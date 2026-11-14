//! PERM-CACHE · La autorización de la sesión de una Handy, guardada entre comprobaciones.
//!
//! Cada gate (`exigir_permiso`, `exigir_rol`, `sesion`) relee el usuario y sus concesiones. En la
//! Main es una lectura de su SQLite. En la Handy era un viaje a la nube delante de cada acción:
//! dos viajes por pulsación. Aquí se guarda la respuesta y se tira en cuanto puede haber cambiado.
//!
//! Dónde se hace cumplir: los permisos personales se comprueban **en Rust**, en la Main y en la
//! Handy; el Worker autentica al dispositivo, no a la persona (SEC-SESION, `docs/pendientes.md`).
//! Lo que se guarda aquí es, por tanto, la comprobación de la propia Handy. Lo que hace cumplir el
//! Worker (licencia, dispositivo, lo que sólo hace la Main) no pasa por esto ni cambia.
//!
//! Cuándo vale lo guardado, y nada más que entonces:
//!
//! - **Sólo con el canal de avisos abierto.** Los cambios de permisos llegan por el socket de avisos
//!   de la Handy. Con él abierto, un cambio en `Usuarios`, `Roles` o `Roles_Permisos` tira lo
//!   guardado antes de que la pantalla se entere. Sin él (conectando, reintentando, rechazada) no se
//!   guarda nada y cada gate pregunta a la nube, como siempre. En la Main no hay canal: nunca se
//!   guarda.
//! - **De una conexión, no de la anterior.** Mientras el socket estuvo caído pudo perderse un
//!   aviso: al abrirse otra conexión, lo guardado con la anterior no vale.
//! - **De esta sesión.** Otra sesión, aunque sea de la misma persona, no hereda nada.
//! - **Como mucho [`EDAD_MAXIMA_MS`].** Es la red por si un aviso no llega con el socket abierto.
//!
//! Sólo se guardan respuestas buenas: un usuario desactivado se deniega preguntando cada vez. Y una
//! respuesta que venía de camino cuando se tiró lo guardado ni se guarda ni se usa: se vuelve a
//! preguntar (`usuario_de_la_sesion`).

use std::sync::{Mutex, MutexGuard};

use tpv_contracts::{permisos::AutorizacionUsuario, socket_handy::{ConexionHandy, EstadoSocketHandy}, sync::CambioReplicado};

use super::permisos;
use crate::{error::AppResult, ports::permisos::PermisosRepository};

/// Lo más que vale una autorización guardada aunque no llegue ningún aviso: cinco minutos.
///
/// Con el socket abierto, un permiso retirado deja de valer en lo que tarda su aviso. Esto cubre el
/// aviso que no llega: el socket parece abierto y está muerto (el latido tarda hasta minuto y medio
/// en notarlo y reconectar), o la nube confirmó el cambio y se reinició antes de difundirlo. Tiene
/// que ser más que eso, para no adelantarse a la reconexión, y bastante menos que el cierre por
/// inactividad (10 minutos) y que un turno. A cinco minutos, una Handy en uso pregunta doce veces
/// por hora en vez de una por acción.
pub const EDAD_MAXIMA_MS: u64 = 5 * 60 * 1000;

/// De dónde sale la autorización de un usuario: su fila, su rol y las concesiones del rol.
const TABLAS: [&str; 3] = ["usuarios", "roles", "roles_permisos"];

/// ¿Puede este cambio haber movido la autorización de alguien? Un cambio sin clasificar
/// (`tablas: None`), también: no se sabe qué ha tocado.
pub fn toca_la_autorizacion(cambio: &CambioReplicado) -> bool {
    match &cambio.tablas {
        None => true,
        Some(tablas) => tablas.iter().any(|t| TABLAS.contains(&t.to_ascii_lowercase().as_str())),
    }
}

/// Un instante por los dos relojes del equipo, en milisegundos. El monótono no retrocede, pero se
/// para con el equipo suspendido; el de pared sigue, pero se puede cambiar. La edad de algo es la
/// mayor de las dos: ni suspender el equipo ni atrasar el reloj alargan lo guardado.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Instante {
    pub monotono_ms: u64,
    pub reloj_ms: u64,
}

impl Instante {
    fn desde(self, antes: Instante) -> u64 {
        self.monotono_ms.saturating_sub(antes.monotono_ms).max(self.reloj_ms.saturating_sub(antes.reloj_ms))
    }
}

/// Una conexión del socket de avisos: el vínculo (`generacion`) y la conexión dentro de él.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Canal {
    pub generacion: u64,
    pub conexion: u64,
}

impl Canal {
    /// El canal por el que están llegando los avisos, o `None` si el socket no está conectado.
    pub fn de(foto: &EstadoSocketHandy) -> Option<Self> {
        (foto.estado == ConexionHandy::Conectada).then_some(Self { generacion: foto.generacion, conexion: foto.conexion })
    }
}

struct Entrada {
    id_usuario: String,
    iniciada_en: i64,
    autorizacion: AutorizacionUsuario,
    pedida: Instante,
}

/// Lo guardado y lo que hace falta para saber si sigue valiendo. Vive en el `AppState`.
#[derive(Default)]
pub struct AutorizacionGuardada {
    canal: Option<Canal>,
    /// Sube cada vez que lo guardado deja de valer. Una respuesta pedida en un turno anterior no se
    /// guarda: mientras viajaba llegó un aviso, se cayó el socket o cambió la sesión.
    turno: u64,
    entrada: Option<Entrada>,
}

impl AutorizacionGuardada {
    /// El estado del socket de avisos ha cambiado. Otro canal que el que había (también ninguno)
    /// tira lo guardado.
    pub fn canal(&mut self, canal: Option<Canal>) {
        if self.canal != canal {
            self.canal = canal;
            self.olvidar();
        }
    }

    /// Ha llegado un aviso de cambio. Devuelve si ha tirado lo guardado.
    pub fn aviso(&mut self, cambio: &CambioReplicado) -> bool {
        let toca = toca_la_autorizacion(cambio);
        if toca {
            self.olvidar();
        }
        toca
    }

    /// Lo guardado deja de valer: cambia la sesión, o este equipo ha escrito algo que puede mover
    /// la autorización (su propio cambio no le vuelve como aviso).
    pub fn olvidar(&mut self) {
        self.turno += 1;
        self.entrada = None;
    }

    fn vigente(&self, id_usuario: &str, iniciada_en: i64, ahora: Instante) -> Option<AutorizacionUsuario> {
        self.canal?;
        let e = self.entrada.as_ref()?;
        (e.id_usuario == id_usuario && e.iniciada_en == iniciada_en && ahora.desde(e.pedida) < EDAD_MAXIMA_MS)
            .then(|| e.autorizacion.clone())
    }

    fn guardar(&mut self, turno: u64, entrada: Entrada) {
        if self.canal.is_some() && self.turno == turno {
            self.entrada = Some(entrada);
        }
    }
}

fn abrir(guardada: &Mutex<AutorizacionGuardada>) -> MutexGuard<'_, AutorizacionGuardada> {
    guardada.lock().unwrap_or_else(|e| e.into_inner())
}

/// Cuántas veces, como mucho, se pregunta en una comprobación cuando lo guardado se tira mientras la
/// pregunta viaja.
pub const PREGUNTAS_MAX: usize = 3;

/// La autorización vigente del usuario de la sesión: la guardada si vale y, si no, la del
/// repositorio, que se guarda para la siguiente. La edad cuenta desde que se pidió, no desde que
/// llegó.
///
/// Si mientras la pregunta viajaba se tiró lo guardado (llegó un aviso, cambió el socket o la
/// sesión), su respuesta puede ser la de antes del cambio: ni se guarda ni se usa, y se vuelve a
/// preguntar. La nube avisa después de aplicar el cambio, así que la pregunta siguiente ya lo ve.
/// Si los avisos no paran, a la [`PREGUNTAS_MAX`] se usa la última respuesta, sin guardarla.
pub async fn usuario_de_la_sesion(
    repo: &dyn PermisosRepository,
    guardada: &Mutex<AutorizacionGuardada>,
    id_usuario: &str,
    iniciada_en: i64,
    ahora: impl Fn() -> Instante,
) -> AppResult<AutorizacionUsuario> {
    let mut preguntas = 0;
    loop {
        let pedida = ahora();
        let turno = {
            let g = abrir(guardada);
            if let Some(autorizacion) = g.vigente(id_usuario, iniciada_en, pedida) {
                return Ok(autorizacion);
            }
            g.turno
        };
        let autorizacion = permisos::usuario(repo, id_usuario).await?;
        preguntas += 1;
        let mut g = abrir(guardada);
        if g.turno == turno || preguntas >= PREGUNTAS_MAX {
            g.guardar(
                turno,
                Entrada { id_usuario: id_usuario.to_string(), iniciada_en, autorizacion: autorizacion.clone(), pedida },
            );
            return Ok(autorizacion);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::AppError;
    use async_trait::async_trait;
    use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
    use tpv_contracts::{permisos::RolPermisos, sync::ComandaReplicada};

    /// La nube: cuenta los viajes y contesta lo que tenga puesto en ese momento.
    struct Nube {
        viajes: AtomicUsize,
        respuesta: Mutex<Option<AutorizacionUsuario>>,
    }

    impl Nube {
        fn con(rol: &str, permisos: &[&str]) -> Self {
            let nube = Self { viajes: AtomicUsize::new(0), respuesta: Mutex::new(None) };
            nube.poner(rol, permisos);
            nube
        }
        fn poner(&self, rol: &str, permisos: &[&str]) {
            *self.respuesta.lock().unwrap() =
                Some(AutorizacionUsuario { rol: rol.into(), permisos: permisos.iter().map(|p| p.to_string()).collect() });
        }
        fn desactivar(&self) {
            *self.respuesta.lock().unwrap() = None;
        }
        fn viajes(&self) -> usize {
            self.viajes.load(Ordering::SeqCst)
        }
    }

    #[async_trait]
    impl PermisosRepository for Nube {
        async fn usuario(&self, _id: &str) -> AppResult<Option<AutorizacionUsuario>> {
            self.viajes.fetch_add(1, Ordering::SeqCst);
            Ok(self.respuesta.lock().unwrap().clone())
        }
        async fn roles(&self) -> AppResult<Vec<RolPermisos>> {
            Err(AppError::validation("no se usa"))
        }
    }

    /// Los dos relojes, que avanzan a mano.
    #[derive(Default)]
    struct Relojes {
        monotono: AtomicU64,
        pared: AtomicU64,
    }

    impl Relojes {
        fn en(pared_ms: u64) -> Self {
            Self { monotono: AtomicU64::new(0), pared: AtomicU64::new(pared_ms) }
        }
        fn pasan(&self, ms: u64) {
            self.monotono.fetch_add(ms, Ordering::SeqCst);
            self.pared.fetch_add(ms, Ordering::SeqCst);
        }
        fn ahora(&self) -> Instante {
            Instante { monotono_ms: self.monotono.load(Ordering::SeqCst), reloj_ms: self.pared.load(Ordering::SeqCst) }
        }
    }

    const CONEXION: Canal = Canal { generacion: 1, conexion: 1 };

    fn conectada() -> Mutex<AutorizacionGuardada> {
        let guardada = Mutex::new(AutorizacionGuardada::default());
        guardada.lock().unwrap().canal(Some(CONEXION));
        guardada
    }

    fn cambio(tablas: Option<&[&str]>) -> CambioReplicado {
        CambioReplicado {
            tablas: tablas.map(|t| t.iter().map(|t| t.to_string()).collect()),
            comanda: ComandaReplicada { ids: vec![], touched_comanda: false, uncertain: false, touched_catalog: false },
        }
    }

    async fn pedir(nube: &Nube, guardada: &Mutex<AutorizacionGuardada>, relojes: &Relojes) -> AppResult<AutorizacionUsuario> {
        usuario_de_la_sesion(nube, guardada, "u-1", 100, || relojes.ahora()).await
    }

    fn puede(a: &AutorizacionUsuario, permiso: &str) -> bool {
        tpv_domain::permisos::permite(&a.rol, &a.permisos, permiso)
    }

    #[tokio::test]
    async fn con_el_canal_abierto_las_comprobaciones_seguidas_cuestan_un_viaje() {
        let (nube, guardada, relojes) = (Nube::con("Camarero", &["servicio.vender"]), conectada(), Relojes::en(1_000));
        for _ in 0..20 {
            assert!(puede(&pedir(&nube, &guardada, &relojes).await.unwrap(), "servicio.vender"));
            relojes.pasan(1_000);
        }
        assert_eq!(nube.viajes(), 1);
    }

    #[tokio::test]
    async fn sin_canal_no_se_guarda_nada_y_cada_comprobacion_pregunta() {
        // Es lo que hay en la Main, y en una Handy con el socket conectando, reintentando o rechazado.
        let (nube, guardada, relojes) = (Nube::con("Camarero", &["servicio.vender"]), Mutex::new(AutorizacionGuardada::default()), Relojes::en(1_000));
        for _ in 0..3 {
            pedir(&nube, &guardada, &relojes).await.unwrap();
        }
        assert_eq!(nube.viajes(), 3);
    }

    #[tokio::test]
    async fn un_aviso_que_toca_usuarios_roles_o_concesiones_retira_el_permiso_en_la_siguiente_comprobacion() {
        for tabla in ["Usuarios", "roles", "Roles_Permisos"] {
            let (nube, guardada, relojes) = (Nube::con("Encargado", &["stock.ajustar"]), conectada(), Relojes::en(1_000));
            assert!(puede(&pedir(&nube, &guardada, &relojes).await.unwrap(), "stock.ajustar"));

            // Se le retira el permiso en la Main, y llega el aviso.
            nube.poner("Encargado", &[]);
            assert!(guardada.lock().unwrap().aviso(&cambio(Some(&["comandas", tabla]))), "{tabla}");

            assert!(!puede(&pedir(&nube, &guardada, &relojes).await.unwrap(), "stock.ajustar"), "{tabla}");
            assert_eq!(nube.viajes(), 2, "{tabla}");
        }
    }

    #[tokio::test]
    async fn un_aviso_sin_clasificar_tambien_y_el_de_otras_tablas_no() {
        let (nube, guardada, relojes) = (Nube::con("Camarero", &["servicio.vender"]), conectada(), Relojes::en(1_000));
        pedir(&nube, &guardada, &relojes).await.unwrap();

        assert!(!guardada.lock().unwrap().aviso(&cambio(Some(&["comandas", "pagos", "productos"]))));
        pedir(&nube, &guardada, &relojes).await.unwrap();
        assert_eq!(nube.viajes(), 1, "un cobro no hace releer los permisos");

        assert!(guardada.lock().unwrap().aviso(&cambio(None)));
        pedir(&nube, &guardada, &relojes).await.unwrap();
        assert_eq!(nube.viajes(), 2, "sin saber qué ha cambiado, se relee");
    }

    #[tokio::test]
    async fn un_usuario_desactivado_se_deniega_y_no_se_guarda_la_denegacion() {
        let (nube, guardada, relojes) = (Nube::con("Camarero", &["servicio.vender"]), conectada(), Relojes::en(1_000));
        pedir(&nube, &guardada, &relojes).await.unwrap();

        nube.desactivar();
        guardada.lock().unwrap().aviso(&cambio(Some(&["usuarios"])));
        for _ in 0..2 {
            let e = pedir(&nube, &guardada, &relojes).await.unwrap_err();
            assert_eq!(e.code(), tpv_contracts::errors::ErrorCode::PermisoDenegado);
        }
        assert_eq!(nube.viajes(), 3, "la denegación se pregunta cada vez");
    }

    #[tokio::test]
    async fn otra_conexion_o_el_socket_caido_no_heredan_lo_guardado() {
        let (nube, guardada, relojes) = (Nube::con("Camarero", &["servicio.vender"]), conectada(), Relojes::en(1_000));
        pedir(&nube, &guardada, &relojes).await.unwrap();

        // El socket se cae: mientras tanto pudo perderse un aviso, y nada se guarda.
        guardada.lock().unwrap().canal(None);
        pedir(&nube, &guardada, &relojes).await.unwrap();
        pedir(&nube, &guardada, &relojes).await.unwrap();
        assert_eq!(nube.viajes(), 3);

        // Reconecta: se vuelve a guardar, con lo que diga la nube ahora.
        guardada.lock().unwrap().canal(Some(Canal { generacion: 1, conexion: 2 }));
        pedir(&nube, &guardada, &relojes).await.unwrap();
        pedir(&nube, &guardada, &relojes).await.unwrap();
        assert_eq!(nube.viajes(), 4);

        // La misma conexión anunciada otra vez (cambia la presencia de la Main) no tira nada.
        guardada.lock().unwrap().canal(Some(Canal { generacion: 1, conexion: 2 }));
        pedir(&nube, &guardada, &relojes).await.unwrap();
        assert_eq!(nube.viajes(), 4);
    }

    #[tokio::test]
    async fn otra_sesion_no_hereda_lo_guardado_ni_siendo_la_misma_persona() {
        let (nube, guardada, relojes) = (Nube::con("Administrador", &[]), conectada(), Relojes::en(1_000));
        usuario_de_la_sesion(&nube, &guardada, "u-1", 100, || relojes.ahora()).await.unwrap();

        // Otro usuario, y el mismo en una sesión posterior, aunque nadie haya avisado del cambio.
        usuario_de_la_sesion(&nube, &guardada, "u-2", 100, || relojes.ahora()).await.unwrap();
        usuario_de_la_sesion(&nube, &guardada, "u-1", 200, || relojes.ahora()).await.unwrap();
        assert_eq!(nube.viajes(), 3);

        // Y al cerrar o cambiar la sesión se tira.
        guardada.lock().unwrap().olvidar();
        usuario_de_la_sesion(&nube, &guardada, "u-1", 200, || relojes.ahora()).await.unwrap();
        assert_eq!(nube.viajes(), 4);
    }

    #[tokio::test]
    async fn sin_ningun_aviso_lo_guardado_caduca_a_los_cinco_minutos() {
        let (nube, guardada, relojes) = (Nube::con("Encargado", &["stock.ajustar"]), conectada(), Relojes::en(1_000));
        pedir(&nube, &guardada, &relojes).await.unwrap();

        // El permiso se retira y el aviso se pierde.
        nube.poner("Encargado", &[]);
        relojes.pasan(EDAD_MAXIMA_MS - 1);
        assert!(puede(&pedir(&nube, &guardada, &relojes).await.unwrap(), "stock.ajustar"));
        assert_eq!(nube.viajes(), 1);

        relojes.pasan(1);
        assert!(!puede(&pedir(&nube, &guardada, &relojes).await.unwrap(), "stock.ajustar"));
        assert_eq!(nube.viajes(), 2);
    }

    #[tokio::test]
    async fn ni_suspender_el_equipo_ni_atrasar_el_reloj_alargan_lo_guardado() {
        // Suspendido, el reloj monótono se para: cuenta el de pared.
        let (nube, guardada, relojes) = (Nube::con("Camarero", &[]), conectada(), Relojes::en(1_000_000));
        pedir(&nube, &guardada, &relojes).await.unwrap();
        relojes.pared.fetch_add(EDAD_MAXIMA_MS, Ordering::SeqCst);
        pedir(&nube, &guardada, &relojes).await.unwrap();
        assert_eq!(nube.viajes(), 2);

        // Con el reloj de pared atrasado una hora, cuenta el monótono.
        relojes.pared.fetch_sub(60 * 60 * 1000, Ordering::SeqCst);
        pedir(&nube, &guardada, &relojes).await.unwrap();
        assert_eq!(nube.viajes(), 3, "al atrasar el reloj lo guardado sigue teniendo su edad");
        relojes.monotono.fetch_add(EDAD_MAXIMA_MS, Ordering::SeqCst);
        pedir(&nube, &guardada, &relojes).await.unwrap();
        assert_eq!(nube.viajes(), 4);
    }

    /// Una nube que tarda: deja meter algo entre la petición y su respuesta.
    struct NubeLenta {
        nube: Nube,
        salida: tokio::sync::Notify,
        llegada: tokio::sync::Notify,
    }

    #[async_trait]
    impl PermisosRepository for NubeLenta {
        async fn usuario(&self, id: &str) -> AppResult<Option<AutorizacionUsuario>> {
            let respuesta = self.nube.usuario(id).await;
            self.salida.notify_one();
            self.llegada.notified().await;
            respuesta
        }
        async fn roles(&self) -> AppResult<Vec<RolPermisos>> {
            Err(AppError::validation("no se usa"))
        }
    }

    #[tokio::test]
    async fn una_respuesta_que_venia_de_camino_cuando_llego_el_aviso_no_se_usa_y_se_vuelve_a_preguntar() {
        let lenta = NubeLenta { nube: Nube::con("Encargado", &["stock.ajustar"]), salida: tokio::sync::Notify::new(), llegada: tokio::sync::Notify::new() };
        let (guardada, relojes) = (conectada(), Relojes::en(1_000));

        let en_vuelo = usuario_de_la_sesion(&lenta, &guardada, "u-1", 100, || relojes.ahora());
        let aviso = async {
            // La nube ya ha leído (con el permiso todavía puesto) y la respuesta viene de camino.
            lenta.salida.notified().await;
            lenta.nube.poner("Encargado", &[]);
            guardada.lock().unwrap().aviso(&cambio(Some(&["roles_permisos"])));
            lenta.llegada.notify_one();
            // La segunda pregunta sale después del aviso.
            lenta.salida.notified().await;
            lenta.llegada.notify_one();
        };
        let (respuesta, ()) = tokio::join!(en_vuelo, aviso);
        // La que venía de camino decía lo de antes: el gate que la esperaba ve lo de ahora.
        assert!(!puede(&respuesta.unwrap(), "stock.ajustar"));
        assert_eq!(lenta.nube.viajes(), 2);

        // Y lo de ahora queda guardado: la siguiente no pregunta.
        let siguiente = usuario_de_la_sesion(&lenta, &guardada, "u-1", 100, || relojes.ahora()).await.unwrap();
        assert!(!puede(&siguiente, "stock.ajustar"));
        assert_eq!(lenta.nube.viajes(), 2);
    }

    /// Una nube que, cada vez que contesta, hace llegar un aviso que lo tira todo.
    struct NubeConAvisos<'a> {
        nube: Nube,
        guardada: &'a Mutex<AutorizacionGuardada>,
    }

    #[async_trait]
    impl PermisosRepository for NubeConAvisos<'_> {
        async fn usuario(&self, id: &str) -> AppResult<Option<AutorizacionUsuario>> {
            let respuesta = self.nube.usuario(id).await;
            self.guardada.lock().unwrap().aviso(&cambio(None));
            respuesta
        }
        async fn roles(&self) -> AppResult<Vec<RolPermisos>> {
            Err(AppError::validation("no se usa"))
        }
    }

    #[tokio::test]
    async fn si_los_avisos_no_paran_se_pregunta_como_mucho_tres_veces_y_no_se_guarda() {
        let (guardada, relojes) = (conectada(), Relojes::en(1_000));
        let nube = NubeConAvisos { nube: Nube::con("Camarero", &["servicio.vender"]), guardada: &guardada };

        let respuesta = usuario_de_la_sesion(&nube, &guardada, "u-1", 100, || relojes.ahora()).await.unwrap();
        assert!(puede(&respuesta, "servicio.vender"));
        assert_eq!(nube.nube.viajes(), PREGUNTAS_MAX);
        assert!(guardada.lock().unwrap().entrada.is_none());
    }

    #[test]
    fn el_canal_es_el_de_un_socket_conectado() {
        let foto = |estado| EstadoSocketHandy {
            revision: 3, generacion: 2, conexion: 5, tenant_id: Some("negocio".into()),
            estado, main_online: Some(false), volcando: false, rechazo: None,
        };
        // Con la Main desconectada los avisos siguen llegando: el canal es el socket, no la Main.
        assert_eq!(Canal::de(&foto(ConexionHandy::Conectada)), Some(Canal { generacion: 2, conexion: 5 }));
        for estado in [ConexionHandy::Pausada, ConexionHandy::SinIdentidad, ConexionHandy::Conectando, ConexionHandy::Reintentando, ConexionHandy::Rechazada] {
            assert_eq!(Canal::de(&foto(estado)), None);
        }
    }
}
