//! Metadatos de un cambio remoto: el SQL y los argumentos nunca cruzan al frontend.
use std::{collections::BTreeSet, sync::OnceLock};
use regex::Regex;
use serde_json::Value;
use tpv_contracts::sync::{CambioReplicado, ComandaReplicada, SqlStatement};

pub fn aviso(sentencias: &[SqlStatement]) -> CambioReplicado {
    static TABLA: OnceLock<Regex> = OnceLock::new();
    static COMANDA: OnceLock<Regex> = OnceLock::new();
    static INSERT: OnceLock<Regex> = OnceLock::new();
    let tabla = TABLA.get_or_init(|| Regex::new(r#"(?i)^\s*(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM)\s+[\"`\[]?(\w+)"#).unwrap());
    let comanda = COMANDA.get_or_init(|| Regex::new(r"(?i)ID_Comanda\s*=\s*\?(\d+)").unwrap());
    let insert = INSERT.get_or_init(|| Regex::new(r"(?i)INSERT\s+(?:OR\s+\w+\s+)?INTO\s+\w+\s*\(([^)]*)\)").unwrap());
    let mut tablas = BTreeSet::new(); let mut ids = BTreeSet::new();
    let mut conocida = true; let mut tocada = false; let mut catalogo = false; let mut incierta = false;
    for s in sentencias {
        let Some(t) = tabla.captures(&s.sql).map(|c| c[1].to_ascii_lowercase()) else { conocida = false; tocada = true; catalogo = true; incierta = true; continue; };
        catalogo |= ["categorias_producto","productos","lotes_producto","lote_consumos","alergenos","producto_alergenos"].contains(&t.as_str());
        if ["comandas","detalle_comanda","pagos","pago_detalles"].contains(&t.as_str()) {
            tocada = true; let mut encontrado = false;
            for c in comanda.captures_iter(&s.sql) {
                if let Ok(i) = c[1].parse::<usize>() {
                    if let Some(v) = i.checked_sub(1).and_then(|i| s.args.get(i)).and_then(Value::as_str).filter(|s| !s.is_empty()) { ids.insert(v.to_string()); encontrado = true; }
                }
            }
            if let Some(c) = insert.captures(&s.sql) {
                let posicion = c[1].split(',').position(|s| s.trim().eq_ignore_ascii_case("ID_Comanda"));
                if let Some(v) = posicion.and_then(|i| s.args.get(i)).and_then(Value::as_str).filter(|s| !s.is_empty()) { ids.insert(v.to_string()); encontrado = true; }
            }
            incierta |= !encontrado;
        }
        tablas.insert(t);
    }
    CambioReplicado { tablas: conocida.then(|| tablas.into_iter().collect()), comanda: ComandaReplicada { ids:ids.into_iter().collect(), touched_comanda:tocada, uncertain:incierta, touched_catalog:catalogo } }
}

/// DO-SUBIDA · El aviso de que la Main ha subido una tabla entera a la nube (`datos_subidos`): esas
/// tablas, sin comandas concretas (todas las abiertas pueden haber cambiado). Sin tablas, todo.
pub fn aviso_de_tablas(nombres: &[String]) -> CambioReplicado {
    let tablas: BTreeSet<String> = nombres.iter().map(|t| t.to_ascii_lowercase()).filter(|t| t.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')).collect();
    let toda = tablas.is_empty();
    let comandas = toda || tablas.iter().any(|t| ["comandas","detalle_comanda","pagos","pago_detalles"].contains(&t.as_str()));
    let catalogo = toda || tablas.iter().any(|t| ["categorias_producto","productos","lotes_producto","lote_consumos","alergenos","producto_alergenos"].contains(&t.as_str()));
    CambioReplicado {
        tablas: (!toda).then(|| tablas.into_iter().collect()),
        comanda: ComandaReplicada { ids: Vec::new(), touched_comanda: comandas, uncertain: comandas, touched_catalog: catalogo },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn el_aviso_de_una_tabla_subida_relee_esa_tabla_y_sus_comandas_sin_elegir_ninguna() {
        let v = aviso_de_tablas(&["Detalle_Comanda".into()]);
        assert_eq!(v.tablas, Some(vec!["detalle_comanda".into()]));
        assert!(v.comanda.touched_comanda && v.comanda.uncertain && v.comanda.ids.is_empty());
        let v = aviso_de_tablas(&["Zonas".into()]);
        assert!(!v.comanda.touched_comanda && !v.comanda.touched_catalog);
        assert_eq!(aviso_de_tablas(&[]).tablas, None, "sin tablas, se relee todo");
    }
    #[test]
    fn el_aviso_no_expone_sql_y_conserva_la_seleccion_del_ticket() {
        let v = aviso(&[SqlStatement { sql:"UPDATE Detalle_Comanda SET Cantidad=?1 WHERE ID_Comanda=?2".into(), args:vec![json!(2),json!("comanda-1")] }]);
        assert_eq!(v.comanda.ids, vec!["comanda-1"]);
        assert!(!v.comanda.uncertain);
        let texto = serde_json::to_string(&v).unwrap();
        assert!(!texto.contains("UPDATE")); assert!(!texto.contains("Cantidad"));
    }
    #[test]
    fn una_forma_desconocida_refresca_por_seguridad() {
        let v = aviso(&[SqlStatement { sql:"WITH x AS (SELECT 1) UPDATE Productos SET Nombre='x'".into(), args:vec![] }]);
        assert!(v.tablas.is_none()); assert!(v.comanda.uncertain);
    }
    #[test]
    fn el_insert_identifica_la_comanda_y_el_lote_deduplica_ids() {
        let v = aviso(&[
            SqlStatement { sql: "INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda) VALUES (?1, ?2)".into(), args: vec![json!("d1"), json!("c1")] },
            SqlStatement { sql: "DELETE FROM Detalle_Comanda WHERE ID_Comanda=?1".into(), args: vec![json!("c1")] },
        ]);
        assert_eq!(v.comanda.ids, vec!["c1"]); assert!(!v.comanda.uncertain);
    }
    #[test]
    fn borrar_por_detalle_refresca_por_seguridad_y_el_catalogo_no_toca_tickets() {
        let v = aviso(&[SqlStatement { sql: "DELETE FROM Detalle_Comanda WHERE ID_Detalle=?1".into(), args: vec![json!("d1")] }]);
        assert!(v.comanda.uncertain); assert!(v.comanda.touched_comanda);
        let v = aviso(&[SqlStatement { sql: "UPDATE Lotes_Producto SET Stock_Disponible=5".into(), args: vec![] }]);
        assert!(v.comanda.touched_catalog); assert!(!v.comanda.touched_comanda);
    }
}
