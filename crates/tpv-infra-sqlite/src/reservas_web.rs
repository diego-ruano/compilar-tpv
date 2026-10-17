//! Persistencia de la reserva desde la web en la Main (docs/estudios/reservas-web.md).
//!
//! Todo lo que se escribe aquí es negocio replicable: va por `WriteGuard::execute`, que lo captura
//! en el outbox, porque la agenda web de la nube lo lee de su copia de la base.

use std::sync::Arc;

use async_trait::async_trait;

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::reservas_web::ReservasWebRepository;
use tpv_contracts::reservas_web::{CierreReservaWebDto, ReservaWebMesaDto};
use tpv_domain::reservas_web::{CierreValidado, MesaWebValidada, TODOS_LOS_DIAS};

use crate::consultas::db_err;
use crate::db::{Db, Reader, Writer};
use crate::ejecutor::Value;
use crate::mapping::{opt_text, v_i64, v_string};
use crate::util::new_id;

pub struct SqliteReservasWebRepository {
    db: Arc<Db>,
}

impl SqliteReservasWebRepository {
    pub fn new(db: Arc<Db>) -> Self {
        Self { db }
    }
}

#[async_trait]
impl ReservasWebRepository for SqliteReservasWebRepository {
    async fn zona_horaria(&self) -> AppResult<String> {
        let g = self.db.read().await;
        let mut rows = g
            .query("SELECT Zona_Horaria FROM Business_Settings WHERE ID = 1;", ())
            .await
            .map_err(db_err)?;
        let row = rows
            .next()
            .await
            .map_err(db_err)?
            .ok_or_else(|| AppError::not_found("No existe Business_Settings (ID=1)"))?;
        Ok(v_string(row.get_value(0).map_err(db_err)?).unwrap_or_default())
    }

    async fn fijar_zona_horaria(&self, zona: &str) -> AppResult<()> {
        let g = self.db.write().await;
        g.execute(
            "UPDATE Business_Settings SET Zona_Horaria = ?1 WHERE ID = 1;",
            vec![Value::Text(zona.to_string())],
        )
        .await
        .map_err(db_err)?;
        Ok(())
    }

    async fn activa(&self) -> AppResult<bool> {
        let g = self.db.read().await;
        let mut rows = g
            .query("SELECT Reserva_Web_Activa FROM Business_Settings WHERE ID = 1;", ())
            .await
            .map_err(db_err)?;
        let row = rows
            .next()
            .await
            .map_err(db_err)?
            .ok_or_else(|| AppError::not_found("No existe Business_Settings (ID=1)"))?;
        Ok(v_i64(row.get_value(0).map_err(db_err)?).unwrap_or(0) != 0)
    }

    async fn fijar_activa(&self, activa: bool) -> AppResult<bool> {
        // Comparar y escribir bajo el MISMO cerrojo de escritura: con la lectura fuera, dos
        // pulsaciones seguidas podían leer las dos el valor viejo, y la segunda se saltaba su
        // escritura aunque fuera la última elección.
        let g = self.db.write().await;
        let mut rows = g
            .query("SELECT Reserva_Web_Activa FROM Business_Settings WHERE ID = 1;", ())
            .await
            .map_err(db_err)?;
        let ahora = match rows.next().await.map_err(db_err)? {
            Some(row) => v_i64(row.get_value(0).map_err(db_err)?).unwrap_or(0) != 0,
            None => return Err(AppError::not_found("No existe Business_Settings (ID=1)")),
        };
        drop(rows);
        // Sólo se escribe si cambia: cada escritura viaja a la nube.
        if ahora == activa {
            return Ok(false);
        }
        g.execute(
            "UPDATE Business_Settings SET Reserva_Web_Activa = ?1 WHERE ID = 1;",
            vec![Value::Integer(i64::from(activa))],
        )
        .await
        .map_err(db_err)?;
        Ok(true)
    }

    async fn cierres(&self) -> AppResult<Vec<CierreReservaWebDto>> {
        let g = self.db.read().await;
        // Una lectura de la Main: `'now'` es el reloj de este equipo, que es la hora del negocio.
        let mut rows = g
            .query(
                "SELECT ID_Cierre, Dia_YMD, Motivo FROM Reserva_Web_Cierres \
                 WHERE Dia_YMD >= date('now','localtime') ORDER BY Dia_YMD;",
                (),
            )
            .await
            .map_err(db_err)?;
        let mut cierres = Vec::new();
        while let Some(row) = rows.next().await.map_err(db_err)? {
            let g = |i: i32| row.get_value(i).map_err(db_err);
            cierres.push(CierreReservaWebDto {
                id_cierre: v_string(g(0)?).unwrap_or_default(),
                dia_ymd: v_string(g(1)?).unwrap_or_default(),
                motivo: v_string(g(2)?),
            });
        }
        Ok(cierres)
    }

    async fn cerrar_dia(&self, cierre: CierreValidado) -> AppResult<String> {
        let g = self.db.write().await;
        g.transaccion(async {
            // Un día ya cerrado conserva su id, y es ESE id el que lleva la sentencia que se
            // replica. Con uno nuevo en el VALUES y el ON CONFLICT sobre el día, la fila guardaba
            // el viejo pero el outbox el nuevo: si la nube apartaba la operación, la reparación por
            // estado (`sync_reparacion`, que lee la clave del VALUES) buscaba una fila que no existe
            // y no reparaba nada.
            let mut rows = g
                .query(
                    "SELECT ID_Cierre FROM Reserva_Web_Cierres WHERE Dia_YMD = ?1;",
                    vec![Value::Text(cierre.dia_ymd.clone())],
                )
                .await
                .map_err(db_err)?;
            let existente = match rows.next().await.map_err(db_err)? {
                Some(row) => v_string(row.get_value(0).map_err(db_err)?),
                None => None,
            };
            drop(rows);
            let id = existente.unwrap_or_else(new_id);
            g.execute(
                "INSERT INTO Reserva_Web_Cierres (ID_Cierre, Dia_YMD, Motivo) VALUES (?1, ?2, ?3) \
                 ON CONFLICT(ID_Cierre) DO UPDATE SET Dia_YMD = excluded.Dia_YMD, Motivo = excluded.Motivo;",
                vec![
                    Value::Text(id.clone()),
                    Value::Text(cierre.dia_ymd.clone()),
                    opt_text(cierre.motivo.clone()),
                ],
            )
            .await
            .map_err(db_err)?;
            Ok(id)
        })
        .await
    }

    async fn quitar_cierre(&self, id_cierre: &str) -> AppResult<bool> {
        let g = self.db.write().await;
        let borradas = g
            .execute(
                "DELETE FROM Reserva_Web_Cierres WHERE ID_Cierre = ?1;",
                vec![Value::Text(id_cierre.to_string())],
            )
            .await
            .map_err(db_err)?;
        Ok(borradas > 0)
    }

    async fn mesas(&self) -> AppResult<Vec<ReservaWebMesaDto>> {
        let g = self.db.read().await;
        // La pantalla edita una franja por mesa: si hubiera varias, la primera del día.
        let mut rows = g
            .query(
                "SELECT W.ID_Mesa, W.Activa, F.Dias_Semana, F.Fecha_Desde, F.Fecha_Hasta, \
                        F.Hora_Desde, F.Hora_Hasta \
                 FROM Reserva_Web_Mesas W \
                 JOIN Mesas M ON M.ID_Mesa = W.ID_Mesa AND M.Archivada_En IS NULL \
                 LEFT JOIN Reserva_Web_Franjas F ON F.ID_Franja = ( \
                   SELECT F2.ID_Franja FROM Reserva_Web_Franjas F2 WHERE F2.ID_Mesa = W.ID_Mesa \
                   ORDER BY F2.Hora_Desde, F2.ID_Franja LIMIT 1) \
                 ORDER BY W.ID_Mesa;",
                (),
            )
            .await
            .map_err(db_err)?;
        let mut mesas = Vec::new();
        while let Some(row) = rows.next().await.map_err(db_err)? {
            let g = |i: i32| row.get_value(i).map_err(db_err);
            mesas.push(ReservaWebMesaDto {
                id_mesa: v_string(g(0)?).unwrap_or_default(),
                activa: v_i64(g(1)?).unwrap_or(0) != 0,
                dias_semana: v_i64(g(2)?).unwrap_or(TODOS_LOS_DIAS),
                fecha_desde: v_string(g(3)?),
                fecha_hasta: v_string(g(4)?),
                hora_desde: v_string(g(5)?),
                hora_hasta: v_string(g(6)?),
            });
        }
        Ok(mesas)
    }

    async fn guardar_mesa(&self, mesa: MesaWebValidada) -> AppResult<()> {
        let g = self.db.write().await;
        g.transaccion(async {
            let mut rows = g
                .query(
                    "SELECT 1 FROM Mesas WHERE ID_Mesa = ?1 AND Archivada_En IS NULL;",
                    vec![Value::Text(mesa.id_mesa.clone())],
                )
                .await
                .map_err(db_err)?;
            if rows.next().await.map_err(db_err)?.is_none() {
                return Err(AppError::not_found("Esa mesa ya no está en el plano"));
            }
            g.execute(
                "INSERT INTO Reserva_Web_Mesas (ID_Mesa, Activa) VALUES (?1, ?2) \
                 ON CONFLICT(ID_Mesa) DO UPDATE SET Activa = excluded.Activa;",
                vec![Value::Text(mesa.id_mesa.clone()), Value::Integer(i64::from(mesa.activa))],
            )
            .await
            .map_err(db_err)?;
            g.execute(
                "DELETE FROM Reserva_Web_Franjas WHERE ID_Mesa = ?1;",
                vec![Value::Text(mesa.id_mesa.clone())],
            )
            .await
            .map_err(db_err)?;
            if let Some(f) = &mesa.franja {
                g.execute(
                    "INSERT INTO Reserva_Web_Franjas \
                       (ID_Franja, ID_Mesa, Dias_Semana, Fecha_Desde, Fecha_Hasta, Hora_Desde, Hora_Hasta) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7);",
                    vec![
                        Value::Text(new_id()),
                        Value::Text(mesa.id_mesa.clone()),
                        Value::Integer(f.dias_semana),
                        opt_text(f.fecha_desde.clone()),
                        opt_text(f.fecha_hasta.clone()),
                        Value::Text(f.hora_desde.clone()),
                        Value::Text(f.hora_hasta.clone()),
                    ],
                )
                .await
                .map_err(db_err)?;
            }
            Ok(())
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn abrir() -> (Arc<Db>, SqliteReservasWebRepository, std::path::PathBuf) {
        let dir = crate::test_temp::dir_temporal("reservas_web");
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        let repo = SqliteReservasWebRepository::new(db.clone());
        (db, repo, dir)
    }

    async fn outbox(db: &Db) -> i64 {
        let g = db.read().await;
        let mut rows = g.query("SELECT COUNT(*) FROM _Sync_Outbox;", ()).await.unwrap();
        match rows.next().await.unwrap().unwrap().get_value(0).unwrap() {
            Value::Integer(n) => n,
            otro => panic!("se esperaba un entero: {otro:?}"),
        }
    }

    /// La nube la lee de su copia: cambiarla tiene que viajar por el outbox.
    #[tokio::test]
    async fn la_zona_horaria_nace_peninsular_y_su_cambio_se_replica() {
        let (db, repo, dir) = abrir().await;
        assert_eq!(repo.zona_horaria().await.unwrap(), "Europe/Madrid");
        let antes = outbox(&db).await;

        repo.fijar_zona_horaria("Atlantic/Canary").await.unwrap();

        assert_eq!(repo.zona_horaria().await.unwrap(), "Atlantic/Canary");
        assert_eq!(outbox(&db).await, antes + 1);
        drop(repo);
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn la_reserva_web_nace_apagada_y_encenderla_se_replica() {
        let (db, repo, dir) = abrir().await;
        assert!(!repo.activa().await.unwrap());
        let antes = outbox(&db).await;

        assert!(repo.fijar_activa(true).await.unwrap());

        assert!(repo.activa().await.unwrap());
        assert_eq!(outbox(&db).await, antes + 1);
        drop(repo);
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Lo que ya está no se vuelve a escribir (cada escritura sube a la nube), y la comparación va
    /// bajo el cerrojo de escritura: pulsaciones simultáneas acaban todas aplicadas en orden y la
    /// base dice lo mismo que la última sentencia que ha salido hacia la nube.
    #[tokio::test]
    async fn encender_o_apagar_solo_escribe_si_cambia_y_en_orden() {
        let (db, repo, dir) = abrir().await;
        let antes = outbox(&db).await;
        assert!(!repo.fijar_activa(false).await.unwrap());
        assert_eq!(outbox(&db).await, antes, "ya estaba apagada");

        let repo = Arc::new(repo);
        let mut tareas = Vec::new();
        for i in 0..20 {
            let repo = repo.clone();
            tareas.push(tokio::spawn(async move { repo.fijar_activa(i % 2 == 0).await.unwrap() }));
        }
        for t in tareas {
            t.await.unwrap();
        }

        let g = db.read().await;
        let mut rows = g
            .query("SELECT Statements_Json FROM _Sync_Outbox ORDER BY Seq DESC LIMIT 1;", ())
            .await
            .unwrap();
        let ultima = match rows.next().await.unwrap().unwrap().get_value(0).unwrap() {
            Value::Text(t) => t,
            otro => panic!("{otro:?}"),
        };
        drop(rows);
        drop(g);
        let en_la_base = repo.activa().await.unwrap();
        let sentencias: Vec<tpv_contracts::sync::SqlStatement> = serde_json::from_str(&ultima).unwrap();
        assert!(sentencias[0].sql.contains("Reserva_Web_Activa"));
        assert_eq!(sentencias[0].args[0], serde_json::json!(i64::from(en_la_base)), "{ultima}");
        drop(repo);
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn cierre(dia: &str, motivo: Option<&str>) -> CierreValidado {
        CierreValidado { dia_ymd: dia.into(), motivo: motivo.map(str::to_string) }
    }

    /// Cerrar dos veces el mismo día no lo duplica: conserva su id y se queda con el motivo nuevo.
    #[tokio::test]
    async fn cerrar_un_dia_ya_cerrado_solo_cambia_el_motivo() {
        let (_db, repo, dir) = abrir().await;
        let primero = repo.cerrar_dia(cierre("2099-12-24", Some("Nochebuena"))).await.unwrap();
        let segundo = repo.cerrar_dia(cierre("2099-12-24", Some("Cena de empresa"))).await.unwrap();

        assert_eq!(primero, segundo);
        let cierres = repo.cierres().await.unwrap();
        assert_eq!(cierres.len(), 1);
        assert_eq!(cierres[0].motivo.as_deref(), Some("Cena de empresa"));
        drop(repo);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// El fallo que motivó comparar bajo el cerrojo, reproducido a propósito: con otra escritura en
    /// curso, «encender» y luego «apagar» esperan su turno. Antes, las dos leían «apagado» fuera
    /// del cerrojo y «apagar» se saltaba su escritura: quedaba encendido. Ahora se aplican las dos,
    /// en orden, y la última elección es la que queda. (El cerrojo de escritura atiende por orden de
    /// llegada.)
    #[tokio::test]
    async fn encender_y_apagar_seguidos_dejan_la_ultima_eleccion() {
        use tpv_application::use_cases::reservas_web::activar;
        use tpv_contracts::reservas_web::ReservaWebActivarInput;

        let (db, repo, dir) = abrir().await;
        let repo = Arc::new(repo);
        let antes = outbox(&db).await;

        // Por el caso de uso, que es por donde entra la pantalla: ahí estaba la lectura de más.
        let otra_escritura = db.write().await;
        let encender = tokio::spawn({
            let repo = repo.clone();
            async move { activar(repo.as_ref(), ReservaWebActivarInput { activa: true }).await.unwrap() }
        });
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let apagar = tokio::spawn({
            let repo = repo.clone();
            async move { activar(repo.as_ref(), ReservaWebActivarInput { activa: false }).await.unwrap() }
        });
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        drop(otra_escritura);
        encender.await.unwrap();
        apagar.await.unwrap();

        assert!(!repo.activa().await.unwrap(), "queda la última elección: apagada");
        assert_eq!(outbox(&db).await, antes + 2);
        drop(repo);
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// La sentencia que se replica lleva el id de la fila de verdad: es el que usa la reparación
    /// por estado para encontrarla si la nube aparta la operación.
    #[tokio::test]
    async fn recerrar_un_dia_replica_con_su_id_de_siempre() {
        let (db, repo, dir) = abrir().await;
        let id = repo.cerrar_dia(cierre("2099-12-24", None)).await.unwrap();
        repo.cerrar_dia(cierre("2099-12-24", Some("Nochebuena"))).await.unwrap();

        let g = db.read().await;
        let mut rows = g
            .query("SELECT Statements_Json FROM _Sync_Outbox ORDER BY Seq DESC LIMIT 1;", ())
            .await
            .unwrap();
        let ultima = match rows.next().await.unwrap().unwrap().get_value(0).unwrap() {
            Value::Text(t) => t,
            otro => panic!("{otro:?}"),
        };
        assert!(ultima.contains("Nochebuena"));
        assert!(ultima.contains(&id), "la sentencia replicada lleva el id de la fila: {ultima}");
        drop(rows);
        drop(g);
        drop(repo);
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn los_dias_cerrados_salen_de_hoy_en_adelante_y_por_fecha() {
        let (_db, repo, dir) = abrir().await;
        repo.cerrar_dia(cierre("2099-12-31", None)).await.unwrap();
        repo.cerrar_dia(cierre("2000-01-01", Some("Ya pasó"))).await.unwrap();
        let navidad = repo.cerrar_dia(cierre("2099-12-25", None)).await.unwrap();

        let dias: Vec<String> = repo.cierres().await.unwrap().into_iter().map(|c| c.dia_ymd).collect();
        assert_eq!(dias, ["2099-12-25", "2099-12-31"]);

        assert!(repo.quitar_cierre(&navidad).await.unwrap());
        assert!(!repo.quitar_cierre(&navidad).await.unwrap(), "ya no estaba cerrado");
        assert_eq!(repo.cierres().await.unwrap().len(), 1);
        drop(repo);
        let _ = std::fs::remove_dir_all(&dir);
    }

    async fn sembrar_mesas(db: &Db) {
        let w = db.write().await;
        w.raw()
            .execute_batch(
                "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1', 'Salon'); \
                 INSERT INTO Mesas (ID_Mesa, ID_Zona, Numero_Mesa, Capacidad, Ubicacion_X, Ubicacion_Y, Shape, Width, Height) \
                   VALUES ('m1', 'z1', '1', 4, 0, 0, 'rect', 10, 10), ('m2', 'z1', '2', 2, 0, 0, 'rect', 10, 10); \
                 INSERT INTO Mesas (ID_Mesa, ID_Zona, Numero_Mesa, Capacidad, Ubicacion_X, Ubicacion_Y, Shape, Width, Height, Archivada_En) \
                   VALUES ('vieja', 'z1', '3', 2, 0, 0, 'rect', 10, 10, '2026-01-01 00:00:00');",
            )
            .await
            .unwrap();
    }

    fn mesa_web(id: &str, activa: bool, horas: Option<(&str, &str)>) -> MesaWebValidada {
        MesaWebValidada {
            id_mesa: id.into(),
            activa,
            franja: horas.map(|(desde, hasta)| tpv_domain::reservas_web::FranjaValidada {
                dias_semana: 31,
                fecha_desde: Some("2026-11-01".into()),
                fecha_hasta: None,
                hora_desde: desde.into(),
                hora_hasta: hasta.into(),
            }),
        }
    }

    /// Guardar deja la casilla y una sola franja, y viaja a la nube como cualquier otra escritura.
    #[tokio::test]
    async fn guardar_una_mesa_deja_su_casilla_y_una_franja() {
        let (db, repo, dir) = abrir().await;
        sembrar_mesas(&db).await;
        let antes = outbox(&db).await;

        repo.guardar_mesa(mesa_web("m1", true, Some(("12:00", "16:00")))).await.unwrap();
        repo.guardar_mesa(mesa_web("m1", true, Some(("13:00", "17:00")))).await.unwrap();

        let mesas = repo.mesas().await.unwrap();
        assert_eq!(mesas.len(), 1);
        let m1 = &mesas[0];
        assert!(m1.activa);
        assert_eq!(m1.dias_semana, 31);
        assert_eq!(m1.fecha_desde.as_deref(), Some("2026-11-01"));
        assert_eq!((m1.hora_desde.as_deref(), m1.hora_hasta.as_deref()), (Some("13:00"), Some("17:00")));
        assert!(outbox(&db).await > antes);

        let w = db.read().await;
        let mut rows = w.query("SELECT COUNT(*) FROM Reserva_Web_Franjas WHERE ID_Mesa = 'm1';", ()).await.unwrap();
        assert_eq!(rows.next().await.unwrap().unwrap().get_value(0).unwrap(), Value::Integer(1));
        drop(rows);
        drop(w);
        drop(repo);
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Apagada sin horas se queda sin franja, y una mesa sin franja sale con todos los días.
    #[tokio::test]
    async fn apagar_una_mesa_sin_horas_le_quita_la_franja() {
        let (db, repo, dir) = abrir().await;
        sembrar_mesas(&db).await;
        repo.guardar_mesa(mesa_web("m2", true, Some(("12:00", "16:00")))).await.unwrap();

        repo.guardar_mesa(mesa_web("m2", false, None)).await.unwrap();

        let m2 = repo.mesas().await.unwrap().into_iter().find(|m| m.id_mesa == "m2").unwrap();
        assert!(!m2.activa);
        assert_eq!(m2.hora_desde, None);
        assert_eq!(m2.dias_semana, TODOS_LOS_DIAS);
        drop(repo);
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn una_mesa_que_ya_no_esta_en_el_plano_no_se_configura() {
        let (db, repo, dir) = abrir().await;
        sembrar_mesas(&db).await;
        for id in ["vieja", "no-existe"] {
            let error = repo.guardar_mesa(mesa_web(id, true, Some(("12:00", "16:00")))).await.unwrap_err();
            assert!(matches!(error, AppError::NotFound(_)), "{id}: {error:?}");
        }
        assert!(repo.mesas().await.unwrap().is_empty());
        drop(repo);
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
