//! OPS-02 · El **paquete de diagnóstico** para soporte: qué partes lleva y de dónde sale cada una.
//!
//! Las reglas que cubren a todas (ninguna parte lo tumba, todo pasa por el filtro de datos
//! personales, tamaño acotado) son del caso de uso `tpv_application::use_cases::diagnostico`. Qué es
//! seguro sacar y por qué: docs/arquitectura/observabilidad.md («El paquete de diagnóstico»).
//!
//! Lo que se lee aquí es lo mismo que ya enseñan Configuración → Conectividad y Licencia, o que ya
//! sale a Axiom: ninguna tabla de negocio, ningún secreto del almacén, ningún `motivo` de los
//! interruptores (texto libre de soporte que no sale del equipo).

use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use tpv_application::error::AppResult;
use tpv_application::ports::diagnostico::FiltroDeDatosPersonales;
use tpv_application::use_cases::diagnostico::{self as uc, Seccion};
use tpv_application::use_cases::licensing as uc_licencia;
use tpv_application::use_cases::pairing as uc_pairing;
use tpv_application::use_cases::sync as uc_sync;
use tpv_contracts::diagnostico::PaqueteDiagnostico;
use tpv_infra_licensing::{LicensingAdapter, PairingAdapter};
use tpv_infra_sqlite::db::Db;
use tpv_infra_sqlite::diagnostico::SqliteDiagnosticoDeLaBase;
use tpv_infra_sqlite::sync::SqliteSyncRepository;
use tpv_telemetry::diagnostico as telemetria;

use crate::{AppState, DeviceMode};

/// Lo que se lee del final del registro: lo que cabe en un correo y alcanza para ver lo de las
/// últimas horas.
const BYTES_DEL_REGISTRO: usize = 1024 * 1024;
const LINEAS_DEL_REGISTRO: usize = 4000;
/// El registro, ya en JSON (con sus comillas y escapes), cabe en esto.
const TOPE_DEL_REGISTRO: usize = 1536 * 1024;

const SIN_BASE: &str = "La base de este equipo no está abierta.";
const SIN_TELEMETRIA: &str = "El registro no llegó a arrancar en este equipo: no hay nada que leer.";
const SIN_APPDATA: &str = "No se encuentra la carpeta de datos de la aplicación.";

/// El filtro de `tpv-telemetry`, el mismo que pasa lo que sale a Axiom y a Sentry.
pub(crate) struct FiltroDeSoporte;

impl FiltroDeDatosPersonales for FiltroDeSoporte {
    fn filtrar(&self, valor: &mut Value) {
        telemetria::filtrar_para_soporte(valor);
    }
}

/// Compone el paquete de este equipo. Nunca falla: lo que no se puede leer va dentro, explicado.
pub(crate) async fn generar(app: &AppHandle) -> PaqueteDiagnostico {
    let state = app.state::<AppState>();
    let modo = *state.mode.lock().await;
    let db = state.db.lock().await.as_ref().cloned();
    let app_data_dir = app.path().app_data_dir().ok();

    let mut secciones = vec![
        Seccion::nueva("aplicacion", async { Ok::<_, String>(aplicacion(app)) }),
        Seccion::nueva("equipo", {
            let dir = app_data_dir.clone();
            async move { Ok::<_, String>(equipo(modo, dir)) }
        }),
        Seccion::nueva("identidad", {
            let dir = app_data_dir.clone();
            async move { identidad(modo, dir) }
        }),
        Seccion::nueva("licencia", {
            let dir = app_data_dir.clone();
            async move {
                let dir = dir.ok_or(SIN_APPDATA)?;
                uc_licencia::get_state(&LicensingAdapter::new(dir)).map_err(|e| e.to_string())
            }
        }),
        Seccion::nueva("interruptores", async {
            // Cuál y hasta cuándo; el motivo es texto libre de soporte y no sale del equipo.
            let apagados: Vec<Value> = crate::interruptores::vigentes(app)
                .into_iter()
                .map(|i| json!({ "interruptor": i.interruptor, "hasta_ms": i.hasta_ms }))
                .collect();
            Ok::<_, String>(apagados)
        }),
        Seccion::nueva("tareas_de_fondo", crate::jobs::estado_actual(app)),
    ];
    // La Handy trabaja contra la nube: no tiene base, réplica ni copias.
    if modo != Some(DeviceMode::Handy) {
        secciones.push(Seccion::nueva("motor_de_replicacion", async {
            app.try_state::<crate::replicacion::SyncNativo>()
                .map(|s| s.estado())
                .ok_or("El motor de réplica no ha arrancado.")
        }));
        secciones.extend(secciones_de_la_base(db, app_data_dir));
    }
    secciones.extend(secciones_de_la_telemetria(telemetria::carpetas()));

    uc::generar(chrono::Utc::now().timestamp_millis(), secciones, &FiltroDeSoporte, uc::ESPERA_POR_SECCION)
        .await
}

fn aplicacion(app: &AppHandle) -> Value {
    let identificador = app.config().identifier.clone();
    json!({
        "version": app.package_info().version.to_string(),
        "variante": env!("TPV_BUILD_VARIANT"),
        "release": env!("TPV_SENTRY_RELEASE"),
        "commit": option_env!("TPV_BUILD_COMMIT"),
        "entorno": crate::entorno_de_sentry(&identificador, cfg!(debug_assertions)),
        "identificador": identificador,
        "sistema": std::env::consts::OS,
        "arquitectura": std::env::consts::ARCH,
        "webview": tauri::webview_version().ok(),
    })
}

fn equipo(modo: Option<DeviceMode>, dir: Option<PathBuf>) -> Value {
    let cfg = dir.map(|d| crate::load_config(&d)).unwrap_or_default();
    // De las impresoras, sólo qué destinos tienen una: su nombre lo pone quien la instala.
    let mut impresoras: Vec<&str> = cfg.printers.keys().map(String::as_str).collect();
    if cfg.printer_name.is_some() && !impresoras.contains(&"caja") {
        impresoras.push("caja");
    }
    impresoras.sort_unstable();
    json!({
        "modo": match modo {
            Some(DeviceMode::Tpv) => "main",
            Some(DeviceMode::Handy) => "handy",
            None => "sin_elegir",
        },
        "conectividad": cfg.connectivity,
        "impresoras_configuradas": impresoras,
        "zoom": cfg.zoom,
    })
}

/// El negocio y el equipo, por sus identificadores: los que lleva cada evento de Axiom y de Sentry,
/// con los que soporte encuentra lo demás. No son de una persona.
fn identidad(modo: Option<DeviceMode>, dir: Option<PathBuf>) -> AppResult<Value> {
    let dir = dir.ok_or_else(|| tpv_application::error::AppError::internal(SIN_APPDATA))?;
    let pairing = PairingAdapter::new(dir.clone());
    let dispositivo = uc_pairing::device_identity(&pairing).map(|d| d.device_id);
    let negocio = match modo {
        Some(DeviceMode::Handy) => uc_pairing::handy_get_tenant(&pairing),
        _ => uc_licencia::get_state(&LicensingAdapter::new(dir)).map(|s| s.map(|s| s.tenant_id)),
    };
    Ok(json!({
        "device_id": dispositivo.unwrap_or_else(|e| format!("(no se ha podido leer: {e})")),
        "tenant_id": negocio.unwrap_or_else(|e| Some(format!("(no se ha podido leer: {e})"))),
    }))
}

/// Una parte que necesita la base local.
fn con_base<T, F, Fut>(nombre: &'static str, db: &Option<Arc<Db>>, leer: F) -> Seccion<'static>
where
    T: Serialize + 'static,
    F: FnOnce(Arc<Db>) -> Fut,
    Fut: std::future::Future<Output = AppResult<T>> + Send + 'static,
{
    match db.clone() {
        Some(db) => Seccion::nueva(nombre, leer(db)),
        None => Seccion::nueva(nombre, async { Err::<T, _>(SIN_BASE) }),
    }
}

/// Lo de la Main: la recuperación, la réplica, el histórico, la base y las copias. Ninguna lee
/// una fila de negocio: cuentan.
pub(crate) fn secciones_de_la_base(db: Option<Arc<Db>>, app_data_dir: Option<PathBuf>) -> Vec<Seccion<'static>> {
    vec![
        con_base("recuperacion", &db, |db| async move { tpv_infra_sqlite::recovery::status(&db).await }),
        con_base("replicacion", &db, |db| async move { uc_sync::health(&SqliteSyncRepository::new(db)).await }),
        con_base("historico", &db, |db| async move {
            uc_sync::backfill_estado(&SqliteSyncRepository::new(db)).await
        }),
        con_base("base_local", &db, |db| async move {
            uc::estado_de_la_base(&SqliteDiagnosticoDeLaBase::new(db)).await
        }),
        Seccion::nueva("copias_locales", async move {
            let dir = app_data_dir.ok_or(SIN_APPDATA)?;
            let copias = tpv_infra_sqlite::recovery::list_backups(&dir).map_err(|e| e.to_string())?;
            Ok::<_, String>(
                copias
                    .into_iter()
                    .map(|c| json!({ "creada_ms": c.created_at_ms, "bytes": c.size_bytes, "importada": c.importada }))
                    .collect::<Vec<_>>(),
            )
        }),
    ]
}

/// El final del registro local y lo que espera en la cola hacia Axiom: lo que no ha salido.
pub(crate) fn secciones_de_la_telemetria(carpetas: Option<telemetria::Carpetas>) -> Vec<Seccion<'static>> {
    let cola = carpetas.as_ref().map(|c| c.cola.clone());
    let registro = carpetas.map(|c| c.registro);
    vec![
        Seccion::nueva("cola_de_telemetria", async move {
            telemetria::cola_pendiente_en(&cola.ok_or(SIN_TELEMETRIA)?).map_err(|e| e.to_string())
        }),
        Seccion::nueva("registro", async move {
            let dir = registro.ok_or(SIN_TELEMETRIA)?;
            // Leer un MiB del disco no tiene por qué ocupar un hilo del runtime.
            tokio::task::spawn_blocking(move || {
                telemetria::registro_reciente_en(&dir, BYTES_DEL_REGISTRO, LINEAS_DEL_REGISTRO).map_err(|e| e.to_string())
            })
            .await
            .map_err(|e| e.to_string())?
        })
        .con_tope(TOPE_DEL_REGISTRO),
    ]
}

#[cfg(test)]
mod tests {
    //! Lo que importa del paquete: que lo que hay en la base y en el registro de un equipo de verdad
    //! no salga en él. Se monta una Main con datos personales por todas partes (clientes, personal,
    //! el outbox, el error de un job, el registro) y se busca cada dato en el fichero.

    use super::*;
    use tpv_infra_sqlite::db::Writer;
    use tpv_infra_sqlite::ejecutor::Value as Sql;

    const NOMBRE: &str = "Remedios Cifuentes";
    const TELEFONO: &str = "612 345 678";
    const CORREO: &str = "remedios.cifuentes@example.com";
    const NOTA: &str = "Alérgica al marisco";
    const DNI: &str = "12345678Z";
    const USUARIO_WINDOWS: &str = "Remedios";

    fn carpeta(nombre: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join("tpv_tests")
            .join(format!("diagnostico_{nombre}_{}_{}", std::process::id(), chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    async fn main_con_datos_personales(dir: &std::path::Path) -> Arc<Db> {
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        let w = db.write().await;
        // Por el camino de una escritura de negocio: queda también en el outbox, con sus valores.
        w.execute(
            "INSERT INTO Clientes (ID_Cliente, Nombre, Telefono, Email, Notas, NIF) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            vec![
                Sql::Text("0193a0b0-0000-7000-8000-000000000001".into()),
                Sql::Text(NOMBRE.into()),
                Sql::Text(TELEFONO.into()),
                Sql::Text(CORREO.into()),
                Sql::Text(NOTA.into()),
                Sql::Text(DNI.into()),
            ],
        )
        .await
        .unwrap();
        // El error de un job, como lo guardaría el motor si alguien lo compusiera mal.
        w.raw()
            .execute(
                "INSERT INTO _Jobs_State (Nombre, Last_Run_Ms, Last_Ok_Ms, Last_Error, Fallos) VALUES ('copia', 1, NULL, ?1, 3)",
                vec![Sql::Text(format!("no se pudo avisar a {CORREO} ({TELEFONO})"))],
            )
            .await
            .unwrap();
        drop(w);
        db
    }

    fn registro_con_datos_personales(dir: &std::path::Path) {
        std::fs::write(
            dir.join("tpv.2026-11-20.log"),
            format!(
                "2026-11-20T10:00:00.000000Z  INFO tpv::startup: arranque\n\
                 2026-11-20T10:00:01.000000Z DEBUG tpv::sql: args=[\"{NOMBRE}\", \"{NOTA}\"]\n\
                 2026-11-20T10:00:02.000000Z  WARN tpv::comandos: clientes_upsert falló: {CORREO} {TELEFONO} DNI {DNI}\n\
                 2026-11-20T10:00:03.000000Z ERROR tpv::x: C:\\Users\\{USUARIO_WINDOWS}\\AppData\\Roaming\\data.db token=eyJhbGciOi.zarzamora.firma\n"
            ),
        )
        .unwrap();
    }

    #[tokio::test]
    async fn el_paquete_de_una_main_no_lleva_datos_personales() {
        let dir = carpeta("main");
        let db = main_con_datos_personales(&dir).await;
        let logs = dir.join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        registro_con_datos_personales(&logs);
        let carpetas = telemetria::Carpetas { registro: logs, cola: dir.join("telemetry-spool") };

        let mut secciones = secciones_de_la_base(Some(db.clone()), Some(dir.clone()));
        // Lo que guarda `_Jobs_State`, como lo lee `jobs::estado_actual` (que necesita la app entera).
        secciones.push(Seccion::nueva("tareas_de_fondo", async move {
            let repo = tpv_infra_sqlite::jobs::SqliteJobsStateRepository::new(db);
            let estados = tpv_application::use_cases::jobs::listar(&repo).await?;
            Ok::<_, tpv_application::error::AppError>(
                estados.into_iter().map(|(n, e)| json!({ "nombre": n, "last_error": e.last_error })).collect::<Vec<_>>(),
            )
        }));
        secciones.extend(secciones_de_la_telemetria(Some(carpetas)));
        let p = uc::generar(1_763_632_800_000, secciones, &FiltroDeSoporte, uc::ESPERA_POR_SECCION).await;

        for dato in [NOMBRE, "Cifuentes", TELEFONO, "612345678", CORREO, NOTA, "marisco", DNI, USUARIO_WINDOWS, "eyJhbGciOi", "zarzamora"] {
            assert!(!p.contenido.contains(dato), "«{dato}» ha salido en el paquete:\n{}", p.contenido);
        }
        assert!(p.secciones_con_error.is_empty(), "{:?}\n{}", p.secciones_con_error, p.contenido);

        // Y lleva lo que soporte necesita.
        let v: Value = serde_json::from_str(&p.contenido).unwrap();
        let seccion = |n: &str| v["secciones"].as_array().unwrap().iter().find(|s| s["nombre"] == n).unwrap()["datos"].clone();
        assert_eq!(seccion("replicacion")["outbox_pending"], 1);
        assert_eq!(seccion("base_local")["integridad"], json!(["ok"]));
        // Sin usuarios, la base cuenta como sin datos: lo que importa es que el estado esté.
        assert_eq!(seccion("recuperacion")["state"], "data_missing");
        let registro = seccion("registro")["lineas"].as_array().unwrap().len();
        assert_eq!(registro, 3, "sin la línea de depuración");
    }

    #[tokio::test]
    async fn sin_base_ni_registro_el_paquete_sale_igual_y_dice_por_que() {
        let mut secciones = secciones_de_la_base(None, None);
        secciones.extend(secciones_de_la_telemetria(None));
        let p = uc::generar(0, secciones, &FiltroDeSoporte, uc::ESPERA_POR_SECCION).await;
        assert_eq!(
            p.secciones_con_error,
            vec!["recuperacion", "replicacion", "historico", "base_local", "copias_locales", "cola_de_telemetria", "registro"]
        );
        assert!(p.contenido.contains(SIN_BASE) && p.contenido.contains(SIN_TELEMETRIA));
    }
}
