//! Casos de uso de tareas. Local-First: validan con el dominio e invocan el puerto.

use tpv_contracts::tareas::{
    CreateTareaInput, FinalizarTareaInput, MisTareasArgs, MisTareasRow, SetAsignacionesTareaInput,
    TareaAdminRow, TareaAsignadoRow, TareaIdArgs, TareaRow, TrabajadorUI, UpdateTareaInput,
};
use tpv_domain::tareas::{limpiar_opcional, normalizar_ids, requerido, TareaData};

use crate::error::{AppError, AppResult};
use crate::ports::tareas::TareasRepository;

/* Lecturas */

pub async fn get_trabajadores(repo: &dyn TareasRepository) -> AppResult<Vec<TrabajadorUI>> {
    repo.get_trabajadores().await
}

pub async fn get_tareas_admin(repo: &dyn TareasRepository) -> AppResult<Vec<TareaAdminRow>> {
    repo.get_tareas_admin().await
}

pub async fn get_tarea_by_id(
    repo: &dyn TareasRepository,
    args: TareaIdArgs,
) -> AppResult<Option<TareaRow>> {
    if args.id_tarea.trim().is_empty() {
        return Ok(None);
    }
    repo.get_tarea_by_id(&args.id_tarea).await
}

pub async fn get_tarea_asignados(
    repo: &dyn TareasRepository,
    args: TareaIdArgs,
) -> AppResult<Vec<TareaAsignadoRow>> {
    if args.id_tarea.trim().is_empty() {
        return Ok(vec![]);
    }
    repo.get_tarea_asignados(&args.id_tarea).await
}

pub async fn get_mis_tareas(
    repo: &dyn TareasRepository,
    args: MisTareasArgs,
) -> AppResult<Vec<MisTareasRow>> {
    if args.id_trabajador.trim().is_empty() {
        return Ok(vec![]);
    }
    repo.get_mis_tareas(&args.id_trabajador).await
}

/* Escrituras */

pub async fn create_tarea(repo: &dyn TareasRepository, input: CreateTareaInput) -> AppResult<bool> {
    let titulo = requerido(&input.titulo, "titulo").map_err(AppError::validation)?;
    let ids_trabajadores = normalizar_ids(input.ids_trabajadores);

    if ids_trabajadores.is_empty() {
        return Err(AppError::validation("ids_trabajadores required"));
    }

    let data = TareaData {
        titulo,
        descripcion: limpiar_opcional(input.descripcion),
        fecha_limite: limpiar_opcional(input.fecha_limite),
    };

    repo.create_tarea(data, ids_trabajadores).await
}

pub async fn update_tarea(repo: &dyn TareasRepository, input: UpdateTareaInput) -> AppResult<bool> {
    if input.id_tarea.trim().is_empty() {
        return Err(AppError::validation("id_tarea required"));
    }

    let titulo = requerido(&input.titulo, "titulo").map_err(AppError::validation)?;

    let data = TareaData {
        titulo,
        descripcion: limpiar_opcional(input.descripcion),
        fecha_limite: limpiar_opcional(input.fecha_limite),
    };

    repo.update_tarea(&input.id_tarea, data).await
}

pub async fn set_asignaciones(
    repo: &dyn TareasRepository,
    input: SetAsignacionesTareaInput,
) -> AppResult<bool> {
    if input.id_tarea.trim().is_empty() {
        return Err(AppError::validation("id_tarea required"));
    }

    repo.set_asignaciones(&input.id_tarea, normalizar_ids(input.ids_trabajadores))
        .await
}

pub async fn delete_tarea(repo: &dyn TareasRepository, args: TareaIdArgs) -> AppResult<bool> {
    if args.id_tarea.trim().is_empty() {
        return Err(AppError::validation("id_tarea required"));
    }
    repo.delete_tarea(&args.id_tarea).await
}

pub async fn marcar_finalizada(
    repo: &dyn TareasRepository,
    input: FinalizarTareaInput,
) -> AppResult<bool> {
    if input.id_tarea.trim().is_empty() || input.id_trabajador.trim().is_empty() {
        return Err(AppError::validation("id_tarea/id_trabajador required"));
    }
    repo.marcar_finalizada(&input.id_tarea, &input.id_trabajador).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use std::sync::Mutex;

    /// Repositorio falso en memoria: en vez de tocar SQLite, **registra** lo que el caso de uso le
    /// pasa a cada escritura, para poder afirmar sobre la validación/normalización (título recortado,
    /// ids deduplicados y ordenados…). Es el equivalente hexagonal a un "mock": implementamos el
    /// puerto a mano, sin librería de mocking.
    #[derive(Default)]
    struct FakeRepo {
        create: Mutex<Vec<(TareaData, Vec<String>)>>,
        update: Mutex<Vec<(String, TareaData)>>,
        asignaciones: Mutex<Vec<(String, Vec<String>)>>,
        delete: Mutex<Vec<String>>,
        finalizar: Mutex<Vec<(String, String)>>,
    }

    #[async_trait]
    impl TareasRepository for FakeRepo {
        async fn get_trabajadores(&self) -> AppResult<Vec<TrabajadorUI>> {
            Ok(vec![])
        }
        async fn get_tareas_admin(&self) -> AppResult<Vec<TareaAdminRow>> {
            Ok(vec![])
        }
        async fn get_tarea_by_id(&self, _id: &str) -> AppResult<Option<TareaRow>> {
            Ok(None)
        }
        async fn get_tarea_asignados(&self, _id: &str) -> AppResult<Vec<TareaAsignadoRow>> {
            Ok(vec![])
        }
        async fn get_mis_tareas(&self, _id: &str) -> AppResult<Vec<MisTareasRow>> {
            Ok(vec![])
        }

        async fn create_tarea(&self, data: TareaData, ids: Vec<String>) -> AppResult<bool> {
            self.create.lock().unwrap().push((data, ids));
            Ok(true)
        }
        async fn update_tarea(&self, id: &str, data: TareaData) -> AppResult<bool> {
            self.update.lock().unwrap().push((id.to_string(), data));
            Ok(true)
        }
        async fn set_asignaciones(&self, id: &str, ids: Vec<String>) -> AppResult<bool> {
            self.asignaciones.lock().unwrap().push((id.to_string(), ids));
            Ok(true)
        }
        async fn delete_tarea(&self, id: &str) -> AppResult<bool> {
            self.delete.lock().unwrap().push(id.to_string());
            Ok(true)
        }
        async fn marcar_finalizada(&self, id: &str, trab: &str) -> AppResult<bool> {
            self.finalizar.lock().unwrap().push((id.to_string(), trab.to_string()));
            Ok(true)
        }
    }

    fn es_validacion(e: AppError) -> bool {
        matches!(e, AppError::Validation(_))
    }

    // ── create_tarea ──────────────────────────────────────────────

    #[tokio::test]
    async fn create_tarea_recorta_titulo_normaliza_ids_y_limpia_opcionales() {
        let repo = FakeRepo::default();
        let input = CreateTareaInput {
            titulo: "  Limpiar barra  ".into(),
            descripcion: Some("   ".into()), // sólo espacios → None
            fecha_limite: Some(" 2026-01-01 ".into()),
            ids_trabajadores: vec!["t2".into(), " t1 ".into(), "t2".into(), "  ".into()],
        };
        assert!(create_tarea(&repo, input).await.unwrap());

        let calls = repo.create.lock().unwrap();
        assert_eq!(calls.len(), 1);
        let (data, ids) = &calls[0];
        assert_eq!(data.titulo, "Limpiar barra");
        assert_eq!(data.descripcion, None);
        assert_eq!(data.fecha_limite.as_deref(), Some("2026-01-01"));
        assert_eq!(ids, &vec!["t1".to_string(), "t2".to_string()]); // dedup + orden
    }

    #[tokio::test]
    async fn create_tarea_sin_titulo_es_validacion_y_no_toca_el_repo() {
        let repo = FakeRepo::default();
        let input = CreateTareaInput {
            titulo: "   ".into(),
            descripcion: None,
            fecha_limite: None,
            ids_trabajadores: vec!["t1".into()],
        };
        assert!(es_validacion(create_tarea(&repo, input).await.unwrap_err()));
        assert!(repo.create.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn create_tarea_exige_al_menos_un_trabajador() {
        let repo = FakeRepo::default();
        let input = CreateTareaInput {
            titulo: "Tarea".into(),
            descripcion: None,
            fecha_limite: None,
            ids_trabajadores: vec!["  ".into(), String::new()], // se normalizan a vacío
        };
        assert!(es_validacion(create_tarea(&repo, input).await.unwrap_err()));
        assert!(repo.create.lock().unwrap().is_empty());
    }

    // ── update_tarea ──────────────────────────────────────────────

    #[tokio::test]
    async fn update_tarea_exige_id_y_titulo() {
        let repo = FakeRepo::default();
        let sin_id = UpdateTareaInput {
            id_tarea: "  ".into(),
            titulo: "x".into(),
            descripcion: None,
            fecha_limite: None,
        };
        assert!(es_validacion(update_tarea(&repo, sin_id).await.unwrap_err()));

        let sin_titulo = UpdateTareaInput {
            id_tarea: "tarea1".into(),
            titulo: "   ".into(),
            descripcion: None,
            fecha_limite: None,
        };
        assert!(es_validacion(update_tarea(&repo, sin_titulo).await.unwrap_err()));

        assert!(repo.update.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn update_tarea_valida_delega_recortado() {
        let repo = FakeRepo::default();
        let input = UpdateTareaInput {
            id_tarea: "tarea1".into(),
            titulo: "  Nuevo  ".into(),
            descripcion: Some(" d ".into()),
            fecha_limite: None,
        };
        assert!(update_tarea(&repo, input).await.unwrap());

        let calls = repo.update.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "tarea1");
        assert_eq!(calls[0].1.titulo, "Nuevo");
        assert_eq!(calls[0].1.descripcion.as_deref(), Some("d"));
    }

    // ── set_asignaciones ──────────────────────────────────────────

    #[tokio::test]
    async fn set_asignaciones_exige_id() {
        let repo = FakeRepo::default();
        let input = SetAsignacionesTareaInput {
            id_tarea: "  ".into(),
            ids_trabajadores: vec!["t1".into()],
        };
        assert!(es_validacion(set_asignaciones(&repo, input).await.unwrap_err()));
        assert!(repo.asignaciones.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn set_asignaciones_normaliza_ids() {
        let repo = FakeRepo::default();
        let input = SetAsignacionesTareaInput {
            id_tarea: "tarea1".into(),
            ids_trabajadores: vec![" b ".into(), "a".into(), "a".into(), String::new()],
        };
        assert!(set_asignaciones(&repo, input).await.unwrap());
        let calls = repo.asignaciones.lock().unwrap();
        assert_eq!(calls[0].1, vec!["a".to_string(), "b".to_string()]);
    }

    // ── delete_tarea / marcar_finalizada ──────────────────────────

    #[tokio::test]
    async fn delete_tarea_exige_id() {
        let repo = FakeRepo::default();
        let err = delete_tarea(&repo, TareaIdArgs { id_tarea: "  ".into() })
            .await
            .unwrap_err();
        assert!(es_validacion(err));
        assert!(repo.delete.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn delete_tarea_valida_delega() {
        let repo = FakeRepo::default();
        assert!(delete_tarea(&repo, TareaIdArgs { id_tarea: "tarea1".into() })
            .await
            .unwrap());
        assert_eq!(*repo.delete.lock().unwrap(), vec!["tarea1".to_string()]);
    }

    #[tokio::test]
    async fn marcar_finalizada_exige_ambos_ids() {
        let repo = FakeRepo::default();
        let sin_trab = FinalizarTareaInput {
            id_tarea: "t1".into(),
            id_trabajador: "  ".into(),
        };
        assert!(es_validacion(marcar_finalizada(&repo, sin_trab).await.unwrap_err()));

        let sin_tarea = FinalizarTareaInput {
            id_tarea: String::new(),
            id_trabajador: "w1".into(),
        };
        assert!(es_validacion(marcar_finalizada(&repo, sin_tarea).await.unwrap_err()));

        assert!(repo.finalizar.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn marcar_finalizada_valida_delega() {
        let repo = FakeRepo::default();
        let input = FinalizarTareaInput {
            id_tarea: "t1".into(),
            id_trabajador: "w1".into(),
        };
        assert!(marcar_finalizada(&repo, input).await.unwrap());
        assert_eq!(
            *repo.finalizar.lock().unwrap(),
            vec![("t1".to_string(), "w1".to_string())]
        );
    }

    // ── guardas de lectura (id vacío corta sin error ni ir al repo) ─

    #[tokio::test]
    async fn lecturas_con_id_vacio_cortan_sin_error() {
        let repo = FakeRepo::default();
        assert!(get_tarea_by_id(&repo, TareaIdArgs { id_tarea: " ".into() })
            .await
            .unwrap()
            .is_none());
        assert!(get_tarea_asignados(&repo, TareaIdArgs { id_tarea: " ".into() })
            .await
            .unwrap()
            .is_empty());
        assert!(get_mis_tareas(&repo, MisTareasArgs { id_trabajador: " ".into() })
            .await
            .unwrap()
            .is_empty());
    }
}
