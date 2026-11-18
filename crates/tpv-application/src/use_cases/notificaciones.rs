//! Casos de uso de **notificaciones**. Orquestan dominio + puertos; sin SQL ni detalles de Tauri.
//! Lecturas/gestión van por `NotificacionesRepository`; la emisión, por `Notifier`.
//!
//! AUD-26: el `id_usuario` que reciben es el de la sesión del backend, y lo pone el comando: la
//! pantalla no elige en nombre de quién se lee ni se marca. Marcar leída y la papelera se lo pasan
//! al repositorio, que sólo escribe si la notificación va dirigida a ese usuario (a todos, a él o a
//! su rol) y está en el estado que toca, con la condición dentro de la propia sentencia (ver el
//! puerto). Aquí no se comprueba antes con una lectura: entre esa lectura y la escritura se podía
//! colar otro (restaurar lo que este usuario iba a borrar para siempre).

use tpv_contracts::notificaciones::{
    CrearNotificacionInput, NoLeidasDto, NotificacionIdInput, NotificacionRow, NotificacionesListArgs,
};
use tpv_domain::notificaciones::NuevaNotificacion;

use crate::error::{AppError, AppResult};
use crate::ports::notificaciones::{NotificacionesRepository, Notifier};

/// Lista las notificaciones visibles de un usuario. Sin usuario => lista vacía (sin tocar el repo).
pub async fn listar(
    repo: &dyn NotificacionesRepository,
    id_usuario: &str,
    args: NotificacionesListArgs,
) -> AppResult<Vec<NotificacionRow>> {
    let id_usuario = id_usuario.trim();
    if id_usuario.is_empty() {
        return Ok(Vec::new());
    }
    repo.listar(id_usuario, args.solo_no_leidas.unwrap_or(false))
        .await
}

/// Contador de no leídas de un usuario (para el badge). Sin usuario => 0.
pub async fn contar_no_leidas(
    repo: &dyn NotificacionesRepository,
    id_usuario: &str,
) -> AppResult<NoLeidasDto> {
    let id_usuario = id_usuario.trim();
    if id_usuario.is_empty() {
        return Ok(NoLeidasDto::default());
    }
    repo.contar_no_leidas(id_usuario).await
}

/// Marca como leída por un usuario una notificación dirigida a él (AUD-26). Sólo escribe su
/// recibo: lo leído es de cada uno, así que no cambia lo que ven los demás.
pub async fn marcar_leida(
    repo: &dyn NotificacionesRepository,
    id_usuario: &str,
    input: NotificacionIdInput,
) -> AppResult<bool> {
    let id_notificacion = id_no_vacio(&input.id_notificacion)?;
    let id_usuario = usuario_no_vacio(id_usuario)?;
    repo.marcar_leida(id_notificacion, id_usuario).await
}

/// Marca como leídas todas las notificaciones visibles de un usuario.
pub async fn marcar_todas_leidas(
    repo: &dyn NotificacionesRepository,
    id_usuario: &str,
) -> AppResult<i64> {
    repo.marcar_todas_leidas(usuario_no_vacio(id_usuario)?).await
}

/// Manda una notificación a la papelera. Reversible con [`restaurar`]. Sólo una activa dirigida
/// al usuario (AUD-26).
pub async fn descartar(
    repo: &dyn NotificacionesRepository,
    id_usuario: &str,
    input: NotificacionIdInput,
) -> AppResult<bool> {
    let id_notificacion = id_no_vacio(&input.id_notificacion)?;
    repo.descartar(id_notificacion, usuario_no_vacio(id_usuario)?).await
}

/// Contenido de la papelera visible para un usuario. Sin usuario => lista vacía.
pub async fn listar_descartadas(
    repo: &dyn NotificacionesRepository,
    id_usuario: &str,
) -> AppResult<Vec<NotificacionRow>> {
    let id_usuario = id_usuario.trim();
    if id_usuario.is_empty() {
        return Ok(Vec::new());
    }
    repo.listar_descartadas(id_usuario).await
}

/// Saca una notificación de la papelera y la devuelve al centro. Sólo una de la papelera del
/// usuario (AUD-26).
pub async fn restaurar(
    repo: &dyn NotificacionesRepository,
    id_usuario: &str,
    input: NotificacionIdInput,
) -> AppResult<bool> {
    let id_notificacion = id_no_vacio(&input.id_notificacion)?;
    repo.restaurar(id_notificacion, usuario_no_vacio(id_usuario)?).await
}

/// Borra una notificación para siempre. No hay vuelta atrás: sólo se ofrece desde la papelera, y
/// sólo vale para una que esté en la del usuario cuando se borra (AUD-26).
pub async fn eliminar(
    repo: &dyn NotificacionesRepository,
    id_usuario: &str,
    input: NotificacionIdInput,
) -> AppResult<bool> {
    let id_notificacion = id_no_vacio(&input.id_notificacion)?;
    repo.eliminar(id_notificacion, usuario_no_vacio(id_usuario)?).await
}

/// Un id vacío llegaría al SQL como un `WHERE ID = ''`: no borra nada, pero tampoco avisa de que
/// la llamada venía mal. Mejor un error de validación.
fn id_no_vacio(id: &str) -> AppResult<&str> {
    let id = id.trim();
    if id.is_empty() {
        return Err(AppError::validation("Falta la notificación."));
    }
    Ok(id)
}

fn usuario_no_vacio(id_usuario: &str) -> AppResult<&str> {
    let id_usuario = id_usuario.trim();
    if id_usuario.is_empty() {
        return Err(AppError::validation("Falta el usuario."));
    }
    Ok(id_usuario)
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
    use std::sync::Mutex;

    struct RepoQueNoDebeLlamarse;

    #[async_trait]
    impl NotificacionesRepository for RepoQueNoDebeLlamarse {
        async fn listar(&self, _: &str, _: bool) -> AppResult<Vec<NotificacionRow>> {
            panic!("repo llamado")
        }
        async fn contar_no_leidas(&self, _: &str) -> AppResult<NoLeidasDto> {
            panic!("repo llamado")
        }
        async fn marcar_leida(&self, _: &str, _: &str) -> AppResult<bool> {
            panic!("repo llamado")
        }
        async fn marcar_todas_leidas(&self, _: &str) -> AppResult<i64> {
            panic!("repo llamado")
        }
        async fn descartar(&self, _: &str, _: &str) -> AppResult<bool> {
            panic!("repo llamado")
        }
        async fn listar_descartadas(&self, _: &str) -> AppResult<Vec<NotificacionRow>> {
            panic!("repo llamado")
        }
        async fn restaurar(&self, _: &str, _: &str) -> AppResult<bool> {
            panic!("repo llamado")
        }
        async fn eliminar(&self, _: &str, _: &str) -> AppResult<bool> {
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

    fn id(id_notificacion: &str) -> NotificacionIdInput {
        NotificacionIdInput { id_notificacion: id_notificacion.into() }
    }

    #[tokio::test]
    async fn listar_sin_usuario_no_toca_repo() {
        let args = NotificacionesListArgs { solo_no_leidas: None };
        assert!(listar(&RepoQueNoDebeLlamarse, "  ", args).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn contar_sin_usuario_devuelve_cero() {
        assert_eq!(contar_no_leidas(&RepoQueNoDebeLlamarse, "").await.unwrap(), NoLeidasDto::default());
    }

    #[tokio::test]
    async fn marcar_leida_exige_ids() {
        assert!(matches!(
            marcar_leida(&RepoQueNoDebeLlamarse, "u1", id(" ")).await,
            Err(AppError::Validation(_))
        ));
        assert!(matches!(
            marcar_leida(&RepoQueNoDebeLlamarse, " ", id("n1")).await,
            Err(AppError::Validation(_))
        ));
    }

    #[tokio::test]
    async fn las_acciones_de_la_papelera_exigen_id_y_usuario() {
        // Un id vacío daría un UPDATE/DELETE que no toca nada y una UI que dice "hecho".
        for (usuario, notificacion) in [("u1", ""), ("u1", "   "), ("", "n1"), ("  ", "n1")] {
            assert!(matches!(
                descartar(&RepoQueNoDebeLlamarse, usuario, id(notificacion)).await,
                Err(AppError::Validation(_))
            ));
            assert!(matches!(
                restaurar(&RepoQueNoDebeLlamarse, usuario, id(notificacion)).await,
                Err(AppError::Validation(_))
            ));
            assert!(matches!(
                eliminar(&RepoQueNoDebeLlamarse, usuario, id(notificacion)).await,
                Err(AppError::Validation(_))
            ));
        }
    }

    #[tokio::test]
    async fn la_papelera_sin_usuario_no_toca_repo() {
        assert!(listar_descartadas(&RepoQueNoDebeLlamarse, " ")
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

    // ── AUD-26: el usuario llega a la escritura ─────────────────────────────────────────────

    /// Apunta lo que se le pide escribir y en nombre de quién. Lo que decide si se escribe es el
    /// repositorio (con la condición dentro de la sentencia): aquí sólo importa que el caso de uso
    /// no se quede el usuario por el camino ni compruebe por su cuenta antes.
    #[derive(Default)]
    struct Apunta(Mutex<Vec<String>>);

    impl Apunta {
        fn apuntar(&self, que: String) -> AppResult<bool> {
            self.0.lock().unwrap().push(que);
            Ok(true)
        }
        fn escrituras(&self) -> Vec<String> {
            self.0.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl NotificacionesRepository for Apunta {
        async fn listar(&self, _: &str, _: bool) -> AppResult<Vec<NotificacionRow>> {
            panic!("no se comprueba con una lectura aparte")
        }
        async fn contar_no_leidas(&self, _: &str) -> AppResult<NoLeidasDto> {
            panic!("no se cuenta nada")
        }
        async fn marcar_leida(&self, id_notificacion: &str, id_usuario: &str) -> AppResult<bool> {
            self.apuntar(format!("leida {id_notificacion} por {id_usuario}"))
        }
        async fn marcar_todas_leidas(&self, id_usuario: &str) -> AppResult<i64> {
            self.apuntar(format!("todas por {id_usuario}"))?;
            Ok(0)
        }
        async fn descartar(&self, id_notificacion: &str, id_usuario: &str) -> AppResult<bool> {
            self.apuntar(format!("descartar {id_notificacion} por {id_usuario}"))
        }
        async fn listar_descartadas(&self, _: &str) -> AppResult<Vec<NotificacionRow>> {
            panic!("no se comprueba con una lectura aparte")
        }
        async fn restaurar(&self, id_notificacion: &str, id_usuario: &str) -> AppResult<bool> {
            self.apuntar(format!("restaurar {id_notificacion} por {id_usuario}"))
        }
        async fn eliminar(&self, id_notificacion: &str, id_usuario: &str) -> AppResult<bool> {
            self.apuntar(format!("eliminar {id_notificacion} por {id_usuario}"))
        }
    }

    #[tokio::test]
    async fn cada_escritura_lleva_el_usuario_que_se_recibe_y_no_lee_antes() {
        let repo = Apunta::default();

        marcar_leida(&repo, "camarero", id("n1")).await.unwrap();
        marcar_todas_leidas(&repo, " camarero ").await.unwrap();
        descartar(&repo, "camarero", id(" n1 ")).await.unwrap();
        restaurar(&repo, "camarero", id("n1")).await.unwrap();
        eliminar(&repo, "camarero", id("n1")).await.unwrap();

        assert_eq!(
            repo.escrituras(),
            [
                "leida n1 por camarero",
                "todas por camarero",
                "descartar n1 por camarero",
                "restaurar n1 por camarero",
                "eliminar n1 por camarero",
            ]
        );
    }
}
