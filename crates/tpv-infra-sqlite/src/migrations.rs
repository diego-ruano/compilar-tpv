//! RI-85 / RI-47: los horarios agrupados y la recuperación de cobros van en `0001`.
//! Sistema de migraciones del esquema de la **BD local (SQLite)**.
//!
//! ## Modelo (fuente única de verdad)
//! Ya **no existe `schema.sql`**. El esquema completo se construye ejecutando en orden los ficheros
//! `.sql` de `packages/database/migrations/`, que se **embeben** en el binario con [`include_dir!`].
//! Tanto una instalación nueva como una existente convergen aplicando las migraciones que aún no
//! tengan registradas.
//!
//! `0001` contiene el esquema completo; las que se añadan después son incrementales.
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
//! Es síncrono: corre sobre la conexión nativa al abrir la base, antes de que exista el ejecutor y
//! fuera de los hilos del runtime (ver `Db::open`).
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
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};

use crate::ejecutor::{ErrorSql, Value};

/// Ficheros de migración embebidos en el binario en tiempo de compilación.
/// Ruta relativa al directorio del crate (`crates/tpv-infra-sqlite`).
///
/// build.rs registra el directorio con rerun-if-changed: Cargo reembebe los SQL cuando cambian,
/// se añaden o se eliminan, también en builds incrementales (RI-49).
static MIGRATIONS_DIR: Dir = include_dir!("$CARGO_MANIFEST_DIR/../../packages/database/migrations");

type BoxErr = Box<dyn std::error::Error + Send + Sync>;

/// Una migración ya aplicada en la base no es la que lleva este programa (hash distinto). Es un tipo
/// propio para que quien abre una base ajena (restaurar una copia) pueda distinguirlo de una base
/// rota: es una base de otra versión del programa.
#[derive(Debug)]
pub struct MigracionAlterada {
    pub(crate) nombre: String,
}

impl std::fmt::Display for MigracionAlterada {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "La migración '{}' fue modificada después de aplicarse (hash distinto). \
             Nunca edites una migración ya publicada: crea una nueva.",
            self.nombre
        )
    }
}

impl std::error::Error for MigracionAlterada {}

/// Una migración pendiente no se pudo aplicar a la base. `causa` es el error del motor, y se
/// conserva como `source()` para que quien lo recibe sepa si fue el disco (lleno, sin permiso).
#[derive(Debug)]
pub struct MigracionFallida {
    pub(crate) nombre: String,
    pub(crate) causa: BoxErr,
}

impl std::fmt::Display for MigracionFallida {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "La migración '{}' no se pudo aplicar: {}", self.nombre, self.causa)
    }
}

impl std::error::Error for MigracionFallida {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(self.causa.as_ref())
    }
}

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

fn table_exists(conn: &Connection, name: &str) -> Result<bool, ErrorSql> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1 LIMIT 1;",
            params![name],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

fn ensure_table(conn: &Connection) -> Result<(), ErrorSql> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS _migrations (\
            name TEXT PRIMARY KEY, \
            hash TEXT NOT NULL, \
            applied_at INTEGER NOT NULL\
        );",
    )?;
    Ok(())
}

/// Mapa `name -> hash` de las migraciones ya aplicadas (vacío si la tabla aún no existe).
fn applied_map(conn: &Connection) -> Result<HashMap<String, String>, ErrorSql> {
    if !table_exists(conn, "_migrations")? {
        return Ok(HashMap::new());
    }

    let mut stmt = conn.prepare("SELECT name, hash FROM _migrations;")?;
    let filas = stmt.query_map([], |fila| Ok((fila.get::<_, Value>(0)?, fila.get::<_, Value>(1)?)))?;

    let mut map = HashMap::new();
    for fila in filas {
        let (name, hash) = fila?;
        let Value::Text(name) = name else { continue };
        let hash = match hash {
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
pub fn run(conn: &Connection) -> Result<(), BoxErr> {
    ensure_table(conn)?;
    let applied = applied_map(conn)?;

    // Fuera de transacción (dentro sería no-op). Se restaura pase lo que pase más abajo.
    conn.execute_batch("PRAGMA foreign_keys=OFF;")?;
    let res = apply_pending(conn, &applied);
    let restore = conn.execute_batch("PRAGMA foreign_keys=ON;");
    // El error de la migración manda sobre el de restaurar (que además casi nunca falla).
    res?;
    restore?;
    Ok(())
}

/// Bucle de aplicación de las pendientes. Se ejecuta con el enforcement de FK ya apagado (ver
/// [`run`]); confía en `foreign_key_check` para no confirmar una migración que rompa integridad.
fn apply_pending(conn: &Connection, applied: &HashMap<String, String>) -> Result<(), BoxErr> {
    for (name, content) in migration_files() {
        let normalized = normalize(&content);
        let hash = sha256_hex(&normalized);

        if let Some(prev) = applied.get(&name) {
            if *prev != hash {
                return Err(MigracionAlterada { nombre: name }.into());
            }
            continue;
        }

        let body = strip_block_comments(&normalized);

        // Transacción: migración + verificación de integridad + registro en `_migrations`, atómicos.
        conn.execute_batch("BEGIN;")?;
        let applied_res = (|| -> Result<(), BoxErr> {
            conn.execute_batch(&body)?;
            comprobar_integridad_fk(conn, &name)?;
            conn.execute(
                "INSERT INTO _migrations (name, hash, applied_at) VALUES (?1, ?2, ?3);",
                params![name, hash, now_ms()],
            )?;
            Ok(())
        })();

        match applied_res {
            Ok(()) => {
                conn.execute_batch("COMMIT;")?;
                tracing::info!(target: "tpv::migrations", migracion = %name, "migración aplicada");
            }
            Err(causa) => {
                let _ = conn.execute_batch("ROLLBACK;");
                return Err(MigracionFallida { nombre: name, causa }.into());
            }
        }
    }

    Ok(())
}

/// Verifica que la migración no dejó filas huérfanas. `PRAGMA foreign_key_check` devuelve una fila
/// por cada violación (tabla, rowid, tabla referida, id de la FK); si hay alguna, abortamos para que
/// la transacción de la migración haga rollback. Con el enforcement apagado durante la tanda, este
/// es el control que sustituye a la verificación en caliente.
fn comprobar_integridad_fk(conn: &Connection, name: &str) -> Result<(), BoxErr> {
    let tabla = conn
        .query_row("PRAGMA foreign_key_check;", [], |fila| fila.get::<_, Value>(0))
        .optional()?;
    if let Some(tabla) = tabla {
        let tabla = match tabla {
            Value::Text(t) => t,
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
pub fn has_pending(conn: &Connection) -> Result<bool, ErrorSql> {
    let applied = applied_map(conn)?;
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

    /// Abre una BD local en un fichero temporal propio (ver `test_temp`), afinada como en
    /// producción. Devuelve la conexión y el directorio (para limpiar).
    fn open_temp() -> (Connection, std::path::PathBuf) {
        let dir = crate::test_temp::dir_temporal("migraciones");
        std::fs::create_dir_all(&dir).unwrap();
        let conn = crate::ejecutor::abrir(dir.join("data.db")).unwrap();
        // tune() activa WAL, busy_timeout, FK y synchronous=NORMAL — igual que producción.
        // Sin esto, las FK quedan desactivadas y violaciones de clave pasan en test pero no en prod.
        crate::db::tune(&conn).unwrap();
        (conn, dir)
    }

    fn scalar_i64(conn: &Connection, sql: &str) -> i64 {
        match conn.query_row(sql, [], |fila| fila.get::<_, Value>(0)).unwrap() {
            Value::Integer(n) => n,
            Value::Real(n) => n as i64,
            _ => panic!("se esperaba entero"),
        }
    }

    #[test]
    fn ri48_rechaza_valores_desconocidos_y_otro_en_cobros() {
        let (conn, _dir) = open_temp();
        run(&conn).unwrap();
        for (tabla, columna) in [("Pagos", "Metodo_Pago"), ("Detalle_Comanda", "Estado_Cocina"),
            ("Reservas", "Estado"), ("Reservas", "Origen"), ("Tareas", "Estado"), ("Tarea_Asignaciones", "Estado"),
            ("Fichajes", "Estado"), ("Movimientos_Caja", "Metodo_Pago")] {
            let error = conn.execute(&format!("INSERT INTO {tabla} ({columna}) VALUES ('DESCONOCIDO');"), []).unwrap_err();
            assert!(error.to_string().contains("RI48"), "{tabla}: {error}");
        }
        conn.execute_batch("INSERT INTO Comandas (ID_Comanda, Fecha_Hora_Apertura, Canal) VALUES ('com', '2030-01-01', 'BARRA');
            INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo)
            VALUES ('pago', 'com', '2030-01-01', 'Efectivo', 100, 'COBRO');").unwrap();
        for metodo in ["Otro", "bizum", ""] {
            assert!(conn.execute("UPDATE Pagos SET Metodo_Pago = ?1 WHERE ID_Pago = 'pago';", params![metodo]).is_err());
        }
        conn.execute_batch("INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo, ID_Pago_Origen, Motivo_Devolucion)
            VALUES ('dev', 'com', '2030-01-01', 'Otro', -50, 'DEVOLUCION', 'pago', 'Devuelto');").unwrap();
        assert_eq!(scalar_i64(&conn, "SELECT COUNT(*) FROM Pagos;"), 2);
    }

    /// El origen de una reserva es un valor cerrado también al editarla, y un `INSERT OR IGNORE`
    /// no se lo salta (que es por lo que RI-48 usa triggers y no CHECK).
    #[test]
    fn ri48_el_origen_de_una_reserva_no_admite_otro_valor_ni_al_editar() {
        let (conn, _dir) = open_temp();
        run(&conn).unwrap();
        conn.execute_batch(
            "INSERT INTO Reservas (ID_Reserva, Dia_YMD, Hora, Turno, Estado, Origen) \
             VALUES ('r1', '2030-01-01', '21:00', 'CENA', 'PROXIMA', 'WEB');",
        )
        .unwrap();

        let al_editar = conn.execute("UPDATE Reservas SET Origen = 'APP' WHERE ID_Reserva = 'r1';", []);
        assert!(al_editar.unwrap_err().to_string().contains("RI48"));
        let sin_ruido = conn.execute(
            "INSERT OR IGNORE INTO Reservas (ID_Reserva, Dia_YMD, Hora, Turno, Estado, Origen) \
             VALUES ('r2', '2030-01-01', '21:00', 'CENA', 'PROXIMA', 'web');",
            [],
        );
        assert!(sin_ruido.unwrap_err().to_string().contains("RI48"));

        assert_eq!(scalar_i64(&conn, "SELECT COUNT(*) FROM Reservas;"), 1);
        assert_eq!(
            scalar_i64(&conn, "SELECT COUNT(*) FROM Reservas WHERE Origen = 'WEB';"),
            1,
            "la reserva web conserva su origen"
        );
    }

    /// Borrar una mesa se lleva su configuración de la reserva web: es la cascada de la base, y por
    /// eso la Handy puede borrar una mesa aunque tenga vetadas esas tablas (`TABLAS_SOLO_MAIN`).
    #[test]
    fn borrar_una_mesa_se_lleva_su_configuracion_de_la_reserva_web() {
        let (conn, _dir) = open_temp();
        run(&conn).unwrap();
        conn.execute_batch(
            "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1', 'Salon'); \
             INSERT INTO Mesas (ID_Mesa, ID_Zona, Numero_Mesa, Capacidad, Ubicacion_X, Ubicacion_Y, Shape, Width, Height) \
               VALUES ('m1', 'z1', '1', 4, 0, 0, 'rect', 10, 10), ('m2', 'z1', '2', 2, 0, 0, 'rect', 10, 10); \
             INSERT INTO Reserva_Web_Mesas (ID_Mesa, Activa) VALUES ('m1', 1), ('m2', 1); \
             INSERT INTO Reserva_Web_Franjas (ID_Franja, ID_Mesa, Hora_Desde, Hora_Hasta) \
               VALUES ('f1', 'm1', '13:00', '16:00'), ('f2', 'm2', '13:00', '16:00');",
        )
        .unwrap();

        conn.execute("DELETE FROM Mesas WHERE ID_Mesa = 'm1';", []).unwrap();

        assert_eq!(scalar_i64(&conn, "SELECT COUNT(*) FROM Reserva_Web_Mesas WHERE ID_Mesa = 'm1';"), 0);
        assert_eq!(scalar_i64(&conn, "SELECT COUNT(*) FROM Reserva_Web_Franjas WHERE ID_Mesa = 'm1';"), 0);
        assert_eq!(scalar_i64(&conn, "SELECT COUNT(*) FROM Reserva_Web_Mesas;"), 1, "la otra mesa no se toca");
        assert_eq!(scalar_i64(&conn, "SELECT COUNT(*) FROM Reserva_Web_Franjas;"), 1);
    }

    /// M-086: el esquema de `main` no trae lo de Veri\*factu que sólo usaba la remisión a la AEAT
    /// (la cola de envío, las anomalías, el control de flujo, las marcas de una subsanación de un
    /// rechazo y el modo prueba). Vuelven con la rama `con-verifactu` (VF-VUELTA).
    #[test]
    fn el_esquema_no_trae_lo_de_la_remision_a_la_aeat() {
        let (conn, _dir) = open_temp();
        run(&conn).unwrap();
        assert_eq!(
            scalar_i64(&conn, "SELECT COUNT(*) FROM sqlite_master WHERE name LIKE '\\_Verifactu\\_%' ESCAPE '\\';"),
            0,
            "las tablas _Verifactu_* son de la remisión a la AEAT"
        );
        for (tabla, columna) in [
            ("Registros_Facturacion", "Rechazo_Previo"),
            ("Registros_Facturacion", "Sin_Registro_Previo"),
            ("Registros_Facturacion", "Subsana_ID_Registro"),
            ("Business_Settings", "Modo_Prueba"),
        ] {
            let n = scalar_i64(
                &conn,
                &format!("SELECT COUNT(*) FROM pragma_table_info('{tabla}') WHERE name = '{columna}';"),
            );
            assert_eq!(n, 0, "{tabla}.{columna} es de la remisión a la AEAT");
        }
    }

    /// 1) Creación limpia: BD vacía → se construye el esquema y quedan registradas todas las
    ///    migraciones, cada una con su hash SHA-256 y timestamp > 0.
    #[test]
    fn smoke_clean_create() {
        let (conn, dir) = open_temp();

        run(&conn).expect("las migraciones deben aplicarse en una BD limpia");

        let total = scalar_i64(&conn, "SELECT COUNT(*) FROM _migrations;");
        let expected = migration_files().len() as i64;
        assert_eq!(total, expected, "debe registrarse una fila por cada migración");

        // Verificar que 0001 está registrada con hash válido.
        let fila = conn
            .query_row(
                "SELECT name, hash, applied_at FROM _migrations WHERE name='0001_inicial.sql';",
                [],
                |f| Ok((f.get::<_, Value>(0)?, f.get::<_, Value>(1)?, f.get::<_, Value>(2)?)),
            )
            .optional()
            .unwrap()
            .expect("debe existir la fila 0001");
        let (Value::Text(name), Value::Text(hash), Value::Integer(applied_at)) = fila else {
            panic!("la fila de 0001 tiene tipos inesperados");
        };
        assert_eq!(name, "0001_inicial.sql");
        assert_eq!(hash.len(), 64, "el hash debe ser SHA-256 en hex");
        assert!(applied_at > 0);

        // Las tablas del esquema se crearon de verdad.
        assert!(table_exists(&conn, "Roles").unwrap());
        assert!(table_exists(&conn, "Usuarios").unwrap());

        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `0004_producto_sin_categoria.sql` reconstruye `Productos` en una base con datos: las hijas
    /// con `ON DELETE CASCADE` (lotes, alérgenos, ingredientes) y las líneas vendidas no se pierden
    /// con el `DROP`, y después un producto ya puede quedarse sin categoría.
    #[test]
    fn reconstruir_productos_conserva_lo_que_cuelga_de_ellos() {
        let (conn, dir) = open_temp();
        run(&conn).unwrap();
        conn.execute_batch(
            "INSERT INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('cat', 'Bar');
             INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta) VALUES ('p', 'cat', 'Cafe', 130);
             INSERT INTO Lotes_Producto (ID_Lote, ID_Producto, Codigo_Lote, Stock_Disponible, Fecha_Entrada)
               VALUES ('lote', 'p', 'L-1', 4, '2026-01-01 10:00:00');
             INSERT INTO Producto_Alergenos (ID_Producto, ID_Alergeno) VALUES ('p', '00000000-0000-7000-8000-000000000201');
             INSERT INTO Categorias_Ingrediente (ID_Categoria_Ingrediente, Nombre) VALUES ('ci', 'Leche');
             INSERT INTO Ingredientes (ID_Ingrediente, ID_Categoria_Ingrediente, Nombre) VALUES ('i', 'ci', 'Avena');
             INSERT INTO Producto_Ingredientes (ID_Producto, ID_Ingrediente) VALUES ('p', 'i');
             INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura, Estado) VALUES ('c', 'BARRA', '2026-01-02 12:00:00', 'Pagada');
             INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Nombre_Producto, Cantidad, Precio_Unitario)
               VALUES ('d', 'c', 'p', 'Cafe', 1, 130);
             DELETE FROM _migrations WHERE name = '0004_producto_sin_categoria.sql';",
        )
        .unwrap();

        run(&conn).expect("la reconstrucción se aplica sobre una base con datos");

        for (que, sql, esperado) in [
            ("lotes", "SELECT COUNT(*) FROM Lotes_Producto WHERE ID_Producto = 'p';", 1),
            ("alérgenos", "SELECT COUNT(*) FROM Producto_Alergenos WHERE ID_Producto = 'p';", 1),
            ("ingredientes", "SELECT COUNT(*) FROM Producto_Ingredientes WHERE ID_Producto = 'p';", 1),
            ("líneas vendidas", "SELECT COUNT(*) FROM Detalle_Comanda WHERE ID_Producto = 'p';", 1),
            ("stock de la vista", "SELECT Stock_Actual FROM v_inventario_producto_stock WHERE ID_Producto = 'p';", 4),
        ] {
            assert_eq!(scalar_i64(&conn, sql), esperado, "{que}");
        }
        conn.execute_batch("UPDATE Productos SET ID_Categoria = NULL WHERE ID_Producto = 'p';").unwrap();

        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 2) Idempotencia: re-ejecutar no falla, no duplica filas y NO re-aplica (no toca applied_at).
    #[test]
    fn smoke_idempotent() {
        let (conn, dir) = open_temp();

        run(&conn).unwrap();
        let first_name = migration_files()
            .into_iter()
            .next()
            .map(|(n, _)| n)
            .expect("debe haber al menos una migración");
        let q = format!("SELECT applied_at FROM _migrations WHERE name='{first_name}';");
        let applied_at_1 = scalar_i64(&conn, &q);

        // Segunda pasada: debe detectar que todas las migraciones ya están aplicadas y saltarlas.
        run(&conn).expect("re-ejecutar no debe fallar");

        assert_eq!(
            scalar_i64(&conn, "SELECT COUNT(*) FROM _migrations;"),
            migration_files().len() as i64,
        );
        let applied_at_2 = scalar_i64(&conn, &q);
        assert_eq!(applied_at_1, applied_at_2, "no debe re-aplicarse la migración");

        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 3) Anti-tampering: si el hash guardado no coincide con el del fichero (simulando que la
    ///    migración se modificó tras aplicarse), el runner falla con error duro y no continúa.
    #[test]
    fn smoke_tamper_detected() {
        let (conn, dir) = open_temp();

        run(&conn).unwrap();

        // Corromper el hash registrado (equivale a editar el .sql ya aplicado).
        conn.execute(
            "UPDATE _migrations SET hash='hash_manipulado' WHERE name='0001_inicial.sql';",
            [],
        )
        .unwrap();

        let err = run(&conn).expect_err("debe detectar la manipulación");
        let msg = format!("{err}").to_lowercase();
        assert!(msg.contains("0001_inicial.sql"), "el error debe nombrar la migración: {msg}");
        assert!(msg.contains("modificada"), "el error debe indicar manipulación: {msg}");

        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Vuelca el esquema resultante (tablas/índices/triggers/vistas), normalizado, para comparar
    /// contra el snapshot. Excluye internos de SQLite y la tabla de control `_migrations`.
    fn dump_schema(conn: &Connection) -> String {
        let mut stmt = conn
            .prepare(
                "SELECT sql FROM sqlite_master \
                 WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name <> '_migrations' \
                 ORDER BY type, name;",
            )
            .unwrap();
        let filas = stmt.query_map([], |fila| fila.get::<_, Value>(0)).unwrap();
        let mut out = String::new();
        for fila in filas {
            if let Value::Text(sql) = fila.unwrap() {
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
    #[test]
    fn schema_snapshot_no_drift() {
        let (conn, dir) = open_temp();
        run(&conn).unwrap();
        let dump = dump_schema(&conn);
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

        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// RI-65: ninguna columna de clave primaria admite NULL. En SQLite sólo una `INTEGER PRIMARY
    /// KEY` de una columna (el alias del rowid) lo impide por sí misma; cualquier otra —una de
    /// texto, o una parte de una clave compuesta— lo admite si no lleva `NOT NULL`, y admite
    /// varios, porque en un índice único los NULL son distintos. Ya pasó: un lote nacía con
    /// `ID_Lote` NULL, invisible para el FEFO. Una tabla nueva que se olvide del `NOT NULL` se
    /// pone roja aquí. (`_migrations` es del runner, no del esquema: la crea cada runner por su
    /// cuenta y sólo la escribe él.)
    #[test]
    fn ninguna_clave_primaria_admite_null() {
        let (conn, dir) = open_temp();
        run(&conn).unwrap();

        let mut stmt = conn
            .prepare(
                "SELECT m.name || '.' || p.name \
                 FROM sqlite_master m JOIN pragma_table_info(m.name) p \
                 WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' AND m.name <> '_migrations' \
                   AND p.pk > 0 AND p.\"notnull\" = 0 \
                   AND NOT (upper(p.type) = 'INTEGER' \
                            AND (SELECT COUNT(*) FROM pragma_table_info(m.name) x WHERE x.pk > 0) = 1) \
                 ORDER BY 1;",
            )
            .unwrap();
        let sin_not_null: Vec<String> = stmt
            .query_map([], |fila| fila.get::<_, Value>(0))
            .unwrap()
            .filter_map(|fila| match fila.unwrap() {
                Value::Text(col) => Some(col),
                _ => None,
            })
            .collect();
        assert!(
            sin_not_null.is_empty(),
            "estas claves primarias admiten NULL (añádeles NOT NULL): {sin_not_null:?}"
        );

        drop(stmt);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Las columnas `INTEGER` que NO son dinero. Todas las demás tienen que llevar
    /// `CHECK (typeof(col) IN ('integer','null'))` (RI-65). Una columna entera nueva obliga a
    /// decidir: o es dinero y lleva el CHECK, o se añade aquí. Así no hay forma de olvidarse.
    /// Las tablas locales del dispositivo (`_…`) no guardan dinero y no se miran.
    const INTEGER_QUE_NO_ES_DINERO: &[(&str, &[&str])] = &[
        ("Applied_Operations", &["Created_At_Ms", "Applied_At_Ms", "Updated_At_Ms"]),
        (
            "Business_Settings",
            &[
                "Reserva_Duracion_Min", "Reserva_Web_Activa", "Reserva_Web_Dias_Min",
                "Reserva_Web_Dias_Max", "Reserva_Web_Margen_Min", "Reserva_Web_Margen_Plazas",
                "Reserva_No_Vino_Min",
            ],
        ),
        ("Categorias_Producto", &["Vendible", "Pasa_Cocina"]),
        ("Cierre_Denominaciones", &["Unidades"]),
        ("Cuentas_Gastos", &["Pagado_Con_Caja"]),
        ("Fichaje_Dia", &["Turno_Partido"]),
        ("Fichajes", &["Parte", "Cerrado_Automatico"]),
        ("Horario_Predeterminado", &["Weekday", "Orden"]),
        ("Intentos_Login", &["Intentos_Fallidos", "Bloqueado_Hasta_Ms", "Ultimo_Intento_Ms"]),
        ("Mesas", &["Capacidad", "Ubicacion_X", "Ubicacion_Y", "Width", "Height", "Radius"]),
        ("Registros_Facturacion", &["Orden", "Numero"]),
        ("Reserva_Web_Franjas", &["Dias_Semana"]),
        ("Reserva_Web_Mesas", &["Activa"]),
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
        ("Usuarios", &["Requiere_Setup", "Sin_PIN"]),
    ];

    /// RI-65: toda columna de dinero lleva su CHECK de tipo, y ninguna otra lo necesita. Ver
    /// [`INTEGER_QUE_NO_ES_DINERO`].
    #[test]
    fn todas_las_columnas_de_dinero_llevan_su_check() {
        let (conn, dir) = open_temp();
        run(&conn).unwrap();

        let mut stmt = conn
            .prepare(
                "SELECT m.name, p.name, m.sql \
                 FROM sqlite_master m JOIN pragma_table_info(m.name) p \
                 WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' AND m.name NOT LIKE '\\_%' ESCAPE '\\' \
                   AND upper(p.type) = 'INTEGER' \
                   AND NOT (p.pk = 1 AND (SELECT COUNT(*) FROM pragma_table_info(m.name) x WHERE x.pk > 0) = 1) \
                 ORDER BY 1, 2;",
            )
            .unwrap();
        let filas = stmt
            .query_map([], |fila| {
                Ok((fila.get::<_, Value>(0)?, fila.get::<_, Value>(1)?, fila.get::<_, Value>(2)?))
            })
            .unwrap();
        let mut sin_check = Vec::new();
        let mut sobra_en_la_lista = Vec::new();
        for fila in filas {
            let (Value::Text(tabla), Value::Text(col), Value::Text(sql)) = fila.unwrap() else {
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

        drop(stmt);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// RI-65: qué deja pasar el CHECK. Mira el valor ya convertido por la afinidad de la columna,
    /// así que lo que es un entero entra aunque llegue escrito de otra forma, y lo que no lo es se
    /// rechaza. En la Main y en la nube, igual.
    #[test]
    fn el_dinero_solo_admite_enteros() {
        let (conn, dir) = open_temp();
        run(&conn).unwrap();
        conn.execute(
            "INSERT INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('cat', 'Cat');",
            [],
        )
        .unwrap();

        let insertar = |id: &str, precio: Value| {
            conn.execute(
                "INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta) \
                 VALUES (?1, 'cat', ?1, ?2);",
                params![id, precio],
            )
        };

        assert!(insertar("real", Value::Real(2.5)).is_err(), "2.5 no es un importe");
        assert!(insertar("texto", Value::Text("2,50".into())).is_err(), "'2,50' tampoco");
        insertar("entero", Value::Integer(250)).unwrap();
        insertar("real_entero", Value::Real(250.0)).unwrap();
        insertar("texto_entero", Value::Text("250".into())).unwrap();
        insertar("nulo", Value::Null).unwrap();

        let n = conn
            .query_row(
                "SELECT COUNT(*) FROM Productos \
                 WHERE ID_Producto IN ('entero','real_entero','texto_entero') \
                   AND typeof(Precio_Venta) = 'integer' AND Precio_Venta = 250;",
                [],
                |fila| fila.get::<_, Value>(0),
            )
            .unwrap();
        assert_eq!(n, Value::Integer(3), "los tres se guardan como el entero 250");

        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// DB-12: la vista `v_inventario_producto_stock` se reescribio (window functions en vez de
    /// subconsultas correlacionadas). Verifica que su semantica es la misma: SUM de stock (todos los
    /// lotes), caducidad mas proxima (MIN de lotes CON stock) y lote FEFO siguiente (NULLs al final),
    /// incluyendo productos sin lotes y con solo lotes sin stock.
    #[test]
    fn view_inventario_stock_semantica() {
        let (conn, dir) = open_temp();
        run(&conn).unwrap();

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
        .unwrap();

        fn read_view(conn: &Connection, id: &str) -> (f64, Value, Value) {
            let sql = format!(
                "SELECT Stock_Actual, Caducidad_Proxima, Lote_Proximo \
                 FROM v_inventario_producto_stock WHERE ID_Producto='{id}';"
            );
            conn.query_row(&sql, [], |r| {
                let stock = match r.get::<_, Value>(0)? {
                    Value::Integer(n) => n as f64,
                    Value::Real(n) => n,
                    v => panic!("stock inesperado: {v:?}"),
                };
                Ok((stock, r.get::<_, Value>(1)?, r.get::<_, Value>(2)?))
            })
            .unwrap()
        }

        // P1: stock = 5+3+0+2 = 10; caducidad proxima = MIN(con stock) = '2026-06-01' (LB);
        // lote FEFO = LB (menor caducidad entre los que tienen stock). LC (sin stock) se ignora.
        let (stock, cad, lote) = read_view(&conn, "P1");
        assert_eq!(stock, 10.0);
        assert_eq!(cad, Value::Text("2026-06-01".into()));
        assert_eq!(lote, Value::Text("B".into()));

        // P2: sin lotes -> 0 / NULL / NULL.
        let (stock, cad, lote) = read_view(&conn, "P2");
        assert_eq!(stock, 0.0);
        assert_eq!(cad, Value::Null);
        assert_eq!(lote, Value::Null);

        // P3: solo lote sin stock -> 0 / NULL / NULL.
        let (stock, cad, lote) = read_view(&conn, "P3");
        assert_eq!(stock, 0.0);
        assert_eq!(cad, Value::Null);
        assert_eq!(lote, Value::Null);

        drop(conn);
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


// RI-48: los triggers de `0001` cierran métodos y estados.
