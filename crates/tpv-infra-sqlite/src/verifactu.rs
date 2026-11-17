//! Persistencia del **registro de facturación** (FISCAL-01) y de su serie.
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
//! No habla con la AEAT ni construye XML: esta rama no remite (`docs/arquitectura/verifactu.md`).
//! El registro se guarda completo —huella, QR y sistema informático— para que el envío se pueda
//! volver a poner sin tocar lo ya emitido.

use crate::util::new_id;
use crate::consultas::{db_err};
use tpv_domain::dinero::Dinero;
use std::sync::RwLock;

use crate::ejecutor::Value;

use tpv_application::error::{AppError, AppResult};
use tpv_contracts::errors::ErrorCode;
use tpv_contracts::verifactu::{BloqueFiscal, EstadoFiscal};
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

/// Lo llama el shell al arrancar. Sustituye el bloque entero.
pub fn set_sistema_informatico(s: SistemaInformatico) {
    *SISTEMA.write().unwrap_or_else(|e| e.into_inner()) = Some(s);
}

/// RI-56: fija el número de instalación sin tocar el resto del bloque. Lo llama la activación de la
/// licencia, que es cuando se conoce el `tenant_id`. Sin bloque inyectado no hace nada: eso sólo
/// pasa en los tests y en los ejemplos, que inyectan el suyo.
pub fn set_numero_instalacion(numero: &str) {
    let mut g = SISTEMA.write().unwrap_or_else(|e| e.into_inner());
    if let Some(s) = g.as_mut() {
        if s.numero_instalacion != numero {
            s.numero_instalacion = numero.to_string();
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

/// Qué dato del obligado falta para emitir, dicho tal cual (POS-13): sólo el que falta.
fn lo_que_falta_del_obligado(nif: &str, razon_social: &str) -> Option<&'static str> {
    match (nif.trim().is_empty(), razon_social.trim().is_empty()) {
        (true, true) => Some(
            "Faltan el NIF y la razón social del negocio: sin ellos no se puede emitir la factura.",
        ),
        (true, false) => {
            Some("Falta el NIF del negocio: sin él no se puede emitir la factura.")
        }
        (false, true) => Some(
            "Falta la razón social del negocio: sin ella no se puede emitir la factura.",
        ),
        (false, false) => None,
    }
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

    if let Some(mensaje) = lo_que_falta_del_obligado(&nif, &razon_social) {
        return Err(AppError::coded(ErrorCode::DatosFiscalesIncompletos, mensaje));
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

/// Emite un registro de **alta**.
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

    // Un número reservado tiene que venir YA en la serie que le toca, y se comprueba aquí porque
    // `Pagos.Numero_Ticket` guarda ese mismo valor: si los dos dejaran de coincidir, el ticket
    // llevaría un número que no corresponde a ningún registro y saldría sin desglose, sin que nada
    // protestara. Se para en vez de escribirlo.
    let numero_reservado = d.numero_reservado.clone();
    if let Some((num, _)) = &numero_reservado {
        if !num.starts_with(&format!("{serie}/")) {
            return Err(AppError::internal(format!(
                "el número reservado ({num}) no es de la serie que corresponde a esta factura ({serie})"
            )));
        }
    }

    let (num_serie_factura, numero) = match numero_reservado {
        Some(v) => v,
        None => reservar_numero(db, &serie).await?,
    };
    let fecha_expedicion = vf::fecha_registro_desde_iso(&crate::util::now_local_date())
        .ok_or_else(|| AppError::internal("El reloj del equipo no da una fecha utilizable"))?;

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
          NIF_Emisor, Num_Serie_Factura, Fecha_Expedicion, Fecha_Operacion, Serie, Numero,
          Nombre_Razon_Emisor, Tipo_Factura, Tipo_Rectificativa, Descripcion_Operacion,
          Importe_Total, Cuota_Total, Desglose_Json, Destinatario_Json, Referencias_Json, Macrodato,
          Primer_Registro, Ant_NIF, Ant_Num_Serie, Ant_Fecha, Ant_Huella,
          Cadena_Huella, Huella, Tipo_Huella, Fecha_Hora_Huso,
          Sistema_Json, QR_Url, Incidencia, ID_Pago
        ) VALUES (
          ?1, ?2, 'ALTA',
          ?3, ?4, ?5, ?31, ?6, ?7,
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
            opt_text(referencias_json(&d.rectificadas, &d.sustituidas, d.importe_rectificacion)),
            opt_text(vf::macrodato(importe_total).map(|s| s.to_string())),
            opt_text(primer_registro.map(|s| s.to_string())),
            opt_text(anterior.as_ref().map(|a| a.nif.clone())),
            opt_text(anterior.as_ref().map(|a| a.num_serie.clone())),
            opt_text(anterior.as_ref().map(|a| a.fecha.clone())),
            opt_text(anterior.as_ref().map(|a| a.huella.clone())),
            Value::Text(cadena),
            Value::Text(huella),
            Value::Text(vf::TIPO_HUELLA_SHA256.to_string()),
            Value::Text(fecha_hora_huso),
            Value::Text(sis.to_json()),
            Value::Text(qr_url),
            Value::Text(if d.incidencia { "S" } else { "N" }.to_string()),
            opt_text(d.id_pago.clone()),
            // ?31 — va al final de la lista aunque su columna esté al principio: renumerar los
            // treinta anteriores para colocarlo "en su sitio" es exactamente el cambio que desplaza
            // un parámetro sin que nada lo note.
            opt_text(fecha_operacion.clone()),
        ],
    )
    .await
    .map_err(db_err)?;

    Ok(BloqueFiscal {
        num_serie_factura,
        fecha_expedicion,
        tipo_factura,
    })
}

/// Emite un registro de **anulación** de una factura ya emitida (art. 11.1 RRSIF).
///
/// Anular **no borra nada**: tanto el registro erróneo como el de anulación se conservan. Y es
/// para cuando la factura *no responde a una operación real* —una venta de
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
            Value::Text(huella),
            Value::Text(vf::TIPO_HUELLA_SHA256.to_string()),
            Value::Text(fecha_hora_huso),
            Value::Text(sis.to_json()),
            Value::Text(qr_url),
            opt_text(id_pago),
        ],
    )
    .await
    .map_err(db_err)?;

    Ok(BloqueFiscal {
        num_serie_factura: num_anulada,
        fecha_expedicion: fecha_anulada,
        tipo_factura: String::new(),
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
        // sin decir nada (`docs/PRUEBAS_AEAT.md` en `con-verifactu`). El único control es esta aritmética.
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
///   no borra nada: el registro erróneo y el de anulación se conservan los dos. La FAQ
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
/// Si el pago no tiene registro fiscal (un cobro anterior a la numeración) no hay nada que anular ni
/// que rectificar, y no es un error: la baja del cobro sigue adelante. Lo que no puede es fallar y dejar
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
/// una línea. Devuelve su número, o `None` si el cobro no tiene factura.
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

/// Los números de ticket de unos cobros, en el mismo orden. Un cobro sin número (anterior a la
/// numeración) no tiene factura que canjear.
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
        if num.trim().is_empty() {
            return Err(AppError::conflict(
                "Uno de los cobros no tiene factura: es de antes de completar los datos fiscales.",
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

/// Reserva el número de la serie del ejercicio en curso. Lo llama el camino del cobro antes del
/// `INSERT INTO Pagos`, para que `Numero_Ticket` y `Num_Serie_Factura` sean el mismo número.
pub async fn reservar_numero_factura(db: &WriteGuard<'_>) -> AppResult<(String, i64)> {
    reservar_numero(db, &serie_actual()).await
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

/// El último eslabón de la cadena, del que cuelga la huella del registro siguiente.
///
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
    let Some(fila) = rows.next().await.map_err(db_err)? else {
        return Ok(None);
    };
    let t = |i: i32| -> AppResult<String> {
        Ok(v_string(fila.get_value(i).map_err(db_err)?).unwrap_or_default())
    };
    Ok(Some(Eslabon {
        nif: t(0)?,
        num_serie: t(1)?,
        fecha: t(2)?,
        huella: t(3)?,
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

/// El desglose como JSON, con los nombres del `DetalleDesglose` de la AEAT.
///
/// Los importes van ya **formateados como texto**, que es lo mismo que se hasheó: nadie los
/// recompone desde un `f64`.
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
// Lecturas
// ─────────────────────────────────────────────────────────────────────────────

/// ¿Puede facturar el negocio? Sin NIF válido o sin razón social no se puede cobrar.
pub async fn estado_fiscal<C: Reader>(conn: &C) -> AppResult<EstadoFiscal> {
    let mut nif = None;
    let mut razon_social = None;
    if let Some(row) = conn
        .query(
            "SELECT CIF, Razon_Social FROM Business_Settings WHERE ID = 1 LIMIT 1;",
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
    }
    let datos_fiscales_completos =
        nif.as_deref().map(vf::nif_valido).unwrap_or(false) && razon_social.is_some();
    Ok(EstadoFiscal {
        datos_fiscales_completos,
        nif,
        razon_social,
    })
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
mod tests {
    use super::*;

    /// Euros -> `Dinero`. Los supuestos se escriben en euros; lo que
    /// se compara son centimos.
    #[allow(dead_code)]
    fn eur(euros: f64) -> Dinero {
        Dinero::de_euros(euros)
    }

    #[test]
    fn el_aviso_del_obligado_dice_solo_lo_que_falta() {
        // POS-13: con el NIF puesto, el aviso no puede pedir el NIF.
        let falta = |nif, razon| lo_que_falta_del_obligado(nif, razon).unwrap_or("");
        assert!(falta("B12345674", " ").starts_with("Falta la razón social"));
        assert!(falta("", "Bar Pepe SL").starts_with("Falta el NIF"));
        assert!(falta("", "").starts_with("Faltan el NIF y la razón social"));
        assert_eq!(lo_que_falta_del_obligado("B12345674", "Bar Pepe SL"), None);
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
    fn el_importe_rectificado_se_guarda_como_texto_fiscal() {
        let r = RefFactura { nif: "B12345674".into(), num_serie: "2027/000001".into(), fecha: "01-01-2027".into() };
        let json = referencias_json(&[r], &[], Some((eur(2.73), eur(0.27)))).unwrap();
        assert!(json.contains("\"BaseRectificada\":\"2.73\""), "{json}");
        assert!(json.contains("\"CuotaRectificada\":\"0.27\""), "{json}");
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

    #[test]
    fn ri_56_los_registros_nuevos_llevan_el_numero_tras_activar() {
        set_sistema_informatico(SistemaInformatico {
            nombre_razon: String::new(),
            nif: String::new(),
            nombre_sistema: "TPV".into(),
            id_sistema: "01".into(),
            version: "1.0.0".into(),
            numero_instalacion: String::new(),
        });
        set_numero_instalacion("tenant-abc");
        assert_eq!(sistema().numero_instalacion, "tenant-abc");
        assert_eq!(sistema().version, "1.0.0", "el resto del bloque no se toca");
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Adaptador del puerto
// ─────────────────────────────────────────────────────────────────────────────

use std::sync::Arc;

use async_trait::async_trait;
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
    async fn estado(&self) -> AppResult<EstadoFiscal> {
        let g = self.db.read().await;
        estado_fiscal(&g).await
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

