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
    CobroDeLaFactura, EstadoPdfFactura, FacturaCompleta, FacturasDeClienteRepository,
    FacturasPdfRepository, OrigenPdf,
};
use tpv_application::use_cases::facturas_pdf::ESPERA_MAXIMA_MS;
use tpv_domain::dinero::Dinero;
use tpv_domain::verifactu::normalizar_nif;

use crate::db::{Db, Reader};
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

/// Al restaurar una copia, lo que dice del PDF local de cada factura es del equipo que la hizo: esta
/// carpeta puede no tenerlo (una `data.db` traída de otro equipo). Se olvida, con sus fallos, y el
/// job las vuelve a documentar. `Subido_Ms` se conserva: dice que la nube lo tiene, y entonces se
/// baja de ella antes de mirar la carpeta (`use_cases::facturas_pdf`).
pub(crate) async fn olvidar_los_pdf_locales(db: &Db) -> AppResult<()> {
    let w = db.write().await;
    w.raw()
        .execute(
            "UPDATE _Facturas_Pdf SET Ruta = NULL, Origen = NULL, Generado_Ms = NULL, Intentos = 0, \
               Ultimo_Error = NULL, Proximo_Intento_Ms = NULL, Apartado = 0;",
            Vec::<Value>::new(),
        )
        .await
        .map_err(db_err)?;
    Ok(())
}

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

/// Las facturas completas de un NIF, para la ficha del cliente. Como la búsqueda de las nuevas, va
/// por `idx_regfact_completas` (lo vigila un test del plan) y deja fuera las subsanaciones, que
/// repiten una factura. El NIF del destinatario se normaliza como `normalizar_nif` (sin guiones ni
/// espacios y en mayúsculas); un JSON que no se pueda leer no casa con nada en vez de hacer fallar
/// la lista.
///
/// Cada una dice si está anulada: si hay un registro de anulación de su `IDFactura` (emisor, número
/// y fecha) posterior a ella. La baja de un cobro por error la anula (`emitir_baja_de_pago`), y la
/// ficha no puede enseñarla como vigente. Se mira por `idx_regfact_numserie`.
pub(crate) const SQL_FACTURAS_DEL_NIF: &str = "\
    SELECT r.ID_Registro, r.Num_Serie_Factura, r.Fecha_Expedicion, COALESCE(r.Tipo_Factura, ''), \
           COALESCE(r.Importe_Total, ''), r.ID_Pago, r.Referencias_Json, \
           EXISTS (SELECT 1 FROM Registros_Facturacion a \
                   WHERE a.Num_Serie_Factura = r.Num_Serie_Factura AND a.Tipo = 'ANULACION' \
                     AND a.Orden > r.Orden AND a.NIF_Emisor = r.NIF_Emisor \
                     AND a.Fecha_Expedicion = r.Fecha_Expedicion) \
    FROM Registros_Facturacion r INDEXED BY idx_regfact_completas \
    WHERE r.Tipo = 'ALTA' AND r.Destinatario_Json IS NOT NULL \
      AND (r.Subsanacion IS NULL OR r.Subsanacion <> 'S') \
      AND upper(replace(replace(trim(CASE WHEN json_valid(r.Destinatario_Json) \
            THEN json_extract(r.Destinatario_Json, '$.NIF') END), '-', ''), ' ', '')) = ?1 \
    ORDER BY r.Orden DESC LIMIT ?2;";

/// Las rectificativas por sustitución (`R1`–`R4` con `Tipo_Rectificativa = 'S'`), para saber qué
/// facturas de la ficha ya no son las vigentes: la que una de ellas pone en `rectificadas` está
/// sustituida, el mismo criterio que `verifactu::cadena_de_sustitutivas`. Hoy sólo las emite la
/// corrección de los datos del cliente (`verifactu::corregir_factura`), siempre con destinatario,
/// así que van por `idx_regfact_completas` sin recorrer los tickets (lo vigila un test del plan).
/// En orden de emisión: si dos la sustituyeran, cuenta la última, como en la cadena.
pub(crate) const SQL_SUSTITUTIVAS: &str = "\
    SELECT r.Num_Serie_Factura, r.Referencias_Json \
    FROM Registros_Facturacion r INDEXED BY idx_regfact_completas \
    WHERE r.Tipo = 'ALTA' AND r.Destinatario_Json IS NOT NULL \
      AND r.Tipo_Factura IN ('R1', 'R2', 'R3', 'R4') AND r.Tipo_Rectificativa = 'S' \
    ORDER BY r.Orden ASC;";

/// Qué factura sustituye a cada una: número sustituido → número de la sustitutiva.
async fn sustituciones<R: Reader>(r: &R) -> AppResult<std::collections::HashMap<String, String>> {
    let mut rows = r.query(SQL_SUSTITUTIVAS, Vec::<Value>::new()).await.map_err(db_err)?;
    let mut por = std::collections::HashMap::new();
    while let Some(row) = rows.next().await.map_err(db_err)? {
        let num = v_string(row.get_value(0).map_err(db_err)?).unwrap_or_default();
        let refs = v_string(row.get_value(1).map_err(db_err)?);
        for sustituida in crate::verifactu::numeros_rectificados(refs.as_deref()) {
            por.insert(sustituida.trim().to_string(), num.trim().to_string());
        }
    }
    Ok(por)
}

/// El cobro en pie de un número de ticket.
const SQL_PAGO_ACTIVO_DE_TICKET: &str = "SELECT ID_Pago FROM Pagos \
     WHERE Numero_Ticket = ?1 AND Estado = 'ACTIVO' ORDER BY Fecha_Hora ASC LIMIT 1;";

/// El cobro con el que se imprime una factura: el suyo; y una `F3` de varios tickets, que no
/// cuelga de ningún cobro, se imprime desde cualquiera de los que canjea (`tickets.rs`): el primero
/// que siga en pie. Desde el de un ticket dado de baja el papel saldría marcado ANULADO, y la `F3`
/// sigue vigente por los demás (`emitir_baja_de_pago` sólo emite la negativa de ese ticket). Si
/// todos están dados de baja, el primero que se encuentre.
async fn pago_de_la_factura<R: Reader>(
    r: &R,
    id_pago: Option<String>,
    referencias: Option<&str>,
) -> AppResult<Option<String>> {
    if let Some(p) = id_pago.filter(|s| !s.trim().is_empty()) {
        return Ok(Some(p));
    }
    let tickets = crate::verifactu::numeros_sustituidos(referencias);
    for num in &tickets {
        let mut rows = r
            .query(SQL_PAGO_ACTIVO_DE_TICKET, vec![Value::Text(num.trim().to_string())])
            .await
            .map_err(db_err)?;
        if let Some(row) = rows.next().await.map_err(db_err)? {
            if let Some(p) = v_string(row.get_value(0).map_err(db_err)?) {
                return Ok(Some(p));
            }
        }
    }
    for num in &tickets {
        if let Some(p) = crate::tickets::pago_de_ticket(r, num).await? {
            return Ok(Some(p));
        }
    }
    Ok(None)
}

#[async_trait]
impl FacturasDeClienteRepository for SqliteFacturasPdf {
    async fn facturas_del_nif(&self, nif: &str, limite: i64) -> AppResult<Vec<FacturaCompleta>> {
        let r = self.db.read().await;
        let mut rows = r
            .conn()
            .query(
                SQL_FACTURAS_DEL_NIF,
                vec![Value::Text(normalizar_nif(nif)), Value::Integer(limite)],
            )
            .await
            .map_err(db_err)?;
        let mut filas = Vec::new();
        while let Some(row) = rows.next().await.map_err(db_err)? {
            let t = |i: i32| -> AppResult<Option<String>> { Ok(v_string(row.get_value(i).map_err(db_err)?)) };
            filas.push((
                FacturaCompleta {
                    id_registro: t(0)?.unwrap_or_default(),
                    num_serie: t(1)?.unwrap_or_default(),
                    fecha_expedicion: t(2)?.unwrap_or_default(),
                    tipo_factura: t(3)?.unwrap_or_default(),
                    // El importe del registro es texto fiscal (`123.10`): se lee sin recalcular.
                    importe: Dinero::de_texto_fiscal(&t(4)?.unwrap_or_default()).unwrap_or(Dinero::CERO),
                    id_pago: None,
                    anulada: v_i64(row.get_value(7).map_err(db_err)?).unwrap_or(0) != 0,
                    sustituida_por: None,
                },
                t(5)?,
                t(6)?,
            ));
        }
        drop(rows);

        let sustituidas = if filas.is_empty() { Default::default() } else { sustituciones(&r).await? };
        let mut out = Vec::with_capacity(filas.len());
        for (mut f, id_pago, referencias) in filas {
            f.id_pago = pago_de_la_factura(&r, id_pago, referencias.as_deref()).await?;
            f.sustituida_por = sustituidas.get(f.num_serie.trim()).cloned();
            out.push(f);
        }
        Ok(out)
    }
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
                   AND (f.Proximo_Intento_Ms IS NULL OR f.Proximo_Intento_Ms <= ?1 \
                        OR f.Proximo_Intento_Ms > ?1 + ?3) \
                 ORDER BY r.Orden DESC LIMIT ?2;"
            ),
            // Una espera más larga que la mayor posible se anotó con la hora adelantada y el
            // equipo se ha puesto en hora después (RELOJ-01): no se espera el desfase entero.
            vec![Value::Integer(ahora_ms), Value::Integer(limite), Value::Integer(ESPERA_MAXIMA_MS)],
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

    async fn es_factura_completa(&self, id_registro: &str) -> AppResult<bool> {
        let r = self.db.read().await;
        let mut rows = r
            .conn()
            .query(
                "SELECT 1 FROM Registros_Facturacion \
                 WHERE ID_Registro = ?1 AND Tipo = 'ALTA' AND Destinatario_Json IS NOT NULL \
                   AND (Subsanacion IS NULL OR Subsanacion <> 'S') LIMIT 1;",
                vec![Value::Text(id_registro.to_string())],
            )
            .await
            .map_err(db_err)?;
        Ok(rows.next().await.map_err(db_err)?.is_some())
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

        let id_pago = pago_de_la_factura(&r, id_pago, referencias.as_deref()).await?;
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
               Subido_Ms = CASE WHEN excluded.Origen = 'generado' THEN NULL ELSE Subido_Ms END, \
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

    async fn aplazar(&self, id_registro: &str, proximo_intento_ms: i64) -> AppResult<()> {
        self.escribir(
            "UPDATE _Facturas_Pdf SET Proximo_Intento_Ms = ?2 WHERE ID_Registro = ?1;",
            vec![Value::Text(id_registro.to_string()), Value::Integer(proximo_intento_ms)],
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

    /// Una F3 cuyos tickets aún no tienen su cobro en la base sigue siendo una factura completa:
    /// su PDF se puede dar desde la carpeta o desde la nube.
    #[tokio::test]
    async fn una_factura_completa_lo_es_aunque_no_este_su_cobro() {
        let (db, _dir) = con_facturas().await;
        let sin_cobro = registro(
            "00000000-0000-7000-8000-0000000000f4",
            4,
            "F-000003",
            "F3",
            CLIENTE,
            r#"'{"rectificadas":[],"sustituidas":[{"IDEmisorFactura":"B12345674","NumSerieFactura":"T-000099","FechaExpedicionFactura":"02-01-2026"}]}'"#,
            "NULL",
        );
        let sub = registro("00000000-0000-7000-8000-00000000005b", 5, "F-000001", "F1", CLIENTE, "NULL", "'p1'")
            .replace("ID_Pago)", "ID_Pago, Subsanacion)")
            .replace("'p1');", "'p1', 'S');");
        sembrar(&db, &[&sin_cobro, &sub]).await;
        let repo = SqliteFacturasPdf::new(db);

        assert!(repo.es_factura_completa("00000000-0000-7000-8000-0000000000f4").await.unwrap());
        assert_eq!(repo.cobro_de_la_factura("00000000-0000-7000-8000-0000000000f4").await.unwrap(), None);
        assert!(repo.es_factura_completa("00000000-0000-7000-8000-0000000000f1").await.unwrap());
        // Un ticket, una subsanación o lo que no existe no lo son.
        assert!(!repo.es_factura_completa("00000000-0000-7000-8000-00000000000a").await.unwrap());
        assert!(!repo.es_factura_completa("00000000-0000-7000-8000-00000000005b").await.unwrap());
        assert!(!repo.es_factura_completa("no-existe").await.unwrap());
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

    /// Uno compuesto aquí vuelve a la subida aunque la nube lo tuviera: al subirlo, si tenía otro (el
    /// que se emitió), se cambia el de aquí por el suyo. Uno bajado de ella no.
    #[tokio::test]
    async fn un_pdf_compuesto_aqui_vuelve_a_la_subida_y_uno_bajado_no() {
        let (db, _dir) = con_facturas().await;
        let repo = SqliteFacturasPdf::new(db);
        let id = "00000000-0000-7000-8000-0000000000f1";
        let ruta = "facturas/00000000-0000-7000-8000-0000000000f1.pdf";
        repo.apuntar_nuevas().await.unwrap();
        repo.anotar_local(id, ruta, OrigenPdf::Bajado, 1).await.unwrap();
        repo.anotar_subido(id, 2).await.unwrap();

        repo.anotar_local(id, ruta, OrigenPdf::Bajado, 3).await.unwrap();
        assert_eq!(repo.estado(id).await.unwrap().unwrap().subido_ms, Some(2));
        assert!(repo.sin_subir(10).await.unwrap().is_empty());

        repo.anotar_local(id, ruta, OrigenPdf::Generado, 4).await.unwrap();
        assert_eq!(repo.estado(id).await.unwrap().unwrap().subido_ms, None);
        assert_eq!(repo.sin_subir(10).await.unwrap()[0].id_registro, id);
    }

    /// Esperar a que acabe el histórico no es un fallo de la factura: no cuenta como intento.
    #[tokio::test]
    async fn aplazar_saca_la_factura_de_la_lista_sin_contar_un_intento() {
        let (db, _dir) = con_facturas().await;
        let repo = SqliteFacturasPdf::new(db);
        let id = "00000000-0000-7000-8000-0000000000f1";
        repo.apuntar_nuevas().await.unwrap();
        repo.aplazar(id, 5_000).await.unwrap();
        let e = repo.estado(id).await.unwrap().unwrap();
        assert_eq!((e.intentos, e.ultimo_error, e.proximo_intento_ms), (0, None, Some(5_000)));
        assert_eq!(repo.sin_pdf_local(4_999, 10).await.unwrap().len(), 1);
        assert_eq!(repo.sin_pdf_local(5_000, 10).await.unwrap().len(), 2);
    }

    /// Un fallo (o un aplazamiento) anotado con el equipo un día adelantado: tras ponerlo en hora,
    /// la factura no espera el día entero.
    #[tokio::test]
    async fn si_se_atrasa_la_hora_una_factura_no_espera_el_desfase() {
        const DIA: i64 = 24 * 60 * 60 * 1000;
        let (db, _dir) = con_facturas().await;
        let repo = SqliteFacturasPdf::new(db);
        repo.apuntar_nuevas().await.unwrap();
        let ahora = 1_000_000_000_000;
        repo.anotar_fallo("00000000-0000-7000-8000-0000000000f1", "no se pudo", ahora + DIA + 60_000).await.unwrap();
        repo.aplazar("00000000-0000-7000-8000-0000000000f3", ahora + DIA + ESPERA_MAXIMA_MS).await.unwrap();
        assert_eq!(repo.sin_pdf_local(ahora, 10).await.unwrap().len(), 2);
        // Una espera que cabe sigue esperando.
        repo.aplazar("00000000-0000-7000-8000-0000000000f3", ahora + ESPERA_MAXIMA_MS).await.unwrap();
        let ids: Vec<_> = repo.sin_pdf_local(ahora, 10).await.unwrap().into_iter().map(|e| e.id_registro).collect();
        assert_eq!(ids, ["00000000-0000-7000-8000-0000000000f1"]);
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

    #[tokio::test]
    async fn las_facturas_de_un_nif_son_las_suyas_de_la_mas_reciente_a_la_mas_antigua() {
        let (db, _dir) = con_facturas().await;
        let otro = r#"'{"NombreRazon":"Otra SL","NIF":"A58818501"}'"#;
        // Guardado con guion y en minúsculas: casa igual.
        let con_guion = r#"'{"NombreRazon":"Cliente SL","NIF":"b-87654321","Domicilio":"Calle 1"}'"#;
        let sub = registro("00000000-0000-7000-8000-00000000005b", 6, "F-000001", "F1", CLIENTE, "NULL", "'p1'")
            .replace("ID_Pago)", "ID_Pago, Subsanacion)")
            .replace("'p1');", "'p1', 'S');");
        sembrar(
            &db,
            &[
                &registro("00000000-0000-7000-8000-0000000000a1", 4, "F-000003", "F1", otro, "NULL", "'p1'"),
                &registro("00000000-0000-7000-8000-0000000000a2", 5, "R-000001", "R1", con_guion, "NULL", "'p1'")
                    .replace("'5.10'", "'-5.10'"),
                &sub,
                // Un destinatario que no es JSON no casa, y no hace fallar la lista.
                &registro("00000000-0000-7000-8000-0000000000a3", 7, "F-000004", "F1", "'no es json'", "NULL", "'p1'"),
            ],
        )
        .await;
        let repo = SqliteFacturasPdf::new(db);

        let facturas = repo.facturas_del_nif("b87654321", 10).await.unwrap();
        let resumen: Vec<_> = facturas
            .iter()
            .map(|f| (f.num_serie.as_str(), f.tipo_factura.as_str(), f.importe.centimos(), f.id_pago.as_deref()))
            .collect();
        assert_eq!(
            resumen,
            [
                ("R-000001", "R1", -510, Some("p1")),
                // La F3 de varios tickets se reimprime desde el primero que está en la base.
                ("F-000002", "F3", 510, Some("p10")),
                ("F-000001", "F1", 510, Some("p1")),
            ]
        );
        assert_eq!(facturas[2].fecha_expedicion, "02-01-2026");
        assert_eq!(facturas[2].id_registro, "00000000-0000-7000-8000-0000000000f1");

        assert_eq!(repo.facturas_del_nif("B87654321", 2).await.unwrap().len(), 2);
        assert!(repo.facturas_del_nif("B11111111", 10).await.unwrap().is_empty());
    }

    /// La baja de un cobro por error anula su factura: la ficha la recibe dicha, no como vigente.
    #[tokio::test]
    async fn una_factura_anulada_llega_marcada_como_anulada() {
        let (db, _dir) = con_facturas().await;
        let anulacion = |id: &str, orden: i64, num: &str, fecha: &str| {
            registro(id, orden, num, "F1", "NULL", "NULL", "'p1'")
                .replace("'ALTA'", "'ANULACION'")
                .replace("'02-01-2026'", &format!("'{fecha}'"))
        };
        sembrar(
            &db,
            &[
                // La de F-000001: la anula.
                &anulacion("00000000-0000-7000-8000-0000000000b1", 8, "F-000001", "02-01-2026"),
                // La de otra factura con el mismo número pero otra fecha: no es la suya.
                &anulacion("00000000-0000-7000-8000-0000000000b2", 9, "F-000002", "03-01-2026"),
            ],
        )
        .await;
        let repo = SqliteFacturasPdf::new(db);

        let facturas = repo.facturas_del_nif("B87654321", 10).await.unwrap();
        let resumen: Vec<_> = facturas.iter().map(|f| (f.num_serie.as_str(), f.anulada)).collect();
        assert_eq!(resumen, [("F-000002", false), ("F-000001", true)]);
    }

    /// Una `R4` por sustitución que reemplaza a `rectifica`, como la emite la corrección de los
    /// datos del cliente: mismos importes, el destinatario nuevo.
    fn sustitutiva(id: &str, orden: i64, num: &str, destinatario: &str, rectifica: &str) -> String {
        let refs = format!(
            r#"'{{"rectificadas":[{{"IDEmisorFactura":"B12345674","NumSerieFactura":"{rectifica}","FechaExpedicionFactura":"02-01-2026"}}],"sustituidas":[]}}'"#
        );
        registro(id, orden, num, "R4", destinatario, &refs, "'p1'")
            .replace("ID_Pago)", "ID_Pago, Tipo_Rectificativa)")
            .replace("'p1');", "'p1', 'S');")
    }

    /// Corregir el cliente de una F1 emite una R4 que la sustituye: la ficha no puede enseñar las
    /// dos como vigentes (parecerían el doble de lo facturado).
    #[tokio::test]
    async fn una_factura_sustituida_llega_con_la_que_la_sustituye() {
        let (db, _dir) = con_facturas().await;
        let corregido = r#"'{"NombreRazon":"Cliente Corregido SL","NIF":"B87654321","Domicilio":"Calle 2"}'"#;
        sembrar(
            &db,
            &[
                &sustitutiva("00000000-0000-7000-8000-0000000000c1", 8, "R-000001", corregido, "F-000001"),
                // Una por diferencias (`I`) rectifica pero no sustituye: la F3 sigue siendo la suya.
                &sustitutiva("00000000-0000-7000-8000-0000000000c2", 9, "R-000002", corregido, "F-000002")
                    .replace("'p1', 'S');", "'p1', 'I');"),
            ],
        )
        .await;
        let repo = SqliteFacturasPdf::new(db);

        let facturas = repo.facturas_del_nif("B87654321", 10).await.unwrap();
        let resumen: Vec<_> =
            facturas.iter().map(|f| (f.num_serie.as_str(), f.sustituida_por.as_deref())).collect();
        assert_eq!(
            resumen,
            [("R-000002", None), ("R-000001", None), ("F-000002", None), ("F-000001", Some("R-000001"))]
        );
    }

    /// Si la corrección cambia el NIF, la ficha del NIF antiguo se queda con la F1: tiene que
    /// decir que ya no vale.
    #[tokio::test]
    async fn una_factura_sustituida_a_otro_nif_tambien_lo_dice() {
        let (db, _dir) = con_facturas().await;
        let otro = r#"'{"NombreRazon":"Otra SL","NIF":"A58818501"}'"#;
        sembrar(&db, &[&sustitutiva("00000000-0000-7000-8000-0000000000c1", 8, "R-000001", otro, "F-000001")]).await;
        let repo = SqliteFacturasPdf::new(db);

        let antiguo: Vec<_> = repo
            .facturas_del_nif("B87654321", 10)
            .await
            .unwrap()
            .into_iter()
            .map(|f| (f.num_serie, f.sustituida_por))
            .collect();
        assert_eq!(
            antiguo,
            [("F-000002".to_string(), None), ("F-000001".to_string(), Some("R-000001".to_string()))]
        );
        let nuevo = repo.facturas_del_nif("A58818501", 10).await.unwrap();
        assert_eq!((nuevo.len(), nuevo[0].sustituida_por.as_deref()), (1, None));
    }

    /// Una F3 de varios tickets se reimprime desde un cobro que siga en pie: desde el de un ticket
    /// dado de baja, el papel saldría marcado ANULADO aunque la factura sigue vigente.
    #[tokio::test]
    async fn una_f3_de_varios_tickets_se_reimprime_desde_un_cobro_activo() {
        let (db, _dir) = con_facturas().await;
        sembrar(
            &db,
            &[
                "INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre) \
                 VALUES ('u1', '00000000-0000-7000-8000-000000000001', 'jefe@bar.example', 'x', 'Marta');",
                // T-000009, el primero que canjea, se dio de baja después.
                "INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo, \
                   Numero_Ticket, Estado, Anulado_En, Anulado_Por, Motivo_Anulacion, Motivo_Baja) \
                 VALUES ('p9', 'com', '2026-01-02 12:35:00', 'Efectivo', 200, 'TOTAL', 'T-000009', \
                   'ANULADO', '2026-01-03 10:00:00', 'u1', 'error', 'ERROR');",
            ],
        )
        .await;
        let repo = SqliteFacturasPdf::new(db.clone());

        assert_eq!(
            repo.cobro_de_la_factura("00000000-0000-7000-8000-0000000000f3").await.unwrap(),
            Some(CobroDeLaFactura { id_pago: "p10".into(), num_serie: "F-000002".into() })
        );
        let f3 = repo
            .facturas_del_nif("B87654321", 10)
            .await
            .unwrap()
            .into_iter()
            .find(|f| f.num_serie == "F-000002")
            .unwrap();
        assert_eq!(f3.id_pago.as_deref(), Some("p10"));

        // Si todos están dados de baja, cualquiera: la factura sigue teniendo papel.
        sembrar(
            &db,
            &["UPDATE Pagos SET Estado = 'ANULADO', Anulado_En = '2026-01-03 10:00:00', Anulado_Por = 'u1' \
               WHERE ID_Pago = 'p10';"],
        )
        .await;
        assert_eq!(
            repo.cobro_de_la_factura("00000000-0000-7000-8000-0000000000f3").await.unwrap(),
            Some(CobroDeLaFactura { id_pago: "p9".into(), num_serie: "F-000002".into() })
        );
    }

    /// Las sustitutivas se buscan por el índice parcial, sin recorrer los tickets.
    #[tokio::test]
    async fn las_sustitutivas_no_recorren_los_tickets() {
        let plan = plan_de(SQL_SUSTITUTIVAS).await;
        assert!(plan.iter().any(|l| l.contains("idx_regfact_completas")), "{plan:#?}");
        assert!(!plan.iter().any(|l| l == "SCAN r"), "{plan:#?}");
    }

    /// El plan de una consulta, renglón a renglón.
    async fn plan_de(sql: &str) -> Vec<String> {
        let (db, dir) = db_temporal().await;
        let conn = crate::ejecutor::abrir(dir.join("data.db")).unwrap();
        let mut stmt = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
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
        plan
    }

    /// La ficha del cliente busca sus facturas por el índice parcial, sin recorrer los tickets.
    #[tokio::test]
    async fn las_facturas_de_un_nif_no_recorren_los_tickets() {
        let plan = plan_de(SQL_FACTURAS_DEL_NIF).await;
        assert!(plan.iter().any(|l| l.contains("idx_regfact_completas")), "{plan:#?}");
        assert!(!plan.iter().any(|l| l == "SCAN r"), "{plan:#?}");
        // Si está anulada se mira por el índice del número, sin recorrer los registros.
        assert!(plan.iter().any(|l| l.contains("idx_regfact_numserie")), "{plan:#?}");
        assert!(!plan.iter().any(|l| l == "SCAN a"), "{plan:#?}");
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
