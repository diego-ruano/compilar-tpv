//! Persistencia de la reserva desde la web en la Main (docs/estudios/reservas-web.md).
//!
//! Todo lo que se escribe aquí es negocio replicable: va por `WriteGuard::execute`, que lo captura
//! en el outbox, porque la agenda web de la nube lo lee de su copia de la base.

use std::sync::Arc;

use async_trait::async_trait;

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::reservas_web::ReservasWebRepository;
use tpv_contracts::reservas_web::{CierreReservaWebDto, ReservaWebMesaDto};
use tpv_domain::reservas_web::{
    AltaWebParaRegistrar, AltaWebRegistrada, CancelacionWeb, CierreValidado, MesaWebValidada, ReservaWebResumen,
    TODOS_LOS_DIAS,
};

use crate::consultas::{db_err, select_one_i64};
use crate::reservas::{ajustes_de_reserva, choque_en_la_mesa, cliente_por, POR_EMAIL};
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

/// ¿Son el mismo teléfono? Por sus cifras: «600 100 200» y «600100200» lo son.
fn mismo_telefono(a: &str, b: &str) -> bool {
    let cifras = |t: &str| t.chars().filter(char::is_ascii_digit).collect::<String>();
    cifras(a) == cifras(b)
}

/// La nota de una reserva web, con el teléfono que se escribió en la web si no es el de la ficha
/// del cliente (la ficha no se cambia: es la de un cliente que ya existía).
fn nota_con_telefono(nota: Option<&str>, telefono: Option<&str>) -> Option<String> {
    let nota = nota.map(str::trim).filter(|n| !n.is_empty());
    let telefono = telefono.filter(|t| !t.is_empty()).map(|t| format!("Teléfono dado en la web: {t}"));
    match (nota, telefono) {
        (Some(n), Some(t)) => Some(format!("{n}
{t}")),
        (Some(n), None) => Some(n.to_string()),
        (None, t) => t,
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

    async fn registrar_alta(&self, a: AltaWebParaRegistrar) -> AppResult<AltaWebRegistrada> {
        let g = self.db.write().await;
        let conn = &g;
        conn.transaccion(async {
            // Recibirla dos veces (la agenda la vuelve a ofrecer si no la ve en la base del negocio)
            // no la duplica ni vuelve a avisar.
            let ya = select_one_i64(
                conn,
                "SELECT 1 FROM Reservas WHERE ID_Reserva = ?1;",
                vec![Value::Text(a.id_reserva.clone())],
            )
            .await?;
            if ya.is_some() {
                return Ok(AltaWebRegistrada::YaEstaba);
            }

            // La mesa que eligió. Si ya no existe, la reserva se guarda sin mesa; si se archivó, en
            // ella. Las dos cosas son «muévela», como un choque.
            let mut rows = conn
                .query(
                    "SELECT Numero_Mesa, Archivada_En IS NOT NULL FROM Mesas WHERE ID_Mesa = ?1;",
                    vec![Value::Text(a.alta.id_mesa.clone())],
                )
                .await
                .map_err(db_err)?;
            let (id_mesa, numero, mesa_fuera) = match rows.next().await.map_err(db_err)? {
                Some(row) => (
                    Some(a.alta.id_mesa.clone()),
                    v_string(row.get_value(0).map_err(db_err)?),
                    v_i64(row.get_value(1).map_err(db_err)?) == Some(1),
                ),
                None => (None, None, true),
            };

            // RI-61: el mismo criterio que una reserva del TPV, pero aquí nunca se rechaza: la
            // reserva ya está confirmada al cliente (regla 3 del plan).
            let choca = match &id_mesa {
                Some(m) => {
                    let (duracion_def, _) = ajustes_de_reserva(conn).await?;
                    choque_en_la_mesa(conn, m, (&a.alta.dia_ymd, &a.alta.hora, None), &a.id_reserva, duracion_def)
                        .await?
                        .is_some()
                }
                None => false,
            };

            // La hora del alta la puso quien la hizo (0004). Si no llegó una válida, la de la Main, ya
            // como literal: un `COALESCE(?, datetime('now', …))` dejaría la sentencia sin poder
            // leerse cuando hay que repararla (`sync_reparacion::analizar` parte los VALUES por comas).
            let creada = a
                .creada_local
                .clone()
                .unwrap_or_else(|| chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string());

            // El cliente es el de ese correo (`ux_clientes_email`). Si ya existe, lo escrito sólo
            // rellena sus huecos (RES-01); si no, uno nuevo con el UUID antes del INSERT.
            // El teléfono que se escribió en la web, si no es el de la ficha: la ficha no se toca, y
            // se apunta en la nota de esta reserva para que quien la atienda lo tenga.
            let mut telefono_distinto: Option<String> = None;
            let id_cliente = match cliente_por(conn, POR_EMAIL, &a.alta.email).await? {
                Some(existente) => {
                    if let Some(de_la_ficha) = existente.telefono.as_deref() {
                        if !mismo_telefono(de_la_ficha, &a.alta.telefono) {
                            telefono_distinto = Some(a.alta.telefono.trim().to_string());
                        }
                    }
                    if existente.telefono.is_none() {
                        conn.execute(
                            "UPDATE Clientes SET Telefono = ?1 WHERE ID_Cliente = ?2;",
                            vec![Value::Text(a.alta.telefono.clone()), Value::Text(existente.id.clone())],
                        )
                        .await
                        .map_err(db_err)?;
                    }
                    existente.id
                }
                None => {
                    let id = new_id();
                    conn.execute(
                        "INSERT INTO Clientes (ID_Cliente, Nombre, Telefono, Email, Created_At) \
                         VALUES (?1, ?2, ?3, ?4, ?5);",
                        vec![
                            Value::Text(id.clone()),
                            Value::Text(a.alta.nombre.clone()),
                            Value::Text(a.alta.telefono.clone()),
                            Value::Text(a.alta.email.clone()),
                            Value::Text(creada.clone()),
                        ],
                    )
                    .await
                    .map_err(db_err)?;
                    id
                }
            };

            // Con el id de la agenda, `Origen = 'WEB'`, la duración del negocio (NULL) y la hora del
            // alta, que la puso quien la hizo (0004).
            conn.execute(
                "INSERT INTO Reservas (ID_Reserva, ID_Cliente, ID_Mesa, Dia_YMD, Hora, Turno, Comensales, Nota, \
                                       Estado, Duracion_Min, Created_At, Origen) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'PROXIMA', NULL, ?9, 'WEB') \
                 ON CONFLICT(ID_Reserva) DO NOTHING;",
                vec![
                    Value::Text(a.id_reserva.clone()),
                    Value::Text(id_cliente),
                    opt_text(id_mesa),
                    Value::Text(a.alta.dia_ymd.clone()),
                    Value::Text(a.alta.hora.clone()),
                    Value::Text(a.turno.clone()),
                    Value::Integer(a.alta.personas),
                    opt_text(nota_con_telefono(a.alta.nota.as_deref(), telefono_distinto.as_deref())),
                    Value::Text(creada),
                ],
            )
            .await
            .map_err(db_err)?;

            Ok(AltaWebRegistrada::Nueva { solapada: choca || mesa_fuera, mesa: numero })
        })
        .await
    }

    async fn cancelar_desde_la_web(&self, id_reserva: &str) -> AppResult<CancelacionWeb> {
        let g = self.db.write().await;
        let conn = &g;
        conn.transaccion(async {
            let mut rows = conn
                .query(
                    "SELECT R.Estado, R.Dia_YMD, R.Hora, M.Numero_Mesa, C.Nombre \
                     FROM Reservas R \
                     LEFT JOIN Mesas M ON M.ID_Mesa = R.ID_Mesa \
                     LEFT JOIN Clientes C ON C.ID_Cliente = R.ID_Cliente \
                     WHERE R.ID_Reserva = ?1 AND R.Origen = 'WEB';",
                    vec![Value::Text(id_reserva.to_string())],
                )
                .await
                .map_err(db_err)?;
            let Some(row) = rows.next().await.map_err(db_err)? else {
                return Ok(CancelacionWeb::NoExiste);
            };
            let estado = v_string(row.get_value(0).map_err(db_err)?).unwrap_or_default();
            // Como cancelar desde la pantalla: sólo la que aún no ha llegado. Con el cliente ya
            // sentado (lo sentó la Main antes de subirlo), terminada o sin presentarse, se queda.
            if estado != "PROXIMA" {
                return Ok(CancelacionWeb::YaNoEstabaViva);
            }
            let resumen = ReservaWebResumen {
                dia_ymd: v_string(row.get_value(1).map_err(db_err)?).unwrap_or_default(),
                hora: v_string(row.get_value(2).map_err(db_err)?).unwrap_or_default(),
                mesa: v_string(row.get_value(3).map_err(db_err)?),
                nombre: v_string(row.get_value(4).map_err(db_err)?),
            };
            // Se decide aquí, al escribir, y se replica sin condición: con la del estado, la otra
            // copia la volvería a evaluar y, si tuviera la reserva en otro estado, no cancelaría.
            conn.execute(
                "UPDATE Reservas SET Estado = 'CANCELADA' WHERE ID_Reserva = ?1;",
                vec![Value::Text(id_reserva.to_string())],
            )
            .await
            .map_err(db_err)?;
            Ok(CancelacionWeb::Cancelada(resumen))
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

    /// Las sentencias de la última operación del outbox.
    async fn ultima_operacion(db: &Db) -> Vec<tpv_contracts::sync::SqlStatement> {
        let g = db.read().await;
        let mut rows = g
            .query("SELECT Statements_Json FROM _Sync_Outbox ORDER BY Seq DESC LIMIT 1;", ())
            .await
            .unwrap();
        match rows.next().await.unwrap().unwrap().get_value(0).unwrap() {
            Value::Text(t) => serde_json::from_str(&t).unwrap(),
            otro => panic!("{otro:?}"),
        }
    }

    /// Guardar deja la casilla y una sola franja, y sale hacia la nube como UNA operación con las
    /// tres sentencias: aplicada en otra base, por el mismo camino que la Main aplica lo que llega
    /// de fuera, deja exactamente la misma configuración.
    #[tokio::test]
    async fn guardar_una_mesa_deja_su_casilla_y_una_franja_y_se_replica_entera() {
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
        assert_eq!(outbox(&db).await, antes + 2, "una operación por guardado");

        let sentencias = ultima_operacion(&db).await;
        let cabezas: Vec<&str> = sentencias.iter().map(|s| s.sql.split_whitespace().take(3).last().unwrap_or("")).collect();
        assert_eq!(cabezas, ["Reserva_Web_Mesas", "Reserva_Web_Franjas", "Reserva_Web_Franjas"], "{sentencias:?}");

        // La otra base: el mismo plano y lo que ha salido, aplicado como un cambio remoto.
        let (db2, repo2, dir2) = abrir().await;
        sembrar_mesas(&db2).await;
        let sync = crate::sync::SqliteSyncRepository::new(db2.clone());
        tpv_application::ports::sync::SyncRepository::apply_changes(
            &sync,
            vec![tpv_contracts::sync::SyncChange { op_id: "op-de-la-main".into(), seq: 1, statements: sentencias }],
        )
        .await
        .unwrap();
        assert_eq!(format!("{:?}", repo2.mesas().await.unwrap()), format!("{mesas:?}"));

        drop((repo, repo2, sync));
        drop((db, db2));
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&dir2);
    }

    /// Si algo falla a mitad (aquí, una franja que el CHECK del esquema rechaza después de haber
    /// borrado la anterior), no queda nada a medias: ni en la base ni en el outbox.
    #[tokio::test]
    async fn un_fallo_a_mitad_deja_la_configuracion_anterior() {
        let (db, repo, dir) = abrir().await;
        sembrar_mesas(&db).await;
        repo.guardar_mesa(mesa_web("m1", true, Some(("12:00", "16:00")))).await.unwrap();
        let antes = outbox(&db).await;
        let como_estaba = format!("{:?}", repo.mesas().await.unwrap());

        let al_reves = mesa_web("m1", false, Some(("16:00", "12:00")));
        assert!(repo.guardar_mesa(al_reves).await.is_err());

        assert_eq!(format!("{:?}", repo.mesas().await.unwrap()), como_estaba);
        assert_eq!(outbox(&db).await, antes);
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
    // ── Registrar lo que llega de la web (§5.5) ──────────────────────────────────────────────────

    fn alta(id: &str, email: &str, mesa: &str, hora: &str) -> AltaWebParaRegistrar {
        AltaWebParaRegistrar::validar(
            id,
            tpv_domain::reservas_web::AltaWebEntrada {
                dia_ymd: "2026-11-20".into(),
                hora: hora.into(),
                personas: 2,
                id_mesa: mesa.into(),
                nombre: "Ana Pérez".into(),
                email: email.into(),
                telefono: "600 112 233".into(),
                nota: Some("Silla para bebé".into()),
            },
            "2026-11-10 12:30:05",
        )
        .unwrap()
    }

    /// Una fila como texto, columna a columna, para comparar sin pelearse con los tipos.
    async fn fila(db: &Db, sql: &str) -> Vec<String> {
        let g = db.read().await;
        let mut rows = g.query(sql, ()).await.unwrap();
        let row = rows.next().await.unwrap().expect("sin fila");
        // Hasta la primera columna que no existe.
        (0..)
            .map_while(|i| row.get_value(i).ok())
            .map(|v| match v {
                Value::Null => "NULL".to_string(),
                Value::Integer(n) => n.to_string(),
                Value::Text(t) => t,
                otro => format!("{otro:?}"),
            })
            .collect()
    }

    /// Las claves primarias de las tablas que escribe el alta, para el analizador de la reparación.
    fn claves(tabla: &str) -> Vec<String> {
        match tabla {
            "Clientes" => vec!["ID_Cliente".into()],
            "Reservas" => vec!["ID_Reserva".into()],
            _ => vec![],
        }
    }

    async fn contar(db: &Db, sql: &str) -> i64 {
        fila(db, sql).await[0].parse().unwrap()
    }

    #[tokio::test]
    async fn un_alta_web_crea_su_cliente_y_su_reserva_con_la_hora_del_alta_y_se_replica() {
        let (db, repo, dir) = abrir().await;
        sembrar_mesas(&db).await;
        let antes = outbox(&db).await;

        let r = repo.registrar_alta(alta("r1", "ana@correo.es", "m1", "21:00")).await.unwrap();

        assert_eq!(r, AltaWebRegistrada::Nueva { solapada: false, mesa: Some("1".into()) });
        assert_eq!(
            fila(&db, "SELECT ID_Mesa, Dia_YMD, Hora, Turno, Comensales, Nota, Estado, Duracion_Min, Created_At, Origen FROM Reservas WHERE ID_Reserva = 'r1';").await,
            ["m1", "2026-11-20", "21:00", "CENA", "2", "Silla para bebé", "PROXIMA", "NULL", "2026-11-10 12:30:05", "WEB"]
        );
        assert_eq!(
            fila(&db, "SELECT C.Nombre, C.Telefono, C.Email, C.Created_At FROM Reservas R JOIN Clientes C ON C.ID_Cliente = R.ID_Cliente WHERE R.ID_Reserva = 'r1';").await,
            ["Ana Pérez", "600112233", "ana@correo.es", "2026-11-10 12:30:05"]
        );
        // Una sola operación hacia la nube, con el cliente y la reserva.
        assert_eq!(outbox(&db).await, antes + 1);
        let sentencias = ultima_operacion(&db).await;
        assert_eq!(sentencias.len(), 2);
        assert!(sentencias[1].sql.contains("ON CONFLICT(ID_Reserva) DO NOTHING"));
        // Y si esa operación hubiera que repararla, se saben leer las dos filas: el cliente y la
        // reserva, con sus claves.
        let id_cliente = fila(&db, "SELECT ID_Cliente FROM Reservas WHERE ID_Reserva = 'r1';").await.remove(0);
        let analisis = crate::sync_reparacion::analizar(&sentencias, &claves);
        assert!(!analisis.incierto, "{analisis:?}");
        assert_eq!(
            analisis.filas.iter().map(|f| (f.tabla.as_str(), f.clave[0].1.as_str())).collect::<Vec<_>>(),
            [("Clientes", id_cliente.as_str()), ("Reservas", "r1")]
        );
        drop(repo);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn recibirla_dos_veces_no_la_duplica_ni_escribe_nada() {
        let (db, repo, dir) = abrir().await;
        sembrar_mesas(&db).await;
        repo.registrar_alta(alta("r1", "ana@correo.es", "m1", "21:00")).await.unwrap();
        let antes = outbox(&db).await;

        assert_eq!(repo.registrar_alta(alta("r1", "ana@correo.es", "m1", "21:00")).await.unwrap(), AltaWebRegistrada::YaEstaba);

        assert_eq!(outbox(&db).await, antes);
        assert_eq!(contar(&db, "SELECT COUNT(*) FROM Reservas;").await, 1);
        assert_eq!(contar(&db, "SELECT COUNT(*) FROM Clientes;").await, 1);
        drop(repo);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// RES-01: el cliente de ese correo se queda la reserva, y lo que trae sólo rellena sus huecos.
    #[tokio::test]
    async fn el_cliente_de_ese_correo_se_queda_la_reserva_y_sus_datos_no_se_pisan() {
        let (db, repo, dir) = abrir().await;
        sembrar_mesas(&db).await;
        {
            let w = db.write().await;
            w.raw()
                .execute_batch("INSERT INTO Clientes (ID_Cliente, Nombre, Email) VALUES ('c1', 'Ana de siempre', 'ANA@correo.es');")
                .await
                .unwrap();
        }

        repo.registrar_alta(alta("r1", "ana@correo.es", "m1", "21:00")).await.unwrap();

        assert_eq!(fila(&db, "SELECT ID_Cliente FROM Reservas WHERE ID_Reserva = 'r1';").await, ["c1"]);
        assert_eq!(
            fila(&db, "SELECT Nombre, Telefono, Email FROM Clientes WHERE ID_Cliente = 'c1';").await,
            ["Ana de siempre", "600112233", "ANA@correo.es"]
        );
        assert_eq!(contar(&db, "SELECT COUNT(*) FROM Clientes;").await, 1);
        // También se sabe reparar: rellenar el teléfono y la reserva.
        let analisis = crate::sync_reparacion::analizar(&ultima_operacion(&db).await, &claves);
        assert!(!analisis.incierto, "{analisis:?}");
        assert_eq!(
            analisis.filas.iter().map(|f| (f.tabla.as_str(), f.clave[0].1.as_str())).collect::<Vec<_>>(),
            [("Clientes", "c1"), ("Reservas", "r1")]
        );
        drop(repo);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// El cliente de ese correo ya tiene otro teléfono: la ficha no se toca, y el que se escribió en
    /// la web se apunta en la nota de la reserva. El mismo con otros espacios no cuenta como otro.
    #[tokio::test]
    async fn el_telefono_de_la_web_que_no_es_el_de_la_ficha_va_a_la_nota() {
        let (db, repo, dir) = abrir().await;
        sembrar_mesas(&db).await;
        {
            let w = db.write().await;
            w.raw()
                .execute_batch(
                    "INSERT INTO Clientes (ID_Cliente, Nombre, Telefono, Email) VALUES ('c1', 'Ana', '611 000 000', 'ana@correo.es');                      INSERT INTO Clientes (ID_Cliente, Nombre, Telefono, Email) VALUES ('c2', 'Luis', '600 11 22 33', 'luis@correo.es');",
                )
                .await
                .unwrap();
        }

        repo.registrar_alta(alta("r1", "ana@correo.es", "m1", "21:00")).await.unwrap();
        repo.registrar_alta(alta("r2", "luis@correo.es", "m2", "21:00")).await.unwrap();

        assert_eq!(
            fila(&db, "SELECT Nota FROM Reservas WHERE ID_Reserva = 'r1';").await,
            ["Silla para bebé
Teléfono dado en la web: 600112233"]
        );
        assert_eq!(fila(&db, "SELECT Telefono FROM Clientes WHERE ID_Cliente = 'c1';").await, ["611 000 000"]);
        // El de Luis es el mismo número con espacios: la nota queda como la escribió.
        assert_eq!(fila(&db, "SELECT Nota FROM Reservas WHERE ID_Reserva = 'r2';").await, ["Silla para bebé"]);
        drop(repo);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Una reserva web confirmada no se rechaza nunca: aunque el negocio prohíba los solapes, se
    /// guarda y se dice que choca.
    #[tokio::test]
    async fn si_choca_se_guarda_igual_y_dice_que_choca() {
        let (db, repo, dir) = abrir().await;
        sembrar_mesas(&db).await;
        {
            let w = db.write().await;
            w.raw()
                .execute_batch(
                    "UPDATE Business_Settings SET Reserva_Solape = 'prohibir' WHERE ID = 1; \
                     INSERT INTO Reservas (ID_Reserva, ID_Mesa, Dia_YMD, Hora, Turno, Comensales, Estado) \
                       VALUES ('tpv', 'm1', '2026-11-20', '20:30', 'CENA', 4, 'PROXIMA');",
                )
                .await
                .unwrap();
        }

        let r = repo.registrar_alta(alta("r1", "ana@correo.es", "m1", "21:00")).await.unwrap();

        assert_eq!(r, AltaWebRegistrada::Nueva { solapada: true, mesa: Some("1".into()) });
        assert_eq!(contar(&db, "SELECT COUNT(*) FROM Reservas WHERE ID_Mesa = 'm1';").await, 2);
        drop(repo);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn sin_su_mesa_se_guarda_sin_mesa_y_en_una_archivada_se_guarda_en_ella_y_las_dos_hay_que_moverlas() {
        let (db, repo, dir) = abrir().await;
        sembrar_mesas(&db).await;

        let borrada = repo.registrar_alta(alta("r1", "ana@correo.es", "ya-no-esta", "21:00")).await.unwrap();
        let archivada = repo.registrar_alta(alta("r2", "otra@correo.es", "vieja", "21:00")).await.unwrap();

        assert_eq!(borrada, AltaWebRegistrada::Nueva { solapada: true, mesa: None });
        assert_eq!(fila(&db, "SELECT ID_Mesa FROM Reservas WHERE ID_Reserva = 'r1';").await, ["NULL"]);
        assert_eq!(archivada, AltaWebRegistrada::Nueva { solapada: true, mesa: Some("3".into()) });
        drop(repo);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Sin un instante válido de la agenda cuenta el «ahora» de la Main, como literal: lo que sale
    /// hacia la nube no puede llevar un `'now'` que cada base calcularía a su manera.
    #[tokio::test]
    async fn sin_la_hora_del_alta_cuenta_la_de_la_main_y_viaja_como_literal() {
        let (db, repo, dir) = abrir().await;
        sembrar_mesas(&db).await;
        let mut a = alta("r1", "ana@correo.es", "m1", "21:00");
        a.creada_local = None;

        repo.registrar_alta(a).await.unwrap();

        let creada = fila(&db, "SELECT Created_At FROM Reservas WHERE ID_Reserva = 'r1';").await;
        assert_eq!(creada[0].len(), 19, "{creada:?}");
        for s in ultima_operacion(&db).await {
            assert!(!s.sql.contains("'now'"), "{}", s.sql);
        }
        drop(repo);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn la_cancelacion_del_cliente_cancela_una_viva_una_sola_vez() {
        let (db, repo, dir) = abrir().await;
        sembrar_mesas(&db).await;
        repo.registrar_alta(alta("r1", "ana@correo.es", "m1", "21:00")).await.unwrap();
        {
            let w = db.write().await;
            w.raw()
                .execute_batch(
                    "INSERT INTO Reservas (ID_Reserva, ID_Mesa, Dia_YMD, Hora, Turno, Comensales, Estado) \
                       VALUES ('del-tpv', 'm2', '2026-11-20', '21:00', 'CENA', 2, 'PROXIMA');",
                )
                .await
                .unwrap();
        }
        let antes = outbox(&db).await;

        let r = repo.cancelar_desde_la_web("r1").await.unwrap();

        assert_eq!(
            r,
            CancelacionWeb::Cancelada(ReservaWebResumen {
                nombre: Some("Ana Pérez".into()),
                dia_ymd: "2026-11-20".into(),
                hora: "21:00".into(),
                mesa: Some("1".into()),
            })
        );
        assert_eq!(fila(&db, "SELECT Estado FROM Reservas WHERE ID_Reserva = 'r1';").await, ["CANCELADA"]);
        assert_eq!(outbox(&db).await, antes + 1);
        // Se replica la cancelación por id, sin condición: la otra copia la aplica igual aunque
        // tenga la reserva en otro estado.
        assert!(fila(&db, "SELECT Statements_Json FROM _Sync_Outbox ORDER BY Seq DESC LIMIT 1;").await[0]
            .contains("UPDATE Reservas SET Estado = 'CANCELADA' WHERE ID_Reserva = ?1;"));
        assert_eq!(repo.cancelar_desde_la_web("r1").await.unwrap(), CancelacionWeb::YaNoEstabaViva);
        assert_eq!(repo.cancelar_desde_la_web("no-existe").await.unwrap(), CancelacionWeb::NoExiste);
        // Una del TPV no se cancela por esta puerta.
        assert_eq!(repo.cancelar_desde_la_web("del-tpv").await.unwrap(), CancelacionWeb::NoExiste);
        assert_eq!(outbox(&db).await, antes + 1);
        drop(repo);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn la_cancelacion_del_cliente_no_toca_una_reserva_ya_sentada() {
        // La Main la sentó antes de subirlo, y la cancelación del enlace llega después: como al
        // cancelar desde la pantalla, sólo se cancela la que aún no ha llegado.
        let (db, repo, dir) = abrir().await;
        sembrar_mesas(&db).await;
        repo.registrar_alta(alta("r1", "ana@correo.es", "m1", "21:00")).await.unwrap();
        db.write()
            .await
            .raw()
            .execute("UPDATE Reservas SET Estado = 'ACTIVA' WHERE ID_Reserva = 'r1';", ())
            .await
            .unwrap();
        let antes = outbox(&db).await;

        assert_eq!(repo.cancelar_desde_la_web("r1").await.unwrap(), CancelacionWeb::YaNoEstabaViva);
        assert_eq!(fila(&db, "SELECT Estado FROM Reservas WHERE ID_Reserva = 'r1';").await, ["ACTIVA"]);
        assert_eq!(outbox(&db).await, antes);
        drop(repo);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
