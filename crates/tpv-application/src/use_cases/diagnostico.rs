//! OPS-02 · El **paquete de diagnóstico** para soporte.
//!
//! Cuando el bar no tiene internet y la telemetría no ha salido, lo que soporte necesita saber del
//! equipo sale en un fichero. El shell decide qué partes lleva y de dónde sale cada una
//! (`apps/tpv-main/src-tauri/src/diagnostico.rs`); aquí están las reglas que las cubren a todas:
//!
//! - **Ninguna parte tumba el paquete.** Cada una se lee por su cuenta: si falla, tarda más de la
//!   cuenta o incluso entra en pánico, el paquete sale igual y esa parte dice dentro por qué no
//!   está. Para eso se ha pedido: para cuando algo va mal.
//! - **Todo pasa por el filtro de datos personales**, los datos y el texto de los errores, después
//!   de leerlo y antes de medirlo.
//! - **Tamaño acotado**: cada parte tiene su techo, y el paquete entero el suyo. Lo que no cabe se
//!   quita entero y se dice; recortar un JSON a medias no lo dejaría leer.

use std::fmt::Display;
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tpv_contracts::diagnostico::PaqueteDiagnostico;

use crate::error::AppResult;
use crate::ports::diagnostico::{DiagnosticoDeLaBase, EstadoDeLaBase, FiltroDeDatosPersonales};

/// Qué es el fichero y en qué versión de su forma. Cambia si cambia la forma, no si se añade una
/// sección.
pub const FORMATO: &str = "tpv-diagnostico/1";

/// Lo que cabe en una parte si no se le dice otra cosa.
pub const TOPE_SECCION: usize = 64 * 1024;

/// Lo que cabe en el paquete entero: que se pueda mandar por correo sin pensarlo.
pub const TOPE_PAQUETE: usize = 2 * 1024 * 1024;

/// Lo que se espera a cada parte. La más lenta es la comprobación de integridad de la base, que
/// recorre el fichero entero.
pub const ESPERA_POR_SECCION: Duration = Duration::from_secs(30);

/// Lo que dice el paquete de sí mismo, para quien lo abra antes de mandarlo.
const NOTA: &str = "Diagnóstico de este equipo para soporte. No lleva datos de clientes, \
personal ni ventas, ni claves o contraseñas: lo que pudiera parecerse a un dato personal o a un \
secreto se ha tapado.";

type Lectura<'a> = Pin<Box<dyn Future<Output = Result<Value, String>> + Send + 'a>>;

/// Una parte del paquete: su nombre y cómo se lee.
pub struct Seccion<'a> {
    nombre: &'static str,
    tope: usize,
    lectura: Lectura<'a>,
}

impl<'a> Seccion<'a> {
    /// Una parte que se lee con `lectura`. Lo que devuelva se guarda como JSON; su error, como texto.
    pub fn nueva<T, E, F>(nombre: &'static str, lectura: F) -> Self
    where
        T: Serialize,
        E: Display,
        F: Future<Output = Result<T, E>> + Send + 'a,
    {
        Self {
            nombre,
            tope: TOPE_SECCION,
            lectura: Box::pin(async move {
                let datos = lectura.await.map_err(|e| e.to_string())?;
                serde_json::to_value(datos).map_err(|e| format!("No se ha podido escribir: {e}"))
            }),
        }
    }

    /// Otro techo para esta parte (el registro de la aplicación es la grande).
    pub fn con_tope(mut self, tope: usize) -> Self {
        self.tope = tope;
        self
    }
}

/// Lo que se cuenta de la base local (sólo la Main).
pub async fn estado_de_la_base(repo: &dyn DiagnosticoDeLaBase) -> AppResult<EstadoDeLaBase> {
    repo.estado().await
}

/// Una lectura que, si entra en pánico, termina con un error en vez de llevarse el paquete.
struct SinPanico<'a>(Lectura<'a>);

impl Future for SinPanico<'_> {
    type Output = Result<Value, String>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let lectura = &mut self.0;
        match std::panic::catch_unwind(AssertUnwindSafe(|| lectura.as_mut().poll(cx))) {
            Ok(p) => p,
            Err(_) => Poll::Ready(Err("Se ha interrumpido al leerla (un fallo del programa).".to_string())),
        }
    }
}

fn tamano(valor: &Value) -> usize {
    serde_json::to_vec(valor).map_or(usize::MAX, |v| v.len())
}

fn kib(bytes: usize) -> usize {
    bytes.div_ceil(1024)
}

/// Lee cada parte, la filtra y la acota, y compone el paquete. Nunca falla.
///
/// `generado_ms` es la hora de quien lo pide (0004): va dentro y en el nombre del fichero.
pub async fn generar(
    generado_ms: i64,
    secciones: Vec<Seccion<'_>>,
    filtro: &dyn FiltroDeDatosPersonales,
    espera: Duration,
) -> PaqueteDiagnostico {
    let mut leidas: Vec<(&'static str, Result<Value, String>)> = Vec::with_capacity(secciones.len());
    for seccion in secciones {
        let leida = match tokio::time::timeout(espera, SinPanico(seccion.lectura)).await {
            Ok(leida) => leida,
            Err(_) => Err(format!("No ha contestado en {} s y se ha dejado sin leer.", espera.as_secs())),
        };
        let leida = leida.and_then(|mut datos| {
            filtro.filtrar(&mut datos);
            let bytes = tamano(&datos);
            if bytes > seccion.tope {
                Err(format!(
                    "Ocupaba {} KiB, más de los {} KiB que caben: se ha quitado.",
                    kib(bytes),
                    kib(seccion.tope)
                ))
            } else {
                Ok(datos)
            }
        });
        leidas.push((seccion.nombre, leida.map_err(|e| filtrar_texto(filtro, e))));
    }

    // El techo del paquete: se quita la parte más grande hasta que quepa.
    loop {
        let total: usize = leidas.iter().map(|(_, l)| l.as_ref().map_or(0, tamano)).sum();
        if total <= TOPE_PAQUETE {
            break;
        }
        let mayor = leidas
            .iter_mut()
            .filter(|(_, l)| l.is_ok())
            .max_by_key(|(_, l)| l.as_ref().map_or(0, tamano));
        let Some((_, leida)) = mayor else { break };
        *leida = Err(format!(
            "El paquete pasaba de {} KiB: se ha quitado esta parte, que era la mayor.",
            kib(TOPE_PAQUETE)
        ));
    }

    let secciones_con_error = leidas
        .iter()
        .filter(|(_, l)| l.is_err())
        .map(|(n, _)| (*n).to_string())
        .collect();
    let partes: Vec<Value> = leidas
        .into_iter()
        .map(|(nombre, leida)| match leida {
            Ok(datos) => json!({ "nombre": nombre, "datos": datos }),
            Err(error) => json!({ "nombre": nombre, "error": error }),
        })
        .collect();
    let paquete = json!({
        "formato": FORMATO,
        "generado_ms": generado_ms,
        "nota": NOTA,
        "secciones": partes,
    });

    PaqueteDiagnostico {
        nombre_fichero: nombre_fichero(generado_ms),
        // Serializar un `Value` sólo falla con claves que no son texto, y aquí no las hay.
        contenido: serde_json::to_string_pretty(&paquete).unwrap_or_default(),
        secciones_con_error,
    }
}

fn filtrar_texto(filtro: &dyn FiltroDeDatosPersonales, texto: String) -> String {
    let mut valor = Value::String(texto);
    filtro.filtrar(&mut valor);
    match valor {
        Value::String(s) => s,
        otro => otro.to_string(),
    }
}

/// `diagnostico-tpv-20261120-103005.json`, en la hora del equipo: es la que ve quien lo guarda.
fn nombre_fichero(generado_ms: i64) -> String {
    let cuando = chrono::DateTime::from_timestamp_millis(generado_ms)
        .map(|d| d.with_timezone(&chrono::Local).format("%Y%m%d-%H%M%S").to_string())
        .unwrap_or_else(|| generado_ms.to_string());
    format!("diagnostico-tpv-{cuando}.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Un filtro de prueba que tapa una palabra: basta para ver que pasa por todo.
    struct TapaZarzamora;
    impl FiltroDeDatosPersonales for TapaZarzamora {
        fn filtrar(&self, valor: &mut Value) {
            match valor {
                Value::String(s) => *s = s.replace("zarzamora", "[tapado]"),
                Value::Array(v) => v.iter_mut().for_each(|x| self.filtrar(x)),
                Value::Object(m) => m.values_mut().for_each(|x| self.filtrar(x)),
                _ => {}
            }
        }
    }

    fn explota() -> Result<Value, String> {
        panic!("a propósito")
    }

    fn leer(p: &PaqueteDiagnostico) -> Value {
        serde_json::from_str(&p.contenido).expect("el paquete es JSON")
    }

    fn seccion<'a>(p: &'a Value, nombre: &str) -> &'a Value {
        p["secciones"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["nombre"] == nombre)
            .unwrap_or_else(|| panic!("falta la sección {nombre}"))
    }

    #[tokio::test]
    async fn una_parte_que_falla_no_tumba_las_demas() {
        let p = generar(
            1_700_000_000_000,
            vec![
                Seccion::nueva("antes", async { Ok::<_, String>(json!({ "n": 1 })) }),
                Seccion::nueva("rota", async { Err::<Value, _>("la base no está abierta") }),
                Seccion::nueva("panico", async { explota() }),
                Seccion::nueva("despues", async { Ok::<_, String>(vec!["x", "y"]) }),
            ],
            &TapaZarzamora,
            ESPERA_POR_SECCION,
        )
        .await;
        let v = leer(&p);
        assert_eq!(v["formato"], FORMATO);
        assert_eq!(v["generado_ms"], 1_700_000_000_000_i64);
        assert_eq!(seccion(&v, "antes")["datos"]["n"], 1);
        assert_eq!(seccion(&v, "rota")["error"], "la base no está abierta");
        assert!(seccion(&v, "panico")["error"].as_str().unwrap().contains("interrumpido"));
        assert_eq!(seccion(&v, "despues")["datos"], json!(["x", "y"]));
        assert_eq!(p.secciones_con_error, vec!["rota", "panico"]);
        // En el orden en que se pidieron.
        let nombres: Vec<_> = v["secciones"].as_array().unwrap().iter().map(|s| s["nombre"].clone()).collect();
        assert_eq!(nombres, vec!["antes", "rota", "panico", "despues"]);
    }

    #[tokio::test(start_paused = true)]
    async fn una_parte_que_no_contesta_se_deja_sin_leer() {
        let p = generar(
            0,
            vec![
                Seccion::nueva("colgada", async {
                    tokio::time::sleep(Duration::from_secs(3600)).await;
                    Ok::<_, String>(1)
                }),
                Seccion::nueva("viva", async { Ok::<_, String>(2) }),
            ],
            &TapaZarzamora,
            Duration::from_secs(5),
        )
        .await;
        let v = leer(&p);
        assert!(seccion(&v, "colgada")["error"].as_str().unwrap().contains("5 s"));
        assert_eq!(seccion(&v, "viva")["datos"], 2);
    }

    #[tokio::test]
    async fn todo_pasa_por_el_filtro_tambien_los_errores() {
        let p = generar(
            0,
            vec![
                Seccion::nueva("datos", async { Ok::<_, String>(json!({ "a": ["una zarzamora"] })) }),
                Seccion::nueva("error", async { Err::<Value, _>("falló con la zarzamora dentro") }),
            ],
            &TapaZarzamora,
            ESPERA_POR_SECCION,
        )
        .await;
        assert!(!p.contenido.contains("zarzamora"), "{}", p.contenido);
        let v = leer(&p);
        assert_eq!(seccion(&v, "datos")["datos"]["a"][0], "una [tapado]");
        assert_eq!(seccion(&v, "error")["error"], "falló con la [tapado] dentro");
    }

    #[tokio::test]
    async fn lo_que_no_cabe_se_quita_entero_y_se_dice() {
        let grande = "x".repeat(TOPE_SECCION + 1);
        let mediana = "y".repeat(TOPE_PAQUETE / 2 + 10);
        let p = generar(
            0,
            vec![
                Seccion::nueva("grande", { let g = grande.clone(); async move { Ok::<_, String>(g) } }),
                Seccion::nueva("con_su_tope", { let g = grande.clone(); async move { Ok::<_, String>(g) } })
                    .con_tope(TOPE_PAQUETE),
                Seccion::nueva("mediana_1", { let m = mediana.clone(); async move { Ok::<_, String>(m) } })
                    .con_tope(TOPE_PAQUETE),
                Seccion::nueva("mediana_2", { let m = mediana.clone(); async move { Ok::<_, String>(m) } })
                    .con_tope(TOPE_PAQUETE),
            ],
            &TapaZarzamora,
            ESPERA_POR_SECCION,
        )
        .await;
        let v = leer(&p);
        assert!(seccion(&v, "grande")["error"].as_str().unwrap().contains("se ha quitado"));
        assert_eq!(seccion(&v, "con_su_tope")["datos"].as_str().unwrap().len(), grande.len());
        // Las dos medianas no caben juntas: se quita una, y el paquete entra en su techo.
        let quitadas = ["mediana_1", "mediana_2"].iter().filter(|n| seccion(&v, n).get("error").is_some()).count();
        assert_eq!(quitadas, 1);
        assert!(p.contenido.len() <= TOPE_PAQUETE + 4096, "{}", p.contenido.len());
    }

    #[test]
    fn el_fichero_se_llama_por_su_fecha() {
        let n = nombre_fichero(1_700_000_000_000);
        assert!(n.starts_with("diagnostico-tpv-2023111"), "{n}");
        assert!(n.ends_with(".json"));
    }
}
