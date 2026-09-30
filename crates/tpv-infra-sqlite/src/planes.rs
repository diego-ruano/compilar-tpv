//! Los planes de las consultas calientes (RI-02, RI-03, RI-04, RI-18).
//!
//! Estas consultas corren en cada apertura de mesa, cada refresco del plano o de cocina y cada cobro,
//! y crecen con el histórico: un plan que recorre una tabla va bien el primer mes y tarda segundos
//! al año. Ningún test de resultados lo ve —el resultado es el mismo—, así que se vigila el plan.
//!
//! Se mira **sin estadísticas** (`ANALYZE`) a propósito: así corren en Turso las lecturas de la Handy
//! y las sentencias replicadas. Un plan que sólo es bueno con estadísticas es malo justo allí.

#[cfg(test)]
mod tests {
    use libsql::Value;

    use crate::contract_comun::db_temporal;
    use crate::db::Reader;

    /// Lo único que se puede recorrer: una fila constante, el índice parcial de las comandas
    /// abiertas (son pocas por definición) y las categorías (un puñado, no crecen con el uso).
    const SCAN_PERMITIDO: &[&str] = &[
        "SCAN CONSTANT ROW",
        "SCAN c USING INDEX idx_comandas_una_abierta_por_mesa",
        "SCAN cat",
    ];

    async fn plan(sql: &str) -> Vec<String> {
        let (db, _dir) = db_temporal().await;
        let r = db.read().await;
        let mut rows = r
            .query(&format!("EXPLAIN QUERY PLAN {sql}"), Vec::<Value>::new())
            .await
            .unwrap();
        let mut out = Vec::new();
        while let Some(row) = rows.next().await.unwrap() {
            if let Value::Text(t) = row.get_value(3).unwrap() {
                out.push(t);
            }
        }
        out
    }

    /// Falla si el plan recorre algo que crece con el histórico. Dos formas de hacerlo:
    /// un `SCAN` (salvo lo permitido), o entrar a `Pagos` por su `Estado`, que casi todos los cobros
    /// comparten: es un `SEARCH` en el nombre y un recorrido de todos los cobros en la práctica.
    async fn sin_recorridos(nombre: &str, sql: &str) {
        let p = plan(sql).await;
        let malos: Vec<&String> = p
            .iter()
            .filter(|l| {
                (l.starts_with("SCAN ") && !SCAN_PERMITIDO.iter().any(|ok| l.as_str() == *ok))
                    || l.contains("MATERIALIZE")
                    || l.contains("(Estado=?)")
            })
            .collect();
        assert!(
            malos.is_empty(),
            "{nombre}: el plan recorre el histórico en {malos:?}\nplan completo: {p:#?}"
        );
    }

    #[tokio::test]
    async fn las_lineas_de_una_comanda_no_recorren_los_cobros() {
        sin_recorridos("get_lineas_comanda", crate::mesas::SQL_LINEAS_COMANDA).await;
    }

    #[tokio::test]
    async fn el_plano_de_mesas_no_materializa_las_lineas_cobradas() {
        sin_recorridos("mesas_meta_all", crate::mesas::SQL_MESAS_META_ALL).await;
    }

    #[tokio::test]
    async fn reservar_numero_no_recorre_los_registros_fiscales() {
        sin_recorridos("reservar_numero", crate::verifactu::SQL_MAX_NUMERO_EMITIDO).await;
        let p = plan(crate::verifactu::SQL_MAX_NUMERO_EMITIDO).await;
        assert!(
            p.iter().any(|l| l.contains("idx_regfact_serie_numero")),
            "reservar_numero debe ir por idx_regfact_serie_numero: {p:#?}"
        );
    }

    #[tokio::test]
    async fn reimprimir_un_ticket_antiguo_no_recorre_los_registros_fiscales() {
        let p = plan(crate::verifactu::SQL_BLOQUE_POR_NUMERO).await;
        assert!(
            p.iter().any(|l| l.contains("idx_regfact_numserie")),
            "bloque_por_numero debe ir por idx_regfact_numserie, no recorrer por Orden: {p:#?}"
        );
    }

    #[tokio::test]
    async fn anotar_un_movimiento_de_caja_no_recorre_el_historial() {
        sin_recorridos("caja_movimientos::registrar", crate::caja_movimientos::SQL_REGISTRAR).await;
    }
}
