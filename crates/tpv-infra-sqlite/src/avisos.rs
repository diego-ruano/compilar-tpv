//! Adaptador SQLite del **escáner de avisos** (`AvisosScanRepository`). Lecturas puras (pool de
//! lectura) de condiciones de tiempo/estado; no escribe (las emisiones las hace el `Notifier`).

use crate::consultas::{db_err};
use std::sync::Arc;

use async_trait::async_trait;
use crate::ejecutor::Value;

use tpv_application::error::AppResult;
use tpv_application::ports::avisos::{AvisosScanRepository, ReservaProxima, TareaVencida};

use crate::db::{Db, Reader};
use crate::mapping::v_string;

pub struct SqliteAvisosScanRepository {
    db: Arc<Db>,
}

impl SqliteAvisosScanRepository {
    pub fn new(db: Arc<Db>) -> Self {
        Self { db }
    }
}

#[async_trait]
impl AvisosScanRepository for SqliteAvisosScanRepository {
    async fn tareas_vencidas(&self) -> AppResult<Vec<TareaVencida>> {
        // Tarea ABIERTA con fecha límite pasada y ≥1 asignación no finalizada. `date('now','localtime')`
        // va en una LECTURA (no se captura en el outbox), así que es seguro.
        let sql = r#"
            SELECT t.ID_Tarea, t.Titulo
            FROM Tareas t
            WHERE COALESCE(t.Estado, 'ABIERTA') = 'ABIERTA'
              AND t.Fecha_Limite IS NOT NULL
              AND date(t.Fecha_Limite) < date('now','localtime')
              AND EXISTS (
                SELECT 1 FROM Tarea_Asignaciones a
                WHERE a.ID_Tarea = t.ID_Tarea AND a.Estado <> 'FINALIZADA'
              )
            ORDER BY t.Fecha_Limite ASC;
        "#;

        let db = self.db.read().await;
        let mut rows = db.query(sql, ()).await.map_err(db_err)?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().await.map_err(db_err)? {
            out.push(TareaVencida {
                id_tarea: v_string(row.get_value(0).map_err(db_err)?).unwrap_or_default(),
                titulo: v_string(row.get_value(1).map_err(db_err)?).unwrap_or_default(),
            });
        }
        Ok(out)
    }

    async fn reservas_proximas(&self, ventana_min: i64) -> AppResult<Vec<ReservaProxima>> {
        // El modificador de `datetime` va como parámetro (?1 = "+N minutes"): reserva cuyo inicio
        // cae entre ahora y ahora+ventana. Las que aún no han llegado: `PROXIMA`. Antes miraba
        // `ACTIVA`, que es el cliente ya sentado, y como las reservas nacen `PROXIMA` el aviso no
        // salía nunca.
        let modif = format!("+{} minutes", ventana_min.max(0));
        let sql = r#"
            SELECT r.ID_Reserva, COALESCE(c.Nombre, '') AS Nombre, r.Dia_YMD, r.Hora
            FROM Reservas r
            LEFT JOIN Clientes c ON c.ID_Cliente = r.ID_Cliente
            WHERE r.Estado = 'PROXIMA'
              AND datetime(r.Dia_YMD || ' ' || r.Hora) >= datetime('now','localtime')
              AND datetime(r.Dia_YMD || ' ' || r.Hora) <= datetime('now','localtime', ?1)
            ORDER BY r.Dia_YMD ASC, r.Hora ASC;
        "#;

        let db = self.db.read().await;
        let mut rows = db
            .query(sql, vec![Value::Text(modif)])
            .await
            .map_err(db_err)?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().await.map_err(db_err)? {
            out.push(ReservaProxima {
                id_reserva: v_string(row.get_value(0).map_err(db_err)?).unwrap_or_default(),
                nombre_cliente: v_string(row.get_value(1).map_err(db_err)?).unwrap_or_default(),
                dia_ymd: v_string(row.get_value(2).map_err(db_err)?).unwrap_or_default(),
                hora: v_string(row.get_value(3).map_err(db_err)?).unwrap_or_default(),
            });
        }
        Ok(out)
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn reserva_proxima_avisa_de_las_que_aun_no_han_llegado() {
        let dir = crate::test_temp::dir_temporal("avisos_reservas");
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        let en = |minutos: i64| {
            let h = chrono::Local::now() + chrono::Duration::minutes(minutos);
            (h.format("%Y-%m-%d").to_string(), h.format("%H:%M").to_string())
        };
        {
            let w = db.write().await;
            for (id, minutos, estado) in
                [("por-llegar", 15, "PROXIMA"), ("sentada", 15, "ACTIVA"), ("cancelada", 15, "CANCELADA"), ("luego", 90, "PROXIMA")]
            {
                let (dia, hora) = en(minutos);
                w.raw()
                    .execute(
                        "INSERT INTO Reservas (ID_Reserva, Dia_YMD, Hora, Turno, Comensales, Estado) \
                         VALUES (?1, ?2, ?3, 'CENA', 2, ?4);",
                        vec![Value::Text(id.into()), Value::Text(dia), Value::Text(hora), Value::Text(estado.into())],
                    )
                    .await
                    .unwrap();
            }
        }
        let proximas = SqliteAvisosScanRepository::new(db).reservas_proximas(30).await.unwrap();
        assert_eq!(proximas.iter().map(|r| r.id_reserva.as_str()).collect::<Vec<_>>(), ["por-llegar"]);
    }
}
