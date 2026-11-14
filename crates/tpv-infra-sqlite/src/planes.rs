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
    use crate::ejecutor::Value;

    use crate::contract_comun::db_temporal;

    /// Lo único que se puede recorrer: una fila constante, el índice parcial de las comandas
    /// abiertas (son pocas por definición) y las categorías (un puñado, no crecen con el uso).
    const SCAN_PERMITIDO: &[&str] = &[
        "SCAN CONSTANT ROW",
        "SCAN c USING INDEX idx_comandas_una_abierta_por_mesa",
        "SCAN cat",
    ];

    async fn plan(sql: &str) -> Vec<String> {
        // `Db` deja la base con el esquema; el plan se pide por una conexión nativa aparte para no
        // tener que enlazar los parámetros: EXPLAIN no ejecuta la sentencia, y sin enlazar valen NULL.
        let (db, dir) = db_temporal().await;
        let conn = crate::ejecutor::abrir(dir.join("data.db")).unwrap();
        let mut stmt = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
        let mut filas = stmt.raw_query();
        let mut out = Vec::new();
        while let Some(fila) = filas.next().unwrap() {
            if let Value::Text(t) = fila.get::<_, Value>(3).unwrap() {
                out.push(t);
            }
        }
        drop(filas);
        drop(stmt);
        drop(conn);
        drop(db);
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
                (l.starts_with("SCAN ") && !SCAN_PERMITIDO.contains(&l.as_str()))
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
    async fn el_tablero_de_cocina_solo_lee_las_comandas_recientes() {
        sin_recorridos("kitchen_list_today_pending", crate::mesas::SQL_COCINA_PENDIENTE).await;
        let p = plan(crate::mesas::SQL_COCINA_PENDIENTE).await;
        assert!(
            p.iter().any(|l| l.contains("idx_comandas_apertura")),
            "la cocina debe entrar por idx_comandas_apertura: {p:#?}"
        );
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
        let p = plan(crate::tickets::SQL_FACTURA).await;
        assert!(
            p.iter().any(|l| l.contains("idx_regfact_numserie")),
            "la factura de un ticket debe ir por idx_regfact_numserie, no recorrer por Orden: {p:#?}"
        );
    }

    #[tokio::test]
    async fn anotar_un_movimiento_de_caja_no_recorre_el_historial() {
        sin_recorridos("caja_movimientos::registrar", crate::caja_movimientos::SQL_REGISTRAR).await;
    }

    /// La estadística de productos lee los días cerrados del resumen diario y, de los cobros, sólo
    /// los de hoy y los de los días que sigan sucios, cada uno con sus líneas: lo que tarda no crece
    /// con el histórico. Recorre el catálogo (a propósito: el peor producto es el que no ha vendido
    /// nada) y sus propios resultados intermedios.
    #[tokio::test]
    async fn la_estadistica_de_productos_solo_lee_los_cobros_del_rango() {
        let sql = crate::stats::sql_productos(tpv_contracts::stats::StatsRange::Anio);
        let p = plan(&sql).await;

        for (tabla, entrada) in [
            ("_Estad_Producto_Dia", "SEARCH e USING INDEX idx_estad_producto_dia (Dia>? AND Dia<?)"),
            ("_Estad_Dias_Sucios", "SEARCH s USING PRIMARY KEY (Dia>? AND Dia<?)"),
            ("Pagos", "SEARCH p USING INDEX idx_pagos_estado_fecha (Estado=? AND Fecha_Hora>? AND Fecha_Hora<?)"),
            ("Pago_Detalles", "SEARCH pd USING COVERING INDEX sqlite_autoindex_Pago_Detalles_1 (ID_Pago=?)"),
            ("Detalle_Comanda", "SEARCH dc USING INDEX sqlite_autoindex_Detalle_Comanda_1 (ID_Detalle=?)"),
        ] {
            assert!(p.iter().any(|l| l == entrada), "{tabla} debe entrar por «{entrada}»: {p:#?}");
        }
        let recorridos: Vec<&String> = p
            .iter()
            .filter(|l| ["SCAN p", "SCAN pd", "SCAN dc"].iter().any(|t| *l == t || l.starts_with(&format!("{t} "))))
            .collect();
        assert!(recorridos.is_empty(), "recorre el histórico en {recorridos:?}\nplan completo: {p:#?}");
        // A los cobros se entra dos veces, las dos por su fecha: por los días que sigan sucios y por
        // lo de hoy (`paid_det`, que se calcula una vez).
        assert_eq!(p.iter().filter(|l| l.starts_with("SEARCH p ")).count(), 2, "{p:#?}");
        assert!(!p.iter().any(|l| l.ends_with("(Estado=?)")), "{p:#?}");
    }

    /// La estadística de mesas, igual: los días cerrados del resumen diario y, de los cobros, sólo
    /// los de hoy, los de los días que sigan sucios y los posteriores a ahora, siempre por su fecha.
    /// Un acceso a los cobros sólo por su estado los recorrería todos: SQLite lo elegía para los días
    /// sucios hasta que la sentencia compartida fijó el orden con `CROSS JOIN` (revisión con Codex).
    #[tokio::test]
    async fn la_estadistica_de_mesas_solo_lee_los_cobros_del_rango() {
        use tpv_contracts::stats::StatsRange;
        for range in [StatsRange::Semana, StatsRange::Anio] {
            let p = plan(&crate::stats::sql_mesas_ingresos(range)).await;
            for entrada in [
                "SEARCH e USING PRIMARY KEY (Dia>? AND Dia<?)",
                "SEARCH s USING PRIMARY KEY (Dia>? AND Dia<?)",
                "SEARCH p USING INDEX idx_pagos_estado_fecha (Estado=? AND Fecha_Hora>? AND Fecha_Hora<?)",
                "SEARCH p USING INDEX idx_pagos_fecha (Fecha_Hora>? AND Fecha_Hora<?)",
            ] {
                assert!(p.iter().any(|l| l == entrada), "{range:?}: falta «{entrada}»: {p:#?}");
            }
            assert!(!p.iter().any(|l| l.ends_with("(Estado=?)")), "{range:?}: {p:#?}");
            let recorridos: Vec<&String> = p
                .iter()
                .filter(|l| ["SCAN p", "SCAN c", "SCAN e"].iter().any(|t| *l == t || l.starts_with(&format!("{t} "))))
                .collect();
            assert!(recorridos.is_empty(), "{range:?}: recorre el histórico en {recorridos:?}\n{p:#?}");
        }
    }

    /// Saber quién es recurrente obliga a mirar los cobros de toda la historia, pero una vez: `allp`
    /// la leen tres CTE y, sin materializar, SQLite recorría los cobros (`p`) y sus comandas (`c`)
    /// en cada una.
    #[tokio::test]
    async fn los_clientes_recurrentes_leen_los_cobros_una_sola_vez() {
        let sql = crate::stats::sql_clientes_recurrentes(tpv_contracts::stats::StatsRange::Hoy);
        let p = plan(&sql).await;

        let lecturas_de = |alias: &str| {
            p.iter()
                .filter(|l| {
                    [format!("SCAN {alias}"), format!("SEARCH {alias}")]
                        .iter()
                        .any(|t| *l == t || l.starts_with(&format!("{t} ")))
                })
                .count()
        };
        assert!(p.iter().any(|l| l == "MATERIALIZE allp"), "{p:#?}");
        assert_eq!(lecturas_de("p"), 1, "los cobros se leen una vez: {p:#?}");
        assert_eq!(lecturas_de("c"), 1, "las comandas se leen una vez: {p:#?}");
        assert_eq!(lecturas_de("allp"), 3, "{p:#?}");
    }
}
