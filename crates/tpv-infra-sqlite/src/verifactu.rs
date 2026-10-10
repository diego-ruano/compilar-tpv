//! Persistencia de **Veri\*factu** (FISCAL-01): el registro de facturación, la serie y la cola de
//! envío.
//!
//! La pieza central es [`emitir_alta`], que se llama **dentro de la transacción del cobro**, entre
//! el `INSERT INTO Pagos` y el `COMMIT`. Ese orden es el que exige el art. 9 RRSIF (*«de forma
//! simultánea o inmediatamente anterior a la expedición»*) y el único que no puede dejar
//! **facturas huérfanas** — una factura expedida cuyo registro no existe, que es la única forma de
//! romper esto de verdad.
//!
//! Si el cobro hace `ROLLBACK`, no queda registro ni se gasta número. Si la **impresión** falla
//! después, el registro ya existe y es correcto: la factura está expedida y el papel se reimprime.
//!
//! ## Lo que este módulo NO hace
//!
//! No habla con la AEAT ni construye XML. Sólo escribe la fila y la encola. El envío es un job
//! aparte (docs/arquitectura/jobs-e-interruptores.md) por una razón de la propia norma: el art. 16.2 de la Orden impone un
//! **control de flujo** entre envíos, así que remitir no puede ser una llamada HTTP dentro del
//! cobro aunque se quisiera.

use crate::util::{new_id, now_ms};
use crate::consultas::{db_err};
use tpv_domain::dinero::Dinero;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::RwLock;

use crate::ejecutor::Value;

use tpv_application::error::{AppError, AppResult};
use tpv_contracts::errors::ErrorCode;
use tpv_contracts::verifactu::{BloqueFiscal, EstadoFiscal, RegistroFiscal};
use tpv_domain::ticket::{self, LineaTicket, TramoIva};
use tpv_domain::verifactu as vf;

use crate::db::{Reader, WriteGuard, Writer};
use crate::mapping::{opt_text, v_f64, v_i64, v_string, v_dinero};

// ─────────────────────────────────────────────────────────────────────────────
// El bloque `SistemaInformatico`, inyectado por el shell
// ─────────────────────────────────────────────────────────────────────────────

/// Quién ha hecho este software y qué instalación es. Va **en cada registro**.
///
/// Se inyecta desde el shell Tauri (`lib.rs`) porque dos de sus datos sólo se conocen allí: la
/// versión (de `tauri.conf.json`) y el número de instalación (el `tenant_id`, que vive en
/// `license_state.json`, fuera de `data.db`). Es el mismo patrón que el notificador del outbox.
#[derive(Debug, Clone)]
pub struct SistemaInformatico {
    /// Razón social del **productor** (nosotros), no del bar. Máx. 120.
    pub nombre_razon: String,
    /// NIF del productor. Es **dato declarado**: la AEAT no lo contrasta contra ningún registro de
    /// actividad económica, así que el epígrafe del productor es irrelevante para que un envío se
    /// acepte.
    pub nif: String,
    /// Máx. **30**.
    pub nombre_sistema: String,
    /// Máx. **2**. No es el nombre: es un código corto que asigna el productor.
    pub id_sistema: String,
    /// La de `tauri.conf.json`. Máx. 50.
    pub version: String,
    /// El `tenant_id` del equipo. Máx. 100.
    pub numero_instalacion: String,
}

impl SistemaInformatico {
    /// El JSON que se congela en la fila y que el adaptador de la AEAT convierte en el bloque XML.
    ///
    /// Se guarda **tal como iba** y no se recompone al remitir: si mañana cambia la versión del
    /// TPV, el registro de ayer tiene que seguir diciendo con qué versión se generó.
    fn to_json(&self) -> String {
        serde_json::json!({
            "NombreRazon": vf::sanear_texto(&self.nombre_razon, 120),
            "NIF": self.nif.trim(),
            "NombreSistemaInformatico": vf::sanear_texto(&self.nombre_sistema, 30),
            "IdSistemaInformatico": vf::sanear_texto(&self.id_sistema, 2),
            "Version": vf::sanear_texto(&self.version, 50),
            "NumeroInstalacion": vf::sanear_texto(&self.numero_instalacion, 100),
            // Consecuencia directa de las decisiones de diseño: un solo modo (Veri*factu siempre) y
            // cada instalación factura para un único obligado.
            "TipoUsoPosibleSoloVerifactu": "S",
            "TipoUsoPosibleMultiOT": "N",
            "IndicadorMultiplesOT": "N",
        })
        .to_string()
    }
}

/// No es un `OnceLock` porque el número de instalación puede llegar con la aplicación ya abierta
/// (RI-56): en un equipo recién instalado `setup()` corre antes de que exista la licencia, y todo lo
/// facturado hasta el siguiente reinicio salía con `NumeroInstalacion` vacío.
static SISTEMA: RwLock<Option<SistemaInformatico>> = RwLock::new(None);

/// Cuántas veces ha cambiado el bloque. Es lo que dice a [`asegurar_sistema_reparado`] si le queda
/// algo por reparar: cada cambio puede traer un dato que antes faltaba.
static GENERACION: AtomicU64 = AtomicU64::new(0);

/// La generación del bloque que ya se aplicó a la base con éxito. `u64::MAX` = ninguna todavía.
static REPARADO_EN: AtomicU64 = AtomicU64::new(u64::MAX);

/// Lo llama el shell al arrancar. Sustituye el bloque entero.
pub fn set_sistema_informatico(s: SistemaInformatico) {
    *SISTEMA.write().unwrap_or_else(|e| e.into_inner()) = Some(s);
    GENERACION.fetch_add(1, Ordering::SeqCst);
}

/// RI-56: fija el número de instalación sin tocar el resto del bloque. Lo llama la activación de la
/// licencia, que es cuando se conoce el `tenant_id`. Sin bloque inyectado no hace nada: eso sólo
/// pasa en los tests y en los ejemplos, que inyectan el suyo.
pub fn set_numero_instalacion(numero: &str) {
    let mut g = SISTEMA.write().unwrap_or_else(|e| e.into_inner());
    if let Some(s) = g.as_mut() {
        if s.numero_instalacion != numero {
            s.numero_instalacion = numero.to_string();
            GENERACION.fetch_add(1, Ordering::SeqCst);
        }
    }
}

/// El bloque configurado, o un defecto que **no oculta que falta**.
///
/// No devuelve `Result` a propósito: que el shell no haya inyectado el bloque es un error nuestro,
/// y hacer que impida cobrar sería convertir un bug en una caja parada. El registro sale con un
/// sistema informático incompleto —que la AEAT marcará— en vez de no salir.
fn sistema() -> SistemaInformatico {
    SISTEMA
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .unwrap_or_else(|| SistemaInformatico {
            nombre_razon: String::new(),
            nif: String::new(),
            nombre_sistema: "TPV".to_string(),
            id_sistema: "01".to_string(),
            version: "0.0.0".to_string(),
            numero_instalacion: String::new(),
        })
}

/// ¿Está configurada la identidad del **productor del software**?
///
/// Es una constante compilada en el binario (`PRODUCTOR_NIF` en `lib.rs`), no un ajuste del bar: o
/// está bien en toda la release o está mal en toda la release. Se comprueba el NIF con su dígito de
/// control porque es lo único que la AEAT valida de este bloque —el resto es dato declarado— y
/// porque un NIF con una errata es igual de irremitible que uno vacío.
pub fn productor_configurado() -> bool {
    vf::nif_valido(&sistema().nif)
}

/// Corrige el bloque `SistemaInformatico` de los registros que se emitieron **antes** de que el
/// productor tuviera identidad. Devuelve cuántos corrigió.
///
/// ## Por qué esto tiene que existir
///
/// `Sistema_Json` se congela en la fila al emitir y **no se recompone al remitir**, que es lo
/// correcto: el registro de ayer tiene que seguir diciendo con qué versión del TPV se generó. Pero
/// eso convierte un `PRODUCTOR_NIF` vacío en una trampa silenciosa: los registros emitidos con él
/// llevan `"NIF":""`, la AEAT valida ese campo por formato (nueve caracteres) y los rechazaría —
/// **para siempre**, porque rellenar la constante en una versión posterior no toca las filas ya
/// escritas. Un bar que empiece a usar el TPV antes de que exista la empresa se quedaría con un
/// tramo de facturación imposible de presentar.
///
/// ## Por qué es legítimo tocar una tabla append-only
///
/// Tres condiciones, y hacen falta las tres:
///
/// 1. **No toca la huella.** `SistemaInformatico` **no entra** en la cadena que se hashea (ver
///    `tpv_domain::verifactu::cadena_huella_alta`: son emisor, número, fecha, tipo, cuota, importe,
///    huella anterior y fecha-hora). Corregirlo no rompe el encadenamiento de nada.
/// 2. **No toca la factura.** Lo que se corrige es quién hizo el programa, no qué se vendió ni por
///    cuánto. Ningún dato del hecho imponible cambia.
/// 3. **Sólo alcanza a registros que la AEAT no tiene.** Se exige que no haya un envío aceptado, y
///    esa condición no puede fallar por sí sola: con el productor sin configurar el job **se niega a
///    remitir** (ver `productor_configurado`), así que un registro con `"NIF":""` nunca ha podido
///    ser aceptado. La condición está de todos modos, porque una guardia que se apoya en el
///    comportamiento de otro módulo es una guardia prestada.
///
/// Va por `execute()` y no por `raw()`: `Registros_Facturacion` es esquema compartido y la copia de
/// la nube tiene que quedar igual de corregida que la local.
///
/// ## Qué se repara, y qué no
///
/// Dos huecos, cada uno cuando ya hay con qué rellenarlo:
///
/// - `"NIF":""` (con su `NombreRazon`, que va con él), en cuanto la versión trae `PRODUCTOR_NIF`.
/// - `"NumeroInstalacion":""` (RI-56), en cuanto se conoce el `tenant_id`: los registros emitidos
///   entre la activación y el siguiente reinicio.
///
/// Se rellena **sólo el campo que falta** (`json_set`), no el bloque entero: la `Version` del
/// registro tiene que seguir diciendo con qué versión del TPV se generó, y sustituir el JSON le
/// ponía la de hoy.
///
/// Antes de escribir se pregunta si hay algo que reparar. No es una optimización: `execute()` sube
/// al outbox toda escritura aunque no toque ninguna fila, así que un `UPDATE` a ciegas mandaría a
/// la nube una operación vacía cada vez.
///
/// Idempotente —la segunda vuelta no encuentra nada—. Quien la llama de verdad es
/// [`asegurar_sistema_reparado`], antes de remitir.
pub async fn reparar_sistema_informatico(db: &Db) -> AppResult<usize> {
    let sis = sistema();
    let mut total = 0usize;

    // Los dos casos comparten guardia: nunca un registro que la AEAT ya tiene.
    const NO_ACEPTADO: &str = "NOT EXISTS ( \
           SELECT 1 FROM _Verifactu_Envios e \
           WHERE e.ID_Registro = Registros_Facturacion.ID_Registro \
             AND e.Estado IN ('ACEPTADO', 'ACEPTADO_CON_ERRORES') \
         )";

    // Sin identidad del productor todavía no hay con qué reparar el NIF. No es un error: es el
    // estado en el que nace el proyecto.
    if productor_configurado() {
        let donde = format!("Sistema_Json LIKE '%\"NIF\":\"\"%' AND {NO_ACEPTADO}");
        let n = reparar_donde(
            db,
            &donde,
            "json_set(Sistema_Json, '$.NIF', ?1, '$.NombreRazon', ?2)",
            vec![
                Value::Text(sis.nif.trim().to_string()),
                Value::Text(vf::sanear_texto(&sis.nombre_razon, 120)),
            ],
        )
        .await?;
        if n > 0 {
            tracing::warn!(
                target: "tpv::verifactu",
                registros = n,
                "{n} registro(s) se emitieron sin identidad del productor y se han corregido: \
                 ya se pueden remitir"
            );
        }
        total += n;
    }

    let numero = vf::sanear_texto(&sis.numero_instalacion, 100);
    if !numero.is_empty() {
        let donde =
            format!("Sistema_Json LIKE '%\"NumeroInstalacion\":\"\"%' AND {NO_ACEPTADO}");
        let n = reparar_donde(
            db,
            &donde,
            "json_set(Sistema_Json, '$.NumeroInstalacion', ?1)",
            vec![Value::Text(numero)],
        )
        .await?;
        if n > 0 {
            tracing::warn!(
                target: "tpv::verifactu",
                registros = n,
                "{n} registro(s) se emitieron sin número de instalación y se han corregido"
            );
        }
        total += n;
    }

    Ok(total)
}

/// Un `UPDATE` de `Sistema_Json` que sólo se escribe si hay filas que lo necesiten.
async fn reparar_donde(
    db: &Db,
    donde: &str,
    nuevo: &str,
    params: Vec<Value>,
) -> AppResult<usize> {
    let g = db.write().await;

    let hay = {
        let mut rows = g
            .query(
                &format!("SELECT EXISTS (SELECT 1 FROM Registros_Facturacion WHERE {donde});"),
                Vec::<Value>::new(),
            )
            .await
            .map_err(db_err)?;
        match rows.next().await.map_err(db_err)? {
            Some(row) => v_i64(row.get_value(0).map_err(db_err)?).unwrap_or(0) != 0,
            None => false,
        }
    };
    if !hay {
        return Ok(0);
    }

    let n = g
        .execute(
            &format!("UPDATE Registros_Facturacion SET Sistema_Json = {nuevo} WHERE {donde};"),
            params,
        )
        .await
        .map_err(db_err)?;
    Ok(n as usize)
}

/// RI-01: repara el bloque `SistemaInformatico` **si ha cambiado desde la última reparación**.
///
/// Es la precondición de remitir: el job `verifactu_remitir` la llama antes de cada ciclo, y si
/// falla no se remite. Antes vivía en `init_main`, que en un arranque normal no llega a esa línea
/// (la base ya la abrió `setup()`), así que el día que la versión trajera `PRODUCTOR_NIF` el job
/// habría mandado los registros viejos con el NIF vacío — y ese rechazo de la AEAT es definitivo.
/// Colgada del propio envío, no puede haber un envío que la adelante.
///
/// Cuesta una comparación de enteros por vuelta: sólo toca la base la primera vez tras arrancar y
/// cada vez que el bloque cambia (la activación trae el número de instalación, RI-56). Si falla, la
/// marca no avanza y se reintenta en la vuelta siguiente.
pub async fn asegurar_sistema_reparado(db: &Db) -> AppResult<usize> {
    let generacion = GENERACION.load(Ordering::SeqCst);
    if REPARADO_EN.load(Ordering::SeqCst) == generacion {
        return Ok(0);
    }
    let n = reparar_sistema_informatico(db).await?;
    REPARADO_EN.store(generacion, Ordering::SeqCst);
    Ok(n)
}

// ─────────────────────────────────────────────────────────────────────────────
// Datos del obligado, leídos en la misma transacción
// ─────────────────────────────────────────────────────────────────────────────

/// Lo que el registro necesita de `Business_Settings`.
#[derive(Debug, Clone)]
pub(crate) struct DatosObligado {
    pub nif: String,
    pub razon_social: String,
    pub descripcion_op: String,
    pub entorno: vf::Entorno,
    pub iva_general: f64,
    /// Límite (IVA incluido) por encima del cual ya no cabe una simplificada. Configurable porque es
    /// un número que la norma puede mover.
    pub limite_simplif: Dinero,
}

/// Lee y **valida** los datos fiscales del obligado.
///
/// Devuelve `DatosFiscalesIncompletos` si falta el NIF o la razón social, o si el NIF no supera su
/// dígito de control. Es la única puerta que Veri\*factu añade al camino de la venta, y tiene
/// código propio para que la UI lleve al formulario en vez de enseñar «no se puede cobrar».
pub(crate) async fn datos_obligado<C: Reader>(conn: &C) -> AppResult<DatosObligado> {
    let mut rows = conn
        .query(
            "SELECT CIF, Razon_Social, Descripcion_Op, Verifactu_Entorno, IVA_Percent, \
                    Limite_Simplif \
             FROM Business_Settings WHERE ID = 1 LIMIT 1;",
            (),
        )
        .await
        .map_err(db_err)?;
    let row = rows.next().await.map_err(db_err)?.ok_or_else(|| {
        AppError::coded(
            ErrorCode::DatosFiscalesIncompletos,
            "No hay datos del negocio configurados",
        )
    })?;

    // RI-14: normalizado igual que se valida. `nif_valido` da por bueno `B-12345674`, y sin esto
    // saldría así al XML, al QR y a la huella: diez caracteres que la AEAT rechaza en cada registro.
    // El campo se guarda como lo escribió el dueño, que es lo que se imprime en el ticket.
    let nif = vf::normalizar_nif(&v_string(row.get_value(0).map_err(db_err)?).unwrap_or_default());
    let razon_social = v_string(row.get_value(1).map_err(db_err)?).unwrap_or_default();
    let descripcion_op = v_string(row.get_value(2).map_err(db_err)?).unwrap_or_default();
    let entorno = vf::Entorno::desde_texto(
        &v_string(row.get_value(3).map_err(db_err)?).unwrap_or_default(),
    );
    let iva_general = v_f64(row.get_value(4).map_err(db_err)?).unwrap_or(10.0);
    let limite_simplif = v_dinero(row.get_value(5).map_err(db_err)?)
        .filter(|v| *v > Dinero::CERO)
        .unwrap_or(vf::LIMITE_SIMPLIFICADA_HOSTELERIA);

    if nif.is_empty() || razon_social.trim().is_empty() {
        return Err(AppError::coded(
            ErrorCode::DatosFiscalesIncompletos,
            "Faltan el NIF y la razón social del negocio: sin ellos no se puede emitir la factura.",
        ));
    }
    if !vf::nif_valido(&nif) {
        // Se comprueba aquí y no al enviar porque al enviar vuelve como error admisible horas
        // después y sin nadie delante.
        return Err(AppError::coded(
            ErrorCode::DatosFiscalesIncompletos,
            format!("El NIF del negocio ({nif}) no es válido."),
        ));
    }

    Ok(DatosObligado {
        nif,
        razon_social: vf::sanear_texto(&razon_social, 120),
        descripcion_op: vf::sanear_texto(
            if descripcion_op.trim().is_empty() {
                "Servicios de hosteleria y restauracion"
            } else {
                &descripcion_op
            },
            500,
        ),
        entorno,
        iva_general,
        limite_simplif,
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// La serie y el número
// ─────────────────────────────────────────────────────────────────────────────

/// Serie del ejercicio en curso (`"2027"`). El contador se reinicia cada año.
fn serie_actual() -> String {
    chrono::Local::now().format("%Y").to_string()
}

/// La serie de las **facturas rectificativas**, que por ley tiene que ser propia.
///
/// > *Art. 6.1.a) RD 1619/2012:* «será obligatoria, **en todo caso**, la expedición en series
/// > específicas de las facturas siguientes: […] 2.º Las rectificativas.»
///
/// No es una preferencia de listado ni una comodidad: es un «en todo caso». Se usa el mismo
/// ejercicio con una `R` delante (`R2027/000001`) para que las dos series se lean juntas y ordenen
/// igual.
///
/// **La `F3` NO entra aquí**, y no es un olvido: el art. 15.6 del mismo reglamento dice que *«las
/// facturas que se expidan en sustitución o canje de facturas simplificadas expedidas con
/// anterioridad no tendrán la condición de rectificativas»*. Una `F3` es una factura normal que
/// sustituye a un ticket, así que va en la serie normal.
fn serie_rectificativas() -> String {
    format!("R{}", serie_actual())
}

/// ¿Este tipo de factura es una **rectificativa** a efectos del art. 6.1.a)?
///
/// `R1`–`R5`, y sólo esas. `F1`, `F2` y `F3` son facturas ordinarias — la `F3` también, por el
/// art. 15.6.
fn es_rectificativa(tipo_factura: &str) -> bool {
    matches!(tipo_factura, "R1" | "R2" | "R3" | "R4" | "R5")
}

/// El número más alto ya emitido en una serie. Corre en cada cobro, dentro de la transacción del
/// escritor único: `planes::tests` vigila que vaya por `idx_regfact_serie_numero` (RI-03).
pub(crate) const SQL_MAX_NUMERO_EMITIDO: &str =
    "SELECT COALESCE(MAX(Numero), 0) FROM Registros_Facturacion WHERE Serie = ?1;";

/// Reserva el siguiente número de la serie y lo devuelve formateado (`2027/000001`).
///
/// El incremento es **relativo** (`Ultimo + 1`), como el antiguo `Ticket_Contador`, para que la
/// sentencia que se captura en el outbox converja sola.
///
/// **Y antes se comprueba contra los registros ya emitidos.** Restaurar una copia local de hace
/// tres días devolvería el contador a un número ya usado, y la AEAT rechazaría el registro por
/// duplicado (`IDFactura` = emisor + número + fecha, error 3000). Un hueco en la numeración es
/// explicable; un número repetido es un registro que no entra. **Se falla hacia el hueco.**
///
/// El salto se escribe con `MAX(Ultimo, ?)` y no con un `=` para que sea idempotente: aplicado dos
/// veces da lo mismo, y aplicado en la nube sobre un valor más alto no lo baja.
pub(crate) async fn reservar_numero(
    db: &WriteGuard<'_>,
    serie: &str,
) -> AppResult<(String, i64)> {
    db.execute(
        "INSERT OR IGNORE INTO Serie_Facturacion (Serie, Ultimo) VALUES (?1, 0);",
        vec![Value::Text(serie.to_string())],
    )
    .await
    .map_err(db_err)?;

    let max_emitido = select_i64(
        db,
        SQL_MAX_NUMERO_EMITIDO,
        vec![Value::Text(serie.to_string())],
    )
    .await?
    .unwrap_or(0);

    let contador = select_i64(
        db,
        "SELECT Ultimo FROM Serie_Facturacion WHERE Serie = ?1;",
        vec![Value::Text(serie.to_string())],
    )
    .await?
    .unwrap_or(0);

    if contador < max_emitido {
        tracing::warn!(
            target: "tpv::verifactu",
            serie = %serie,
            contador,
            max_emitido,
            "el contador de la serie iba por detrás de los registros emitidos: salta hacia adelante"
        );
        db.execute(
            "UPDATE Serie_Facturacion SET Ultimo = MAX(Ultimo, ?2) WHERE Serie = ?1;",
            vec![Value::Text(serie.to_string()), Value::Integer(max_emitido)],
        )
        .await
        .map_err(db_err)?;
    }

    db.execute(
        "UPDATE Serie_Facturacion SET Ultimo = Ultimo + 1 WHERE Serie = ?1;",
        vec![Value::Text(serie.to_string())],
    )
    .await
    .map_err(db_err)?;

    let n = select_i64(
        db,
        "SELECT Ultimo FROM Serie_Facturacion WHERE Serie = ?1;",
        vec![Value::Text(serie.to_string())],
    )
    .await?
    .unwrap_or(1);

    Ok((format!("{serie}/{n:06}"), n))
}

// ─────────────────────────────────────────────────────────────────────────────
// Emisión
// ─────────────────────────────────────────────────────────────────────────────

/// Lo que hace falta para emitir una **subsanación**: reemitir el mismo `IDFactura` corregido.
///
/// Una subsanación **no es una factura nueva**. Es el mismo hecho vuelto a contar bien, así que
/// conserva la terna que la identifica ante la AEAT —emisor, número de serie y fecha de expedición—
/// y **no gasta número**. Lo que sí cambia es todo lo demás: ocupa su propio `Orden`, se encadena al
/// final de la cadena y tiene su propia huella y su propia hora de generación.
///
/// Por eso el índice único de la terna excluye las subsanaciones: si no, la segunda no entraría.
#[derive(Debug, Clone)]
pub struct Subsanar {
    /// El registro al que subsana. Se guarda en `Subsana_ID_Registro` para poder seguir el hilo.
    pub id_registro_original: String,
    pub num_serie_factura: String,
    pub numero: i64,
    pub serie: String,
    /// `DD-MM-AAAA`, la del original: forma parte de su identidad.
    pub fecha_expedicion: String,
    /// Siempre `"S"`.
    pub marca: &'static str,
    /// `"X"` si el original fue **rechazado** (la AEAT no lo tiene), `None` si lo aceptó.
    ///
    /// La diferencia no es cosmética: dice si el registro que se está mandando sustituye a uno que
    /// ya está en la AEAT o si es el primero que llega de ese `IDFactura`.
    pub rechazo_previo: Option<&'static str>,
}

/// Un destinatario de factura completa (`F1`/`F3`). En `F2` y `R5` **no puede haberlo**: la AEAT
/// rechaza el registro con el error 1190.
#[derive(Debug, Clone)]
pub struct Destinatario {
    pub nombre_razon: String,
    pub nif: String,
    /// El domicilio del cliente. No va al XML —el registro no lo lleva— sino al **papel**: una
    /// factura completa lo exige, y sin guardarlo no habría de dónde sacarlo al imprimirla (RI-29).
    pub domicilio: Option<String>,
}

/// Una factura a la que este registro se refiere: la rectificada (`R1`-`R5`) o la sustituida
/// (`F3`).
#[derive(Debug, Clone)]
pub struct RefFactura {
    pub nif: String,
    pub num_serie: String,
    /// `DD-MM-AAAA`.
    pub fecha: String,
}

/// Todo lo que hace falta para emitir un registro de alta.
#[derive(Debug, Clone, Default)]
pub struct DatosFactura {
    /// `F1` | `F2` | `F3` | `R1`..`R5`. Por defecto `F2`, que es el ticket de barra o mesa.
    pub tipo_factura: Option<String>,
    /// `S` (por sustitución) | `I` (por diferencias). Obligatorio si `tipo_factura` es `R*`, y
    /// prohibido si no (errores 1114 y 1115).
    pub tipo_rectificativa: Option<String>,
    pub id_pago: Option<String>,
    /// Las líneas cobradas, para el desglose.
    pub lineas: Vec<LineaTicket>,
    pub destinatario: Option<Destinatario>,
    /// Facturas rectificadas (`R*`). Sólo si es rectificativa (error 1117).
    pub rectificadas: Vec<RefFactura>,
    /// Facturas sustituidas. **Sólo si es `F3`** (error 1116).
    pub sustituidas: Vec<RefFactura>,
    /// `"S"` cuando el registro se genera durante una incidencia (sin conexión, tras restaurar).
    pub incidencia: bool,
    /// Número ya reservado por el llamante (`("2027/000001", 1)`).
    ///
    /// El camino del cobro lo reserva **antes** del `INSERT INTO Pagos`, porque
    /// `Pagos.Numero_Ticket` guarda ese mismo número: un solo número para el papel, el cobro y el
    /// registro — dos numeraciones paralelas serían dos cosas que pueden divergir. Si es `None`,
    /// lo reserva esta función.
    pub numero_reservado: Option<(String, i64)>,
    /// Cuando este registro **subsana** a otro. Ver [`Subsanar`].
    pub subsanar: Option<Subsanar>,
    /// `DD-MM-AAAA`: el día en que se efectuó la operación, **si no es el de expedición**.
    ///
    /// Lo decide quien emite, porque sólo él sabe a qué operación corresponde: la apertura de la
    /// comanda en un cobro, la fecha de la factura original en una rectificativa o en una `F3`.
    /// `emitir_alta` lo descarta si coincide con la de expedición — informarlo entonces es ruido, y
    /// la norma lo condiciona a que sea distinta.
    pub fecha_operacion: Option<String>,
    /// El desglose ya declarado en otras facturas, cuando ésta lo copia (una `F3`, una
    /// rectificativa, una subsanación). Se usa **tal cual**: recalcularlo desde los totales puede
    /// mover un céntimo entre base y cuota —sobre todo al sumar varios tickets en una `F3`—, y
    /// entonces dos facturas dirían cosas distintas del mismo dinero. `None` = se calcula de
    /// `lineas`.
    pub desglose: Option<Vec<TramoIva>>,
    /// `ImporteRectificacion` de una rectificativa **por sustitución** (`S`): la base y la cuota de
    /// la factura que se sustituye (FAQ del SII 2.8, opción 1). Obligatorio con `S` y prohibido con
    /// `I`.
    pub importe_rectificacion: Option<(Dinero, Dinero)>,
}

/// Emite un registro de **alta** y lo deja encolado para remitir.
///
/// Se llama dentro de la transacción del cobro. Devuelve el bloque que el frontend mete en el
/// payload de impresión — el número, el QR y la huella **no se pueden inventar en el cliente**.
pub async fn emitir_alta(db: &WriteGuard<'_>, d: DatosFactura) -> AppResult<BloqueFiscal> {
    let obligado = datos_obligado(db).await?;
    let sis = sistema();

    let tipo_factura = d.tipo_factura.clone().unwrap_or_else(|| "F2".to_string());

    // ── Desglose e importes. Se calculan UNA vez, se formatean UNA vez y se guardan como texto ──
    let tramos = match &d.desglose {
        Some(declarado) => declarado.clone(),
        None => ticket::desglose(&normalizar_lineas(&d.lineas, obligado.iva_general)),
    };

    // Una rectificativa por sustitución lleva SIEMPRE lo que sustituye, y sólo ella: sin
    // `ImporteRectificacion` la AEAT no sabe qué importe deja de valer.
    let por_sustitucion = d.tipo_rectificativa.as_deref() == Some("S");
    if por_sustitucion != d.importe_rectificacion.is_some() {
        return Err(AppError::internal(
            "una rectificativa por sustitución lleva ImporteRectificacion, y sólo ella",
        ));
    }
    let importe_total = ticket::importe_total(&tramos);
    let cuota_total = ticket::cuota_total(&tramos);
    let importe_txt = vf::fmt_importe(importe_total);
    let cuota_txt = vf::fmt_importe(cuota_total);

    // ── Identificación de la factura ──
    //
    // La serie sale del TIPO, no del camino que llamó. Una rectificativa va a la suya porque el
    // art. 6.1.a) del RD 1619/2012 lo exige «en todo caso»; el resto —incluida la `F3`, que por el
    // art. 15.6 no es rectificativa— va a la del ejercicio.
    let rectificativa = es_rectificativa(&tipo_factura);
    let serie = if rectificativa {
        serie_rectificativas()
    } else {
        serie_actual()
    };

    // Un número reservado de antemano SÓLO puede venir del camino del cobro, que reserva en la serie
    // ordinaria antes de saber siquiera si habrá destinatario. Si llegara aquí con una rectificativa
    // sería un número de la serie equivocada, y el síntoma —una rectificativa numerada como una
    // venta— no se distingue a simple vista de lo correcto. Se para en vez de escribirlo.
    if rectificativa && d.numero_reservado.is_some() {
        return Err(AppError::internal(
            "una factura rectificativa no puede usar un número reservado de la serie ordinaria",
        ));
    }

    // Un número reservado tiene que venir YA en la serie que le toca. El camino del cobro lo
    // consigue preguntando por el modo antes de reservar (`serie_del_cobro`), y lo comprueba aquí
    // porque `Pagos.Numero_Ticket` guarda ese mismo valor: si los dos dejaran de coincidir, el
    // ticket llevaría un número que no corresponde a ningún registro y saldría sin QR, sin que nada
    // protestara. Se para en vez de escribirlo.
    let numero_reservado = d.numero_reservado.clone();
    if let Some((num, _)) = &numero_reservado {
        if !num.starts_with(&format!("{serie}/")) {
            return Err(AppError::internal(format!(
                "el número reservado ({num}) no es de la serie que corresponde a esta factura ({serie})"
            )));
        }
    }

    // Una subsanación conserva la identidad del original y NO gasta número: es el mismo hecho vuelto
    // a contar, no una factura más.
    let (serie, num_serie_factura, numero) = match &d.subsanar {
        Some(sub) => (sub.serie.clone(), sub.num_serie_factura.clone(), sub.numero),
        None => {
            let (n, num) = match numero_reservado {
                Some(v) => v,
                None => reservar_numero(db, &serie).await?,
            };
            (serie, n, num)
        }
    };
    let fecha_expedicion = match &d.subsanar {
        // La fecha de expedición forma parte del `IDFactura`: cambiarla sería otra factura.
        Some(sub) => sub.fecha_expedicion.clone(),
        None => vf::fecha_registro_desde_iso(&crate::util::now_local_date())
            .ok_or_else(|| AppError::internal("El reloj del equipo no da una fecha utilizable"))?,
    };

    // Sólo si es DISTINTA de la de expedición. Los arts. 6.1.i) y 7.1.c) del RD 1619/2012 lo
    // condicionan a eso con la misma redacción, y la AEAT interpreta la ausencia como «igual a la
    // de expedición». Se filtra aquí y no en cada llamante para que no dependa de que todos se
    // acuerden.
    let fecha_operacion = d
        .fecha_operacion
        .as_deref()
        .map(str::trim)
        .filter(|f| !f.is_empty() && *f != fecha_expedicion)
        .map(str::to_string);
    // `chrono::Local` y no `datetime('now')`: el campo lleva HUSO y la BD no lo escribe. Es un
    // literal calculado en Rust, igual que los UUID, así que el outbox lo replica tal cual.
    let fecha_hora_huso = chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, false);

    // ── El eslabón anterior ──
    let eslabones = estado_de_la_cadena(db).await?;
    let anterior = eslabones.ultimo.clone();
    let primer_registro = if anterior.is_none() { Some("S") } else { None };

    let entrada = vf::EntradaHuellaAlta {
        id_emisor_factura: &obligado.nif,
        num_serie_factura: &num_serie_factura,
        fecha_expedicion_factura: &fecha_expedicion,
        tipo_factura: &tipo_factura,
        cuota_total: &cuota_txt,
        importe_total: &importe_txt,
        huella_anterior: anterior.as_ref().map(|a| a.huella.as_str()),
        fecha_hora_huso: &fecha_hora_huso,
    };
    let cadena = vf::cadena_huella_alta(&entrada);
    let huella = vf::huella(&cadena);

    let qr_url = vf::url_qr(
        obligado.entorno.base_qr(),
        &obligado.nif,
        &num_serie_factura,
        &fecha_expedicion,
        &importe_txt,
    );

    let orden = siguiente_orden(db).await?;
    let id_registro = new_id();

    db.execute(
        r#"
        INSERT INTO Registros_Facturacion (
          ID_Registro, Orden, Tipo,
          NIF_Emisor, Num_Serie_Factura, Fecha_Expedicion, Fecha_Operacion, Serie, Numero,
          Nombre_Razon_Emisor, Tipo_Factura, Tipo_Rectificativa, Descripcion_Operacion,
          Importe_Total, Cuota_Total, Desglose_Json, Destinatario_Json, Referencias_Json, Macrodato,
          Primer_Registro, Ant_NIF, Ant_Num_Serie, Ant_Fecha, Ant_Huella,
          Cadena_Huella, Huella, Tipo_Huella, Fecha_Hora_Huso,
          Sistema_Json, QR_Url, Incidencia, ID_Pago,
          Subsanacion, Rechazo_Previo, Subsana_ID_Registro
        ) VALUES (
          ?1, ?2, 'ALTA',
          ?3, ?4, ?5, ?31, ?6, ?7,
          ?8, ?9, ?10, ?11,
          ?12, ?13, ?14, ?15, ?16, ?17,
          ?18, ?19, ?20, ?21, ?22,
          ?23, ?24, ?25, ?26,
          ?27, ?28, ?29, ?30,
          ?32, ?33, ?34
        );
        "#,
        vec![
            Value::Text(id_registro.clone()),
            Value::Integer(orden),
            Value::Text(obligado.nif.clone()),
            Value::Text(num_serie_factura.clone()),
            Value::Text(fecha_expedicion.clone()),
            Value::Text(serie.clone()),
            Value::Integer(numero),
            Value::Text(obligado.razon_social.clone()),
            Value::Text(tipo_factura.clone()),
            opt_text(d.tipo_rectificativa.clone()),
            Value::Text(obligado.descripcion_op.clone()),
            Value::Text(importe_txt.clone()),
            Value::Text(cuota_txt.clone()),
            Value::Text(desglose_json(&tramos)),
            opt_text(destinatario_json(d.destinatario.as_ref())),
            opt_text(referencias_json(&d.rectificadas, &d.sustituidas, d.importe_rectificacion)),
            opt_text(vf::macrodato(importe_total).map(|s| s.to_string())),
            opt_text(primer_registro.map(|s| s.to_string())),
            opt_text(anterior.as_ref().map(|a| a.nif.clone())),
            opt_text(anterior.as_ref().map(|a| a.num_serie.clone())),
            opt_text(anterior.as_ref().map(|a| a.fecha.clone())),
            opt_text(anterior.as_ref().map(|a| a.huella.clone())),
            Value::Text(cadena),
            Value::Text(huella.clone()),
            Value::Text(vf::TIPO_HUELLA_SHA256.to_string()),
            Value::Text(fecha_hora_huso),
            Value::Text(sis.to_json()),
            Value::Text(qr_url.clone()),
            Value::Text(if d.incidencia { "S" } else { "N" }.to_string()),
            opt_text(d.id_pago.clone()),
            // ?31 — va al final de la lista aunque su columna esté al principio: renumerar los
            // treinta anteriores para colocarlo "en su sitio" es exactamente el cambio que desplaza
            // un parámetro sin que nada lo note.
            opt_text(fecha_operacion.clone()),
            // ?32..?34 — la subsanación, por lo mismo.
            opt_text(d.subsanar.as_ref().map(|s| s.marca.to_string())),
            opt_text(d.subsanar.as_ref().and_then(|s| s.rechazo_previo.map(str::to_string))),
            opt_text(d.subsanar.as_ref().map(|s| s.id_registro_original.clone())),
        ],
    )
    .await
    .map_err(db_err)?;

    encolar_envio(db, &id_registro).await?;

    // La comprobación del art. 7.i) se hizo ANTES de generar (al leer la cadena); aquí sólo se deja
    // constancia, ya con el identificador del registro nuevo delante. Nunca impide nada: el registro
    // está emitido y el cobro hecho.
    if let Some(a) = eslabones.anomalia {
        anotar_anomalia(db, a, &id_registro).await;
    }

    Ok(BloqueFiscal {
        num_serie_factura,
        fecha_expedicion,
        qr_url,
        huella,
        tipo_factura,
        entorno_pruebas: obligado.entorno.es_pruebas(),
    })
}

/// Emite un registro de **anulación** de una factura ya emitida (art. 11.1 RRSIF).
///
/// Anular **no borra nada**: tanto el registro erróneo como el de anulación se conservan y se
/// remiten los dos. Y es para cuando la factura *no responde a una operación real* —una venta de
/// prueba, una formación, una mesa equivocada—: la AEAT dice en su FAQ que estos casos deben ser
/// «MUY POCO FRECUENTES». Si la operación existió y hay que devolver dinero, eso es una
/// **rectificativa**, no una anulación.
pub async fn emitir_anulacion(
    db: &WriteGuard<'_>,
    id_registro_anulado: &str,
) -> AppResult<BloqueFiscal> {
    let obligado = datos_obligado(db).await?;
    let sis = sistema();

    // Se leen del registro original y no de la entrada: el `IDFactura` que se anula tiene que ser
    // exactamente el que se emitió.
    let mut rows = db
        .query(
            "SELECT NIF_Emisor, Num_Serie_Factura, Fecha_Expedicion, Serie, Numero, ID_Pago \
             FROM Registros_Facturacion WHERE ID_Registro = ?1 LIMIT 1;",
            vec![Value::Text(id_registro_anulado.to_string())],
        )
        .await
        .map_err(db_err)?;
    let row = rows
        .next()
        .await
        .map_err(db_err)?
        .ok_or_else(|| AppError::not_found("No existe ese registro de facturación"))?;

    let nif_anulada = v_string(row.get_value(0).map_err(db_err)?).unwrap_or_default();
    let num_anulada = v_string(row.get_value(1).map_err(db_err)?).unwrap_or_default();
    let fecha_anulada = v_string(row.get_value(2).map_err(db_err)?).unwrap_or_default();
    let serie = v_string(row.get_value(3).map_err(db_err)?).unwrap_or_else(serie_actual);
    let numero = v_i64(row.get_value(4).map_err(db_err)?).unwrap_or(0);
    let id_pago = v_string(row.get_value(5).map_err(db_err)?);

    let fecha_hora_huso = chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, false);
    let eslabones = estado_de_la_cadena(db).await?;
    let anterior = eslabones.ultimo.clone();
    let primer_registro = if anterior.is_none() { Some("S") } else { None };

    let entrada = vf::EntradaHuellaAnulacion {
        id_emisor_factura_anulada: &nif_anulada,
        num_serie_factura_anulada: &num_anulada,
        fecha_expedicion_factura_anulada: &fecha_anulada,
        huella_anterior: anterior.as_ref().map(|a| a.huella.as_str()),
        fecha_hora_huso: &fecha_hora_huso,
    };
    let cadena = vf::cadena_huella_anulacion(&entrada);
    let huella = vf::huella(&cadena);

    // Un registro de anulación no lleva importe, así que su QR no tiene nada que cotejar. Se
    // conserva el de la factura anulada para que la fila sea autosuficiente al exportar.
    let qr_url = qr_de(db, id_registro_anulado).await?.unwrap_or_default();

    let orden = siguiente_orden(db).await?;
    let id_registro = new_id();

    db.execute(
        r#"
        INSERT INTO Registros_Facturacion (
          ID_Registro, Orden, Tipo,
          NIF_Emisor, Num_Serie_Factura, Fecha_Expedicion, Serie, Numero,
          Nombre_Razon_Emisor,
          Primer_Registro, Ant_NIF, Ant_Num_Serie, Ant_Fecha, Ant_Huella,
          Cadena_Huella, Huella, Tipo_Huella, Fecha_Hora_Huso,
          Sistema_Json, QR_Url, Incidencia, ID_Pago
        ) VALUES (
          ?1, ?2, 'ANULACION',
          ?3, ?4, ?5, ?6, ?7,
          ?8,
          ?9, ?10, ?11, ?12, ?13,
          ?14, ?15, ?16, ?17,
          ?18, ?19, 'N', ?20
        );
        "#,
        vec![
            Value::Text(id_registro.clone()),
            Value::Integer(orden),
            Value::Text(nif_anulada.clone()),
            Value::Text(num_anulada.clone()),
            Value::Text(fecha_anulada.clone()),
            Value::Text(serie),
            Value::Integer(numero),
            Value::Text(obligado.razon_social.clone()),
            opt_text(primer_registro.map(|s| s.to_string())),
            opt_text(anterior.as_ref().map(|a| a.nif.clone())),
            opt_text(anterior.as_ref().map(|a| a.num_serie.clone())),
            opt_text(anterior.as_ref().map(|a| a.fecha.clone())),
            opt_text(anterior.as_ref().map(|a| a.huella.clone())),
            Value::Text(cadena),
            Value::Text(huella.clone()),
            Value::Text(vf::TIPO_HUELLA_SHA256.to_string()),
            Value::Text(fecha_hora_huso),
            Value::Text(sis.to_json()),
            Value::Text(qr_url.clone()),
            opt_text(id_pago),
        ],
    )
    .await
    .map_err(db_err)?;

    encolar_envio(db, &id_registro).await?;

    // La comprobación del art. 7.i) se hizo ANTES de generar (al leer la cadena); aquí sólo se deja
    // constancia, ya con el identificador del registro nuevo delante. Nunca impide nada: el registro
    // está emitido y el cobro hecho.
    if let Some(a) = eslabones.anomalia {
        anotar_anomalia(db, a, &id_registro).await;
    }

    Ok(BloqueFiscal {
        num_serie_factura: num_anulada,
        fecha_expedicion: fecha_anulada,
        qr_url,
        huella,
        tipo_factura: String::new(),
        entorno_pruebas: obligado.entorno.es_pruebas(),
    })
}

/// Las líneas que cubre un pago, tal como se cobraron.
///
/// Se leen de `Pago_Detalles` ⋈ `Detalle_Comanda` **después** de enlazarlas, y no de la entrada del
/// comando, por la misma razón por la que el nombre y el precio están congelados en la línea: lo
/// que se declara a la AEAT tiene que ser exactamente lo que se cobró, no lo que se pidió cobrar.
///
/// Un `IVA_Percent` nulo hereda el general del negocio, que es el caso de casi todo en hostelería.
pub(crate) async fn lineas_de_pago<C: Reader>(
    conn: &C,
    id_pago: &str,
    iva_general: f64,
) -> AppResult<Vec<LineaTicket>> {
    let mut rows = conn
        .query(
            "SELECT COALESCE(dc.Cantidad, 1) * COALESCE(dc.Precio_Unitario, 0),                     dc.IVA_Percent              FROM Pago_Detalles pd              JOIN Detalle_Comanda dc ON dc.ID_Detalle = pd.ID_Detalle              WHERE pd.ID_Pago = ?1;",
            vec![Value::Text(id_pago.to_string())],
        )
        .await
        .map_err(db_err)?;

    let mut out = Vec::new();
    while let Some(row) = rows.next().await.map_err(db_err)? {
        out.push(LineaTicket {
            total_con_iva: v_dinero(row.get_value(0).map_err(db_err)?).unwrap_or(Dinero::CERO),
            tipo_iva: v_f64(row.get_value(1).map_err(db_err)?).unwrap_or(iva_general),
        });
    }
    Ok(out)
}

/// Emite el registro de un cobro: una **factura simplificada (`F2`)** o una **completa (`F1`)** si
/// el cliente dio sus datos.
///
/// Es el camino de la inmensa mayoría de las ventas de un bar, y lo llaman los tres sitios que
/// cobran (`mesas` por detalles, `mesas` por productos sueltos y `venta_rapida`). Está aquí y no
/// copiado tres veces porque las tres tienen que hacer exactamente lo mismo.
///
/// **Importante**: se llama DESPUÉS de insertar `Pago_Detalles`, porque el desglose sale de ahí.
///
/// ## El límite de la simplificada
///
/// Una `F2` vale hasta **3.000 € con IVA** en hostelería (art. 4.2 RD 1619/2012, y la AEAT lo valida
/// en el servicio web con el error 1150). Por encima no cabe una `F2`, y una `F1` sin destinatario es
/// imposible (error 1189). Así que si el importe pasa del límite y no hay destinatario, **esto
/// devuelve `FacturaCompletaRequerida`** y la transacción del cobro rueda atrás: no hay ninguna
/// factura que emitir con lo que hay, y emitir una inválida sería peor que no cobrar todavía.
///
/// El límite se mira sobre el **importe DEL COBRO**, no sobre el total de la comanda. Eso juega a
/// favor: una comanda de 4.000 € que pagan dos empresas a 2.000 € son dos simplificadas correctas, y
/// eso ya funciona con el cobro fraccionado. Lo que no hay es un botón de «dividir el cobro» para
/// bajar del límite: partir el pago de un mismo cliente es fraccionamiento artificial de una
/// operación, y ofrecer el botón sería invitar a usarlo mal.
///
/// Si el pago no tiene ninguna línea enlazada (un cobro que no cubre nada), se emite igualmente con
/// el importe del pago como único tramo al tipo general: una factura sin desglose no es válida, y
/// dejar de emitir no es una opción — sería expedir una factura huérfana.
pub async fn emitir_cobro(
    db: &WriteGuard<'_>,
    id_pago: &str,
    numero_reservado: (String, i64),
    importe_pago: Dinero,
    destinatario: Option<vf::Destinatario>,
) -> AppResult<Option<BloqueFiscal>> {
    // MODO-PRUEBA (temporal): el número ya dice si el cobro se hizo en modo prueba —la serie se fija
    // al reservarlo—, y un cobro de prueba no expide factura: ni registro, ni QR, ni datos fiscales.
    // Se quita entero antes de que Veri*factu sea obligatorio.
    if vf::es_numero_de_prueba(&numero_reservado.0) {
        return Ok(None);
    }
    let obligado = datos_obligado(db).await?;

    // Los datos del cliente se validan ANTES de tocar nada: un NIF con el dígito de control mal no
    // se rechaza al enviar, vuelve como error admisible 2001 horas después y sin el cliente delante.
    let destinatario = match destinatario {
        Some(d) => Some(
            vf::validar_destinatario(d)
                .map_err(|e| AppError::validation(e.mensaje()))?,
        ),
        None => None,
    };

    let clave = vf::clave_de_factura(importe_pago, obligado.limite_simplif, destinatario.is_some())
        .ok_or_else(|| {
            AppError::coded(
                ErrorCode::FacturaCompletaRequerida,
                format!(
                    "Este cobro ({:.2} €) pasa del límite de la factura simplificada ({:.2} €). \
                     Hacen falta el NIF y el nombre del cliente para emitir una factura completa.",
                    importe_pago, obligado.limite_simplif
                ),
            )
        })?;

    // El día en que se efectuó la operación es aquel en que se consumió, o sea el de apertura de la
    // comanda. Casi siempre es hoy y entonces no se informa; el caso que lo justifica es la cena que
    // cruza la medianoche, que en hostelería no es raro. Lo exigen los arts. 6.1.i) y 7.1.c) del
    // RD 1619/2012 con la misma redacción para la factura completa y para la simplificada.
    let fecha_operacion = fecha_apertura_de_la_comanda(db, id_pago).await?;

    let mut lineas = lineas_de_pago(db, id_pago, obligado.iva_general).await?;

    let suma: Dinero = lineas.iter().map(|l| l.total_con_iva).sum();
    if lineas.is_empty() || suma != importe_pago {
        // Dos casos que van juntos porque el remedio es el mismo:
        //   * un cobro que no enlaza líneas (no debería pasar, pero no puede impedir facturar), y
        //   * un cobro PARCIAL de una línea, donde lo cobrado no es la suma de las líneas enteras.
        // En los dos, lo que se declara es el importe del cobro, que es el hecho fiscal: la
        // factura es el cobro.
        //
        // REV-16: lo que se hacía era colapsarlo todo en UNA línea al tipo de la primera, y eso
        // declara mal el IVA en cuanto el ticket mezcla tipos — comida al 10 % y alcohol al 21 %,
        // o sea lo normal en un bar. Ahora se reparte en proporción (`ticket::prorratear`), que
        // conserva el peso de cada tipo y cuadra al céntimo.
        //
        // ⚠️ Esto no lo habría cazado nadie de fuera: la AEAT acepta una `CuotaTotal` descuadrada
        // sin decir nada (`docs/PRUEBAS_AEAT.md`). El único control es esta aritmética.
        lineas = ticket::prorratear(&lineas, importe_pago, obligado.iva_general);
    }

    emitir_alta(
        db,
        DatosFactura {
            tipo_factura: Some(clave.to_string()),
            id_pago: Some(id_pago.to_string()),
            lineas,
            destinatario: destinatario.map(|d| Destinatario {
                nombre_razon: d.nombre_razon,
                nif: d.nif,
                domicilio: d.direccion,
            }),
            numero_reservado: Some(numero_reservado),
            fecha_operacion,
            ..Default::default()
        },
    )
    .await
    .map(Some)
}

/// El día de apertura de la comanda a la que pertenece un cobro, en `DD-MM-AAAA`.
///
/// Devuelve `None` cuando no se puede saber, y eso **no es un error**: un cobro sin comanda o con
/// una fecha que no se parse deja el campo sin informar, que es exactamente lo mismo que declarar
/// que la operación fue el día de la expedición — el caso normal. Nada de lo que rodea al registro
/// puede impedir emitirlo.
async fn fecha_apertura_de_la_comanda<C: Reader>(
    conn: &C,
    id_pago: &str,
) -> AppResult<Option<String>> {
    let mut rows = conn
        .query(
            "SELECT c.Fecha_Hora_Apertura FROM Pagos p              JOIN Comandas c ON c.ID_Comanda = p.ID_Comanda              WHERE p.ID_Pago = ?1 LIMIT 1;",
            vec![Value::Text(id_pago.to_string())],
        )
        .await
        .map_err(db_err)?;

    let Some(row) = rows.next().await.map_err(db_err)? else {
        return Ok(None);
    };
    // `Fecha_Hora_Apertura` es `AAAA-MM-DD hh:mm:ss`; sólo interesa el día.
    Ok(v_string(row.get_value(0).map_err(db_err)?)
        .filter(|f| f.len() >= 10)
        .and_then(|f| vf::fecha_registro_desde_iso(&f[..10])))
}

/// Emite el registro que corresponde cuando un cobro deja de contar (FISCAL-01).
///
/// **Los dos instrumentos no son intercambiables y la AEAT es explícita al respecto**:
///
/// - `ClaseBaja::Error` → la factura **no respondía a una operación real** (un ticket de prueba, una
///   formación, una mesa equivocada). Se emite un **RF de anulación** del art. 11.1 RRSIF. Anular
///   no borra nada: el registro erróneo y el de anulación se conservan y se remiten los dos. La FAQ
///   de desarrolladores avisa de que estos casos deben ser *«MUY POCO FRECUENTES»*.
///
/// - `ClaseBaja::Devolucion` → la operación **sí existió** y hay que devolver el dinero. Se emite
///   una **factura rectificativa**: un RF de **alta `R5`** con `TipoRectificativa = I` (por
///   diferencias) e importe **negativo**, referenciando la simplificada original en
///   `FacturasRectificadas`. *«Todas las facturas emitidas, en la medida en que respondan a
///   operaciones realmente efectuadas (como es el caso habitual) no pueden anularse»*.
///
/// Una rectificativa gasta número de **su propia serie** (`R2027/000001`), no de la de las ventas.
/// No es una elección de diseño: el art. 6.1.a) del RD 1619/2012 la impone «en todo caso». Sí son
/// dos contadores que mantener, que es lo que este comentario decía antes para justificar lo
/// contrario — pero eso no es un argumento contra la ley, es el precio de cumplirla.
///
/// Se llama **dentro de la transacción** de la baja: si esa transacción rueda atrás, no queda
/// registro ni se gasta número.
///
/// Si el pago no tiene registro fiscal (p. ej. un cobro hecho en modo prueba) no hay nada que anular ni que
/// rectificar, y no es un error: la baja del cobro sigue adelante. Lo que no puede es fallar y dejar
/// el cobro sin anular.
///
/// `devoluciones` son las devoluciones parciales vigentes del cobro (sus `ID_Pago`), que una baja
/// por error deshace: si la venta no existió, sus rectificativas tampoco responden a nada real y se
/// anulan, de la última a la primera, antes que la factura que rectifican.
pub async fn emitir_baja_de_pago(
    db: &WriteGuard<'_>,
    id_pago: &str,
    clase: tpv_application::ports::cuentas::ClaseBaja,
    devoluciones: &[String],
) -> AppResult<()> {
    use tpv_application::ports::cuentas::ClaseBaja;

    if clase == ClaseBaja::Error {
        for id in devoluciones.iter().rev() {
            for alta in ultimas_por_numero(altas_del_pago(db, id).await?).iter().rev() {
                if !esta_anulada(db, &alta.num_serie).await? {
                    emitir_anulacion(db, &alta.id_registro).await?;
                }
            }
        }
    }

    // Un cobro puede tener varias facturas, y se buscan POR SEPARADO: coger «la última alta del
    // pago» daba la `F3` y la baja se hacía sobre ella dejando el ticket intacto.
    //
    // - La original: su `F1` o `F2` (la última fila, por si se subsanó).
    // - Si es una `F1` corregida, las rectificativas por sustitución que la han ido reemplazando.
    //   La vigente es la última, y es la que se rectifica o se anula.
    // - Si es una `F2` canjeada, la `F3` vigente que la sustituye (sola o con otros tickets).
    let altas = altas_del_pago(db, id_pago).await?;
    let Some(original) = altas
        .iter()
        .rfind(|a| a.tipo_factura == "F1" || a.tipo_factura == "F2")
        .cloned()
    else {
        tracing::warn!(
            target: "tpv::verifactu",
            id_pago = %id_pago,
            "el cobro no tiene registro de facturación: no hay nada que anular ni rectificar"
        );
        return Ok(());
    };
    let sustitutivas = if original.tipo_factura == "F1" {
        cadena_de_sustitutivas(db, &original).await?
    } else {
        Vec::new()
    };
    let vigente = sustitutivas.last().cloned().unwrap_or_else(|| original.clone());
    let canje = if original.tipo_factura == "F2" {
        f3_vigente(db, &original.num_serie).await?
    } else {
        None
    };

    // La operación que documenta una rectificativa es la MISMA que la de la factura original, y
    // esa se efectuó otro día: la devolución se hace días después. Es, con diferencia, el caso más
    // frecuente de `FechaOperacion` en un bar — mucho más que la comanda que cruza la medianoche.
    //
    // Se toma la del original si la tenía (una venta que ya cruzó medianoche) y, si no, su fecha de
    // expedición. `emitir_alta` la descarta sola si acaba coincidiendo con la de hoy, que es el caso
    // de devolver algo cobrado esta misma mañana.
    let fecha_op_original = original
        .fecha_operacion
        .clone()
        .or_else(|| Some(original.fecha.clone()));

    match clase {
        ClaseBaja::Error => {
            // La anulación «deshace» la expedición de una factura que no respondía a una operación
            // real (FAQ de desarrolladores de la AEAT, apartado 17.2.d). Todo lo que documenta esa
            // operación se anula, de lo último expedido a lo primero.
            if let Some(c) = &canje {
                if c.sustituye_solo(&original.num_serie) {
                    emitir_anulacion(db, &c.id_registro).await?;
                } else {
                    // Una F3 que canjea también otros tickets no se puede anular: los demás siguen
                    // siendo ventas. Se contrarresta sólo la parte de este ticket con una F3
                    // negativa que lo sustituye, como hace la FAQ (apartado 27, caso 1) para
                    // corregir una F3. La FAQ no trata este caso de forma literal.
                    emitir_alta(
                        db,
                        DatosFactura {
                            tipo_factura: Some("F3".to_string()),
                            id_pago: Some(id_pago.to_string()),
                            desglose: Some(negar(&original.tramos())),
                            destinatario: Some(c.cliente()?),
                            sustituidas: vec![original.referencia()],
                            fecha_operacion: fecha_op_original.clone(),
                            ..Default::default()
                        },
                    )
                    .await?;
                }
            }
            for s in sustitutivas.iter().rev() {
                emitir_anulacion(db, &s.id_registro).await?;
            }
            emitir_anulacion(db, &original.id_registro).await?;
        }
        ClaseBaja::Devolucion => {
            // La clave sale de la factura que se rectifica (FAQ Veri*factu de la AEAT,
            // «¿Cómo registra el emisor una factura rectificativa?»):
            //   * una simplificada (`F2`) se rectifica con `R5`, que **no puede llevar
            //     destinatario** (error 1190);
            //   * una completa (`F1`) con `R1`, la de las causas del art. 80.Uno, Dos y Seis LIVA:
            //     una devolución deja «sin efecto total o parcialmente» la operación (80.Dos). Al
            //     ser completa tiene que cumplir el art. 6 del RD 1619/2012 (art. 15.5), así que
            //     lleva el cliente de la factura vigente, y en el registro su destinatario es
            //     obligatorio (error 1189).
            //
            // Se rectifica la factura VIGENTE: si la F1 se corrigió, la última rectificativa que la
            // sustituye (las FAQ del SII rectifican así una rectificativa previa, ejemplos 4 y 5).
            let (clave, destinatario) = if original.tipo_factura == "F1" {
                ("R1", Some(vigente.cliente()?))
            } else {
                ("R5", None)
            };
            // Los importes se NIEGAN sobre lo declarado, no se recalculan: es el mismo número que se
            // facturó, con el signo cambiado.
            let devuelto = negar(&vigente.tramos());

            let rectificativa = emitir_alta(
                db,
                DatosFactura {
                    tipo_factura: Some(clave.to_string()),
                    // `I` = rectificativa **por diferencias**: se declara sólo lo que cambia (el
                    // importe negativo). Es lo que marca la FAQ para una devolución.
                    tipo_rectificativa: Some("I".to_string()),
                    id_pago: Some(id_pago.to_string()),
                    desglose: Some(devuelto.clone()),
                    destinatario,
                    // Rectifica el TICKET, también si se canjeó: la `F3` no es rectificativa
                    // (art. 15.6 ROF) y lo que se declaró a efectos del IVA es la simplificada.
                    rectificadas: vec![vigente.referencia()],
                    fecha_operacion: fecha_op_original.clone(),
                    ..Default::default()
                },
            )
            .await?;

            // Si el ticket se canjeó, el cliente tiene una factura completa con un IVA que ya no
            // puede deducir. La FAQ de desarrolladores de la AEAT (apartado 27, casos 2 y 3) dice
            // cómo se corrige: tras la `R5`, «debe emitirse nueva F3 con los mismos datos de R5»,
            // con el cliente y sustituyendo a la `R5`. Vale igual si la F3 canjeó varios tickets
            // (apartado 27, punto 1: «hay que emitir una F3 por la rectificativa simplificada»).
            if let Some(c) = canje {
                emitir_alta(
                    db,
                    DatosFactura {
                        tipo_factura: Some("F3".to_string()),
                        id_pago: Some(id_pago.to_string()),
                        desglose: Some(devuelto),
                        destinatario: Some(c.cliente()?),
                        sustituidas: vec![RefFactura {
                            nif: datos_obligado(db).await?.nif,
                            num_serie: rectificativa.num_serie_factura,
                            fecha: rectificativa.fecha_expedicion,
                        }],
                        fecha_operacion: fecha_op_original,
                        ..Default::default()
                    },
                )
                .await?;
            }
        }
    }
    Ok(())
}

/// Emite la rectificativa de una devolución de PARTE de un cobro: unas líneas, o unas unidades de
/// una línea. Devuelve su número, o `None` si el cobro no tiene factura (modo prueba).
///
/// Es la misma rectificativa que la de una devolución entera (`emitir_baja_de_pago`, que explica
/// las fuentes), por la parte devuelta: `R5` si se rectifica un ticket o `R1` con el cliente si es
/// una factura completa, **por diferencias** (`I`) e importe negativo, rectificando la factura
/// vigente. Una devolución deja la operación «sin efecto total o parcialmente» (art. 80.Dos LIVA), y
/// una rectificativa por diferencias recoge sólo lo que cambia. Si el ticket se canjeó por una
/// `F3`, detrás va la `F3` con los mismos datos de la rectificativa (FAQ de desarrolladores,
/// apartado 27), como en la devolución entera.
///
/// El desglose sale de las líneas devueltas (`lineas`: importe con IVA y tipo), salvo cuando con
/// ésta queda devuelto el cobro entero (`completa`): entonces es lo que quede de lo declarado —la
/// factura vigente menos las rectificativas de las devoluciones anteriores—, para que todas juntas
/// sumen al céntimo lo que se facturó, base y cuota.
///
/// Queda ligada a la devolución (`id_pago_devolucion`), no al cobro: es su papel.
pub async fn emitir_devolucion_parcial(
    db: &WriteGuard<'_>,
    id_pago_origen: &str,
    id_pago_devolucion: &str,
    lineas: &[(Dinero, Option<f64>)],
    completa: bool,
) -> AppResult<Option<String>> {
    let del_cobro = altas_del_pago(db, id_pago_origen).await?;
    let Some(original) = del_cobro
        .iter()
        .rfind(|a| a.tipo_factura == "F1" || a.tipo_factura == "F2")
        .cloned()
    else {
        tracing::warn!(
            target: "tpv::verifactu",
            id_pago = %id_pago_origen,
            "el cobro no tiene registro de facturación: la devolución no tiene nada que rectificar"
        );
        return Ok(None);
    };
    let sustitutivas = if original.tipo_factura == "F1" {
        cadena_de_sustitutivas(db, &original).await?
    } else {
        Vec::new()
    };
    let vigente = sustitutivas.last().cloned().unwrap_or_else(|| original.clone());
    let canje = if original.tipo_factura == "F2" {
        f3_vigente(db, &original.num_serie).await?
    } else {
        None
    };
    let fecha_op_original = original
        .fecha_operacion
        .clone()
        .or_else(|| Some(original.fecha.clone()));
    let (clave, destinatario) = if original.tipo_factura == "F1" {
        ("R1", Some(vigente.cliente()?))
    } else {
        ("R5", None)
    };

    let devuelto = if completa {
        let previas = ultimas_por_numero(
            altas(
                db,
                "Tipo_Factura IN ('R1', 'R5') AND ID_Pago IN (\
                   SELECT ID_Pago FROM Pagos WHERE ID_Pago_Origen = ?1 AND Estado = 'ACTIVO' \
                   AND ID_Pago <> ?2)",
                vec![
                    Value::Text(id_pago_origen.to_string()),
                    Value::Text(id_pago_devolucion.to_string()),
                ],
            )
            .await?,
        );
        let vigente_tramos = vigente.tramos();
        let previas_tramos: Vec<Vec<TramoIva>> = previas.iter().map(Alta::tramos).collect();
        let queda = sumar_desgloses(
            std::iter::once(vigente_tramos.as_slice())
                .chain(previas_tramos.iter().map(Vec::as_slice)),
        );
        // Un tipo de IVA que ya se devolvió entero no es un tramo de esta rectificativa.
        negar(&queda)
            .into_iter()
            .filter(|t| !(t.base.es_cero() && t.cuota.es_cero()))
            .collect()
    } else {
        let iva_general = datos_obligado(db).await?.iva_general;
        let lineas: Vec<LineaTicket> = lineas
            .iter()
            .map(|(total, iva)| LineaTicket {
                total_con_iva: *total,
                tipo_iva: iva.unwrap_or(iva_general),
            })
            .collect();
        negar(&ticket::desglose(&normalizar_lineas(&lineas, iva_general)))
    };

    let rectificativa = emitir_alta(
        db,
        DatosFactura {
            tipo_factura: Some(clave.to_string()),
            tipo_rectificativa: Some("I".to_string()),
            id_pago: Some(id_pago_devolucion.to_string()),
            desglose: Some(devuelto.clone()),
            destinatario,
            rectificadas: vec![vigente.referencia()],
            fecha_operacion: fecha_op_original.clone(),
            ..Default::default()
        },
    )
    .await?;

    if let Some(c) = canje {
        emitir_alta(
            db,
            DatosFactura {
                tipo_factura: Some("F3".to_string()),
                id_pago: Some(id_pago_devolucion.to_string()),
                desglose: Some(devuelto),
                destinatario: Some(c.cliente()?),
                sustituidas: vec![RefFactura {
                    nif: datos_obligado(db).await?.nif,
                    num_serie: rectificativa.num_serie_factura.clone(),
                    fecha: rectificativa.fecha_expedicion.clone(),
                }],
                fecha_operacion: fecha_op_original,
                ..Default::default()
            },
        )
        .await?;
    }
    Ok(Some(rectificativa.num_serie_factura))
}

/// Una fila por número, la última: una subsanación repite el número de la factura que subsana.
fn ultimas_por_numero(altas: Vec<Alta>) -> Vec<Alta> {
    let mut out: Vec<Alta> = Vec::new();
    for a in altas {
        match out.iter_mut().find(|x| x.num_serie == a.num_serie) {
            Some(x) => *x = a,
            None => out.push(a),
        }
    }
    out
}

/// El desglose con el signo cambiado, tramo a tramo.
fn negar(tramos: &[TramoIva]) -> Vec<TramoIva> {
    tramos
        .iter()
        .map(|t| TramoIva { tipo: t.tipo, base: -t.base, cuota: -t.cuota })
        .collect()
}

/// Suma desgloses por tipo, tramo a tramo y sin recalcular: la base y la cuota de cada tipo son la
/// suma de las declaradas. Es lo que declara una F3 de varios tickets (FAQ, apartado 27, punto 1:
/// «F3: BI 6.000, cuota 1.260» para tres simplificadas de 1.000, 2.000 y 3.000).
fn sumar_desgloses<'a>(desgloses: impl IntoIterator<Item = &'a [TramoIva]>) -> Vec<TramoIva> {
    let mut out: Vec<TramoIva> = Vec::new();
    for d in desgloses {
        for t in d {
            match out.iter_mut().find(|x| (x.tipo - t.tipo).abs() < 1e-9) {
                Some(x) => {
                    x.base += t.base;
                    x.cuota += t.cuota;
                }
                None => out.push(t.clone()),
            }
        }
    }
    out.sort_by(|a, b| a.tipo.partial_cmp(&b.tipo).unwrap_or(std::cmp::Ordering::Equal));
    out
}

/// Emite una **factura completa en sustitución** de uno o varios tickets ya expedidos (`F3`).
///
/// Es la respuesta al *«¿me lo puedes hacer con IVA?»* del día siguiente: el cliente vuelve con el
/// ticket —o con los de un periodo— y pide factura. **No se rectifica nada** (art. 15.6 ROF):
/// canjear simplificadas por una completa no es rectificar, se emite una `F3` que las **sustituye**
/// y que sí lleva destinatario. Los tickets se quedan exactamente como están.
///
/// Canjear varios tickets en una sola F3 está permitido (FAQ de desarrolladores de la AEAT,
/// apartado 27: consulta vinculante V2543-06 de la DGT). Su desglose es la suma de los declarados,
/// y su fecha de operación la del último ticket: es el criterio de las facturas recapitulativas
/// (FAQ del SII 2.31), que la FAQ no fija para este caso.
///
/// Cada ticket tiene que ser una `F2` vigente: ni canjeado ya, ni anulado, ni devuelto.
///
/// La `F3` gasta número nuevo de la serie ordinaria y entra en la cadena como cualquier otro
/// registro. Si canjea un solo ticket queda ligada a su cobro (`ID_Pago`); si canjea varios, a
/// ninguno: sus cobros la encuentran por `FacturasSustituidas`.
pub async fn emitir_sustitutiva(
    db: &WriteGuard<'_>,
    nums_tickets: &[String],
    destinatario: vf::Destinatario,
) -> AppResult<BloqueFiscal> {
    let destinatario =
        vf::validar_destinatario(destinatario).map_err(|e| AppError::validation(e.mensaje()))?;

    let mut nums: Vec<String> = nums_tickets.iter().map(|n| n.trim().to_string()).collect();
    nums.retain(|n| !n.is_empty());
    let antes = nums.len();
    nums.sort();
    nums.dedup();
    if nums.is_empty() {
        return Err(AppError::validation("Elige al menos un ticket que facturar."));
    }
    if nums.len() != antes {
        return Err(AppError::validation("Un mismo ticket no puede ir dos veces en la factura."));
    }
    // El XSD admite como mucho 1.000 facturas sustituidas por registro.
    if nums.len() > 1000 {
        return Err(AppError::validation("Una factura puede sustituir como mucho a 1.000 tickets."));
    }

    let mut tickets: Vec<Alta> = Vec::with_capacity(nums.len());
    for num in &nums {
        let Some(t) = ultima_alta(db, num).await? else {
            return Err(AppError::not_found(format!("No existe ninguna factura con el número {num}.")));
        };
        if t.tipo_factura != "F2" {
            // Sólo una simplificada se canjea. Una `F1` ya es una factura completa y una `R5` es
            // una rectificativa: en ninguno de los dos casos hay nada que sustituir.
            return Err(AppError::conflict(format!(
                "La factura {num} es de tipo {}: sólo un ticket (factura simplificada) se puede \
                 canjear por una factura completa.",
                t.tipo_factura
            )));
        }
        // ¿Ya se canjeó? Se mira la F3 VIGENTE: una corregida con su F3 negativa deja de contar.
        if f3_vigente(db, num).await?.is_some() {
            return Err(AppError::conflict(format!(
                "Del ticket {num} ya se emitió una factura completa."
            )));
        }
        // Una F3 canjea simplificadas «facturadas y declaradas» (clave F3 de la Orden
        // HAC/1177/2024). Un ticket anulado ya no tiene efecto fiscal, y uno devuelto quedó a
        // cero con su rectificativa: en los dos casos no queda venta que facturar al cliente.
        if esta_anulada(db, num).await? {
            return Err(AppError::conflict(format!(
                "El ticket {num} está anulado: no hay venta que facturar."
            )));
        }
        if referenciado_por(db, "R5", "rectificadas", num).await? {
            return Err(AppError::conflict(format!(
                "El ticket {num} tiene una devolución: ya no se canjea por una factura."
            )));
        }
        tickets.push(t);
    }

    // El desglose es el de los tickets, con su signo: la F3 no cambia el importe, lo vuelve a
    // declarar con destinatario.
    let tramos: Vec<Vec<TramoIva>> = tickets.iter().map(|t| t.tramos()).collect();
    let desglose = sumar_desgloses(tramos.iter().map(|t| t.as_slice()));

    // La `F3` documenta LA MISMA operación que los tickets que canjea, y esos se consumieron otro
    // día. Con uno solo se hereda la suya (o su expedición si no la tenía); con varios, la del
    // último. `emitir_alta` la descarta sola si coincide con la de hoy.
    let fecha_operacion = tickets
        .iter()
        .filter_map(|t| t.fecha_operacion.clone().or_else(|| Some(t.fecha.clone())))
        .max_by_key(|f| vf_fecha_ordenable(f));
    let id_pago = match tickets.as_slice() {
        [unico] => unico.id_pago.clone(),
        _ => None,
    };

    emitir_alta(
        db,
        DatosFactura {
            tipo_factura: Some("F3".to_string()),
            id_pago,
            desglose: Some(desglose),
            destinatario: Some(Destinatario {
                nombre_razon: destinatario.nombre_razon,
                nif: destinatario.nif,
                domicilio: destinatario.direccion,
            }),
            // `FacturasSustituidas` sólo puede ir en una F3 (error 1116). Y no es
            // `FacturasRectificadas`: no se rectifica nada.
            sustituidas: tickets.iter().map(Alta::referencia).collect(),
            fecha_operacion,
            ..Default::default()
        },
    )
    .await
}

/// Corrige los datos del cliente de una factura completa ya expedida. Devuelve la factura nueva.
///
/// - **Una `F3`** (FAQ de desarrolladores de la AEAT, apartado 27, caso 1): al no haber error en
///   los tickets, no se tocan. Se emite una F3 negativa con los mismos importes y los mismos
///   tickets sustituidos, que contrarresta la errónea, y una F3 nueva con los datos correctos.
/// - **Una `F1`** (o la rectificativa que ya la sustituyó): una factura completa con el cliente mal
///   no cumple el art. 6 del RD 1619/2012, y eso obliga a rectificarla (art. 15.1). Se rectifica
///   **por sustitución** (`S`) con los mismos importes y el cliente correcto, informando en
///   `ImporteRectificacion` la base y la cuota de la que se sustituye (FAQ del SII 2.7 y 2.8,
///   opción 1). La clave es **`R4`** («resto»): un error material en los datos del destinatario no
///   es un error fundado de derecho ni una causa del art. 80 LIVA, que son las de `R1`–`R3`. Esto
///   último es una deducción: ninguna fuente oficial pone este caso como ejemplo.
///
/// Sólo se corrige la factura vigente, de un cobro que no se haya anulado ni devuelto.
pub async fn corregir_factura(
    db: &WriteGuard<'_>,
    num_factura: &str,
    destinatario: vf::Destinatario,
) -> AppResult<BloqueFiscal> {
    let destinatario =
        vf::validar_destinatario(destinatario).map_err(|e| AppError::validation(e.mensaje()))?;
    let nuevo = Destinatario {
        nombre_razon: destinatario.nombre_razon,
        nif: destinatario.nif,
        domicilio: destinatario.direccion,
    };

    let Some(f) = ultima_alta(db, num_factura).await? else {
        return Err(AppError::not_found("No existe ninguna factura con ese número."));
    };
    if esta_anulada(db, &f.num_serie).await? {
        return Err(AppError::conflict("Esa factura está anulada: no hay nada que corregir."));
    }

    match f.tipo_factura.as_str() {
        "F3" => {
            let vigente_de_sus_tickets = match f.sustituidas().first() {
                Some(primero) => f3_vigente(db, &primero.num_serie).await?,
                None => None,
            };
            if f.importe().es_negativo()
                || vigente_de_sus_tickets.as_ref().map(|v| v.num_serie.as_str()) != Some(f.num_serie.as_str())
            {
                return Err(AppError::conflict(
                    "Esa factura ya no es la vigente: se corrige la última que se emitió.",
                ));
            }
            for t in f.sustituidas() {
                if referenciado_por(db, "R5", "rectificadas", &t.num_serie).await? {
                    return Err(AppError::conflict(format!(
                        "El ticket {} tiene una devolución: su factura ya no se corrige.",
                        t.num_serie
                    )));
                }
            }
            let tramos = f.tramos();
            // La negativa es la errónea con el signo cambiado: mismos tickets, mismo cliente.
            emitir_alta(
                db,
                DatosFactura {
                    tipo_factura: Some("F3".to_string()),
                    id_pago: f.id_pago.clone(),
                    desglose: Some(negar(&tramos)),
                    destinatario: Some(f.cliente()?),
                    sustituidas: f.sustituidas(),
                    fecha_operacion: f.fecha_operacion.clone(),
                    ..Default::default()
                },
            )
            .await?;
            emitir_alta(
                db,
                DatosFactura {
                    tipo_factura: Some("F3".to_string()),
                    id_pago: f.id_pago.clone(),
                    desglose: Some(tramos),
                    destinatario: Some(nuevo),
                    sustituidas: f.sustituidas(),
                    fecha_operacion: f.fecha_operacion.clone(),
                    ..Default::default()
                },
            )
            .await
        }
        "F1" | "R1" | "R2" | "R3" | "R4" => {
            let es_sustitutiva = f.tipo_factura == "F1" || f.tipo_rectificativa.as_deref() == Some("S");
            if !es_sustitutiva || f.importe().es_negativo() {
                return Err(AppError::conflict(
                    "Esa factura no es una factura completa que se pueda corregir.",
                ));
            }
            // Vigente: nada la ha sustituido después, ni se ha devuelto.
            if referenciado_por(db, "R1", "rectificadas", &f.num_serie).await? {
                return Err(AppError::conflict(
                    "Esa factura tiene una devolución: ya no se corrige.",
                ));
            }
            if rectificada_por(db, &f.num_serie).await? {
                return Err(AppError::conflict(
                    "Esa factura ya no es la vigente: se corrige la última que se emitió.",
                ));
            }
            let tramos = f.tramos();
            emitir_alta(
                db,
                DatosFactura {
                    tipo_factura: Some("R4".to_string()),
                    tipo_rectificativa: Some("S".to_string()),
                    id_pago: f.id_pago.clone(),
                    importe_rectificacion: Some((ticket::base_total(&tramos), ticket::cuota_total(&tramos))),
                    desglose: Some(tramos),
                    destinatario: Some(nuevo),
                    rectificadas: vec![f.referencia()],
                    fecha_operacion: f.fecha_operacion.clone().or_else(|| Some(f.fecha.clone())),
                    ..Default::default()
                },
            )
            .await
        }
        otro => Err(AppError::conflict(format!(
            "Una factura de tipo {otro} no lleva cliente que corregir."
        ))),
    }
}

/// Los números de ticket de unos cobros, en el mismo orden. Un cobro sin número (modo prueba, o
/// anterior a la numeración) no tiene factura que canjear.
async fn numeros_de_ticket<C: Reader>(conn: &C, id_pagos: &[String]) -> AppResult<Vec<String>> {
    let mut out = Vec::with_capacity(id_pagos.len());
    for id in id_pagos {
        let mut rows = conn
            .query(
                "SELECT COALESCE(Numero_Ticket, '') FROM Pagos WHERE ID_Pago = ?1 LIMIT 1;",
                vec![Value::Text(id.trim().to_string())],
            )
            .await
            .map_err(db_err)?;
        let num = match rows.next().await.map_err(db_err)? {
            Some(row) => v_string(row.get_value(0).map_err(db_err)?).unwrap_or_default(),
            None => return Err(AppError::not_found("Uno de los cobros no existe.")),
        };
        if num.trim().is_empty() || vf::es_numero_de_prueba(&num) {
            return Err(AppError::conflict(
                "Uno de los cobros no tiene factura: es de antes de completar los datos fiscales o del \
                 modo prueba.",
            ));
        }
        out.push(num);
    }
    Ok(out)
}

/// `DD-MM-AAAA` → `AAAAMMDD`, para comparar fechas de factura.
fn vf_fecha_ordenable(f: &str) -> String {
    let p: Vec<&str> = f.trim().split('-').collect();
    match p.as_slice() {
        [d, m, a] => format!("{a}{m}{d}"),
        _ => f.to_string(),
    }
}
/// Los tramos de `Desglose_Json` tal como se declararon: el papel de una factura los imprime de
/// aquí, no de un recálculo (RI-29).
pub(crate) fn tramos_declarados(desglose_json: Option<&str>) -> Vec<TramoIva> {
    let Some(arr) = desglose_json
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
        .and_then(|v| v.as_array().cloned())
    else {
        return Vec::new();
    };

    arr.iter()
        .filter_map(|t| {
            // El desglose guardado lleva el TEXTO fiscal ("123.10"), que es el dato canonico:
            // se lee a centimos sin pasar por f64.
            let base = t
                .get("BaseImponibleOimporteNoSujeto")
                .and_then(|v| v.as_str())
                .and_then(Dinero::de_texto_fiscal)?;
            let cuota = t
                .get("CuotaRepercutida")
                .and_then(|v| v.as_str())
                .and_then(Dinero::de_texto_fiscal)
                .unwrap_or(Dinero::CERO);
            let tipo: f64 = t
                .get("TipoImpositivo")
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse().ok())
                .unwrap_or(0.0);
            Some(TramoIva { tipo, base, cuota })
        })
        .collect()
}

/// Vuelve a encolar para remitir **todo registro que no tenga estado de envío**.
///
/// Se llama después de restaurar (desde la nube o desde una copia local) y devuelve cuántos encoló.
///
/// ## Por qué hace falta
///
/// `Registros_Facturacion` se replica y vuelve; `_Verifactu_Envios` **no**, porque es estado local
/// del equipo. Así que tras una restauración los registros están ahí y su cola de envío está vacía:
/// el panel diría «0 pendientes» y el job no mandaría nada — incluidos los registros que nunca
/// llegaron a la AEAT. Dejar de remitir en silencio es la única forma de romper esto de verdad.
///
/// ## Por qué se REENVÍA en vez de preguntar a la AEAT
///
/// El diseño original proponía reconstruir el estado con `ConsultaFactuSistemaFacturacion`. Se hace
/// de otra forma, y es mejor por tres razones:
///
/// 1. **Ya está resuelto.** Reenviar un registro que la AEAT tiene devuelve «registro duplicado»
///    (error 3000), que el clasificador trata como aceptado. Esa idempotencia existe, está probada y
///    es la misma que cubre un corte de luz entre el envío y el guardado del resultado.
/// 2. **La consulta no lo sabe todo.** Preguntaría por lo que la AEAT tiene, pero no distingue un
///    registro que nunca se mandó de uno que se mandó y fue rechazado — y los dos hay que reenviarlos.
/// 3. **Una operación SOAP menos.** Otro mensaje, otro parser y otro modo de fallo, para llegar al
///    mismo sitio.
///
/// El precio es un envío de más por registro ya aceptado, acotado por el control de flujo (1000 por
/// envío, 60 s entre envíos) y que sólo se paga una vez tras una avería. A cambio, la verdad sobre
/// qué tiene la AEAT la sigue diciendo la AEAT, que es donde está.
///
/// ⚠️ Va por `raw()`: `_Verifactu_Envios` es estado local y por `execute()` se replicaría a la nube.
pub async fn resembrar_cola_de_envio(db: &Db) -> AppResult<usize> {
    let g = db.write().await;

    // `Creado_En_Ms` se pone al instante de la RESTAURACIÓN y no al de la factura, y es a propósito:
    // la escalera de avisos mide la antigüedad del pendiente más viejo, y fecharlos con su fecha
    // original pondría el panel en rojo («tres días sin remitir») desde el primer segundo, por algo
    // que se está arreglando solo en ese momento. Lo que la escalera tiene que medir es cuánto lleva
    // este equipo sin conseguir remitir, que empieza ahora.
    let afectadas = g
        .raw()
        .execute(
            "INSERT OR IGNORE INTO _Verifactu_Envios (ID_Registro, Estado, Creado_En_Ms) \
             SELECT r.ID_Registro, 'PENDIENTE', ?1 \
             FROM Registros_Facturacion r \
             WHERE NOT EXISTS ( \
               SELECT 1 FROM _Verifactu_Envios e WHERE e.ID_Registro = r.ID_Registro \
             );",
            vec![Value::Integer(now_ms())],
        )
        .await
        .map_err(db_err)?;

    if afectadas > 0 {
        tracing::warn!(
            target: "tpv::verifactu",
            registros = afectadas,
            "tras restaurar, {afectadas} registro(s) de facturación vuelven a la cola de envío: \
             los que la AEAT ya tenga volverán como duplicados y se darán por aceptados"
        );
    }
    Ok(afectadas as usize)
}

/// Reserva el número de la serie del ejercicio en curso. Lo llama el camino del cobro antes del
/// `INSERT INTO Pagos`, para que `Numero_Ticket` y `Num_Serie_Factura` sean el mismo número.
pub async fn reservar_numero_factura(db: &WriteGuard<'_>) -> AppResult<(String, i64)> {
    reservar_numero(db, &serie_del_cobro(db).await?).await
}

/// La serie en la que numera **un cobro**: la del ejercicio, o la del modo prueba.
///
/// Se pregunta AQUÍ, antes de reservar, porque `Pagos.Numero_Ticket` guarda ese mismo número: si se
/// decidiera después habría que descartar el reservado y el contador de la serie real quedaría con
/// un hueco. Y no hay carrera: esto y la emisión corren dentro de la misma transacción del cobro.
async fn serie_del_cobro(db: &WriteGuard<'_>) -> AppResult<String> {
    // MODO-PRUEBA (temporal): los cobros de prueba numeran aparte, y ese número es lo que después
    // dice —al emitir y al imprimir— que el cobro no expide factura.
    Ok(if en_modo_prueba(db).await? {
        vf::SERIE_MODO_PRUEBA.to_string()
    } else {
        serie_actual()
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// Piezas internas
// ─────────────────────────────────────────────────────────────────────────────

/// El último eslabón de la cadena: `MAX(Orden)`.
#[derive(Clone)]
struct Eslabon {
    nif: String,
    num_serie: String,
    fecha: String,
    huella: String,
}

/// El último eslabón **y** el resultado de la comprobación previa del art. 7.i).
///
/// Van juntos porque salen de la misma consulta: comprobar que el último registro está bien
/// encadenado exige mirar el que hay detrás de él, o sea las dos últimas filas. Separarlo en dos
/// funciones costaría una consulta más en el camino del cobro para leer lo mismo.
struct EstadoDeLaCadena {
    ultimo: Option<Eslabon>,
    anomalia: Option<vf::AnomaliaPrevia>,
}

/// Lee las **dos** últimas filas de la cadena y comprueba lo que exige el art. 7.i) de la Orden
/// HAC/1177/2024 antes de generar un registro nuevo.
///
/// Se busca por `MAX(Orden)` y **no por `rowid`**: con `rowid` la cadena dependería del orden en
/// que una restauración reinserta las filas, que no está garantizado.
///
/// ⚠️ **Lo que devuelve NO decide si se puede facturar.** La FAQ de desarrolladores de la AEAT lo
/// dice sin matices: *«será preciso generar el siguiente RF, ya que la facturación por este motivo
/// NUNCA debe interrumpirse»*. Un TPV que se niega a cobrar porque su propia cadena tiene una
/// anomalía convierte un problema de trazabilidad en un bar que no puede vender.
async fn estado_de_la_cadena<C: Reader>(conn: &C) -> AppResult<EstadoDeLaCadena> {
    let mut rows = conn
        .query(
            "SELECT NIF_Emisor, Num_Serie_Factura, Fecha_Expedicion, Huella, \
                    COALESCE(Ant_Huella, ''), Fecha_Hora_Huso \
             FROM Registros_Facturacion ORDER BY Orden DESC LIMIT 2;",
            (),
        )
        .await
        .map_err(db_err)?;

    let t = |row: &crate::ejecutor::Row, i: i32| -> AppResult<String> {
        Ok(v_string(row.get_value(i).map_err(db_err)?).unwrap_or_default())
    };

    let Some(fila_ultimo) = rows.next().await.map_err(db_err)? else {
        // Sin registros: es el primero de la cadena y no hay nada que comprobar.
        return Ok(EstadoDeLaCadena {
            ultimo: None,
            anomalia: None,
        });
    };

    let ultimo = Eslabon {
        nif: t(&fila_ultimo, 0)?,
        num_serie: t(&fila_ultimo, 1)?,
        fecha: t(&fila_ultimo, 2)?,
        huella: t(&fila_ultimo, 3)?,
    };
    let ant_declarada = t(&fila_ultimo, 4)?;
    let generado = t(&fila_ultimo, 5)?;

    let huella_penultimo = match rows.next().await.map_err(db_err)? {
        Some(fila) => Some(t(&fila, 3)?),
        None => None,
    };

    // Si la fecha del último no se puede leer no se inventa una anomalía: se da por buena. Fallar
    // aquí sería acusar a la cadena de algo que sólo prueba que no supimos parsear una fecha.
    let anomalia = match chrono::DateTime::parse_from_rfc3339(&generado) {
        Ok(dt) => vf::comprobar_registro_previo(
            Some(&vf::UltimoRegistro {
                ant_huella_declarada: if ant_declarada.is_empty() {
                    None
                } else {
                    Some(&ant_declarada)
                },
                huella_del_anterior: huella_penultimo.as_deref(),
                generado_en_segundos: dt.timestamp(),
            }),
            chrono::Local::now().timestamp(),
        ),
        Err(_) => None,
    };

    Ok(EstadoDeLaCadena {
        ultimo: Some(ultimo),
        anomalia,
    })
}

/// Anota una anomalía de la cadena en la tabla local de diagnóstico.
///
/// ⚠️ Va por `raw()`: `_Verifactu_Anomalias` es estado LOCAL del dispositivo, como `_Verifactu_Envios`
/// y `_Jobs_State`. Por `execute()` se capturaría en `_Sync_Outbox` y se replicaría a la nube el
/// diagnóstico de un equipo concreto, que allí no significa nada.
///
/// Y es **best-effort**: si esto falla, lo que NO puede es tumbar el cobro. Se está registrando una
/// anomalía, no cobrando; que el diagnóstico impida la venta sería exactamente al revés de lo que
/// pide la norma.
async fn anotar_anomalia(db: &WriteGuard<'_>, anomalia: vf::AnomaliaPrevia, id_registro: &str) {
    let clase = match anomalia {
        vf::AnomaliaPrevia::EncadenamientoRoto => "ENCADENAMIENTO",
        vf::AnomaliaPrevia::RelojHaciaAtras { .. } => "RELOJ",
    };
    tracing::error!(
        target: "tpv::verifactu",
        clase,
        id_registro,
        "{}", anomalia.mensaje()
    );
    let r = db
        .raw()
        .execute(
            "INSERT INTO _Verifactu_Anomalias (ID_Anomalia, Clase, Mensaje, ID_Registro, Detectada_En_Ms) \
             VALUES (?1, ?2, ?3, ?4, ?5);",
            vec![
                Value::Text(new_id()),
                Value::Text(clase.to_string()),
                Value::Text(anomalia.mensaje()),
                Value::Text(id_registro.to_string()),
                Value::Integer(now_ms()),
            ],
        )
        .await;
    if let Err(e) = r {
        tracing::warn!(target: "tpv::verifactu", error = %e, "no se pudo anotar la anomalía");
    }
}

async fn siguiente_orden<C: Reader>(conn: &C) -> AppResult<i64> {
    Ok(select_i64(
        conn,
        "SELECT COALESCE(MAX(Orden), 0) + 1 FROM Registros_Facturacion;",
        vec![],
    )
    .await?
    .unwrap_or(1))
}

async fn qr_de<C: Reader>(conn: &C, id_registro: &str) -> AppResult<Option<String>> {
    let mut rows = conn
        .query(
            "SELECT QR_Url FROM Registros_Facturacion WHERE ID_Registro = ?1 LIMIT 1;",
            vec![Value::Text(id_registro.to_string())],
        )
        .await
        .map_err(db_err)?;
    match rows.next().await.map_err(db_err)? {
        Some(row) => Ok(v_string(row.get_value(0).map_err(db_err)?)),
        None => Ok(None),
    }
}

/// Encola el registro para remitir.
///
/// ⚠️ Va por **`raw()`**: `_Verifactu_Envios` es una tabla de control local y por `execute()` cada
/// intento de envío se capturaría en `_Sync_Outbox` y se replicaría a la nube. El estado del envío
/// no se replica a propósito: tras una restauración [`resembrar_cola_de_envio`] vuelve a encolarlo
/// todo, y lo que la AEAT ya tenga vuelve como duplicado (3000) y se da por aceptado.
async fn encolar_envio(db: &WriteGuard<'_>, id_registro: &str) -> AppResult<()> {
    db.raw()
        .execute(
            "INSERT OR IGNORE INTO _Verifactu_Envios (ID_Registro, Estado, Creado_En_Ms) \
             VALUES (?1, 'PENDIENTE', ?2);",
            vec![
                Value::Text(id_registro.to_string()),
                Value::Integer(now_ms()),
            ],
        )
        .await
        .map_err(db_err)?;
    Ok(())
}

/// Rellena el tipo general del negocio en las líneas que no traen el suyo.
///
/// Lo hace aquí y no en el dominio porque `LineaTicket` ya lleva el tipo resuelto: quien lo
/// resuelve es quien conoce `Business_Settings`.
fn normalizar_lineas(lineas: &[LineaTicket], iva_general: f64) -> Vec<LineaTicket> {
    lineas
        .iter()
        .map(|l| LineaTicket {
            tipo_iva: if l.tipo_iva.is_nan() { iva_general } else { l.tipo_iva },
            ..l.clone()
        })
        .collect()
}

/// El desglose como JSON, listo para que el adaptador de la AEAT lo convierta en `DetalleDesglose`.
///
/// Los importes van ya **formateados como texto**, que es lo mismo que se hasheó y lo que se
/// remite: nadie los recompone desde un `f64` al construir el XML.
///
/// Todo tramo es sujeto y no exento (`S1`); ver `tpv_domain::ticket`.
///
/// `ClaveRegimen` es `"01"` (régimen general) y es **obligatorio** cuando el impuesto es IVA
/// (error 1245). `Impuesto` no se informa: vacío se considera `"01"` (IVA), que es el caso, y
/// Canarias/Ceuta/Melilla están fuera de alcance.
fn desglose_json(tramos: &[TramoIva]) -> String {
    let arr: Vec<serde_json::Value> = tramos
        .iter()
        .map(|t| {
            serde_json::json!({
                "ClaveRegimen": "01",
                "CalificacionOperacion": "S1",
                "TipoImpositivo": vf::fmt_tipo(t.tipo),
                "BaseImponibleOimporteNoSujeto": vf::fmt_importe(t.base),
                "CuotaRepercutida": vf::fmt_importe(t.cuota),
            })
        })
        .collect();
    serde_json::Value::Array(arr).to_string()
}

/// El destinatario como JSON. `NombreRazon` y `NIF` van al XML; `Domicilio` sólo al papel (el
/// adaptador de la AEAT no lo lee, y el destinatario no entra en la huella).
fn destinatario_json(d: Option<&Destinatario>) -> Option<String> {
    d.map(|d| {
        let mut v = serde_json::json!({
            "NombreRazon": vf::sanear_texto(&d.nombre_razon, 120),
            "NIF": d.nif.trim().to_ascii_uppercase(),
        });
        if let Some(dom) = d.domicilio.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            v["Domicilio"] = serde_json::Value::String(dom.to_string());
        }
        v.to_string()
    })
}

/// El destinatario guardado, para el papel: `(nombre, NIF, domicilio)`.
pub(crate) fn destinatario_del_papel(json: Option<&str>) -> Option<(String, String, Option<String>)> {
    destinatario_desde_json(json).map(|d| (d.nombre_razon, d.nif, d.domicilio))
}

/// Los números de las facturas que sustituye una `F3`, leídos de su `Referencias_Json`.
pub(crate) fn numeros_sustituidos(referencias_json: Option<&str>) -> Vec<String> {
    refs_desde_json(referencias_json, "sustituidas")
        .into_iter()
        .map(|r| r.num_serie)
        .collect()
}

/// La factura que rectifica una rectificativa, para el papel: `(número, fecha DD-MM-AAAA)`.
pub(crate) fn rectificada_del_papel(referencias_json: Option<&str>) -> Option<(String, String)> {
    refs_desde_json(referencias_json, "rectificadas")
        .into_iter()
        .next()
        .map(|r| (r.num_serie, r.fecha))
}

/// ¿Hay algún alta de tipo `tipo_factura` cuyas referencias (`clave`: `"sustituidas"` o
/// `"rectificadas"`) incluyan exactamente `num_serie`?
///
/// Se parsea el JSON en vez de buscar con `LIKE`: un número es subcadena de otros (`2027/000001`
/// está dentro de `R2027/000001`), y casar por subcadena confunde una factura con otra.
async fn referenciado_por<C: Reader>(
    conn: &C,
    tipo_factura: &str,
    clave: &str,
    num_serie: &str,
) -> AppResult<bool> {
    let mut rows = conn
        .query(
            "SELECT Referencias_Json FROM Registros_Facturacion \
             WHERE Tipo = 'ALTA' AND Tipo_Factura = ?1 AND Referencias_Json IS NOT NULL;",
            vec![Value::Text(tipo_factura.to_string())],
        )
        .await
        .map_err(db_err)?;
    while let Some(row) = rows.next().await.map_err(db_err)? {
        let refs = v_string(row.get_value(0).map_err(db_err)?);
        if refs_desde_json(refs.as_deref(), clave)
            .iter()
            .any(|r| r.num_serie.trim() == num_serie.trim())
        {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Un registro de alta, con lo que hace falta para referenciarlo, copiar su desglose o anularlo.
#[derive(Debug, Clone)]
struct Alta {
    id_registro: String,
    orden: i64,
    tipo_factura: String,
    tipo_rectificativa: Option<String>,
    nif: String,
    num_serie: String,
    fecha: String,
    importe: Option<String>,
    desglose: Option<String>,
    fecha_operacion: Option<String>,
    destinatario: Option<String>,
    referencias: Option<String>,
    id_pago: Option<String>,
}

impl Alta {
    /// Su `IDFactura`, para referenciarla desde otra.
    fn referencia(&self) -> RefFactura {
        RefFactura {
            nif: self.nif.clone(),
            num_serie: self.num_serie.clone(),
            fecha: self.fecha.clone(),
        }
    }

    /// El desglose tal como se declaró.
    fn tramos(&self) -> Vec<TramoIva> {
        tramos_declarados(self.desglose.as_deref())
    }

    fn importe(&self) -> Dinero {
        self.importe
            .as_deref()
            .and_then(Dinero::de_texto_fiscal)
            .unwrap_or(Dinero::CERO)
    }

    fn sustituidas(&self) -> Vec<RefFactura> {
        refs_desde_json(self.referencias.as_deref(), "sustituidas")
    }

    /// ¿Sustituye exactamente a esa factura y a ninguna más?
    fn sustituye_solo(&self, num: &str) -> bool {
        matches!(self.sustituidas().as_slice(), [r] if r.num_serie.trim() == num.trim())
    }

    /// Los números que sustituye, ordenados: dos F3 sustituyen «lo mismo» si coinciden.
    fn juego_sustituido(&self) -> Vec<String> {
        let mut v: Vec<String> = self.sustituidas().into_iter().map(|r| r.num_serie).collect();
        v.sort();
        v
    }

    /// Su cliente. Una factura completa siempre lo tiene; si falta, el registro está mal y no se
    /// puede emitir nada que lo copie.
    fn cliente(&self) -> AppResult<Destinatario> {
        destinatario_desde_json(self.destinatario.as_deref()).ok_or_else(|| {
            AppError::internal(format!(
                "la factura completa {} no tiene cliente guardado",
                self.num_serie
            ))
        })
    }
}

/// Las altas que cumplen `filtro`, de la más antigua a la más reciente.
async fn altas<C: Reader>(conn: &C, filtro: &str, args: Vec<Value>) -> AppResult<Vec<Alta>> {
    let sql = format!(
        "SELECT ID_Registro, Orden, COALESCE(Tipo_Factura, ''), Tipo_Rectificativa, NIF_Emisor, \
                Num_Serie_Factura, Fecha_Expedicion, Importe_Total, Desglose_Json, Fecha_Operacion, \
                Destinatario_Json, Referencias_Json, ID_Pago \
         FROM Registros_Facturacion \
         WHERE Tipo = 'ALTA' AND {filtro} \
         ORDER BY Orden ASC;"
    );
    let mut rows = conn.query(&sql, args).await.map_err(db_err)?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().await.map_err(db_err)? {
        let t = |i: i32| -> AppResult<Option<String>> { Ok(v_string(row.get_value(i).map_err(db_err)?)) };
        out.push(Alta {
            id_registro: t(0)?.unwrap_or_default(),
            orden: v_i64(row.get_value(1).map_err(db_err)?).unwrap_or(0),
            tipo_factura: t(2)?.unwrap_or_default(),
            tipo_rectificativa: t(3)?,
            nif: t(4)?.unwrap_or_default(),
            num_serie: t(5)?.unwrap_or_default(),
            fecha: t(6)?.unwrap_or_default(),
            importe: t(7)?,
            desglose: t(8)?,
            fecha_operacion: t(9)?,
            destinatario: t(10)?,
            referencias: t(11)?,
            id_pago: t(12)?,
        });
    }
    Ok(out)
}

/// Las altas de un cobro, de la más antigua a la más reciente. Va por `idx_regfact_pago`.
async fn altas_del_pago<C: Reader>(conn: &C, id_pago: &str) -> AppResult<Vec<Alta>> {
    altas(conn, "ID_Pago = ?1", vec![Value::Text(id_pago.to_string())]).await
}

/// La última fila de alta de un número: la vigente si se subsanó. Va por `idx_regfact_numserie`.
async fn ultima_alta<C: Reader>(conn: &C, num: &str) -> AppResult<Option<Alta>> {
    Ok(altas(conn, "Num_Serie_Factura = ?1", vec![Value::Text(num.trim().to_string())])
        .await?
        .pop())
}

/// ¿Tiene esa factura un registro de anulación?
async fn esta_anulada<C: Reader>(conn: &C, num: &str) -> AppResult<bool> {
    Ok(select_i64(
        conn,
        "SELECT COUNT(*) FROM Registros_Facturacion \
         WHERE Tipo = 'ANULACION' AND Num_Serie_Factura = ?1;",
        vec![Value::Text(num.trim().to_string())],
    )
    .await?
    .unwrap_or(0)
        > 0)
}

/// ¿La rectifica alguna rectificativa de una factura completa (`R1`–`R4`)?
async fn rectificada_por<C: Reader>(conn: &C, num: &str) -> AppResult<bool> {
    for clave in ["R1", "R2", "R3", "R4"] {
        if referenciado_por(conn, clave, "rectificadas", num).await? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// La `F3` vigente que canjea un ticket, sola o con otros. `None` si no se canjeó.
///
/// Una F3 deja de estar vigente cuando la contrarresta una F3 negativa con los mismos tickets y el
/// mismo importe en negativo: es como se corrige una F3 (FAQ de desarrolladores de la AEAT,
/// apartado 27, caso 1). Se recorren en el orden en que se emitieron; una subsanación repite el
/// número y reemplaza a su fila anterior.
async fn f3_vigente<C: Reader>(conn: &C, num_ticket: &str) -> AppResult<Option<Alta>> {
    let num = num_ticket.trim();
    let candidatas: Vec<Alta> = altas(
        conn,
        "Tipo_Factura = 'F3' AND Referencias_Json IS NOT NULL",
        vec![],
    )
    .await?
    .into_iter()
    .filter(|a| a.sustituidas().iter().any(|r| r.num_serie.trim() == num))
    .collect();

    let mut vigentes: Vec<Alta> = Vec::new();
    for a in candidatas {
        if let Some(previa) = vigentes.iter_mut().find(|v| v.num_serie == a.num_serie) {
            *previa = a;
            continue;
        }
        if a.importe().es_negativo() {
            let contrarrestada = vigentes.iter().rposition(|v| {
                v.juego_sustituido() == a.juego_sustituido() && v.importe() == -a.importe()
            });
            if let Some(i) = contrarrestada {
                vigentes.remove(i);
            }
            // Una F3 negativa que no contrarresta a ninguna (la de la parte de un ticket anulado
            // dentro de una F3 de varios) no es una factura vigente de este ticket.
            continue;
        }
        vigentes.push(a);
    }
    Ok(vigentes.pop())
}

/// Las rectificativas por sustitución (`R1`–`R4` con `S`) que han ido reemplazando a una factura
/// completa, de la primera a la última. La última es la vigente.
async fn cadena_de_sustitutivas<C: Reader>(conn: &C, original: &Alta) -> AppResult<Vec<Alta>> {
    let sustitutivas = altas(
        conn,
        "Tipo_Factura IN ('R1', 'R2', 'R3', 'R4') AND Tipo_Rectificativa = 'S'",
        vec![],
    )
    .await?;
    let mut cadena: Vec<Alta> = Vec::new();
    let mut actual = original.num_serie.clone();
    // Cada eslabón sustituye al anterior; el tope es una red contra un ciclo que no debería existir.
    for _ in 0..sustitutivas.len() {
        let siguiente = sustitutivas
            .iter()
            .filter(|s| {
                refs_desde_json(s.referencias.as_deref(), "rectificadas")
                    .iter()
                    .any(|r| r.num_serie.trim() == actual)
            })
            .max_by_key(|s| s.orden)
            .cloned();
        match siguiente {
            Some(s) => {
                actual = s.num_serie.clone();
                cadena.push(s);
            }
            None => break,
        }
    }
    Ok(cadena)
}

/// Las referencias de una factura a otras, y el `ImporteRectificacion` de una rectificativa por
/// sustitución, que también habla de la factura rectificada (su base y su cuota). El adaptador de
/// la AEAT escribe cada parte en su bloque; la exportación del art. 8 las lleva tal cual.
fn referencias_json(
    rect: &[RefFactura],
    sust: &[RefFactura],
    importe_rectificacion: Option<(Dinero, Dinero)>,
) -> Option<String> {
    if rect.is_empty() && sust.is_empty() && importe_rectificacion.is_none() {
        return None;
    }
    let mapear = |v: &[RefFactura]| -> Vec<serde_json::Value> {
        v.iter()
            .map(|r| {
                serde_json::json!({
                    "IDEmisorFactura": r.nif.trim(),
                    "NumSerieFactura": r.num_serie.trim(),
                    "FechaExpedicionFactura": r.fecha.trim(),
                })
            })
            .collect()
    };
    let mut v = serde_json::json!({
        "rectificadas": mapear(rect),
        "sustituidas": mapear(sust),
    });
    if let Some((base, cuota)) = importe_rectificacion {
        v["importe_rectificacion"] = serde_json::json!({
            "BaseRectificada": vf::fmt_importe(base),
            "CuotaRectificada": vf::fmt_importe(cuota),
        });
    }
    Some(v.to_string())
}

async fn select_i64<C: Reader>(conn: &C, sql: &str, args: Vec<Value>) -> AppResult<Option<i64>> {
    let mut rows = conn.query(sql, args).await.map_err(db_err)?;
    match rows.next().await.map_err(db_err)? {
        Some(row) => Ok(v_i64(row.get_value(0).map_err(db_err)?)),
        None => Ok(None),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Lecturas para el panel
// ─────────────────────────────────────────────────────────────────────────────

/// Escalones de la escalera de avisos (`docs/arquitectura/verifactu.md`, «La escalera de avisos»),
/// medidos sobre la **antigüedad del registro pendiente más viejo** y no sobre el tiempo sin
/// conexión: estar desconectado sin nada que enviar no es un problema.
///
/// Es una función **pura** para poder probarla, y ninguno de sus escalones bloquea el cobro. La
/// obligación de remitir es del bar; nuestro trabajo es que no pueda decir que no lo sabía.
pub fn escalon_aviso(antiguedad_min: Option<i64>) -> &'static str {
    match antiguedad_min {
        None => "ninguno",
        Some(m) if m < 60 => "ninguno",           // < 1 h: funcionamiento normal, incluso con fibra
        Some(m) if m < 6 * 60 => "visible",       // aviso en Configuración → Fiscal
        Some(m) if m < 24 * 60 => "notificacion", // notificación al administrador (job)
        Some(m) if m < 72 * 60 => "modal_login",  // aviso al iniciar sesión, con reconocimiento
        Some(_) => "modal_cobro",                 // aviso después de cada cobro
    }
}

/// Resumen para el panel fiscal.
pub async fn estado_fiscal<C: Reader>(conn: &C) -> AppResult<EstadoFiscal> {
    let mut nif = None;
    let mut razon_social = None;
    let mut entorno_pruebas = false;
    if let Some(row) = conn
        .query(
            "SELECT CIF, Razon_Social, Verifactu_Entorno FROM Business_Settings WHERE ID = 1 LIMIT 1;",
            (),
        )
        .await
        .map_err(db_err)?
        .next()
        .await
        .map_err(db_err)?
    {
        nif = v_string(row.get_value(0).map_err(db_err)?).filter(|s| !s.trim().is_empty());
        razon_social = v_string(row.get_value(1).map_err(db_err)?).filter(|s| !s.trim().is_empty());
        entorno_pruebas = vf::Entorno::desde_texto(
            &v_string(row.get_value(2).map_err(db_err)?).unwrap_or_default(),
        )
        .es_pruebas();
    }

    let total_registros = select_i64(conn, "SELECT COUNT(*) FROM Registros_Facturacion;", vec![])
        .await?
        .unwrap_or(0);

    let cuenta = |estado: &'static str| async move {
        select_i64(
            conn,
            "SELECT COUNT(*) FROM _Verifactu_Envios WHERE Estado = ?1;",
            vec![Value::Text(estado.to_string())],
        )
        .await
        .map(|v| v.unwrap_or(0))
    };
    let pendientes = cuenta("PENDIENTE").await?;
    let aceptados = cuenta("ACEPTADO").await?;
    let aceptados_con_errores = cuenta("ACEPTADO_CON_ERRORES").await?;
    let rechazados = cuenta("RECHAZADO").await?;

    // La antigüedad se mide contra `Creado_En_Ms`, que es cuándo se generó el registro. Medirla
    // contra el último intento diría "cero minutos" en un equipo que reintenta cada minuto sin
    // conseguirlo, que es justo el caso que la escalera existe para hacer visible.
    let mas_viejo_ms = select_i64(
        conn,
        "SELECT MIN(Creado_En_Ms) FROM _Verifactu_Envios WHERE Estado = 'PENDIENTE';",
        vec![],
    )
    .await?
    .filter(|v| *v > 0);
    let antiguedad_pendiente_min = mas_viejo_ms.map(|ms| ((now_ms() - ms) / 60_000).max(0));

    // MODO-PRUEBA (temporal): con el modo prueba no hacen falta los datos fiscales para cobrar, así
    // que no se dice que falten — el aviso de «este TPV no puede cobrar» sería falso.
    let modo_prueba = en_modo_prueba(conn).await?;
    let datos_fiscales_completos = modo_prueba
        || (nif.as_deref().map(vf::nif_valido).unwrap_or(false) && razon_social.is_some());

    let anomalias_sin_reconocer = select_i64(
        conn,
        "SELECT COUNT(*) FROM _Verifactu_Anomalias WHERE Reconocida = 0;",
        vec![],
    )
    .await?
    .unwrap_or(0);
    let ultima_anomalia = {
        let mut rows = conn
            .query(
                "SELECT Mensaje FROM _Verifactu_Anomalias WHERE Reconocida = 0 \
                 ORDER BY Detectada_En_Ms DESC LIMIT 1;",
                (),
            )
            .await
            .map_err(db_err)?;
        match rows.next().await.map_err(db_err)? {
            Some(row) => v_string(row.get_value(0).map_err(db_err)?),
            None => None,
        }
    };

    Ok(EstadoFiscal {
        datos_fiscales_completos,
        nif,
        razon_social,
        entorno_pruebas,
        total_registros,
        pendientes,
        aceptados,
        aceptados_con_errores,
        rechazados,
        antiguedad_pendiente_min,
        escalon_aviso: escalon_aviso(antiguedad_pendiente_min).to_string(),
        // Los rellena la capa que conoce el almacén de certificados (sólo Windows). Aquí se dejan
        // en el estado "no se puede remitir" para que nadie lo lea como "todo bien" por omisión.
        certificado_ok: false,
        // El orden importa: primero lo que puede arreglar el bar, después lo que sólo podemos
        // arreglar nosotros. Faltando sus datos fiscales ni siquiera puede cobrar, así que es lo
        // que tiene delante de todos modos; decirle antes «llama a soporte» sería mandarlo a hacer
        // una llamada que no resuelve lo que le impide abrir.
        motivo_no_remite: if modo_prueba {
            Some("modo_prueba".to_string())
        } else if !datos_fiscales_completos {
            Some("sin_datos_fiscales".to_string())
        } else if !productor_configurado() {
            Some("sin_datos_del_productor".to_string())
        } else {
            None
        },
        dias_para_caducar_certificado: None,
        anomalias_sin_reconocer,
        ultima_anomalia,
        modo_prueba,
    })
}

/// Emite una **subsanación** de todos los registros que la AEAT rechazó. Devuelve cuántas emitió.
///
/// ## El agujero que esto cierra
///
/// `pendientes()` sólo coge los que están `PENDIENTE`, así que **un registro rechazado se quedaba
/// ahí para siempre**: visible en el panel, contado en el marcador de rechazados y sin ninguna forma
/// de avanzar. Las columnas estaban, el XML las escribía y `marcas_de_subsanacion` decidía los
/// valores — pero no había nadie que creara la fila. Toda la maquinaria y ningún productor.
///
/// ## Qué es exactamente una subsanación
///
/// **No es una factura nueva.** Es el mismo hecho vuelto a contar bien, así que conserva el
/// `IDFactura` del original —emisor, número y fecha de expedición— y no gasta número. Lo que cambia
/// es que ocupa su propio `Orden`, se encadena al final y tiene su propia huella y su propia hora.
///
/// La marca `RechazoPrevio` distingue los dos casos, y no es cosmética:
///
/// - El original fue **rechazado** → `RechazoPrevio = "X"`. La AEAT **no tiene** ese `IDFactura`, así
///   que esto es lo primero que le llega de esa factura.
/// - El original fue **aceptado** (con o sin errores) → sin `RechazoPrevio`. La AEAT ya lo tiene y
///   esto lo sustituye.
///
/// Lo decide `marcas_de_subsanacion` a partir del estado guardado, que es donde se puede probar.
///
/// ## Por qué se reemiten los MISMOS datos
///
/// Porque en este TPV un rechazo no viene de un dato que el usuario pueda corregir: los importes los
/// calcula el dominio, el desglose sale del ticket y el destinatario se valida antes de cobrar. Un
/// rechazo es casi siempre **un fallo nuestro** —un campo mal construido, un formato— que se corrige
/// en una versión nueva del programa. Reemitir los mismos datos fiscales con el XML ya arreglado es
/// exactamente lo que hay que hacer.
///
/// Si algún día un rechazo dependiera de un dato editable, esto necesitaría una variante que lo
/// acepte. Hoy no la hay porque no hay ese caso.
pub async fn subsanar_rechazados(db: &Db) -> AppResult<usize> {
    use tpv_application::use_cases::verifactu::{marcas_de_subsanacion, EstadoEnvio};

    let g = db.write().await;

    // Los rechazados que NO tengan ya una subsanación por delante. Sin ese filtro, pulsar dos veces
    // emitiría dos subsanaciones del mismo registro — y cada una gasta un eslabón de la cadena.
    let mut ids = Vec::new();
    {
        let mut rows = g
            .query(
                "SELECT r.ID_Registro FROM Registros_Facturacion r \
                 JOIN _Verifactu_Envios e ON e.ID_Registro = r.ID_Registro \
                 WHERE e.Estado = 'RECHAZADO' \
                   AND NOT EXISTS ( \
                     SELECT 1 FROM Registros_Facturacion s \
                     WHERE s.Subsana_ID_Registro = r.ID_Registro \
                   ) \
                 ORDER BY r.Orden ASC;",
                (),
            )
            .await
            .map_err(db_err)?;
        while let Some(row) = rows.next().await.map_err(db_err)? {
            if let Some(id) = v_string(row.get_value(0).map_err(db_err)?) {
                ids.push(id);
            }
        }
    }

    let (marca, rechazo) = marcas_de_subsanacion(EstadoEnvio::Rechazado);
    let Some(marca) = marca else {
        return Ok(0);
    };

    let mut n = 0usize;
    for id in ids {
        emitir_subsanacion_de(&g, &id, marca, rechazo).await?;
        n += 1;
    }

    if n > 0 {
        tracing::warn!(
            target: "tpv::verifactu",
            subsanadas = n,
            "{n} registro(s) rechazados vuelven a la cola como subsanación"
        );
    }
    Ok(n)
}

/// Emite la subsanación de UN registro, copiando sus datos fiscales.
async fn emitir_subsanacion_de(
    db: &WriteGuard<'_>,
    id_original: &str,
    marca: &'static str,
    rechazo_previo: Option<&'static str>,
) -> AppResult<()> {
    let (num_serie, serie, numero, fecha, tipo_factura, tipo_rect, desglose, dest, refs, id_pago, fecha_op) = {
        let mut rows = db
            .query(
                "SELECT Num_Serie_Factura, Serie, Numero, Fecha_Expedicion, \
                        COALESCE(Tipo_Factura,'F2'), Tipo_Rectificativa, Desglose_Json, \
                        Destinatario_Json, Referencias_Json, ID_Pago, Fecha_Operacion \
                 FROM Registros_Facturacion WHERE ID_Registro = ?1;",
                vec![Value::Text(id_original.to_string())],
            )
            .await
            .map_err(db_err)?;
        let Some(row) = rows.next().await.map_err(db_err)? else {
            return Err(AppError::not_found("Ese registro no existe."));
        };
        let t = |i: i32| -> AppResult<Option<String>> {
            Ok(v_string(row.get_value(i).map_err(db_err)?))
        };
        (
            t(0)?.unwrap_or_default(),
            t(1)?.unwrap_or_default(),
            v_i64(row.get_value(2).map_err(db_err)?).unwrap_or(0),
            t(3)?.unwrap_or_default(),
            t(4)?.unwrap_or_else(|| "F2".to_string()),
            t(5)?,
            t(6)?,
            t(7)?,
            t(8)?,
            t(9)?,
            t(10)?,
        )
    };

    // El desglose se reconstruye del original, igual que en la `F3` y en la `R5` y por lo mismo: la
    // subsanación tiene que declarar EXACTAMENTE el mismo dinero. Recalcularlo desde el ticket podría
    // dar un céntimo distinto, y entonces habría dos versiones del mismo hecho.
    emitir_alta(
        db,
        DatosFactura {
            tipo_factura: Some(tipo_factura),
            tipo_rectificativa: tipo_rect,
            id_pago,
            desglose: Some(tramos_declarados(desglose.as_deref())),
            importe_rectificacion: importe_rectificacion_desde_json(refs.as_deref()),
            destinatario: destinatario_desde_json(dest.as_deref()),
            rectificadas: refs_desde_json(refs.as_deref(), "rectificadas"),
            sustituidas: refs_desde_json(refs.as_deref(), "sustituidas"),
            fecha_operacion: fecha_op,
            subsanar: Some(Subsanar {
                id_registro_original: id_original.to_string(),
                num_serie_factura: num_serie,
                numero,
                serie,
                fecha_expedicion: fecha,
                marca,
                rechazo_previo,
            }),
            ..Default::default()
        },
    )
    .await?;
    Ok(())
}

/// El `ImporteRectificacion` guardado (base y cuota de la factura sustituida), si lo hay.
fn importe_rectificacion_desde_json(json: Option<&str>) -> Option<(Dinero, Dinero)> {
    let v: serde_json::Value = serde_json::from_str(json?).ok()?;
    let ir = v.get("importe_rectificacion")?;
    let base = Dinero::de_texto_fiscal(ir.get("BaseRectificada")?.as_str()?)?;
    let cuota = Dinero::de_texto_fiscal(ir.get("CuotaRectificada")?.as_str()?)?;
    Some((base, cuota))
}

/// Reconstruye el destinatario desde el JSON guardado.
fn destinatario_desde_json(json: Option<&str>) -> Option<Destinatario> {
    let v: serde_json::Value = serde_json::from_str(json?).ok()?;
    Some(Destinatario {
        nombre_razon: v.get("NombreRazon")?.as_str()?.to_string(),
        nif: v.get("NIF")?.as_str()?.to_string(),
        domicilio: v.get("Domicilio").and_then(|d| d.as_str()).map(str::to_string),
    })
}

/// Reconstruye las referencias (`rectificadas` o `sustituidas`) desde el JSON guardado.
fn refs_desde_json(json: Option<&str>, clave: &str) -> Vec<RefFactura> {
    let Some(j) = json else { return vec![] };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(j) else {
        return vec![];
    };
    v.get(clave)
        .and_then(|a| a.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|r| {
                    Some(RefFactura {
                        nif: r.get("IDEmisorFactura")?.as_str()?.to_string(),
                        num_serie: r.get("NumSerieFactura")?.as_str()?.to_string(),
                        fecha: r.get("FechaExpedicionFactura")?.as_str()?.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// MODO-PRUEBA (temporal): ¿está activado? Se quita entero antes de que Veri*factu sea obligatorio.
pub async fn en_modo_prueba<C: Reader>(conn: &C) -> AppResult<bool> {
    Ok(select_i64(
        conn,
        "SELECT COALESCE(Modo_Prueba, 0) FROM Business_Settings WHERE ID = 1;",
        vec![],
    )
    .await?
    .unwrap_or(0)
        != 0)
}

/// MODO-PRUEBA (temporal): lo activa o lo desactiva. Va por `execute` porque `Business_Settings`
/// es esquema compartido y la nube tiene que saberlo como cualquier otro ajuste.
pub async fn set_modo_prueba(db: &Db, encendido: bool) -> AppResult<()> {
    let g = db.write().await;
    g.execute(
        "UPDATE Business_Settings SET Modo_Prueba = ?1 WHERE ID = 1;",
        vec![Value::Integer(i64::from(encendido))],
    )
    .await
    .map_err(db_err)?;
    Ok(())
}

/// Marca como reconocidas todas las anomalías pendientes. Devuelve cuántas.
///
/// «Reconocida» no es «resuelta»: la fila se conserva, porque lo que registra es que a este equipo le
/// pasó algo y eso no deja de ser cierto porque alguien pulse un botón. Lo único que cambia es que
/// deja de gritarlo.
pub async fn reconocer_anomalias(db: &Db) -> AppResult<usize> {
    let g = db.write().await;
    let n = g
        .raw()
        .execute(
            "UPDATE _Verifactu_Anomalias SET Reconocida = 1 WHERE Reconocida = 0;",
            Vec::<Value>::new(),
        )
        .await
        .map_err(db_err)?;
    Ok(n as usize)
}

/// Lista los registros para el panel, del más reciente al más antiguo.
pub async fn listar_registros<C: Reader>(
    conn: &C,
    limite: i64,
    desplazamiento: i64,
) -> AppResult<Vec<RegistroFiscal>> {
    let mut rows = conn
        .query(
            "SELECT r.ID_Registro, r.Orden, r.Tipo, r.Num_Serie_Factura, r.Fecha_Expedicion, \
                    r.Tipo_Factura, r.Importe_Total, r.Cuota_Total, r.Huella, r.Fecha_Hora_Huso, \
                    r.Incidencia, r.Subsanacion, r.ID_Pago, \
                    e.Estado, COALESCE(e.Intentos, 0), e.Codigo_Error, e.Descripcion_Error, e.CSV \
             FROM Registros_Facturacion r \
             LEFT JOIN _Verifactu_Envios e ON e.ID_Registro = r.ID_Registro \
             ORDER BY r.Orden DESC LIMIT ?1 OFFSET ?2;",
            vec![
                Value::Integer(limite.clamp(1, 1000)),
                Value::Integer(desplazamiento.max(0)),
            ],
        )
        .await
        .map_err(db_err)?;

    let mut out = Vec::new();
    while let Some(row) = rows.next().await.map_err(db_err)? {
        let g = |i: i32| row.get_value(i).map_err(db_err);
        out.push(RegistroFiscal {
            id_registro: v_string(g(0)?).unwrap_or_default(),
            orden: v_i64(g(1)?).unwrap_or(0),
            tipo: v_string(g(2)?).unwrap_or_default(),
            num_serie_factura: v_string(g(3)?).unwrap_or_default(),
            fecha_expedicion: v_string(g(4)?).unwrap_or_default(),
            tipo_factura: v_string(g(5)?),
            importe_total: v_string(g(6)?),
            cuota_total: v_string(g(7)?),
            huella: v_string(g(8)?).unwrap_or_default(),
            fecha_hora_huso: v_string(g(9)?).unwrap_or_default(),
            incidencia: v_string(g(10)?).unwrap_or_else(|| "N".to_string()),
            subsanacion: v_string(g(11)?),
            id_pago: v_string(g(12)?),
            estado_envio: v_string(g(13)?),
            intentos: v_i64(g(14)?).unwrap_or(0),
            codigo_error: v_string(g(15)?),
            descripcion_error: v_string(g(16)?),
            csv: v_string(g(17)?),
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests_subsanacion {
    #![allow(non_snake_case)] // los nombres en mayúsculas señalan qué afirma cada test

    //! La subsanación de un rechazo: el único camino del sistema que **no tenía productor**.
    //!
    //! Las columnas estaban, el XML las escribía y `marcas_de_subsanacion` decidía los valores, pero
    //! nadie creaba la fila. Y como `pendientes()` sólo coge los `PENDIENTE`, un registro rechazado
    //! se quedaba en el panel para siempre, contado como rechazado y sin ninguna forma de avanzar.

    use super::*;
    use crate::db::Db;
    use std::sync::Arc;

    /// Euros -> `Dinero`. Los supuestos se escriben en euros; lo que se compara son centimos.
    #[allow(dead_code)]
    fn eur(euros: f64) -> Dinero {
        Dinero::de_euros(euros)
    }

    async fn db_temporal() -> (Arc<Db>, std::path::PathBuf) {
        let dir = crate::test_temp::dir_temporal("verifactu_subsana");
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        let g = db.write().await;
        g.raw()
            .execute(
                "UPDATE Business_Settings SET CIF = 'B12345674', Razon_Social = 'Bar SL' WHERE ID = 1;",
                Vec::<Value>::new(),
            )
            .await
            .unwrap();
        drop(g);
        (db, dir)
    }

    /// Emite un alta y la deja marcada como RECHAZADA por la AEAT.
    async fn alta_rechazada(db: &Arc<Db>) -> String {
        let num = {
            let g = db.write().await;
            emitir_alta(
                &g,
                DatosFactura {
                    lineas: vec![LineaTicket {
                        total_con_iva: eur(12.10),
                        tipo_iva: 10.0,
                    }],
                    ..Default::default()
                },
            )
            .await
            .unwrap()
            .num_serie_factura
        };
        let g = db.write().await;
        g.raw()
            .execute(
                "UPDATE _Verifactu_Envios SET Estado = 'RECHAZADO', Codigo_Error = '1189';",
                Vec::<Value>::new(),
            )
            .await
            .unwrap();
        num
    }

    async fn cuenta(db: &Arc<Db>, sql: &str) -> i64 {
        let r = db.read().await;
        let mut rows = r.query(sql, Vec::<Value>::new()).await.unwrap();
        let row = rows.next().await.unwrap().unwrap();
        v_i64(row.get_value(0).unwrap()).unwrap_or(0)
    }

    #[tokio::test]
    async fn un_rechazado_vuelve_a_la_cola_como_subsanacion() {
        let (db, _dir) = db_temporal().await;
        alta_rechazada(&db).await;

        assert_eq!(subsanar_rechazados(&db).await.unwrap(), 1);

        assert_eq!(
            cuenta(&db, "SELECT COUNT(*) FROM Registros_Facturacion WHERE Subsanacion = 'S';").await,
            1
        );
        assert_eq!(
            cuenta(&db, "SELECT COUNT(*) FROM _Verifactu_Envios WHERE Estado = 'PENDIENTE';").await,
            1,
            "la subsanación sale a la cola; el rechazado se queda como estaba"
        );
    }

    #[tokio::test]
    async fn conserva_el_IDFactura_del_original_y_NO_gasta_numero() {
        // Una subsanación no es una factura nueva: es el mismo hecho vuelto a contar bien. Si gastara
        // número, el libro tendría dos facturas donde hubo una — y un hueco en la numeración real.
        let (db, _dir) = db_temporal().await;
        let num = alta_rechazada(&db).await;

        subsanar_rechazados(&db).await.unwrap();

        assert_eq!(
            cuenta(
                &db,
                &format!("SELECT COUNT(*) FROM Registros_Facturacion WHERE Num_Serie_Factura = '{num}';")
            )
            .await,
            2,
            "los dos registros comparten número"
        );
        // Y el contador no se movió: la siguiente venta es la 2.
        let g = db.write().await;
        let (siguiente, _) = reservar_numero_factura(&g).await.unwrap();
        let serie = chrono::Local::now().format("%Y").to_string();
        assert_eq!(siguiente, format!("{serie}/000002"));
    }

    #[tokio::test]
    async fn un_rechazo_lleva_RechazoPrevio_X() {
        // No es cosmético: dice si la AEAT tiene ya ese IDFactura o si esto es lo primero que le
        // llega de esa factura. Con `X` significa que NO lo tiene.
        let (db, _dir) = db_temporal().await;
        alta_rechazada(&db).await;
        subsanar_rechazados(&db).await.unwrap();

        let r = db.read().await;
        let mut rows = r
            .query(
                "SELECT Subsanacion, Rechazo_Previo FROM Registros_Facturacion WHERE Subsanacion = 'S';",
                Vec::<Value>::new(),
            )
            .await
            .unwrap();
        let row = rows.next().await.unwrap().unwrap();
        assert_eq!(v_string(row.get_value(0).unwrap()).as_deref(), Some("S"));
        assert_eq!(v_string(row.get_value(1).unwrap()).as_deref(), Some("X"));
    }

    #[tokio::test]
    async fn la_subsanacion_ocupa_su_propio_eslabon_de_la_cadena() {
        // Comparte IDFactura pero no huella: es un registro más de la cadena, con su Orden, su hora
        // de generación y su propio encadenamiento.
        let (db, _dir) = db_temporal().await;
        alta_rechazada(&db).await;
        subsanar_rechazados(&db).await.unwrap();

        let r = db.read().await;
        let mut rows = r
            .query(
                "SELECT Orden, Huella, COALESCE(Ant_Huella,'') FROM Registros_Facturacion ORDER BY Orden;",
                Vec::<Value>::new(),
            )
            .await
            .unwrap();
        // ⚠️ Cada fila se lee ENTERA antes de pedir la siguiente. Un `Row` de libsql deja de ser
        // válido en cuanto se avanza el cursor, así que guardar dos y leerlos después devuelve dos
        // veces el último — y el test compara algo consigo mismo y pasa siempre. Costó un rojo
        // desconcertante ("huellas distintas: A vs A") descubrirlo.
        let a = rows.next().await.unwrap().unwrap();
        let h_a = v_string(a.get_value(1).unwrap()).unwrap_or_default();

        let b = rows.next().await.unwrap().unwrap();
        let orden_b = v_i64(b.get_value(0).unwrap()).unwrap_or(0);
        let h_b = v_string(b.get_value(1).unwrap()).unwrap_or_default();
        let ant_b = v_string(b.get_value(2).unwrap()).unwrap_or_default();

        assert_ne!(h_a, h_b, "huellas distintas");
        assert_eq!(ant_b, h_a, "la subsanación encadena con el rechazado");
        assert_eq!(orden_b, 2);
    }

    #[tokio::test]
    async fn subsanar_dos_veces_NO_emite_dos() {
        // El botón se puede pulsar dos veces, y cada subsanación gasta un eslabón de la cadena.
        let (db, _dir) = db_temporal().await;
        alta_rechazada(&db).await;

        assert_eq!(subsanar_rechazados(&db).await.unwrap(), 1);
        assert_eq!(subsanar_rechazados(&db).await.unwrap(), 0);
        assert_eq!(cuenta(&db, "SELECT COUNT(*) FROM Registros_Facturacion;").await, 2);
    }

    #[tokio::test]
    async fn sin_rechazados_no_hace_nada() {
        let (db, _dir) = db_temporal().await;
        {
            let g = db.write().await;
            emitir_alta(
                &g,
                DatosFactura {
                    lineas: vec![LineaTicket {
                        total_con_iva: eur(12.10),
                        tipo_iva: 10.0,
                    }],
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        }
        assert_eq!(subsanar_rechazados(&db).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn el_dinero_de_la_subsanacion_es_el_MISMO() {
        // Se reconstruye del desglose del original, igual que la F3 y la R5 y por lo mismo: si
        // difiriera un céntimo, habría dos versiones del mismo hecho.
        let (db, _dir) = db_temporal().await;
        alta_rechazada(&db).await;
        subsanar_rechazados(&db).await.unwrap();

        let r = db.read().await;
        let mut rows = r
            .query(
                "SELECT Importe_Total, Cuota_Total FROM Registros_Facturacion ORDER BY Orden;",
                Vec::<Value>::new(),
            )
            .await
            .unwrap();
        // Cada fila, entera, antes de avanzar (ver la nota del test anterior). Aquí además el
        // descuido sería invisible: comparar la última consigo misma pasa siempre.
        let a = rows.next().await.unwrap().unwrap();
        let (imp_a, cuota_a) = (
            v_string(a.get_value(0).unwrap()),
            v_string(a.get_value(1).unwrap()),
        );
        let b = rows.next().await.unwrap().unwrap();
        let (imp_b, cuota_b) = (
            v_string(b.get_value(0).unwrap()),
            v_string(b.get_value(1).unwrap()),
        );
        assert_eq!(imp_a, imp_b, "mismo importe");
        assert_eq!(cuota_a, cuota_b, "misma cuota");
        assert!(imp_a.is_some(), "y no vacíos");
    }
}

#[cfg(test)]
mod tests_modo_prueba {
    //! MODO-PRUEBA (temporal). Lo que tiene que cumplirse mientras exista: que un cobro de prueba no
    //! deje ningún registro —ni pida los datos fiscales— y que no gaste número de la serie real.

    use super::*;
    use crate::db::Db;
    use std::sync::Arc;

    /// Euros -> `Dinero`. Los supuestos se escriben en euros; lo que se compara son centimos.
    #[allow(dead_code)]
    fn eur(euros: f64) -> Dinero {
        Dinero::de_euros(euros)
    }

    /// Sin NIF ni razón social: fuera del modo prueba, un cobro aquí se cortaría.
    async fn db_sin_datos_fiscales() -> Arc<Db> {
        let dir = crate::test_temp::dir_temporal("verifactu_modo_prueba");
        std::fs::create_dir_all(&dir).unwrap();
        Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap()
    }

    #[tokio::test]
    async fn en_modo_prueba_un_cobro_no_emite_registro_ni_pide_el_nif() {
        let db = db_sin_datos_fiscales().await;
        set_modo_prueba(&db, true).await.unwrap();

        let g = db.write().await;
        let numero = reservar_numero_factura(&g).await.unwrap();
        assert!(vf::es_numero_de_prueba(&numero.0), "numera en la serie de prueba: {}", numero.0);

        let bloque = emitir_cobro(&g, "pago-de-prueba", numero, eur(5.0), None).await.unwrap();
        assert!(bloque.is_none(), "un cobro de prueba no expide factura");

        let registros = select_i64(&g, "SELECT COUNT(*) FROM Registros_Facturacion;", vec![])
            .await
            .unwrap()
            .unwrap_or(0);
        assert_eq!(registros, 0);
    }

    #[tokio::test]
    async fn al_apagarlo_la_serie_del_ejercicio_sigue_sin_huecos() {
        let db = db_sin_datos_fiscales().await;
        set_modo_prueba(&db, true).await.unwrap();
        {
            let g = db.write().await;
            reservar_numero_factura(&g).await.unwrap();
        }
        set_modo_prueba(&db, false).await.unwrap();

        let g = db.write().await;
        let numero = reservar_numero_factura(&g).await.unwrap();
        assert_eq!(numero.0, format!("{}/000001", serie_actual()));
    }

    #[tokio::test]
    async fn en_modo_prueba_el_estado_no_dice_que_falten_datos_fiscales() {
        let db = db_sin_datos_fiscales().await;
        set_modo_prueba(&db, true).await.unwrap();

        let r = db.read().await;
        let e = estado_fiscal(&r).await.unwrap();
        assert!(e.modo_prueba);
        assert!(e.datos_fiscales_completos, "el aviso de «no puede cobrar» sería falso");
        assert_eq!(e.motivo_no_remite.as_deref(), Some("modo_prueba"));
    }
}

#[cfg(test)]
mod tests_anomalias_de_la_cadena {
    #![allow(non_snake_case)] // los nombres en mayúsculas señalan qué afirma cada test

    //! La comprobación previa del art. 7.i) leída de la base de datos de verdad.
    //!
    //! La aritmética está probada en `tpv_domain::verifactu`; aquí se prueba lo que sólo se puede
    //! romper en SQL: que se lean las DOS últimas filas, que se lean por `Orden` y no por `rowid`, y
    //! que anotar la anomalía no salga por el outbox ni tumbe nada.

    use super::*;
    use crate::db::Db;
    use std::sync::Arc;

    async fn db_temporal() -> (Arc<Db>, std::path::PathBuf) {
        let dir = crate::test_temp::dir_temporal("verifactu_anomalias");
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        (db, dir)
    }

    /// Inserta un registro con la huella y el eslabón declarado que se le pasen.
    async fn registro(
        db: &Arc<Db>,
        orden: i64,
        huella: &str,
        ant_huella: Option<&str>,
        fecha_hora_huso: &str,
    ) {
        let g = db.write().await;
        g.raw()
            .execute(
                "INSERT INTO Registros_Facturacion (ID_Registro, Orden, Tipo, NIF_Emisor, \
                   Num_Serie_Factura, Fecha_Expedicion, Serie, Numero, Nombre_Razon_Emisor, \
                   Cadena_Huella, Huella, Ant_Huella, Fecha_Hora_Huso, Sistema_Json, QR_Url) \
                 VALUES (?1, ?2, 'ALTA', 'B12345674', ?1, '15-01-2027', '2027', ?2, 'Bar', \
                         'c', ?3, ?4, ?5, '{}', 'u');",
                vec![
                    Value::Text(format!("r{orden}")),
                    Value::Integer(orden),
                    Value::Text(huella.to_string()),
                    match ant_huella {
                        Some(h) => Value::Text(h.to_string()),
                        None => Value::Null,
                    },
                    Value::Text(fecha_hora_huso.to_string()),
                ],
            )
            .await
            .unwrap();
    }

    fn hace(segundos: i64) -> String {
        (chrono::Local::now() - chrono::Duration::seconds(segundos))
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, false)
    }

    fn dentro_de(segundos: i64) -> String {
        (chrono::Local::now() + chrono::Duration::seconds(segundos))
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, false)
    }

    #[tokio::test]
    async fn una_cadena_sana_no_da_anomalia() {
        let (db, _dir) = db_temporal().await;
        registro(&db, 1, "H1", None, &hace(600)).await;
        registro(&db, 2, "H2", Some("H1"), &hace(300)).await;

        let r = db.read().await;
        let e = estado_de_la_cadena(&r).await.unwrap();
        assert!(e.anomalia.is_none());
        assert_eq!(e.ultimo.unwrap().huella, "H2");
    }

    #[tokio::test]
    async fn una_base_vacia_no_da_anomalia() {
        // Es el primer registro de la cadena: no hay nada detrás que comprobar.
        let (db, _dir) = db_temporal().await;
        let r = db.read().await;
        let e = estado_de_la_cadena(&r).await.unwrap();
        assert!(e.anomalia.is_none());
        assert!(e.ultimo.is_none());
    }

    #[tokio::test]
    async fn si_el_ultimo_declara_una_huella_que_no_es_la_del_anterior_lo_detecta() {
        let (db, _dir) = db_temporal().await;
        registro(&db, 1, "H1", None, &hace(600)).await;
        registro(&db, 2, "H2", Some("OTRA"), &hace(300)).await;

        let r = db.read().await;
        let e = estado_de_la_cadena(&r).await.unwrap();
        assert_eq!(e.anomalia, Some(vf::AnomaliaPrevia::EncadenamientoRoto));
    }

    #[tokio::test]
    async fn un_registro_fechado_en_el_FUTURO_delata_el_reloj_hacia_atras() {
        let (db, _dir) = db_temporal().await;
        registro(&db, 1, "H1", None, &hace(600)).await;
        registro(&db, 2, "H2", Some("H1"), &dentro_de(3600)).await;

        let r = db.read().await;
        let e = estado_de_la_cadena(&r).await.unwrap();
        assert!(matches!(
            e.anomalia,
            Some(vf::AnomaliaPrevia::RelojHaciaAtras { .. })
        ));
    }

    #[tokio::test]
    async fn una_fecha_ilegible_NO_se_convierte_en_anomalia() {
        // Fallar al parsear una fecha sólo prueba que no supimos leerla. Acusar a la cadena por eso
        // llenaría el panel de rojo por un problema de formato.
        let (db, _dir) = db_temporal().await;
        registro(&db, 1, "H1", None, "no-es-una-fecha").await;

        let r = db.read().await;
        assert!(estado_de_la_cadena(&r).await.unwrap().anomalia.is_none());
    }

    #[tokio::test]
    async fn se_leen_las_dos_ultimas_por_ORDEN_y_no_por_el_orden_de_insercion() {
        // Con `rowid` la cadena dependería del orden en que una restauración reinserta las filas.
        // Aquí se insertan al revés a propósito: la 2 antes que la 1.
        let (db, _dir) = db_temporal().await;
        registro(&db, 2, "H2", Some("H1"), &hace(300)).await;
        registro(&db, 1, "H1", None, &hace(600)).await;

        let r = db.read().await;
        let e = estado_de_la_cadena(&r).await.unwrap();
        assert_eq!(e.ultimo.unwrap().huella, "H2", "el último es el de Orden mayor");
        assert!(e.anomalia.is_none(), "y la cadena está sana");
    }

    #[tokio::test]
    async fn anotar_una_anomalia_NO_sale_por_el_outbox() {
        // `_Verifactu_Anomalias` es diagnóstico local de ESTE equipo. Por `execute()` se replicaría
        // a la nube, donde no significa nada.
        let (db, _dir) = db_temporal().await;
        {
            let g = db.write().await;
            anotar_anomalia(&g, vf::AnomaliaPrevia::EncadenamientoRoto, "r1").await;
        }

        let r = db.read().await;
        let mut rows = r
            .query(
                "SELECT (SELECT COUNT(*) FROM _Verifactu_Anomalias), \
                        (SELECT COUNT(*) FROM _Sync_Outbox WHERE Statements_Json LIKE '%Anomalias%');",
                Vec::<Value>::new(),
            )
            .await
            .unwrap();
        let row = rows.next().await.unwrap().unwrap();
        assert_eq!(v_i64(row.get_value(0).unwrap()).unwrap_or(0), 1, "se anota");
        assert_eq!(v_i64(row.get_value(1).unwrap()).unwrap_or(0), 0, "y no se replica");
    }

    #[tokio::test]
    async fn reconocer_las_deja_de_contar_pero_NO_las_borra() {
        let (db, _dir) = db_temporal().await;
        {
            let g = db.write().await;
            anotar_anomalia(&g, vf::AnomaliaPrevia::EncadenamientoRoto, "r1").await;
        }

        assert_eq!(reconocer_anomalias(&db).await.unwrap(), 1);

        let r = db.read().await;
        let mut rows = r
            .query(
                "SELECT (SELECT COUNT(*) FROM _Verifactu_Anomalias), \
                        (SELECT COUNT(*) FROM _Verifactu_Anomalias WHERE Reconocida = 0);",
                Vec::<Value>::new(),
            )
            .await
            .unwrap();
        let row = rows.next().await.unwrap().unwrap();
        assert_eq!(v_i64(row.get_value(0).unwrap()).unwrap_or(0), 1, "la fila se conserva");
        assert_eq!(v_i64(row.get_value(1).unwrap()).unwrap_or(0), 0, "pero deja de contar");
    }
}

#[cfg(test)]
mod tests_fecha_de_operacion {
    #![allow(non_snake_case)] // los nombres en mayúsculas señalan qué afirma cada test

    //! Cuándo se informa `FechaOperacion` y cuándo no.
    //!
    //! La regla no es nuestra: los arts. 6.1.i) (factura completa) y 7.1.c) (simplificada) del
    //! RD 1619/2012 la escriben igual — *«la fecha en que se hayan efectuado las operaciones que se
    //! documentan […] siempre que se trate de una fecha distinta a la de expedición de la factura»*.
    //!
    //! O sea que el campo tiene DOS condiciones y las dos se prueban aquí: se informa si difiere, y
    //! **no** se informa si coincide. La segunda es la que se olvida, y su síntoma es un XML con un
    //! dato redundante que la AEAT no necesita.

    use super::*;

    /// `emitir_alta` filtra el valor antes de guardarlo. Este es ese filtro, aislado.
    fn filtrada(fecha_operacion: Option<&str>, fecha_expedicion: &str) -> Option<String> {
        fecha_operacion
            .map(str::trim)
            .filter(|f| !f.is_empty() && *f != fecha_expedicion)
            .map(str::to_string)
    }

    #[test]
    fn si_la_operacion_es_de_OTRO_dia_se_informa() {
        // La cena que cruza la medianoche: comanda abierta el 15, cobrada el 16.
        assert_eq!(
            filtrada(Some("15-01-2027"), "16-01-2027"),
            Some("15-01-2027".to_string())
        );
    }

    #[test]
    fn si_coincide_con_la_expedicion_NO_se_informa() {
        // El caso normal de un bar, y el 99 % de las facturas. La norma condiciona el campo a que
        // sea una fecha DISTINTA, y la AEAT ya toma la de expedición cuando falta.
        assert_eq!(filtrada(Some("15-01-2027"), "15-01-2027"), None);
    }

    #[test]
    fn una_cadena_vacia_no_es_una_fecha() {
        // Un `Some("")` colado desde una fila sin dato pondría `<FechaOperacion></FechaOperacion>`
        // en el XML, que no valida contra el XSD (el tipo es una fecha, no un texto libre).
        assert_eq!(filtrada(Some(""), "15-01-2027"), None);
        assert_eq!(filtrada(Some("   "), "15-01-2027"), None);
    }

    #[test]
    fn sin_dato_no_se_inventa() {
        assert_eq!(filtrada(None, "15-01-2027"), None);
    }

    #[test]
    fn la_fecha_de_operacion_NO_entra_en_la_cadena_de_huella() {
        // Es lo que permite añadir este campo sin invalidar ninguna huella ya calculada, y lo que
        // permitió corregir el bloque del productor. Se comprueba sobre la cadena de verdad, no
        // sobre la lista de campos de memoria.
        let cadena = vf::cadena_huella_alta(&vf::EntradaHuellaAlta {
            id_emisor_factura: "89890001K",
            num_serie_factura: "2027/000001",
            fecha_expedicion_factura: "16-01-2027",
            tipo_factura: "F2",
            cuota_total: "1.10",
            importe_total: "12.10",
            huella_anterior: None,
            fecha_hora_huso: "2027-01-16T01:34:56+01:00",
        });
        assert!(
            !cadena.contains("FechaOperacion"),
            "si entrara, informarla cambiaría huellas ya emitidas: {cadena}"
        );
    }
}

#[cfg(test)]
mod tests_identidad_del_productor {
    #![allow(non_snake_case)] // los nombres en mayúsculas señalan qué afirma cada test

    //! Qué pasa con los registros emitidos ANTES de que el productor del software tuviera NIF.
    //!
    //! El agujero es silencioso y definitivo: `Sistema_Json` se congela en la fila, así que un
    //! registro creado con `"NIF":""` lo lleva vacío para siempre, la AEAT lo rechaza por formato y
    //! rellenar la constante en una versión posterior no toca las filas ya escritas.
    //!
    //! ⚠️ Estos tests **dependen de `cargo nextest`**, que ya es lo que manda CLAUDE.md. El bloque
    //! del productor es un estático del proceso (lo inyecta el shell al arrancar), así que un test que
    //! lo inyecta y otro que lo quiere vacío no pueden convivir en el mismo proceso. Con nextest cada
    //! test tiene el suyo; con `cargo test` se pisarían y el que fallara dependería del orden.

    use super::*;
    use crate::db::Db;
    use std::sync::Arc;

    async fn db_temporal() -> (Arc<Db>, std::path::PathBuf) {
        let dir = crate::test_temp::dir_temporal("verifactu_productor");
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        (db, dir)
    }

    /// Inserta un registro con el `Sistema_Json` que se le pase.
    async fn registro(db: &Arc<Db>, orden: i64, sistema_json: &str) {
        let g = db.write().await;
        g.raw()
            .execute(
                "INSERT INTO Registros_Facturacion (ID_Registro, Orden, Tipo, NIF_Emisor, \
                   Num_Serie_Factura, Fecha_Expedicion, Serie, Numero, Nombre_Razon_Emisor, \
                   Cadena_Huella, Huella, Fecha_Hora_Huso, Sistema_Json, QR_Url) \
                 VALUES (?1, ?2, 'ALTA', 'B12345674', ?1, '15-01-2027', '2027', ?2, 'Bar', \
                         'c', 'h', '2027-01-15T21:34:56+01:00', ?3, 'u');",
                vec![
                    Value::Text(format!("r{orden}")),
                    Value::Integer(orden),
                    Value::Text(sistema_json.to_string()),
                ],
            )
            .await
            .unwrap();
    }

    async fn sistema_json_de(db: &Arc<Db>, id: &str) -> String {
        let r = db.read().await;
        let mut rows = r
            .query(
                "SELECT Sistema_Json FROM Registros_Facturacion WHERE ID_Registro = ?1;",
                vec![Value::Text(id.to_string())],
            )
            .await
            .unwrap();
        let row = rows.next().await.unwrap().unwrap();
        v_string(row.get_value(0).unwrap()).unwrap_or_default()
    }

    /// El bloque tal como sale hoy: sin NIF, porque la constante está vacía a la espera de que la
    /// empresa exista.
    const SIN_IDENTIDAD: &str = r#"{"NIF":"","NombreRazon":"Altaria Lights"}"#;

    #[test]
    fn el_NIF_del_productor_se_valida_con_su_digito_de_control() {
        // No basta con "no está vacío": una errata en el NIF es tan irremitible como no tenerlo, y
        // se descubriría igual de tarde. Es además lo ÚNICO que la AEAT valida de este bloque.
        assert!(!vf::nif_valido(""));
        assert!(!vf::nif_valido("B12345678"), "dígito de control incorrecto");
        assert!(vf::nif_valido("B12345674"));
    }

    #[tokio::test]
    async fn sin_identidad_no_repara_nada_y_no_es_un_error() {
        // Es el estado en el que nace el proyecto, no una avería: la constante se rellenará cuando
        // se sepa si el productor es un autónomo o una sociedad.
        let (db, _dir) = db_temporal().await;
        registro(&db, 1, SIN_IDENTIDAD).await;

        assert_eq!(reparar_sistema_informatico(&db).await.unwrap(), 0);
        assert_eq!(sistema_json_de(&db, "r1").await, SIN_IDENTIDAD);
    }

    #[tokio::test]
    async fn con_identidad_corrige_los_que_se_emitieron_sin_ella() {
        let (db, _dir) = db_temporal().await;
        registro(&db, 1, SIN_IDENTIDAD).await;
        set_sistema_informatico(SistemaInformatico {
            nombre_razon: "Altaria Lights SL".into(),
            nif: "B12345674".into(),
            nombre_sistema: "TPV Altaria".into(),
            id_sistema: "01".into(),
            version: "1.0.0".into(),
            numero_instalacion: "t-1".into(),
        });

        assert_eq!(reparar_sistema_informatico(&db).await.unwrap(), 1);
        let json = sistema_json_de(&db, "r1").await;
        assert!(json.contains(r#""NIF":"B12345674""#), "{json}");
        assert!(!json.contains(r#""NIF":"""#));
    }

    #[tokio::test]
    async fn NO_toca_un_registro_que_la_AEAT_ya_acepto() {
        // No puede darse con el job negándose a remitir sin identidad, pero la guardia va igual: una
        // que se apoya en el comportamiento de otro módulo es una guardia prestada. Y si se tocara,
        // la copia local diría algo distinto de lo que se presentó.
        let (db, _dir) = db_temporal().await;
        registro(&db, 1, SIN_IDENTIDAD).await;
        {
            let g = db.write().await;
            g.raw()
                .execute(
                    "INSERT INTO _Verifactu_Envios (ID_Registro, Estado, CSV, Creado_En_Ms) \
                     VALUES ('r1', 'ACEPTADO', 'CSV1', 1);",
                    Vec::<Value>::new(),
                )
                .await
                .unwrap();
        }
        set_sistema_informatico(SistemaInformatico {
            nombre_razon: "Altaria Lights SL".into(),
            nif: "B12345674".into(),
            nombre_sistema: "TPV Altaria".into(),
            id_sistema: "01".into(),
            version: "1.0.0".into(),
            numero_instalacion: "t-1".into(),
        });

        assert_eq!(reparar_sistema_informatico(&db).await.unwrap(), 0);
        assert_eq!(sistema_json_de(&db, "r1").await, SIN_IDENTIDAD);
    }

    #[tokio::test]
    async fn NO_toca_un_registro_que_ya_tenia_identidad() {
        // La versión del TPV va dentro de este mismo bloque y NO se recompone: el registro de ayer
        // tiene que seguir diciendo con qué versión se generó. Reescribir de más se llevaría eso por
        // delante sin que nada lo delatara.
        let (db, _dir) = db_temporal().await;
        let viejo = r#"{"NIF":"B12345674","Version":"0.9.0"}"#;
        registro(&db, 1, viejo).await;
        set_sistema_informatico(SistemaInformatico {
            nombre_razon: "Altaria Lights SL".into(),
            nif: "B12345674".into(),
            nombre_sistema: "TPV Altaria".into(),
            id_sistema: "01".into(),
            version: "1.0.0".into(),
            numero_instalacion: "t-1".into(),
        });

        assert_eq!(reparar_sistema_informatico(&db).await.unwrap(), 0);
        assert_eq!(
            sistema_json_de(&db, "r1").await,
            viejo,
            "la versión con la que se generó no se puede reescribir"
        );
    }

    #[tokio::test]
    async fn es_idempotente() {
        let (db, _dir) = db_temporal().await;
        registro(&db, 1, SIN_IDENTIDAD).await;
        set_sistema_informatico(SistemaInformatico {
            nombre_razon: "Altaria Lights SL".into(),
            nif: "B12345674".into(),
            nombre_sistema: "TPV Altaria".into(),
            id_sistema: "01".into(),
            version: "1.0.0".into(),
            numero_instalacion: "t-1".into(),
        });

        assert_eq!(reparar_sistema_informatico(&db).await.unwrap(), 1);
        assert_eq!(reparar_sistema_informatico(&db).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn la_correccion_SI_sale_por_el_outbox() {
        // Al revés que `_Verifactu_Envios`: `Registros_Facturacion` es esquema compartido, así que
        // la copia de la nube tiene que quedar igual de corregida que la local. Si no, restaurar
        // devolvería los registros rotos.
        let (db, _dir) = db_temporal().await;
        registro(&db, 1, SIN_IDENTIDAD).await;
        set_sistema_informatico(SistemaInformatico {
            nombre_razon: "Altaria Lights SL".into(),
            nif: "B12345674".into(),
            nombre_sistema: "TPV Altaria".into(),
            id_sistema: "01".into(),
            version: "1.0.0".into(),
            numero_instalacion: "t-1".into(),
        });

        reparar_sistema_informatico(&db).await.unwrap();

        let r = db.read().await;
        let mut rows = r
            .query(
                "SELECT COUNT(*) FROM _Sync_Outbox WHERE Statements_Json LIKE '%Registros_Facturacion%';",
                Vec::<Value>::new(),
            )
            .await
            .unwrap();
        let row = rows.next().await.unwrap().unwrap();
        assert!(v_i64(row.get_value(0).unwrap()).unwrap_or(0) > 0);
    }

    async fn operaciones_en_el_outbox(db: &Arc<Db>) -> i64 {
        let r = db.read().await;
        let mut rows = r
            .query("SELECT COUNT(*) FROM _Sync_Outbox;", Vec::<Value>::new())
            .await
            .unwrap();
        let row = rows.next().await.unwrap().unwrap();
        v_i64(row.get_value(0).unwrap()).unwrap_or(0)
    }

    fn con_identidad(numero_instalacion: &str) -> SistemaInformatico {
        SistemaInformatico {
            nombre_razon: "Altaria Lights SL".into(),
            nif: "B12345674".into(),
            nombre_sistema: "TPV Altaria".into(),
            id_sistema: "01".into(),
            version: "1.0.0".into(),
            numero_instalacion: numero_instalacion.into(),
        }
    }

    #[tokio::test]
    async fn la_reparacion_NO_cambia_la_version_con_la_que_se_genero() {
        // Antes se sustituía el JSON entero por el de hoy, y con él la versión: el registro dejaba
        // de decir con qué TPV se había emitido. Sólo se rellena lo que falta.
        let (db, _dir) = db_temporal().await;
        registro(
            &db,
            1,
            r#"{"NombreRazon":"Altaria Lights","NIF":"","Version":"0.9.0","NumeroInstalacion":"t-1"}"#,
        )
        .await;
        set_sistema_informatico(con_identidad("t-1"));

        assert_eq!(reparar_sistema_informatico(&db).await.unwrap(), 1);
        let json = sistema_json_de(&db, "r1").await;
        assert!(json.contains(r#""NIF":"B12345674""#), "{json}");
        assert!(json.contains(r#""NombreRazon":"Altaria Lights SL""#), "{json}");
        assert!(json.contains(r#""Version":"0.9.0""#), "{json}");
    }

    #[tokio::test]
    async fn RI_56_rellena_el_numero_de_instalacion_que_falto() {
        // Un equipo recién instalado arranca sin licencia; lo que factura hasta reiniciar salía
        // con `NumeroInstalacion` vacío. Se rellena en cuanto se conoce, aunque el productor
        // todavía no tenga NIF: son dos huecos independientes.
        let (db, _dir) = db_temporal().await;
        registro(&db, 1, r#"{"NIF":"","NumeroInstalacion":"","Version":"0.9.0"}"#).await;
        set_sistema_informatico(SistemaInformatico {
            nif: String::new(),
            ..con_identidad("")
        });
        assert_eq!(reparar_sistema_informatico(&db).await.unwrap(), 0, "aún no se sabe");

        set_numero_instalacion("tenant-abc");
        assert_eq!(reparar_sistema_informatico(&db).await.unwrap(), 1);
        let json = sistema_json_de(&db, "r1").await;
        assert!(json.contains(r#""NumeroInstalacion":"tenant-abc""#), "{json}");
        assert!(json.contains(r#""NIF":"""#), "sin identidad del productor, el NIF se queda");
        assert!(json.contains(r#""Version":"0.9.0""#), "{json}");
    }

    #[test]
    fn RI_56_los_registros_nuevos_llevan_el_numero_tras_activar() {
        set_sistema_informatico(con_identidad(""));
        set_numero_instalacion("tenant-abc");
        assert_eq!(sistema().numero_instalacion, "tenant-abc");
        assert_eq!(sistema().version, "1.0.0", "el resto del bloque no se toca");
    }

    #[tokio::test]
    async fn sin_nada_que_reparar_no_se_sube_nada_a_la_nube() {
        // `execute()` sube al outbox toda escritura, toque filas o no. Repararlo a ciegas antes de
        // cada envío mandaría a Turso una operación vacía por vuelta.
        let (db, _dir) = db_temporal().await;
        registro(&db, 1, r#"{"NIF":"B12345674","NumeroInstalacion":"t-1"}"#).await;
        set_sistema_informatico(con_identidad("t-1"));

        assert_eq!(reparar_sistema_informatico(&db).await.unwrap(), 0);
        assert_eq!(operaciones_en_el_outbox(&db).await, 0);
    }

    #[tokio::test]
    async fn RI_01_asegurar_repara_una_vez_por_cambio_del_bloque() {
        // Es la precondición del envío: corre en cada vuelta del job, pero sólo toca la base cuando
        // el bloque ha cambiado desde la última reparación buena.
        let (db, _dir) = db_temporal().await;
        registro(&db, 1, SIN_IDENTIDAD).await;
        set_sistema_informatico(con_identidad(""));

        assert_eq!(asegurar_sistema_reparado(&db).await.unwrap(), 1);

        // Un registro roto que apareciera ahora no se buscaría: nada ha cambiado.
        registro(&db, 2, r#"{"NIF":"","NumeroInstalacion":""}"#).await;
        assert_eq!(asegurar_sistema_reparado(&db).await.unwrap(), 0);

        // La activación trae el número de instalación: eso sí es un cambio, y se vuelve a mirar.
        set_numero_instalacion("tenant-abc");
        assert_eq!(asegurar_sistema_reparado(&db).await.unwrap(), 2);
        assert!(sistema_json_de(&db, "r2").await.contains(r#""NIF":"B12345674""#));
    }
}

#[cfg(test)]
mod tests_reconciliacion {
    #![allow(non_snake_case)] // los nombres en mayúsculas señalan qué afirma cada test
    //! Qué pasa con los registros de facturación cuando el equipo recupera sus datos.
    //!
    //! `Registros_Facturacion` se replica a la nube y vuelve; `_Verifactu_Envios` **no**, porque es
    //! estado local. El agujero que esto cierra es silencioso: tras restaurar, el panel diría «0
    //! pendientes» y el job no mandaría nada — incluidos los registros que nunca llegaron a la AEAT.
    //! Dejar de remitir sin que se note es la única forma de romper esto de verdad.

    use super::*;
    use crate::db::Db;
    use std::sync::Arc;

    async fn db_temporal() -> (Arc<Db>, std::path::PathBuf) {
        let dir = crate::test_temp::dir_temporal("verifactu_recon");
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        (db, dir)
    }

    /// Inserta un registro como lo haría la restauración: la fila fiscal, **sin** su fila de envío.
    async fn registro_restaurado(db: &Arc<Db>, orden: i64, num: &str) {
        let g = db.write().await;
        g.raw()
            .execute(
                "INSERT INTO Registros_Facturacion (ID_Registro, Orden, Tipo, NIF_Emisor, \
                   Num_Serie_Factura, Fecha_Expedicion, Serie, Numero, Nombre_Razon_Emisor, \
                   Cadena_Huella, Huella, Fecha_Hora_Huso, Sistema_Json, QR_Url) \
                 VALUES (?1, ?2, 'ALTA', 'B12345674', ?3, '15-01-2027', '2027', ?2, 'Bar', \
                         'c', 'h', '2027-01-15T21:34:56+01:00', '{}', 'u');",
                vec![
                    Value::Text(format!("r{orden}")),
                    Value::Integer(orden),
                    Value::Text(num.to_string()),
                ],
            )
            .await
            .unwrap();
    }

    async fn cuenta(db: &Arc<Db>, sql: &str) -> i64 {
        let r = db.read().await;
        let mut rows = r.query(sql, Vec::<Value>::new()).await.unwrap();
        let row = rows.next().await.unwrap().unwrap();
        v_i64(row.get_value(0).unwrap()).unwrap_or(0)
    }

    #[tokio::test]
    async fn tras_restaurar_los_registros_vuelven_a_la_cola_de_envio() {
        let (db, _dir) = db_temporal().await;
        registro_restaurado(&db, 1, "2027/000001").await;
        registro_restaurado(&db, 2, "2027/000002").await;

        // Antes: los registros están, la cola está vacía. El panel diría «0 pendientes».
        assert_eq!(cuenta(&db, "SELECT COUNT(*) FROM Registros_Facturacion;").await, 2);
        assert_eq!(cuenta(&db, "SELECT COUNT(*) FROM _Verifactu_Envios;").await, 0);

        let n = resembrar_cola_de_envio(&db).await.unwrap();

        assert_eq!(n, 2);
        assert_eq!(
            cuenta(
                &db,
                "SELECT COUNT(*) FROM _Verifactu_Envios WHERE Estado = 'PENDIENTE';"
            )
            .await,
            2
        );
    }

    #[tokio::test]
    async fn no_pisa_el_estado_de_lo_que_ya_se_habia_enviado() {
        // Lo que ya tiene estado lo tiene por algo: o se envió en este equipo antes de la avería, o
        // ya se reenvió. Volver a ponerlo PENDIENTE lo mandaría otra vez para nada.
        let (db, _dir) = db_temporal().await;
        registro_restaurado(&db, 1, "2027/000001").await;
        registro_restaurado(&db, 2, "2027/000002").await;
        {
            let g = db.write().await;
            g.raw()
                .execute(
                    "INSERT INTO _Verifactu_Envios (ID_Registro, Estado, CSV, Creado_En_Ms) \
                     VALUES ('r1', 'ACEPTADO', 'CSV123', 1);",
                    Vec::<Value>::new(),
                )
                .await
                .unwrap();
        }

        let n = resembrar_cola_de_envio(&db).await.unwrap();

        assert_eq!(n, 1, "sólo encola el que no tenía estado");
        let r = db.read().await;
        let mut rows = r
            .query(
                "SELECT Estado, COALESCE(CSV,'') FROM _Verifactu_Envios WHERE ID_Registro = 'r1';",
                Vec::<Value>::new(),
            )
            .await
            .unwrap();
        let row = rows.next().await.unwrap().unwrap();
        assert_eq!(v_string(row.get_value(0).unwrap()).as_deref(), Some("ACEPTADO"));
        assert_eq!(
            v_string(row.get_value(1).unwrap()).as_deref(),
            Some("CSV123"),
            "el CSV no se puede recuperar con una consulta posterior: no se pierde"
        );
    }

    #[tokio::test]
    async fn es_idempotente() {
        // Se llama en cada restauración y en cada arranque que la reintente: la segunda vuelta no
        // puede duplicar filas ni devolver nada a PENDIENTE.
        let (db, _dir) = db_temporal().await;
        registro_restaurado(&db, 1, "2027/000001").await;

        assert_eq!(resembrar_cola_de_envio(&db).await.unwrap(), 1);
        assert_eq!(resembrar_cola_de_envio(&db).await.unwrap(), 0);
        assert_eq!(cuenta(&db, "SELECT COUNT(*) FROM _Verifactu_Envios;").await, 1);
    }

    #[tokio::test]
    async fn la_antiguedad_se_cuenta_desde_la_RESTAURACION_y_no_desde_la_factura() {
        // Si se fecharan con la fecha de la factura, la escalera de avisos pondría el panel en rojo
        // («tres días sin remitir») desde el primer segundo, por algo que se está arreglando solo en
        // ese momento. Lo que la escalera mide es cuánto lleva ESTE equipo sin conseguir remitir.
        let (db, _dir) = db_temporal().await;
        registro_restaurado(&db, 1, "2027/000001").await;
        let antes = crate::util::now_ms();

        resembrar_cola_de_envio(&db).await.unwrap();

        let creado = cuenta(&db, "SELECT Creado_En_Ms FROM _Verifactu_Envios LIMIT 1;").await;
        assert!(
            creado >= antes,
            "la cola se fecha ahora ({creado}), no con la fecha de la factura"
        );
    }

    #[tokio::test]
    async fn sin_registros_no_hace_nada() {
        let (db, _dir) = db_temporal().await;
        assert_eq!(resembrar_cola_de_envio(&db).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn reencolar_NO_sale_por_el_outbox() {
        // `_Verifactu_Envios` es estado local. Si esto fuera por `execute()`, una restauración
        // replicaría a la nube «he reencolado 400 registros», que allí no significa nada — y encima
        // con la base bloqueada para escrituras de negocio, que es justo cuando se llama.
        let (db, _dir) = db_temporal().await;
        registro_restaurado(&db, 1, "2027/000001").await;
        resembrar_cola_de_envio(&db).await.unwrap();

        assert_eq!(
            cuenta(
                &db,
                "SELECT COUNT(*) FROM _Sync_Outbox WHERE Statements_Json LIKE '%_Verifactu_Envios%';"
            )
            .await,
            0
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Euros -> `Dinero`. Los supuestos se escriben en euros; lo que
    /// se compara son centimos.
    #[allow(dead_code)]
    fn eur(euros: f64) -> Dinero {
        Dinero::de_euros(euros)
    }

    #[test]
    fn la_escalera_de_avisos_va_por_la_antiguedad_del_pendiente_mas_viejo() {
        // Sin nada que enviar no hay aviso, aunque el equipo lleve una semana sin internet: estar
        // desconectado sin cola no es un problema y avisar de ello enseña a ignorar los avisos.
        assert_eq!(escalon_aviso(None), "ninguno");
        // Menos de una hora es funcionamiento normal, incluso con fibra: el control de flujo de la
        // AEAT ya impone 60 s entre envíos.
        assert_eq!(escalon_aviso(Some(0)), "ninguno");
        assert_eq!(escalon_aviso(Some(59)), "ninguno");
        assert_eq!(escalon_aviso(Some(60)), "visible");
        assert_eq!(escalon_aviso(Some(5 * 60)), "visible");
        assert_eq!(escalon_aviso(Some(6 * 60)), "notificacion");
        assert_eq!(escalon_aviso(Some(23 * 60)), "notificacion");
        assert_eq!(escalon_aviso(Some(24 * 60)), "modal_login");
        assert_eq!(escalon_aviso(Some(71 * 60)), "modal_login");
        assert_eq!(escalon_aviso(Some(72 * 60)), "modal_cobro");
        assert_eq!(escalon_aviso(Some(1000 * 60)), "modal_cobro");
    }

    #[test]
    fn el_desglose_json_de_un_tramo_al_cero_por_ciento_informa_tipo_y_cuota() {
        // Un producto al 0 % es "sujeta y no exenta, gravada al 0 %", y ahí el tipo y la cuota son
        // OBLIGATORIOS (error 1208).
        let json = desglose_json(&[TramoIva {
            tipo: 0.0,
            base: eur(10.0),
            cuota: Dinero::CERO,
        }]);
        assert!(json.contains("\"CalificacionOperacion\":\"S1\""));
        assert!(json.contains("\"TipoImpositivo\":\"0\""));
        assert!(json.contains("\"CuotaRepercutida\":\"0.00\""));
    }

    #[test]
    fn el_desglose_json_siempre_lleva_clave_de_regimen() {
        // Error 1245: si Impuesto está vacío (que es como va: vacío se considera IVA), ClaveRegimen
        // es obligatorio.
        let json = desglose_json(&[
            TramoIva { tipo: 10.0, base: eur(10.0), cuota: eur(1.0) },
            TramoIva { tipo: 21.0, base: eur(5.0), cuota: eur(1.05) },
        ]);
        assert_eq!(json.matches("\"ClaveRegimen\":\"01\"").count(), 2);
    }

    #[test]
    fn sin_referencias_no_se_escribe_el_bloque() {
        // Informar `FacturasRectificadas` en una factura que no es rectificativa es el error 1117.
        assert!(referencias_json(&[], &[], None).is_none());
    }

    #[test]
    fn el_importe_rectificado_se_guarda_como_texto_fiscal_y_se_lee_igual() {
        // Lo lee la subsanación para repetir la rectificativa: si no volviera idéntico, la
        // subsanación declararía otra cosa que el original.
        let r = RefFactura { nif: "B12345674".into(), num_serie: "2027/000001".into(), fecha: "01-01-2027".into() };
        let json = referencias_json(&[r], &[], Some((eur(2.73), eur(0.27)))).unwrap();
        assert!(json.contains("\"BaseRectificada\":\"2.73\""), "{json}");
        assert_eq!(importe_rectificacion_desde_json(Some(&json)), Some((eur(2.73), eur(0.27))));
        assert_eq!(importe_rectificacion_desde_json(Some("{\"rectificadas\":[]}")), None);
    }

    #[test]
    fn sumar_desgloses_suma_por_tipo_sin_recalcular() {
        let t = |tipo: f64, b: f64, c: f64| TramoIva { tipo, base: eur(b), cuota: eur(c) };
        let suma = sumar_desgloses([
            vec![t(10.0, 0.95, 0.10)].as_slice(),
            vec![t(21.0, 1.00, 0.21), t(10.0, 0.95, 0.10)].as_slice(),
        ]);
        assert_eq!(suma, vec![t(10.0, 1.90, 0.20), t(21.0, 1.00, 0.21)]);
    }

    #[test]
    fn las_fechas_de_factura_se_ordenan_por_dia_real() {
        // DD-MM-AAAA no se ordena como texto: el 31-01 iría detrás del 01-02.
        assert!(vf_fecha_ordenable("01-02-2027") > vf_fecha_ordenable("31-01-2027"));
        assert!(vf_fecha_ordenable("01-01-2028") > vf_fecha_ordenable("31-12-2027"));
    }

    #[test]
    fn el_sistema_informatico_por_defecto_no_finge_estar_configurado() {
        // Que el shell no lo inyecte es un bug nuestro, pero no puede parar la caja. Lo que sí
        // tiene que hacer es NO inventarse un productor.
        let s = sistema();
        assert!(s.nif.is_empty());
        assert!(s.nombre_razon.is_empty());
        // Y las tres constantes de diseño van siempre, porque no dependen de la configuración.
        let json = s.to_json();
        assert!(json.contains("\"TipoUsoPosibleSoloVerifactu\":\"S\""));
        assert!(json.contains("\"TipoUsoPosibleMultiOT\":\"N\""));
        assert!(json.contains("\"IndicadorMultiplesOT\":\"N\""));
    }

    #[test]
    fn el_id_del_sistema_informatico_se_recorta_a_dos_caracteres() {
        // `IdSistemaInformatico` es TextMax2Type. Es fácil pasarlo por alto y mandar el nombre.
        let s = SistemaInformatico {
            nombre_razon: "Altaria Lights SL".into(),
            nif: "B12345674".into(),
            nombre_sistema: "TPV Altaria".into(),
            id_sistema: "DEMASIADO LARGO".into(),
            version: "1.2.3".into(),
            numero_instalacion: "tenant-abc".into(),
        };
        assert!(s.to_json().contains("\"IdSistemaInformatico\":\"DE\""));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Adaptador del puerto
// ─────────────────────────────────────────────────────────────────────────────

use std::sync::Arc;

use async_trait::async_trait;
use tpv_application::ports::aeat::RegistroParaEnvio;
use tpv_application::ports::verifactu::{ResultadoRegistro, VerifactuRepository};

use crate::db::Db;

/// Implementación SQLite de [`VerifactuRepository`].
pub struct SqliteVerifactuRepository {
    db: Arc<Db>,
}

impl SqliteVerifactuRepository {
    pub fn new(db: Arc<Db>) -> Self {
        Self { db }
    }
}

#[async_trait]
impl VerifactuRepository for SqliteVerifactuRepository {
    async fn estado(&self) -> AppResult<EstadoFiscal> {
        let g = self.db.read().await;
        estado_fiscal(&g).await
    }

    async fn listar(&self, limite: i64, desplazamiento: i64) -> AppResult<Vec<RegistroFiscal>> {
        let g = self.db.read().await;
        listar_registros(&g, limite, desplazamiento).await
    }

    // ── Cola de envío ───────────────────────────────────────────────────────────────────────────

    async fn pendientes(&self, limite: i64) -> AppResult<Vec<RegistroParaEnvio>> {
        let g = self.db.read().await;
        // Por `Orden` ASCENDENTE y no por fecha: la AEAT valida cada registro contra su
        // encadenamiento anterior, así que mandar el eslabón N+1 antes que el N es mandarlo contra
        // una huella que todavía no tiene.
        let mut rows = g
            .query(
                "SELECT r.ID_Registro, r.Tipo, r.NIF_Emisor, r.Num_Serie_Factura, \
                        r.Fecha_Expedicion, r.Nombre_Razon_Emisor, r.Tipo_Factura, \
                        r.Tipo_Rectificativa, r.Descripcion_Operacion, r.Importe_Total, \
                        r.Cuota_Total, r.Desglose_Json, r.Destinatario_Json, r.Referencias_Json, \
                        r.Macrodato, r.Primer_Registro, r.Ant_NIF, r.Ant_Num_Serie, r.Ant_Fecha, \
                        r.Ant_Huella, r.Huella, r.Tipo_Huella, r.Fecha_Hora_Huso, r.Sistema_Json, \
                        r.Subsanacion, r.Rechazo_Previo, r.Sin_Registro_Previo, \
                        r.Fecha_Operacion \
                 FROM Registros_Facturacion r \
                 JOIN _Verifactu_Envios e ON e.ID_Registro = r.ID_Registro \
                 WHERE e.Estado = 'PENDIENTE' \
                 ORDER BY r.Orden ASC LIMIT ?1;",
                vec![Value::Integer(limite.clamp(1, 1000))],
            )
            .await
            .map_err(db_err)?;

        let mut out = Vec::new();
        while let Some(row) = rows.next().await.map_err(db_err)? {
            let g = |i: i32| row.get_value(i).map_err(db_err);
            out.push(RegistroParaEnvio {
                id_registro: v_string(g(0)?).unwrap_or_default(),
                tipo: v_string(g(1)?).unwrap_or_else(|| "ALTA".to_string()),
                nif_emisor: v_string(g(2)?).unwrap_or_default(),
                num_serie_factura: v_string(g(3)?).unwrap_or_default(),
                fecha_expedicion: v_string(g(4)?).unwrap_or_default(),
                // Va la última en el SELECT (índice 27) aunque su columna esté al principio de la
                // tabla: añadirla en medio desplazaría los índices siguientes de golpe.
                //
                // RI-88: se leía la 26, que es `Sin_Registro_Previo`, y `FechaOperacion` no llegaba
                // nunca a la AEAT. Lo vigila `tests_cola_de_envio`.
                fecha_operacion: v_string(g(27)?),
                nombre_razon_emisor: v_string(g(5)?).unwrap_or_default(),
                tipo_factura: v_string(g(6)?),
                tipo_rectificativa: v_string(g(7)?),
                descripcion_operacion: v_string(g(8)?),
                importe_total: v_string(g(9)?),
                cuota_total: v_string(g(10)?),
                desglose_json: v_string(g(11)?),
                destinatario_json: v_string(g(12)?),
                referencias_json: v_string(g(13)?),
                macrodato: v_string(g(14)?),
                primer_registro: v_string(g(15)?),
                ant_nif: v_string(g(16)?),
                ant_num_serie: v_string(g(17)?),
                ant_fecha: v_string(g(18)?),
                ant_huella: v_string(g(19)?),
                huella: v_string(g(20)?).unwrap_or_default(),
                tipo_huella: v_string(g(21)?).unwrap_or_else(|| "01".to_string()),
                fecha_hora_huso: v_string(g(22)?).unwrap_or_default(),
                sistema_json: v_string(g(23)?).unwrap_or_default(),
                subsanacion: v_string(g(24)?),
                rechazo_previo: v_string(g(25)?),
                sin_registro_previo: v_string(g(26)?),
            });
        }
        Ok(out)
    }

    async fn contar_pendientes(&self) -> AppResult<i64> {
        let g = self.db.read().await;
        Ok(select_i64(
            &g,
            "SELECT COUNT(*) FROM _Verifactu_Envios WHERE Estado = 'PENDIENTE';",
            vec![],
        )
        .await?
        .unwrap_or(0))
    }

    async fn flujo(&self) -> AppResult<(i64, Option<i64>)> {
        let g = self.db.read().await;
        let mut rows = g
            .query(
                "SELECT Espera_Segundos, Ultimo_Envio_Ms FROM _Verifactu_Flujo WHERE ID = 1;",
                (),
            )
            .await
            .map_err(db_err)?;
        match rows.next().await.map_err(db_err)? {
            Some(row) => Ok((
                v_i64(row.get_value(0).map_err(db_err)?).unwrap_or(60),
                v_i64(row.get_value(1).map_err(db_err)?).filter(|v| *v > 0),
            )),
            // La migración `0001_inicial.sql` (§16) siembra la fila con ID = 1 y espera 60.
            // Si falta, esta lectura devuelve ese valor inicial y ningún último envío.
            None => Ok((60, None)),
        }
    }

    async fn guardar_flujo(&self, espera_s: i64, ultimo_envio_ms: i64) -> AppResult<()> {
        let g = self.db.write().await;
        // Por `raw()`: `_Verifactu_Flujo` es estado local del equipo. Por `execute()` cada envío
        // replicaría a la nube «el TPV acaba de hablar con Hacienda», que no le importa a nadie y
        // ensucia el outbox.
        g.raw()
            .execute(
                "UPDATE _Verifactu_Flujo SET Espera_Segundos = ?1, Ultimo_Envio_Ms = ?2 WHERE ID = 1;",
                vec![Value::Integer(espera_s), Value::Integer(ultimo_envio_ms)],
            )
            .await
            .map_err(db_err)?;
        Ok(())
    }

    async fn marcar_resultados(&self, resultados: &[ResultadoRegistro]) -> AppResult<()> {
        if resultados.is_empty() {
            return Ok(());
        }
        // RI-34: todo el lote en UNA transacción, que es un solo commit a disco en vez de uno por
        // registro. Va por `raw()` porque `_Verifactu_Envios` es estado local; el COMMIT del guard
        // no tiene nada que capturar en el outbox.
        let g = self.db.write().await;
        let ahora = now_ms();
        g.transaccion(async {
        for r in resultados {
            g
                .raw()
                .execute(
                    // El CSV se guarda con `COALESCE(?, CSV)`: la propia documentación avisa de que
                    // no se puede recuperar con una consulta posterior, así que una respuesta que
                    // no lo traiga no puede borrar el que ya teníamos.
                    "UPDATE _Verifactu_Envios \
                     SET Estado = ?2, Intentos = Intentos + 1, Ultimo_Intento_Ms = ?3, \
                         Codigo_Error = ?4, Descripcion_Error = ?5, CSV = COALESCE(?6, CSV) \
                     WHERE ID_Registro = ?1;",
                    vec![
                        Value::Text(r.id_registro.clone()),
                        Value::Text(r.estado.to_string()),
                        Value::Integer(ahora),
                        r.codigo_error.map(|c| Value::Text(c.to_string())).unwrap_or(Value::Null),
                        opt_text(r.descripcion_error.clone()),
                        opt_text(r.csv.clone()),
                    ],
                )
                .await.map_err(db_err)?;
        }
            Ok(())
        }).await
    }

    async fn marcar_intento(&self, ids: &[String]) -> AppResult<()> {
        if ids.is_empty() {
            return Ok(());
        }
        // RI-34: una sola sentencia. Antes era un `UPDATE` por registro con el escritor tomado
        // todo el rato, así que tras un fallo de transporte con el lote lleno un cobro esperaba a
        // mil escrituras seguidas.
        //
        // El estado NO se toca: siguen PENDIENTE. Un fallo de transporte no dice nada de si la AEAT
        // los tiene o no, y darlos por perdidos sería tan malo como darlos por buenos.
        let ids_json = serde_json::to_string(ids)
            .map_err(|e| AppError::internal(format!("serializando los ids: {e}")))?;
        let g = self.db.write().await;
        g.raw()
            .execute(
                "UPDATE _Verifactu_Envios \
                 SET Intentos = Intentos + 1, Ultimo_Intento_Ms = ?2 \
                 WHERE ID_Registro IN (SELECT value FROM json_each(?1));",
                vec![Value::Text(ids_json), Value::Integer(now_ms())],
            )
            .await
            .map_err(db_err)?;
        Ok(())
    }

    async fn emitir_sustitutiva(
        &self,
        id_pagos: &[String],
        destinatario: vf::Destinatario,
    ) -> AppResult<BloqueFiscal> {
        // En su propia transacción: la `F3` gasta número y entra en la cadena, así que o se escribe
        // entera o no se escribe.
        let g = self.db.write().await;
        g.transaccion(async {
            let nums = numeros_de_ticket(&g, id_pagos).await?;
            emitir_sustitutiva(&g, &nums, destinatario).await
        }).await
    }

    async fn corregir_factura(
        &self,
        num_factura: &str,
        destinatario: vf::Destinatario,
    ) -> AppResult<BloqueFiscal> {
        // Las dos facturas de una corrección de F3 (la negativa y la nueva) van juntas o no van.
        let g = self.db.write().await;
        g.transaccion(corregir_factura(&g, num_factura, destinatario)).await
    }

    async fn obligado(&self) -> AppResult<Option<(String, String, bool)>> {
        let g = self.db.read().await;
        match datos_obligado(&g).await {
            Ok(d) => Ok(Some((d.nif, d.razon_social, d.entorno.es_pruebas()))),
            // Faltan los datos fiscales: no es un error del job, es una tarea del dueño. Se
            // devuelve `None` para que el job lo diga con un mensaje y no con una traza.
            Err(e) if e.code() == ErrorCode::DatosFiscalesIncompletos => Ok(None),
            Err(e) => Err(e),
        }
    }
}

/// Para los tests: canjea un ticket por su NÚMERO, en su transacción, como hace el repositorio con
/// los cobros. Los tests parten del número que leen del registro.
#[cfg(test)]
pub(crate) struct CanjePorNumero(pub std::sync::Arc<crate::db::Db>);

#[cfg(test)]
impl CanjePorNumero {
    pub(crate) async fn emitir_sustitutiva(
        &self,
        num: &str,
        destinatario: vf::Destinatario,
    ) -> AppResult<BloqueFiscal> {
        let g = self.0.write().await;
        g.transaccion(emitir_sustitutiva(&g, &[num.to_string()], destinatario)).await
    }
}

#[cfg(test)]
mod tests_cola_de_envio {
    #![allow(non_snake_case)] // los nombres en mayúsculas señalan qué afirma cada test

    //! Lo que `pendientes()` lee de la fila es lo que sale en el XML. Sus columnas se leen por
    //! posición, así que cada campo que no entra en la huella necesita un test que lo vea salir:
    //! si se cruzan, la AEAT no lo rechaza y nadie se entera (RI-88).

    use super::*;

    async fn db_temporal() -> (Arc<Db>, std::path::PathBuf) {
        let dir = crate::test_temp::dir_temporal("verifactu_cola");
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        (db, dir)
    }

    /// Un registro pendiente con su `Fecha_Operacion` y su `Sin_Registro_Previo`.
    async fn pendiente(db: &Arc<Db>, fecha_operacion: Option<&str>, sin_registro_previo: Option<&str>) {
        let g = db.write().await;
        g.raw()
            .execute(
                "INSERT INTO Registros_Facturacion (ID_Registro, Orden, Tipo, NIF_Emisor, \
                   Num_Serie_Factura, Fecha_Expedicion, Fecha_Operacion, Serie, Numero, \
                   Nombre_Razon_Emisor, Cadena_Huella, Huella, Fecha_Hora_Huso, \
                   Sin_Registro_Previo, Sistema_Json, QR_Url) \
                 VALUES ('r1', 1, 'ALTA', 'B12345674', '2027/000001', '16-01-2027', ?1, '2027', 1, \
                         'Bar', 'c', 'h', '2027-01-16T01:34:56+01:00', ?2, '{}', 'u');",
                vec![
                    fecha_operacion.map(|v| Value::Text(v.into())).unwrap_or(Value::Null),
                    sin_registro_previo.map(|v| Value::Text(v.into())).unwrap_or(Value::Null),
                ],
            )
            .await
            .unwrap();
        g.raw()
            .execute(
                "INSERT INTO _Verifactu_Envios (ID_Registro, Estado, Creado_En_Ms) \
                 VALUES ('r1', 'PENDIENTE', 1);",
                Vec::<Value>::new(),
            )
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn la_FECHA_DE_OPERACION_guardada_es_la_que_sale_hacia_la_AEAT() {
        // La cena que cruza la medianoche: abierta el 15, cobrada el 16.
        let (db, _dir) = db_temporal().await;
        pendiente(&db, Some("15-01-2027"), None).await;

        let lote = SqliteVerifactuRepository::new(db).pendientes(10).await.unwrap();
        assert_eq!(lote.len(), 1);
        assert_eq!(lote[0].fecha_operacion.as_deref(), Some("15-01-2027"));
        assert_eq!(lote[0].sin_registro_previo, None);
    }

    #[tokio::test]
    async fn SIN_REGISTRO_PREVIO_no_se_cuela_como_fecha_de_operacion() {
        let (db, _dir) = db_temporal().await;
        pendiente(&db, None, Some("S")).await;

        let lote = SqliteVerifactuRepository::new(db).pendientes(10).await.unwrap();
        assert_eq!(lote[0].fecha_operacion, None);
        assert_eq!(lote[0].sin_registro_previo.as_deref(), Some("S"));
    }

    #[tokio::test]
    async fn el_NIF_del_negocio_sale_hacia_la_AEAT_SIN_GUIONES_ni_espacios() {
        // RI-14: la validación los quita, así que `B-12345674` se daba por bueno; si saliera tal
        // cual, serían diez caracteres en cada registro y la AEAT los rechazaría todos.
        let (db, _dir) = db_temporal().await;
        {
            let g = db.write().await;
            g.raw()
                .execute(
                    "UPDATE Business_Settings SET CIF = ' b-1234 5674 ', Razon_Social = 'Bar SL' \
                     WHERE ID = 1;",
                    Vec::<Value>::new(),
                )
                .await
                .unwrap();
        }
        let (nif, _, _) = SqliteVerifactuRepository::new(db).obligado().await.unwrap().unwrap();
        assert_eq!(nif, "B12345674");
    }

    /// Filas de `_Verifactu_Envios` en PENDIENTE, con un CSV previo en la primera.
    async fn envios(db: &Arc<Db>, ids: &[&str]) {
        let g = db.write().await;
        for (i, id) in ids.iter().enumerate() {
            g.raw()
                .execute(
                    "INSERT INTO _Verifactu_Envios (ID_Registro, Estado, CSV, Creado_En_Ms) \
                     VALUES (?1, 'PENDIENTE', ?2, 1);",
                    vec![
                        Value::Text((*id).into()),
                        if i == 0 { Value::Text("CSV-VIEJO".into()) } else { Value::Null },
                    ],
                )
                .await
                .unwrap();
        }
    }

    async fn fila(db: &Arc<Db>, id: &str) -> (String, i64, Option<String>, Option<String>) {
        let r = db.read().await;
        let mut rows = r
            .query(
                "SELECT Estado, Intentos, Codigo_Error, CSV FROM _Verifactu_Envios WHERE ID_Registro = ?1;",
                vec![Value::Text(id.into())],
            )
            .await
            .unwrap();
        let row = rows.next().await.unwrap().unwrap();
        (
            v_string(row.get_value(0).unwrap()).unwrap(),
            v_i64(row.get_value(1).unwrap()).unwrap(),
            v_string(row.get_value(2).unwrap()),
            v_string(row.get_value(3).unwrap()),
        )
    }

    #[tokio::test]
    async fn los_resultados_del_lote_se_anotan_todos_y_un_CSV_ausente_no_borra_el_viejo() {
        let (db, _dir) = db_temporal().await;
        envios(&db, &["a", "b", "c"]).await;
        let repo = SqliteVerifactuRepository::new(db.clone());
        let r = |id: &str, estado: &'static str, cod: Option<i64>, csv: Option<&str>| ResultadoRegistro {
            id_registro: id.into(),
            estado,
            codigo_error: cod,
            descripcion_error: None,
            csv: csv.map(str::to_string),
        };
        repo.marcar_resultados(&[
            r("a", "ACEPTADO", None, None),
            r("b", "ACEPTADO", None, Some("CSV-NUEVO")),
            r("c", "RECHAZADO", Some(1150), None),
        ])
        .await
        .unwrap();

        assert_eq!(fila(&db, "a").await, ("ACEPTADO".into(), 1, None, Some("CSV-VIEJO".into())));
        assert_eq!(fila(&db, "b").await, ("ACEPTADO".into(), 1, None, Some("CSV-NUEVO".into())));
        assert_eq!(fila(&db, "c").await, ("RECHAZADO".into(), 1, Some("1150".into()), None));
    }

    #[tokio::test]
    async fn un_intento_cuenta_SOLO_en_los_registros_que_se_le_pasan_y_no_cambia_su_estado() {
        let (db, _dir) = db_temporal().await;
        envios(&db, &["a", "b", "c"]).await;
        SqliteVerifactuRepository::new(db.clone())
            .marcar_intento(&["a".to_string(), "c".to_string()])
            .await
            .unwrap();

        assert_eq!(fila(&db, "a").await.0, "PENDIENTE");
        assert_eq!(fila(&db, "a").await.1, 1);
        assert_eq!(fila(&db, "b").await.1, 0);
        assert_eq!(fila(&db, "c").await.1, 1);
    }
}

