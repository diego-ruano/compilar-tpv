//! Lo que teclea el usuario en un buscador se compara **sin acentos y sin distinguir mayúsculas**:
//! «café» encuentra «CAFÉ Solo» y «CAÑA» encuentra «Caña».
//!
//! La comparación es `instr(<columna normalizada>, <texto normalizado>) > 0`. La columna la
//! normaliza SQLite, con la expresión que fabrica `tpv-infra-sqlite/src/busqueda.rs` a partir de
//! estas tablas, y el texto lo normaliza [`normalizar`] antes de pasarlo como parámetro. Las dos
//! cosas tienen que decir lo mismo: por eso aquí sólo baja a minúscula lo que baja `lower()` de
//! SQLite (las letras ASCII) y se pliega lo que pliega la expresión, ni una letra más. Un
//! `to_lowercase()` de Rust bajaría también la «Ø», que en la columna se quedaría como está, y esa
//! búsqueda dejaría de encontrar lo que tiene delante.
//!
//! La función no se registra en SQLite porque el SQLite del Durable Object no admite funciones
//! propias: la expresión es SQL corriente (`lower` y `replace` anidados), y la misma en la Main y en
//! el worker (`apps/cloud-worker-licensing/src/lib/busqueda.ts`), así que los dos devuelven las
//! mismas filas. Una columna ya normalizada al escribir ahorraría la cuenta en cada búsqueda, pero
//! los listados de caja buscan en un texto que se compone al leer (la mesa, el cliente, el método y
//! el importe de cada cobro), y esa columna habría que mantenerla en cada tabla que aporta un trozo.
//!
//! Los casos, compartidos con el worker y con la pantalla, están en `busqueda_casos.json`.

/// Cada letra base con las que se le pliegan. Las mayúsculas van en la lista porque `lower()` de
/// SQLite sólo baja las letras ASCII: «Á» seguiría siendo «Á».
pub const PLIEGUES: &[(char, &str)] = &[
    ('a', "áàâäãÁÀÂÄÃ"),
    ('e', "éèêëÉÈÊË"),
    ('i', "íìîïÍÌÎÏ"),
    ('o', "óòôöõÓÒÔÖÕ"),
    ('u', "úùûüÚÙÛÜ"),
    ('n', "ñÑ"),
    ('c', "çÇ"),
];

/// Las marcas combinantes de esos acentos, que se quitan: un texto puede llegar descompuesto (una
/// «e» y un acento agudo suelto detrás), como lo escriben algunos teclados o lo pega un macOS.
pub const SE_QUITAN: &[char] = &['\u{300}', '\u{301}', '\u{302}', '\u{303}', '\u{308}', '\u{327}'];

/// El texto con el que se busca, como queda la columna en SQL: las letras ASCII en minúscula, las
/// de [`PLIEGUES`] en su letra base y sin las marcas de [`SE_QUITAN`]. Lo demás, tal cual.
pub fn normalizar(texto: &str) -> String {
    let mut out = String::with_capacity(texto.len());
    for c in texto.chars() {
        if c.is_ascii_uppercase() {
            out.push(c.to_ascii_lowercase());
        } else if SE_QUITAN.contains(&c) {
            continue;
        } else if let Some((base, _)) = PLIEGUES.iter().find(|(_, de)| de.contains(c)) {
            out.push(*base);
        } else {
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn casos() -> serde_json::Value {
        serde_json::from_str(include_str!("busqueda_casos.json")).expect("busqueda_casos.json no es JSON")
    }

    #[test]
    fn las_tablas_son_las_de_los_casos_compartidos() {
        let casos = casos();
        let pliegues: std::collections::BTreeMap<String, String> =
            serde_json::from_value(casos["pliegues"].clone()).unwrap();
        let aqui: std::collections::BTreeMap<String, String> =
            PLIEGUES.iter().map(|(base, de)| (base.to_string(), de.to_string())).collect();
        assert_eq!(aqui, pliegues);
        let se_quitan: Vec<String> = serde_json::from_value(casos["se_quitan"].clone()).unwrap();
        assert_eq!(SE_QUITAN.iter().map(|c| c.to_string()).collect::<Vec<_>>(), se_quitan);
    }

    #[test]
    fn normaliza_como_dicen_los_casos_compartidos() {
        for caso in casos()["normalizar"].as_array().unwrap() {
            let texto = caso["texto"].as_str().unwrap();
            assert_eq!(normalizar(texto), caso["queda"].as_str().unwrap(), "{texto:?}");
        }
    }

    #[test]
    fn encuentra_lo_que_dicen_los_casos_compartidos() {
        for caso in casos()["buscar"].as_array().unwrap() {
            let (nombre, busca) = (caso["nombre"].as_str().unwrap(), caso["busca"].as_str().unwrap());
            let encuentra = normalizar(nombre).contains(&normalizar(busca));
            assert_eq!(encuentra, caso["encuentra"].as_bool().unwrap(), "{nombre:?} con {busca:?}");
        }
    }

    #[test]
    fn normalizar_dos_veces_es_normalizar_una() {
        for caso in casos()["normalizar"].as_array().unwrap() {
            let una = normalizar(caso["texto"].as_str().unwrap());
            assert_eq!(normalizar(&una), una);
        }
    }
}
