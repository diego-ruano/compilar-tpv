//! AUD-02 · Lo que llega de la nube no puede abrir otra base en el disco de la Main.
//!
//! La Main aplica tal cual las sentencias de un `change` (o de un ítem del catch-up) sobre su
//! conexión de escritura. Una sesión que ya no debía ser Main en el `TenantHub` podía dejar en el
//! log un cambio con `ATTACH DATABASE '<ruta>'`, y la Main que se ponía al día a través de él creaba
//! un fichero SQLite, con el texto elegido, en esa ruta. El escritor ya no admite `ATTACH`
//! (`db::sin_attach`).
//!
//! Aquí: el cambio falla sin crear nada, no detiene la bajada para siempre (acaba en cuarentena,
//! como cualquier otro que no entra) y lo que la aplicación hace de verdad con `VACUUM INTO`, las
//! copias locales por las conexiones de lectura, sigue funcionando.
//!
//! Sólo API pública, una base de verdad en `%TEMP%/tpv_tests` y datos ficticios.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tpv_application::ports::sync::SyncRepository;
use tpv_contracts::sync::{SqlStatement, SyncChange};
use tpv_infra_sqlite::connection::init_main_db;
use tpv_infra_sqlite::db::Db;
use tpv_infra_sqlite::ejecutor::Value;
use tpv_infra_sqlite::recovery;
use tpv_infra_sqlite::sync::SqliteSyncRepository;

/// Los intentos que agota un cambio antes de pasar a cuarentena (`sync::MAX_APPLY_ATTEMPTS`).
const INTENTOS_HASTA_LA_CUARENTENA: usize = 5;

const MARCA: &[u8] = b"AUD02-MARCA-ELEGIDA";

fn dir_temporal(nombre: &str) -> PathBuf {
    let sello = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let dir = std::env::temp_dir()
        .join("tpv_tests")
        .join(format!("aud02-{nombre}-{}-{sello}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// La base de una Main en marcha, como la abre el arranque (`init_main_db`).
async fn abrir(nombre: &str) -> (Arc<Db>, SqliteSyncRepository, PathBuf) {
    let dir = dir_temporal(nombre);
    let db = init_main_db(&dir, None).await.unwrap();
    (db.clone(), SqliteSyncRepository::new(db), dir)
}

async fn cerrar(db: Arc<Db>, repo: SqliteSyncRepository, dir: PathBuf) {
    drop(repo);
    db.cerrar().await.unwrap();
    drop(db);
    let _ = std::fs::remove_dir_all(&dir);
}

fn sentencia(sql: impl Into<String>) -> SqlStatement {
    SqlStatement { sql: sql.into(), args: vec![] }
}

fn cambio(op_id: &str, seq: i64, sentencias: Vec<SqlStatement>) -> SyncChange {
    SyncChange { op_id: op_id.into(), seq, statements: sentencias }
}

/// La ruta, lista para ir entre comillas simples en una sentencia.
fn literal(ruta: &Path) -> String {
    ruta.display().to_string().replace('\'', "''")
}

/// El cambio forjado de la investigación: adjunta una ruta del disco y escribe en ella.
fn cambio_con_attach(op_id: &str, seq: i64, ruta: &Path) -> SyncChange {
    cambio(
        op_id,
        seq,
        vec![
            sentencia(format!("ATTACH DATABASE '{}' AS fuera;", literal(ruta))),
            sentencia("CREATE TABLE fuera.t (c TEXT);"),
            sentencia("INSERT INTO fuera.t (c) VALUES ('AUD02-MARCA-ELEGIDA');"),
        ],
    )
}

/// Lo que haya en disco en `ruta` o en sus ficheros auxiliares de SQLite.
fn bytes_en_disco(ruta: &Path) -> Vec<u8> {
    let mut bytes = Vec::new();
    for sufijo in ["", "-wal", "-journal", "-shm"] {
        let mut nombre = ruta.as_os_str().to_owned();
        nombre.push(sufijo);
        bytes.extend(std::fs::read(PathBuf::from(nombre)).unwrap_or_default());
    }
    bytes
}

async fn entero(db: &Db, sql: &str) -> i64 {
    let r = db.read().await;
    let mut filas = r.conn().query(sql, ()).await.unwrap();
    match filas.next().await.unwrap().unwrap().get_value(0).unwrap() {
        Value::Integer(n) => n,
        otro => panic!("se esperaba un entero: {otro:?}"),
    }
}

#[tokio::test]
async fn un_cambio_remoto_con_attach_falla_sin_crear_el_fichero() {
    let (db, repo, dir) = abrir("attach").await;
    let fuera = dir.join("fuera.txt");

    let r = repo.apply_changes(vec![cambio_con_attach("forjada-attach", 1, &fuera)]).await.unwrap();

    assert!(r.aplicadas.is_empty(), "el cambio no entra");
    assert_eq!(r.detenida.as_ref().map(|d| d.op_id.as_str()), Some("forjada-attach"));
    assert_eq!(repo.get_checkpoint().await.unwrap(), 0, "ni mueve el checkpoint");
    assert_eq!(
        entero(&db, "SELECT COUNT(*) FROM _Sync_Failed WHERE Op_Id = 'forjada-attach' AND Last_Error LIKE '%too many attached databases%';").await,
        1,
        "queda anotado con el motivo: el escritor no adjunta bases"
    );

    // Se suelta la base (cierra las conexiones y vuelca el WAL) para mirar lo que quedó en disco.
    cerrar_sin_borrar(db, repo).await;
    assert!(!fuera.exists(), "no se ha creado el fichero");
    assert!(bytes_en_disco(&fuera).is_empty(), "ni ninguno de sus auxiliares");
    let _ = std::fs::remove_dir_all(&dir);
}

async fn cerrar_sin_borrar(db: Arc<Db>, repo: SqliteSyncRepository) {
    drop(repo);
    db.cerrar().await.unwrap();
    drop(db);
}

#[tokio::test]
async fn el_attach_forjado_acaba_en_cuarentena_y_la_bajada_sigue() {
    // Un ítem así en el log no puede parar la réplica de la Main para siempre: agota sus intentos
    // como cualquier cambio que no entra, pasa a cuarentena y lo siguiente se aplica.
    let (db, repo, dir) = abrir("cuarentena").await;
    let fuera = dir.join("fuera.txt");
    let forjado = cambio_con_attach("forjada-attach", 1, &fuera);

    for intento in 1..=INTENTOS_HASTA_LA_CUARENTENA {
        let r = repo.apply_changes(vec![forjado.clone()]).await.unwrap();
        assert!(r.aplicadas.is_empty(), "intento {intento}: no entra");
    }
    assert_eq!(repo.get_checkpoint().await.unwrap(), 1, "en cuarentena, el checkpoint pasa por encima");
    assert_eq!(
        entero(&db, "SELECT Quarantined FROM _Sync_Failed WHERE Op_Id = 'forjada-attach';").await,
        1
    );

    let r = repo
        .apply_changes(vec![cambio(
            "legitima",
            2,
            vec![sentencia("INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('zona-aud02', 'Terraza');")],
        )])
        .await
        .unwrap();
    assert_eq!(r.aplicadas, vec!["legitima".to_string()]);
    assert_eq!(repo.get_checkpoint().await.unwrap(), 2);

    cerrar_sin_borrar(db, repo).await;
    assert!(bytes_en_disco(&fuera).is_empty(), "en ningún intento se ha escrito nada fuera");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn un_cambio_remoto_con_vacuum_into_tampoco_escribe_un_fichero() {
    // La otra forma de escribir una base en una ruta elegida. No entra por dos motivos: va dentro
    // de la transacción del cambio, y `VACUUM` adjunta su destino por dentro.
    let (db, repo, dir) = abrir("vacuum").await;
    let fuera = dir.join("copia-fuera.db");

    let r = repo
        .apply_changes(vec![cambio(
            "forjada-vacuum",
            1,
            vec![sentencia(format!("VACUUM INTO '{}';", literal(&fuera)))],
        )])
        .await
        .unwrap();

    assert!(r.aplicadas.is_empty());
    assert_eq!(repo.get_checkpoint().await.unwrap(), 0);
    cerrar_sin_borrar(db, repo).await;
    assert!(bytes_en_disco(&fuera).is_empty(), "no se ha escrito la copia");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn el_escritor_no_adjunta_bases_y_las_copias_locales_siguen_funcionando() {
    let (db, repo, dir) = abrir("copias").await;
    let fuera = dir.join("fuera.db");

    // El escritor, directamente: ni dentro ni fuera de una transacción.
    {
        let w = db.write().await;
        let e = w
            .raw()
            .execute(&format!("ATTACH DATABASE '{}' AS fuera;", literal(&fuera)), ())
            .await
            .expect_err("el escritor no adjunta bases");
        assert!(e.to_string().contains("too many attached databases"), "{e}");
    }
    assert!(!fuera.exists());

    // Lo legítimo: la copia local diaria (`VACUUM INTO` por una conexión de lectura), con datos
    // escritos después de abrir, y su restauración preparada, que la valida como base.
    {
        let w = db.write().await;
        w.raw()
            .execute("INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('zona-aud02', 'Terraza');", ())
            .await
            .unwrap();
    }
    let copia = recovery::create_backup(&db, &dir).await.unwrap().expect("la base está operativa: hay copia");
    assert_eq!(recovery::list_backups(&dir).unwrap().len(), 1);
    let preparada = recovery::prepare_restore(&dir, &copia.id, None).await.unwrap();
    let bytes = std::fs::read(&preparada).unwrap();
    assert!(bytes.starts_with(b"SQLite format 3"), "la copia es una base SQLite");
    assert!(
        bytes.windows(b"Terraza".len()).any(|w| w == b"Terraza"),
        "con lo que había en la base"
    );
    assert!(!bytes.windows(MARCA.len()).any(|w| w == MARCA));
    recovery::discard_prepared(&preparada);

    cerrar(db, repo, dir).await;
}
