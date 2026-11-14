//! SYNC-36 · La salida de una cuarentena de bajada, de punta a punta: el repositorio SQLite real y
//! la nube del contraste de los tests (`comun::nube_de_contraste`, que contesta
//! `/v1/sync/verificar/*` como el worker sobre una base propia).
//!
//! Lo que la Handy escribió y aquí no entró (un alta, un cambio, un borrado, una hija cuyo padre está
//! en otra cuarentena, un padre y su hija en el mismo cambio) se trae de la nube por estado en la
//! pasada del contraste, y en cuanto no queda ninguna cuarentena el contraste repara. Lo que sigue
//! sin entrar se queda, y nada se trae con una foto de la nube de otro momento. Y a los 30 días sus
//! datos se vacían, la barrera sigue y la salida funciona igual.
//!
//! «Una versión anterior» la hacen unos triggers que rechazan lo que la nube ya acepta: es lo que
//! pasa cuando la nube escribe algo que esta versión de la Main todavía no sabe guardar.

mod comun;

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{json, Value as JsonValue};

use comun::nube_de_contraste::{NubeDeContraste, Paginas};
use tpv_application::ports::sync::{ContrasteLocal, SyncRepository};
use tpv_application::use_cases::sync as uc_sync;
use tpv_contracts::sync::{ResultadoVerificacion, SqlStatement, SyncChange};
use tpv_infra_sqlite::db::Db;
use tpv_infra_sqlite::ejecutor::Value;
use tpv_infra_sqlite::sync::SqliteSyncRepository;

// ── Ayudantes ─────────────────────────────────────────────────────────────────

async fn base(nombre: &str) -> (Arc<SqliteSyncRepository>, Arc<Db>, PathBuf) {
    let marca = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let dir = std::env::temp_dir()
        .join("tpv_tests")
        .join(format!("salida-{nombre}-{}-{marca}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
    (Arc::new(SqliteSyncRepository::new(db.clone())), db, dir)
}

async fn cerrar(db: Arc<Db>, dir: PathBuf, nube: NubeDeContraste) {
    nube.cerrar().await;
    let _ = db.cerrar().await;
    drop(db);
    let _ = std::fs::remove_dir_all(&dir);
}

/// Por `raw()`, que no deja nada en el outbox.
async fn sembrar(db: &Arc<Db>, sql: &str) {
    let w = db.write().await;
    w.raw().execute_batch(sql).await.unwrap();
}

async fn numero(db: &Arc<Db>, sql: &str) -> i64 {
    let r = db.read().await;
    let mut filas = r.conn().query(sql, ()).await.unwrap();
    let fila = filas.next().await.unwrap().expect("una fila");
    fila.get::<i64>(0).unwrap()
}

async fn textos(db: &Arc<Db>, sql: &str) -> Vec<String> {
    let r = db.read().await;
    let mut filas = r.conn().query(sql, ()).await.unwrap();
    let mut salida = Vec::new();
    while let Some(f) = filas.next().await.unwrap() {
        salida.push(match f.get_value(0).unwrap() {
            Value::Text(t) => t,
            Value::Null => "NULL".into(),
            otro => format!("{otro:?}"),
        });
    }
    salida
}

const MESA: &str = "INSERT INTO Mesas (ID_Mesa, ID_Zona, Numero_Mesa, Capacidad, Ubicacion_X, Ubicacion_Y, \
     Shape, Width, Height) VALUES (?1, ?2, ?3, 4, 0, 0, 'rect', 80, 80);";

/// Lo que hay en las dos bases antes de nada.
const NEGOCIO: &str = "
    INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1', 'Terraza'), ('z2', 'Salón');
    INSERT INTO Mesas (ID_Mesa, ID_Zona, Numero_Mesa, Capacidad, Ubicacion_X, Ubicacion_Y, Shape, Width, Height)
         VALUES ('m1', 'z1', '1', 4, 0, 0, 'rect', 80, 80), ('m2', 'z1', '2', 2, 0, 0, 'rect', 80, 80),
                ('m3', 'z2', '7', 6, 0, 0, 'rect', 80, 80);
";

/// Lo que esta versión de la Main no sabe guardar y la nube sí.
const VERSION_ANTERIOR: &str = "
    CREATE TRIGGER anterior_alta BEFORE INSERT ON Zonas WHEN NEW.Nombre_Zona LIKE 'Bodega%'
      BEGIN SELECT RAISE(ABORT, 'version_anterior'); END;
    CREATE TRIGGER anterior_nombre BEFORE UPDATE ON Zonas WHEN NEW.Nombre_Zona = 'Salón grande'
      BEGIN SELECT RAISE(ABORT, 'version_anterior'); END;
    CREATE TRIGGER anterior_borrado BEFORE DELETE ON Mesas WHEN OLD.ID_Mesa = 'm1'
      BEGIN SELECT RAISE(ABORT, 'version_anterior'); END;
";

fn cambio(op: &str, seq: i64, sentencias: Vec<(&str, Vec<JsonValue>)>) -> SyncChange {
    SyncChange {
        op_id: op.into(),
        seq,
        statements: sentencias.into_iter().map(|(sql, args)| SqlStatement { sql: sql.into(), args }).collect(),
    }
}

/// Lo que escribe la Handy, del `Seq` 31 al 35: un alta, una hija de esa alta, un cambio, un borrado,
/// y un padre y su hija en el mismo cambio (la hija primero).
fn de_la_handy() -> Vec<SyncChange> {
    vec![
        cambio("op-31", 31, vec![("INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES (?1, ?2);", vec![json!("zb"), json!("Bodega")])]),
        cambio("op-32", 32, vec![(MESA, vec![json!("mb"), json!("zb"), json!("40")])]),
        cambio("op-33", 33, vec![("UPDATE Zonas SET Nombre_Zona = ?2 WHERE ID_Zona = ?1;", vec![json!("z2"), json!("Salón grande")])]),
        cambio("op-34", 34, vec![("DELETE FROM Mesas WHERE ID_Mesa = ?1;", vec![json!("m1")])]),
        cambio(
            "op-35",
            35,
            vec![
                (MESA, vec![json!("mc"), json!("zc"), json!("50")]),
                ("INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES (?1, ?2);", vec![json!("zc"), json!("Bodega 2")]),
            ],
        ),
    ]
}

/// Aplica un cambio hasta que entra o pasa a cuarentena, como el motor de réplica.
async fn bajar(repo: &SqliteSyncRepository, ch: &SyncChange) {
    for _ in 0..10 {
        repo.apply_changes(vec![ch.clone()]).await.unwrap();
        if repo.get_checkpoint().await.unwrap() >= ch.seq {
            return;
        }
    }
    panic!("{} ni entra ni pasa a cuarentena", ch.op_id);
}

/// Una Main con la versión anterior que ha recibido los cambios de la Handy (los cinco en
/// cuarentena), y la nube con todos aplicados. El checkpoint y el log de la nube, en 35.
async fn escenario(nombre: &str) -> (Arc<SqliteSyncRepository>, Arc<Db>, PathBuf, NubeDeContraste) {
    let (repo, db, dir) = base(nombre).await;
    sembrar(&db, NEGOCIO).await;
    sembrar(&db, VERSION_ANTERIOR).await;
    sembrar(&db, "UPDATE _Sync_State SET Last_Seq = 30 WHERE Id = 1;").await;
    for ch in de_la_handy() {
        bajar(&repo, &ch).await;
    }
    assert_eq!(numero(&db, "SELECT COUNT(*) FROM _Sync_Failed WHERE Quarantined = 1;").await, 5);

    let nube = NubeDeContraste::nueva(nombre).await;
    nube.sembrar(NEGOCIO).await;
    for ch in de_la_handy() {
        nube.aplicar(&ch.statements).await;
    }
    *nube.hasta_seq.lock().unwrap() = 35;
    *nube.ultimo_ajeno.lock().unwrap() = 35;
    (repo, db, dir, nube)
}

async fn pasada(repo: &SqliteSyncRepository, nube: &NubeDeContraste, reparar: bool) -> ContrasteLocal {
    let marca = repo.contraste_marca().await.unwrap();
    let resumen = nube.resumen_para(marca.checkpoint).await;
    repo.contrastar_con_la_nube(resumen, marca, &Paginas(nube), reparar).await.unwrap()
}

fn hecha(c: ContrasteLocal) -> ResultadoVerificacion {
    match c {
        ContrasteLocal::Hecho(r) => r,
        ContrasteLocal::SeHaMovido => panic!("se tenía que comparar"),
    }
}

async fn reparaciones(repo: &SqliteSyncRepository) -> usize {
    repo.outbox_pending(1_000).await.unwrap().len()
}

async fn en_cuarentena(db: &Arc<Db>) -> Vec<String> {
    textos(db, "SELECT Op_Id FROM _Sync_Failed WHERE Quarantined = 1 ORDER BY Seq;").await
}

/// Esta base, tabla a tabla, como la de la nube.
async fn como_la_nube(db: &Arc<Db>, nube: &NubeDeContraste) {
    for sql in [
        "SELECT ID_Zona || ':' || Nombre_Zona FROM Zonas ORDER BY ID_Zona;",
        "SELECT ID_Mesa || ':' || ID_Zona FROM Mesas ORDER BY ID_Mesa;",
    ] {
        assert_eq!(textos(db, sql).await, textos(&nube.db, sql).await, "{sql}");
    }
}

// ── La salida ─────────────────────────────────────────────────────────────────

#[tokio::test]
async fn lo_que_no_entro_se_trae_de_la_nube_y_al_no_quedar_cuarentenas_el_contraste_repara() {
    let (repo, db, dir, nube) = escenario("salida").await;
    // Lo que tocó cada uno, sabido al fallar.
    let filas = textos(&db, "SELECT Filas_Json FROM _Sync_Failed ORDER BY Seq;").await;
    assert!(filas[3].contains("\"m1\"") && filas[3].contains("\"borrada\":true"), "{}", filas[3]);
    assert!(filas[4].contains("\"mc\"") && filas[4].contains("\"zc\""), "{}", filas[4]);

    // Con la versión anterior nada entra: todo se queda, nada se repara ni sube, y esta base sigue
    // como estaba.
    let r = hecha(pasada(&repo, &nube, true).await);
    assert_eq!((r.reparadas, r.borradas, r.aplazado), (0, 0, true));
    assert_eq!(en_cuarentena(&db).await, vec!["op-31", "op-32", "op-33", "op-34", "op-35"]);
    assert_eq!(reparaciones(&repo).await, 0);
    assert_eq!(numero(&db, "SELECT COUNT(*) FROM Mesas WHERE ID_Mesa = 'm1';").await, 1);

    // La versión nueva ya lo sabe guardar: las cinco salen en la misma pasada, la hija detrás de su
    // padre, y como no queda ninguna, el contraste compara y no encuentra nada que reparar.
    sembrar(&db, "DROP TRIGGER anterior_alta; DROP TRIGGER anterior_nombre; DROP TRIGGER anterior_borrado;").await;
    let r = hecha(pasada(&repo, &nube, true).await);
    assert!(en_cuarentena(&db).await.is_empty());
    assert_eq!(r.descuadres, vec![], "esta base ya es la de la nube");
    assert_eq!((r.reparadas, r.borradas, r.aplazado), (0, 0, false));
    como_la_nube(&db, &nube).await;
    assert_eq!(textos(&db, "SELECT Nombre_Zona FROM Zonas WHERE ID_Zona = 'z2';").await, vec!["Salón grande"]);
    assert_eq!(numero(&db, "SELECT COUNT(*) FROM Mesas WHERE ID_Mesa = 'm1';").await, 0, "el borrado de la Handy");
    // Sólo se ha escrito aquí: nada sube a la nube.
    assert_eq!(reparaciones(&repo).await, 0);
    assert_eq!(repo.get_checkpoint().await.unwrap(), 35, "el checkpoint no se toca");

    cerrar(db, dir, nube).await;
}

#[tokio::test]
async fn sin_cuarentenas_el_contraste_repara_lo_demas_en_la_misma_pasada() {
    // Lo que la nube tiene distinto por otra cosa (aquí, una mesa que la Main escribió y no subió)
    // se repara en cuanto la barrera se levanta, en la misma pasada.
    let (repo, db, dir, nube) = escenario("y-repara").await;
    sembrar(&db, "DROP TRIGGER anterior_alta; DROP TRIGGER anterior_nombre; DROP TRIGGER anterior_borrado;").await;
    sembrar(&db, "INSERT INTO Mesas (ID_Mesa, ID_Zona, Numero_Mesa, Capacidad, Ubicacion_X, Ubicacion_Y, Shape, Width, Height) VALUES ('m-main', 'z1', '9', 2, 0, 0, 'rect', 80, 80);").await;

    let r = hecha(pasada(&repo, &nube, true).await);

    assert!(en_cuarentena(&db).await.is_empty());
    assert_eq!((r.reparadas, r.borradas, r.aplazado), (1, 0, false), "{:?}", r.descuadres);
    let sube = repo.outbox_pending(1_000).await.unwrap();
    assert!(sube[0].statements[0].args.contains(&json!("m-main")), "{:?}", sube[0].statements);

    cerrar(db, dir, nube).await;
}

#[tokio::test]
async fn lo_que_sigue_sin_entrar_se_queda_y_lo_demas_sale() {
    // Sólo el alta de las bodegas sigue sin entrar: se quedan ella, la mesa que cuelga de ella y el
    // cambio de la otra bodega. El cambio de nombre y el borrado salen. Con tres cuarentenas, el
    // contraste no repara.
    let (repo, db, dir, nube) = escenario("se-queda").await;
    sembrar(&db, "DROP TRIGGER anterior_nombre; DROP TRIGGER anterior_borrado;").await;

    let r = hecha(pasada(&repo, &nube, true).await);
    assert_eq!(en_cuarentena(&db).await, vec!["op-31", "op-32", "op-35"]);
    assert_eq!((r.reparadas, r.borradas, r.aplazado), (0, 0, true));
    assert_eq!(textos(&db, "SELECT Nombre_Zona FROM Zonas WHERE ID_Zona = 'z2';").await, vec!["Salón grande"]);
    assert_eq!(numero(&db, "SELECT COUNT(*) FROM Mesas WHERE ID_Mesa IN ('m1', 'mb', 'mc');").await, 0);
    assert_eq!(numero(&db, "SELECT COUNT(*) FROM Zonas WHERE ID_Zona IN ('zb', 'zc');").await, 0);

    // Y en cuanto entra, salen: la mesa, detrás de su zona.
    sembrar(&db, "DROP TRIGGER anterior_alta;").await;
    let r = hecha(pasada(&repo, &nube, true).await);
    assert!(en_cuarentena(&db).await.is_empty());
    assert_eq!((r.reparadas, r.borradas, r.aplazado), (0, 0, false));
    como_la_nube(&db, &nube).await;

    cerrar(db, dir, nube).await;
}

#[tokio::test]
async fn no_se_trae_nada_con_una_foto_de_la_nube_de_otro_momento() {
    let (repo, db, dir, nube) = escenario("otra-foto").await;
    sembrar(&db, "DROP TRIGGER anterior_alta; DROP TRIGGER anterior_nombre; DROP TRIGGER anterior_borrado;").await;

    // Las filas por clave no son de la foto del resumen: la nube se ha movido entre medias.
    *nube.hasta_seq_de_las_paginas.lock().unwrap() = Some(36);
    assert!(matches!(pasada(&repo, &nube, true).await, ContrasteLocal::SeHaMovido));
    assert_eq!(en_cuarentena(&db).await.len(), 5);
    assert_eq!(numero(&db, "SELECT COUNT(*) FROM Zonas WHERE ID_Zona = 'zb';").await, 0);

    // Una nube cuyo log no llega a lo que esta Main ya ha bajado (una foto anterior a los cambios).
    *nube.hasta_seq_de_las_paginas.lock().unwrap() = None;
    *nube.hasta_seq.lock().unwrap() = 32;
    *nube.ultimo_ajeno.lock().unwrap() = 32;
    assert!(matches!(pasada(&repo, &nube, true).await, ContrasteLocal::SeHaMovido));
    assert_eq!(en_cuarentena(&db).await.len(), 5);

    // Con la reparación apagada (`reparacion_nube`), tampoco se trae nada.
    *nube.hasta_seq.lock().unwrap() = 35;
    *nube.ultimo_ajeno.lock().unwrap() = 35;
    let r = hecha(pasada(&repo, &nube, false).await);
    assert_eq!(en_cuarentena(&db).await.len(), 5);
    assert!(r.aplazado);
    assert_eq!(numero(&db, "SELECT COUNT(*) FROM Zonas WHERE ID_Zona = 'zb';").await, 0);
    assert_eq!(textos(&db, "SELECT Nombre_Zona FROM Zonas WHERE ID_Zona = 'z2';").await, vec!["Salón"]);

    cerrar(db, dir, nube).await;
}

#[tokio::test]
async fn lo_que_choca_con_lo_apartado_de_la_subida_se_queda() {
    // La Main cambió la zona 2 y la nube lo rechazó: traer la zona de la nube desharía aquí lo que
    // escribió la Main. Esa cuarentena se queda; las demás salen.
    let (repo, db, dir, nube) = escenario("choca").await;
    sembrar(&db, "DROP TRIGGER anterior_alta; DROP TRIGGER anterior_nombre; DROP TRIGGER anterior_borrado;").await;
    sembrar(
        &db,
        r#"INSERT INTO _Sync_Outbox (Op_Id, Command_Name, Statements_Json, Created_At_Ms, Cuarentena)
           VALUES ('op-main', 'main_op', '[{"sql":"UPDATE Zonas SET Nombre_Zona = ?1 WHERE ID_Zona = ?2;","args":["Salón de la Main","z2"]}]', 1, 1);"#,
    )
    .await;

    let r = hecha(pasada(&repo, &nube, true).await);
    assert_eq!(en_cuarentena(&db).await, vec!["op-33"]);
    assert!(r.aplazado);
    assert_eq!(textos(&db, "SELECT Nombre_Zona FROM Zonas WHERE ID_Zona = 'z2';").await, vec!["Salón"]);

    cerrar(db, dir, nube).await;
}

#[tokio::test]
async fn las_que_siguen_sin_entrar_no_dejan_sin_intentar_a_las_de_detras() {
    // Codex (segunda pasada): 50 que se intentan y siguen sin entrar consumían el cupo de cada pasada,
    // y la 51 no se intentaba nunca. Ahora cada pasada empieza por las que hace más que no se miran.
    let (repo, db, dir) = base("rotan").await;
    sembrar(&db, NEGOCIO).await;
    sembrar(
        &db,
        "CREATE TRIGGER anterior_alta BEFORE INSERT ON Zonas WHEN NEW.Nombre_Zona LIKE 'Bodega%'
           BEGIN SELECT RAISE(ABORT, 'version_anterior'); END;
         CREATE TRIGGER anterior_nombre BEFORE UPDATE ON Zonas WHEN NEW.Nombre_Zona = 'Salón azul'
           BEGIN SELECT RAISE(ABORT, 'version_anterior'); END;
         UPDATE _Sync_State SET Last_Seq = 30 WHERE Id = 1;",
    )
    .await;
    let mut cambios: Vec<SyncChange> = (0..55)
        .map(|i| {
            cambio(
                &format!("op-b{i:02}"),
                31 + i,
                vec![("INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES (?1, ?2);", vec![json!(format!("zb{i:02}")), json!(format!("Bodega {i}"))])],
            )
        })
        .collect();
    cambios.push(cambio("op-azul", 86, vec![("UPDATE Zonas SET Nombre_Zona = ?2 WHERE ID_Zona = ?1;", vec![json!("z2"), json!("Salón azul")])]));
    for ch in &cambios {
        bajar(&repo, ch).await;
    }
    let nube = NubeDeContraste::nueva("rotan").await;
    nube.sembrar(NEGOCIO).await;
    for ch in &cambios {
        nube.aplicar(&ch.statements).await;
    }
    *nube.hasta_seq.lock().unwrap() = 86;
    *nube.ultimo_ajeno.lock().unwrap() = 86;
    // El nombre ya se sabe guardar; las bodegas, no.
    sembrar(&db, "DROP TRIGGER anterior_nombre;").await;

    hecha(pasada(&repo, &nube, true).await);
    assert!(en_cuarentena(&db).await.contains(&"op-azul".to_string()), "la 56 no ha cabido en la primera");
    hecha(pasada(&repo, &nube, true).await);
    let quedan = en_cuarentena(&db).await;
    assert!(!quedan.contains(&"op-azul".to_string()), "en la segunda, sí");
    assert_eq!(quedan.len(), 55);
    assert_eq!(textos(&db, "SELECT Nombre_Zona FROM Zonas WHERE ID_Zona = 'z2';").await, vec!["Salón azul"]);

    cerrar(db, dir, nube).await;
}

#[tokio::test]
async fn lo_apuntado_con_algo_apartado_en_su_tabla_no_se_trae_ni_cuando_lo_apartado_se_retira() {
    // Codex: aquí la mesa m2 es de la zona 2 por una escritura de la Main que la nube rechazó; arriba
    // sigue en la 1. La Handy cambia las mesas de la zona 1 por su zona, y aquí el filtro no ve la m2.
    // Cuando lo apartado se retire, nada dirá que faltaba: la cuarentena se queda para siempre, y el
    // contraste no sube la m2 de la Main encima de lo que hizo la Handy.
    let (repo, db, dir) = base("dudosa").await;
    sembrar(&db, NEGOCIO).await;
    sembrar(&db, "UPDATE Mesas SET ID_Zona = 'z2' WHERE ID_Mesa = 'm2';").await;
    sembrar(
        &db,
        r#"INSERT INTO _Sync_Outbox (Op_Id, Command_Name, Statements_Json, Created_At_Ms, Cuarentena)
           VALUES ('op-main', 'main_op', '[{"sql":"UPDATE Mesas SET ID_Zona = ?1 WHERE ID_Mesa = ?2;","args":["z2","m2"]}]', 1, 1);"#,
    )
    .await;
    sembrar(
        &db,
        "CREATE TRIGGER anterior_capacidad BEFORE UPDATE ON Mesas WHEN NEW.Capacidad = 9
           BEGIN SELECT RAISE(ABORT, 'version_anterior'); END;
         UPDATE _Sync_State SET Last_Seq = 30 WHERE Id = 1;",
    )
    .await;
    let ch = cambio("op-31", 31, vec![("UPDATE Mesas SET Capacidad = 9 WHERE ID_Zona = ?1;", vec![json!("z1")])]);
    bajar(&repo, &ch).await;
    let filas = textos(&db, "SELECT Filas_Json FROM _Sync_Failed;").await;
    assert!(filas[0].contains("\"dudosa\":true"), "{}", filas[0]);

    let nube = NubeDeContraste::nueva("dudosa").await;
    nube.sembrar(NEGOCIO).await;
    nube.aplicar(&ch.statements).await;
    *nube.hasta_seq.lock().unwrap() = 31;
    *nube.ultimo_ajeno.lock().unwrap() = 31;

    // Lo apartado se retira y la versión nueva ya lo sabe guardar.
    sembrar(&db, "DELETE FROM _Sync_Outbox; DROP TRIGGER anterior_capacidad;").await;
    let r = hecha(pasada(&repo, &nube, true).await);
    assert_eq!(en_cuarentena(&db).await, vec!["op-31"]);
    assert!(r.aplazado, "{:?}", r.descuadres);
    assert_eq!(reparaciones(&repo).await, 0, "nada sube encima de lo de la Handy");

    cerrar(db, dir, nube).await;
}

#[tokio::test]
async fn una_incierta_que_ve_algo_apartado_queda_dudosa_aunque_lo_apartado_se_retire_antes_de_saberse() {
    // Codex (tercera pasada): una incierta (una tabla que esta versión aún no tiene) que filtra las
    // mesas. Mientras sigue incierta, la Main aparta un cambio de mesa: cada pasada lo cruza y la
    // marca dudosa. Lo apartado se retira, la versión nueva trae la tabla y ya se sabe qué toca: no
    // se trae, porque lo sacado de aquí pudo no ser lo de arriba.
    let (repo, db, dir) = base("incierta-dudosa").await;
    sembrar(&db, NEGOCIO).await;
    sembrar(&db, "UPDATE _Sync_State SET Last_Seq = 30 WHERE Id = 1;").await;
    let ch = cambio(
        "op-31",
        31,
        vec![
            ("UPDATE Mesas SET Capacidad = 9 WHERE ID_Zona = ?1;", vec![json!("z1")]),
            ("INSERT INTO Tabla_Nueva (ID) VALUES (?1);", vec![json!("x")]),
        ],
    );
    bajar(&repo, &ch).await;
    let nube = NubeDeContraste::nueva("incierta-dudosa").await;
    nube.sembrar(NEGOCIO).await;
    nube.sembrar("CREATE TABLE Tabla_Nueva (ID TEXT NOT NULL PRIMARY KEY);").await;
    nube.aplicar(&ch.statements).await;
    *nube.hasta_seq.lock().unwrap() = 31;
    *nube.ultimo_ajeno.lock().unwrap() = 31;

    sembrar(
        &db,
        r#"INSERT INTO _Sync_Outbox (Op_Id, Command_Name, Statements_Json, Created_At_Ms, Cuarentena)
           VALUES ('op-main', 'main_op', '[{"sql":"UPDATE Mesas SET ID_Zona = ?1 WHERE ID_Mesa = ?2;","args":["z2","m2"]}]', 1, 1);"#,
    )
    .await;
    hecha(pasada(&repo, &nube, true).await);
    assert!(textos(&db, "SELECT Filas_Json FROM _Sync_Failed;").await[0].contains("\"dudosa\":true"));

    sembrar(&db, "DELETE FROM _Sync_Outbox; CREATE TABLE Tabla_Nueva (ID TEXT NOT NULL PRIMARY KEY);").await;
    hecha(pasada(&repo, &nube, true).await);
    let filas = textos(&db, "SELECT Filas_Json FROM _Sync_Failed;").await;
    assert!(filas[0].contains("\"incierto\":false") && filas[0].contains("\"dudosa\":true"), "{}", filas[0]);
    assert_eq!(en_cuarentena(&db).await, vec!["op-31"]);

    cerrar(db, dir, nube).await;
}

#[tokio::test]
async fn los_recalculos_de_las_inciertas_tambien_rotan() {
    // Codex (tercera pasada): de 22 inciertas se recalculaban siempre las mismas 20. Las que no
    // caben no se marcan como miradas, y la pasada siguiente empieza por ellas.
    let (repo, db, dir) = base("recalculos").await;
    sembrar(&db, NEGOCIO).await;
    sembrar(&db, "UPDATE _Sync_State SET Last_Seq = 30 WHERE Id = 1;").await;
    for i in 0..22 {
        bajar(&repo, &cambio(&format!("op-{i:02}"), 31 + i, vec![("INSERT INTO Tabla_Nueva (ID) VALUES (?1);", vec![json!(i)])])).await;
    }
    let nube = NubeDeContraste::nueva("recalculos").await;
    nube.sembrar(NEGOCIO).await;
    *nube.hasta_seq.lock().unwrap() = 52;
    *nube.ultimo_ajeno.lock().unwrap() = 52;

    hecha(pasada(&repo, &nube, true).await);
    assert_eq!(numero(&db, "SELECT COUNT(*) FROM _Sync_Failed WHERE Ultima_Salida_Ms IS NULL;").await, 2, "dos no han cabido");
    hecha(pasada(&repo, &nube, true).await);
    assert_eq!(numero(&db, "SELECT COUNT(*) FROM _Sync_Failed WHERE Ultima_Salida_Ms IS NULL;").await, 0, "y en la siguiente, sí");

    cerrar(db, dir, nube).await;
}

#[tokio::test]
async fn las_que_no_se_pueden_traer_no_dejan_sin_intentar_a_las_de_detras() {
    // Codex: sólo se leían las 50 primeras por `Seq`, y 60 sin filas sabidas delante dejaban fuera
    // para siempre a las de detrás, que sí se podían traer.
    let (repo, db, dir, nube) = escenario("muchas").await;
    sembrar(
        &db,
        "WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < 60)
         INSERT INTO _Sync_Failed (Op_Id, Seq, Statements_Json, Attempts, Quarantined, First_Failed_At_Ms, Last_Failed_At_Ms)
         SELECT printf('vieja-%02d', i), i % 30, '[]', 5, 1, 1, 1 FROM s;",
    )
    .await;
    sembrar(&db, "DROP TRIGGER anterior_alta; DROP TRIGGER anterior_nombre; DROP TRIGGER anterior_borrado;").await;

    let r = hecha(pasada(&repo, &nube, true).await);

    let quedan = en_cuarentena(&db).await;
    assert_eq!(quedan.len(), 60, "{quedan:?}");
    assert!(quedan.iter().all(|op| op.starts_with("vieja-")), "las cinco han salido: {quedan:?}");
    assert_eq!(r.descuadres, vec![], "lo de las cinco ya está aquí");
    como_la_nube(&db, &nube).await;

    cerrar(db, dir, nube).await;
}

// ── Los datos caducan ─────────────────────────────────────────────────────────

#[tokio::test]
async fn a_los_treinta_dias_sus_datos_se_vacian_la_barrera_sigue_y_la_salida_funciona_igual() {
    let (repo, db, dir, nube) = escenario("caducan").await;
    let antes = textos(&db, "SELECT Filas_Json FROM _Sync_Failed ORDER BY Seq;").await;

    // Recién apartadas no se tocan.
    let ahora = tpv_infra_sqlite::util::now_ms();
    assert_eq!(uc_sync::vaciar_cuarentenas_de_bajada(repo.as_ref(), ahora).await.unwrap(), 0);
    // Treinta días después, sí: las sentencias y lo que decía el error, fuera; lo demás, igual.
    let despues = ahora + uc_sync::RETENCION_CUARENTENAS_MS + 1;
    assert_eq!(uc_sync::vaciar_cuarentenas_de_bajada(repo.as_ref(), despues).await.unwrap(), 5);
    assert_eq!(uc_sync::vaciar_cuarentenas_de_bajada(repo.as_ref(), despues).await.unwrap(), 0, "una vez");
    assert_eq!(numero(&db, "SELECT COUNT(*) FROM _Sync_Failed WHERE Statements_Json = '[]' AND Datos_Vaciados_At_Ms IS NOT NULL;").await, 5);
    assert_eq!(textos(&db, "SELECT Filas_Json FROM _Sync_Failed ORDER BY Seq;").await, antes);
    assert_eq!(
        textos(&db, "SELECT Last_Error FROM _Sync_Failed ORDER BY Seq;").await,
        vec!["sentencia #0: otro", "foreign_key", "sentencia #0: otro", "sentencia #0: otro", "sentencia #1: otro"]
    );
    let salud = repo.health().await.unwrap();
    assert_eq!(salud.quarantined, 5, "siguen ahí: son la barrera");
    let r = hecha(pasada(&repo, &nube, true).await);
    assert_eq!((r.reparadas, r.borradas, r.aplazado), (0, 0, true));

    // Sin sentencias, la salida va por las filas que tocaron.
    sembrar(&db, "DROP TRIGGER anterior_alta; DROP TRIGGER anterior_nombre; DROP TRIGGER anterior_borrado;").await;
    let r = hecha(pasada(&repo, &nube, true).await);
    assert!(en_cuarentena(&db).await.is_empty());
    assert!(!r.aplazado);
    como_la_nube(&db, &nube).await;

    cerrar(db, dir, nube).await;
}
