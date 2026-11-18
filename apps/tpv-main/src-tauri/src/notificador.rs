//! El `Notifier` de la Main, que además avisa a su pantalla.
//!
//! En la Main el `Notifier` es el repositorio SQLite: escribe el aviso y la réplica lo sube, pero su
//! propia pantalla de Notificaciones no se enteraba. Lo que llega de otro equipo sí la refresca (la
//! réplica emite `sync:cambio`), y lo que creaban aquí los jobs (`avisos`, `stock_negativo`,
//! `caja_sin_cerrar`…) o los casos de uso no: el aviso salía al cambiar de pantalla. Esto envuelve el
//! repositorio y, tras un `emitir` o un `resolver_por_clave` que cambie algo, avisa con
//! `sync:cambio { tablas: ["notificaciones"] }`, el mismo evento que escucha `socketMain.ts`. Cubre a
//! todo el que emite, porque todos lo piden a `AppState::notifier`.
//!
//! En la Handy no hace falta: su `Notifier` va a la nube, que se lo difunde de vuelta.

use std::sync::Arc;

use async_trait::async_trait;
use tauri::{AppHandle, Emitter};
use tpv_application::error::AppResult;
use tpv_application::ports::notificaciones::Notifier;
use tpv_contracts::sync::{CambioReplicado, ComandaReplicada};
use tpv_domain::notificaciones::NuevaNotificacion;
use tpv_infra_sqlite::notificaciones::SqliteNotificacionesRepository;

/// Avisa a la pantalla de que han cambiado las notificaciones.
pub(crate) type AvisarPantalla = Arc<dyn Fn() + Send + Sync>;

/// El aviso de verdad: el evento que escucha la pantalla de la Main.
pub(crate) fn avisar_con_evento(app: AppHandle) -> AvisarPantalla {
    Arc::new(move || {
        let _ = app.emit(
            "sync:cambio",
            CambioReplicado {
                tablas: Some(vec!["notificaciones".into()]),
                comanda: ComandaReplicada { ids: vec![], touched_comanda: false, uncertain: false, touched_catalog: false },
            },
        );
    })
}

pub(crate) struct NotifierDeLaMain {
    repo: SqliteNotificacionesRepository,
    avisar: AvisarPantalla,
}

impl NotifierDeLaMain {
    pub(crate) fn new(repo: SqliteNotificacionesRepository, avisar: AvisarPantalla) -> Self {
        Self { repo, avisar }
    }
}

#[async_trait]
impl Notifier for NotifierDeLaMain {
    async fn emitir(&self, nueva: NuevaNotificacion) -> AppResult<String> {
        let (id, cambia) = self.repo.emitir_y_decir_si_cambia(nueva).await?;
        // Lo que se emite igual en cada pasada de un job no escribe nada, y tampoco avisa.
        if cambia {
            (self.avisar)();
        }
        Ok(id)
    }

    async fn resolver_por_clave(&self, clave_dedupe: &str) -> AppResult<bool> {
        let resuelta = self.repo.resolver_por_clave(clave_dedupe).await?;
        if resuelta {
            (self.avisar)();
        }
        Ok(resuelta)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tpv_domain::notificaciones::{Destino, Severidad};
    use tpv_infra_sqlite::db::Db;

    fn aviso(titulo: &str) -> NuevaNotificacion {
        NuevaNotificacion {
            tipo: "caja_abierta".into(),
            severidad: Severidad::Aviso,
            titulo: titulo.into(),
            cuerpo: None,
            destino: Destino::Todos,
            accion: None,
            payload: None,
            clave_dedupe: Some("caja_abierta".into()),
            expira_en: None,
        }
    }

    #[tokio::test]
    async fn avisa_a_la_pantalla_cuando_cambia_algo_y_solo_entonces() {
        let dir = std::env::temp_dir().join(format!("tpv-notificador-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        let avisos = Arc::new(AtomicUsize::new(0));
        let cuenta = avisos.clone();
        let notifier = NotifierDeLaMain::new(
            SqliteNotificacionesRepository::new(db),
            Arc::new(move || {
                cuenta.fetch_add(1, Ordering::SeqCst);
            }),
        );
        let vistos = || avisos.load(Ordering::SeqCst);

        notifier.emitir(aviso("La caja lleva 21 horas sin cerrarse")).await.unwrap();
        assert_eq!(vistos(), 1, "un aviso nuevo se ve sin cambiar de pantalla");
        notifier.emitir(aviso("La caja lleva 21 horas sin cerrarse")).await.unwrap();
        assert_eq!(vistos(), 1, "el mismo aviso otra vez no escribe ni avisa");
        notifier.emitir(aviso("La caja lleva 22 horas sin cerrarse")).await.unwrap();
        assert_eq!(vistos(), 2, "uno que cambia, sí");

        assert!(notifier.resolver_por_clave("caja_abierta").await.unwrap());
        assert_eq!(vistos(), 3, "resolverlo también");
        assert!(!notifier.resolver_por_clave("caja_abierta").await.unwrap());
        assert_eq!(vistos(), 3, "resolver lo que no está no avisa");
    }
}
