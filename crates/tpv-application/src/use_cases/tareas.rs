//! Casos de uso de tareas. Local-First: validan con el dominio e invocan el puerto.

use tpv_contracts::tareas::{
    CreateTareaInput, FinalizarTareaInput, MisTareasArgs, MisTareasRow, SetAsignacionesTareaInput,
    TareaAdminRow, TareaAsignadoRow, TareaIdArgs, TareaRow, TrabajadorUI, UpdateTareaInput,
};
use tpv_domain::notificaciones::{Destino, NuevaNotificacion, Severidad};
use tpv_domain::tareas::{limpiar_opcional, normalizar_ids, requerido, TareaData};

use crate::error::{AppError, AppResult};
use crate::ports::notificaciones::Notifier;
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

pub async fn create_tarea(
    repo: &dyn TareasRepository,
    notifier: Option<&dyn Notifier>,
    input: CreateTareaInput,
) -> AppResult<bool> {
    let titulo = requerido(&input.titulo, "titulo").map_err(AppError::validation)?;
    let ids_trabajadores = normalizar_ids(input.ids_trabajadores);

    if ids_trabajadores.is_empty() {
        return Err(AppError::validation("ids_trabajadores required"));
    }

    let data = TareaData {
        titulo: titulo.clone(),
        descripcion: limpiar_opcional(input.descripcion),
        fecha_limite: limpiar_opcional(input.fecha_limite),
    };

    let ok = repo.create_tarea(data, ids_trabajadores.clone()).await?;

    // Emisión best-effort de "tarea_asignada" a cada usuario asignado. Solo hay Notifier en modo
    // Main (SQLite local); en Handy (creación vía HTTP a la nube) es None y se omite — la emisión
    // server-side es un follow-up. Un fallo emitiendo NO tumba la creación de la tarea.
    if ok {
        if let Some(notifier) = notifier {
            emitir_a_trabajadores(
                repo,
                notifier,
                &ids_trabajadores,
                "tarea_asignada",
                "Nueva tarea asignada",
                Some(&titulo),
                Some("ver_tareas"),
            )
            .await;
        }
    }

    Ok(ok)
}

/// Emite una notificación a cada trabajador de `ids_trabajadores`, resolviendo su `ID_Usuario`
/// (las notificaciones se dirigen por usuario, no por trabajador). `get_trabajadores` ya trae el
/// par (ID_Trabajador, ID_Usuario), así que no ampliamos el puerto. Best-effort: si la lectura
/// falla o una emisión concreta falla, se ignora (la escritura de la tarea ya está confirmada).
async fn emitir_a_trabajadores(
    repo: &dyn TareasRepository,
    notifier: &dyn Notifier,
    ids_trabajadores: &[String],
    tipo: &str,
    titulo: &str,
    cuerpo: Option<&str>,
    accion: Option<&str>,
) {
    if ids_trabajadores.is_empty() {
        return;
    }

    let trabajadores = match repo.get_trabajadores().await {
        Ok(t) => t,
        Err(_) => return,
    };

    for id_trab in ids_trabajadores {
        let Some(tr) = trabajadores.iter().find(|t| &t.id_trabajador == id_trab) else {
            continue;
        };
        let nueva = NuevaNotificacion {
            tipo: tipo.to_string(),
            severidad: Severidad::Info,
            titulo: titulo.to_string(),
            cuerpo: cuerpo.map(|s| s.to_string()),
            destino: Destino::Usuario(tr.id_usuario.clone()),
            accion: accion.map(|s| s.to_string()),
            payload: None,
            clave_dedupe: None,
            expira_en: None,
        };
        let _ = notifier.emitir(nueva).await;
    }
}

pub async fn update_tarea(
    repo: &dyn TareasRepository,
    notifier: Option<&dyn Notifier>,
    input: UpdateTareaInput,
) -> AppResult<bool> {
    if input.id_tarea.trim().is_empty() {
        return Err(AppError::validation("id_tarea required"));
    }

    let titulo = requerido(&input.titulo, "titulo").map_err(AppError::validation)?;

    let data = TareaData {
        titulo: titulo.clone(),
        descripcion: limpiar_opcional(input.descripcion),
        fecha_limite: limpiar_opcional(input.fecha_limite),
    };

    let ok = repo.update_tarea(&input.id_tarea, data).await?;

    // Avisar a los asignados ACTUALES de que su tarea cambió (best-effort).
    if ok {
        if let Some(notifier) = notifier {
            let ids: Vec<String> = repo
                .get_tarea_asignados(&input.id_tarea)
                .await
                .unwrap_or_default()
                .into_iter()
                .map(|a| a.id_trabajador)
                .collect();
            emitir_a_trabajadores(
                repo,
                notifier,
                &ids,
                "tarea_modificada",
                "Tu tarea fue modificada",
                Some(&titulo),
                Some("ver_tareas"),
            )
            .await;
        }
    }

    Ok(ok)
}

pub async fn set_asignaciones(
    repo: &dyn TareasRepository,
    notifier: Option<&dyn Notifier>,
    input: SetAsignacionesTareaInput,
) -> AppResult<bool> {
    if input.id_tarea.trim().is_empty() {
        return Err(AppError::validation("id_tarea required"));
    }

    let ids_nuevos = normalizar_ids(input.ids_trabajadores);

    // Asignados ANTES del cambio, para notificar SOLO a los recién añadidos (los que ya estaban
    // no vuelven a recibir "tarea asignada"). Solo se lee si hay Notifier.
    let previos: Vec<String> = if notifier.is_some() {
        repo.get_tarea_asignados(&input.id_tarea)
            .await
            .unwrap_or_default()
            .into_iter()
            .map(|a| a.id_trabajador)
            .collect()
    } else {
        Vec::new()
    };

    let ok = repo
        .set_asignaciones(&input.id_tarea, ids_nuevos.clone())
        .await?;

    if ok {
        if let Some(notifier) = notifier {
            let nuevos: Vec<String> = ids_nuevos
                .iter()
                .filter(|id| !previos.contains(id))
                .cloned()
                .collect();
            if !nuevos.is_empty() {
                let titulo_tarea = repo
                    .get_tarea_by_id(&input.id_tarea)
                    .await
                    .ok()
                    .flatten()
                    .map(|t| t.titulo);
                emitir_a_trabajadores(
                    repo,
                    notifier,
                    &nuevos,
                    "tarea_asignada",
                    "Nueva tarea asignada",
                    titulo_tarea.as_deref(),
                    Some("ver_tareas"),
                )
                .await;
            }
        }
    }

    Ok(ok)
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
    repo.marcar_finalizada(&input.id_tarea, &input.id_trabajador)
        .await
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
        /// Plantel devuelto por `get_trabajadores` (para probar el mapeo trabajador→usuario al emitir).
        trabajadores: Vec<TrabajadorUI>,
        /// Asignados devueltos por `get_tarea_asignados` (para probar la emisión al modificar/reasignar).
        asignados: Vec<TareaAsignadoRow>,
        /// Tarea devuelta por `get_tarea_by_id` (título para el cuerpo del aviso de reasignación).
        tarea: Option<TareaRow>,
        create: Mutex<Vec<(TareaData, Vec<String>)>>,
        update: Mutex<Vec<(String, TareaData)>>,
        asignaciones: Mutex<Vec<(String, Vec<String>)>>,
        delete: Mutex<Vec<String>>,
        finalizar: Mutex<Vec<(String, String)>>,
    }

    /// Notifier falso: registra lo emitido en vez de persistir.
    #[derive(Default)]
    struct FakeNotifier {
        emitidas: Mutex<Vec<NuevaNotificacion>>,
    }

    #[async_trait]
    impl Notifier for FakeNotifier {
        async fn emitir(&self, nueva: NuevaNotificacion) -> AppResult<String> {
            self.emitidas.lock().unwrap().push(nueva);
            Ok("notif-1".to_string())
        }
        async fn resolver_por_clave(&self, _clave: &str) -> AppResult<bool> {
            Ok(false)
        }
    }

    #[async_trait]
    impl TareasRepository for FakeRepo {
        async fn get_trabajadores(&self) -> AppResult<Vec<TrabajadorUI>> {
            Ok(self.trabajadores.clone())
        }
        async fn get_tareas_admin(&self) -> AppResult<Vec<TareaAdminRow>> {
            Ok(vec![])
        }
        async fn get_tarea_by_id(&self, _id: &str) -> AppResult<Option<TareaRow>> {
            Ok(self.tarea.clone())
        }
        async fn get_tarea_asignados(&self, _id: &str) -> AppResult<Vec<TareaAsignadoRow>> {
            Ok(self.asignados.clone())
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
            self.asignaciones
                .lock()
                .unwrap()
                .push((id.to_string(), ids));
            Ok(true)
        }
        async fn delete_tarea(&self, id: &str) -> AppResult<bool> {
            self.delete.lock().unwrap().push(id.to_string());
            Ok(true)
        }
        async fn marcar_finalizada(&self, id: &str, trab: &str) -> AppResult<bool> {
            self.finalizar
                .lock()
                .unwrap()
                .push((id.to_string(), trab.to_string()));
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
        assert!(create_tarea(&repo, None, input).await.unwrap());

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
        assert!(es_validacion(create_tarea(&repo, None, input).await.unwrap_err()));
        assert!(repo.create.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn create_tarea_emite_notificacion_por_cada_asignado() {
        let mut repo = FakeRepo::default();
        repo.trabajadores = vec![
            TrabajadorUI {
                id_trabajador: "t1".into(),
                id_usuario: "u1".into(),
                nombre: "Ana".into(),
                apellido: None,
                puesto: None,
                email: "ana@x.com".into(),
            },
            TrabajadorUI {
                id_trabajador: "t2".into(),
                id_usuario: "u2".into(),
                nombre: "Beto".into(),
                apellido: None,
                puesto: None,
                email: "beto@x.com".into(),
            },
        ];
        let notifier = FakeNotifier::default();

        let input = CreateTareaInput {
            titulo: "Limpiar barra".into(),
            descripcion: None,
            fecha_limite: None,
            ids_trabajadores: vec!["t1".into(), "t2".into()],
        };
        assert!(create_tarea(&repo, Some(&notifier), input).await.unwrap());

        let emitidas = notifier.emitidas.lock().unwrap();
        assert_eq!(emitidas.len(), 2, "una notificación por asignado");
        assert!(emitidas.iter().all(|n| n.tipo == "tarea_asignada"));
        assert_eq!(emitidas[0].cuerpo.as_deref(), Some("Limpiar barra"));
        let destinos: Vec<_> = emitidas.iter().map(|n| n.destino.clone()).collect();
        assert!(destinos.contains(&Destino::Usuario("u1".into())));
        assert!(destinos.contains(&Destino::Usuario("u2".into())));
    }

    #[tokio::test]
    async fn create_tarea_sin_notifier_no_falla() {
        // Modo Handy (notifier None): la tarea se crea igual, sin emisión.
        let repo = FakeRepo::default();
        let input = CreateTareaInput {
            titulo: "Tarea".into(),
            descripcion: None,
            fecha_limite: None,
            ids_trabajadores: vec!["t1".into()],
        };
        assert!(create_tarea(&repo, None, input).await.unwrap());
        assert_eq!(repo.create.lock().unwrap().len(), 1);
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
        assert!(es_validacion(create_tarea(&repo, None, input).await.unwrap_err()));
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
        assert!(es_validacion(
            update_tarea(&repo, None,sin_id).await.unwrap_err()
        ));

        let sin_titulo = UpdateTareaInput {
            id_tarea: "tarea1".into(),
            titulo: "   ".into(),
            descripcion: None,
            fecha_limite: None,
        };
        assert!(es_validacion(
            update_tarea(&repo, None,sin_titulo).await.unwrap_err()
        ));

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
        assert!(update_tarea(&repo, None,input).await.unwrap());

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
        assert!(es_validacion(
            set_asignaciones(&repo, None,input).await.unwrap_err()
        ));
        assert!(repo.asignaciones.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn set_asignaciones_normaliza_ids() {
        let repo = FakeRepo::default();
        let input = SetAsignacionesTareaInput {
            id_tarea: "tarea1".into(),
            ids_trabajadores: vec![" b ".into(), "a".into(), "a".into(), String::new()],
        };
        assert!(set_asignaciones(&repo, None,input).await.unwrap());
        let calls = repo.asignaciones.lock().unwrap();
        assert_eq!(calls[0].1, vec!["a".to_string(), "b".to_string()]);
    }

    #[tokio::test]
    async fn update_tarea_notifica_a_los_asignados_actuales() {
        let mut repo = FakeRepo::default();
        repo.trabajadores = vec![TrabajadorUI {
            id_trabajador: "t1".into(),
            id_usuario: "u1".into(),
            nombre: "Ana".into(),
            apellido: None,
            puesto: None,
            email: "ana@x.com".into(),
        }];
        repo.asignados = vec![TareaAsignadoRow {
            id_trabajador: "t1".into(),
            nombre: "Ana".into(),
            apellido: None,
            puesto: None,
            asignada_at: "2026-01-01 00:00:00".into(),
            estado: "PENDIENTE".into(),
            finalizada_at: None,
        }];
        let notifier = FakeNotifier::default();

        let input = UpdateTareaInput {
            id_tarea: "tarea1".into(),
            titulo: "Limpiar barra".into(),
            descripcion: None,
            fecha_limite: None,
        };
        assert!(update_tarea(&repo, Some(&notifier), input).await.unwrap());

        let emitidas = notifier.emitidas.lock().unwrap();
        assert_eq!(emitidas.len(), 1);
        assert_eq!(emitidas[0].tipo, "tarea_modificada");
        assert_eq!(emitidas[0].destino, Destino::Usuario("u1".into()));
    }

    #[tokio::test]
    async fn set_asignaciones_notifica_solo_a_los_nuevos() {
        let mut repo = FakeRepo::default();
        repo.trabajadores = vec![
            TrabajadorUI {
                id_trabajador: "t1".into(),
                id_usuario: "u1".into(),
                nombre: "Ana".into(),
                apellido: None,
                puesto: None,
                email: "a@x.com".into(),
            },
            TrabajadorUI {
                id_trabajador: "t2".into(),
                id_usuario: "u2".into(),
                nombre: "Beto".into(),
                apellido: None,
                puesto: None,
                email: "b@x.com".into(),
            },
        ];
        // t1 ya estaba asignado; al guardar {t1, t2} solo t2 es nuevo.
        repo.asignados = vec![TareaAsignadoRow {
            id_trabajador: "t1".into(),
            nombre: "Ana".into(),
            apellido: None,
            puesto: None,
            asignada_at: "2026-01-01 00:00:00".into(),
            estado: "PENDIENTE".into(),
            finalizada_at: None,
        }];
        repo.tarea = Some(TareaRow {
            id_tarea: "tarea1".into(),
            titulo: "Limpiar barra".into(),
            descripcion: None,
            fecha_creacion: "2026-01-01 00:00:00".into(),
            fecha_limite: None,
        });
        let notifier = FakeNotifier::default();

        let input = SetAsignacionesTareaInput {
            id_tarea: "tarea1".into(),
            ids_trabajadores: vec!["t1".into(), "t2".into()],
        };
        assert!(set_asignaciones(&repo, Some(&notifier), input).await.unwrap());

        let emitidas = notifier.emitidas.lock().unwrap();
        assert_eq!(emitidas.len(), 1, "solo el recién añadido (t2)");
        assert_eq!(emitidas[0].tipo, "tarea_asignada");
        assert_eq!(emitidas[0].destino, Destino::Usuario("u2".into()));
    }

    // ── delete_tarea / marcar_finalizada ──────────────────────────

    #[tokio::test]
    async fn delete_tarea_exige_id() {
        let repo = FakeRepo::default();
        let err = delete_tarea(
            &repo,
            TareaIdArgs {
                id_tarea: "  ".into(),
            },
        )
        .await
        .unwrap_err();
        assert!(es_validacion(err));
        assert!(repo.delete.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn delete_tarea_valida_delega() {
        let repo = FakeRepo::default();
        assert!(delete_tarea(
            &repo,
            TareaIdArgs {
                id_tarea: "tarea1".into()
            }
        )
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
        assert!(es_validacion(
            marcar_finalizada(&repo, sin_trab).await.unwrap_err()
        ));

        let sin_tarea = FinalizarTareaInput {
            id_tarea: String::new(),
            id_trabajador: "w1".into(),
        };
        assert!(es_validacion(
            marcar_finalizada(&repo, sin_tarea).await.unwrap_err()
        ));

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
        assert!(get_tarea_by_id(
            &repo,
            TareaIdArgs {
                id_tarea: " ".into()
            }
        )
        .await
        .unwrap()
        .is_none());
        assert!(get_tarea_asignados(
            &repo,
            TareaIdArgs {
                id_tarea: " ".into()
            }
        )
        .await
        .unwrap()
        .is_empty());
        assert!(get_mis_tareas(
            &repo,
            MisTareasArgs {
                id_trabajador: " ".into()
            }
        )
        .await
        .unwrap()
        .is_empty());
    }
}
