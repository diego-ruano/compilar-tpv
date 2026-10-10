//! RI-85 / RI-47: horarios agrupados y recuperación de cobros en migraciones aditivas.
//! Sistema de migraciones del esquema de la **BD local (SQLite/libsql)**.
//!
//! ## Modelo (fuente única de verdad)
//! Ya **no existe `schema.sql`**. El esquema completo se construye ejecutando en orden los ficheros
//! `.sql` de `packages/database/migrations/`, que se **embeben** en el binario con [`include_dir!`].
//! Tanto una instalación nueva como una existente convergen aplicando las migraciones que aún no
//! tengan registradas.
//!
//! `0001` contiene el esquema inicial; las siguientes migraciones son incrementales.
//! No se modifica una migración aplicada: cambiaría su hash y ambos runners fallarían
//! con `migration_altered`.
//!
//! ## Control por tabla `_migrations`
//! Cada BD lleva una tabla `_migrations (name, hash, applied_at)` con las migraciones ya aplicadas.
//! En cada arranque:
//! 1. Se asegura la tabla `_migrations`.
//! 2. Por cada fichero (en orden de nombre):
//!    - Si **ya está aplicado**: se verifica que su `hash` no haya cambiado (detecta que alguien
//!      editó una migración ya publicada → error duro). Si coincide, se salta.
//!    - Si **está pendiente**: se ejecuta **dentro de una transacción** junto con el `INSERT` en
//!      `_migrations`; o se aplican ambos o ninguno.
//!
//! ## Cómo añadir un cambio de esquema
//! 1. Crea `packages/database/migrations/000N_descripcion.sql` con el cambio (solo aditivo).
//! 2. Nada más en Rust: `include_dir!` lo recoge solo. (En el worker hay que añadir una línea al
//!    registro — ver `tenantMigrations.ts`.)
//!
//! ## Reglas
//! - **Solo aditivo / compatible hacia atrás**: `ALTER TABLE ... ADD COLUMN`, `CREATE TABLE`,
//!   `CREATE INDEX`. Evita renombrar/eliminar columnas mientras haya apps viejas en producción.
//! - **Nunca edites una migración ya publicada** (cambiaría su hash → error). Crea una nueva.

use crate::util::now_ms;
use std::collections::HashMap;

use include_dir::{include_dir, Dir};
use libsql::Connection;
use crate::ejecutor::{ErrorSql, Value};
use sha2::{Digest, Sha256};

/// Ficheros de migración embebidos en el binario en tiempo de compilación.
/// Ruta relativa al directorio del crate (`crates/tpv-infra-sqlite`).
///
/// build.rs registra el directorio con rerun-if-changed: Cargo reembebe los SQL cuando cambian,
/// se añaden o se eliminan, también en builds incrementales (RI-49).
static MIGRATIONS_DIR: Dir = include_dir!("$CARGO_MANIFEST_DIR/../../packages/database/migrations");

type BoxErr = Box<dyn std::error::Error + Send + Sync>;

/// Lista de migraciones `(nombre, contenido)` ordenada por nombre (0001, 0002, …).
fn migration_files() -> Vec<(String, String)> {
    let mut files: Vec<(String, String)> = MIGRATIONS_DIR
        .files()
        .filter_map(|f| {
            let name = f.path().file_name()?.to_str()?.to_string();
            if !name.ends_with(".sql") {
                return None;
            }
            let content = f.contents_utf8()?.to_string();
            Some((name, content))
        })
        .collect();
    files.sort_by(|a, b| a.0.cmp(&b.0));
    files
}

/// Normaliza finales de línea (CRLF → LF) para que el hash sea estable entre sistemas.
fn normalize(s: &str) -> String {
    s.replace("\r\n", "\n")
}

/// Quita comentarios de bloque `/* … */` (UTF-8 safe: corta en los delimitadores ASCII). Algunos
/// motores los rechazan; nuestras migraciones no usan `/*` dentro de literales, así que es seguro.
fn strip_block_comments(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(start) = rest.find("/*") {
        out.push_str(&rest[..start]);
        match rest[start + 2..].find("*/") {
            Some(end) => rest = &rest[start + 2 + end + 2..],
            None => {
                rest = "";
                break;
            }
        }
    }
    out.push_str(rest);
    out
}

fn sha256_hex(s: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(s.as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect()
}

async fn table_exists(conn: &Connection, name: &str) -> Result<bool, ErrorSql> {
    let mut rows = conn
        .query(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1 LIMIT 1;",
            vec![Value::Text(name.to_string())],
        )
        .await?;
    Ok(rows.next().await?.is_some())
}

async fn ensure_table(conn: &Connection) -> Result<(), ErrorSql> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS _migrations (\
            name TEXT PRIMARY KEY, \
            hash TEXT NOT NULL, \
            applied_at INTEGER NOT NULL\
        );",
    )
    .await?;
    Ok(())
}

/// Mapa `name -> hash` de las migraciones ya aplicadas (vacío si la tabla aún no existe).
async fn applied_map(conn: &Connection) -> Result<HashMap<String, String>, ErrorSql> {
    if !table_exists(conn, "_migrations").await? {
        return Ok(HashMap::new());
    }

    let mut rows = conn
        .query("SELECT name, hash FROM _migrations;", Vec::<Value>::new())
        .await?;

    let mut map = HashMap::new();
    while let Some(row) = rows.next().await? {
        let name = match row.get_value(0)? {
            Value::Text(s) => s,
            _ => continue,
        };
        let hash = match row.get_value(1)? {
            Value::Text(s) => s,
            _ => String::new(),
        };
        map.insert(name, hash);
    }
    Ok(map)
}

/// Aplica todas las migraciones pendientes (cada una en su propia transacción). Crea desde cero el
/// esquema en BDs nuevas y pone al día las existentes. Falla si una migración ya aplicada fue
/// modificada (hash distinto).
///
/// **Enforcement de FK apagado durante las migraciones.** Un cambio de esquema que quite una
/// restricción de tabla (un `CHECK`) obliga a reconstruir la tabla (SQLite no soporta
/// `ALTER TABLE ... DROP CONSTRAINT`): crear la nueva, copiar, `DROP` la vieja, renombrar. Con las
/// FK activas ese `DROP` de la tabla referenciada haría un DELETE implícito que **cascadearía** a
/// `Movimientos_Stock` (`ON DELETE CASCADE`) o **violaría** la FK `NO ACTION` de `Lote_Consumos`.
/// SQLite exige togglear el enforcement **fuera** de transacción (dentro es no-op), así que se apaga
/// aquí, alrededor de toda la tanda, y se restaura al terminar. Como red de seguridad, cada
/// migración pasa `foreign_key_check` antes de confirmar: con las FK apagadas nadie las verifica en
/// caliente, así que comprobamos a mano que la migración no dejó huérfanos. Es el procedimiento que
/// recomienda la propia doc de SQLite para alteraciones de tabla.
pub async fn run(conn: &Connection) -> Result<(), BoxErr> {
    ensure_table(conn).await?;
    let applied = applied_map(conn).await?;

    // Fuera de transacción (dentro sería no-op). Se restaura pase lo que pase más abajo.
    conn.execute_batch("PRAGMA foreign_keys=OFF;").await?;
    let res = apply_pending(conn, &applied).await;
    let restore = conn.execute_batch("PRAGMA foreign_keys=ON;").await;
    // El error de la migración manda sobre el de restaurar (que además casi nunca falla).
    res?;
    restore?;
    Ok(())
}

/// Bucle de aplicación de las pendientes. Se ejecuta con el enforcement de FK ya apagado (ver
/// [`run`]); confía en `foreign_key_check` para no confirmar una migración que rompa integridad.
async fn apply_pending(conn: &Connection, applied: &HashMap<String, String>) -> Result<(), BoxErr> {
    for (name, content) in migration_files() {
        let normalized = normalize(&content);
        let hash = sha256_hex(&normalized);

        if let Some(prev) = applied.get(&name) {
            if *prev != hash {
                return Err(format!(
                    "La migración '{name}' fue modificada después de aplicarse (hash distinto). \
                     Nunca edites una migración ya publicada: crea una nueva."
                )
                .into());
            }
            continue;
        }

        let body = strip_block_comments(&normalized);

        // Transacción: migración + verificación de integridad + registro en `_migrations`, atómicos.
        conn.execute_batch("BEGIN;").await?;
        let applied_res: Result<(), BoxErr> = async {
            conn.execute_batch(&body).await?;
            comprobar_integridad_fk(conn, &name).await?;
            conn.execute(
                "INSERT INTO _migrations (name, hash, applied_at) VALUES (?1, ?2, ?3);",
                vec![
                    Value::Text(name.clone()),
                    Value::Text(hash.clone()),
                    Value::Integer(now_ms()),
                ],
            )
            .await?;
            Ok(())
        }
        .await;

        match applied_res {
            Ok(()) => {
                conn.execute_batch("COMMIT;").await?;
                tracing::info!(target: "tpv::migrations", migracion = %name, "migración aplicada");
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK;").await;
                return Err(e);
            }
        }
    }

    Ok(())
}

/// Verifica que la migración no dejó filas huérfanas. `PRAGMA foreign_key_check` devuelve una fila
/// por cada violación (tabla, rowid, tabla referida, id de la FK); si hay alguna, abortamos para que
/// la transacción de la migración haga rollback. Con el enforcement apagado durante la tanda, este
/// es el control que sustituye a la verificación en caliente.
async fn comprobar_integridad_fk(conn: &Connection, name: &str) -> Result<(), BoxErr> {
    let mut rows = conn
        .query("PRAGMA foreign_key_check;", Vec::<Value>::new())
        .await?;
    if let Some(row) = rows.next().await? {
        let tabla = match row.get_value(0) {
            Ok(Value::Text(t)) => t,
            _ => "?".to_string(),
        };
        return Err(format!(
            "La migración '{name}' dejó integridad referencial rota (foreign_key_check señala '{tabla}'). \
             Se revierte."
        )
        .into());
    }
    Ok(())
}

/// `true` si hay migraciones pendientes sobre una BD que **ya tiene datos** (tiene al menos una
/// migración registrada en `_migrations`). Lo usa la copia de seguridad previa a migrar. Una BD
/// nueva sin migraciones devuelve `false`: no hay nada que respaldar.
pub async fn has_pending(conn: &Connection) -> Result<bool, ErrorSql> {
    let applied = applied_map(conn).await?;
    // BD nueva (nunca migrada): nada que respaldar.
    if applied.is_empty() {
        return Ok(false);
    }
    Ok(migration_files()
        .into_iter()
        .any(|(name, _)| !applied.contains_key(&name)))
}

// ──────────────────────────────────────────────────────────────────────────────
// Tests de humo del runner (headless): replican los 3 escenarios manuales
// (creación limpia, idempotencia, anti-tampering) sin necesidad de la GUI.
// ──────────────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;
    use libsql::Builder;

    // Unicidad garantizada entre tests en paralelo: contador atómico + PID. (No usar el reloj:
    // en Windows su resolución es baja y dos tests simultáneos colisionarían de directorio.)
    /// Abre una BD libsql local en un fichero temporal. Devuelve la `Database` (hay que mantenerla
    /// viva mientras se use la `Connection`) + la conexión + el directorio (para limpiar).
    async fn open_temp() -> (libsql::Database, Connection, std::path::PathBuf) {
        let dir = crate::test_temp::dir_temporal("migraciones");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("data.db");
        let database = Builder::new_local(path.to_str().unwrap())
            .build()
            .await
            .unwrap();
        let conn = database.connect().unwrap();
        // tune() activa WAL, busy_timeout, FK y synchronous=NORMAL — igual que producción.
        // Sin esto, las FK quedan desactivadas y violaciones de clave pasan en test pero no en prod.
        crate::db::tune(&conn).await.unwrap();
        (database, conn, dir)
    }

    async fn scalar_i64(conn: &Connection, sql: &str) -> i64 {
        let mut rows = conn.query(sql, Vec::<Value>::new()).await.unwrap();
        let row = rows.next().await.unwrap().unwrap();
        match row.get_value(0).unwrap() {
            Value::Integer(n) => n,
            Value::Real(n) => n as i64,
            _ => panic!("se esperaba entero"),
        }
    }

    #[tokio::test]
    async fn ri48_una_base_incompatible_se_rechaza_sin_modificar_sus_datos() {
        let (_base, conn, _dir) = open_temp().await;
        ensure_table(&conn).await.unwrap();
        for (name, content) in migration_files().into_iter().take(3) {
            let normalized = normalize(&content);
            conn.execute_batch(&strip_block_comments(&normalized)).await.unwrap();
            conn.execute("INSERT INTO _migrations (name, hash, applied_at) VALUES (?1, ?2, 1);",
                vec![Value::Text(name), Value::Text(sha256_hex(&normalized))]).await.unwrap();
        }
        conn.execute_batch("INSERT INTO Tareas (ID_Tarea, Titulo, Fecha_Creacion, Estado) VALUES ('t', 'Tarea', '2030-01-01', 'INVENTADO');").await.unwrap();
        assert!(run(&conn).await.is_err());
        assert_eq!(scalar_i64(&conn, "SELECT COUNT(*) FROM Tareas WHERE Estado = 'INVENTADO';").await, 1);
        assert_eq!(scalar_i64(&conn, "SELECT COUNT(*) FROM _migrations WHERE name = '0004_valores_dominio.sql';").await, 0);
        assert!(!table_exists(&conn, "_RI48_Validacion").await.unwrap());
        assert_eq!(scalar_i64(&conn, "PRAGMA foreign_keys;").await, 1);
    }

    #[tokio::test]
    async fn ri48_rechaza_valores_desconocidos_y_otro_en_cobros() {
        let (_base, conn, _dir) = open_temp().await;
        run(&conn).await.unwrap();
        for (tabla, columna) in [("Pagos", "Metodo_Pago"), ("Detalle_Comanda", "Estado_Cocina"),
            ("Reservas", "Estado"), ("Tareas", "Estado"), ("Tarea_Asignaciones", "Estado"),
            ("Fichajes", "Estado"), ("Movimientos_Caja", "Metodo_Pago")] {
            let error = conn.execute(&format!("INSERT INTO {tabla} ({columna}) VALUES ('DESCONOCIDO');"), ()).await.unwrap_err();
            assert!(error.to_string().contains("RI48"), "{tabla}: {error}");
        }
        conn.execute_batch("INSERT INTO Comandas (ID_Comanda, Fecha_Hora_Apertura, Canal) VALUES ('com', '2030-01-01', 'BARRA');
            INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo)
            VALUES ('pago', 'com', '2030-01-01', 'Efectivo', 100, 'COBRO');").await.unwrap();
        for metodo in ["Otro", "bizum", ""] {
            assert!(conn.execute("UPDATE Pagos SET Metodo_Pago = ?1 WHERE ID_Pago = 'pago';", vec![Value::Text(metodo.into())]).await.is_err());
        }
        conn.execute_batch("INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo, ID_Pago_Origen, Motivo_Devolucion)
            VALUES ('dev', 'com', '2030-01-01', 'Otro', -50, 'DEVOLUCION', 'pago', 'Devuelto');").await.unwrap();
        assert_eq!(scalar_i64(&conn, "SELECT COUNT(*) FROM Pagos;").await, 2);
    }

    /// 1) Creación limpia: BD vacía → se construye el esquema y quedan registradas todas las
    ///    migraciones, cada una con su hash SHA-256 y timestamp > 0.
    #[tokio::test]
    async fn smoke_clean_create() {
        let (_db, conn, dir) = open_temp().await;

        run(&conn).await.expect("las migraciones deben aplicarse en una BD limpia");

        let total = scalar_i64(&conn, "SELECT COUNT(*) FROM _migrations;").await;
        let expected = migration_files().len() as i64;
        assert_eq!(total, expected, "debe registrarse una fila por cada migración");

        // Verificar que 0001 está registrada con hash válido.
        let mut rows = conn
            .query(
                "SELECT name, hash, applied_at FROM _migrations WHERE name='0001_inicial.sql';",
                Vec::<Value>::new(),
            )
            .await
            .unwrap();
        let row = rows.next().await.unwrap().expect("debe existir la fila 0001");
        let name = match row.get_value(0).unwrap() {
            Value::Text(s) => s,
            _ => panic!(),
        };
        let hash = match row.get_value(1).unwrap() {
            Value::Text(s) => s,
            _ => panic!(),
        };
        let applied_at = match row.get_value(2).unwrap() {
            Value::Integer(n) => n,
            _ => panic!(),
        };
        assert_eq!(name, "0001_inicial.sql");
        assert_eq!(hash.len(), 64, "el hash debe ser SHA-256 en hex");
        assert!(applied_at > 0);

        // Las tablas del esquema se crearon de verdad.
        assert!(table_exists(&conn, "Roles").await.unwrap());
        assert!(table_exists(&conn, "Usuarios").await.unwrap());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 2) Idempotencia: re-ejecutar no falla, no duplica filas y NO re-aplica (no toca applied_at).
    #[tokio::test]
    async fn smoke_idempotent() {
        let (_db, conn, dir) = open_temp().await;

        run(&conn).await.unwrap();
        let first_name = migration_files()
            .into_iter()
            .next()
            .map(|(n, _)| n)
            .expect("debe haber al menos una migración");
        let q = format!("SELECT applied_at FROM _migrations WHERE name='{first_name}';");
        let applied_at_1 = scalar_i64(&conn, &q).await;

        // Segunda pasada: debe detectar que todas las migraciones ya están aplicadas y saltarlas.
        run(&conn).await.expect("re-ejecutar no debe fallar");

        assert_eq!(
            scalar_i64(&conn, "SELECT COUNT(*) FROM _migrations;").await,
            migration_files().len() as i64,
        );
        let applied_at_2 = scalar_i64(&conn, &q).await;
        assert_eq!(applied_at_1, applied_at_2, "no debe re-aplicarse la migración");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 3) Anti-tampering: si el hash guardado no coincide con el del fichero (simulando que la
    ///    migración se modificó tras aplicarse), el runner falla con error duro y no continúa.
    #[tokio::test]
    async fn smoke_tamper_detected() {
        let (_db, conn, dir) = open_temp().await;

        run(&conn).await.unwrap();

        // Corromper el hash registrado (equivale a editar el .sql ya aplicado).
        conn.execute(
            "UPDATE _migrations SET hash='hash_manipulado' WHERE name='0001_inicial.sql';",
            Vec::<Value>::new(),
        )
        .await
        .unwrap();

        let err = run(&conn).await.expect_err("debe detectar la manipulación");
        let msg = format!("{err}").to_lowercase();
        assert!(msg.contains("0001_inicial.sql"), "el error debe nombrar la migración: {msg}");
        assert!(msg.contains("modificada"), "el error debe indicar manipulación: {msg}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 4) Rebuild de tabla (0003): el runner corre con las FK apagadas, así que el DROP+recreate de
    ///    `Lotes_Producto` NO borra por cascada sus hijas (`Movimientos_Stock`), y el
    ///    `CHECK (Stock_Disponible >= 0)` desaparece (ya se admite stock negativo). Es la red de
    ///    seguridad del cambio más delicado de todo el refactor.
    #[tokio::test]
    async fn migracion_0003_conserva_hijas_y_permite_stock_negativo() {
        let (_db, conn, dir) = open_temp().await;

        // Aplica a mano 0001 y 0002 (dejando 0003 pendiente) para sembrar datos ANTES del rebuild y
        // comprobar que sobreviven.
        ensure_table(&conn).await.unwrap();
        for (name, content) in migration_files().into_iter().take(2) {
            let normalized = normalize(&content);
            let body = strip_block_comments(&normalized);
            conn.execute_batch(&body).await.unwrap();
            conn.execute(
                "INSERT INTO _migrations (name, hash, applied_at) VALUES (?1, ?2, 1);",
                vec![Value::Text(name), Value::Text(sha256_hex(&normalized))],
            )
            .await
            .unwrap();
        }

        // Semilla mínima consistente: categoría → producto → lote (stock 3) → movimiento de ALTA.
        // El movimiento es hija de Lotes_Producto con ON DELETE CASCADE: es justo la fila que un
        // DROP de la tabla con las FK activas borraría.
        conn.execute_batch(
            "INSERT INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('c1','Bebidas');
             INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta)
               VALUES ('p1','c1','Cerveza',250);
             INSERT INTO Lotes_Producto (ID_Lote, ID_Producto, Codigo_Lote, Stock_Disponible, Fecha_Entrada)
               VALUES ('l1','p1','L-1',3, '2026-01-01 10:00:00');
             INSERT INTO Movimientos_Stock (ID_Movimiento, ID_Lote, Tipo, Delta, Stock_Resultante, Fecha)
               VALUES ('m1','l1','ALTA',10,10,'2026-01-01 00:00:00');",
        )
        .await
        .unwrap();

        // Runner: ahora solo 0003 está pendiente.
        run(&conn).await.expect("0003 debe aplicarse sin romper nada");

        // La hija ON DELETE CASCADE sobrevive al rebuild, y el lote sigue con su stock.
        assert_eq!(scalar_i64(&conn, "SELECT COUNT(*) FROM Movimientos_Stock;").await, 1);
        assert_eq!(
            scalar_i64(&conn, "SELECT COUNT(*) FROM Lotes_Producto WHERE ID_Lote='l1';").await,
            1,
        );

        // El CHECK se fue: el disponible ya puede bajar de cero (antes esto lo rechazaba el CHECK).
        conn.execute(
            "UPDATE Lotes_Producto SET Stock_Disponible = -5 WHERE ID_Lote='l1';",
            Vec::<Value>::new(),
        )
        .await
        .expect("el stock ya puede ser negativo");

        // Integridad referencial intacta tras el rebuild.
        let mut rows = conn
            .query("PRAGMA foreign_key_check;", Vec::<Value>::new())
            .await
            .unwrap();
        assert!(
            rows.next().await.unwrap().is_none(),
            "no debe haber huérfanos tras el rebuild",
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Vuelca el esquema resultante (tablas/índices/triggers/vistas), normalizado, para comparar
    /// contra el snapshot. Excluye internos de SQLite y la tabla de control `_migrations`.
    async fn dump_schema(conn: &Connection) -> String {
        let mut rows = conn
            .query(
                "SELECT sql FROM sqlite_master \
                 WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name <> '_migrations' \
                 ORDER BY type, name;",
                Vec::<Value>::new(),
            )
            .await
            .unwrap();
        let mut out = String::new();
        while let Some(row) = rows.next().await.unwrap() {
            if let Value::Text(sql) = row.get_value(0).unwrap() {
                // Normaliza espacios para que reformatear una migración no dispare falsos drifts.
                out.push_str(&sql.split_whitespace().collect::<Vec<_>>().join(" "));
                out.push_str(";\n");
            }
        }
        out
    }

    fn snapshot_path() -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/database/schema.snapshot.sql")
    }

    /// ANTI-DRIFT: el esquema que producen TODAS las migraciones sobre una BD vacía debe coincidir
    /// con `packages/database/schema.snapshot.sql`. Si cambias el esquema a propósito, regenera el
    /// snapshot:  `BLESS_SCHEMA_SNAPSHOT=1 cargo nextest run -p tpv-infra-sqlite -E test(schema_snapshot)`.
    #[tokio::test]
    async fn schema_snapshot_no_drift() {
        let (_db, conn, dir) = open_temp().await;
        run(&conn).await.unwrap();
        let dump = dump_schema(&conn).await;
        let path = snapshot_path();

        if std::env::var("BLESS_SCHEMA_SNAPSHOT").is_ok() {
            std::fs::write(&path, &dump).unwrap();
            eprintln!("[snapshot] regenerado: {:?}", path);
        } else {
            let expected = std::fs::read_to_string(&path).unwrap_or_else(|_| {
                panic!(
                    "Falta el snapshot {:?}. Regenéralo con: \
                     BLESS_SCHEMA_SNAPSHOT=1 cargo nextest run -p tpv-infra-sqlite -E test(schema_snapshot)",
                    path
                )
            });
            assert_eq!(
                dump.replace("\r\n", "\n").trim(),
                expected.replace("\r\n", "\n").trim(),
                "El esquema generado por las migraciones difiere del snapshot. Si es intencionado, \
                 regenera: BLESS_SCHEMA_SNAPSHOT=1 cargo nextest run -p tpv-infra-sqlite -E test(schema_snapshot)"
            );
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// RI-65: ninguna columna de clave primaria admite NULL. En SQLite sólo una `INTEGER PRIMARY
    /// KEY` de una columna (el alias del rowid) lo impide por sí misma; cualquier otra —una de
    /// texto, o una parte de una clave compuesta— lo admite si no lleva `NOT NULL`, y admite
    /// varios, porque en un índice único los NULL son distintos. Ya pasó: un lote nacía con
    /// `ID_Lote` NULL, invisible para el FEFO. Una tabla nueva que se olvide del `NOT NULL` se
    /// pone roja aquí. (`_migrations` es del runner, no del esquema: la crea cada runner por su
    /// cuenta y sólo la escribe él.)
    #[tokio::test]
    async fn ninguna_clave_primaria_admite_null() {
        let (_db, conn, dir) = open_temp().await;
        run(&conn).await.unwrap();

        let mut rows = conn
            .query(
                "SELECT m.name || '.' || p.name \
                 FROM sqlite_master m JOIN pragma_table_info(m.name) p \
                 WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' AND m.name <> '_migrations' \
                   AND p.pk > 0 AND p.\"notnull\" = 0 \
                   AND NOT (upper(p.type) = 'INTEGER' \
                            AND (SELECT COUNT(*) FROM pragma_table_info(m.name) x WHERE x.pk > 0) = 1) \
                 ORDER BY 1;",
                Vec::<Value>::new(),
            )
            .await
            .unwrap();
        let mut sin_not_null = Vec::new();
        while let Some(row) = rows.next().await.unwrap() {
            if let Value::Text(col) = row.get_value(0).unwrap() {
                sin_not_null.push(col);
            }
        }
        assert!(
            sin_not_null.is_empty(),
            "estas claves primarias admiten NULL (añádeles NOT NULL): {sin_not_null:?}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Las columnas `INTEGER` que NO son dinero. Todas las demás tienen que llevar
    /// `CHECK (typeof(col) IN ('integer','null'))` (RI-65). Una columna entera nueva obliga a
    /// decidir: o es dinero y lleva el CHECK, o se añade aquí. Así no hay forma de olvidarse.
    /// Las tablas locales del dispositivo (`_…`) no guardan dinero y no se miran.
    const INTEGER_QUE_NO_ES_DINERO: &[(&str, &[&str])] = &[
        ("Applied_Operations", &["Created_At_Ms", "Applied_At_Ms", "Updated_At_Ms"]),
        ("Business_Settings", &["Modo_Prueba", "Reserva_Duracion_Min"]),
        ("Categorias_Producto", &["Vendible", "Pasa_Cocina"]),
        ("Cierre_Denominaciones", &["Unidades"]),
        ("Cuentas_Gastos", &["Pagado_Con_Caja"]),
        ("Fichaje_Dia", &["Turno_Partido"]),
        ("Fichajes", &["Parte", "Cerrado_Automatico"]),
        ("Horario_Predeterminado", &["Weekday", "Orden"]),
        ("Intentos_Login", &["Intentos_Fallidos", "Bloqueado_Hasta_Ms", "Ultimo_Intento_Ms"]),
        ("Mesas", &["Capacidad", "Ubicacion_X", "Ubicacion_Y", "Width", "Height", "Radius"]),
        ("Registros_Facturacion", &["Orden", "Numero"]),
        ("Reservas", &["Comensales", "Duracion_Min"]),
        ("Serie_Facturacion", &["Ultimo"]),
        ("Sync_Changes", &["Created_At_Ms"]),
        ("Sync_Main_Checkpoints", &["Last_Seq", "Updated_At_Ms"]),
        (
            "Ticket_Settings",
            &[
                "Show_Logo", "Show_BusinessName", "Show_Address", "Show_Phone",
                "Show_FooterMessage", "Paper_Width_Mm", "Paper_Dpi", "Chars_Per_Line",
            ],
        ),
        ("Usuarios", &["Requiere_Setup"]),
    ];

    /// RI-65: toda columna de dinero lleva su CHECK de tipo, y ninguna otra lo necesita. Ver
    /// [`INTEGER_QUE_NO_ES_DINERO`].
    #[tokio::test]
    async fn todas_las_columnas_de_dinero_llevan_su_check() {
        let (_db, conn, dir) = open_temp().await;
        run(&conn).await.unwrap();

        let mut rows = conn
            .query(
                "SELECT m.name, p.name, m.sql \
                 FROM sqlite_master m JOIN pragma_table_info(m.name) p \
                 WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' AND m.name NOT LIKE '\\_%' ESCAPE '\\' \
                   AND upper(p.type) = 'INTEGER' \
                   AND NOT (p.pk = 1 AND (SELECT COUNT(*) FROM pragma_table_info(m.name) x WHERE x.pk > 0) = 1) \
                 ORDER BY 1, 2;",
                Vec::<Value>::new(),
            )
            .await
            .unwrap();
        let mut sin_check = Vec::new();
        let mut sobra_en_la_lista = Vec::new();
        while let Some(row) = rows.next().await.unwrap() {
            let (Value::Text(tabla), Value::Text(col), Value::Text(sql)) = (
                row.get_value(0).unwrap(),
                row.get_value(1).unwrap(),
                row.get_value(2).unwrap(),
            ) else {
                panic!("fila inesperada");
            };
            let no_es_dinero = INTEGER_QUE_NO_ES_DINERO
                .iter()
                .any(|(t, cols)| *t == tabla && cols.contains(&col.as_str()));
            let tiene_check = sql.contains(&format!("typeof({col}) IN ('integer','null')"));
            if !no_es_dinero && !tiene_check {
                sin_check.push(format!("{tabla}.{col}"));
            }
            if no_es_dinero && tiene_check {
                sobra_en_la_lista.push(format!("{tabla}.{col}"));
            }
        }
        assert!(
            sin_check.is_empty(),
            "columnas INTEGER sin CHECK de tipo: si son dinero, añádeselo; si no, decláralas en \
             INTEGER_QUE_NO_ES_DINERO: {sin_check:?}"
        );
        assert!(
            sobra_en_la_lista.is_empty(),
            "llevan el CHECK de dinero pero están en INTEGER_QUE_NO_ES_DINERO: {sobra_en_la_lista:?}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// RI-65: qué deja pasar el CHECK. Mira el valor ya convertido por la afinidad de la columna,
    /// así que lo que es un entero entra aunque llegue escrito de otra forma, y lo que no lo es se
    /// rechaza. En la Main y en Turso, igual.
    #[tokio::test]
    async fn el_dinero_solo_admite_enteros() {
        let (_db, conn, dir) = open_temp().await;
        run(&conn).await.unwrap();
        conn.execute(
            "INSERT INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('cat', 'Cat');",
            Vec::<Value>::new(),
        )
        .await
        .unwrap();

        let insertar = |id: &'static str, precio: Value| {
            let conn = &conn;
            async move {
                conn.execute(
                    "INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta) \
                     VALUES (?1, 'cat', ?1, ?2);",
                    vec![Value::Text(id.into()), precio],
                )
                .await
            }
        };

        assert!(insertar("real", Value::Real(2.5)).await.is_err(), "2.5 no es un importe");
        assert!(insertar("texto", Value::Text("2,50".into())).await.is_err(), "'2,50' tampoco");
        insertar("entero", Value::Integer(250)).await.unwrap();
        insertar("real_entero", Value::Real(250.0)).await.unwrap();
        insertar("texto_entero", Value::Text("250".into())).await.unwrap();
        insertar("nulo", Value::Null).await.unwrap();

        let mut rows = conn
            .query(
                "SELECT COUNT(*) FROM Productos \
                 WHERE ID_Producto IN ('entero','real_entero','texto_entero') \
                   AND typeof(Precio_Venta) = 'integer' AND Precio_Venta = 250;",
                Vec::<Value>::new(),
            )
            .await
            .unwrap();
        let n = rows.next().await.unwrap().unwrap().get_value(0).unwrap();
        assert_eq!(n, Value::Integer(3), "los tres se guardan como el entero 250");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// DB-12: la vista `v_inventario_producto_stock` se reescribio (window functions en vez de
    /// subconsultas correlacionadas). Verifica que su semantica es la misma: SUM de stock (todos los
    /// lotes), caducidad mas proxima (MIN de lotes CON stock) y lote FEFO siguiente (NULLs al final),
    /// incluyendo productos sin lotes y con solo lotes sin stock.
    #[tokio::test]
    async fn view_inventario_stock_semantica() {
        let (_db, conn, dir) = open_temp().await;
        run(&conn).await.unwrap();

        conn.execute_batch(
            "INSERT INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('cat1','Cat');\n\
             INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre) VALUES ('P1','cat1','Prod1');\n\
             INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre) VALUES ('P2','cat1','Prod2');\n\
             INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre) VALUES ('P3','cat1','Prod3');\n\
             INSERT INTO Lotes_Producto (ID_Lote,ID_Producto,Codigo_Lote,Fecha_Entrada,Caducidad,Stock_Disponible) VALUES ('LA','P1','A','2026-01-01','2026-12-01',5);\n\
             INSERT INTO Lotes_Producto (ID_Lote,ID_Producto,Codigo_Lote,Fecha_Entrada,Caducidad,Stock_Disponible) VALUES ('LB','P1','B','2026-02-01','2026-06-01',3);\n\
             INSERT INTO Lotes_Producto (ID_Lote,ID_Producto,Codigo_Lote,Fecha_Entrada,Caducidad,Stock_Disponible) VALUES ('LC','P1','C','2026-01-01','2025-01-01',0);\n\
             INSERT INTO Lotes_Producto (ID_Lote,ID_Producto,Codigo_Lote,Fecha_Entrada,Caducidad,Stock_Disponible) VALUES ('LD','P1','D','2026-03-01',NULL,2);\n\
             INSERT INTO Lotes_Producto (ID_Lote,ID_Producto,Codigo_Lote,Fecha_Entrada,Caducidad,Stock_Disponible) VALUES ('LE','P3','E','2026-01-01','2026-01-01',0);",
        )
        .await
        .unwrap();

        async fn read_view(conn: &Connection, id: &str) -> (f64, Value, Value) {
            let sql = format!(
                "SELECT Stock_Actual, Caducidad_Proxima, Lote_Proximo \
                 FROM v_inventario_producto_stock WHERE ID_Producto='{id}';"
            );
            let mut rows = conn.query(&sql, Vec::<Value>::new()).await.unwrap();
            let r = rows.next().await.unwrap().unwrap();
            let stock = match r.get_value(0).unwrap() {
                Value::Integer(n) => n as f64,
                Value::Real(n) => n,
                v => panic!("stock inesperado: {v:?}"),
            };
            (stock, r.get_value(1).unwrap(), r.get_value(2).unwrap())
        }

        // P1: stock = 5+3+0+2 = 10; caducidad proxima = MIN(con stock) = '2026-06-01' (LB);
        // lote FEFO = LB (menor caducidad entre los que tienen stock). LC (sin stock) se ignora.
        let (stock, cad, lote) = read_view(&conn,"P1").await;
        assert_eq!(stock, 10.0);
        assert_eq!(cad, Value::Text("2026-06-01".into()));
        assert_eq!(lote, Value::Text("B".into()));

        // P2: sin lotes -> 0 / NULL / NULL.
        let (stock, cad, lote) = read_view(&conn,"P2").await;
        assert_eq!(stock, 0.0);
        assert_eq!(cad, Value::Null);
        assert_eq!(lote, Value::Null);

        // P3: solo lote sin stock -> 0 / NULL / NULL.
        let (stock, cad, lote) = read_view(&conn,"P3").await;
        assert_eq!(stock, 0.0);
        assert_eq!(cad, Value::Null);
        assert_eq!(lote, Value::Null);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Elimina literales de texto SQL ('…') para que el tokenizador no encuentre palabras
    /// reservadas dentro de strings ('DO COMMIT NOW' → falso positivo sin este paso).
    fn strip_sql_string_literals(s: &str) -> String {
        let mut out = String::with_capacity(s.len());
        let chars: Vec<char> = s.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            if chars[i] == '\'' {
                i += 1;
                while i < chars.len() {
                    if chars[i] == '\'' {
                        i += 1;
                        if i < chars.len() && chars[i] == '\'' {
                            i += 1; // '' → comilla escapada, continuar
                        } else {
                            break; // cierre del literal
                        }
                    } else {
                        i += 1;
                    }
                }
            } else {
                out.push(chars[i]);
                i += 1;
            }
        }
        out
    }

    /// Las migraciones deben ser sentencias puras: el control de transacción lo gestiona el runner
    /// (en el worker, dentro de una transacción interactiva; meter BEGIN/COMMIT en el .sql rompería
    /// con "transacciones anidadas"). Permite el `BEGIN … END` de triggers (no es control de tx).
    #[test]
    fn migrations_no_transaction_control() {
        for (name, content) in migration_files() {
            let body = strip_sql_string_literals(
                &strip_line_comments(&strip_block_comments(&content))
            ).to_uppercase();
            let toks: Vec<String> = body
                .split(|c: char| c.is_whitespace() || c == ';' || c == '(' || c == ')')
                .map(|t| t.trim().to_string())
                .filter(|t| !t.is_empty())
                .collect();
            for (i, t) in toks.iter().enumerate() {
                let begin_tx = t == "BEGIN"
                    && toks
                        .get(i + 1)
                        .map(|n| matches!(n.as_str(), "TRANSACTION" | "DEFERRED" | "IMMEDIATE" | "EXCLUSIVE"))
                        .unwrap_or(false);
                let bad = matches!(t.as_str(), "COMMIT" | "ROLLBACK") || begin_tx;
                assert!(
                    !bad,
                    "La migración '{name}' contiene control de transacción ('{t}'). Usa solo \
                     sentencias puras (CREATE/ALTER/INSERT…); la transacción la gestiona el runner."
                );
            }
        }
    }

    fn strip_line_comments(s: &str) -> String {
        s.lines()
            .map(|l| match l.find("--") {
                Some(i) => &l[..i],
                None => l,
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
}

// RI-70: el esquema compartido incluye Encargado y Roles_Permisos.


// RI-48: 0004 valida metodos y estados sin reconstruir tablas.
