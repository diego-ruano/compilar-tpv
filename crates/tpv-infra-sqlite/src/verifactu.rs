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
}

/// Lee y **valida** los datos fiscales del obligado.
///
/// Devuelve `DatosFiscalesIncompletos` si falta el NIF o la razón social, o si el NIF no supera su
/// dígito de control. Es la única puerta que Veri\*factu añade al camino de la venta, y tiene
/// código propio para que la UI lleve al formulario en vez de enseñar «no se puede cobrar».
pub(crate) async fn datos_obligado<C: Reader>(conn: &C) -> AppResult<DatosObligado> {
    let mut rows = conn
        .query(
            "SELECT CIF, Razon_Social, Descripcion_Op, Verifactu_Entorno, IVA_Percent \
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
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// La serie y el número
// ─────────────────────────────────────────────────────────────────────────────

/// Serie del ejercicio en curso (`"2027"`). El contador se reinicia cada año.
fn serie_actual() -> String {
    chrono::Local::now().format("%Y").to_string()
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
    let serie = serie_actual();
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

/// Emite el registro de un cobro corriente: una **factura simplificada (`F2`)**.
///
/// Es el camino de la inmensa mayoría de las ventas de un bar, y lo llaman los tres sitios que
/// cobran (`mesas` por detalles, `mesas` por productos sueltos y `venta_rapida`). Está aquí y no
/// copiado tres veces porque las tres tienen que hacer exactamente lo mismo.
///
/// **Importante**: se llama DESPUÉS de insertar `Pago_Detalles`, porque el desglose sale de ahí.
///
/// Si el pago no tiene ninguna línea enlazada (un cobro que no cubre nada), se emite igualmente con
/// el importe del pago como único tramo al tipo general: una factura sin desglose no es válida, y
/// dejar de emitir no es una opción — sería expedir una factura huérfana.
pub async fn emitir_cobro_simplificado(
    db: &WriteGuard<'_>,
    id_pago: &str,
    numero_reservado: (String, i64),
    importe_pago: f64,
) -> AppResult<BloqueFiscal> {
    let obligado = datos_obligado(db).await?;
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
            tipo_factura: Some("F2".to_string()),
            id_pago: Some(id_pago.to_string()),
            lineas,
            numero_reservado: Some(numero_reservado),
            ..Default::default()
        },
    )
    .await
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
        motivo_no_remite: if datos_fiscales_completos {
            None
        } else {
            Some("sin_datos_fiscales".to_string())
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
}
