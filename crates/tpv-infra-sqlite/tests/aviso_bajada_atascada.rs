//! SYNC-36 · El aviso de lo que la nube ha cambiado y lleva una semana sin poder escribirse en esta
//! Main, con SQLite real: la base, el panel de salud y las notificaciones de verdad.
//!
//! Un cambio hecho desde una Handy que esta Main no pudo aplicar, con las filas que tocaba inciertas o
//! dudosas, no se cierra nunca solo, y mientras esté ahí el contraste diario con la nube no repara
//! nada; uno que la salida ya ha intentado traer y sigue ahí (SYNC-38), tampoco. Y una fila apuntada
//! para traerla de la nube que no entra (SYNC-38) se queda apuntada y el contraste no la toca. A los
//! 7 días se avisa al administrador, una vez (con su clave), sin bloquear nada; y el aviso se cierra
//! en cuanto la situación desaparece (recuperar el estado actual de la nube vacía las cuarentenas y lo
//! apuntado).

use std::path::PathBuf;
use std::sync::Arc;

use tpv_application::ports::sync::SyncRepository;
use tpv_application::use_cases::sync as uc_sync;
use tpv_infra_sqlite::db::Db;
use tpv_infra_sqlite::ejecutor::Value;
use tpv_infra_sqlite::notificaciones::SqliteNotificacionesRepository;
use tpv_infra_sqlite::sync::SqliteSyncRepository;
use tpv_infra_sqlite::util::now_ms;

const DIA_MS: i64 = 24 * 60 * 60 * 1000;

fn dir_temporal() -> PathBuf {
    let sello = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let d = std::env::temp_dir()
        .join("tpv_tests")
        .join(format!("bajada-atascada-{}-{sello}", std::process::id()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// Una cuarentena de bajada apartada hace `dias` días, con sus filas como diga `filas_json`; si la
/// salida ya la ha intentado, `intentada`.
async fn cuarentena(db: &Db, op: &str, dias: i64, filas_json: Option<&str>, apartada: bool, intentada: bool) {
    let cuando = now_ms() - dias * DIA_MS;
    let w = db.write().await;
    w.raw()
        .execute(
            "INSERT INTO _Sync_Failed (Op_Id, Seq, Statements_Json, Attempts, Quarantined, Last_Error, \
             First_Failed_At_Ms, Last_Failed_At_Ms, Filas_Json, Ultima_Salida_Ms) VALUES (?1, 1, '[]', 5, ?2, 'x', ?3, ?3, ?4, ?5);",
            vec![
                Value::Text(op.into()),
                Value::Integer(apartada as i64),
                Value::Integer(cuando),
                filas_json.map_or(Value::Null, |f| Value::Text(f.into())),
                if intentada { Value::Integer(now_ms()) } else { Value::Null },
            ],
        )
        .await
        .unwrap();
}

/// Una fila apuntada para traerla de la nube hace `dias` días, que no ha entrado `intentos` veces.
async fn apuntada(db: &Db, clave: &str, dias: i64, intentos: i64) {
    let w = db.write().await;
    w.raw()
        .execute(
            "INSERT INTO _Sync_Por_Contrastar (Tabla, Clave_Json, Seq, Desde_Ms, Intentos) VALUES ('Zonas', json_array(?1), 1, ?2, ?3);",
            vec![Value::Text(clave.into()), Value::Integer(now_ms() - dias * DIA_MS), Value::Integer(intentos)],
        )
        .await
        .unwrap();
}

async fn avisos(db: &Db) -> Vec<(String, String)> {
    let r = db.read().await;
    let mut filas = r
        .conn()
        .query(
            "SELECT Estado, Accion FROM Notificaciones WHERE Clave_Dedupe = 'bajada_atascada' ORDER BY Creada_En, rowid;",
            (),
        )
        .await
        .unwrap();
    let mut out = Vec::new();
    while let Some(f) = filas.next().await.unwrap() {
        out.push((f.get::<String>(0).unwrap(), f.get::<String>(1).unwrap()));
    }
    out
}

const INCIERTA: &str = r#"{"tablas":["Comandas"],"incierto":true,"por_filtro":["*"],"dudosa":false,"filas":[]}"#;
const DUDOSA: &str = r#"{"tablas":["Productos"],"incierto":false,"por_filtro":["Lotes_Producto"],"dudosa":true,"filas":[{"tabla":"Productos","clave":["p1"],"borrada":false}]}"#;
const CIERTA: &str = r#"{"tablas":["Mesas"],"incierto":false,"por_filtro":[],"dudosa":false,"filas":[{"tabla":"Mesas","clave":["m1"],"borrada":false}]}"#;

async fn abrir() -> (PathBuf, Arc<Db>, SqliteSyncRepository, SqliteNotificacionesRepository) {
    let dir = dir_temporal();
    // Una base operativa: `Db::open` aplica las migraciones de verdad sin el cerrojo de la
    // recuperación (sin usuarios, `init_main_db` la abriría como datos perdidos).
    let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
    let repo = SqliteSyncRepository::new(db.clone());
    let notif = SqliteNotificacionesRepository::new(db.clone());
    (dir, db, repo, notif)
}

async fn cerrar(dir: PathBuf, db: Arc<Db>, repo: SqliteSyncRepository, notif: SqliteNotificacionesRepository) {
    drop(repo);
    drop(notif);
    db.cerrar().await.unwrap();
    drop::<Arc<Db>>(db);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn una_cuarentena_que_no_sale_avisa_a_la_semana_una_vez_y_se_cierra_al_resolverse() {
    let (dir, db, repo, notif) = abrir().await;

    // Lo que no cuenta: una que sale sola (sus filas se saben) y que la salida no ha intentado
    // nunca, una incierta de hace dos días y un cambio que todavía se reintenta.
    cuarentena(&db, "cierta-vieja-sin-intentar", 10, Some(CIERTA), true, false).await;
    cuarentena(&db, "incierta-reciente", 2, Some(INCIERTA), true, true).await;
    cuarentena(&db, "reintentandose", 10, Some(INCIERTA), false, false).await;
    assert_eq!(repo.health().await.unwrap().bajada_atascada, 0);
    assert!(!uc_sync::avisar_bajada_atascada(&repo, &notif).await.unwrap());
    assert!(avisos(&db).await.is_empty());

    // Una incierta, una dudosa y una sin filas apuntadas, de hace más de una semana: atascadas. Y
    // (SYNC-38) una cierta que la salida ya ha intentado y sigue ahí.
    cuarentena(&db, "incierta-vieja", 8, Some(INCIERTA), true, false).await;
    cuarentena(&db, "dudosa-vieja", 9, Some(DUDOSA), true, false).await;
    cuarentena(&db, "sin-filas", 30, None, true, false).await;
    cuarentena(&db, "cierta-que-no-entra", 8, Some(CIERTA), true, true).await;
    assert_eq!(repo.health().await.unwrap().bajada_atascada, 4);

    // Un aviso, con la salida, y sólo uno por más que se mire.
    assert!(uc_sync::avisar_bajada_atascada(&repo, &notif).await.unwrap());
    assert!(uc_sync::avisar_bajada_atascada(&repo, &notif).await.unwrap());
    assert_eq!(avisos(&db).await, vec![("activa".to_string(), "ver_conectividad".to_string())]);
    // El texto se parte en el fuente; en la notificación no quedan los espacios del sangrado.
    let cuerpo = {
        let r = db.read().await;
        let mut filas = r
            .conn()
            .query("SELECT Cuerpo FROM Notificaciones WHERE Clave_Dedupe = 'bajada_atascada';", ())
            .await
            .unwrap();
        filas.next().await.unwrap().unwrap().get::<String>(0).unwrap()
    };
    assert!(!cuerpo.contains("  "), "{cuerpo}");
    assert!(cuerpo.contains("TPV principal: en él pueden verse datos distintos"), "{cuerpo}");

    // Recuperar el estado de la nube vacía las cuarentenas: el aviso se cierra solo.
    {
        let w = db.write().await;
        w.raw().execute("DELETE FROM _Sync_Failed;", ()).await.unwrap();
    }
    assert!(!uc_sync::avisar_bajada_atascada(&repo, &notif).await.unwrap());
    assert_eq!(avisos(&db).await, vec![("resuelta".to_string(), "ver_conectividad".to_string())]);

    cerrar(dir, db, repo, notif).await;
}

#[tokio::test]
async fn una_fila_apuntada_que_no_entra_avisa_a_la_semana_con_el_mismo_aviso_y_se_cierra_al_traer_la_nube() {
    // SYNC-38: la convergencia la reintenta como mucho una vez por minuto y no la retira (el
    // contraste no la toca, y retirarla dejaría subir lo de aquí encima del orden de la nube).
    let (dir, db, repo, notif) = abrir().await;

    // Lo que no cuenta: una de hace dos días que no entra, y una de hace diez que no se ha podido
    // intentar (el equipo sin conexión) o que acaba de tocar otro cambio.
    apuntada(&db, "z-reciente", 2, 6).await;
    apuntada(&db, "z-sin-intentar", 10, 0).await;
    assert_eq!(repo.health().await.unwrap().bajada_atascada, 0);
    assert!(!uc_sync::avisar_bajada_atascada(&repo, &notif).await.unwrap());

    // Dos que llevan más de una semana sin entrar, y una cuarentena atascada: un solo aviso.
    apuntada(&db, "z-1", 8, 1).await;
    apuntada(&db, "z-2", 9, 40).await;
    assert_eq!(repo.health().await.unwrap().bajada_atascada, 2);
    assert!(uc_sync::avisar_bajada_atascada(&repo, &notif).await.unwrap());
    cuarentena(&db, "incierta-vieja", 8, Some(INCIERTA), true, false).await;
    assert_eq!(repo.health().await.unwrap().bajada_atascada, 3);
    assert!(uc_sync::avisar_bajada_atascada(&repo, &notif).await.unwrap());
    assert_eq!(avisos(&db).await, vec![("activa".to_string(), "ver_conectividad".to_string())]);

    // Traer el estado actual de la nube vacía lo apuntado y las cuarentenas (`bootstrap_restaurar`):
    // el aviso se cierra solo.
    {
        let w = db.write().await;
        w.raw().execute_batch("DELETE FROM _Sync_Por_Contrastar; DELETE FROM _Sync_Failed;").await.unwrap();
    }
    assert!(!uc_sync::avisar_bajada_atascada(&repo, &notif).await.unwrap());
    assert_eq!(avisos(&db).await, vec![("resuelta".to_string(), "ver_conectividad".to_string())]);

    cerrar(dir, db, repo, notif).await;
}
