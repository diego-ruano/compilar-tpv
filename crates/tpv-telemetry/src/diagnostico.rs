//! OPS-02 · Lo que el paquete de diagnóstico para soporte saca de la telemetría: el final del
//! registro local, lo que espera en la cola hacia Axiom y el filtro por el que pasa todo.
//!
//! El registro local (`<AppData>/logs/tpv.*.log`) no se filtra al escribirlo: es del propio equipo
//! (`scrub.rs`). Lo que sale de él hacia el paquete es **lo mismo que sale hacia Axiom**: sólo las
//! líneas de INFO o más (las que reenvía `forward.rs`) y pasadas por el mismo filtro. Además se
//! tapa el usuario de las rutas de carpeta (`C:\Users\<usuario>\…`): no debería haber ninguna
//! (AUD-28), pero el paquete lo abre una persona que no es la del equipo.

use std::borrow::Cow;
use std::fs::{self, File};
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::UNIX_EPOCH;

use regex::Regex;
use serde::Serialize;
use serde_json::Value;

/// Dónde están el registro y la cola en este proceso. Lo fija `init`; `None` si no llegó a hacerlo.
static CARPETAS: OnceLock<Carpetas> = OnceLock::new();

#[derive(Debug, Clone)]
pub struct Carpetas {
    pub registro: PathBuf,
    pub cola: PathBuf,
}

pub(crate) fn fijar_carpetas(registro: PathBuf, cola: PathBuf) {
    let _ = CARPETAS.set(Carpetas { registro, cola });
}

/// Las carpetas del registro y de la cola, si la telemetría arrancó.
pub fn carpetas() -> Option<Carpetas> {
    CARPETAS.get().cloned()
}

/// Lo más que ocupa una línea del registro dentro del paquete. Se corta después de filtrarla.
const TOPE_LINEA: usize = 2 * 1024;
const MARCA_RECORTE: &str = "…[recortado]";

/// El final del registro, de lo más viejo a lo más nuevo.
#[derive(Debug, Clone, Serialize)]
pub struct RegistroReciente {
    /// Los ficheros de los que salen las líneas, por nombre (`tpv.2026-11-20.log`).
    pub ficheros: Vec<String>,
    pub lineas: Vec<String>,
    /// Había más de lo que cabe: falta lo más antiguo.
    pub recortado: bool,
}

/// Lee lo último del registro de `dir`: como mucho `tope_bytes` de los ficheros más recientes y
/// `tope_lineas` líneas, sólo las de INFO o más y filtradas.
pub fn registro_reciente_en(dir: &Path, tope_bytes: usize, tope_lineas: usize) -> io::Result<RegistroReciente> {
    // `tracing-appender` los nombra `tpv.AAAA-MM-DD.log`: por nombre, de más nuevo a más viejo.
    let mut ficheros: Vec<PathBuf> = fs::read_dir(dir)?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.is_file()
                && p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with("tpv") && n.ends_with(".log"))
        })
        .collect();
    ficheros.sort();
    ficheros.reverse();

    let mut queda = tope_bytes;
    let mut recortado = false;
    let mut nombres = Vec::new();
    // Trozos de cada fichero, del más nuevo al más viejo.
    let mut trozos: Vec<String> = Vec::new();
    for fichero in &ficheros {
        if queda == 0 {
            recortado = true;
            break;
        }
        let mut f = File::open(fichero)?;
        let largo = f.metadata()?.len();
        let desde = largo.saturating_sub(queda as u64);
        f.seek(SeekFrom::Start(desde))?;
        let mut bytes = Vec::with_capacity((largo - desde) as usize);
        f.read_to_end(&mut bytes)?;
        queda = queda.saturating_sub(bytes.len());
        let mut texto = String::from_utf8_lossy(&bytes).into_owned();
        if desde > 0 {
            // Se ha empezado a mitad de una línea: fuera.
            recortado = true;
            texto = texto.split_once('\n').map(|(_, resto)| resto.to_string()).unwrap_or_default();
        }
        nombres.push(fichero.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default());
        trozos.push(texto);
    }
    nombres.reverse();
    trozos.reverse();

    let mut lineas = Vec::new();
    // Una línea que no empieza con la hora sigue al evento de arriba (un mensaje de varias líneas):
    // va o no va con él.
    let mut dentro = false;
    for linea in trozos.iter().flat_map(|t| t.lines()) {
        if let Some(nivel) = nivel_de(linea) {
            dentro = matches!(nivel, "INFO" | "WARN" | "ERROR");
        }
        if dentro && !linea.trim().is_empty() {
            lineas.push(acotar(filtrar_texto(linea).into_owned()));
        }
    }
    if lineas.len() > tope_lineas {
        recortado = true;
        lineas.drain(..lineas.len() - tope_lineas);
    }
    Ok(RegistroReciente { ficheros: nombres, lineas, recortado })
}

/// El nivel de una línea que empieza un evento (`2026-11-20T10:00:00.123Z  INFO tpv::x: …`).
fn nivel_de(linea: &str) -> Option<&str> {
    let mut partes = linea.split_whitespace();
    let hora = partes.next()?;
    let b = hora.as_bytes();
    let es_hora = b.len() >= 20 && b[..4].iter().all(u8::is_ascii_digit) && b[4] == b'-' && b[10] == b'T';
    if !es_hora {
        return None;
    }
    partes.next().filter(|n| matches!(*n, "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR"))
}

fn acotar(mut linea: String) -> String {
    if linea.len() > TOPE_LINEA {
        let mut corte = TOPE_LINEA;
        while !linea.is_char_boundary(corte) {
            corte -= 1;
        }
        linea.truncate(corte);
        linea.push_str(MARCA_RECORTE);
    }
    linea
}

/// Lo que espera en la cola hacia Axiom: lo que se ha registrado y todavía no ha salido.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct ColaPendiente {
    /// Segmentos en disco (los `.jsonl` y el que se está escribiendo).
    pub segmentos: u32,
    pub bytes: u64,
    /// Cuándo se escribió el más antiguo: desde entonces no sale nada.
    pub mas_antiguo_ms: Option<i64>,
}

/// Mira la carpeta de la cola sin abrir ningún segmento.
pub fn cola_pendiente_en(dir: &Path) -> io::Result<ColaPendiente> {
    let mut cola = ColaPendiente::default();
    let entradas = match fs::read_dir(dir) {
        Ok(e) => e,
        // Nunca se ha escrito nada: no hay cola.
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(cola),
        Err(e) => return Err(e),
    };
    for entrada in entradas {
        let entrada = entrada?;
        let nombre = entrada.file_name().to_string_lossy().into_owned();
        if !(nombre.ends_with(".jsonl") || nombre.ends_with(".jsonl.tmp")) {
            continue;
        }
        let meta = entrada.metadata()?;
        cola.segmentos += 1;
        cola.bytes += meta.len();
        let escrito = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64);
        if let Some(ms) = escrito {
            cola.mas_antiguo_ms = Some(cola.mas_antiguo_ms.map_or(ms, |m| m.min(ms)));
        }
    }
    Ok(cola)
}

/// El usuario del sistema en una ruta de carpeta personal: `C:\Users\<usuario>` (también con las
/// barras dobles de un texto escapado o con `/`), `/home/<usuario>` y `/Users/<usuario>`.
///
/// El nombre puede llevar espacios («Ana Pérez»): se tapa hasta la barra siguiente, o hasta una
/// comilla, un separador o el final de la línea. Si la ruta acaba ahí, se tapa de más, nunca de menos.
fn rutas_de_usuario() -> &'static [Regex; 2] {
    static RE: OnceLock<[Regex; 2]> = OnceLock::new();
    RE.get_or_init(|| {
        [
            Regex::new(r#"((?i-u:[a-z]):(?:\\\\|\\|/)(?i-u:users)(?:\\\\|\\|/))[^\\/"':;,<>|\r\n\t]+"#).unwrap(),
            Regex::new(r#"(/(?:home|Users)/)[^/"':;,<>|\r\n\t]+"#).unwrap(),
        ]
    })
}

fn tapar_rutas(texto: &str) -> Cow<'_, str> {
    let mut out = Cow::Borrowed(texto);
    for re in rutas_de_usuario() {
        if let Cow::Owned(nuevo) = re.replace_all(&out, "${1}[usuario]") {
            out = Cow::Owned(nuevo);
        }
    }
    out
}

/// Un texto, por el filtro de datos personales y sin el usuario de las rutas.
pub fn filtrar_texto(texto: &str) -> Cow<'_, str> {
    match crate::scrub::scrub(texto) {
        Cow::Borrowed(b) => tapar_rutas(b),
        Cow::Owned(o) => Cow::Owned(tapar_rutas(&o).into_owned()),
    }
}

/// Todo lo que entra en el paquete pasa por aquí: el filtro de datos personales que se aplica a lo
/// que sale a Axiom y a Sentry (también las claves de secretos, `token`, `pin`…) y sin el usuario de
/// las rutas.
pub fn filtrar_para_soporte(valor: &mut Value) {
    crate::scrub::scrub_value(valor);
    tapar_rutas_en(valor);
}

fn tapar_rutas_en(valor: &mut Value) {
    match valor {
        Value::String(s) => {
            if let Cow::Owned(nuevo) = tapar_rutas(s) {
                *s = nuevo;
            }
        }
        Value::Array(v) => v.iter_mut().for_each(tapar_rutas_en),
        Value::Object(m) => m.values_mut().for_each(tapar_rutas_en),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn carpeta(nombre: &str) -> PathBuf {
        // Bajo `tpv_tests`, que los tests de la base purgan pasada una hora.
        let dir = std::env::temp_dir().join("tpv_tests").join(format!("telemetria_diagnostico_{nombre}_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn el_registro_sale_como_sale_a_axiom() {
        let dir = carpeta("registro");
        fs::write(
            dir.join("tpv.2026-11-19.log"),
            "2026-11-19T22:00:00.000000Z  INFO tpv::startup: arranque viejo\n",
        )
        .unwrap();
        fs::write(
            dir.join("tpv.2026-11-20.log"),
            concat!(
                "2026-11-20T10:00:00.000000Z  INFO tpv::sync: conectado\n",
                "2026-11-20T10:00:01.000000Z DEBUG tpv::sync: args={\"Nombre\":\"Remedios\"}\n",
                "  segunda línea del depurado con Remedios\n",
                "2026-11-20T10:00:02.000000Z  WARN tpv::comandos: falló al llamar al 612 345 678 o a remedios@example.com\n",
                "2026-11-20T10:00:03.000000Z ERROR tpv::x: no se pudo abrir C:\\Users\\Remedios\\AppData\\Roaming\\data.db con token=abc123secreto\n",
                "  sigue el error\n",
            ),
        )
        .unwrap();
        fs::write(dir.join("otra-cosa.txt"), "Remedios").unwrap();

        let r = registro_reciente_en(&dir, 1024 * 1024, 1000).unwrap();
        assert_eq!(r.ficheros, vec!["tpv.2026-11-19.log", "tpv.2026-11-20.log"]);
        assert!(!r.recortado);
        let todo = r.lineas.join("\n");
        assert!(todo.contains("arranque viejo") && todo.contains("conectado") && todo.contains("sigue el error"), "{todo}");
        // Lo de depuración no sale: tampoco su continuación.
        assert!(!todo.contains("Remedios"), "{todo}");
        for dato in ["612 345 678", "remedios@example.com", "abc123secreto"] {
            assert!(!todo.contains(dato), "{dato} en {todo}");
        }
        assert!(todo.contains(r"C:\Users\[usuario]\AppData"), "{todo}");
        // De lo más viejo a lo más nuevo.
        assert!(r.lineas[0].contains("arranque viejo"));
    }

    #[test]
    fn el_registro_tiene_techo_y_lo_dice() {
        let dir = carpeta("techo");
        let mut texto = String::new();
        for i in 0..500 {
            texto.push_str(&format!("2026-11-20T10:00:00.000000Z  INFO tpv::x: linea {i:04}\n"));
        }
        texto.push_str(&format!("2026-11-20T10:00:00.000000Z  INFO tpv::x: {}\n", "z".repeat(10_000)));
        fs::write(dir.join("tpv.2026-11-20.log"), &texto).unwrap();

        let por_lineas = registro_reciente_en(&dir, 1024 * 1024, 100).unwrap();
        assert!(por_lineas.recortado);
        assert_eq!(por_lineas.lineas.len(), 100);
        assert!(por_lineas.lineas.last().unwrap().ends_with(MARCA_RECORTE));
        assert!(por_lineas.lineas.last().unwrap().len() <= TOPE_LINEA + MARCA_RECORTE.len());

        let por_bytes = registro_reciente_en(&dir, 20 * 1024, 10_000).unwrap();
        assert!(por_bytes.recortado);
        // Lo último está; lo primero, no; y ninguna línea empieza a medias.
        assert!(por_bytes.lineas.iter().any(|l| l.contains("linea 0499")));
        assert!(!por_bytes.lineas.iter().any(|l| l.contains("linea 0000")));
        assert!(por_bytes.lineas.iter().all(|l| l.starts_with("2026-")));
    }

    #[test]
    fn la_cola_se_cuenta_sin_abrirla() {
        let dir = carpeta("cola");
        assert_eq!(cola_pendiente_en(&dir.join("no-existe")).unwrap(), ColaPendiente::default());
        fs::write(dir.join("a.jsonl"), "x".repeat(10)).unwrap();
        fs::write(dir.join("b.jsonl.tmp"), "y".repeat(5)).unwrap();
        fs::write(dir.join("a.jsonl.ack"), [0u8; 8]).unwrap();
        let c = cola_pendiente_en(&dir).unwrap();
        assert_eq!((c.segmentos, c.bytes), (2, 15));
        assert!(c.mas_antiguo_ms.is_some());
    }

    #[test]
    fn el_filtro_tapa_lo_personal_las_claves_y_el_usuario_de_las_rutas() {
        let mut v = json!({
            "token": "eyJ-lo-que-sea",
            "pin": "9876",
            "detalle": "escribe a ana@example.com desde C:\\\\Users\\\\Ana Pérez\\\\Desktop o /home/ana/tpv",
            "lista": ["/Users/ana/Library", "D:/users/ana/x"],
            "tenant_id": "0193a0b0-0000-7000-8000-000000000001",
            "outbox_pending": 612345678,
        });
        filtrar_para_soporte(&mut v);
        let texto = v.to_string();
        for dato in ["eyJ-lo-que-sea", "9876", "ana@example.com", "Ana Pérez", "/home/ana", "/Users/ana", "users/ana"] {
            assert!(!texto.contains(dato), "{dato} en {texto}");
        }
        assert_eq!(v["tenant_id"], "0193a0b0-0000-7000-8000-000000000001");
        assert_eq!(v["outbox_pending"], 612345678);
        // Dos veces da lo mismo.
        let una = v.clone();
        filtrar_para_soporte(&mut v);
        assert_eq!(v, una);
    }
}
