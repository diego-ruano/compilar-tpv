//! El contraste diario con la nube (`use_cases::sync::verificar_contra_la_nube`, el cuerpo del job
//! `verificar_nube`), de punta a punta: la nube simulada y el repositorio SQLite real.
//!
//! VERIF-01 · Una Main recién recuperada de la nube tiene la ventana de la fase 1 y el checkpoint
//! en el `Seq` de esa foto: por el marcapáginas está al día, y le falta todo el histórico que la
//! fase 2 todavía no ha bajado. El contraste no puede leer eso como «la nube tiene filas de más».
//!
//! VERIF-02 · El horario: lo que hace cada vuelta del job (`use_cases::verificacion_nube`) con la
//! regla de `tpv_domain::verificacion_nube`, el estado en `_Verificacion_Nube` y el contraste de
//! verdad. La hora la pone el test.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use chrono::TimeZone;
use serde_json::{json, Value as JsonValue};

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::licensing::{PairingService, ResultadoSubidaImagen};
use tpv_application::ports::sync::SyncRepository;
use tpv_application::ports::verificacion_nube::{IntentoVerificacion, VerificacionNubeRepository};
use tpv_application::use_cases::sync::{self as uc_sync, Contraste};
use tpv_application::use_cases::verificacion_nube::{self as uc_verificacion, Momento, Vuelta};
use tpv_contracts::licensing::{
    ApiSignedHeaders, DeviceFirmarEmparejamientoArgs, DeviceIdentity, FirmaDispositivo,
    PairCreateResult,
};
use tpv_contracts::sync::SqlStatement;
use tpv_domain::verificacion_nube::Espera;
use tpv_infra_sqlite::db::Db;
use tpv_infra_sqlite::sync::SqliteSyncRepository;
use tpv_infra_sqlite::verificacion_nube::SqliteVerificacionNube;

// ── Dobles ────────────────────────────────────────────────────────────────────

/// La nube: respuestas preparadas por ruta y lo que se le ha pedido.
#[derive(Default)]
struct Nube {
    respuestas: Mutex<HashMap<String, VecDeque<JsonValue>>>,
    peticiones: Mutex<Vec<String>>,
}

impl Nube {
    fn responde(&self, ruta: &str, cuerpo: JsonValue) {
        self.respuestas.lock().unwrap().entry(ruta.to_string()).or_default().push_back(cuerpo);
    }

    fn pedidas(&self) -> Vec<String> {
        self.peticiones.lock().unwrap().clone()
    }
}

#[async_trait]
impl PairingService for Nube {
    fn device_identity(&self) -> AppResult<DeviceIdentity> {
        unimplemented!()
    }
    fn firmar_hello(&self, _: &str, _: &str) -> AppResult<FirmaDispositivo> {
        unimplemented!()
    }
    fn firmar_emparejamiento(&self, _: DeviceFirmarEmparejamientoArgs) -> AppResult<FirmaDispositivo> {
        unimplemented!()
    }
    fn hora_para_firmar(&self) -> i64 {
        unimplemented!()
    }
    fn handy_set_token(&self, _: &str, _: &str) -> AppResult<()> {
        unimplemented!()
    }
    fn handy_clear_token(&self) -> AppResult<()> {
        unimplemented!()
    }
    fn handy_get_tenant(&self) -> AppResult<Option<String>> {
        unimplemented!()
    }
    fn negocio_de_la_licencia(&self) -> AppResult<Option<String>> {
        Ok(Some("negocio-de-prueba".into()))
    }
    fn tpv_server_signed_headers(&self, _: &str, _: &str, _: &str, _: &[u8]) -> AppResult<ApiSignedHeaders> {
        unimplemented!()
    }
    async fn tpv_server_post_json(&self, _mode: &str, path: &str, _: JsonValue) -> AppResult<JsonValue> {
        self.peticiones.lock().unwrap().push(path.to_string());
        let siguiente = self.respuestas.lock().unwrap().get_mut(path).and_then(|cola| cola.pop_front());
        siguiente.ok_or_else(|| AppError::external(format!("respuesta no prevista para {path}")))
    }
    async fn pair_create(&self) -> AppResult<PairCreateResult> {
        unimplemented!()
    }
    async fn upload_image(&self, _: &str, _: &str, _: &str, _: Vec<u8>, _: &str) -> AppResult<ResultadoSubidaImagen> {
        unimplemented!()
    }
    async fn delete_image(&self, _: &str, _: &str) -> AppResult<()> {
        unimplemented!()
    }
    async fn download_image(&self, _: &str, _: &str) -> AppResult<Option<Vec<u8>>> {
        unimplemented!()
    }
}

// ── Ayudantes ─────────────────────────────────────────────────────────────────

async fn base(nombre: &str) -> (Arc<SqliteSyncRepository>, Arc<Db>, PathBuf) {
    let marca = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let dir = std::env::temp_dir()
        .join("tpv_tests")
        .join(format!("contraste-{nombre}-{}-{marca}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
    (Arc::new(SqliteSyncRepository::new(db.clone())), db, dir)
}

async fn cerrar(db: Arc<Db>, dir: PathBuf) {
    let _ = db.cerrar().await;
    drop(db);
    let _ = std::fs::remove_dir_all(&dir);
}

/// Estado de partida: por `raw()`, que no deja nada en el outbox.
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

/// Las sentencias de las reparaciones encoladas (`main_reparacion`), que es lo que sube a la nube.
async fn reparaciones(repo: &SqliteSyncRepository) -> Vec<SqlStatement> {
    repo.outbox_pending(100)
        .await
        .unwrap()
        .into_iter()
        .filter(|e| e.command_name == "main_reparacion")
        .flat_map(|e| e.statements)
        .collect()
}

// ── La nube de un negocio con tres cierres de caja, dos de ellos fuera de la ventana ──────────

/// `Periodo_Desde` va porque dos cierres vigentes no pueden empezar en el mismo sitio (RI-58).
const COLUMNAS_CIERRE: [&str; 3] = ["ID_Cierre", "Fecha_Hora", "Periodo_Desde"];

/// `/v1/sync/bootstrap`: la fase 1 trae el cierre de ayer y dice que la tabla viene recortada.
fn volcado_de_la_fase_1() -> JsonValue {
    json!({
        "ok": true, "seq": 40, "totalFilas": 1,
        "tablas": [{
            "nombre": "Cierres_Caja", "columnas": COLUMNAS_CIERRE,
            "filas": [["cierre-de-ayer", "2026-11-12 02:00:00", "2026-04-30 02:00:00"]],
            "parcial": true,
        }],
        "backfill": ["Cierres_Caja"],
    })
}

/// `/v1/sync/historico`: la fase 2 trae la tabla entera, la ventana incluida.
fn pagina_del_historico() -> JsonValue {
    json!({
        "tabla": "Cierres_Caja", "columnas": COLUMNAS_CIERRE,
        "filas": [
            ["cierre-de-marzo", "2026-03-31 02:00:00", null],
            ["cierre-de-abril", "2026-04-30 02:00:00", "2026-03-31 02:00:00"],
            ["cierre-de-ayer", "2026-11-12 02:00:00", "2026-04-30 02:00:00"],
        ],
        "siguiente_cursor": null,
    })
}

/// Lo que contesta la nube a un contraste: tres cierres, y sus claves si se las piden.
fn la_nube_contesta_al_contraste(nube: &Nube) {
    nube.responde(
        "/v1/sync/verificar",
        json!({
            "conteos": [{ "nombre": "Cierres_Caja", "filas": 3 }],
            "ventana": [], "ventana_omitida": false, "desde": "", "hasta_seq": 40,
        }),
    );
    nube.responde(
        "/v1/sync/verificar-claves",
        json!({ "tablas": [{
            "nombre": "Cierres_Caja", "columnas": ["ID_Cierre"],
            "claves": [["cierre-de-marzo"], ["cierre-de-abril"], ["cierre-de-ayer"]],
            "truncada": false,
        }] }),
    );
    nube.responde("/v1/sync/salud", json!({ "ok": true }));
}

#[tokio::test]
async fn recien_recuperada_el_contraste_no_borra_de_la_nube_lo_que_el_historico_no_ha_traido() {
    let (repo, db, dir) = base("historico").await;
    let nube = Nube::default();

    // Fase 1 de la recuperación: entra la ventana y el checkpoint queda en el `Seq` de la foto.
    nube.responde("/v1/sync/bootstrap", volcado_de_la_fase_1());
    uc_sync::bootstrap_desde_nube(&nube, repo.as_ref()).await.unwrap();
    assert_eq!(repo.get_checkpoint().await.unwrap(), 40);
    assert_eq!(numero(&db, "SELECT COUNT(*) FROM Cierres_Caja;").await, 1);
    assert_eq!(uc_sync::backfill_estado(repo.as_ref()).await.unwrap().tablas_pendientes, 1);

    // El contraste, con el histórico a medias: los dos cierres antiguos «sobran» arriba y el
    // checkpoint alcanza la foto. No se pide nada a la nube ni sale nada hacia ella.
    la_nube_contesta_al_contraste(&nube);
    let pasada = uc_sync::verificar_contra_la_nube(&nube, repo.as_ref(), true).await.unwrap();
    assert!(matches!(pasada, Contraste::HistoricoPendiente), "{pasada:?}");
    assert_eq!(nube.pedidas(), vec!["/v1/sync/bootstrap"], "ni la foto ni las claves");
    assert!(reparaciones(&repo).await.is_empty(), "ningún borrado sube a la nube");

    // Fase 2: el backfill trae los cierres antiguos y la cola queda vacía.
    nube.responde("/v1/sync/historico", pagina_del_historico());
    uc_sync::backfill_paso(&nube, repo.as_ref()).await.unwrap();
    assert_eq!(uc_sync::backfill_estado(repo.as_ref()).await.unwrap().tablas_pendientes, 0);
    assert_eq!(numero(&db, "SELECT COUNT(*) FROM Cierres_Caja;").await, 3);

    // Ahora sí se contrasta, y cuadra: no hay nada que borrar ni que subir.
    let r = uc_sync::verificar_contra_la_nube(&nube, repo.as_ref(), true)
        .await
        .unwrap()
        .hecho()
        .expect("con el histórico completo se compara");
    assert!(r.descuadres.is_empty(), "{:?}", r.descuadres);
    assert_eq!((r.reparadas, r.borradas, r.aplazado), (0, 0, false));
    assert!(reparaciones(&repo).await.is_empty());

    cerrar(db, dir).await;
}

#[tokio::test]
async fn aunque_se_llegue_a_comparar_con_el_historico_a_medias_no_se_borra_arriba() {
    // La segunda guarda, por si el contraste llega al repositorio con la cola del backfill sin
    // vaciar (otro camino que no sea el caso de uso): `puede_borrar_arriba` dice que no.
    let (repo, db, dir) = base("historico-repo").await;
    let nube = Nube::default();
    nube.responde("/v1/sync/bootstrap", volcado_de_la_fase_1());
    uc_sync::bootstrap_desde_nube(&nube, repo.as_ref()).await.unwrap();

    let claves: tpv_contracts::sync::VerificacionClaves = serde_json::from_value(json!({ "tablas": [{
        "nombre": "Cierres_Caja", "columnas": ["ID_Cierre"],
        "claves": [["cierre-de-marzo"], ["cierre-de-abril"], ["cierre-de-ayer"]],
        "truncada": false,
    }] }))
    .unwrap();
    let (descuadres, reparadas, borradas, aplazado) =
        SyncRepository::contrastar_claves(repo.as_ref(), claves, 40, true).await.unwrap();

    assert_eq!(descuadres[0].sobran, 2, "se ve lo que falta por bajar");
    assert_eq!((reparadas, borradas, aplazado), (0, 0, true));
    assert!(reparaciones(&repo).await.is_empty());

    cerrar(db, dir).await;
}

// ── VERIF-02: el horario del contraste, con la regla, el estado y el contraste de verdad ─────────

const MIN: i64 = 60 * 1000;
const HORA: i64 = 60 * MIN;

/// Un mediodía de invierno (hora UTC): lejos de un cambio de horario en cualquier zona.
const MEDIODIA: i64 = 1_768_478_400_000;

/// Una Main operativa, arrancada hace una hora, en el instante `ahora_ms`.
fn momento(ahora_ms: i64) -> Momento {
    Momento { ahora_ms, desde_el_arranque_ms: HORA, main_operativa: true }
}

/// La hora local que la base guardaría para ese instante.
fn hora_local(ms: i64) -> String {
    chrono::Local.timestamp_millis_opt(ms).unwrap().format("%Y-%m-%d %H:%M:%S").to_string()
}

/// Una Main con una zona, el checkpoint en 40 y la última escritura en `ultima_escritura_ms`.
async fn main_al_dia(db: &Arc<Db>, ultima_escritura_ms: i64) {
    sembrar(
        db,
        &format!(
            "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1', 'Terraza');
             UPDATE _Sync_State SET Last_Seq = 40 WHERE Id = 1;
             INSERT INTO _Sync_Applied_Ops (Op_Id, Seq, Applied_At_Ms) VALUES ('op-vieja', 40, {ultima_escritura_ms});"
        ),
    )
    .await;
}

/// La caja se cierra en `ms`: el cierre y la escritura que lo deja.
async fn cerrar_la_caja(db: &Arc<Db>, ms: i64) {
    sembrar(
        db,
        &format!(
            "INSERT INTO Cierres_Caja (ID_Cierre, Fecha_Hora, Periodo_Desde) VALUES ('cierre-{ms}', '{}', '{}');
             INSERT INTO _Sync_Applied_Ops (Op_Id, Seq, Applied_At_Ms) VALUES ('op-cierre-{ms}', 0, {ms});",
            hora_local(ms),
            hora_local(ms - 12 * HORA),
        ),
    )
    .await;
}

/// La nube contesta a un contraste que cuadra: la zona de la Main, con `hasta_seq`.
fn la_nube_cuadra(nube: &Nube, hasta_seq: i64) {
    nube.responde(
        "/v1/sync/verificar",
        json!({
            "conteos": [{ "nombre": "Zonas", "filas": 1 }],
            "ventana": [{ "nombre": "Zonas", "columnas": ["ID_Zona", "Nombre_Zona"], "filas": [["z1", "Terraza"]] }],
            "ventana_omitida": false, "desde": "", "hasta_seq": hasta_seq,
        }),
    );
    nube.responde("/v1/sync/salud", json!({ "ok": true }));
}

async fn vuelta(
    nube: &Nube,
    repo: &SqliteSyncRepository,
    estado: &SqliteVerificacionNube,
    m: Momento,
) -> AppResult<Vuelta> {
    uc_verificacion::verificar_si_toca(nube, repo, estado, m, true).await
}

#[tokio::test]
async fn tras_el_cierre_de_caja_contrasta_en_cuanto_hay_calma_y_no_vuelve_a_hacerlo_sin_motivo() {
    let (repo, db, dir) = base("horario-cierre").await;
    let estado = SqliteVerificacionNube::new(db.clone());
    let nube = Nube::default();
    main_al_dia(&db, MEDIODIA - 3 * HORA).await;
    // Una pasada buena hace tres horas, para que el único motivo sea el cierre.
    estado.anotar(IntentoVerificacion::Hecha, MEDIODIA - 3 * HORA).await.unwrap();
    cerrar_la_caja(&db, MEDIODIA).await;

    // A los 4 min del cierre todavía no hay motivo; a los 7 hay motivo pero no calma. Nada sale.
    for (minutos, espera) in [(4, Espera::SinMotivo), (7, Espera::ActividadReciente), (14, Espera::ActividadReciente)] {
        let v = vuelta(&nube, &repo, &estado, momento(MEDIODIA + minutos * MIN)).await.unwrap();
        assert!(matches!(v, Vuelta::NoToca(e) if e == espera), "a los {minutos} min: {v:?}");
    }
    assert!(nube.pedidas().is_empty(), "mientras no toca no se pide nada a la nube");

    // Al cuarto de hora de la última escritura, contrasta.
    la_nube_cuadra(&nube, 40);
    let v = vuelta(&nube, &repo, &estado, momento(MEDIODIA + 16 * MIN)).await.unwrap();
    let Vuelta::Hecha(r) = v else { panic!("tenía que contrastar: {v:?}") };
    assert!(r.descuadres.is_empty());
    assert_eq!(nube.pedidas(), vec!["/v1/sync/verificar", "/v1/sync/salud"]);
    assert_eq!(estado.situacion().await.unwrap().ultima_ok_ms, Some(MEDIODIA + 16 * MIN));

    // Y hasta que haya otro cierre o pasen veinte horas, no vuelve a pedir nada.
    for horas in [1, 10, 19] {
        let v = vuelta(&nube, &repo, &estado, momento(MEDIODIA + horas * HORA)).await.unwrap();
        assert!(matches!(v, Vuelta::NoToca(Espera::SinMotivo)), "a las {horas} h: {v:?}");
    }
    assert_eq!(nube.pedidas().len(), 2);

    // A las veinte horas, otra vez.
    la_nube_cuadra(&nube, 40);
    let v = vuelta(&nube, &repo, &estado, momento(MEDIODIA + 16 * MIN + 20 * HORA)).await.unwrap();
    assert!(matches!(v, Vuelta::Hecha(_)), "{v:?}");

    cerrar(db, dir).await;
}

#[tokio::test]
async fn con_algo_pendiente_de_subir_o_recien_arrancada_no_contrasta() {
    let (repo, db, dir) = base("horario-ocupada").await;
    let estado = SqliteVerificacionNube::new(db.clone());
    let nube = Nube::default();
    main_al_dia(&db, MEDIODIA - 3 * HORA).await;

    // Nunca se ha contrastado, así que toca; pero la aplicación lleva dos minutos arrancada.
    let recien = Momento { desde_el_arranque_ms: 2 * MIN, ..momento(MEDIODIA) };
    let v = vuelta(&nube, &repo, &estado, recien).await.unwrap();
    assert!(matches!(v, Vuelta::NoToca(Espera::ArranqueReciente)), "{v:?}");

    // Con una operación sin subir tampoco.
    sembrar(
        &db,
        "INSERT INTO _Sync_Outbox (Op_Id, Command_Name, Statements_Json, Created_At_Ms) VALUES ('op-1', 'main_op', '[]', 1);",
    )
    .await;
    let v = vuelta(&nube, &repo, &estado, momento(MEDIODIA)).await.unwrap();
    assert!(matches!(v, Vuelta::NoToca(Espera::SubidaPendiente)), "{v:?}");

    // Ni sin estar operativa (una recuperación en curso).
    let recuperando = Momento { main_operativa: false, ..momento(MEDIODIA) };
    let v = vuelta(&nube, &repo, &estado, recuperando).await.unwrap();
    assert!(matches!(v, Vuelta::NoToca(Espera::NoOperativa)), "{v:?}");

    assert!(nube.pedidas().is_empty());
    assert_eq!(estado.situacion().await.unwrap().ultimo_intento_ms, None, "no ha habido ningún intento");

    cerrar(db, dir).await;
}

#[tokio::test]
async fn con_el_historico_a_medias_el_horario_ni_lo_intenta() {
    // VERIF-01, visto desde el job: recién recuperada, por mucho que lleve sin contrastar.
    let (repo, db, dir) = base("horario-historico").await;
    let estado = SqliteVerificacionNube::new(db.clone());
    let nube = Nube::default();
    nube.responde("/v1/sync/bootstrap", volcado_de_la_fase_1());
    uc_sync::bootstrap_desde_nube(&nube, repo.as_ref()).await.unwrap();

    let v = vuelta(&nube, &repo, &estado, momento(MEDIODIA + 30 * 24 * HORA)).await.unwrap();
    assert!(matches!(v, Vuelta::NoToca(Espera::HistoricoPendiente)), "{v:?}");
    assert_eq!(nube.pedidas(), vec!["/v1/sync/bootstrap"]);

    cerrar(db, dir).await;
}

#[tokio::test]
async fn un_fallo_de_la_nube_espera_su_propia_escalera() {
    let (repo, db, dir) = base("horario-fallo").await;
    let estado = SqliteVerificacionNube::new(db.clone());
    let nube = Nube::default();
    main_al_dia(&db, MEDIODIA - 3 * HORA).await;

    // La nube no contesta (el doble no tiene respuesta preparada): el intento falla y se anota.
    assert!(vuelta(&nube, &repo, &estado, momento(MEDIODIA)).await.is_err());
    let s = estado.situacion().await.unwrap();
    assert_eq!((s.ultima_ok_ms, s.ultimo_intento_ms, s.fallos), (None, Some(MEDIODIA), 1));
    assert_eq!(nube.pedidas().len(), 1);

    // Las vueltas siguientes (el motor vuelve al minuto, y luego cada cuarto de hora) no piden nada.
    for minutos in [1, 15, 29] {
        let v = vuelta(&nube, &repo, &estado, momento(MEDIODIA + minutos * MIN)).await.unwrap();
        assert!(matches!(v, Vuelta::NoToca(Espera::Reintento)), "a los {minutos} min: {v:?}");
    }
    assert_eq!(nube.pedidas().len(), 1, "no se martillea a una nube caída");

    // A la media hora se reintenta; si vuelve a fallar, la espera siguiente es de una hora.
    assert!(vuelta(&nube, &repo, &estado, momento(MEDIODIA + 30 * MIN)).await.is_err());
    assert_eq!(estado.situacion().await.unwrap().fallos, 2);
    let v = vuelta(&nube, &repo, &estado, momento(MEDIODIA + 30 * MIN + 59 * MIN)).await.unwrap();
    assert!(matches!(v, Vuelta::NoToca(Espera::Reintento)), "{v:?}");

    // Y cuando contesta, la cuenta vuelve a cero.
    la_nube_cuadra(&nube, 40);
    let v = vuelta(&nube, &repo, &estado, momento(MEDIODIA + 30 * MIN + 60 * MIN)).await.unwrap();
    assert!(matches!(v, Vuelta::Hecha(_)), "{v:?}");
    let s = estado.situacion().await.unwrap();
    assert_eq!((s.ultima_ok_ms, s.fallos), (Some(MEDIODIA + 90 * MIN), 0));

    cerrar(db, dir).await;
}

#[tokio::test]
async fn si_la_foto_va_por_delante_no_se_compara_y_se_reintenta_a_los_diez_minutos() {
    let (repo, db, dir) = base("horario-foto").await;
    let estado = SqliteVerificacionNube::new(db.clone());
    let nube = Nube::default();
    main_al_dia(&db, MEDIODIA - 3 * HORA).await;

    // La nube tiene una zona que una Handy acaba de crear (Seq 41) y que aquí aún no ha bajado.
    // Comparar diría que sobra arriba; lo que pasa es que está de camino.
    nube.responde(
        "/v1/sync/verificar",
        json!({
            "conteos": [{ "nombre": "Zonas", "filas": 2 }],
            "ventana": [], "ventana_omitida": false, "desde": "", "hasta_seq": 41,
        }),
    );
    let v = vuelta(&nube, &repo, &estado, momento(MEDIODIA)).await.unwrap();
    assert!(matches!(v, Vuelta::Aplazada), "{v:?}");
    assert_eq!(nube.pedidas(), vec!["/v1/sync/verificar"], "ni las claves ni el informe");
    assert!(reparaciones(&repo).await.is_empty());
    let s = estado.situacion().await.unwrap();
    assert_eq!((s.ultima_ok_ms, s.ultimo_intento_ms, s.fallos), (None, Some(MEDIODIA), 0), "no es un fallo");

    // A los 9 min todavía espera; a los 10, con el cambio ya bajado, contrasta y cuadra.
    let v = vuelta(&nube, &repo, &estado, momento(MEDIODIA + 9 * MIN)).await.unwrap();
    assert!(matches!(v, Vuelta::NoToca(Espera::Reintento)), "{v:?}");
    sembrar(
        &db,
        "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z-handy', 'Barra');
         UPDATE _Sync_State SET Last_Seq = 41 WHERE Id = 1;",
    )
    .await;
    nube.responde(
        "/v1/sync/verificar",
        json!({
            "conteos": [{ "nombre": "Zonas", "filas": 2 }],
            "ventana": [], "ventana_omitida": false, "desde": "", "hasta_seq": 41,
        }),
    );
    nube.responde("/v1/sync/salud", json!({ "ok": true }));
    let v = vuelta(&nube, &repo, &estado, momento(MEDIODIA + 10 * MIN)).await.unwrap();
    let Vuelta::Hecha(r) = v else { panic!("tenía que contrastar: {v:?}") };
    assert!(r.descuadres.is_empty(), "{:?}", r.descuadres);

    cerrar(db, dir).await;
}

#[tokio::test]
async fn a_las_48_horas_bastan_cinco_minutos_de_calma() {
    let (repo, db, dir) = base("horario-48h").await;
    let estado = SqliteVerificacionNube::new(db.clone());
    let nube = Nube::default();
    main_al_dia(&db, MEDIODIA - 6 * MIN).await;

    // Con la última pasada hace 47 h, seis minutos sin escribir no bastan.
    estado.anotar(IntentoVerificacion::Hecha, MEDIODIA - 47 * HORA).await.unwrap();
    let v = vuelta(&nube, &repo, &estado, momento(MEDIODIA)).await.unwrap();
    assert!(matches!(v, Vuelta::NoToca(Espera::ActividadReciente)), "{v:?}");

    // Hace 48 h, sí.
    estado.anotar(IntentoVerificacion::Hecha, MEDIODIA - 48 * HORA).await.unwrap();
    la_nube_cuadra(&nube, 40);
    let v = vuelta(&nube, &repo, &estado, momento(MEDIODIA)).await.unwrap();
    assert!(matches!(v, Vuelta::Hecha(_)), "{v:?}");

    cerrar(db, dir).await;
}
