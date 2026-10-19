//! La cola de avisos al cliente de las reservas web (docs/estudios/reservas-web.md §5.7).
//!
//! Cuando el restaurante cambia o cancela una reserva web, la Main apunta aquí el correo que hay que
//! mandarle al cliente, y el job `avisos_reserva_web` lo entrega al worker cuando hay conexión: un
//! cambio hecho sin internet avisa al volver. `_Reservas_Web_Avisos` es estado local del equipo: se
//! escribe por `raw()` y no se replica.

use std::sync::Arc;

use async_trait::async_trait;

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::reservas::{AvisoAlCliente, AvisoEnCola, AvisosReservaWeb, ColaAvisosReservaWeb};
use tpv_contracts::reservas_web::AvisoReservaWebInput;

use crate::consultas::db_err;
use crate::db::{Db, Reader};
use crate::ejecutor::Value;
use crate::mapping::{v_i64, v_string};
use crate::util::{new_id, now_ms};

pub struct SqliteAvisosReservaWeb {
    db: Arc<Db>,
}

impl SqliteAvisosReservaWeb {
    pub fn new(db: Arc<Db>) -> Self {
        Self { db }
    }
}

fn texto_de(cuerpo: &AvisoReservaWebInput) -> AppResult<(String, String)> {
    let tipo = serde_json::to_value(cuerpo.tipo)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default();
    let json = serde_json::to_string(cuerpo).map_err(|e| AppError::internal(e.to_string()))?;
    Ok((tipo, json))
}

#[async_trait]
impl AvisosReservaWeb for SqliteAvisosReservaWeb {
    async fn encolar(&self, aviso: AvisoAlCliente) -> AppResult<()> {
        let cuerpo = AvisoReservaWebInput {
            id_aviso: new_id(),
            id_reserva: aviso.id_reserva,
            tipo: aviso.tipo,
            dia_ymd: aviso.dia_ymd,
            hora: aviso.hora,
            personas: aviso.personas,
            mesa: aviso.mesa,
            id_cliente: aviso.id_cliente,
        };
        let (tipo, json) = texto_de(&cuerpo)?;
        let g = self.db.write().await;
        let r = g
            .raw()
            .execute(
                "INSERT INTO _Reservas_Web_Avisos (ID_Aviso, ID_Reserva, Tipo, Datos_Json, Creado_Ms) \
                 VALUES (?1, ?2, ?3, ?4, ?5);",
                vec![
                    Value::Text(cuerpo.id_aviso.clone()),
                    Value::Text(cuerpo.id_reserva.clone()),
                    Value::Text(tipo),
                    Value::Text(json),
                    Value::Integer(now_ms()),
                ],
            )
            .await
            .map_err(db_err);
        if let Err(e) = &r {
            tracing::warn!(target: "tpv::reservas_web", codigo = ?e.code(), "no se ha podido encolar el aviso al cliente");
        }
        r.map(|_| ())
    }
}

#[async_trait]
impl ColaAvisosReservaWeb for SqliteAvisosReservaWeb {
    async fn pendientes(&self, max: i64) -> AppResult<Vec<AvisoEnCola>> {
        let mut out = Vec::new();
        let mut ilegibles = Vec::new();
        {
            let db = self.db.read().await;
            let mut rows = db
                .query(
                    "SELECT ID_Aviso, Datos_Json, Creado_Ms, Intentos FROM _Reservas_Web_Avisos \
                     ORDER BY Creado_Ms, ID_Aviso LIMIT ?1;",
                    vec![Value::Integer(max)],
                )
                .await
                .map_err(db_err)?;
            while let Some(row) = rows.next().await.map_err(db_err)? {
                let id = v_string(row.get_value(0).map_err(db_err)?).unwrap_or_default();
                let json = v_string(row.get_value(1).map_err(db_err)?).unwrap_or_default();
                let creado_ms = v_i64(row.get_value(2).map_err(db_err)?).unwrap_or(0);
                let intentos = v_i64(row.get_value(3).map_err(db_err)?).unwrap_or(0);
                match serde_json::from_str::<AvisoReservaWebInput>(&json) {
                    Ok(cuerpo) => out.push(AvisoEnCola { cuerpo, creado_ms, intentos }),
                    Err(_) => ilegibles.push(id),
                }
            }
        }
        // Una fila que no se entiende no se podrá mandar nunca: fuera, para que no tape a las de
        // detrás.
        for id in ilegibles {
            tracing::warn!(target: "tpv::reservas_web", "aviso al cliente ilegible en la cola: se descarta");
            self.quitar(&id).await?;
        }
        Ok(out)
    }

    async fn quitar(&self, id_aviso: &str) -> AppResult<()> {
        let g = self.db.write().await;
        g.raw()
            .execute("DELETE FROM _Reservas_Web_Avisos WHERE ID_Aviso = ?1;", vec![Value::Text(id_aviso.to_string())])
            .await
            .map_err(db_err)?;
        Ok(())
    }

    async fn apuntar_fallo(&self, id_aviso: &str, codigo: &str) -> AppResult<()> {
        let g = self.db.write().await;
        g.raw()
            .execute(
                "UPDATE _Reservas_Web_Avisos SET Intentos = Intentos + 1, Ultimo_Error = ?2 WHERE ID_Aviso = ?1;",
                vec![Value::Text(id_aviso.to_string()), Value::Text(codigo.to_string())],
            )
            .await
            .map_err(db_err)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tpv_contracts::reservas_web::TipoAvisoReservaWeb;

    async fn abrir() -> (Arc<Db>, std::path::PathBuf) {
        let dir = crate::test_temp::dir_temporal("reservas_web_avisos");
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        (db, dir)
    }

    fn aviso(id: &str) -> AvisoAlCliente {
        AvisoAlCliente {
            id_reserva: id.into(),
            tipo: TipoAvisoReservaWeb::Modificada,
            dia_ymd: "2026-10-24".into(),
            hora: "22:00".into(),
            personas: 4,
            mesa: Some("Mesa 7".into()),
            id_cliente: Some("c1".into()),
        }
    }

    #[tokio::test]
    async fn se_encola_se_lee_en_orden_se_apunta_el_fallo_y_se_quita() {
        let (db, _dir) = abrir().await;
        let cola = SqliteAvisosReservaWeb::new(db.clone());
        cola.encolar(aviso("r1")).await.unwrap();
        cola.encolar(aviso("r2")).await.unwrap();

        let p = cola.pendientes(10).await.unwrap();
        assert_eq!(p.iter().map(|a| a.cuerpo.id_reserva.as_str()).collect::<Vec<_>>(), ["r1", "r2"]);
        assert_eq!(p[0].cuerpo.mesa.as_deref(), Some("Mesa 7"));
        assert_ne!(p[0].cuerpo.id_aviso, p[1].cuerpo.id_aviso);
        assert!(p[0].creado_ms > 0);

        cola.apuntar_fallo(&p[0].cuerpo.id_aviso, "not_found").await.unwrap();
        let mut rows = db
            .read()
            .await
            .query("SELECT Intentos, Ultimo_Error, Tipo FROM _Reservas_Web_Avisos WHERE ID_Reserva = 'r1';", ())
            .await
            .unwrap();
        let row = rows.next().await.unwrap().unwrap();
        assert_eq!(v_i64(row.get_value(0).unwrap()), Some(1));
        assert_eq!(v_string(row.get_value(1).unwrap()).as_deref(), Some("not_found"));
        assert_eq!(v_string(row.get_value(2).unwrap()).as_deref(), Some("modificada"));
        drop(rows);

        cola.quitar(&p[0].cuerpo.id_aviso).await.unwrap();
        assert_eq!(cola.pendientes(10).await.unwrap().len(), 1);
        // No es una escritura de negocio: no llega al outbox.
        let mut rows = db.read().await.query("SELECT COUNT(*) FROM _Sync_Outbox;", ()).await.unwrap();
        let n = v_i64(rows.next().await.unwrap().unwrap().get_value(0).unwrap());
        assert_eq!(n, Some(0));
    }
}
