//! Adaptador SQLite del estado del PDF de las facturas completas (`_Facturas_Pdf`,
//! `0006_facturas_pdf.sql`).
//!
//! Es estado local del equipo, como `_Jobs_State`: todas las escrituras van por la conexión cruda
//! (`WriteGuard::raw()`). Por `execute()` cada anotación se capturaría en `_Sync_Outbox` y viajaría
//! a la nube, que no tiene nada que hacer con ella.
//!
//! Una factura completa es un alta de `Registros_Facturacion` con destinatario. Una subsanación
//! repite el número de una factura que ya está: no es una factura nueva y no lleva PDF propio.

use crate::consultas::db_err;
use std::sync::Arc;

use async_trait::async_trait;

use tpv_application::error::AppResult;
use tpv_application::ports::facturas_pdf::{
    CobroDeLaFactura, EstadoPdfFactura, FacturasPdfRepository, OrigenPdf,
};

use crate::db::Db;
use crate::ejecutor::Value;
use crate::mapping::{v_i64, v_string};

pub struct SqliteFacturasPdf {
    db: Arc<Db>,
}

impl SqliteFacturasPdf {
    pub fn new(db: Arc<Db>) -> Self {
        Self { db }
    }
}

/// Las facturas completas sin fila. Entra por `idx_regfact_completas` (el índice parcial de las
/// facturas con destinatario), así que no recorre los tickets: lo vigila un test del plan. Va con
/// `INDEXED BY` porque, sin estadísticas, SQLite prefiere `ux_regfact_idfactura`, cuyo `WHERE` es el
/// de la subsanación, y eso es recorrer todos los registros.
///
/// Sólo un `ID_Registro` con la forma de un UUID (36 cifras hexadecimales y guiones): es el nombre de
/// su fichero en AppData. Todos lo son (`new_id()`); uno que no lo fuera se queda sin PDF en vez de
/// parar a las demás.
pub(crate) const SQL_APUNTAR_NUEVAS: &str = "\
    INSERT INTO _Facturas_Pdf (ID_Registro, Intentos, Apartado) \
    SELECT r.ID_Registro, 0, 0 \
    FROM Registros_Facturacion r INDEXED BY idx_regfact_completas \
    WHERE r.Tipo = 'ALTA' AND r.Destinatario_Json IS NOT NULL \
      AND (r.Subsanacion IS NULL OR r.Subsanacion <> 'S') \
      AND length(r.ID_Registro) = 36 AND r.ID_Registro NOT GLOB '*[^0-9A-Fa-f-]*' \
      AND NOT EXISTS (SELECT 1 FROM _Facturas_Pdf f WHERE f.ID_Registro = r.ID_Registro);";

/// Columnas en el mismo orden en todas las lecturas, para leer por índice.
const COLS: &str = "f.ID_Registro, f.Origen, f.Generado_Ms, f.Subido_Ms, f.Intentos, f.Ultimo_Error, \
                    f.Proximo_Intento_Ms, f.Apartado";

fn fila(row: &crate::ejecutor::Row) -> AppResult<EstadoPdfFactura> {
    let g = |i: i32| row.get_value(i).map_err(db_err);
    Ok(EstadoPdfFactura {
        id_registro: v_string(g(0)?).unwrap_or_default(),
        origen: v_string(g(1)?).as_deref().and_then(OrigenPdf::desde_texto),
        generado_ms: v_i64(g(2)?),
        subido_ms: v_i64(g(3)?),
        intentos: v_i64(g(4)?).unwrap_or(0),
        ultimo_error: v_string(g(5)?),
        proximo_intento_ms: v_i64(g(6)?),
        apartado: v_i64(g(7)?).unwrap_or(0) == 1,
    })
}

impl SqliteFacturasPdf {
    async fn leer(&self, sql: &str, params: Vec<Value>) -> AppResult<Vec<EstadoPdfFactura>> {
        let r = self.db.read().await;
        let mut rows = r.conn().query(sql, params).await.map_err(db_err)?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().await.map_err(db_err)? {
            out.push(fila(&row)?);
        }
        Ok(out)
    }

    async fn escribir(&self, sql: &str, params: Vec<Value>) -> AppResult<u64> {
        let w = self.db.write().await;
        w.raw().execute(sql, params).await.map_err(db_err)
    }
}

#[async_trait]
impl FacturasPdfRepository for SqliteFacturasPdf {
    async fn apuntar_nuevas(&self) -> AppResult<u64> {
        self.escribir(SQL_APUNTAR_NUEVAS, Vec::new()).await
    }

    async fn sin_pdf_local(&self, ahora_ms: i64, limite: i64) -> AppResult<Vec<EstadoPdfFactura>> {
        self.leer(
            &format!(
                "SELECT {COLS} FROM _Facturas_Pdf f \
                 JOIN Registros_Facturacion r ON r.ID_Registro = f.ID_Registro \
                 WHERE f.Generado_Ms IS NULL \
                   AND (f.Proximo_Intento_Ms IS NULL OR f.Proximo_Intento_Ms <= ?1) \
                 ORDER BY r.Orden DESC LIMIT ?2;"
            ),
            vec![Value::Integer(ahora_ms), Value::Integer(limite)],
        )
        .await
    }

    async fn sin_subir(&self, limite: i64) -> AppResult<Vec<EstadoPdfFactura>> {
        self.leer(
            &format!(
                "SELECT {COLS} FROM _Facturas_Pdf f \
                 JOIN Registros_Facturacion r ON r.ID_Registro = f.ID_Registro \
                 WHERE f.Generado_Ms IS NOT NULL AND f.Subido_Ms IS NULL AND f.Apartado = 0 \
                 ORDER BY r.Orden DESC LIMIT ?1;"
            ),
            vec![Value::Integer(limite)],
        )
        .await
    }

    async fn estado(&self, id_registro: &str) -> AppResult<Option<EstadoPdfFactura>> {
        Ok(self
            .leer(
                &format!("SELECT {COLS} FROM _Facturas_Pdf f WHERE f.ID_Registro = ?1 LIMIT 1;"),
                vec![Value::Text(id_registro.to_string())],
            )
            .await?
            .into_iter()
            .next())
    }

    async fn cobro_de_la_factura(&self, id_registro: &str) -> AppResult<Option<CobroDeLaFactura>> {
        let r = self.db.read().await;
        let mut rows = r
            .conn()
            .query(
                "SELECT ID_Pago, Num_Serie_Factura, Referencias_Json FROM Registros_Facturacion \
                 WHERE ID_Registro = ?1 AND Tipo = 'ALTA' AND Destinatario_Json IS NOT NULL LIMIT 1;",
                vec![Value::Text(id_registro.to_string())],
            )
            .await
            .map_err(db_err)?;
        let Some(row) = rows.next().await.map_err(db_err)? else {
            return Ok(None);
        };
        let id_pago = v_string(row.get_value(0).map_err(db_err)?).filter(|s| !s.trim().is_empty());
        let num_serie = v_string(row.get_value(1).map_err(db_err)?).unwrap_or_default();
        let referencias = v_string(row.get_value(2).map_err(db_err)?);
        drop(rows);

        // Una F3 de varios tickets no cuelga de ningún cobro: se imprime desde cualquiera de los que
        // canjea (`tickets.rs`), y se toma el primero que se encuentre.
        let id_pago = match id_pago {
            Some(p) => Some(p),
            None => {
                let mut encontrado = None;
                for num in crate::verifactu::numeros_sustituidos(referencias.as_deref()) {
                    if let Some(p) = crate::tickets::pago_de_ticket(&r, &num).await? {
                        encontrado = Some(p);
                        break;
                    }
                }
                encontrado
            }
        };
        Ok(id_pago.map(|id_pago| CobroDeLaFactura { id_pago, num_serie }))
    }

    async fn anotar_local(
        &self,
        id_registro: &str,
        ruta: &str,
        origen: OrigenPdf,
        ahora_ms: i64,
    ) -> AppResult<()> {
        self.escribir(
            "INSERT INTO _Facturas_Pdf (ID_Registro, Ruta, Origen, Generado_Ms, Intentos, Apartado) \
             VALUES (?1, ?2, ?3, ?4, 0, 0) \
             ON CONFLICT(ID_Registro) DO UPDATE SET \
               Ruta = excluded.Ruta, Origen = excluded.Origen, Generado_Ms = excluded.Generado_Ms, \
               Intentos = 0, Ultimo_Error = NULL, Proximo_Intento_Ms = NULL;",
            vec![
                Value::Text(id_registro.to_string()),
                Value::Text(ruta.to_string()),
                Value::Text(origen.como_texto().to_string()),
                Value::Integer(ahora_ms),
            ],
        )
        .await?;
        Ok(())
    }

    async fn olvidar_local(&self, id_registro: &str) -> AppResult<()> {
        self.escribir(
            "UPDATE _Facturas_Pdf SET Ruta = NULL, Origen = NULL, Generado_Ms = NULL \
             WHERE ID_Registro = ?1;",
            vec![Value::Text(id_registro.to_string())],
        )
        .await?;
        Ok(())
    }

    async fn anotar_subido(&self, id_registro: &str, ahora_ms: i64) -> AppResult<()> {
        self.escribir(
            "UPDATE _Facturas_Pdf SET Subido_Ms = ?2 WHERE ID_Registro = ?1;",
            vec![Value::Text(id_registro.to_string()), Value::Integer(ahora_ms)],
        )
        .await?;
        Ok(())
    }

    async fn anotar_fallo(
        &self,
        id_registro: &str,
        motivo: &str,
        proximo_intento_ms: i64,
    ) -> AppResult<()> {
        self.escribir(
            "UPDATE _Facturas_Pdf SET Intentos = Intentos + 1, Ultimo_Error = ?2, \
               Proximo_Intento_Ms = ?3 \
             WHERE ID_Registro = ?1;",
            vec![
                Value::Text(id_registro.to_string()),
                Value::Text(motivo.to_string()),
                Value::Integer(proximo_intento_ms),
            ],
        )
        .await?;
        Ok(())
    }

    async fn apartar(&self, id_registro: &str, motivo: &str) -> AppResult<()> {
        self.escribir(
            "UPDATE _Facturas_Pdf SET Apartado = 1, Ultimo_Error = ?2 WHERE ID_Registro = ?1;",
            vec![Value::Text(id_registro.to_string()), Value::Text(motivo.to_string())],
        )
        .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ejecutor::Connection;

    async fn db_temporal() -> (Arc<Db>, std::path::PathBuf) {
        let dir = crate::test_temp::dir_temporal("facturas_pdf");
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        (db, dir)
    }

    async fn sembrar(db: &Arc<Db>, sentencias: &[&str]) {
        let w = db.write().await;
        let conn: &Connection = w.raw();
        for sql in sentencias {
            conn.execute(sql, Vec::<Value>::new())
                .await
                .unwrap_or_else(|e| panic!("sembrando: {sql}\n{e}"));
        }
    }

    /// Un registro de facturación con lo mínimo. `destinatario` y `referencias` van tal cual (SQL).
    fn registro(id: &str, orden: i64, num: &str, tipo: &str, destinatario: &str, refs: &str, pago: &str) -> String {
        format!(
            "INSERT INTO Registros_Facturacion (ID_Registro, Orden, Tipo, NIF_Emisor, Num_Serie_Factura, \
               Fecha_Expedicion, Serie, Numero, Nombre_Razon_Emisor, Tipo_Factura, Importe_Total, \
               Destinatario_Json, Referencias_Json, Cadena_Huella, Huella, Fecha_Hora_Huso, Sistema_Json, \
               QR_Url, ID_Pago) \
             VALUES ('{id}', {orden}, 'ALTA', 'B12345674', '{num}', '02-01-2026', 'T', {orden}, 'Bar Pepe SL', \
               '{tipo}', '5.10', {destinatario}, {refs}, 'c', 'h', '2026-01-02T12:30:05+01:00', '{{}}', \
               'https://qr', {pago});"
        )
    }

    const CLIENTE: &str = r#"'{"NombreRazon":"Cliente SL","NIF":"B87654321"}'"#;

    async fn con_facturas() -> (Arc<Db>, std::path::PathBuf) {
        let (db, dir) = db_temporal().await;
        let regs = [
            // Un ticket (sin cliente): no lleva PDF.
            registro("00000000-0000-7000-8000-00000000000a", 1, "T-000001", "F2", "NULL", "NULL", "NULL"),
            // Una F1 de un cobro.
            registro("00000000-0000-7000-8000-0000000000f1", 2, "F-000001", "F1", CLIENTE, "NULL", "'p1'"),
            // Una F3 de varios tickets, que no cuelga de ningún cobro.
            registro(
                "00000000-0000-7000-8000-0000000000f3",
                3,
                "F-000002",
                "F3",
                CLIENTE,
                r#"'{"rectificadas":[],"sustituidas":[{"IDEmisorFactura":"B12345674","NumSerieFactura":"T-000009","FechaExpedicionFactura":"02-01-2026"},{"IDEmisorFactura":"B12345674","NumSerieFactura":"T-000010","FechaExpedicionFactura":"02-01-2026"}]}'"#,
                "NULL",
            ),
        ];
        let mut sql: Vec<String> = vec![
            "INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura, Estado) VALUES ('com', 'BARRA', '2026-01-02 12:00:00', 'Pagada');".into(),
            "INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo, Numero_Ticket) VALUES ('p1', 'com', '2026-01-02 12:30:00', 'Efectivo', 510, 'TOTAL', 'F-000001');".into(),
            "INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo, Numero_Ticket) VALUES ('p10', 'com', '2026-01-02 12:40:00', 'Efectivo', 510, 'TOTAL', 'T-000010');".into(),
        ];
        sql.extend(regs);
        let refs: Vec<&str> = sql.iter().map(String::as_str).collect();
        sembrar(&db, &refs).await;
        (db, dir)
    }

    #[tokio::test]
    async fn se_apuntan_las_facturas_completas_una_vez() {
        let (db, _dir) = con_facturas().await;
        let repo = SqliteFacturasPdf::new(db.clone());

        assert_eq!(repo.apuntar_nuevas().await.unwrap(), 2);
        assert_eq!(repo.apuntar_nuevas().await.unwrap(), 0);
        assert!(repo.estado("00000000-0000-7000-8000-00000000000a").await.unwrap().is_none());

        // De la más reciente a la más antigua.
        let ids: Vec<String> =
            repo.sin_pdf_local(0, 10).await.unwrap().into_iter().map(|e| e.id_registro).collect();
        assert_eq!(ids, ["00000000-0000-7000-8000-0000000000f3", "00000000-0000-7000-8000-0000000000f1"]);
    }

    #[tokio::test]
    async fn un_registro_cuyo_id_no_es_un_nombre_de_fichero_no_se_apunta() {
        let (db, _dir) = con_facturas().await;
        sembrar(&db, &[&registro("../../data", 9, "F-000009", "F1", CLIENTE, "NULL", "'p1'")]).await;
        let repo = SqliteFacturasPdf::new(db);
        assert_eq!(repo.apuntar_nuevas().await.unwrap(), 2);
        assert!(repo.estado("../../data").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn una_subsanacion_no_lleva_pdf_propio() {
        let (db, _dir) = con_facturas().await;
        let sub = registro("00000000-0000-7000-8000-00000000005b", 4, "F-000001", "F1", CLIENTE, "NULL", "'p1'")
            .replace("ID_Pago)", "ID_Pago, Subsanacion)")
            .replace("'p1');", "'p1', 'S');");
        sembrar(&db, &[&sub]).await;
        let repo = SqliteFacturasPdf::new(db);
        repo.apuntar_nuevas().await.unwrap();
        assert!(repo.estado("00000000-0000-7000-8000-00000000005b").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn el_cobro_de_una_factura_es_el_suyo_o_el_del_primer_ticket_que_canjea() {
        let (db, _dir) = con_facturas().await;
        let repo = SqliteFacturasPdf::new(db);

        assert_eq!(
            repo.cobro_de_la_factura("00000000-0000-7000-8000-0000000000f1").await.unwrap(),
            Some(CobroDeLaFactura { id_pago: "p1".into(), num_serie: "F-000001".into() })
        );
        // T-000009 no tiene cobro aquí; T-000010 sí.
        assert_eq!(
            repo.cobro_de_la_factura("00000000-0000-7000-8000-0000000000f3").await.unwrap(),
            Some(CobroDeLaFactura { id_pago: "p10".into(), num_serie: "F-000002".into() })
        );
        assert_eq!(repo.cobro_de_la_factura("00000000-0000-7000-8000-00000000000a").await.unwrap(), None);
        assert_eq!(repo.cobro_de_la_factura("no-existe").await.unwrap(), None);
    }

    #[tokio::test]
    async fn cada_anotacion_mueve_la_factura_de_lista() {
        let (db, _dir) = con_facturas().await;
        let repo = SqliteFacturasPdf::new(db);
        repo.apuntar_nuevas().await.unwrap();

        // Un fallo la saca de la lista hasta su hora.
        repo.anotar_fallo("00000000-0000-7000-8000-0000000000f1", "no se pudo", 5_000).await.unwrap();
        let e = repo.estado("00000000-0000-7000-8000-0000000000f1").await.unwrap().unwrap();
        assert_eq!((e.intentos, e.ultimo_error.as_deref(), e.proximo_intento_ms), (1, Some("no se pudo"), Some(5_000)));
        assert_eq!(repo.sin_pdf_local(4_999, 10).await.unwrap().len(), 1);
        assert_eq!(repo.sin_pdf_local(5_000, 10).await.unwrap().len(), 2);

        // Con PDF local, pasa a la de subir y se borran los fallos.
        repo.anotar_local("00000000-0000-7000-8000-0000000000f1", "facturas/00000000-0000-7000-8000-0000000000f1.pdf", OrigenPdf::Generado, 6_000).await.unwrap();
        let e = repo.estado("00000000-0000-7000-8000-0000000000f1").await.unwrap().unwrap();
        assert_eq!((e.origen, e.generado_ms, e.intentos, e.ultimo_error), (Some(OrigenPdf::Generado), Some(6_000), 0, None));
        assert_eq!(repo.sin_pdf_local(10_000, 10).await.unwrap().len(), 1);
        assert_eq!(repo.sin_subir(10).await.unwrap().len(), 1);

        repo.anotar_subido("00000000-0000-7000-8000-0000000000f1", 7_000).await.unwrap();
        assert!(repo.sin_subir(10).await.unwrap().is_empty());

        // Un rechazo de la nube la aparta de la subida.
        repo.anotar_local("00000000-0000-7000-8000-0000000000f3", "facturas/00000000-0000-7000-8000-0000000000f3.pdf", OrigenPdf::Bajado, 8_000).await.unwrap();
        repo.apartar("00000000-0000-7000-8000-0000000000f3", "factura_no_es_pdf").await.unwrap();
        assert!(repo.sin_subir(10).await.unwrap().is_empty());
        assert!(repo.estado("00000000-0000-7000-8000-0000000000f3").await.unwrap().unwrap().apartado);

        // Si el PDF local desaparece, se vuelve a documentar.
        repo.olvidar_local("00000000-0000-7000-8000-0000000000f1").await.unwrap();
        assert_eq!(repo.sin_pdf_local(10_000, 10).await.unwrap()[0].id_registro, "00000000-0000-7000-8000-0000000000f1");
    }

    #[tokio::test]
    async fn anotar_el_local_de_una_que_no_tenia_fila_la_crea() {
        // La pantalla puede pedir el PDF antes de que el job la haya apuntado.
        let (db, _dir) = con_facturas().await;
        let repo = SqliteFacturasPdf::new(db);
        repo.anotar_local("00000000-0000-7000-8000-0000000000f1", "facturas/00000000-0000-7000-8000-0000000000f1.pdf", OrigenPdf::Bajado, 1).await.unwrap();
        repo.anotar_subido("00000000-0000-7000-8000-0000000000f1", 2).await.unwrap();
        assert_eq!(repo.apuntar_nuevas().await.unwrap(), 1);
        let e = repo.estado("00000000-0000-7000-8000-0000000000f1").await.unwrap().unwrap();
        assert_eq!((e.origen, e.subido_ms), (Some(OrigenPdf::Bajado), Some(2)));
    }

    #[tokio::test]
    async fn las_anotaciones_no_van_al_outbox() {
        let (db, _dir) = con_facturas().await;
        let repo = SqliteFacturasPdf::new(db.clone());
        repo.apuntar_nuevas().await.unwrap();
        repo.anotar_local("00000000-0000-7000-8000-0000000000f1", "facturas/00000000-0000-7000-8000-0000000000f1.pdf", OrigenPdf::Generado, 1).await.unwrap();
        repo.anotar_subido("00000000-0000-7000-8000-0000000000f1", 2).await.unwrap();

        let r = db.read().await;
        let mut rows = r.conn().query("SELECT COUNT(*) FROM _Sync_Outbox;", ()).await.unwrap();
        let n = v_i64(rows.next().await.unwrap().unwrap().get_value(0).unwrap()).unwrap();
        assert_eq!(n, 0);
    }

    /// Cada minuto se buscan las facturas nuevas: por el índice parcial, sin recorrer los tickets.
    #[tokio::test]
    async fn buscar_las_nuevas_no_recorre_los_tickets() {
        let (db, dir) = db_temporal().await;
        let conn = crate::ejecutor::abrir(dir.join("data.db")).unwrap();
        let mut stmt = conn.prepare(&format!("EXPLAIN QUERY PLAN {SQL_APUNTAR_NUEVAS}")).unwrap();
        let mut filas = stmt.raw_query();
        let mut plan = Vec::new();
        while let Some(fila) = filas.next().unwrap() {
            if let Value::Text(t) = fila.get::<_, Value>(3).unwrap() {
                plan.push(t);
            }
        }
        drop(filas);
        drop(stmt);
        drop(conn);
        drop(db);
        assert!(
            plan.iter().any(|l| l.contains("idx_regfact_completas")),
            "debe entrar por el índice de las facturas completas: {plan:#?}"
        );
        assert!(
            !plan.iter().any(|l| l == "SCAN r"),
            "no puede recorrer los registros de facturación: {plan:#?}"
        );
    }
}
