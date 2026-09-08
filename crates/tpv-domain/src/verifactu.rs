//! Dominio de **Veri\*factu** (FISCAL-01). RD 1007/2023 (RRSIF) + Orden HAC/1177/2024.
//!
//! Aquí vive la aritmética y el formato del registro de facturación, y nada más: sin BD, sin red,
//! sin reloj. Es lo que permite probar barato lo único que la AEAT comprueba carácter a carácter
//! —la huella— sin una conexión ni un certificado delante.
//!
//! **El principio que ordena todo:** el registro de facturación es el hecho fiscal; el papel es una
//! copia suya y el envío a la AEAT es una consecuencia diferida. De ahí que aquí no haya nada que
//! pueda fallar por causas externas: lo que se calcula en este módulo es determinista o no es nada.
//!
//! Lo que NO está aquí, a propósito: el XML (es transporte, vive en `tpv-infra-aeat`), la
//! persistencia (`tpv-infra-sqlite`) y la decisión de cuándo emitir (`tpv-application`).
//!
//! ## Fuentes
//!
//! - Huella: *Detalle de las especificaciones técnicas para generación de la huella o hash de los
//!   registros de facturación*, AEAT v0.1.2 (27/08/2024). Sus tres ejemplos son los tests golden
//!   de este módulo.
//! - QR: *Detalle de las especificaciones técnicas del código QR de la factura*, AEAT v0.5.0.
//! - Validaciones: *Validaciones y errores*, AEAT v1.2.2 + `errores.properties`.

use sha2::{Digest, Sha256};

// ─────────────────────────────────────────────────────────────────────────────
// Importes: TEXTO, y ese es el punto delicado
// ─────────────────────────────────────────────────────────────────────────────

/// Formatea un importe **exactamente como va al XML, al QR y a la cadena de la huella**.
///
/// El XSD lo tipa como una cadena con el patrón `(\+|-)?\d{1,12}(\.\d{0,2})?`: punto decimal, sin
/// separador de miles, sin símbolo. No es un número.
///
/// **Por qué importa que esto se llame una sola vez por importe.** `ImporteTotal` y `CuotaTotal`
/// entran en la cadena que se hashea, y `f64` → texto no es una operación única: `123.1`, `123.10`
/// y `123.100000000000001` son tres cadenas distintas y tres huellas distintas. La AEAT admite
/// indistintamente una o dos posiciones decimales (los ceros a la derecha no cuentan para la
/// huella), pero eso no nos salva de lo que sí nos rompería: **recomputar la cadena más tarde y
/// obtener otra**. Por eso el resultado de esta función se guarda en la fila, y nadie recomputa
/// nada al leer.
///
/// El `-0.00` se normaliza a `0.00`: un importe negativo minúsculo no es un importe negativo, y en
/// un registro fiscal el signo significa algo (una rectificativa por diferencias).
pub fn fmt_importe(v: f64) -> String {
    let c = (v * 100.0).round() / 100.0;
    let c = if c == 0.0 { 0.0 } else { c }; // se lleva por delante el -0.0
    format!("{c:.2}")
}

/// Formatea un tipo impositivo (`TipoImpositivo`, patrón `\d{1,3}(\.\d{0,2})?`).
///
/// Sin decimales cuando son cero (`21`, no `21.00`), que es como lo escriben los ejemplos oficiales
/// de la AEAT, y con dos cuando los hay (`7.5`). No entra en la huella, así que aquí el formato es
/// una cuestión de higiene, no de integridad.
pub fn fmt_tipo(v: f64) -> String {
    let c = (v * 100.0).round() / 100.0;
    if (c - c.round()).abs() < f64::EPSILON {
        format!("{}", c.round() as i64)
    } else {
        let s = format!("{c:.2}");
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// La huella (art. 13 de la Orden)
// ─────────────────────────────────────────────────────────────────────────────

/// El único algoritmo permitido a día de hoy (lista L12 del anexo de la Orden). Va en el campo
/// `TipoHuella`, que es **obligatorio** en el registro — cosa que es fácil pasar por alto porque el
/// documento de la huella no lo menciona: sale sólo del XSD.
pub const TIPO_HUELLA_SHA256: &str = "01";

/// Datos de entrada de la huella de un registro de **alta**, en el orden exacto del diseño de
/// registro. El orden no es una convención nuestra: cambiarlo cambia el hash.
#[derive(Debug, Clone)]
pub struct EntradaHuellaAlta<'a> {
    pub id_emisor_factura: &'a str,
    pub num_serie_factura: &'a str,
    /// `DD-MM-AAAA`.
    pub fecha_expedicion_factura: &'a str,
    pub tipo_factura: &'a str,
    /// Ya formateado con [`fmt_importe`].
    pub cuota_total: &'a str,
    /// Ya formateado con [`fmt_importe`].
    pub importe_total: &'a str,
    /// Huella del registro **anterior**. `None` en el primero de la cadena.
    pub huella_anterior: Option<&'a str>,
    /// `AAAA-MM-DDThh:mm:ss±hh:mm`.
    pub fecha_hora_huso: &'a str,
}

/// Datos de entrada de la huella de un registro de **anulación**. Son otros campos y otro orden:
/// el diseño de registro de la anulación es distinto y por eso hay dos funciones y no una con un
/// `if`.
#[derive(Debug, Clone)]
pub struct EntradaHuellaAnulacion<'a> {
    pub id_emisor_factura_anulada: &'a str,
    pub num_serie_factura_anulada: &'a str,
    /// `DD-MM-AAAA`.
    pub fecha_expedicion_factura_anulada: &'a str,
    pub huella_anterior: Option<&'a str>,
    pub fecha_hora_huso: &'a str,
}

/// Un par `nombre=valor` de la cadena, con las reglas de la especificación aplicadas:
///
/// - Los valores van **sin espacios al principio ni al final**.
/// - Si el campo no existe o va vacío, se pone **el nombre y el `=`, sin nada detrás**. Es el caso
///   del primer registro de la cadena: `…&Huella=&FechaHoraHusoGenRegistro=…`.
fn par(nombre: &str, valor: &str) -> String {
    format!("{}={}", nombre, valor.trim())
}

/// Construye la cadena que se hashea para un registro de **alta**.
///
/// Se devuelve la cadena y no sólo el hash porque **se guarda en la fila** (`Cadena_Huella`). Es
/// redundante —se puede recomputar— y precisamente por eso vale: si algún día el formateo cambia,
/// el fichero enseña qué se hasheó de verdad, y la exportación del art. 8 RRSIF es auditable sin
/// tener que confiar en el código que la lee.
pub fn cadena_huella_alta(e: &EntradaHuellaAlta<'_>) -> String {
    [
        par("IDEmisorFactura", e.id_emisor_factura),
        par("NumSerieFactura", e.num_serie_factura),
        par("FechaExpedicionFactura", e.fecha_expedicion_factura),
        par("TipoFactura", e.tipo_factura),
        par("CuotaTotal", e.cuota_total),
        par("ImporteTotal", e.importe_total),
        par("Huella", e.huella_anterior.unwrap_or("")),
        par("FechaHoraHusoGenRegistro", e.fecha_hora_huso),
    ]
    .join("&")
}

/// Construye la cadena que se hashea para un registro de **anulación**.
pub fn cadena_huella_anulacion(e: &EntradaHuellaAnulacion<'_>) -> String {
    [
        par("IDEmisorFacturaAnulada", e.id_emisor_factura_anulada),
        par("NumSerieFacturaAnulada", e.num_serie_factura_anulada),
        par(
            "FechaExpedicionFacturaAnulada",
            e.fecha_expedicion_factura_anulada,
        ),
        par("Huella", e.huella_anterior.unwrap_or("")),
        par("FechaHoraHusoGenRegistro", e.fecha_hora_huso),
    ]
    .join("&")
}

/// SHA-256 de la cadena, codificada en UTF-8, en **hexadecimal y mayúsculas** (64 caracteres).
///
/// Es un hash pelado: en Veri\*factu **no se firma la factura**. La firma electrónica del registro
/// (XAdES) es un requisito de la modalidad NO Veri\*factu, que se descartó. Lo que garantiza la
/// integridad aquí es el encadenamiento, y el certificado sólo sirve para autenticar la conexión.
pub fn huella(cadena: &str) -> String {
    let d = Sha256::digest(cadena.as_bytes());
    let mut out = String::with_capacity(64);
    for b in d {
        out.push_str(&format!("{b:02X}"));
    }
    out
}

// ─────────────────────────────────────────────────────────────────────────────
// El código QR (arts. 20 y 21 de la Orden)
// ─────────────────────────────────────────────────────────────────────────────

/// Base de la URL de cotejo, entorno de **producción**.
pub const QR_BASE_PRODUCCION: &str =
    "https://www2.agenciatributaria.gob.es/wlpl/TIKE-CONT/ValidarQR";
/// Base de la URL de cotejo, entorno de **pruebas** (Portal de Pruebas Externas).
pub const QR_BASE_PRUEBAS: &str = "https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR";

/// Codifica un valor para la *query string* (`application/x-www-form-urlencoded` sobre UTF-8, pero
/// con el espacio como `%20` y no como `+`, que es lo que hace `URLEncoder` en el ejemplo de la
/// AEAT una vez corregido el `+`).
///
/// **Esto no es opcional y el propio ejemplo oficial lo demuestra**: un número de serie con un `&`
/// dentro (`12345678&G33`) parte la URL en dos parámetros si no se codifica, y el cotejo devuelve
/// un error de campo. Se conservan sin escapar sólo los *unreserved* de RFC 3986.
fn url_encode(v: &str) -> String {
    let mut out = String::with_capacity(v.len());
    for b in v.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// URL exacta que se imprime en el QR del papel.
///
/// Los cuatro parámetros son obligatorios y no admite ninguno más: el parámetro `formato=json` que
/// acepta el servicio **nunca puede ir en el QR de una factura** (lo dice la especificación en
/// mayúsculas).
///
/// `importe` es el total de la factura con punto decimal — el mismo texto que se guardó y que entró
/// en la huella, no un número reformateado aquí.
pub fn url_qr(base: &str, nif: &str, num_serie: &str, fecha_ddmmaaaa: &str, importe: &str) -> String {
    format!(
        "{}?nif={}&numserie={}&fecha={}&importe={}",
        base,
        url_encode(nif.trim()),
        url_encode(num_serie.trim()),
        url_encode(fecha_ddmmaaaa.trim()),
        url_encode(importe.trim()),
    )
}

/// Entorno de emisión. Cambia **a la vez** el endpoint del servicio web y la base del QR: son la
/// misma decisión, y separarlas es la forma de imprimir un ticket de producción con un QR que
/// apunta a preproducción.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Entorno {
    Produccion,
    Pruebas,
}

impl Entorno {
    /// Lee el valor de `Business_Settings.Verifactu_Entorno`. Cualquier cosa que no sea exactamente
    /// `"pruebas"` es producción: fallar hacia producción es lo correcto porque un registro emitido
    /// en pruebas y creído bueno es una factura que la AEAT no tiene.
    pub fn desde_texto(s: &str) -> Self {
        if s.trim().eq_ignore_ascii_case("pruebas") {
            Entorno::Pruebas
        } else {
            Entorno::Produccion
        }
    }

    pub fn base_qr(self) -> &'static str {
        match self {
            Entorno::Produccion => QR_BASE_PRODUCCION,
            Entorno::Pruebas => QR_BASE_PRUEBAS,
        }
    }

    pub fn es_pruebas(self) -> bool {
        matches!(self, Entorno::Pruebas)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fechas y horas con el formato del registro
// ─────────────────────────────────────────────────────────────────────────────

/// `AAAA-MM-DD` → `DD-MM-AAAA`, que es el tipo `fecha` del XSD (longitud 10, patrón
/// `\d{2}-\d{2}-\d{4}`) y el formato del parámetro `fecha` del QR.
///
/// Devuelve `None` si la entrada no tiene la forma esperada: una fecha mal formada es el error 1106
/// y un envío rechazado, así que es mejor no construir el registro que construirlo mal.
pub fn fecha_registro_desde_iso(ymd: &str) -> Option<String> {
    let s = ymd.trim();
    let b = s.as_bytes();
    if b.len() < 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    if !b[..10]
        .iter()
        .enumerate()
        .all(|(i, c)| if i == 4 || i == 7 { true } else { c.is_ascii_digit() })
    {
        return None;
    }
    Some(format!("{}-{}-{}", &s[8..10], &s[5..7], &s[0..4]))
}

// ─────────────────────────────────────────────────────────────────────────────
// Identificadores fiscales
// ─────────────────────────────────────────────────────────────────────────────

/// Letra de control de un NIF de persona física, por el resto de la división entre 23.
const LETRAS_NIF: &[u8; 23] = b"TRWAGMYFPDXBNJZSQVHLCKE";

/// Valida un **NIF/NIE/CIF español** comprobando el dígito o letra de control.
///
/// La AEAT lo tipa como una cadena de longitud exacta 9 y lo contrasta contra su censo. Un NIF mal
/// dictado **no se rechaza al enviar**: vuelve como *«error admisible: NIF no censado»* (código
/// 2001), o sea horas después y sin el cliente delante. Comprobar el control aquí mismo evita casi
/// todos esos casos, que es la razón de que esta función exista en el dominio y no en la interfaz.
///
/// Cubre las tres formas:
///
/// - **NIF** de persona física: 8 dígitos + letra (`12345678Z`).
/// - **NIE**: `X`/`Y`/`Z` + 7 dígitos + letra, sustituyendo la inicial por `0`/`1`/`2`.
/// - **CIF** de persona jurídica: letra + 7 dígitos + dígito o letra de control, con la suma
///   ponderada de Luhn sobre las posiciones impares.
pub fn nif_valido(nif: &str) -> bool {
    let s: String = nif.trim().to_ascii_uppercase().replace(['-', ' '], "");
    if s.len() != 9 || !s.is_ascii() {
        return false;
    }
    let b = s.as_bytes();

    // NIF de persona física: 8 dígitos + letra.
    if b[..8].iter().all(|c| c.is_ascii_digit()) && b[8].is_ascii_alphabetic() {
        let n: u32 = s[..8].parse().unwrap_or(0);
        return b[8] == LETRAS_NIF[(n % 23) as usize];
    }

    // NIE: X/Y/Z + 7 dígitos + letra. La inicial vale 0/1/2 y el resto se calcula igual.
    if matches!(b[0], b'X' | b'Y' | b'Z')
        && b[1..8].iter().all(|c| c.is_ascii_digit())
        && b[8].is_ascii_alphabetic()
    {
        let pref = match b[0] {
            b'X' => '0',
            b'Y' => '1',
            _ => '2',
        };
        let n: u32 = format!("{}{}", pref, &s[1..8]).parse().unwrap_or(0);
        return b[8] == LETRAS_NIF[(n % 23) as usize];
    }

    // CIF: letra de organización + 7 dígitos + control (dígito o letra, según la letra inicial).
    if b[0].is_ascii_alphabetic() && b[1..8].iter().all(|c| c.is_ascii_digit()) {
        let mut suma_par = 0u32;
        let mut suma_impar = 0u32;
        for (i, c) in s[1..8].bytes().enumerate() {
            let d = (c - b'0') as u32;
            // Posiciones 1..7 dentro del cuerpo: las de índice PAR aquí son las impares del CIF.
            if i % 2 == 0 {
                let doble = d * 2;
                suma_impar += doble / 10 + doble % 10;
            } else {
                suma_par += d;
            }
        }
        let total = suma_par + suma_impar;
        let control_num = ((10 - (total % 10)) % 10) as u8;
        let control_letra = b"JABCDEFGHI"[control_num as usize];

        return match b[0] {
            // Sólo letra de control.
            b'K' | b'P' | b'Q' | b'R' | b'S' | b'N' | b'W' => b[8] == control_letra,
            // Sólo dígito de control.
            b'A' | b'B' | b'E' | b'H' => b[8] == b'0' + control_num,
            // Cualquiera de los dos.
            _ => b[8] == b'0' + control_num || b[8] == control_letra,
        };
    }

    false
}

// ─────────────────────────────────────────────────────────────────────────────
// Saneado de texto que va al XML
// ─────────────────────────────────────────────────────────────────────────────

/// Recorta y limpia un texto que va a un campo del registro.
///
/// Hay dos razones distintas y las dos son de la AEAT:
///
/// - El error **1287** rechaza la factura si un campo contiene `<`, `>`, `"`, `'` o `=`. No es el
///   escapado de XML (que también hay que hacer, pero eso es del serializador): son caracteres que
///   el validador rechaza aunque vayan escapados. Y por estos campos pasan textos que escribe el
///   usuario.
/// - Los campos tienen longitud máxima y superarla es el error 1100.
///
/// Los caracteres de control se convierten en espacio por la misma razón por la que el generador de
/// tickets lo hace: el nombre de un producto lo escribe una persona.
pub fn sanear_texto(v: &str, max: usize) -> String {
    let limpio: String = v
        .chars()
        .map(|c| match c {
            '<' | '>' | '"' | '\'' | '=' => ' ',
            c if (c as u32) < 0x20 => ' ',
            c => c,
        })
        .collect();
    // Colapsa los espacios que deja la sustitución: "a = b" no tiene que salir como "a   b".
    let mut out = String::with_capacity(limpio.len());
    let mut espacio = false;
    for c in limpio.chars() {
        if c == ' ' {
            espacio = true;
            continue;
        }
        if espacio && !out.is_empty() {
            out.push(' ');
        }
        espacio = false;
        out.push(c);
    }
    out.chars().take(max).collect::<String>().trim().to_string()
}

// ─────────────────────────────────────────────────────────────────────────────
// Umbral de la factura simplificada
// ─────────────────────────────────────────────────────────────────────────────

/// Límite por defecto (IVA incluido) de una factura simplificada en hostelería.
///
/// El general del art. 4.1 RD 1619/2012 son 400 €, pero los *«servicios de hostelería y restauración
/// prestados por restaurantes, bares, cafeterías… así como el suministro de bebidas o comidas para
/// consumir en el acto»* están en la lista del art. 4.2, que lo sube a 3.000. Es también el número
/// que valida la AEAT en el servicio web (error 1150, con un margen de +10 €).
pub const LIMITE_SIMPLIFICADA_HOSTELERIA: f64 = 3000.0;

/// ¿Este importe cabe en una factura simplificada?
///
/// **Se mira sobre el importe DEL COBRO, no sobre el total de la comanda**, y no es un matiz menor:
/// como un cobro es una factura, una comanda de 4.000 € que pagan dos empresas a 2.000 € cada una
/// son dos simplificadas correctas, y eso ya funciona con el cobro fraccionado.
///
/// Lo que no puede haber es un botón de «dividir el cobro» para bajar del límite: partir el pago de
/// un mismo cliente es fraccionamiento artificial de una operación. Que el reparto entre clientes
/// distintos funcione es una consecuencia del modelo, no un atajo que se ofrezca.
pub fn cabe_en_simplificada(importe: f64, limite: f64) -> bool {
    let l = if limite > 0.0 {
        limite
    } else {
        LIMITE_SIMPLIFICADA_HOSTELERIA
    };
    (importe * 100.0).round() / 100.0 <= (l * 100.0).round() / 100.0
}

/// Umbral del campo `Macrodato`: por encima (en valor absoluto) hay que informarlo con `"S"`, y por
/// debajo no se puede (errores 1138 y 1139). Un bar no llegará nunca; se implementa porque la
/// validación es simétrica y omitirla sería el único caso en que el registro sale mal por no haber
/// escrito tres líneas.
pub const UMBRAL_MACRODATO: f64 = 100_000_000.0;

/// `Some("S")` si el importe obliga a marcar `Macrodato`; `None` si no debe informarse.
pub fn macrodato(importe_total: f64) -> Option<&'static str> {
    if importe_total.abs() >= UMBRAL_MACRODATO {
        Some("S")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Los tres vectores oficiales (AEAT v0.1.2 §6) ────────────────────────────────────────────
    //
    // Son el mejor regalo que hace la AEAT: si el formateo se desvía un solo carácter, fallan. Se
    // escriben con la cadena esperada Y el hash esperado a propósito, para que un fallo diga cuál
    // de las dos cosas se ha roto.

    #[test]
    fn vector_oficial_1_primer_registro_de_alta() {
        let e = EntradaHuellaAlta {
            id_emisor_factura: "89890001K",
            num_serie_factura: "12345678/G33",
            fecha_expedicion_factura: "01-01-2024",
            tipo_factura: "F1",
            cuota_total: "12.35",
            importe_total: "123.45",
            huella_anterior: None,
            fecha_hora_huso: "2024-01-01T19:20:30+01:00",
        };
        let cadena = cadena_huella_alta(&e);
        assert_eq!(
            cadena,
            "IDEmisorFactura=89890001K&NumSerieFactura=12345678/G33\
             &FechaExpedicionFactura=01-01-2024&TipoFactura=F1&CuotaTotal=12.35\
             &ImporteTotal=123.45&Huella=&FechaHoraHusoGenRegistro=2024-01-01T19:20:30+01:00"
        );
        assert_eq!(
            huella(&cadena),
            "3C464DAF61ACB827C65FDA19F352A4E3BDC2C640E9E9FC4CC058073F38F12F60"
        );
    }

    #[test]
    fn vector_oficial_2_alta_encadenada() {
        let anterior = "3C464DAF61ACB827C65FDA19F352A4E3BDC2C640E9E9FC4CC058073F38F12F60";
        let e = EntradaHuellaAlta {
            id_emisor_factura: "89890001K",
            num_serie_factura: "12345679/G34",
            fecha_expedicion_factura: "01-01-2024",
            tipo_factura: "F1",
            cuota_total: "12.35",
            importe_total: "123.45",
            huella_anterior: Some(anterior),
            fecha_hora_huso: "2024-01-01T19:20:35+01:00",
        };
        assert_eq!(
            huella(&cadena_huella_alta(&e)),
            "F7B94CFD8924EDFF273501B01EE5153E4CE8F259766F88CF6ACB8935802A2B97"
        );
    }

    #[test]
    fn vector_oficial_3_anulacion_encadenada() {
        let anterior = "F7B94CFD8924EDFF273501B01EE5153E4CE8F259766F88CF6ACB8935802A2B97";
        let e = EntradaHuellaAnulacion {
            id_emisor_factura_anulada: "89890001K",
            num_serie_factura_anulada: "12345679/G34",
            fecha_expedicion_factura_anulada: "01-01-2024",
            huella_anterior: Some(anterior),
            fecha_hora_huso: "2024-01-01T19:20:40+01:00",
        };
        let cadena = cadena_huella_anulacion(&e);
        assert_eq!(
            cadena,
            "IDEmisorFacturaAnulada=89890001K&NumSerieFacturaAnulada=12345679/G34\
             &FechaExpedicionFacturaAnulada=01-01-2024\
             &Huella=F7B94CFD8924EDFF273501B01EE5153E4CE8F259766F88CF6ACB8935802A2B97\
             &FechaHoraHusoGenRegistro=2024-01-01T19:20:40+01:00"
        );
        assert_eq!(
            huella(&cadena),
            "177547C0D57AC74748561D054A9CEC14B4C4EA23D1BEFD6F2E69E3A388F90C68"
        );
    }

    #[test]
    fn el_primer_registro_deja_el_nombre_y_el_igual_sin_valor() {
        // La regla que más se incumple sin darse cuenta: el campo ausente NO se omite de la cadena.
        let e = EntradaHuellaAlta {
            id_emisor_factura: "89890001K",
            num_serie_factura: "1",
            fecha_expedicion_factura: "01-01-2024",
            tipo_factura: "F2",
            cuota_total: "0.00",
            importe_total: "0.00",
            huella_anterior: None,
            fecha_hora_huso: "2024-01-01T00:00:00+01:00",
        };
        assert!(cadena_huella_alta(&e).contains("&Huella=&FechaHoraHusoGenRegistro="));
    }

    #[test]
    fn los_valores_van_sin_espacios_a_los_lados() {
        // El ejemplo de la especificación: "<NumSerieFactura> 12345678 / G33 </...>" da
        // "12345678 / G33" — se recortan los extremos, NO los espacios interiores.
        let e = EntradaHuellaAlta {
            id_emisor_factura: " 89890001K ",
            num_serie_factura: " 12345678 / G33 ",
            fecha_expedicion_factura: "01-01-2024",
            tipo_factura: "F1",
            cuota_total: "12.35",
            importe_total: "123.45",
            huella_anterior: None,
            fecha_hora_huso: "2024-01-01T19:20:30+01:00",
        };
        let c = cadena_huella_alta(&e);
        assert!(c.contains("&NumSerieFactura=12345678 / G33&"));
        assert!(c.starts_with("IDEmisorFactura=89890001K&"));
    }

    #[test]
    fn la_huella_sale_en_hexadecimal_mayusculas_de_64() {
        let h = huella("");
        assert_eq!(h.len(), 64);
        assert!(h.chars().all(|c| c.is_ascii_digit() || ('A'..='F').contains(&c)));
    }

    // ── Importes ────────────────────────────────────────────────────────────────────────────────

    #[test]
    fn fmt_importe_siempre_dos_decimales_y_punto() {
        assert_eq!(fmt_importe(123.1), "123.10");
        assert_eq!(fmt_importe(123.45), "123.45");
        assert_eq!(fmt_importe(0.0), "0.00");
        assert_eq!(fmt_importe(-12.5), "-12.50");
        // El caso que motiva guardar el texto: el f64 no vale como fuente de la cadena.
        assert_eq!(fmt_importe(0.1 + 0.2), "0.30");
    }

    #[test]
    fn fmt_importe_normaliza_el_menos_cero() {
        // Un `-0.00 €` en un ticket no significa nada, y en un registro fiscal el signo SÍ.
        assert_eq!(fmt_importe(-0.001), "0.00");
    }

    #[test]
    fn fmt_tipo_sin_decimales_cuando_son_cero() {
        assert_eq!(fmt_tipo(21.0), "21");
        assert_eq!(fmt_tipo(10.0), "10");
        assert_eq!(fmt_tipo(0.0), "0");
        assert_eq!(fmt_tipo(7.5), "7.5");
        assert_eq!(fmt_tipo(4.25), "4.25");
    }

    // ── QR ──────────────────────────────────────────────────────────────────────────────────────

    #[test]
    fn vector_oficial_del_qr_con_ampersand_en_el_numero_de_serie() {
        // El ejemplo del apartado 4 de la especificación del QR: sin codificar, ese `&` partiría la
        // URL en un parámetro `G33` inexistente y el cotejo devolvería un error de campo.
        let url = url_qr(QR_BASE_PRUEBAS, "89890001K", "12345678&G33", "01-01-2024", "241.4");
        assert_eq!(
            url,
            "https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR\
             ?nif=89890001K&numserie=12345678%26G33&fecha=01-01-2024&importe=241.4"
        );
    }

    #[test]
    fn el_qr_de_produccion_apunta_a_agenciatributaria_y_el_de_pruebas_a_prewww2() {
        assert!(Entorno::Produccion.base_qr().starts_with("https://www2.agenciatributaria.gob.es/"));
        assert!(Entorno::Pruebas.base_qr().starts_with("https://prewww2.aeat.es/"));
    }

    #[test]
    fn entorno_desconocido_cae_en_produccion() {
        // Fallar hacia producción es lo correcto: un registro emitido en pruebas y creído bueno es
        // una factura que la AEAT no tiene.
        assert_eq!(Entorno::desde_texto("pruebas"), Entorno::Pruebas);
        assert_eq!(Entorno::desde_texto("PRUEBAS"), Entorno::Pruebas);
        assert_eq!(Entorno::desde_texto("produccion"), Entorno::Produccion);
        assert_eq!(Entorno::desde_texto(""), Entorno::Produccion);
        assert_eq!(Entorno::desde_texto("basura"), Entorno::Produccion);
    }

    #[test]
    fn la_url_del_qr_solo_lleva_ascii_imprimible() {
        // La especificación lo exige: sólo ASCII 32-126.
        let url = url_qr(QR_BASE_PRODUCCION, "B12345674", "2027/000001 ñ", "15-01-2027", "12.00");
        assert!(url.chars().all(|c| (' '..='~').contains(&c)), "{url}");
        assert!(url.contains("%C3%B1"), "la eñe va en UTF-8 percent-encoded: {url}");
    }

    // ── Fechas ──────────────────────────────────────────────────────────────────────────────────

    #[test]
    fn fecha_iso_a_formato_de_registro() {
        assert_eq!(fecha_registro_desde_iso("2027-01-15").as_deref(), Some("15-01-2027"));
        // Acepta un datetime y se queda con la fecha.
        assert_eq!(
            fecha_registro_desde_iso("2027-01-15 21:34:56").as_deref(),
            Some("15-01-2027")
        );
        assert_eq!(fecha_registro_desde_iso("15/01/2027"), None);
        assert_eq!(fecha_registro_desde_iso(""), None);
    }

    // ── NIF ─────────────────────────────────────────────────────────────────────────────────────

    #[test]
    fn nif_de_persona_fisica() {
        assert!(nif_valido("12345678Z"));
        assert!(nif_valido("89890001K")); // el de los ejemplos oficiales de la AEAT
        assert!(!nif_valido("12345678A"));
        assert!(!nif_valido("1234567Z"));
    }

    #[test]
    fn nie() {
        assert!(nif_valido("X1234567L"));
        assert!(nif_valido("Y1234567X"));
        assert!(nif_valido("Z1234567R"));
        assert!(!nif_valido("X1234567A"));
    }

    #[test]
    fn cif() {
        assert!(nif_valido("A58818501"));
        assert!(nif_valido("B12345674"));
        assert!(nif_valido("Q2826000H")); // letra obligatoria (organismo público)
        assert!(!nif_valido("B12345670"));
    }

    #[test]
    fn nif_tolera_espacios_y_minusculas_pero_no_longitudes_raras() {
        assert!(nif_valido(" 12345678z "));
        assert!(!nif_valido("12345678"));
        assert!(!nif_valido("12345678ZZ"));
        assert!(!nif_valido(""));
    }

    // ── Saneado ─────────────────────────────────────────────────────────────────────────────────

    #[test]
    fn sanear_quita_los_caracteres_que_la_aeat_rechaza() {
        // Error 1287: <, >, ", ' y = tumban la factura aunque vayan escapados en el XML.
        assert_eq!(sanear_texto("Menú <del> día = 12", 100), "Menú del día 12");
        assert_eq!(sanear_texto("Bar \"El Rincón\"", 100), "Bar El Rincón");
        assert_eq!(sanear_texto("O'Donnell", 100), "O Donnell");
    }

    #[test]
    fn sanear_recorta_a_la_longitud_maxima() {
        assert_eq!(sanear_texto(&"a".repeat(600), 500).len(), 500);
    }

    #[test]
    fn sanear_convierte_los_controles_en_espacio() {
        // El nombre de un producto lo escribe una persona, y un ESC ahí lo lee la impresora como un
        // comando; en el XML es directamente un documento inválido.
        assert_eq!(sanear_texto("Caña\u{1b}Grande", 100), "Caña Grande");
    }

    // ── Límite de la simplificada ───────────────────────────────────────────────────────────────

    #[test]
    fn el_limite_de_la_simplificada_se_mira_sobre_el_cobro() {
        assert!(cabe_en_simplificada(2999.99, 3000.0));
        assert!(cabe_en_simplificada(3000.0, 3000.0));
        assert!(!cabe_en_simplificada(3000.01, 3000.0));
        // Dos cobros de 2.000 € sobre una comanda de 4.000 € siguen siendo dos F2 correctas.
        assert!(cabe_en_simplificada(2000.0, 3000.0));
    }

    #[test]
    fn un_limite_sin_configurar_cae_en_el_de_hosteleria() {
        assert!(cabe_en_simplificada(2999.0, 0.0));
        assert!(!cabe_en_simplificada(3001.0, 0.0));
    }

    #[test]
    fn macrodato_solo_a_partir_de_cien_millones() {
        // Simétrico a propósito: informarlo de menos es el error 1139 e informarlo de más el 1138.
        assert_eq!(macrodato(99_999_999.99), None);
        assert_eq!(macrodato(100_000_000.0), Some("S"));
        assert_eq!(macrodato(-100_000_000.0), Some("S"));
    }
}
