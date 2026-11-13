//! La búsqueda de texto sin acentos ni mayúsculas, en SQL. La regla y sus tablas están en
//! `tpv_domain::busqueda`; aquí se fabrica la expresión que normaliza una columna igual que
//! `tpv_domain::busqueda::normalizar` normaliza el texto que se busca.
//!
//! Se compara con `instr(<columna normalizada>, ?) > 0`, nunca con `LIKE`: el SQLite del Durable
//! Object no admite un patrón de `LIKE` de más de 50 bytes y en un patrón el `%` y el `_` que
//! teclea el usuario son comodines. El worker fabrica la misma expresión, en el mismo orden
//! (`apps/cloud-worker-licensing/src/lib/busqueda.ts`), así que los dos lados devuelven las mismas
//! filas.

use tpv_domain::busqueda::{PLIEGUES, SE_QUITAN};

/// `expr` (una columna o una concatenación de columnas) como queda para buscar en ella: `lower()`,
/// que baja las letras ASCII, y un `replace()` por cada letra de [`PLIEGUES`] y cada marca de
/// [`SE_QUITAN`]. Las marcas van como `char(n)`: sueltas dentro de un literal no se verían.
pub(crate) fn normalizada(expr: &str) -> String {
    let mut sql = format!("lower({expr})");
    for (base, de) in PLIEGUES {
        for letra in de.chars() {
            sql = format!("replace({sql},'{letra}','{base}')");
        }
    }
    for marca in SE_QUITAN {
        sql = format!("replace({sql},char({}),'')", u32::from(*marca));
    }
    sql
}

/// El texto que se busca, recortado y normalizado. `None` si no queda nada: entonces no se filtra
/// (o no se busca), igual que con un buscador vacío. Un texto hecho sólo de acentos sueltos no
/// encuentra todo por quedarse vacío.
pub(crate) fn texto_a_buscar(texto: &str) -> Option<String> {
    Some(tpv_domain::busqueda::normalizar(texto.trim())).filter(|t| !t.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract_comun::db_temporal;
    use crate::ejecutor::Value;
    use crate::mapping::v_string;

    fn casos() -> serde_json::Value {
        serde_json::from_str(include_str!("../../tpv-domain/src/busqueda_casos.json")).unwrap()
    }

    /// SQLite, con la expresión de verdad, deja cada texto como `normalizar`.
    #[tokio::test]
    async fn la_expresion_sql_normaliza_como_el_codigo() {
        let (db, _dir) = db_temporal().await;
        let r = db.read().await;
        for caso in casos()["normalizar"].as_array().unwrap() {
            let texto = caso["texto"].as_str().unwrap();
            let mut filas = r
                .conn()
                .query(&format!("SELECT {};", normalizada("?1")), vec![Value::Text(texto.into())])
                .await
                .unwrap();
            let fila = filas.next().await.unwrap().unwrap();
            let en_sql = v_string(fila.get_value(0).unwrap()).unwrap_or_default();
            assert_eq!(en_sql, caso["queda"].as_str().unwrap(), "{texto:?}");
            assert_eq!(en_sql, tpv_domain::busqueda::normalizar(texto), "{texto:?}");
        }
    }

    /// Y la comparación entera, columna contra texto, encuentra lo que dicen los casos.
    #[tokio::test]
    async fn instr_sobre_la_columna_normalizada_encuentra_lo_de_los_casos() {
        let (db, _dir) = db_temporal().await;
        let r = db.read().await;
        for caso in casos()["buscar"].as_array().unwrap() {
            let (nombre, busca) = (caso["nombre"].as_str().unwrap(), caso["busca"].as_str().unwrap());
            let sql = format!("SELECT instr({}, ?2) > 0;", normalizada("?1"));
            let mut filas = r
                .conn()
                .query(&sql, vec![Value::Text(nombre.into()), Value::Text(texto_a_buscar(busca).unwrap())])
                .await
                .unwrap();
            let fila = filas.next().await.unwrap().unwrap();
            let encuentra = matches!(fila.get_value(0).unwrap(), Value::Integer(1));
            assert_eq!(encuentra, caso["encuentra"].as_bool().unwrap(), "{nombre:?} con {busca:?}");
        }
    }

    #[test]
    fn un_texto_vacio_o_de_acentos_sueltos_no_es_una_busqueda() {
        assert_eq!(texto_a_buscar("  "), None);
        assert_eq!(texto_a_buscar("\u{301}\u{303}"), None);
        assert_eq!(texto_a_buscar("  Café "), Some("cafe".into()));
    }
}
