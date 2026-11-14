//! SYNC-36 · El aviso de un cambio de la nube que no puede salir solo de su cuarentena, con SQLite
//! real: la base, el panel de salud y las notificaciones de verdad.
//!
//! Un cambio hecho desde una Handy que esta Main no pudo aplicar, con las filas que tocaba inciertas o
//! dudosas, no se cierra nunca solo, y mientras esté ahí el contraste diario con la nube no repara
//! nada. A los 7 días se avisa al administrador, una vez (con su clave), sin bloquear nada; y el aviso
//! se cierra en cuanto la situación desaparece (recuperar el estado actual de la nube vacía las
//! cuarentenas).

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

/// Una cuarentena de bajada apartada hace `dias` días, con sus filas como diga `filas_json`.
async fn cuarentena(db: &Db, op: &str, dias: i64, filas_json: Option<&str>, apartada: bool) {
    let cuando = now_ms() - dias * DIA_MS;
    let w = db.write().await;
    w.raw()
        .execute(
            "INSERT INTO _Sync_Failed (Op_Id, Seq, Statements_Json, Attempts, Quarantined, Last_Error, \
             First_Failed_At_Ms, Last_Failed_At_Ms, Filas_Json) VALUES (?1, 1, '[]', 5, ?2, 'x', ?3, ?3, ?4);",
            vec![
                Value::Text(op.into()),
                Value::Integer(apartada as i64),
                Value::Integer(cuando),
                filas_json.map_or(Value::Null, |f| Value::Text(f.into())),
            ],
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

#[tokio::test]
async fn una_cuarentena_que_no_puede_salir_sola_avisa_a_la_semana_una_vez_y_se_cierra_al_resolverse() {
    let dir = dir_temporal();
    // Una base operativa: `Db::open` aplica las migraciones de verdad sin el cerrojo de la
    // recuperación (sin usuarios, `init_main_db` la abriría como datos perdidos).
    let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
    let repo = SqliteSyncRepository::new(db.clone());
    let notif = SqliteNotificacionesRepository::new(db.clone());

    // Lo que no cuenta: una que sale sola (sus filas se saben), una incierta de hace dos días y
    // un cambio que todavía se reintenta.
    cuarentena(&db, "cierta-vieja", 10, Some(CIERTA), true).await;
    cuarentena(&db, "incierta-reciente", 2, Some(INCIERTA), true).await;
    cuarentena(&db, "reintentandose", 10, Some(INCIERTA), false).await;
    assert_eq!(repo.health().await.unwrap().bajada_atascada, 0);
    assert!(!uc_sync::avisar_bajada_atascada(&repo, &notif).await.unwrap());
    assert!(avisos(&db).await.is_empty());

    // Una incierta, una dudosa y una sin filas apuntadas, de hace más de una semana: atascadas.
    cuarentena(&db, "incierta-vieja", 8, Some(INCIERTA), true).await;
    cuarentena(&db, "dudosa-vieja", 9, Some(DUDOSA), true).await;
    cuarentena(&db, "sin-filas", 30, None, true).await;
    assert_eq!(repo.health().await.unwrap().bajada_atascada, 3);

    // Un aviso, con la salida, y sólo uno por más que se mire.
    assert!(uc_sync::avisar_bajada_atascada(&repo, &notif).await.unwrap());
    assert!(uc_sync::avisar_bajada_atascada(&repo, &notif).await.unwrap());
    assert_eq!(avisos(&db).await, vec![("activa".to_string(), "ver_conectividad".to_string())]);

    // Recuperar el estado de la nube vacía las cuarentenas: el aviso se cierra solo.
    {
        let w = db.write().await;
        w.raw().execute("DELETE FROM _Sync_Failed;", ()).await.unwrap();
    }
    assert!(!uc_sync::avisar_bajada_atascada(&repo, &notif).await.unwrap());
    assert_eq!(avisos(&db).await, vec![("resuelta".to_string(), "ver_conectividad".to_string())]);

    drop(repo);
    drop(notif);
    db.cerrar().await.unwrap();
    drop::<Arc<Db>>(db);
    let _ = std::fs::remove_dir_all(&dir);
}
