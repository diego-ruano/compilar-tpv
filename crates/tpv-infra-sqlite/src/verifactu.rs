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
//! aparte (§10 de CLAUDE.md) por una razón de la propia norma: el art. 16.2 de la Orden impone un
//! **control de flujo** entre envíos, así que remitir no puede ser una llamada HTTP dentro del
//! cobro aunque se quisiera.

use std::sync::OnceLock;

use libsql::Value;

use tpv_application::error::{AppError, AppResult};
use tpv_contracts::errors::ErrorCode;
use tpv_contracts::verifactu::{BloqueFiscal, EstadoFiscal, RegistroFiscal};
use tpv_domain::ticket::{self, LineaTicket, TramoIva};
use tpv_domain::verifactu as vf;

use crate::db::{Reader, WriteGuard, Writer};
use crate::mapping::{opt_text, v_f64, v_i64, v_string};
use crate::util::{new_id, now_ms};

fn db_err(e: impl std::fmt::Display) -> AppError {
    AppError::repository(e.to_string())
}

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

static SISTEMA: OnceLock<SistemaInformatico> = OnceLock::new();

/// Lo llama el shell al arrancar. Idempotente: la segunda llamada se ignora.
pub fn set_sistema_informatico(s: SistemaInformatico) {
    let _ = SISTEMA.set(s);
}

/// El bloque configurado, o un defecto que **no oculta que falta**.
///
/// No devuelve `Result` a propósito: que el shell no haya inyectado el bloque es un error nuestro,
/// y hacer que impida cobrar sería convertir un bug en una caja parada. El registro sale con un
/// sistema informático incompleto —que la AEAT marcará— en vez de no salir.
fn sistema() -> SistemaInformatico {
    SISTEMA
        .get()
        .cloned()
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
/// Se llama al arrancar, después de inyectar el bloque. Es idempotente —la segunda vuelta no
/// encuentra nada— y best-effort: si la base está bloqueada para escrituras de negocio (una
/// recuperación en curso), no pasa nada y se reintenta en el arranque siguiente.
pub async fn reparar_sistema_informatico(db: &Db) -> AppResult<usize> {
    if !productor_configurado() {
        // Todavía no hay con qué reparar. No es un error: es el estado en el que nace el proyecto.
        return Ok(0);
    }

    let json = sistema().to_json();
    let g = db.write().await;

    let afectadas = g
        .execute(
            "UPDATE Registros_Facturacion SET Sistema_Json = ?1 \
             WHERE Sistema_Json LIKE '%\"NIF\":\"\"%' \
               AND NOT EXISTS ( \
                 SELECT 1 FROM _Verifactu_Envios e \
                 WHERE e.ID_Registro = Registros_Facturacion.ID_Registro \
                   AND e.Estado IN ('ACEPTADO', 'ACEPTADO_CON_ERRORES') \
               );",
            vec![Value::Text(json)],
        )
        .await
        .map_err(db_err)?;

    if afectadas > 0 {
        tracing::warn!(
            target: "tpv::verifactu",
            registros = afectadas,
            "{afectadas} registro(s) se emitieron sin identidad del productor y se han corregido: \
             ya se pueden remitir"
        );
    }
    Ok(afectadas as usize)
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
    pub limite_simplif: f64,
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

    let nif = v_string(row.get_value(0).map_err(db_err)?)
        .unwrap_or_default()
        .trim()
        .to_ascii_uppercase();
    let razon_social = v_string(row.get_value(1).map_err(db_err)?).unwrap_or_default();
    let descripcion_op = v_string(row.get_value(2).map_err(db_err)?).unwrap_or_default();
    let entorno = vf::Entorno::desde_texto(
        &v_string(row.get_value(3).map_err(db_err)?).unwrap_or_default(),
    );
    let iva_general = v_f64(row.get_value(4).map_err(db_err)?).unwrap_or(10.0);
    let limite_simplif = v_f64(row.get_value(5).map_err(db_err)?)
        .filter(|v| *v > 0.0)
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
        "SELECT COALESCE(MAX(Numero), 0) FROM Registros_Facturacion WHERE Serie = ?1;",
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

/// Un destinatario de factura completa (`F1`/`F3`). En `F2` y `R5` **no puede haberlo**: la AEAT
/// rechaza el registro con el error 1190.
#[derive(Debug, Clone)]
pub struct Destinatario {
    pub nombre_razon: String,
    pub nif: String,
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
    let tramos = ticket::desglose(&normalizar_lineas(&d.lineas, obligado.iva_general));
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

    let (num_serie_factura, numero) = match d.numero_reservado.clone() {
        Some(v) => v,
        None => reservar_numero(db, &serie).await?,
    };
    let fecha_expedicion = vf::fecha_registro_desde_iso(&crate::util::now_local_date())
        .ok_or_else(|| AppError::internal("El reloj del equipo no da una fecha utilizable"))?;
    // `chrono::Local` y no `datetime('now')`: el campo lleva HUSO y la BD no lo escribe. Es un
    // literal calculado en Rust, igual que los UUID, así que el outbox lo replica tal cual.
    let fecha_hora_huso = chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, false);

    // ── El eslabón anterior ──
    let anterior = ultimo_eslabon(db).await?;
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
          NIF_Emisor, Num_Serie_Factura, Fecha_Expedicion, Serie, Numero,
          Nombre_Razon_Emisor, Tipo_Factura, Tipo_Rectificativa, Descripcion_Operacion,
          Importe_Total, Cuota_Total, Desglose_Json, Destinatario_Json, Referencias_Json, Macrodato,
          Primer_Registro, Ant_NIF, Ant_Num_Serie, Ant_Fecha, Ant_Huella,
          Cadena_Huella, Huella, Tipo_Huella, Fecha_Hora_Huso,
          Sistema_Json, QR_Url, Incidencia, ID_Pago
        ) VALUES (
          ?1, ?2, 'ALTA',
          ?3, ?4, ?5, ?6, ?7,
          ?8, ?9, ?10, ?11,
          ?12, ?13, ?14, ?15, ?16, ?17,
          ?18, ?19, ?20, ?21, ?22,
          ?23, ?24, ?25, ?26,
          ?27, ?28, ?29, ?30
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
            opt_text(referencias_json(&d.rectificadas, &d.sustituidas)),
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
        ],
    )
    .await
    .map_err(db_err)?;

    encolar_envio(db, &id_registro).await?;

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
    let anterior = ultimo_eslabon(db).await?;
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
            "SELECT COALESCE(dc.Cantidad, 1) * COALESCE(dc.Precio_Unitario, 0),                     dc.IVA_Percent, COALESCE(dc.Exento, 0), dc.Causa_Exencion              FROM Pago_Detalles pd              JOIN Detalle_Comanda dc ON dc.ID_Detalle = pd.ID_Detalle              WHERE pd.ID_Pago = ?1;",
            vec![Value::Text(id_pago.to_string())],
        )
        .await
        .map_err(db_err)?;

    let mut out = Vec::new();
    while let Some(row) = rows.next().await.map_err(db_err)? {
        out.push(LineaTicket {
            total_con_iva: v_f64(row.get_value(0).map_err(db_err)?).unwrap_or(0.0),
            tipo_iva: v_f64(row.get_value(1).map_err(db_err)?).unwrap_or(iva_general),
            exento: v_i64(row.get_value(2).map_err(db_err)?).unwrap_or(0) == 1,
            causa_exencion: v_string(row.get_value(3).map_err(db_err)?),
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
/// ## El límite de la simplificada (§2.2 del plan)
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
    importe_pago: f64,
    destinatario: Option<vf::Destinatario>,
) -> AppResult<BloqueFiscal> {
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

    let mut lineas = lineas_de_pago(db, id_pago, obligado.iva_general).await?;

    let suma: f64 = lineas.iter().map(|l| l.total_con_iva).sum();
    if lineas.is_empty() || (suma - importe_pago).abs() > 0.005 {
        // Dos casos que van juntos porque el remedio es el mismo:
        //   * un cobro que no enlaza líneas (no debería pasar, pero no puede impedir facturar), y
        //   * un cobro PARCIAL de una línea, donde lo cobrado no es la suma de las líneas enteras.
        // En los dos, lo que se declara es el importe del cobro, que es el hecho fiscal: la
        // factura es el cobro. Se pierde el detalle por tipo, no el dinero — y si todas las líneas
        // van al mismo tipo (el caso de un bar), no se pierde ni eso.
        let tipo = lineas
            .first()
            .map(|l| l.tipo_iva)
            .unwrap_or(obligado.iva_general);
        let exento = !lineas.is_empty() && lineas.iter().all(|l| l.exento);
        let causa = lineas.first().and_then(|l| l.causa_exencion.clone());
        lineas = vec![LineaTicket {
            total_con_iva: importe_pago,
            tipo_iva: tipo,
            exento,
            causa_exencion: causa,
        }];
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
            }),
            numero_reservado: Some(numero_reservado),
            ..Default::default()
        },
    )
    .await
}

/// Emite el registro que corresponde cuando un cobro deja de contar (FISCAL-01, §7 del plan).
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
/// Si el pago no tiene registro fiscal (un cobro anterior a FISCAL-01, o emitido cuando faltaban los
/// datos fiscales) no hay nada que anular ni que rectificar, y no es un error: la baja del cobro
/// sigue adelante. Lo que no puede es fallar y dejar el cobro sin anular.
pub async fn emitir_baja_de_pago(
    db: &WriteGuard<'_>,
    id_pago: &str,
    clase: tpv_application::ports::cuentas::ClaseBaja,
) -> AppResult<()> {
    use tpv_application::ports::cuentas::ClaseBaja;

    // El registro de ALTA que hay que anular o rectificar. Se busca el último por `Orden` porque un
    // pago puede tener más de uno (una subsanación es otra fila con el mismo `IDFactura`), y el
    // vigente es el último.
    let mut rows = db
        .query(
            "SELECT ID_Registro, NIF_Emisor, Num_Serie_Factura, Fecha_Expedicion, \
                    Importe_Total, Cuota_Total, Desglose_Json \
             FROM Registros_Facturacion \
             WHERE ID_Pago = ?1 AND Tipo = 'ALTA' \
             ORDER BY Orden DESC LIMIT 1;",
            vec![Value::Text(id_pago.to_string())],
        )
        .await
        .map_err(db_err)?;
    let Some(row) = rows.next().await.map_err(db_err)? else {
        tracing::warn!(
            target: "tpv::verifactu",
            id_pago = %id_pago,
            "el cobro no tiene registro de facturación: no hay nada que anular ni rectificar"
        );
        return Ok(());
    };
    let id_alta = v_string(row.get_value(0).map_err(db_err)?).unwrap_or_default();
    let nif = v_string(row.get_value(1).map_err(db_err)?).unwrap_or_default();
    let num_serie = v_string(row.get_value(2).map_err(db_err)?).unwrap_or_default();
    let fecha = v_string(row.get_value(3).map_err(db_err)?).unwrap_or_default();
    let importe = v_string(row.get_value(4).map_err(db_err)?).unwrap_or_default();
    let cuota = v_string(row.get_value(5).map_err(db_err)?).unwrap_or_default();
    let desglose = v_string(row.get_value(6).map_err(db_err)?);

    match clase {
        ClaseBaja::Error => {
            emitir_anulacion(db, &id_alta).await?;
        }
        ClaseBaja::Devolucion => {
            // Los importes se NIEGAN sobre el texto guardado, no se recalculan desde un `f64`: es
            // el mismo número que se facturó, con el signo cambiado. Recalcularlo podría devolver
            // un céntimo distinto del que se cobró.
            let lineas = desglose_negado(desglose.as_deref());
            emitir_alta(
                db,
                DatosFactura {
                    tipo_factura: Some("R5".to_string()),
                    // `I` = rectificativa **por diferencias**: se declara sólo lo que cambia (el
                    // importe negativo), no la factura completa sustituida. Con `S` (sustitución)
                    // habría que informar `ImporteRectificacion`, que es otro camino y no el que
                    // marca la FAQ para una devolución sobre una simplificada.
                    tipo_rectificativa: Some("I".to_string()),
                    id_pago: Some(id_pago.to_string()),
                    lineas,
                    // Una `R5` **no puede llevar destinatario** (error 1190): rectifica una
                    // simplificada, que por definición no lo tiene.
                    destinatario: None,
                    rectificadas: vec![RefFactura {
                        nif,
                        num_serie,
                        fecha,
                    }],
                    sustituidas: vec![],
                    incidencia: false,
                    numero_reservado: None,
                },
            )
            .await?;
            let _ = (importe, cuota);
        }
    }
    Ok(())
}

/// Las líneas de la rectificativa: las del desglose original con el signo cambiado.
///
/// Se reconstruyen desde `Desglose_Json` para que el desglose de la `R5` sea el espejo exacto del de
/// la factura rectificada — mismos tipos, mismas causas de exención, mismas bases. Un desglose
/// inventado aquí podría no cuadrar con lo que se devolvió.
///
/// Si no hay desglose guardado (no debería pasar) se devuelve vacío y el registro sale con importe
/// cero. Es mejor que no salir: lo que no puede quedar es un cobro dado de baja sin su rectificativa.
fn desglose_negado(desglose_json: Option<&str>) -> Vec<LineaTicket> {
    tramos_del_desglose(desglose_json, -1.0)
}


/// Emite una **factura completa en sustitución** de una simplificada ya expedida (`F3`).
///
/// Es la respuesta al *«¿me lo puedes hacer con IVA?»* del día siguiente: el cliente vuelve con el
/// ticket y pide factura. **No se rectifica nada** (art. 15.6 ROF): canjear una simplificada por una
/// completa no es rectificar, se emite una `F3` que la **sustituye** y que sí lleva destinatario. La
/// simplificada original se queda exactamente como está — no se anula ni se modifica.
///
/// La `F3` gasta número nuevo de la misma serie y entra en la cadena como cualquier otro registro.
///
/// Se niega si el ticket ya tiene una `F3`: emitir dos facturas completas del mismo ticket sería
/// facturar dos veces la misma venta.
pub async fn emitir_sustitutiva(
    db: &WriteGuard<'_>,
    num_serie_original: &str,
    destinatario: vf::Destinatario,
) -> AppResult<BloqueFiscal> {
    let destinatario =
        vf::validar_destinatario(destinatario).map_err(|e| AppError::validation(e.mensaje()))?;

    // El registro de alta original, del que salen el desglose y la referencia.
    let mut rows = db
        .query(
            "SELECT ID_Registro, NIF_Emisor, Num_Serie_Factura, Fecha_Expedicion, Desglose_Json, \
                    ID_Pago, COALESCE(Tipo_Factura, '') \
             FROM Registros_Facturacion \
             WHERE Num_Serie_Factura = ?1 AND Tipo = 'ALTA' \
             ORDER BY Orden DESC LIMIT 1;",
            vec![Value::Text(num_serie_original.trim().to_string())],
        )
        .await
        .map_err(db_err)?;
    let Some(row) = rows.next().await.map_err(db_err)? else {
        return Err(AppError::not_found(
            "No existe ninguna factura con ese número.",
        ));
    };
    let nif = v_string(row.get_value(1).map_err(db_err)?).unwrap_or_default();
    let num_serie = v_string(row.get_value(2).map_err(db_err)?).unwrap_or_default();
    let fecha = v_string(row.get_value(3).map_err(db_err)?).unwrap_or_default();
    let desglose = v_string(row.get_value(4).map_err(db_err)?);
    let id_pago = v_string(row.get_value(5).map_err(db_err)?);
    let tipo_original = v_string(row.get_value(6).map_err(db_err)?).unwrap_or_default();

    if tipo_original != "F2" {
        // Sólo una simplificada se canjea. Una `F1` ya es una factura completa y una `R5` es una
        // rectificativa: en ninguno de los dos casos hay nada que sustituir.
        return Err(AppError::conflict(format!(
            "Esa factura es de tipo {tipo_original}: sólo un ticket (factura simplificada) se puede \
             canjear por una factura completa."
        )));
    }

    // ¿Ya se canjeó? `Referencias_Json` de la F3 lleva el número sustituido.
    let ya = select_i64(
        db,
        "SELECT COUNT(*) FROM Registros_Facturacion \
         WHERE Tipo_Factura = 'F3' AND Referencias_Json LIKE ?1;",
        vec![Value::Text(format!("%{num_serie}%"))],
    )
    .await?
    .unwrap_or(0);
    if ya > 0 {
        return Err(AppError::conflict(
            "De ese ticket ya se emitió una factura completa.",
        ));
    }

    // El desglose es el MISMO de la simplificada, con el mismo signo: la F3 no cambia el importe, lo
    // vuelve a declarar con destinatario. Reconstruirlo del original es lo que garantiza que las dos
    // facturas digan exactamente lo mismo del dinero.
    let lineas = desglose_mismo_signo(desglose.as_deref());

    emitir_alta(
        db,
        DatosFactura {
            tipo_factura: Some("F3".to_string()),
            id_pago,
            lineas,
            destinatario: Some(Destinatario {
                nombre_razon: destinatario.nombre_razon,
                nif: destinatario.nif,
            }),
            // `FacturasSustituidas` sólo puede ir en una F3 (error 1116). Y no es
            // `FacturasRectificadas`: no se rectifica nada.
            sustituidas: vec![RefFactura {
                nif,
                num_serie,
                fecha,
            }],
            ..Default::default()
        },
    )
    .await
}

/// Las líneas del desglose original, **con su signo**. Gemela de `desglose_negado`, que es la de la
/// rectificativa; aquí el importe no cambia de signo porque la `F3` no devuelve nada.
fn desglose_mismo_signo(desglose_json: Option<&str>) -> Vec<LineaTicket> {
    tramos_del_desglose(desglose_json, 1.0)
}

/// Lee `Desglose_Json` y devuelve sus tramos como líneas, multiplicando el importe por `signo`.
///
/// Existe porque la rectificativa y la sustitutiva necesitan lo mismo con el signo contrario, y dos
/// copias de este parseo se separarían en cuanto alguien añadiera un campo al desglose.
fn tramos_del_desglose(desglose_json: Option<&str>, signo: f64) -> Vec<LineaTicket> {
    let Some(arr) = desglose_json
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
        .and_then(|v| v.as_array().cloned())
    else {
        return Vec::new();
    };

    arr.iter()
        .filter_map(|t| {
            let base: f64 = t
                .get("BaseImponibleOimporteNoSujeto")
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse().ok())?;
            let cuota: f64 = t
                .get("CuotaRepercutida")
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse().ok())
                .unwrap_or(0.0);
            let exenta = t.get("OperacionExenta").and_then(|v| v.as_str());
            let tipo: f64 = t
                .get("TipoImpositivo")
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse().ok())
                .unwrap_or(0.0);
            Some(LineaTicket {
                // `LineaTicket` trabaja con el total CON IVA, que es base + cuota.
                total_con_iva: signo * (base + cuota),
                tipo_iva: tipo,
                exento: exenta.is_some(),
                causa_exencion: exenta.map(str::to_string),
            })
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
    reservar_numero(db, &serie_actual()).await
}

// ─────────────────────────────────────────────────────────────────────────────
// Piezas internas
// ─────────────────────────────────────────────────────────────────────────────

/// El último eslabón de la cadena: `MAX(Orden)`.
struct Eslabon {
    nif: String,
    num_serie: String,
    fecha: String,
    huella: String,
}

/// Se busca por `MAX(Orden)` y **no por `rowid`**: con `rowid` la cadena dependería del orden en
/// que una restauración reinserta las filas, que no está garantizado.
async fn ultimo_eslabon<C: Reader>(conn: &C) -> AppResult<Option<Eslabon>> {
    let mut rows = conn
        .query(
            "SELECT NIF_Emisor, Num_Serie_Factura, Fecha_Expedicion, Huella \
             FROM Registros_Facturacion ORDER BY Orden DESC LIMIT 1;",
            (),
        )
        .await
        .map_err(db_err)?;
    let Some(row) = rows.next().await.map_err(db_err)? else {
        return Ok(None);
    };
    Ok(Some(Eslabon {
        nif: v_string(row.get_value(0).map_err(db_err)?).unwrap_or_default(),
        num_serie: v_string(row.get_value(1).map_err(db_err)?).unwrap_or_default(),
        fecha: v_string(row.get_value(2).map_err(db_err)?).unwrap_or_default(),
        huella: v_string(row.get_value(3).map_err(db_err)?).unwrap_or_default(),
    }))
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
/// no se replica a propósito: tras una restauración la verdad no está en nuestra nube sino en la
/// AEAT, a la que se le puede preguntar.
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
/// `ClaveRegimen` es `"01"` (régimen general) y es **obligatorio** cuando el impuesto es IVA
/// (error 1245). `Impuesto` no se informa: vacío se considera `"01"` (IVA), que es el caso, y
/// Canarias/Ceuta/Melilla están fuera de alcance.
fn desglose_json(tramos: &[TramoIva]) -> String {
    let arr: Vec<serde_json::Value> = tramos
        .iter()
        .map(|t| match t {
            TramoIva::Sujeta { tipo, base, cuota } => serde_json::json!({
                "ClaveRegimen": "01",
                "CalificacionOperacion": "S1",
                "TipoImpositivo": vf::fmt_tipo(*tipo),
                "BaseImponibleOimporteNoSujeto": vf::fmt_importe(*base),
                "CuotaRepercutida": vf::fmt_importe(*cuota),
            }),
            // Una operación exenta NO lleva TipoImpositivo ni CuotaRepercutida: informarlos es el
            // error 1238. No van a cero — no van.
            TramoIva::Exenta { causa, base } => serde_json::json!({
                "ClaveRegimen": "01",
                "OperacionExenta": causa,
                "BaseImponibleOimporteNoSujeto": vf::fmt_importe(*base),
            }),
        })
        .collect();
    serde_json::Value::Array(arr).to_string()
}

fn destinatario_json(d: Option<&Destinatario>) -> Option<String> {
    d.map(|d| {
        serde_json::json!({
            "NombreRazon": vf::sanear_texto(&d.nombre_razon, 120),
            "NIF": d.nif.trim().to_ascii_uppercase(),
        })
        .to_string()
    })
}

fn referencias_json(rect: &[RefFactura], sust: &[RefFactura]) -> Option<String> {
    if rect.is_empty() && sust.is_empty() {
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
    Some(
        serde_json::json!({
            "rectificadas": mapear(rect),
            "sustituidas": mapear(sust),
        })
        .to_string(),
    )
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

/// El registro asociado a un cobro, para reimprimir.
///
/// Una reimpresión saca **el mismo número, el mismo QR y la misma huella**, marcada COPIA, y no
/// genera registro. Por eso se leen de la fila y no se recalculan: recalcular daría otra hora de
/// generación y, por tanto, otra huella.
pub async fn bloque_de_pago<C: Reader>(
    conn: &C,
    id_pago: &str,
) -> AppResult<Option<BloqueFiscal>> {
    let mut rows = conn
        .query(
            "SELECT r.Num_Serie_Factura, r.Fecha_Expedicion, r.QR_Url, r.Huella, r.Tipo_Factura, \
                    (SELECT Verifactu_Entorno FROM Business_Settings WHERE ID = 1) \
             FROM Registros_Facturacion r \
             WHERE r.ID_Pago = ?1 AND r.Tipo = 'ALTA' \
             ORDER BY r.Orden DESC LIMIT 1;",
            vec![Value::Text(id_pago.to_string())],
        )
        .await
        .map_err(db_err)?;
    let Some(row) = rows.next().await.map_err(db_err)? else {
        return Ok(None);
    };
    Ok(Some(BloqueFiscal {
        num_serie_factura: v_string(row.get_value(0).map_err(db_err)?).unwrap_or_default(),
        fecha_expedicion: v_string(row.get_value(1).map_err(db_err)?).unwrap_or_default(),
        qr_url: v_string(row.get_value(2).map_err(db_err)?).unwrap_or_default(),
        huella: v_string(row.get_value(3).map_err(db_err)?).unwrap_or_default(),
        tipo_factura: v_string(row.get_value(4).map_err(db_err)?).unwrap_or_default(),
        entorno_pruebas: vf::Entorno::desde_texto(
            &v_string(row.get_value(5).map_err(db_err)?).unwrap_or_default(),
        )
        .es_pruebas(),
    }))
}

/// Escalones de la escalera de avisos (§1.2.1 del plan), medidos sobre la **antigüedad del
/// registro pendiente más viejo** y no sobre el tiempo sin conexión: estar desconectado sin nada
/// que enviar no es un problema.
///
/// Es una función **pura** para poder probarla, y ninguno de sus escalones bloquea el cobro. La
/// obligación de remitir es del bar; nuestro trabajo es que no pueda decir que no lo sabía.
pub fn escalon_aviso(antiguedad_min: Option<i64>) -> &'static str {
    match antiguedad_min {
        None => "ninguno",
        Some(m) if m < 60 => "ninguno",           // < 1 h: funcionamiento normal, incluso con fibra
        Some(m) if m < 6 * 60 => "visible",       // indicador en la barra
        Some(m) if m < 24 * 60 => "notificacion", // notificación persistente al administrador
        Some(m) if m < 72 * 60 => "modal_login",  // modal al iniciar sesión, con reconocimiento
        Some(_) => "modal_cobro",                 // modal en cada cobro + telemetría
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

    let datos_fiscales_completos = nif
        .as_deref()
        .map(|n| vf::nif_valido(n))
        .unwrap_or(false)
        && razon_social.is_some();

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
        motivo_no_remite: if !datos_fiscales_completos {
            Some("sin_datos_fiscales".to_string())
        } else if !productor_configurado() {
            Some("sin_datos_del_productor".to_string())
        } else {
            None
        },
        dias_para_caducar_certificado: None,
    })
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
mod tests_identidad_del_productor {
    #![allow(non_snake_case)] // los nombres en mayúsculas señalan qué afirma cada test

    //! Qué pasa con los registros emitidos ANTES de que el productor del software tuviera NIF.
    //!
    //! El agujero es silencioso y definitivo: `Sistema_Json` se congela en la fila, así que un
    //! registro creado con `"NIF":""` lo lleva vacío para siempre, la AEAT lo rechaza por formato y
    //! rellenar la constante en una versión posterior no toca las filas ya escritas.
    //!
    //! ⚠️ Estos tests **dependen de `cargo nextest`**, que ya es lo que manda CLAUDE.md §6. El bloque
    //! del productor vive en un `OnceLock` (se inyecta una vez, al arrancar), así que un test que lo
    //! inyecta y otro que lo quiere vacío no pueden convivir en el mismo proceso. Con nextest cada
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
    fn el_desglose_json_no_informa_tipo_ni_cuota_en_una_exenta() {
        // Es el error 1238 de la AEAT: "Si la operacion es exenta no se puede informar ninguno de
        // los campos TipoImpositivo, CuotaRepercutida...". No van a cero: NO VAN.
        let json = desglose_json(&[TramoIva::Exenta {
            causa: "E1".into(),
            base: 10.0,
        }]);
        assert!(json.contains("\"OperacionExenta\":\"E1\""));
        assert!(!json.contains("TipoImpositivo"), "{json}");
        assert!(!json.contains("CuotaRepercutida"), "{json}");
        assert!(!json.contains("CalificacionOperacion"), "{json}");
    }

    #[test]
    fn el_desglose_json_de_una_sujeta_al_cero_por_ciento_si_los_informa() {
        // El otro lado de la moneda: un producto al 0 % es "sujeta y no exenta, gravada al 0 %", y
        // ahí el tipo y la cuota son OBLIGATORIOS (error 1208).
        let json = desglose_json(&[TramoIva::Sujeta {
            tipo: 0.0,
            base: 10.0,
            cuota: 0.0,
        }]);
        assert!(json.contains("\"CalificacionOperacion\":\"S1\""));
        assert!(json.contains("\"TipoImpositivo\":\"0\""));
        assert!(json.contains("\"CuotaRepercutida\":\"0.00\""));
        assert!(!json.contains("OperacionExenta"), "{json}");
    }

    #[test]
    fn el_desglose_json_siempre_lleva_clave_de_regimen() {
        // Error 1245: si Impuesto está vacío (que es como va: vacío se considera IVA), ClaveRegimen
        // es obligatorio.
        let json = desglose_json(&[
            TramoIva::Sujeta { tipo: 10.0, base: 10.0, cuota: 1.0 },
            TramoIva::Exenta { causa: "E1".into(), base: 5.0 },
        ]);
        assert_eq!(json.matches("\"ClaveRegimen\":\"01\"").count(), 2);
    }

    #[test]
    fn sin_referencias_no_se_escribe_el_bloque() {
        // Informar `FacturasRectificadas` en una factura que no es rectificativa es el error 1117.
        assert!(referencias_json(&[], &[]).is_none());
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
use tpv_application::ports::verifactu::VerifactuRepository;

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
    async fn bloque_por_numero(&self, num_serie_factura: &str) -> AppResult<Option<BloqueFiscal>> {
        let g = self.db.read().await;
        let mut rows = g
            .query(
                "SELECT r.Num_Serie_Factura, r.Fecha_Expedicion, r.QR_Url, r.Huella, \
                        COALESCE(r.Tipo_Factura, ''), \
                        (SELECT Verifactu_Entorno FROM Business_Settings WHERE ID = 1) \
                 FROM Registros_Facturacion r \
                 WHERE r.Num_Serie_Factura = ?1 AND r.Tipo = 'ALTA' \
                 ORDER BY r.Orden DESC LIMIT 1;",
                vec![Value::Text(num_serie_factura.to_string())],
            )
            .await
            .map_err(db_err)?;
        let Some(row) = rows.next().await.map_err(db_err)? else {
            return Ok(None);
        };
        Ok(Some(BloqueFiscal {
            num_serie_factura: v_string(row.get_value(0).map_err(db_err)?).unwrap_or_default(),
            fecha_expedicion: v_string(row.get_value(1).map_err(db_err)?).unwrap_or_default(),
            qr_url: v_string(row.get_value(2).map_err(db_err)?).unwrap_or_default(),
            huella: v_string(row.get_value(3).map_err(db_err)?).unwrap_or_default(),
            tipo_factura: v_string(row.get_value(4).map_err(db_err)?).unwrap_or_default(),
            entorno_pruebas: vf::Entorno::desde_texto(
                &v_string(row.get_value(5).map_err(db_err)?).unwrap_or_default(),
            )
            .es_pruebas(),
        }))
    }

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
                        r.Subsanacion, r.Rechazo_Previo, r.Sin_Registro_Previo \
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
            // La fila la crea `init_sync_tables`; si no está, el valor inicial de la norma es 60.
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

    async fn marcar_resultado(
        &self,
        id_registro: &str,
        estado: &str,
        codigo_error: Option<i64>,
        descripcion_error: Option<&str>,
        csv: Option<&str>,
    ) -> AppResult<()> {
        let g = self.db.write().await;
        g.raw()
            .execute(
                // El CSV se guarda con `COALESCE(?, CSV)`: la propia documentación avisa de que no
                // se puede recuperar con una consulta posterior, así que una respuesta que no lo
                // traiga no puede borrar el que ya teníamos.
                "UPDATE _Verifactu_Envios \
                 SET Estado = ?2, Intentos = Intentos + 1, Ultimo_Intento_Ms = ?3, \
                     Codigo_Error = ?4, Descripcion_Error = ?5, CSV = COALESCE(?6, CSV) \
                 WHERE ID_Registro = ?1;",
                vec![
                    Value::Text(id_registro.to_string()),
                    Value::Text(estado.to_string()),
                    Value::Integer(now_ms()),
                    codigo_error.map(|c| Value::Text(c.to_string())).unwrap_or(Value::Null),
                    opt_text(descripcion_error.map(|s| s.to_string())),
                    opt_text(csv.map(|s| s.to_string())),
                ],
            )
            .await
            .map_err(db_err)?;
        Ok(())
    }

    async fn marcar_intento(&self, ids: &[String]) -> AppResult<()> {
        if ids.is_empty() {
            return Ok(());
        }
        let g = self.db.write().await;
        for id in ids {
            // El estado NO se toca: siguen PENDIENTE. Un fallo de transporte no dice nada de si la
            // AEAT los tiene o no, y darlos por perdidos sería tan malo como darlos por buenos.
            g.raw()
                .execute(
                    "UPDATE _Verifactu_Envios \
                     SET Intentos = Intentos + 1, Ultimo_Intento_Ms = ?2 \
                     WHERE ID_Registro = ?1;",
                    vec![Value::Text(id.clone()), Value::Integer(now_ms())],
                )
                .await
                .map_err(db_err)?;
        }
        Ok(())
    }

    async fn emitir_sustitutiva(
        &self,
        num_serie_original: &str,
        destinatario: vf::Destinatario,
    ) -> AppResult<BloqueFiscal> {
        // En su propia transacción: la `F3` gasta número y entra en la cadena, así que o se escribe
        // entera o no se escribe.
        let g = self.db.write().await;
        g.execute_batch("BEGIN;").await.map_err(db_err)?;
        let res = emitir_sustitutiva(&g, num_serie_original, destinatario).await;
        match res {
            Ok(v) => {
                g.execute_batch("COMMIT;").await.map_err(db_err)?;
                Ok(v)
            }
            Err(e) => {
                let _ = g.execute_batch("ROLLBACK;").await;
                Err(e)
            }
        }
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
