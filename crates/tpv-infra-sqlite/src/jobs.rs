//! Adaptador SQLite del puerto `JobsStateRepository`: el estado de los jobs periódicos.
//!
//! `_Jobs_State` es una tabla de control **local del dispositivo** (como las `_Sync_*`): la crea
//! `Db::open` y NO forma parte del esquema compartido con la nube. Cada equipo lleva su propio
//! ritmo de ejecución, así que replicarla no significaría nada.
//!
//! Por eso todas las escrituras van por la conexión CRUDA (`WriteGuard::raw()`): un `execute()`
//! normal se capturaría en `_Sync_Outbox` y cada tick de cada job generaría tráfico de
//! sincronización hacia la nube.

use std::sync::Arc;

use async_trait::async_trait;
use libsql::Value;

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::jobs::{EstadoJob, JobsStateRepository};

use crate::db::Db;
use crate::mapping::{v_i64, v_string};

pub struct SqliteJobsStateRepository {
    db: Arc<Db>,
}

impl SqliteJobsStateRepository {
    pub fn new(db: Arc<Db>) -> Self {
        Self { db }
    }
}

fn db_err(e: impl std::fmt::Display) -> AppError {
    AppError::repository(e.to_string())
}

/// Columnas en el mismo orden en todas las consultas, para leer por índice sin sorpresas.
const COLS: &str = "Nombre, Last_Run_Ms, Last_Ok_Ms, Last_Error, Fallos";

fn fila_a_estado(row: &libsql::Row) -> AppResult<(String, EstadoJob)> {
    let nombre = v_string(row.get_value(0).map_err(db_err)?).unwrap_or_default();
    Ok((
        nombre,
        EstadoJob {
            last_run_ms: v_i64(row.get_value(1).map_err(db_err)?),
            last_ok_ms: v_i64(row.get_value(2).map_err(db_err)?),
            last_error: v_string(row.get_value(3).map_err(db_err)?),
            fallos: v_i64(row.get_value(4).map_err(db_err)?).unwrap_or(0),
        },
    ))
}

fn opt_int(v: Option<i64>) -> Value {
    v.map(Value::Integer).unwrap_or(Value::Null)
}

fn opt_text(v: Option<&str>) -> Value {
    v.map(|s| Value::Text(s.to_string())).unwrap_or(Value::Null)
}

#[async_trait]
impl JobsStateRepository for SqliteJobsStateRepository {
    async fn cargar(&self, nombre: &str) -> AppResult<Option<EstadoJob>> {
        let r = self.db.read().await;
        let mut rows = r
            .conn()
            .query(
                &format!("SELECT {COLS} FROM _Jobs_State WHERE Nombre = ?1 LIMIT 1;"),
                vec![Value::Text(nombre.to_string())],
            )
            .await
            .map_err(db_err)?;

        match rows.next().await.map_err(db_err)? {
            Some(row) => Ok(Some(fila_a_estado(&row)?.1)),
            None => Ok(None),
        }
    }

    async fn guardar(&self, nombre: &str, estado: &EstadoJob) -> AppResult<()> {
        let w = self.db.write().await;
        w.raw()
            .execute(
                "INSERT INTO _Jobs_State (Nombre, Last_Run_Ms, Last_Ok_Ms, Last_Error, Fallos) \
                 VALUES (?1, ?2, ?3, ?4, ?5) \
                 ON CONFLICT(Nombre) DO UPDATE SET \
                   Last_Run_Ms = excluded.Last_Run_Ms, \
                   Last_Ok_Ms  = excluded.Last_Ok_Ms, \
                   Last_Error  = excluded.Last_Error, \
                   Fallos      = excluded.Fallos;",
                vec![
                    Value::Text(nombre.to_string()),
                    opt_int(estado.last_run_ms),
                    opt_int(estado.last_ok_ms),
                    opt_text(estado.last_error.as_deref()),
                    Value::Integer(estado.fallos),
                ],
            )
            .await
            .map_err(db_err)?;
        Ok(())
    }

    async fn listar(&self) -> AppResult<Vec<(String, EstadoJob)>> {
        let r = self.db.read().await;
        let mut rows = r
            .conn()
            .query(
                &format!("SELECT {COLS} FROM _Jobs_State ORDER BY Nombre;"),
                (),
            )
            .await
            .map_err(db_err)?;

        let mut out = Vec::new();
        while let Some(row) = rows.next().await.map_err(db_err)? {
            out.push(fila_a_estado(&row)?);
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Unicidad entre tests en paralelo: contador atómico + PID, igual que en `migrations.rs`.
    // (No usar el reloj: en Windows su resolución es baja y dos tests simultáneos colisionarían.)
    /// BD local en un fichero temporal, abierta como en producción (`Db::open` aplica migraciones
    /// y crea las tablas de control, `_Jobs_State` incluida). Devuelve también el directorio para
    /// poder limpiarlo al final del test.
    async fn db_temp() -> (std::sync::Arc<Db>, std::path::PathBuf) {
        let dir = crate::test_temp::dir_temporal("jobs");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("data.db");
        let db = Db::open(path.to_str().unwrap())
            .await
            .expect("abrir la BD temporal");
        (db, dir)
    }

    fn estado_completo() -> EstadoJob {
        // Valores DISTINTOS entre sí a propósito: si dos columnas se cruzaran, el `assert_eq!`
        // del ida y vuelta lo detecta. Con valores iguales, un cruce pasaría desapercibido.
        EstadoJob {
            last_run_ms: Some(1_700_000_000_000),
            last_ok_ms: Some(1_699_111_111_111),
            last_error: Some("feed caído".to_string()),
            fallos: 7,
        }
    }

    #[tokio::test]
    async fn un_job_sin_historial_no_tiene_estado() {
        let (db, dir) = db_temp().await;
        let repo = SqliteJobsStateRepository::new(db);

        assert_eq!(repo.cargar("jamas_ejecutado").await.unwrap(), None);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// El test que de verdad importa. `COLS` y `fila_a_estado` están acopladas **por posición**:
    /// nada en el compilador garantiza que el orden coincida. Si alguien añade una columna en medio
    /// sin tocar los índices, `last_ok_ms` acabaría leyendo otro valor —y `last_ok_ms` es el dato
    /// con el que se decide si un job está vencido, así que el job dejaría de correr (o correría
    /// sin parar) sin un solo error visible. Este ida y vuelta fija esa correspondencia entera.
    #[tokio::test]
    async fn el_estado_va_y_vuelve_intacto() {
        let (db, dir) = db_temp().await;
        let repo = SqliteJobsStateRepository::new(db);
        let guardado = estado_completo();

        repo.guardar("licencia", &guardado).await.unwrap();
        let leido = repo.cargar("licencia").await.unwrap();

        assert_eq!(leido, Some(guardado));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Los campos vacíos deben viajar como NULL y volver como `None`, no como 0 ni cadena vacía:
    /// `last_ok_ms = None` es lo que significa "nunca se ejecutó con éxito" y decide que el job
    /// arranque con su `retardo_inicial` en vez de creerse vencido.
    #[tokio::test]
    async fn los_campos_vacios_van_y_vuelven_como_none() {
        let (db, dir) = db_temp().await;
        let repo = SqliteJobsStateRepository::new(db);

        repo.guardar("avisos", &EstadoJob::default()).await.unwrap();

        assert_eq!(repo.cargar("avisos").await.unwrap(), Some(EstadoJob::default()));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// El runner guarda tras CADA intento: si el upsert no funcionara, la tabla crecería sin
    /// límite y `listar` devolvería duplicados en el panel.
    #[tokio::test]
    async fn guardar_dos_veces_actualiza_en_vez_de_duplicar() {
        let (db, dir) = db_temp().await;
        let repo = SqliteJobsStateRepository::new(db);

        repo.guardar("updater", &estado_completo()).await.unwrap();
        let segundo = EstadoJob {
            last_run_ms: Some(1_800_000_000_000),
            last_ok_ms: Some(1_800_000_000_000),
            last_error: None,
            fallos: 0,
        };
        repo.guardar("updater", &segundo).await.unwrap();

        let todos = repo.listar().await.unwrap();
        assert_eq!(todos.len(), 1, "el upsert no debe crear una fila nueva");
        assert_eq!(todos[0].1, segundo, "debe quedar el último estado");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn listar_devuelve_todos_los_jobs_ordenados_por_nombre() {
        let (db, dir) = db_temp().await;
        let repo = SqliteJobsStateRepository::new(db);

        for nombre in ["updater", "avisos", "licencia"] {
            repo.guardar(nombre, &estado_completo()).await.unwrap();
        }

        let nombres: Vec<String> = repo
            .listar()
            .await
            .unwrap()
            .into_iter()
            .map(|(n, _)| n)
            .collect();
        assert_eq!(nombres, vec!["avisos", "licencia", "updater"]);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
