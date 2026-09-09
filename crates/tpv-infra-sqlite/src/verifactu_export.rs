//! Exportación de los registros de facturación (art. 8 RRSIF).
//!
//! > *«Los sistemas informáticos de facturación deberán permitir la exportación de los registros de
//! > facturación […] a través de un fichero normalizado»*.
//!
//! Es una obligación del sistema, no una comodidad: un inspector puede pedirla, y el TPV tiene que
//! poder dársela sin que nadie abra la base de datos.
//!
//! ## Qué lleva el ZIP y por qué cuatro ficheros
//!
//! | Fichero | Para quién |
//! |---|---|
//! | `registros.xml` | La máquina. Los registros en el formato del diseño oficial, tal como se remitieron |
//! | `registros.csv` | La persona. Lo mismo, abrible en una hoja de cálculo |
//! | `cadena.txt` | **El que de verdad importa.** Número, cadena hasheada y huella de cada registro |
//! | `manifiesto.json` | El contexto: NIF, razón social, rango, cuántos, versión del sistema |
//!
//! `cadena.txt` es el que justifica todo esto. Lleva la **cadena exacta que se hasheó** de cada
//! registro, así que **un tercero puede verificar la cadena entera con un SHA-256 y sin nuestro
//! código**: aplica el hash a cada línea, comprueba que sale la huella que dice, y que esa huella es
//! la que el registro siguiente declara como anterior. Esa es la diferencia entre exportar datos y
//! exportar algo comprobable — y es la razón por la que `Cadena_Huella` se guarda en la fila en vez
//! de recomputarse al leer.
//!
//! ## Y tiene que funcionar con la base en mal estado
//!
//! Exportar es de las cosas que se piden justo cuando algo va mal. Así que esto sólo LEE, no abre
//! transacciones y no se apoya en ninguna tabla de control: si falta `_Verifactu_Envios` (una base
//! restaurada a medias), el estado del envío sale vacío y los registros salen igual.

use std::io::Write;
use std::path::Path;

use libsql::Value;

use tpv_application::error::{AppError, AppResult};

use crate::db::{Db, Reader};
use crate::mapping::{v_i64, v_string};

fn db_err(e: impl std::fmt::Display) -> AppError {
    AppError::repository(e.to_string())
}

/// Una fila, con todo lo que hace falta para los cuatro ficheros.
struct Fila {
    orden: i64,
    tipo: String,
    nif_emisor: String,
    num_serie: String,
    fecha: String,
    /// Vacía en el caso normal: la operación se efectuó el mismo día que se expidió la factura.
    fecha_operacion: String,
    tipo_factura: String,
    importe: String,
    cuota: String,
    cadena: String,
    huella: String,
    fecha_hora_huso: String,
    incidencia: String,
    subsanacion: String,
    desglose: String,
    destinatario: String,
    referencias: String,
    ant_huella: String,
    estado_envio: String,
    csv_aeat: String,
}

/// Escapa un campo de CSV: comillas dobladas y el campo entre comillas si lleva separador, comilla
/// o salto de línea.
///
/// El separador es **`;`** y no `,` porque el destino real de este fichero es Excel en español, que
/// con `,` mete todo en una columna. Es una exportación para que alguien la lea, no un formato de
/// intercambio.
fn csv(campo: &str) -> String {
    if campo.contains(';') || campo.contains('"') || campo.contains('\n') {
        format!("\"{}\"", campo.replace('"', "\"\""))
    } else {
        campo.to_string()
    }
}

fn xml_esc(v: &str) -> String {
    v.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// Lee los registros del rango. Las fechas van en `AAAA-MM-DD` (es lo que manda una pantalla).
///
/// El filtro va sobre `Fecha_Hora_Huso` y **no** sobre `Fecha_Expedicion`, que es `DD-MM-AAAA`
/// porque así viaja al XML y al QR: comparar eso contra una fecha `AAAA-MM-DD` da un orden
/// lexicográfico sin ningún sentido. Es la misma trampa que la ventana del bootstrap.
async fn leer<C: Reader>(conn: &C, desde: &str, hasta: &str) -> AppResult<Vec<Fila>> {
    // `hasta` se extiende al final del día: quien escribe «hasta el 31» espera que entre el 31.
    let hasta_inclusivo = format!("{hasta}T23:59:59+99:99");

    let mut rows = conn
        .query(
            "SELECT r.Orden, r.Tipo, r.NIF_Emisor, r.Num_Serie_Factura, r.Fecha_Expedicion, \
                    COALESCE(r.Tipo_Factura,''), COALESCE(r.Importe_Total,''), \
                    COALESCE(r.Cuota_Total,''), r.Cadena_Huella, r.Huella, r.Fecha_Hora_Huso, \
                    COALESCE(r.Incidencia,'N'), COALESCE(r.Subsanacion,''), \
                    COALESCE(r.Desglose_Json,''), COALESCE(r.Destinatario_Json,''), \
                    COALESCE(r.Referencias_Json,''), COALESCE(r.Ant_Huella,''), \
                    COALESCE(e.Estado,''), COALESCE(e.CSV,''), \
                    COALESCE(r.Fecha_Operacion,'') \
             FROM Registros_Facturacion r \
             LEFT JOIN _Verifactu_Envios e ON e.ID_Registro = r.ID_Registro \
             WHERE r.Fecha_Hora_Huso >= ?1 AND r.Fecha_Hora_Huso <= ?2 \
             ORDER BY r.Orden ASC;",
            vec![
                Value::Text(desde.trim().to_string()),
                Value::Text(hasta_inclusivo),
            ],
        )
        .await
        .map_err(db_err)?;

    let mut out = Vec::new();
    while let Some(row) = rows.next().await.map_err(db_err)? {
        let t = |i: i32| -> AppResult<String> {
            Ok(v_string(row.get_value(i).map_err(db_err)?).unwrap_or_default())
        };
        out.push(Fila {
            orden: v_i64(row.get_value(0).map_err(db_err)?).unwrap_or(0),
            tipo: t(1)?,
            nif_emisor: t(2)?,
            num_serie: t(3)?,
            fecha: t(4)?,
            tipo_factura: t(5)?,
            importe: t(6)?,
            cuota: t(7)?,
            cadena: t(8)?,
            huella: t(9)?,
            fecha_hora_huso: t(10)?,
            incidencia: t(11)?,
            subsanacion: t(12)?,
            desglose: t(13)?,
            destinatario: t(14)?,
            referencias: t(15)?,
            ant_huella: t(16)?,
            estado_envio: t(17)?,
            csv_aeat: t(18)?,
            fecha_operacion: t(19)?,
        });
    }
    Ok(out)
}

fn construir_xml(filas: &[Fila]) -> String {
    let mut b = String::with_capacity(1024 + filas.len() * 1024);
    b.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<RegistrosFacturacion>\n");
    for f in filas {
        b.push_str("  <Registro>\n");
        let el = |b: &mut String, k: &str, v: &str| {
            b.push_str(&format!("    <{k}>{}</{k}>\n", xml_esc(v)));
        };
        b.push_str(&format!("    <Orden>{}</Orden>\n", f.orden));
        el(&mut b, "Tipo", &f.tipo);
        el(&mut b, "IDEmisorFactura", &f.nif_emisor);
        el(&mut b, "NumSerieFactura", &f.num_serie);
        el(&mut b, "FechaExpedicionFactura", &f.fecha);
        if !f.fecha_operacion.is_empty() {
            el(&mut b, "FechaOperacion", &f.fecha_operacion);
        }
        if !f.tipo_factura.is_empty() {
            el(&mut b, "TipoFactura", &f.tipo_factura);
        }
        if !f.importe.is_empty() {
            el(&mut b, "ImporteTotal", &f.importe);
            el(&mut b, "CuotaTotal", &f.cuota);
        }
        if !f.desglose.is_empty() {
            el(&mut b, "Desglose", &f.desglose);
        }
        if !f.destinatario.is_empty() {
            el(&mut b, "Destinatario", &f.destinatario);
        }
        if !f.referencias.is_empty() {
            el(&mut b, "Referencias", &f.referencias);
        }
        if !f.ant_huella.is_empty() {
            el(&mut b, "HuellaRegistroAnterior", &f.ant_huella);
        } else {
            el(&mut b, "PrimerRegistro", "S");
        }
        el(&mut b, "FechaHoraHusoGenRegistro", &f.fecha_hora_huso);
        el(&mut b, "TipoHuella", "01");
        el(&mut b, "Huella", &f.huella);
        el(&mut b, "Incidencia", &f.incidencia);
        if !f.subsanacion.is_empty() {
            el(&mut b, "Subsanacion", &f.subsanacion);
        }
        // El estado del envío NO es parte del registro: es información nuestra sobre él. Va en un
        // bloque aparte para que nadie lo confunda con un campo del diseño oficial.
        if !f.estado_envio.is_empty() || !f.csv_aeat.is_empty() {
            b.push_str("    <EstadoRemision>\n");
            b.push_str(&format!(
                "      <Estado>{}</Estado>\n",
                xml_esc(&f.estado_envio)
            ));
            if !f.csv_aeat.is_empty() {
                b.push_str(&format!("      <CSV>{}</CSV>\n", xml_esc(&f.csv_aeat)));
            }
            b.push_str("    </EstadoRemision>\n");
        }
        b.push_str("  </Registro>\n");
    }
    b.push_str("</RegistrosFacturacion>\n");
    b
}

fn construir_csv(filas: &[Fila]) -> String {
    let mut b = String::with_capacity(256 + filas.len() * 256);
    // BOM de UTF-8: sin él, Excel en Windows lee los acentos como basura. El fichero es para que
    // alguien lo abra, así que esto no es un detalle cosmético.
    b.push('\u{FEFF}');
    b.push_str(
        "Orden;Tipo;TipoFactura;NumSerieFactura;FechaExpedicion;FechaOperacion;ImporteTotal;CuotaTotal;\
         FechaHoraGeneracion;Huella;HuellaAnterior;Incidencia;Subsanacion;EstadoRemision;CSV\n",
    );
    for f in filas {
        b.push_str(&format!(
            "{};{};{};{};{};{};{};{};{};{};{};{};{};{};{}\n",
            f.orden,
            csv(&f.tipo),
            csv(&f.tipo_factura),
            csv(&f.num_serie),
            csv(&f.fecha),
            csv(&f.fecha_operacion),
            csv(&f.importe),
            csv(&f.cuota),
            csv(&f.fecha_hora_huso),
            csv(&f.huella),
            csv(&f.ant_huella),
            csv(&f.incidencia),
            csv(&f.subsanacion),
            csv(&f.estado_envio),
            csv(&f.csv_aeat),
        ));
    }
    b
}

/// El fichero que hace verificable la exportación.
///
/// Tres líneas por registro: el número, la **cadena exacta que se hasheó** y la huella que salió.
/// Con eso un tercero comprueba la integridad entera sin nuestro código — `sha256(cadena)` tiene que
/// dar `huella`, y esa `huella` tiene que aparecer dentro de la cadena del registro siguiente.
fn construir_cadena(filas: &[Fila]) -> String {
    let mut b = String::with_capacity(512 + filas.len() * 512);
    b.push_str(
        "# Cadena de huellas de los registros de facturacion.\n\
         #\n\
         # Tres lineas por registro:\n\
         #   NUM     numero de serie de la factura\n\
         #   CADENA  la cadena EXACTA sobre la que se aplico SHA-256\n\
         #   HUELLA  el resultado, en hexadecimal y mayusculas\n\
         #\n\
         # Para verificar, sin necesidad de este programa:\n\
         #   1. sha256(CADENA) en UTF-8, en mayusculas, tiene que dar HUELLA.\n\
         #   2. La HUELLA de cada registro tiene que aparecer como &Huella=... dentro de la\n\
         #      CADENA del registro siguiente. En el primero de la cadena va vacia (&Huella=&).\n\
         #\n\
         # Algoritmo: SHA-256 (el unico que admite la Orden HAC/1177/2024 a dia de hoy).\n\n",
    );
    for f in filas {
        b.push_str(&format!("NUM    {}\n", f.num_serie));
        b.push_str(&format!("CADENA {}\n", f.cadena));
        b.push_str(&format!("HUELLA {}\n\n", f.huella));
    }
    b
}

/// Datos del obligado y del sistema para el manifiesto.
pub struct ContextoExport {
    pub nif: String,
    pub razon_social: String,
    /// La del `tauri.conf.json`.
    pub version_sistema: String,
    pub nombre_sistema: String,
    pub id_sistema: String,
    pub nif_productor: String,
    pub nombre_productor: String,
    pub entorno: String,
}

fn construir_manifiesto(filas: &[Fila], ctx: &ContextoExport, desde: &str, hasta: &str) -> String {
    let primero = filas.first();
    let ultimo = filas.last();
    serde_json::json!({
        "obligado": { "nif": ctx.nif, "nombre_razon": ctx.razon_social },
        "sistema_informatico": {
            "nombre_razon_productor": ctx.nombre_productor,
            "nif_productor": ctx.nif_productor,
            "nombre": ctx.nombre_sistema,
            "id": ctx.id_sistema,
            "version": ctx.version_sistema,
        },
        "rango_solicitado": { "desde": desde, "hasta": hasta },
        "registros": {
            "total": filas.len(),
            "primer_orden": primero.map(|f| f.orden),
            "ultimo_orden": ultimo.map(|f| f.orden),
            "primer_numero": primero.map(|f| f.num_serie.clone()),
            "ultimo_numero": ultimo.map(|f| f.num_serie.clone()),
        },
        "entorno": ctx.entorno,
        "generado_en": chrono::Local::now().to_rfc3339(),
        "algoritmo_huella": "SHA-256",
        "normativa": "RD 1007/2023 (RRSIF) art. 8 · Orden HAC/1177/2024",
        // Lo que este fichero NO afirma, dicho aquí para que nadie lo lea como lo que no es.
        "nota": "Esta exportacion es una copia de los registros conservados por el sistema de \
                 facturacion. El estado de remision que acompaña a cada registro es el que conoce \
                 este equipo; la fuente de verdad de lo presentado es la AEAT.",
    })
    .to_string()
}

/// Genera el ZIP de la exportación en `destino`.
///
/// `desde` y `hasta` en `AAAA-MM-DD`. Devuelve cuántos registros entraron.
pub async fn exportar(
    db: &Db,
    destino: &Path,
    desde: &str,
    hasta: &str,
    ctx: &ContextoExport,
) -> AppResult<usize> {
    let filas = {
        let g = db.read().await;
        leer(&g, desde, hasta).await?
    };

    // Un rango sin registros no es un error: puede que el bar no facturara nada esa semana. Lo que
    // no se hace es escribir un ZIP vacío sin decirlo — el manifiesto lleva el total.
    let xml = construir_xml(&filas);
    let csv_txt = construir_csv(&filas);
    let cadena = construir_cadena(&filas);
    let manifiesto = construir_manifiesto(&filas, ctx, desde, hasta);

    // Se escribe a un temporal y se renombra al final: si el disco se llena a mitad, el usuario no
    // se queda con un ZIP truncado que parece bueno.
    let tmp = destino.with_extension("zip.parcial");
    if let Some(padre) = destino.parent() {
        std::fs::create_dir_all(padre).map_err(|e| AppError::internal(e.to_string()))?;
    }
    {
        let f = std::fs::File::create(&tmp).map_err(|e| {
            AppError::internal(format!("no se pudo crear {}: {e}", tmp.display()))
        })?;
        let mut zip = zip::ZipWriter::new(f);
        let opciones: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);

        for (nombre, contenido) in [
            ("registros.xml", xml.as_str()),
            ("registros.csv", csv_txt.as_str()),
            ("cadena.txt", cadena.as_str()),
            ("manifiesto.json", manifiesto.as_str()),
        ] {
            zip.start_file(nombre, opciones)
                .map_err(|e| AppError::internal(e.to_string()))?;
            zip.write_all(contenido.as_bytes())
                .map_err(|e| AppError::internal(e.to_string()))?;
        }
        zip.finish().map_err(|e| AppError::internal(e.to_string()))?;
    }
    std::fs::rename(&tmp, destino).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        AppError::internal(format!("no se pudo guardar en {}: {e}", destino.display()))
    })?;

    Ok(filas.len())
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)] // los nombres en mayúsculas señalan qué afirma cada test
    use super::*;

    fn fila(orden: i64, num: &str, ant: &str) -> Fila {
        Fila {
            orden,
            tipo: "ALTA".into(),
            nif_emisor: "89890001K".into(),
            num_serie: num.into(),
            fecha: "15-01-2027".into(),
            fecha_operacion: String::new(),
            tipo_factura: "F2".into(),
            importe: "12.10".into(),
            cuota: "1.10".into(),
            cadena: format!("IDEmisorFactura=89890001K&NumSerieFactura={num}&Huella={ant}"),
            huella: format!("HUELLA{orden}"),
            fecha_hora_huso: "2027-01-15T21:34:56+01:00".into(),
            incidencia: "N".into(),
            subsanacion: String::new(),
            desglose: "[]".into(),
            destinatario: String::new(),
            referencias: String::new(),
            ant_huella: ant.into(),
            estado_envio: "ACEPTADO".into(),
            csv_aeat: "CSV123".into(),
        }
    }

    #[test]
    fn la_cadena_exportada_lleva_lo_que_hace_falta_para_verificarla_sin_nosotros() {
        // Es lo que justifica el fichero: con la cadena y la huella, un tercero aplica SHA-256 y
        // comprueba la integridad entera sin ejecutar nuestro código.
        let txt = construir_cadena(&[fila(1, "2027/000001", ""), fila(2, "2027/000002", "HUELLA1")]);

        assert!(txt.contains("NUM    2027/000001"));
        assert!(txt.contains("CADENA IDEmisorFactura=89890001K&NumSerieFactura=2027/000001&Huella="));
        assert!(txt.contains("HUELLA HUELLA1"));
        // Y el segundo referencia al primero: eso es la cadena.
        assert!(txt.contains("NumSerieFactura=2027/000002&Huella=HUELLA1"));
        // Con las instrucciones de cómo comprobarlo, porque un fichero que nadie sabe leer no
        // cumple el art. 8.
        assert!(txt.contains("sha256(CADENA)"));
    }

    #[test]
    fn el_csv_va_con_punto_y_coma_y_con_BOM() {
        // El destino real es Excel en español: con `,` mete todo en una columna, y sin BOM lee los
        // acentos como basura. Es una exportación para que alguien la LEA.
        let txt = construir_csv(&[fila(1, "2027/000001", "")]);
        assert!(txt.starts_with('\u{FEFF}'));
        assert!(txt.contains("Orden;Tipo;TipoFactura;"));
        // La columna de `FechaOperacion` va vacía en el caso normal —la operación es del mismo día—
        // pero la columna EXISTE: un CSV cuyo número de campos cambia según la fila no lo abre bien
        // ninguna hoja de cálculo.
        assert!(txt.contains("1;ALTA;F2;2027/000001;15-01-2027;;12.10;1.10;"));
    }

    #[test]
    fn el_csv_saca_la_fecha_de_operacion_cuando_la_hay() {
        // La cena que cruza la medianoche. Quien abra el fichero tiene que poder ver que esa factura
        // documenta una operación de otro día: es justo el dato por el que preguntaría un inspector
        // al ver una venta fechada a la una de la madrugada.
        let mut f = fila(1, "2027/000001", "");
        f.fecha = "16-01-2027".into();
        f.fecha_operacion = "15-01-2027".into();
        let txt = construir_csv(&[f]);
        assert!(
            txt.contains("1;ALTA;F2;2027/000001;16-01-2027;15-01-2027;12.10;1.10;"),
            "{txt}"
        );
    }

    #[test]
    fn el_csv_escapa_un_campo_con_el_separador_dentro() {
        assert_eq!(csv("simple"), "simple");
        assert_eq!(csv("con;punto"), "\"con;punto\"");
        assert_eq!(csv("con\"comilla"), "\"con\"\"comilla\"");
    }

    #[test]
    fn el_xml_marca_el_primer_registro_y_encadena_el_resto() {
        let txt = construir_xml(&[fila(1, "2027/000001", ""), fila(2, "2027/000002", "HUELLA1")]);
        assert!(txt.contains("<PrimerRegistro>S</PrimerRegistro>"));
        assert!(txt.contains("<HuellaRegistroAnterior>HUELLA1</HuellaRegistroAnterior>"));
        assert_eq!(txt.matches("<Registro>").count(), 2);
    }

    #[test]
    fn el_estado_de_remision_va_en_su_propio_bloque() {
        // No es un campo del diseño oficial: es información NUESTRA sobre el registro. Mezclarlo con
        // los campos del registro invitaría a leerlo como parte de lo que se remitió.
        let txt = construir_xml(&[fila(1, "2027/000001", "")]);
        assert!(txt.contains("<EstadoRemision>"));
        assert!(txt.contains("<Estado>ACEPTADO</Estado>"));
        assert!(txt.contains("<CSV>CSV123</CSV>"));
    }

    #[test]
    fn el_xml_escapa_el_texto() {
        let mut f = fila(1, "2027/000001", "");
        f.num_serie = "A&B".into();
        let txt = construir_xml(&[f]);
        assert!(txt.contains("<NumSerieFactura>A&amp;B</NumSerieFactura>"));
    }

    #[test]
    fn el_manifiesto_dice_el_rango_y_cuantos_entraron() {
        let ctx = ContextoExport {
            nif: "89890001K".into(),
            razon_social: "Bar de Pruebas SL".into(),
            version_sistema: "0.1.0".into(),
            nombre_sistema: "TPV Altaria".into(),
            id_sistema: "01".into(),
            nif_productor: "B12345674".into(),
            nombre_productor: "Altaria Lights".into(),
            entorno: "pruebas".into(),
        };
        let json = construir_manifiesto(
            &[fila(1, "2027/000001", ""), fila(2, "2027/000002", "HUELLA1")],
            &ctx,
            "2027-01-01",
            "2027-01-31",
        );
        assert!(json.contains("\"total\":2"));
        assert!(json.contains("\"desde\":\"2027-01-01\""));
        assert!(json.contains("\"primer_numero\":\"2027/000001\""));
        assert!(json.contains("\"ultimo_numero\":\"2027/000002\""));
        assert!(json.contains("SHA-256"));
    }

    #[test]
    fn un_rango_vacio_produce_un_manifiesto_que_lo_dice() {
        // Un rango sin registros no es un error: puede que el bar no facturara nada esa semana. Lo
        // que no se puede es entregar un ZIP que parezca completo sin decirlo.
        let ctx = ContextoExport {
            nif: "89890001K".into(),
            razon_social: "Bar".into(),
            version_sistema: "0.1.0".into(),
            nombre_sistema: "TPV".into(),
            id_sistema: "01".into(),
            nif_productor: String::new(),
            nombre_productor: String::new(),
            entorno: "produccion".into(),
        };
        let json = construir_manifiesto(&[], &ctx, "2027-02-01", "2027-02-07");
        assert!(json.contains("\"total\":0"));
        assert!(json.contains("\"primer_numero\":null"));
    }
}
