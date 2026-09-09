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

/// Los datos del cliente cuando pide **factura completa** (`F1`) o cuando el importe obliga a
/// emitirla (§2.2 del plan).
///
/// El **registro** sólo necesita `nombre_razon` + `nif`. La **factura en papel** es otro documento y
/// el art. 6 ROF le exige además el domicilio del destinatario, así que el formulario pide tres
/// cosas y sólo dos viajan a la AEAT.
#[derive(Debug, Clone, PartialEq)]
pub struct Destinatario {
    pub nombre_razon: String,
    pub nif: String,
    /// Sólo para el papel. El registro de facturación no lo lleva.
    pub direccion: Option<String>,
}

/// Por qué unos datos de destinatario no sirven.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DestinatarioInvalido {
    FaltaNombre,
    FaltaNif,
    NifMalFormado,
}

impl DestinatarioInvalido {
    pub fn mensaje(self) -> &'static str {
        match self {
            DestinatarioInvalido::FaltaNombre => "Falta el nombre o la razón social del cliente.",
            DestinatarioInvalido::FaltaNif => "Falta el NIF del cliente.",
            DestinatarioInvalido::NifMalFormado => {
                "El NIF del cliente no es válido. Compruébalo con el cliente delante: si se manda \
                 mal, la AEAT lo avisa horas después y ya no está para corregirlo."
            }
        }
    }
}

/// Normaliza y valida un destinatario.
///
/// **El dígito de control se comprueba aquí y no al enviar**, y eso es el punto: un NIF mal dictado
/// no provoca un rechazo, vuelve como *«error admisible: NIF no censado»* (código 2001) — o sea,
/// horas después, sin el cliente delante y con una subsanación que alguien tiene que disparar a
/// mano. Comprobar el control en el momento evita casi todos esos casos.
///
/// Lo que esto **no** puede comprobar es que el NIF exista en el censo de la AEAT: eso sólo lo sabe
/// la AEAT.
pub fn validar_destinatario(d: Destinatario) -> Result<Destinatario, DestinatarioInvalido> {
    let nombre = sanear_texto(&d.nombre_razon, 120);
    if nombre.is_empty() {
        return Err(DestinatarioInvalido::FaltaNombre);
    }
    let nif = d.nif.trim().to_ascii_uppercase().replace([' ', '-'], "");
    if nif.is_empty() {
        return Err(DestinatarioInvalido::FaltaNif);
    }
    if !nif_valido(&nif) {
        return Err(DestinatarioInvalido::NifMalFormado);
    }
    Ok(Destinatario {
        nombre_razon: nombre,
        nif,
        // El domicilio va al papel, no al XML, así que no se recorta a un máximo del XSD; sólo se
        // limpia.
        direccion: d
            .direccion
            .map(|v| sanear_texto(&v, 250))
            .filter(|v| !v.is_empty()),
    })
}

/// Qué clave de factura corresponde a un cobro.
///
/// - Con destinatario → `F1` (factura completa). Se emite así tanto si el cliente la pide
///   voluntariamente como si el importe obliga.
/// - Sin destinatario → `F2` (simplificada), **siempre que quepa**.
///
/// `None` significa que **no se puede emitir**: el importe pasa del límite de la simplificada y no
/// hay destinatario. No es un fallo del sistema, es un dato que falta — y quien lo tiene es el
/// cliente que está delante.
pub fn clave_de_factura(importe: f64, limite: f64, hay_destinatario: bool) -> Option<&'static str> {
    if hay_destinatario {
        Some("F1")
    } else if cabe_en_simplificada(importe, limite) {
        Some("F2")
    } else {
        None
    }
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

// ─────────────────────────────────────────────────────────────────────────────
// La comprobación previa del art. 7.i) de la Orden HAC/1177/2024
// ─────────────────────────────────────────────────────────────────────────────

/// El margen del art. 7.i).2.º: el último registro no puede estar fechado más de un minuto **por
/// delante** del que se va a generar.
pub const MARGEN_RELOJ_SEGUNDOS: i64 = 60;

/// Lo que hay que saber del último registro generado para comprobarlo antes de crear el siguiente.
#[derive(Debug, Clone)]
pub struct UltimoRegistro<'a> {
    /// La huella que el último registro **declaró** como la de su anterior. `None` si dijo ser el
    /// primero de la cadena.
    pub ant_huella_declarada: Option<&'a str>,
    /// La huella real del registro que hay **antes** de él. `None` si no hay ninguno.
    pub huella_del_anterior: Option<&'a str>,
    /// `FechaHoraHusoGenRegistro` del último registro, en segundos desde época.
    pub generado_en_segundos: i64,
}

/// Lo que puede estar mal en el último registro generado.
///
/// Es un enum y no un `bool` porque las dos anomalías son de naturaleza distinta y se explican
/// distinto: una dice que la cadena está rota, la otra que el reloj se ha movido.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnomaliaPrevia {
    /// El último registro declara como eslabón anterior una huella que no es la del registro que
    /// realmente le precede. La cadena está rota **en el registro anterior**, no en el que vamos a
    /// crear.
    EncadenamientoRoto,
    /// El último registro está fechado más de un minuto **por delante** del reloj actual. Eso no lo
    /// produce el paso del tiempo: lo produce un reloj que ha ido hacia atrás.
    RelojHaciaAtras {
        /// Cuántos segundos por delante está el último registro.
        adelanto_segundos: i64,
    },
}

impl AnomaliaPrevia {
    /// Texto para el registro de diagnóstico y para la pantalla.
    pub fn mensaje(&self) -> String {
        match self {
            AnomaliaPrevia::EncadenamientoRoto => {
                "el último registro de facturación no está correctamente encadenado con el anterior"
                    .to_string()
            }
            AnomaliaPrevia::RelojHaciaAtras { adelanto_segundos } => format!(
                "el último registro de facturación está fechado {adelanto_segundos} segundos por \
                 delante de la hora actual: el reloj del equipo ha ido hacia atrás"
            ),
        }
    }
}

/// La comprobación que el art. 7.i) exige **antes de generar cada registro**.
///
/// > *«Salvo cuando se trate del primer registro de facturación, cada vez que el sistema informático
/// > vaya a generar un nuevo registro de facturación, de alta o de anulación, antes deberá comprobar
/// > que se cumplen los siguientes requisitos:*
/// > *1.º El último registro de facturación generado está correctamente encadenado.*
/// > *2.º La fecha y hora de generación del último registro de facturación generado no es superior
/// > en más de un minuto a la fecha y hora actuales que se utilizarán para fechar el registro de
/// > facturación a generar.»*
///
/// ## Lo que NO hace, y es lo más importante
///
/// **No decide si se puede facturar.** Devuelve lo que ha encontrado y ya. La FAQ de desarrolladores
/// de la AEAT lo dice sin matices: *«será preciso generar el siguiente RF, ya que la facturación por
/// este motivo NUNCA debe interrumpirse»*. Un TPV que se niega a cobrar porque detecta una anomalía
/// en su propia cadena convierte un problema de trazabilidad en un bar que no puede vender.
///
/// ## El sentido del segundo punto
///
/// Se lee al revés de lo que parece. Que el registro nuevo sea **posterior** al anterior es lo
/// normal y no es ningún problema, por muchas horas que hayan pasado; lo que no se admite es que el
/// anterior esté fechado **por delante** del nuevo. Eso no lo produce el paso del tiempo: lo produce
/// un reloj que se ha movido hacia atrás —una corrección de NTP, un cambio a mano, una pila de BIOS
/// gastada—. El síntoma sería una cadena con fechas decrecientes, que es justo lo que produciría un
/// sistema manipulado, y la AEAT lo marca además con el error 2004.
pub fn comprobar_registro_previo(
    ultimo: Option<&UltimoRegistro<'_>>,
    ahora_segundos: i64,
) -> Option<AnomaliaPrevia> {
    // «Salvo cuando se trate del primer registro»: sin nada detrás no hay nada que comprobar.
    let u = ultimo?;

    // 1.º ¿El último está bien encadenado con el suyo? Se comparan las huellas como texto, en
    // mayúsculas, porque es como se guardan y como viajan.
    let declarada = u.ant_huella_declarada.unwrap_or("").trim();
    let real = u.huella_del_anterior.unwrap_or("").trim();
    if !declarada.eq_ignore_ascii_case(real) {
        return Some(AnomaliaPrevia::EncadenamientoRoto);
    }

    // 2.º ¿El último está fechado por delante del reloj actual?
    let adelanto = u.generado_en_segundos - ahora_segundos;
    if adelanto > MARGEN_RELOJ_SEGUNDOS {
        return Some(AnomaliaPrevia::RelojHaciaAtras {
            adelanto_segundos: adelanto,
        });
    }

    None
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
    // ── Factura completa (§2.2 y §9 del plan) ───────────────────────────────────────────────────

    #[test]
    fn sin_destinatario_y_dentro_del_limite_es_una_simplificada() {
        assert_eq!(clave_de_factura(12.10, 3000.0, false), Some("F2"));
        assert_eq!(clave_de_factura(3000.0, 3000.0, false), Some("F2"));
    }

    #[test]
    fn con_destinatario_es_factura_completa_aunque_el_importe_sea_pequeno() {
        // El cliente puede pedir factura por un café. No hay mínimo.
        assert_eq!(clave_de_factura(1.20, 3000.0, true), Some("F1"));
    }

    #[test]
    fn por_encima_del_limite_y_sin_destinatario_NO_se_puede_emitir() {
        // Es el caso que obliga a parar y preguntar. Emitir una F2 ahí sería emitir una factura
        // inválida que la AEAT rechaza (error 1150), y emitir una F1 sin destinatario es imposible
        // (el bloque Destinatarios es obligatorio en F1, error 1189).
        assert_eq!(clave_de_factura(3000.01, 3000.0, false), None);
        // Con los datos del cliente, la misma venta sí sale.
        assert_eq!(clave_de_factura(3000.01, 3000.0, true), Some("F1"));
    }

    #[test]
    fn un_destinatario_valido_se_normaliza() {
        let d = validar_destinatario(Destinatario {
            nombre_razon: "  Empresa Cliente SL  ".into(),
            nif: " b-12345674 ".into(),
            direccion: Some("  Calle Mayor 1  ".into()),
        })
        .unwrap();
        assert_eq!(d.nombre_razon, "Empresa Cliente SL");
        assert_eq!(d.nif, "B12345674");
        assert_eq!(d.direccion.as_deref(), Some("Calle Mayor 1"));
    }

    #[test]
    fn un_nif_de_cliente_mal_dictado_se_caza_en_el_momento() {
        // Si se mandara, volvería como error admisible 2001 («NIF no censado») horas después y sin
        // el cliente delante, con una subsanación que alguien tiene que disparar a mano.
        let e = validar_destinatario(Destinatario {
            nombre_razon: "Empresa SL".into(),
            nif: "B12345670".into(),
            direccion: None,
        })
        .unwrap_err();
        assert_eq!(e, DestinatarioInvalido::NifMalFormado);
    }

    #[test]
    fn un_destinatario_sin_nombre_o_sin_nif_no_vale() {
        // Los dos son obligatorios en el registro (bloque Destinatarios de una F1).
        assert_eq!(
            validar_destinatario(Destinatario {
                nombre_razon: "   ".into(),
                nif: "B12345674".into(),
                direccion: None,
            })
            .unwrap_err(),
            DestinatarioInvalido::FaltaNombre
        );
        assert_eq!(
            validar_destinatario(Destinatario {
                nombre_razon: "Empresa SL".into(),
                nif: "  ".into(),
                direccion: None,
            })
            .unwrap_err(),
            DestinatarioInvalido::FaltaNif
        );
    }

    #[test]
    fn el_nombre_del_destinatario_se_sanea_como_el_resto() {
        // Error 1287: la AEAT rechaza la factura si un campo lleva < > " ' o =. Y este campo lo
        // dicta un cliente y lo teclea un camarero con prisa.
        let d = validar_destinatario(Destinatario {
            nombre_razon: "Bar \"El Rincón\" = SL".into(),
            nif: "B12345674".into(),
            direccion: None,
        })
        .unwrap();
        assert_eq!(d.nombre_razon, "Bar El Rincón SL");
    }
}
#[cfg(test)]
mod tests_comprobacion_previa {
    #![allow(non_snake_case)] // los nombres en mayúsculas señalan qué afirma cada test

    //! La comprobación del art. 7.i) de la Orden HAC/1177/2024, antes de generar cada registro.
    //!
    //! Lo que más se presta a equivocarse es el signo del segundo punto: se lee al revés de lo que
    //! parece. Que el registro nuevo sea POSTERIOR al anterior es lo normal por muchas horas que
    //! pasen; lo que no se admite es que el ANTERIOR esté fechado por delante del nuevo.

    use super::*;

    const H1: &str = "AAAA1111";
    const H2: &str = "BBBB2222";

    fn ultimo<'a>(
        ant_declarada: Option<&'a str>,
        anterior_real: Option<&'a str>,
        generado_en: i64,
    ) -> UltimoRegistro<'a> {
        UltimoRegistro {
            ant_huella_declarada: ant_declarada,
            huella_del_anterior: anterior_real,
            generado_en_segundos: generado_en,
        }
    }

    const AHORA: i64 = 1_800_000_000;

    #[test]
    fn sin_registros_previos_no_hay_nada_que_comprobar() {
        // «Salvo cuando se trate del primer registro de facturación». El primero no tiene detrás.
        assert_eq!(comprobar_registro_previo(None, AHORA), None);
    }

    #[test]
    fn una_cadena_sana_no_da_anomalia() {
        let u = ultimo(Some(H1), Some(H1), AHORA - 300);
        assert_eq!(comprobar_registro_previo(Some(&u), AHORA), None);
    }

    #[test]
    fn el_primer_registro_de_la_cadena_declara_vacio_y_esta_bien() {
        // El RF n-1 era el primero: no declara huella anterior y no hay ninguna detrás. Comparar
        // `None` con `None` tiene que dar «correcto», no «roto».
        let u = ultimo(None, None, AHORA - 10);
        assert_eq!(comprobar_registro_previo(Some(&u), AHORA), None);
    }

    #[test]
    fn si_el_ultimo_declara_otra_huella_la_cadena_esta_rota() {
        let u = ultimo(Some(H1), Some(H2), AHORA - 10);
        assert_eq!(
            comprobar_registro_previo(Some(&u), AHORA),
            Some(AnomaliaPrevia::EncadenamientoRoto)
        );
    }

    #[test]
    fn declarar_primero_teniendo_uno_detras_tambien_es_romper_la_cadena() {
        // El caso que deja un hueco silencioso: alguien empieza una cadena nueva sin borrar la
        // anterior. Las dos partes existen y ninguna apunta a la otra.
        let u = ultimo(None, Some(H1), AHORA - 10);
        assert_eq!(
            comprobar_registro_previo(Some(&u), AHORA),
            Some(AnomaliaPrevia::EncadenamientoRoto)
        );
    }

    #[test]
    fn la_huella_se_compara_sin_distinguir_mayusculas() {
        // Se guardan en mayúsculas, pero comparar por igualdad exacta convertiría un cambio de
        // formato en «cadena rota» para todos los registros de golpe.
        let u = ultimo(Some("aaaa1111"), Some("AAAA1111"), AHORA - 10);
        assert_eq!(comprobar_registro_previo(Some(&u), AHORA), None);
    }

    #[test]
    fn que_haya_pasado_MUCHO_tiempo_NO_es_una_anomalia() {
        // Es el malentendido que la propia AEAT tuvo que aclarar en su FAQ: lo natural es que el
        // registro nuevo sea posterior en más de un minuto, y eso no es ningún problema. Un bar que
        // abre a las 13:00 genera el primer registro doce horas después del último de anoche.
        let u = ultimo(Some(H1), Some(H1), AHORA - 12 * 3600);
        assert_eq!(comprobar_registro_previo(Some(&u), AHORA), None);
    }

    #[test]
    fn el_ultimo_fechado_POR_DELANTE_del_reloj_es_el_reloj_hacia_atras() {
        let u = ultimo(Some(H1), Some(H1), AHORA + 3600);
        assert_eq!(
            comprobar_registro_previo(Some(&u), AHORA),
            Some(AnomaliaPrevia::RelojHaciaAtras {
                adelanto_segundos: 3600
            })
        );
    }

    #[test]
    fn el_margen_del_minuto_es_exacto() {
        // Un minuto justo pasa; un segundo más, no. El margen existe porque la hora de generación se
        // toma en Rust y la comparación ocurre después: sin él, cualquier registro se acusaría a sí
        // mismo por el tiempo que tarda la transacción.
        let justo = ultimo(Some(H1), Some(H1), AHORA + MARGEN_RELOJ_SEGUNDOS);
        assert_eq!(comprobar_registro_previo(Some(&justo), AHORA), None);

        let pasado = ultimo(Some(H1), Some(H1), AHORA + MARGEN_RELOJ_SEGUNDOS + 1);
        assert!(matches!(
            comprobar_registro_previo(Some(&pasado), AHORA),
            Some(AnomaliaPrevia::RelojHaciaAtras { .. })
        ));
    }

    #[test]
    fn la_cadena_rota_se_reporta_ANTES_que_el_reloj() {
        // Si las dos cosas fallan a la vez, la que importa es la cadena: el reloj se arregla solo en
        // cuanto NTP corrija, y la cadena no se arregla nunca sola.
        let u = ultimo(Some(H1), Some(H2), AHORA + 3600);
        assert_eq!(
            comprobar_registro_previo(Some(&u), AHORA),
            Some(AnomaliaPrevia::EncadenamientoRoto)
        );
    }

    #[test]
    fn los_dos_mensajes_explican_QUE_ha_pasado_y_no_solo_que_algo_falla() {
        // Estos textos acaban en un log y en una pantalla. «Error de encadenamiento» no le dice nada
        // a quien lo lee; «el reloj del equipo ha ido hacia atrás» le dice dónde mirar.
        assert!(AnomaliaPrevia::EncadenamientoRoto
            .mensaje()
            .contains("no está correctamente encadenado"));
        let m = AnomaliaPrevia::RelojHaciaAtras {
            adelanto_segundos: 90,
        }
        .mensaje();
        assert!(m.contains("90"), "{m}");
        assert!(m.contains("hacia atrás"), "{m}");
    }
}
