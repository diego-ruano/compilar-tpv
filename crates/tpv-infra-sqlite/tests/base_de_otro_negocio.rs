//! AUD-06 · Una Main con la base de un negocio que activa la licencia de otro, de punta a punta: el
//! caso de uso de la activación y el del arranque sobre la persistencia real (SQLite, el sello de la
//! base y los ficheros de AppData) y el motor de réplica. De la licencia sólo se simula lo que no se
//! puede tocar aquí: el servidor y el almacén de secretos (lo que guarda el adaptador de verdad, lo
//! vigente y lo pendiente, se prueba en `tpv-infra-licensing`). El reinicio del TPV es cerrar la base
//! y hacer lo que hace el arranque: aplicar el cambio pendiente y abrir la base.
//!
//! La regla: **una base sólo se usa con la licencia de su negocio**, y de quién es lo dice ella
//! misma (su sello, `_Negocio`).
//!
//! 1. Activar la licencia de otro negocio la deja pendiente, sin tocar la vigente, anota el cambio y
//!    pide reiniciar. Hasta el reinicio nada del negocio nuevo existe en el proceso: lo que estaba en
//!    marcha, o empieza entonces, sigue siendo del anterior, con su base y sus credenciales. No se
//!    activa nada más (una activación cada vez, y ninguna con el cambio pendiente) ni se purga nada.
//! 2. Al arrancar, antes de abrir nada, se aparta todo lo del equipo (la base si la hay, todas sus
//!    copias y bases guardadas, sus imágenes y su cola) sin borrar ni pisar nada, la licencia pendiente
//!    pasa a vigente y se quita la anotación. El negocio nuevo empieza con una base vacía que trae su
//!    nube.
//! 3. La reconciliación, con el motor real, termina sin subir nada, y el negocio nuevo estrena su
//!    administrador con el PIN inicial.
//!
//! Y lo que no puede romperse: el arranque cortado en cualquier punto (entre sus pasos, a mitad de
//! apartar porque otro programa tiene un fichero bloqueado, o porque una carpeta no se deja recorrer)
//! no abre nada y lo termina el siguiente, sin perder ni pisar nada; una restauración cortada antes
//! del reinicio se aparta igual; y el mismo negocio que vuelve conserva lo suyo.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{json, Value as JsonValue};

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::licensing::{
    BaseDelEquipo, EstadoConsultado, LicensingService, PairingService, ResultadoSubidaImagen,
};
use tpv_application::ports::login::LoginRepository;
use tpv_application::ports::replicacion::{CanalReplicacion, ContextoReplicacion};
use tpv_application::ports::sync::SyncRepository;
use tpv_application::use_cases::{licensing as uc_licencia, replicacion, sync as uc_sync};
use tpv_contracts::licensing::{
    ApiSignedHeaders, DeviceFirmarEmparejamientoArgs, DeviceIdentity, FirmaDispositivo,
    LicenseActivateInput, LicenseActivateOutcome, LicenseLocalState, PairCreateResult,
};
use tpv_contracts::recovery::RecoveryState;
use tpv_contracts::sync::{OutboxFallo, SqlStatement};
use tpv_domain::licensing::{Concesion, FalloConsulta, ResultadoActivacion, Sello, SolicitudActivacion};
use tpv_infra_sqlite::connection::init_main_db;
use tpv_infra_sqlite::db::Db;
use tpv_infra_sqlite::login::SqliteLoginRepository;
use tpv_infra_sqlite::recovery::{self, BaseLocal};
use tpv_infra_sqlite::sello;
use tpv_infra_sqlite::sync::SqliteSyncRepository;
use tpv_infra_sqlite::sync_reparacion::valor_a_json;
use tpv_infra_sqlite::util::ADMIN_USUARIO_ID;

// Un rol de los que siembra 0001_inicial.sql.
const ROL_CAMARERO: &str = "00000000-0000-7000-8000-000000000002";
/// El `Last_Seq` al que llegó esta Main en la nube del negocio anterior.
const CHECKPOINT_DEL_ANTERIOR: i64 = 5000;
/// Hasta dónde llega el log de la nube del negocio nuevo, recién estrenada.
const SEQ_DEL_NUEVO: i64 = 3;
const NEGOCIO_A: &str = "negocio-a";
const NEGOCIO_X: &str = "negocio-x";

/// Lo que el negocio A tiene en `backups/`, de todas las familias, además de su copia diaria.
/// Ninguna puede quedarse.
const COPIAS_DE_A: [&str; 7] = [
    "import-1000.db.gz",
    "antes-de-la-nube-2000.db.gz",
    "antes-de-traslado-3000.db.gz",
    "pre-restore-4000.db",
    "failed-restore-5000.db",
    "ilegible-6000.db",
    ".backup-7000.tmp",
];
/// Y en la raíz de AppData, fuera de la base.
const FUERA_DE_LA_BASE_DE_A: [&str; 5] = [
    "data.db.bak.8000",
    "data.restore.9000.tmp",
    "image_uploads.json",
    "image_backfill_done",
    "images",
];

// ── Dobles ────────────────────────────────────────────────────────────────────

/// La licencia del equipo sin servidor ni almacén de secretos: lo vigente (el estado y de qué
/// negocio son las credenciales), lo pendiente de reinicio y lo que contesta el servidor.
#[derive(Default)]
struct Licencias {
    estado: Mutex<Option<LicenseLocalState>>,
    credenciales_de: Mutex<Option<String>>,
    /// Lo que concedió la última petición y aún no está guardado.
    concedido: Mutex<Option<String>>,
    /// La licencia de otro negocio que espera al arranque: su estado y de qué negocio son sus
    /// credenciales.
    pendiente: Mutex<Option<(LicenseLocalState, String)>>,
    /// Lo que contesta el servidor: el negocio y si dice que la licencia viene de otro equipo.
    respuestas: Mutex<VecDeque<(&'static str, bool)>>,
    /// La escritura que no llega a hacerse, como si el proceso se cortara justo antes.
    corte: Mutex<Option<&'static str>>,
    /// Con ella tomada, la petición de activar espera a que se suelte: una activación en vuelo.
    puerta: tokio::sync::Mutex<()>,
}

impl Licencias {
    /// El negocio de la licencia vigente.
    fn negocio(&self) -> Option<String> {
        self.estado.lock().unwrap().as_ref().map(|s| s.tenant_id.clone())
    }

    fn credenciales(&self) -> Option<String> {
        self.credenciales_de.lock().unwrap().clone()
    }

    /// El negocio de la licencia pendiente y el de sus credenciales.
    fn pendiente(&self) -> Option<(String, String)> {
        self.pendiente.lock().unwrap().as_ref().map(|(st, cred)| (st.tenant_id.clone(), cred.clone()))
    }

    fn cortar_antes_de(&self, que: Option<&'static str>) {
        *self.corte.lock().unwrap() = que;
    }

    fn se_corta(&self, que: &'static str) -> AppResult<()> {
        if *self.corte.lock().unwrap() == Some(que) {
            return Err(AppError::internal(format!("corte antes de escribir: {que}")));
        }
        Ok(())
    }
}

#[async_trait]
impl LicensingService for Licencias {
    fn load_state(&self) -> AppResult<Option<LicenseLocalState>> {
        Ok(self.estado.lock().unwrap().clone())
    }
    fn save_state(&self, state: &LicenseLocalState) -> AppResult<()> {
        self.se_corta("estado")?;
        *self.estado.lock().unwrap() = Some(state.clone());
        Ok(())
    }
    fn delete_state(&self, _: Option<&str>) -> AppResult<()> {
        // Como el adaptador: con la licencia se va su credencial.
        *self.estado.lock().unwrap() = None;
        *self.credenciales_de.lock().unwrap() = None;
        Ok(())
    }
    fn last_rejection(&self) -> AppResult<Option<String>> {
        Ok(None)
    }
    async fn activar_remoto(&self, _: &SolicitudActivacion, _: Option<&str>) -> AppResult<ResultadoActivacion> {
        let (negocio, cambio_de_equipo) =
            self.respuestas.lock().unwrap().pop_front().expect("una respuesta por activación");
        drop(self.puerta.lock().await);
        *self.concedido.lock().unwrap() = Some(negocio.to_string());
        Ok(ResultadoActivacion::Activada(Concesion {
            tenant_id: negocio.into(),
            device_id: "equipo".into(),
            status: "active".into(),
            expires_at: None,
            expires_at_ms: None,
            plan: None,
            cambio_de_equipo,
            tiempo_sumado: false,
        }))
    }
    fn guardar_credenciales(&self) -> AppResult<()> {
        self.se_corta("credenciales")?;
        *self.credenciales_de.lock().unwrap() = self.concedido.lock().unwrap().take();
        Ok(())
    }
    fn guardar_pendiente(&self, estado: &LicenseLocalState) -> AppResult<()> {
        self.se_corta("pendiente")?;
        let credenciales = self.concedido.lock().unwrap().take().expect("algo concedido");
        *self.pendiente.lock().unwrap() = Some((estado.clone(), credenciales));
        Ok(())
    }
    fn negocio_pendiente(&self) -> AppResult<Option<String>> {
        Ok(self.pendiente().map(|(negocio, _)| negocio))
    }
    fn aplicar_pendiente(&self) -> AppResult<()> {
        self.se_corta("aplicar")?;
        if let Some((estado, credenciales)) = self.pendiente.lock().unwrap().take() {
            *self.estado.lock().unwrap() = Some(estado);
            *self.credenciales_de.lock().unwrap() = Some(credenciales);
        }
        Ok(())
    }
    fn descartar_pendiente(&self) -> AppResult<()> {
        *self.pendiente.lock().unwrap() = None;
        Ok(())
    }
    async fn solicitar_cambio_dispositivo(&self, _: &str) -> AppResult<()> {
        unimplemented!()
    }
    async fn consultar_estado(&self, _: &LicenseLocalState) -> Result<EstadoConsultado, FalloConsulta> {
        unimplemented!()
    }
    fn guardar_token(&self, _: &str) {
        unimplemented!()
    }
}

/// La base del equipo vista por el arranque, que puede cortarse antes de apartar o de quitar la
/// anotación del cambio (el corte antes de aplicar la licencia lo hace `Licencias`).
struct BaseQueSeCorta {
    base: BaseLocal,
    corte: Option<&'static str>,
}

impl BaseQueSeCorta {
    fn se_corta(&self, que: &'static str) -> AppResult<()> {
        if self.corte == Some(que) {
            return Err(AppError::internal(format!("corte antes de {que}")));
        }
        Ok(())
    }
}

#[async_trait]
impl BaseDelEquipo for BaseQueSeCorta {
    async fn sello(&self) -> AppResult<Sello> {
        self.base.sello().await
    }
    async fn sellar(&self, negocio: &str) -> AppResult<()> {
        self.base.sellar(negocio).await
    }
    async fn marcar_traslado(&self) -> AppResult<()> {
        self.base.marcar_traslado().await
    }
    async fn marcar_cambio_de_negocio(&self, negocio: &str) -> AppResult<()> {
        self.base.marcar_cambio_de_negocio(negocio).await
    }
    async fn cambio_de_negocio_pendiente(&self) -> AppResult<Option<String>> {
        self.base.cambio_de_negocio_pendiente().await
    }
    async fn apartar_si_no_es_de(&self, negocio: &str) -> AppResult<()> {
        self.se_corta("apartar")?;
        self.base.apartar_si_no_es_de(negocio).await
    }
    async fn quitar_cambio_de_negocio(&self) -> AppResult<()> {
        self.se_corta("quitar")?;
        self.base.quitar_cambio_de_negocio().await
    }
}

/// La nube del negocio de la licencia: su volcado y lo que contesta `/v1/sync/changes`. Firma con
/// las credenciales vigentes, y apunta de qué negocio eran las de cada petición. Con la `puerta`
/// tomada, las peticiones esperan a que se suelte: lo que estaba en marcha.
struct Nube {
    licencias: Arc<Licencias>,
    cambios: Mutex<JsonValue>,
    volcado: Mutex<JsonValue>,
    puerta: tokio::sync::Mutex<()>,
    firmadas_con: Mutex<Vec<Option<String>>>,
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
        Ok(self.licencias.negocio())
    }
    fn tpv_server_signed_headers(&self, _: &str, _: &str, _: &str, _: &[u8]) -> AppResult<ApiSignedHeaders> {
        unimplemented!()
    }
    async fn tpv_server_post_json(&self, _mode: &str, path: &str, _: JsonValue) -> AppResult<JsonValue> {
        drop(self.puerta.lock().await);
        self.firmadas_con.lock().unwrap().push(self.licencias.credenciales());
        match path {
            "/v1/sync/changes" => Ok(self.cambios.lock().unwrap().clone()),
            "/v1/sync/bootstrap" => Ok(self.volcado.lock().unwrap().clone()),
            otro => Err(AppError::external(format!("respuesta no prevista para {otro}"))),
        }
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

/// El contexto del shell sin Tauri: desbloquear es `complete_reconciliation`, como en `completar`.
struct Ctx {
    db: Arc<Db>,
    repo: Arc<SqliteSyncRepository>,
}

#[async_trait]
impl ContextoReplicacion for Ctx {
    async fn repositorio(&self) -> AppResult<Arc<dyn SyncRepository>> {
        Ok(self.repo.clone())
    }
    fn cambios(&self, _: &[SqlStatement]) {}
    fn fase_recuperacion(&self, _: &str) {}
    fn solicitud_emparejamiento(&self) {}
    fn reservas_web(&self) {}
    fn fallo_subida(&self, _: &str, _: &OutboxFallo) {}
    async fn completar_recuperacion(&self, _: i64) -> AppResult<()> {
        recovery::complete_reconciliation(&self.db).await
    }
    async fn sigue_disponible(&self, _: bool) -> AppResult<bool> {
        Ok(false)
    }
    fn volcado_permitido(&self) -> bool {
        false
    }
}

/// El socket: apunta lo que manda la Main y no le llega nada.
#[derive(Default)]
struct Socket {
    enviados: Vec<JsonValue>,
}

#[async_trait]
impl CanalReplicacion for Socket {
    async fn enviar(&mut self, m: JsonValue) -> AppResult<()> {
        self.enviados.push(m);
        Ok(())
    }
    async fn recibir(&mut self, _: Duration) -> AppResult<Option<JsonValue>> {
        Ok(None)
    }
}

// ── Ayudantes ─────────────────────────────────────────────────────────────────

fn dir_temporal(nombre: &str) -> PathBuf {
    let sello = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let d = std::env::temp_dir()
        .join("tpv_tests")
        .join(format!("aud06-{nombre}-{}-{sello}", std::process::id()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

async fn escribir(db: &Db, sql: &str) {
    let w = db.write().await;
    w.raw().execute_batch(sql).await.unwrap();
}

async fn numero(db: &Db, sql: &str) -> i64 {
    let r = db.read().await;
    let mut filas = r.conn().query(sql, ()).await.unwrap();
    let fila = filas.next().await.unwrap().expect("una fila");
    fila.get::<i64>(0).unwrap()
}

async fn estado(db: &Db) -> RecoveryState {
    recovery::status(db).await.unwrap().state
}

async fn sello_de(db: &Db) -> Option<String> {
    sello::leer(&db.read().await).await.unwrap()
}

/// La tabla `Usuarios` tal y como la vuelca la nube: columnas y filas posicionales.
async fn usuarios_como_la_nube(db: &Db) -> (Vec<String>, Vec<Vec<JsonValue>>) {
    let r = db.read().await;
    let mut cols = Vec::new();
    let mut filas = r.conn().query("PRAGMA table_info(\"Usuarios\");", ()).await.unwrap();
    while let Some(f) = filas.next().await.unwrap() {
        cols.push(f.get::<String>(1).unwrap());
    }
    let mut out = Vec::new();
    let mut filas = r.conn().query("SELECT * FROM Usuarios ORDER BY ID_Usuario;", ()).await.unwrap();
    while let Some(f) = filas.next().await.unwrap() {
        out.push((0..cols.len()).map(|i| valor_a_json(&f.get_value(i as i32).unwrap())).collect());
    }
    (cols, out)
}

/// Los nombres de lo que hay en `carpeta`, ordenados.
fn nombres_en(carpeta: &Path) -> Vec<String> {
    let mut out: Vec<String> = std::fs::read_dir(carpeta)
        .map(|it| it.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect())
        .unwrap_or_default();
    out.sort();
    out
}

/// Las carpetas donde se ha apartado lo de otro negocio.
fn apartados(dir: &Path) -> Vec<PathBuf> {
    nombres_en(&dir.join("backups"))
        .into_iter()
        .filter(|n| n.starts_with("negocio-anterior-"))
        .map(|n| dir.join("backups").join(n))
        .collect()
}

/// El negocio del cambio anotado, si lo hay.
fn cambio_anotado(dir: &Path) -> Option<String> {
    recovery::cambio_de_negocio_pendiente(dir)
}

fn entrada() -> LicenseActivateInput {
    LicenseActivateInput {
        activation_key: "TPV-AAAAA-BBBBB-CCCCC-DDDDD".into(),
        business_name: "Bar de Pruebas".into(),
        legal_name: None,
        phone: None,
        country: None,
        device_change_code: None,
    }
}

/// Un equipo Main: su AppData, su base abierta y su licencia.
struct Equipo {
    dir: PathBuf,
    db: Arc<Db>,
    licencias: Arc<Licencias>,
    /// Lo que tiene la nube de un negocio recién estrenado: el administrador por estrenar.
    usuarios_de_un_negocio_nuevo: (Vec<String>, Vec<Vec<JsonValue>>),
    /// Las copias de A que hay en `backups/`.
    copias_de_a: Vec<String>,
    copia_diaria: String,
}

impl Equipo {
    /// Teclea la clave de `negocio` en la pantalla de activación, como el comando: con la base que
    /// haya abierta.
    async fn activar(&self, negocio: &'static str, servidor_dice_traslado: bool) -> AppResult<LicenseActivateOutcome> {
        self.activar_sobre(Some(self.db.clone()), negocio, servidor_dice_traslado).await
    }

    async fn activar_sobre(
        &self,
        db: Option<Arc<Db>>,
        negocio: &'static str,
        servidor_dice_traslado: bool,
    ) -> AppResult<LicenseActivateOutcome> {
        self.licencias.respuestas.lock().unwrap().push_back((negocio, servidor_dice_traslado));
        let base = BaseLocal::new(&self.dir, db);
        uc_licencia::activate(self.licencias.as_ref(), &base, entrada()).await
    }

    /// «Borrar y volver a activar».
    fn borrar_la_licencia(&self) {
        uc_licencia::clear_state(self.licencias.as_ref()).unwrap();
    }

    /// Lo que hace el arranque, con la base cerrada: aplicar el cambio de negocio pendiente y abrir
    /// la base con la licencia vigente. `corte`, el paso antes del cual se corta.
    async fn arranque(&self, corte: Option<&'static str>) -> AppResult<Arc<Db>> {
        let base = BaseQueSeCorta { base: BaseLocal::new(&self.dir, None), corte };
        uc_licencia::aplicar_cambio_de_negocio_pendiente(self.licencias.as_ref(), &base).await?;
        init_main_db(&self.dir, self.licencias.negocio().as_deref()).await
    }

    /// El reinicio del TPV.
    async fn reiniciar(&mut self) {
        self.db.cerrar().await.unwrap();
        self.db = self.arranque(None).await.unwrap();
    }

    fn nube(&self, volcado: JsonValue) -> Nube {
        Nube {
            licencias: self.licencias.clone(),
            cambios: Mutex::new(JsonValue::Null),
            volcado: Mutex::new(volcado),
            puerta: tokio::sync::Mutex::new(()),
            firmadas_con: Mutex::new(Vec::new()),
        }
    }

    /// «Recuperar el estado actual de la nube», con el volcado de la nube de la licencia.
    async fn traer_la_nube(&self, volcado: JsonValue) -> (Arc<SqliteSyncRepository>, Nube) {
        let repo = Arc::new(SqliteSyncRepository::new(self.db.clone()));
        let nube = self.nube(volcado);
        uc_sync::bootstrap_desde_nube(&nube, repo.as_ref()).await.unwrap();
        (repo, nube)
    }

    /// El volcado de la nube de un negocio recién estrenado.
    fn volcado_de_un_negocio_nuevo(&self) -> JsonValue {
        let (columnas, filas) = &self.usuarios_de_un_negocio_nuevo;
        json!({
            "seq": SEQ_DEL_NUEVO,
            "total_filas": filas.len(),
            "tablas": [
                {"nombre": "Usuarios", "columnas": columnas, "filas": filas, "parcial": false},
                {"nombre": "Clientes", "columnas": ["ID_Cliente", "Nombre"], "filas": [], "parcial": false},
                {"nombre": "Zonas", "columnas": ["ID_Zona", "Nombre_Zona"], "filas": [], "parcial": false},
            ],
            "backfill": [],
        })
    }

    async fn terminar(self) {
        self.db.cerrar().await.unwrap();
        drop(self.db);
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// La Main de A tal como la deja su vida normal: instalada, activada (lo que sella su base), con el
/// PIN elegido, personal, clientes y zonas, todo subido y el checkpoint en el `Seq` de su nube; una
/// copia diaria y una de cada familia de las que se guardan; una operación sin subir, un cobro sin
/// terminar, un correo a un cliente por mandar, un administrador con intentos fallidos y el registro
/// de sus jobs; y, fuera de la base, una imagen, la cola de las que le faltan por subir y una copia
/// previa a una migración.
async fn equipo_de_a(nombre: &str) -> Equipo {
    let dir = dir_temporal(nombre);
    let db = init_main_db(&dir, None).await.unwrap();
    // `ensureTenantInitialAdmin` siembra en la nube el mismo administrador que la Main.
    let usuarios_de_un_negocio_nuevo = usuarios_como_la_nube(&db).await;
    let mut e = Equipo {
        dir,
        db,
        licencias: Arc::new(Licencias::default()),
        usuarios_de_un_negocio_nuevo,
        copias_de_a: Vec::new(),
        copia_diaria: String::new(),
    };

    let estreno = e.activar(NEGOCIO_A, false).await.unwrap();
    assert!(!estreno.cambio_de_equipo && !estreno.reinicia, "estrenar la licencia no cambia nada");
    assert_eq!(sello_de(&e.db).await.as_deref(), Some(NEGOCIO_A), "la base queda sellada con su negocio");
    assert_eq!(e.licencias.credenciales().as_deref(), Some(NEGOCIO_A));

    let login = SqliteLoginRepository::new(e.db.clone());
    login.complete_initial_setup(ADMIN_USUARIO_ID, "2580").await.unwrap();
    drop(login);
    escribir(
        &e.db,
        &format!(
            "INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre, Estado)
               VALUES ('camarero-a', '{ROL_CAMARERO}', 'camarero@bar-a.test', 'x', 'Camarero de A', 'Activo');
             INSERT INTO Clientes (ID_Cliente, Nombre, Telefono, Email)
               VALUES ('cli-1', 'Cliente Ficticio Uno', '600000001', 'uno@cliente-a.test'),
                      ('cli-2', 'Cliente Ficticio Dos', '600000002', 'dos@cliente-a.test');
             INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1', 'Terraza A'), ('z2', 'Salón A');
             DELETE FROM _Sync_Outbox;
             UPDATE _Sync_State SET Last_Seq = {CHECKPOINT_DEL_ANTERIOR} WHERE Id = 1;"
        ),
    )
    .await;
    e.copia_diaria = recovery::create_backup(&e.db, &e.dir).await.unwrap().expect("copia hecha").id;
    let copias = e.dir.join("backups");
    for nombre in COPIAS_DE_A {
        std::fs::copy(copias.join(&e.copia_diaria), copias.join(nombre)).unwrap();
    }
    e.copias_de_a = COPIAS_DE_A.iter().map(|c| c.to_string()).chain([e.copia_diaria.clone()]).collect();
    escribir(
        &e.db,
        &format!(
            "INSERT INTO _Sync_Outbox (Op_Id, Command_Name, Statements_Json, Created_At_Ms)
               VALUES ('op-de-a', 'x', '[]', 1);
             INSERT INTO _Cobros_Pendientes (ID_Pago, Datos_Json) VALUES ('pago-de-a', '{{}}');
             INSERT INTO _Reservas_Web_Avisos (ID_Aviso, ID_Reserva, Tipo, Datos_Json, Creado_Ms)
               VALUES ('aviso-de-a', 'reserva-de-a', 'cancelada', '{{}}', 1);
             INSERT INTO Intentos_Login (ID_Usuario, Intentos_Fallidos, Bloqueado_Hasta_Ms, Ultimo_Intento_Ms)
               VALUES ('{ADMIN_USUARIO_ID}', 4, 0, 1);
             INSERT INTO _Jobs_State (Nombre, Last_Run_Ms, Fallos) VALUES ('copia_local', 1, 0);"
        ),
    )
    .await;
    std::fs::create_dir_all(e.dir.join("images").join("productos")).unwrap();
    std::fs::write(e.dir.join("images").join("productos").join("de-a.jpg"), "foto de A").unwrap();
    std::fs::write(
        e.dir.join("image_uploads.json"),
        r#"[{"rel_path":"images/productos/de-a.jpg","content_type":"image/jpeg"}]"#,
    )
    .unwrap();
    std::fs::write(e.dir.join("image_backfill_done"), "1").unwrap();
    std::fs::write(e.dir.join("data.db.bak.8000"), "base de antes de una migración").unwrap();
    std::fs::write(e.dir.join("data.restore.9000.tmp"), "restauración a medias").unwrap();
    assert_eq!(estado(&e.db).await, RecoveryState::Ready);
    e
}

/// Lo de A está entero en `carpeta`, con la forma que tenía en AppData, y fuera no queda nada suyo.
fn todo_lo_de_a_esta_en(e: &Equipo, carpeta: &Path) {
    assert!(carpeta.join("data.db").is_file(), "la base de A, apartada");
    assert_eq!(sello::del_fichero(&carpeta.join("data.db")).unwrap(), Sello::De(NEGOCIO_A.into()));
    assert!(!carpeta.join("apartado-en-curso").exists(), "el apartado ha terminado");
    let mut copias = e.copias_de_a.clone();
    copias.sort();
    assert_eq!(nombres_en(&carpeta.join("backups")), copias, "todas sus copias, de todas las familias");
    for nombre in FUERA_DE_LA_BASE_DE_A {
        assert!(carpeta.join(nombre).exists(), "falta {nombre} en lo apartado");
        assert!(!e.dir.join(nombre).exists(), "{nombre} sigue en AppData");
    }
    assert_eq!(
        std::fs::read_to_string(carpeta.join("images").join("productos").join("de-a.jpg")).unwrap(),
        "foto de A"
    );
    let en_backups: Vec<String> =
        nombres_en(&e.dir.join("backups")).into_iter().filter(|n| !n.starts_with("negocio-anterior-")).collect();
    assert!(en_backups.is_empty(), "en backups/ no queda nada de A: {en_backups:?}");
    // Y la base apartada lo lleva todo dentro.
    let vieja = rusqlite::Connection::open(carpeta.join("data.db")).unwrap();
    let contar = |sql: &str| vieja.query_row(sql, [], |f| f.get::<_, i64>(0)).unwrap();
    for (que, sql, cuantos) in [
        ("clientes", "SELECT COUNT(*) FROM Clientes;", 2),
        ("operación sin subir", "SELECT COUNT(*) FROM _Sync_Outbox;", 1),
        ("cobro a medias", "SELECT COUNT(*) FROM _Cobros_Pendientes;", 1),
        ("correo por mandar", "SELECT COUNT(*) FROM _Reservas_Web_Avisos;", 1),
        ("registro de jobs", "SELECT COUNT(*) FROM _Jobs_State WHERE Nombre = 'copia_local';", 1),
    ] {
        assert_eq!(contar(sql), cuantos, "la base de A se aparta entera: {que}");
    }
}

/// La base que hay es la del negocio X recién estrenado, con su licencia y sus credenciales, y sin
/// cambio pendiente: vacía y a la espera de su nube.
async fn es_la_de_x_recien_estrenada(e: &Equipo) {
    assert_eq!(e.licencias.negocio().as_deref(), Some(NEGOCIO_X));
    assert_eq!(e.licencias.credenciales().as_deref(), Some(NEGOCIO_X));
    assert_eq!(e.licencias.pendiente(), None);
    assert_eq!(cambio_anotado(&e.dir), None, "el cambio queda terminado");
    assert_eq!(sello_de(&e.db).await.as_deref(), Some(NEGOCIO_X), "la base nueva nace sellada con X");
    assert_eq!(estado(&e.db).await, RecoveryState::DataMissing, "espera a la nube de X");
}

/// Con la licencia de X activada y el reinicio por llegar, todo es de A: la licencia vigente, sus
/// credenciales, su base y lo que se hace con ella. Lo de X sólo está pendiente.
async fn todo_sigue_siendo_de_a(e: &Equipo) {
    assert_eq!(e.licencias.negocio().as_deref(), Some(NEGOCIO_A), "la licencia vigente sigue siendo la de A");
    assert_eq!(e.licencias.credenciales().as_deref(), Some(NEGOCIO_A), "y sus credenciales");
    assert_eq!(e.licencias.pendiente(), Some((NEGOCIO_X.into(), NEGOCIO_X.into())), "la de X, pendiente");
    assert_eq!(cambio_anotado(&e.dir).as_deref(), Some(NEGOCIO_X));
    assert_eq!(sello_de(&e.db).await.as_deref(), Some(NEGOCIO_A));
    assert_eq!(estado(&e.db).await, RecoveryState::Ready);
    assert!(!e.db.escrituras_de_negocio_bloqueadas());
    assert!(recovery::base_del_negocio(&e.db, NEGOCIO_A).await.unwrap(), "sus imágenes, con su licencia");
    assert!(!recovery::base_del_negocio(&e.db, NEGOCIO_X).await.unwrap());
    let repo = SqliteSyncRepository::new(e.db.clone());
    let pendientes = repo.outbox_pending(100).await.unwrap();
    assert_eq!(pendientes.len(), 1, "lo de A sigue para subir a la nube de A");
}

// ── La transición entera ──────────────────────────────────────────────────────

#[tokio::test]
async fn la_licencia_de_otro_negocio_espera_al_arranque_que_aparta_todo_lo_del_anterior() {
    let mut e = equipo_de_a("otro-negocio").await;

    // La clave del negocio X, con la licencia de A todavía guardada. El servidor NO dice que haya
    // traslado: es lo que contesta al reintento de una primera activación cuya respuesta no llegó.
    let outcome = e.activar(NEGOCIO_X, false).await.unwrap();
    assert!(outcome.reinicia && outcome.cambio_de_equipo, "el TPV se reinicia");
    assert_eq!(outcome.state.as_ref().map(|s| s.tenant_id.as_str()), Some(NEGOCIO_X));

    // ── 1. Hasta el reinicio, todo sigue siendo de A ────────────────────────────────────────
    todo_sigue_siendo_de_a(&e).await;
    let login = SqliteLoginRepository::new(e.db.clone());
    assert_eq!(login.login(ADMIN_USUARIO_ID, "2580").await.unwrap().id_usuario, ADMIN_USUARIO_ID, "se entra en A");
    drop(login);
    // La copia diaria que toque es de A, con su sello: se aparta con lo demás.
    let copia = recovery::create_backup(&e.db, &e.dir).await.unwrap().expect("se hace").id;
    e.copias_de_a.push(copia);
    // Y una copia de A que llega de fuera tampoco entra con la licencia de X.
    let fuera = e.dir.join("usb");
    std::fs::create_dir_all(&fuera).unwrap();
    std::fs::copy(e.dir.join("backups").join(&e.copia_diaria), fuera.join("copia-de-a.db.gz")).unwrap();
    let err = recovery::import_backup(&e.dir, &fuera.join("copia-de-a.db.gz"), Some(NEGOCIO_X)).await.unwrap_err();
    assert!(err.to_string().contains("es de otro negocio"), "{err}");

    // ── 2. El reinicio aparta todo lo de A antes de abrir nada, y llega X ───────────────────
    e.reiniciar().await;
    let apartados = apartados(&e.dir);
    assert_eq!(apartados.len(), 1);
    todo_lo_de_a_esta_en(&e, &apartados[0]);
    es_la_de_x_recien_estrenada(&e).await;

    let volcado = e.volcado_de_un_negocio_nuevo();
    let (repo, nube) = e.traer_la_nube(volcado).await;
    assert_eq!(*nube.firmadas_con.lock().unwrap(), vec![Some(NEGOCIO_X.to_string())], "con las credenciales de X");
    assert_eq!(sello_de(&e.db).await.as_deref(), Some(NEGOCIO_X));
    assert_eq!(estado(&e.db).await, RecoveryState::ReconciliationPending);
    assert_eq!(repo.get_checkpoint().await.unwrap(), SEQ_DEL_NUEVO);
    for (que, sql) in [
        ("clientes", "SELECT COUNT(*) FROM Clientes;"),
        ("zonas", "SELECT COUNT(*) FROM Zonas;"),
        ("outbox", "SELECT COUNT(*) FROM _Sync_Outbox;"),
        ("cobros a medias", "SELECT COUNT(*) FROM _Cobros_Pendientes;"),
        ("correos por mandar", "SELECT COUNT(*) FROM _Reservas_Web_Avisos;"),
        ("intentos de login", "SELECT COUNT(*) FROM Intentos_Login;"),
        ("registro de jobs", "SELECT COUNT(*) FROM _Jobs_State;"),
        ("personal de A", "SELECT COUNT(*) FROM Usuarios WHERE ID_Usuario = 'camarero-a';"),
    ] {
        assert_eq!(numero(&e.db, sql).await, 0, "de A no queda nada: {que}");
    }
    assert!(recovery::list_backups(&e.dir).unwrap().is_empty(), "las copias de A no se ofrecen");

    // La purga de restos no entra en lo apartado, y nada de ello vuelve por «Restaurar desde un
    // archivo», lleve sello o no.
    let guardado = nombres_en(&apartados[0].join("backups"));
    for nombre in ["pre-restore-1.db", "pre-restore-2.db", "pre-restore-3.db"] {
        std::fs::write(e.dir.join("backups").join(nombre), "de X").unwrap();
    }
    recovery::purge_restore_leftovers(&e.dir).unwrap();
    assert_eq!(nombres_en(&apartados[0].join("backups")), guardado);
    for copia in [apartados[0].join("backups").join(&e.copia_diaria), apartados[0].join("data.db")] {
        assert!(recovery::import_backup(&e.dir, &copia, Some(NEGOCIO_X)).await.is_err(), "{}", copia.display());
    }

    // ── 3. La reconciliación termina sin subir nada y X estrena su PIN ──────────────────────
    let ctx = Ctx { db: e.db.clone(), repo: repo.clone() };
    *nube.cambios.lock().unwrap() = json!({
        "ok": true, "items": [], "nextSince": SEQ_DEL_NUEVO, "highWater": SEQ_DEL_NUEVO, "purgadoHasta": 0,
    });
    let mut socket = Socket::default();
    replicacion::ejecutar(&ctx, &nube, &mut socket, true).await.unwrap();
    assert!(
        socket.enviados.iter().all(|m| m["type"] != "apply" && m["type"] != "bulk_apply"),
        "{:?}",
        socket.enviados
    );
    assert_eq!(estado(&e.db).await, RecoveryState::Ready);
    assert!(recovery::base_del_negocio(&e.db, NEGOCIO_X).await.unwrap());

    let login = SqliteLoginRepository::new(e.db.clone());
    let setup = login.setup_pendiente().await.unwrap();
    assert!(setup.pendiente, "el negocio nuevo elige su PIN inicial");
    assert_eq!(setup.id_usuario.as_deref(), Some(ADMIN_USUARIO_ID));
    assert!(login.login(ADMIN_USUARIO_ID, "2580").await.is_err(), "el PIN del administrador de A no abre X");
    assert_eq!(login.list_login_users().await.unwrap().len(), 1, "sólo el administrador de X");

    drop(login);
    drop(ctx);
    drop(repo);
    e.terminar().await;
}

/// AUD-06 · Lo que estaba en marcha con A cuando se activa X, y termina después, sigue siendo de A:
/// un login que esperaba a la base entra en A, y lo que se traía de la nube se pide con las
/// credenciales de A y se instala en la base de A, con su sello. Una restauración en caliente
/// después, con la licencia vigente de A, tampoco quita el cambio anotado: el reinicio aparta lo
/// restaurado como todo lo demás de A.
#[tokio::test]
async fn lo_que_estaba_en_marcha_con_a_termina_como_de_a_y_el_reinicio_lo_aparta() {
    let mut e = equipo_de_a("en-marcha").await;
    // Traer la nube exige no tener nada sin subir.
    escribir(&e.db, "DELETE FROM _Sync_Outbox;").await;
    let volcado_de_a = e.volcado_de_un_negocio_nuevo();
    let nube = e.nube(volcado_de_a);
    let repo = SqliteSyncRepository::new(e.db.clone());
    let login = SqliteLoginRepository::new(e.db.clone());

    // El login y la descarga empiezan con A y se quedan esperando: el login, a la base (alguien la
    // está escribiendo); la descarga, a la nube.
    let base_ocupada = e.db.write().await;
    let nube_ocupada = nube.puerta.lock().await;
    let entrar = login.login(ADMIN_USUARIO_ID, "2580");
    let traer = uc_sync::bootstrap_desde_nube(&nube, &repo);
    let activar_y_soltar = async {
        let outcome = e.activar(NEGOCIO_X, true).await.unwrap();
        assert!(outcome.reinicia);
        drop(base_ocupada);
        drop(nube_ocupada);
    };
    let (entrado, traido, ()) = tokio::join!(entrar, traer, activar_y_soltar);

    let entrado = entrado.unwrap();
    assert_eq!(entrado.id_usuario, ADMIN_USUARIO_ID, "el login termina dentro de A");
    traido.unwrap();
    assert_eq!(*nube.firmadas_con.lock().unwrap(), vec![Some(NEGOCIO_A.to_string())], "pedido con lo de A");
    assert_eq!(sello_de(&e.db).await.as_deref(), Some(NEGOCIO_A), "instalado en la base de A, con su sello");
    drop(login);
    drop(repo);

    // Restaurar en caliente una copia de A, con la licencia vigente de A, como el comando.
    e.db.cerrar().await.unwrap();
    let preparada = recovery::prepare_restore(&e.dir, &e.copia_diaria, e.licencias.negocio().as_deref()).await.unwrap();
    recovery::install_prepared(&e.dir, &preparada).unwrap();
    e.db = init_main_db(&e.dir, e.licencias.negocio().as_deref()).await.unwrap();
    assert_eq!(sello_de(&e.db).await.as_deref(), Some(NEGOCIO_A));
    assert_eq!(cambio_anotado(&e.dir).as_deref(), Some(NEGOCIO_X), "ni restaurar ni abrir quitan el cambio");
    assert_eq!(e.licencias.pendiente(), Some((NEGOCIO_X.into(), NEGOCIO_X.into())));
    // Lo que había antes de restaurar queda entre las copias de A.
    let restos: Vec<String> = nombres_en(&e.dir.join("backups"))
        .into_iter()
        .filter(|n| !e.copias_de_a.contains(n))
        .collect();
    e.copias_de_a.extend(restos);

    e.reiniciar().await;
    let apartados = apartados(&e.dir);
    assert_eq!(apartados.len(), 1);
    assert_eq!(sello::del_fichero(&apartados[0].join("data.db")).unwrap(), Sello::De(NEGOCIO_A.into()));
    let mut copias = e.copias_de_a.clone();
    copias.sort();
    assert_eq!(nombres_en(&apartados[0].join("backups")), copias, "lo restaurado y lo de antes, apartados");
    es_la_de_x_recien_estrenada(&e).await;
    e.terminar().await;
}

// ── Cortes ────────────────────────────────────────────────────────────────────

/// AUD-06 · Activar X cortándose antes de guardarla como pendiente: nada de X queda, ni siquiera
/// el cambio anotado (se anota después), y el arranque abre la base de A con su licencia. Con la
/// licencia de A borrada antes («Borrar y volver a activar») tampoco se aparta nada: no hay licencia
/// con la que abrir otra cosa.
#[tokio::test]
async fn un_corte_al_activar_no_deja_nada_de_x() {
    for borrar_antes in [false, true] {
        let mut e = equipo_de_a(&format!("corte-al-activar-{borrar_antes}")).await;
        if borrar_antes {
            e.borrar_la_licencia();
        }
        e.licencias.cortar_antes_de(Some("pendiente"));
        assert!(e.activar(NEGOCIO_X, false).await.is_err());
        assert_eq!(e.licencias.pendiente(), None);
        assert_eq!(cambio_anotado(&e.dir), None);
        e.licencias.cortar_antes_de(None);

        e.reiniciar().await;
        assert_eq!(e.licencias.negocio().as_deref(), (!borrar_antes).then_some(NEGOCIO_A));
        assert_eq!(sello_de(&e.db).await.as_deref(), Some(NEGOCIO_A));
        assert_eq!(numero(&e.db, "SELECT COUNT(*) FROM Clientes;").await, 2);
        assert!(apartados(&e.dir).is_empty(), "no se ha movido nada");

        // Repetir la activación termina igual que sin corte.
        assert!(e.activar(NEGOCIO_X, false).await.unwrap().reinicia);
        e.reiniciar().await;
        todo_lo_de_a_esta_en(&e, &apartados(&e.dir)[0]);
        es_la_de_x_recien_estrenada(&e).await;
        e.terminar().await;
    }
}

/// AUD-06 · El arranque cortado entre sus pasos —antes de apartar lo de A, antes de aplicar la
/// licencia de X o antes de quitar la anotación— no abre ninguna base, y el siguiente lo termina
/// igual que sin corte. Hasta que la licencia de X no es la vigente, la de A sigue siéndolo.
#[tokio::test]
async fn el_arranque_cortado_entre_sus_pasos_lo_termina_el_siguiente() {
    for corte in ["apartar", "aplicar", "quitar"] {
        let mut e = equipo_de_a(&format!("arranque-{corte}")).await;
        e.borrar_la_licencia();
        assert!(e.activar(NEGOCIO_X, false).await.unwrap().reinicia, "corte en {corte}");
        e.db.cerrar().await.unwrap();

        if corte == "aplicar" {
            e.licencias.cortar_antes_de(Some("aplicar"));
        }
        let err = e.arranque(Some(corte)).await.err().expect("no se abre nada");
        assert!(err.to_string().contains("corte"), "corte en {corte}: {err}");
        e.licencias.cortar_antes_de(None);
        assert_eq!(cambio_anotado(&e.dir).as_deref(), Some(NEGOCIO_X), "corte en {corte}: el cambio sigue anotado");
        match corte {
            "apartar" => {
                assert_eq!(sello::del_fichero(&e.dir.join("data.db")).unwrap(), Sello::De(NEGOCIO_A.into()));
                assert!(apartados(&e.dir).is_empty());
                assert_eq!(e.licencias.pendiente().map(|p| p.0).as_deref(), Some(NEGOCIO_X));
            }
            "aplicar" => {
                assert!(!e.dir.join("data.db").exists(), "lo de A ya está apartado");
                assert_eq!(e.licencias.negocio(), None, "la licencia de X aún no es la vigente");
                assert_eq!(e.licencias.pendiente().map(|p| p.0).as_deref(), Some(NEGOCIO_X));
            }
            _ => {
                assert!(!e.dir.join("data.db").exists());
                assert_eq!(e.licencias.negocio().as_deref(), Some(NEGOCIO_X), "ya aplicada");
                assert_eq!(e.licencias.pendiente(), None);
            }
        }

        e.db = e.arranque(None).await.unwrap();
        let apartados = apartados(&e.dir);
        assert_eq!(apartados.len(), 1, "corte en {corte}");
        todo_lo_de_a_esta_en(&e, &apartados[0]);
        es_la_de_x_recien_estrenada(&e).await;
        e.terminar().await;
    }
}

/// AUD-06 · Con el cambio pendiente no se activa ninguna otra licencia, ni la del negocio de la base:
/// se rechaza antes de pedir nada al servidor (la clave no se gasta) y lo pendiente sigue. El
/// arranque aplica X.
#[tokio::test]
async fn con_un_cambio_pendiente_no_se_activa_otra() {
    let mut e = equipo_de_a("otra-vez").await;
    assert!(e.activar(NEGOCIO_X, false).await.unwrap().reinicia);
    for negocio in ["negocio-y", NEGOCIO_A] {
        let err = e.activar(negocio, false).await.unwrap_err();
        assert!(err.to_string().contains("cambio de licencia pendiente"), "{negocio}: {err}");
    }
    assert_eq!(e.licencias.respuestas.lock().unwrap().len(), 2, "no se ha pedido nada al servidor");
    e.licencias.respuestas.lock().unwrap().clear();
    todo_sigue_siendo_de_a(&e).await;

    e.reiniciar().await;
    todo_lo_de_a_esta_en(&e, &apartados(&e.dir)[0]);
    es_la_de_x_recien_estrenada(&e).await;
    e.terminar().await;
}

/// AUD-06 · Dos activaciones a la vez, de dos negocios, las dos en vuelo: van una detrás de otra. La
/// primera deja X pendiente; la segunda, con el cambio ya anotado, se rechaza sin pedir nada al
/// servidor. El sello de la base no cambia.
#[tokio::test]
async fn dos_activaciones_a_la_vez_una_gana_y_la_otra_se_rechaza() {
    let e = equipo_de_a("dos-a-la-vez").await;
    let servidor_ocupado = e.licencias.puerta.lock().await;
    let primera = e.activar(NEGOCIO_X, false);
    let segunda = e.activar("negocio-y", false);
    let soltar = async {
        tokio::task::yield_now().await;
        drop(servidor_ocupado);
    };
    let (primera, segunda, ()) = tokio::join!(primera, segunda, soltar);

    assert!(primera.unwrap().reinicia, "la primera gana");
    let err = segunda.unwrap_err();
    assert!(err.to_string().contains("cambio de licencia pendiente"), "{err}");
    assert_eq!(
        e.licencias.respuestas.lock().unwrap().iter().map(|r| r.0).collect::<Vec<_>>(),
        ["negocio-y"],
        "la segunda no llegó a pedir nada"
    );
    assert_eq!(sello_de(&e.db).await.as_deref(), Some(NEGOCIO_A), "el sello no cambia");
    todo_sigue_siendo_de_a(&e).await;
    e.terminar().await;
}

/// AUD-06 · Una restauración en caliente cortada entre sus dos `rename` (la base de A ya en
/// `backups/pre-restore-*`, la copia preparada todavía sin poner) con el cambio a X pendiente: el
/// equipo se queda sin `data.db`, pero con todo lo demás de A. El arranque lo aparta todo igual y
/// aplica X.
#[tokio::test]
async fn una_restauracion_cortada_con_el_cambio_pendiente_se_aparta_entera() {
    let mut e = equipo_de_a("restauracion-cortada").await;
    assert!(e.activar(NEGOCIO_X, false).await.unwrap().reinicia);
    let preparada = recovery::prepare_restore(&e.dir, &e.copia_diaria, Some(NEGOCIO_A)).await.unwrap();
    e.db.cerrar().await.unwrap();
    // Lo que deja `install_prepared` si el proceso muere tras su primer `rename`.
    let antes_de_restaurar = format!("pre-restore-{}.db", 1);
    std::fs::rename(e.dir.join("data.db"), e.dir.join("backups").join(&antes_de_restaurar)).unwrap();
    assert!(!e.dir.join("data.db").exists() && preparada.exists());
    let preparada = preparada.file_name().unwrap().to_string_lossy().into_owned();

    e.db = e.arranque(None).await.unwrap();

    let apartados = apartados(&e.dir);
    assert_eq!(apartados.len(), 1);
    let carpeta = &apartados[0];
    assert!(!carpeta.join("apartado-en-curso").exists());
    let mut copias = e.copias_de_a.clone();
    copias.push(antes_de_restaurar.clone());
    copias.sort();
    assert_eq!(nombres_en(&carpeta.join("backups")), copias, "todas las copias, y la base de antes de restaurar");
    assert_eq!(
        sello::del_fichero(&carpeta.join("backups").join(&antes_de_restaurar)).unwrap(),
        Sello::De(NEGOCIO_A.into())
    );
    assert!(carpeta.join(&preparada).is_file(), "la copia preparada, también");
    for nombre in FUERA_DE_LA_BASE_DE_A {
        assert!(carpeta.join(nombre).exists(), "falta {nombre}");
        assert!(!e.dir.join(nombre).exists(), "{nombre} sigue en AppData");
    }
    assert!(recovery::list_backups(&e.dir).unwrap().is_empty(), "no se ofrece nada de A");
    es_la_de_x_recien_estrenada(&e).await;
    e.terminar().await;
}

/// AUD-06 · Si una carpeta no se deja recorrer al arrancar (aquí `backups` no es una carpeta), el
/// arranque se para con el cambio anotado y la licencia de X pendiente, sin dar nada por apartado ni
/// abrir ninguna base; cuando se arregla, el siguiente lo termina.
#[tokio::test]
async fn un_error_al_recorrer_las_carpetas_deja_el_cambio_pendiente() {
    let mut e = equipo_de_a("enumerar").await;
    assert!(e.activar(NEGOCIO_X, false).await.unwrap().reinicia);
    e.db.cerrar().await.unwrap();
    let copias = e.dir.join("backups");
    let guardadas = e.dir.join("backups-de-verdad");
    std::fs::rename(&copias, &guardadas).unwrap();
    std::fs::write(&copias, "no es una carpeta").unwrap();

    assert!(e.arranque(None).await.is_err());
    assert_eq!(cambio_anotado(&e.dir).as_deref(), Some(NEGOCIO_X), "el cambio sigue anotado");
    assert_eq!(e.licencias.negocio().as_deref(), Some(NEGOCIO_A), "la licencia de X sigue pendiente");
    assert_eq!(e.licencias.pendiente().map(|p| p.0).as_deref(), Some(NEGOCIO_X));
    assert_eq!(sello::del_fichero(&e.dir.join("data.db")).unwrap(), Sello::De(NEGOCIO_A.into()));
    for nombre in FUERA_DE_LA_BASE_DE_A {
        assert!(e.dir.join(nombre).exists(), "{nombre} no se ha movido");
    }

    std::fs::remove_file(&copias).unwrap();
    std::fs::rename(&guardadas, &copias).unwrap();
    e.db = e.arranque(None).await.unwrap();
    todo_lo_de_a_esta_en(&e, &apartados(&e.dir)[0]);
    es_la_de_x_recien_estrenada(&e).await;
    e.terminar().await;
}

/// AUD-06 · Traída ya la nube de X (su base, sellada con X, confirmada), se vuelve a la licencia de
/// A. La base que hay es de X: se aparta al reiniciar, como cualquier otra de otro negocio, y A
/// trae la suya de su nube.
#[tokio::test]
async fn volver_a_la_licencia_anterior_despues_de_traer_la_nube_aparta_la_del_nuevo() {
    let mut e = equipo_de_a("vuelta-a-a").await;
    e.borrar_la_licencia();
    assert!(e.activar(NEGOCIO_X, true).await.unwrap().reinicia);
    e.reiniciar().await;
    let volcado = e.volcado_de_un_negocio_nuevo();
    let (repo, _nube) = e.traer_la_nube(volcado).await;
    drop(repo);
    assert_eq!(sello_de(&e.db).await.as_deref(), Some(NEGOCIO_X));
    escribir(&e.db, "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('zx', 'Barra de X');").await;

    // El proceso muere justo después: al volver a abrir, la base de X se usa con la licencia de X.
    e.reiniciar().await;
    assert_eq!(sello_de(&e.db).await.as_deref(), Some(NEGOCIO_X));
    assert_eq!(apartados(&e.dir).len(), 1);

    // Se vuelve a la licencia de A.
    e.borrar_la_licencia();
    assert!(e.activar(NEGOCIO_A, false).await.unwrap().reinicia, "la base que hay no es la de A");
    e.reiniciar().await;
    let volcado = e.volcado_de_un_negocio_nuevo();
    let (repo, _nube) = e.traer_la_nube(volcado).await;
    drop(repo);
    assert_eq!(sello_de(&e.db).await.as_deref(), Some(NEGOCIO_A));
    assert_eq!(numero(&e.db, "SELECT COUNT(*) FROM Zonas WHERE ID_Zona = 'zx';").await, 0, "nada de X");

    let apartados = apartados(&e.dir);
    assert_eq!(apartados.len(), 2, "lo de A y, aparte, lo de X");
    let de_x = apartados
        .iter()
        .find(|c| sello::del_fichero(&c.join("data.db")).unwrap() == Sello::De(NEGOCIO_X.into()))
        .expect("la base de X, apartada");
    let vieja = rusqlite::Connection::open(de_x.join("data.db")).unwrap();
    let zonas: i64 = vieja.query_row("SELECT COUNT(*) FROM Zonas WHERE ID_Zona = 'zx';", [], |f| f.get(0)).unwrap();
    assert_eq!(zonas, 1, "con lo que X hizo");
    drop(vieja);
    e.terminar().await;
}

/// AUD-06 · Una base que no se deja leer cuando el arranque aplica la licencia de X: no consta de
/// quién es, así que se aparta entera con sus imágenes y su cola, como si fuera de otro negocio.
#[tokio::test]
async fn una_base_ilegible_se_aparta_con_todo_lo_suyo() {
    let mut e = equipo_de_a("ilegible").await;
    e.borrar_la_licencia();
    assert!(e.activar(NEGOCIO_X, false).await.unwrap().reinicia);
    e.db.cerrar().await.unwrap();
    for sufijo in ["-wal", "-shm"] {
        let _ = std::fs::remove_file(e.dir.join(format!("data.db{sufijo}")));
    }
    std::fs::write(e.dir.join("data.db"), vec![0xA5u8; 16384]).unwrap();

    e.db = e.arranque(None).await.unwrap();

    let apartados = apartados(&e.dir);
    assert_eq!(apartados.len(), 1);
    assert_eq!(std::fs::read(apartados[0].join("data.db")).unwrap(), vec![0xA5u8; 16384], "tal cual");
    for nombre in FUERA_DE_LA_BASE_DE_A {
        assert!(apartados[0].join(nombre).exists(), "falta {nombre}");
    }
    // Las copias de A dicen ser de A: no son de X, y se apartan con lo demás.
    assert!(recovery::list_backups(&e.dir).unwrap().is_empty());
    es_la_de_x_recien_estrenada(&e).await;
    e.terminar().await;
}

/// AUD-06 · El arranque cortado a mitad de apartar, porque un fichero lo tiene bloqueado otro
/// programa (como haría un antivirus), no abre nada: la base de A sigue en su sitio con su sello y
/// la licencia de X sigue pendiente, y entre medias no se puede activar otra. El siguiente arranque
/// lo termina en la misma carpeta, sin perder ni pisar nada.
#[cfg(windows)]
#[tokio::test]
async fn un_apartado_interrumpido_en_cualquier_paso_lo_termina_el_siguiente_arranque() {
    use std::os::windows::fs::OpenOptionsExt;
    // Un fichero abierto sin dejar a nadie más escribirlo ni moverlo: `share_mode` sólo de lectura
    // para la base (mirar su sello sigue pudiendo), nada para lo demás.
    let bloquear = |ruta: &Path, lectura: bool| {
        std::fs::OpenOptions::new()
            .read(true)
            .share_mode(if lectura { 1 } else { 0 })
            .open(ruta)
            .unwrap()
    };

    for (paso, ruta, lectura) in [
        ("una copia", "backups/import-1000.db.gz", false),
        ("la cola de imágenes", "image_uploads.json", false),
        ("una imagen", "images/productos/de-a.jpg", false),
        ("la base", "data.db", true),
    ] {
        {
            let caso = paso;
            let mut e = equipo_de_a(&format!("bloqueo-{}", paso.replace(' ', "-"))).await;
            e.borrar_la_licencia();
            assert!(e.activar(NEGOCIO_X, false).await.unwrap().reinicia, "{caso}");
            e.db.cerrar().await.unwrap();

            let ocupado = bloquear(&e.dir.join(ruta), lectura);
            let err = e.arranque(None).await.err().expect("no se abre nada");
            assert!(err.to_string().contains("No se pudo apartar"), "{caso}: {err}");
            assert_eq!(sello::del_fichero(&e.dir.join("data.db")).unwrap(), Sello::De(NEGOCIO_A.into()), "{caso}");
            assert_eq!(e.licencias.negocio(), None, "{caso}: la licencia de X no se aplica antes de apartar");
            assert_eq!(cambio_anotado(&e.dir).as_deref(), Some(NEGOCIO_X), "{caso}");
            let a_medias = apartados(&e.dir);
            assert_eq!(a_medias.len(), 1, "{caso}");
            assert!(a_medias[0].join("apartado-en-curso").exists(), "{caso}: queda anotado que está a medias");
            assert!(!a_medias[0].join("data.db").exists(), "{caso}: la base es lo último que se mueve");

            // Entre medias no se activa otra licencia, tampoco la de A.
            let err = e.activar_sobre(None, NEGOCIO_A, false).await.unwrap_err();
            assert!(err.to_string().contains("cambio de licencia pendiente"), "{caso}: {err}");
            e.licencias.respuestas.lock().unwrap().clear();
            // Algo con el nombre de lo que falta por mover ya estaba en la carpeta: no se pisa.
            let ya_estaba = paso == "una copia";
            if ya_estaba {
                std::fs::write(a_medias[0].join("image_uploads.json"), "otro, que ya estaba").unwrap();
            }

            drop(ocupado);
            e.db = e.arranque(None).await.unwrap();
            let licencia = e.licencias.negocio();
            assert_eq!(licencia.as_deref(), Some(NEGOCIO_X), "{caso}");
            assert_eq!(cambio_anotado(&e.dir), None, "{caso}");

            assert_eq!(apartados(&e.dir), a_medias, "{caso}: se termina en la misma carpeta");
            if ya_estaba {
                assert_eq!(std::fs::read_to_string(a_medias[0].join("image_uploads.json")).unwrap(), "otro, que ya estaba");
                assert!(std::fs::read_to_string(a_medias[0].join("image_uploads.json.2")).unwrap().contains("de-a.jpg"), "{caso}");
            }
            todo_lo_de_a_esta_en(&e, &a_medias[0]);
            assert_eq!(sello_de(&e.db).await, licencia, "{caso}: la base nueva es de la licencia");
            assert_eq!(estado(&e.db).await, RecoveryState::DataMissing, "{caso}");
            e.terminar().await;
        }
    }
}

// ── El mismo negocio ──────────────────────────────────────────────────────────

/// AUD-06, lo que no puede romperse: el mismo negocio que vuelve (una anulación que se deshizo)
/// sigue con su base tal cual, sin reiniciar; y con la licencia traída de otro equipo sólo la base
/// es de antes: se reconstruye desde la nube, y sus copias, sus imágenes y lo que tenía a medias se
/// quedan.
#[tokio::test]
async fn el_mismo_negocio_conserva_lo_suyo() {
    let mut e = equipo_de_a("mismo-negocio").await;
    let copias = recovery::list_backups(&e.dir).unwrap().len();

    e.borrar_la_licencia();
    let outcome = e.activar(NEGOCIO_A, false).await.unwrap();
    assert!(!outcome.cambio_de_equipo && !outcome.reinicia);
    assert_eq!(e.licencias.credenciales().as_deref(), Some(NEGOCIO_A), "se guarda ya, sin esperar");
    assert_eq!(cambio_anotado(&e.dir), None);
    e.reiniciar().await;
    assert_eq!(estado(&e.db).await, RecoveryState::Ready);
    assert_eq!(numero(&e.db, "SELECT COUNT(*) FROM Clientes;").await, 2);
    assert!(apartados(&e.dir).is_empty());

    // La licencia de A, traída de otro equipo con el código del correo.
    let outcome = e.activar(NEGOCIO_A, true).await.unwrap();
    assert!(outcome.cambio_de_equipo && !outcome.reinicia, "la base es de antes, pero de su negocio");
    assert!(recovery::hay_traslado_pendiente(&e.dir));
    assert_eq!(estado(&e.db).await, RecoveryState::TransferPending);

    let volcado = e.volcado_de_un_negocio_nuevo();
    let (repo, _nube) = e.traer_la_nube(volcado).await;
    drop(repo);
    assert!(apartados(&e.dir).is_empty(), "nada se aparta");
    assert_eq!(sello_de(&e.db).await.as_deref(), Some(NEGOCIO_A));
    assert_eq!(recovery::list_backups(&e.dir).unwrap().len(), copias, "sus copias se siguen ofreciendo");
    assert!(e.dir.join("images").join("productos").join("de-a.jpg").exists());
    assert!(e.dir.join("image_uploads.json").exists());
    assert_eq!(numero(&e.db, "SELECT COUNT(*) FROM _Cobros_Pendientes;").await, 1, "el cobro a medias sigue");
    assert_eq!(numero(&e.db, "SELECT COUNT(*) FROM _Sync_Outbox;").await, 0, "el outbox de antes no sube");
    e.terminar().await;
}

/// AUD-06 · Una base sin sello (anterior a los sellos) en un equipo con licencia recibe el sello de
/// esa licencia la primera vez que se abre, y se usa. Y una base que se crea con la licencia ya
/// guardada nace sellada.
#[tokio::test]
async fn una_base_sin_sello_recibe_el_de_la_licencia_al_abrirla() {
    let dir = dir_temporal("sin-sello");
    let db = init_main_db(&dir, None).await.unwrap();
    let login = SqliteLoginRepository::new(db.clone());
    login.complete_initial_setup(ADMIN_USUARIO_ID, "2580").await.unwrap();
    drop(login);
    assert_eq!(sello_de(&db).await, None);
    db.cerrar().await.unwrap();
    drop(db);

    let db = init_main_db(&dir, Some(NEGOCIO_A)).await.unwrap();
    assert_eq!(sello_de(&db).await.as_deref(), Some(NEGOCIO_A));
    assert_eq!(estado(&db).await, RecoveryState::Ready);
    assert!(apartados(&dir).is_empty());
    db.cerrar().await.unwrap();
    drop(db);
    let _ = std::fs::remove_dir_all(&dir);

    let nueva = dir_temporal("nueva-con-licencia");
    let db = init_main_db(&nueva, Some(NEGOCIO_X)).await.unwrap();
    assert_eq!(sello_de(&db).await.as_deref(), Some(NEGOCIO_X), "nace sellada");
    db.cerrar().await.unwrap();
    drop(db);
    let _ = std::fs::remove_dir_all(&nueva);
}
