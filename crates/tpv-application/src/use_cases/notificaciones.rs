//! Casos de uso de **notificaciones**. Orquestan dominio + puertos; sin SQL ni detalles de Tauri.
//! Lecturas/gestión van por `NotificacionesRepository`; la emisión, por `Notifier`.

use tpv_contracts::notificaciones::{
    CrearNotificacionInput, MarcarLeidaInput, MarcarTodasLeidasInput, NotificacionIdInput,
    NotificacionRow, NotificacionesListArgs, NotificacionesUsuarioArgs,
};
use tpv_domain::notificaciones::NuevaNotificacion;

use crate::error::{AppError, AppResult};
use crate::ports::notificaciones::{NotificacionesRepository, Notifier};

/// Lista las notificaciones visibles de un usuario. Sin usuario => lista vacía (sin tocar el repo).
pub async fn listar(
    repo: &dyn NotificacionesRepository,
    args: NotificacionesListArgs,
) -> AppResult<Vec<NotificacionRow>> {
    let id_usuario = args.id_usuario.trim();
    if id_usuario.is_empty() {
        return Ok(Vec::new());
    }
    repo.listar(id_usuario, args.solo_no_leidas.unwrap_or(false))
        .await
}

/// Contador de no leídas de un usuario (para el badge). Sin usuario => 0.
pub async fn contar_no_leidas(
    repo: &dyn NotificacionesRepository,
    args: NotificacionesUsuarioArgs,
) -> AppResult<i64> {
    let id_usuario = args.id_usuario.trim();
    if id_usuario.is_empty() {
        return Ok(0);
    }
    repo.contar_no_leidas(id_usuario).await
}

/// Marca una notificación como leída por un usuario.
pub async fn marcar_leida(
    repo: &dyn NotificacionesRepository,
    input: MarcarLeidaInput,
) -> AppResult<bool> {
    let id_notificacion = input.id_notificacion.trim();
    let id_usuario = input.id_usuario.trim();
    if id_notificacion.is_empty() || id_usuario.is_empty() {
        return Err(AppError::validation("id_notificacion e id_usuario requeridos"));
    }
    repo.marcar_leida(id_notificacion, id_usuario).await
}

/// Marca como leídas todas las notificaciones visibles de un usuario.
pub async fn marcar_todas_leidas(
    repo: &dyn NotificacionesRepository,
    input: MarcarTodasLeidasInput,
) -> AppResult<i64> {
    let id_usuario = input.id_usuario.trim();
    if id_usuario.is_empty() {
        return Err(AppError::validation("id_usuario requerido"));
    }
    repo.marcar_todas_leidas(id_usuario).await
}

/// Manda una notificación a la papelera. Reversible con [`restaurar`].
pub async fn descartar(
    repo: &dyn NotificacionesRepository,
    input: NotificacionIdInput,
) -> AppResult<bool> {
    repo.descartar(id_no_vacio(&input.id_notificacion)?).await
}

/// Contenido de la papelera visible para un usuario. Sin usuario => lista vacía.
pub async fn listar_descartadas(
    repo: &dyn NotificacionesRepository,
    args: NotificacionesUsuarioArgs,
) -> AppResult<Vec<NotificacionRow>> {
    let id_usuario = args.id_usuario.trim();
    if id_usuario.is_empty() {
        return Ok(Vec::new());
    }
    repo.listar_descartadas(id_usuario).await
}

/// Saca una notificación de la papelera y la devuelve al centro.
pub async fn restaurar(
    repo: &dyn NotificacionesRepository,
    input: NotificacionIdInput,
) -> AppResult<bool> {
    repo.restaurar(id_no_vacio(&input.id_notificacion)?).await
}

/// Borra una notificación para siempre. No hay vuelta atrás: sólo se ofrece desde la papelera.
pub async fn eliminar(
    repo: &dyn NotificacionesRepository,
    input: NotificacionIdInput,
) -> AppResult<bool> {
    repo.eliminar(id_no_vacio(&input.id_notificacion)?).await
}

/// Un id vacío llegaría al SQL como un `WHERE ID = ''`: no borra nada, pero tampoco avisa de que
/// la llamada venía mal. Mejor un error de validación.
fn id_no_vacio(id: &str) -> AppResult<&str> {
    let id = id.trim();
    if id.is_empty() {
        return Err(AppError::validation("id_notificacion requerido"));
    }
    Ok(id)
}

/// Emite una notificación manual (validando en el dominio). Devuelve su `ID_Notificacion`.
pub async fn crear(notifier: &dyn Notifier, input: CrearNotificacionInput) -> AppResult<String> {
    let nueva = NuevaNotificacion::validar(tpv_domain::notificaciones::NotificacionEntrada {
        tipo: input.tipo,
        severidad: input.severidad.as_deref().unwrap_or("info"),
        titulo: input.titulo,
        cuerpo: input.cuerpo,
        destino_tipo: &input.destino_tipo,
        destino_valor: input.destino_valor,
        accion: input.accion,
        payload: input.payload,
        clave_dedupe: input.clave_dedupe,
        expira_en: input.expira_en,
    })
    .map_err(AppError::validation)?;

    notifier.emitir(nueva).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;

    struct RepoQueNoDebeLlamarse;

    #[async_trait]
    impl NotificacionesRepository for RepoQueNoDebeLlamarse {
        async fn listar(&self, _: &str, _: bool) -> AppResult<Vec<NotificacionRow>> {
            panic!("repo llamado")
        }
        async fn contar_no_leidas(&self, _: &str) -> AppResult<i64> {
            panic!("repo llamado")
        }
        async fn marcar_leida(&self, _: &str, _: &str) -> AppResult<bool> {
            panic!("repo llamado")
        }
        async fn marcar_todas_leidas(&self, _: &str) -> AppResult<i64> {
            panic!("repo llamado")
        }
        async fn descartar(&self, _: &str) -> AppResult<bool> {
            panic!("repo llamado")
        }
        async fn listar_descartadas(&self, _: &str) -> AppResult<Vec<NotificacionRow>> {
            panic!("repo llamado")
        }
        async fn restaurar(&self, _: &str) -> AppResult<bool> {
            panic!("repo llamado")
        }
        async fn eliminar(&self, _: &str) -> AppResult<bool> {
            panic!("repo llamado")
        }
    }

    struct NotifierQueNoDebeLlamarse;

    #[async_trait]
    impl Notifier for NotifierQueNoDebeLlamarse {
        async fn emitir(&self, _: NuevaNotificacion) -> AppResult<String> {
            panic!("notifier llamado")
        }
        async fn resolver_por_clave(&self, _: &str) -> AppResult<bool> {
            panic!("notifier llamado")
        }
    }

    #[tokio::test]
    async fn listar_sin_usuario_no_toca_repo() {
        let args = NotificacionesListArgs { id_usuario: "  ".into(), solo_no_leidas: None };
        assert!(listar(&RepoQueNoDebeLlamarse, args).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn contar_sin_usuario_devuelve_cero() {
        let args = NotificacionesUsuarioArgs { id_usuario: "".into() };
        assert_eq!(contar_no_leidas(&RepoQueNoDebeLlamarse, args).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn marcar_leida_exige_ids() {
        let input = MarcarLeidaInput { id_notificacion: " ".into(), id_usuario: "u1".into() };
        assert!(matches!(
            marcar_leida(&RepoQueNoDebeLlamarse, input).await,
            Err(AppError::Validation(_))
        ));
    }

    #[tokio::test]
    async fn las_acciones_de_la_papelera_exigen_id() {
        // Un id vacío daría un UPDATE/DELETE que no toca nada y una UI que dice "hecho".
        for id in ["", "   "] {
            let input = NotificacionIdInput { id_notificacion: id.into() };
            assert!(matches!(
                descartar(&RepoQueNoDebeLlamarse, input.clone()).await,
                Err(AppError::Validation(_))
            ));

            let input = NotificacionIdInput { id_notificacion: id.into() };
            assert!(matches!(
                restaurar(&RepoQueNoDebeLlamarse, input.clone()).await,
                Err(AppError::Validation(_))
            ));

            let input = NotificacionIdInput { id_notificacion: id.into() };
            assert!(matches!(
                eliminar(&RepoQueNoDebeLlamarse, input).await,
                Err(AppError::Validation(_))
            ));
        }
    }

    #[tokio::test]
    async fn la_papelera_sin_usuario_no_toca_repo() {
        let args = NotificacionesUsuarioArgs { id_usuario: " ".into() };
        assert!(listar_descartadas(&RepoQueNoDebeLlamarse, args)
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn crear_invalido_no_toca_notifier() {
        // 'usuario' sin valor => validación de dominio falla antes de tocar el notifier.
        let input = CrearNotificacionInput {
            tipo: "aviso_manual".into(),
            severidad: None,
            titulo: "Hola".into(),
            cuerpo: None,
            destino_tipo: "usuario".into(),
            destino_valor: None,
            accion: None,
            payload: None,
            clave_dedupe: None,
            expira_en: None,
        };
        assert!(matches!(
            crear(&NotifierQueNoDebeLlamarse, input).await,
            Err(AppError::Validation(_))
        ));
    }
}
