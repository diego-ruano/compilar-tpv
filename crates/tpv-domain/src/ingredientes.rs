//! Dominio de **ingredientes**: qué lleva cada producto y lo que se pide distinto en una línea.
//!
//! Sin cantidades, sin stock y sin precio: un ingrediente sólo dice qué lleva un producto, para
//! poder pedirlo «sin cebolla» o «con extra de queso». Se agrupan por categorías (Pan, Salsas…).
//! Lo que se pide distinto en una línea se guarda en `Detalle_Comanda.Cambios_Ingredientes` como
//! un array JSON con el nombre que tenía el ingrediente al pedirlo (ver `0003_ingredientes.sql`).
//!
//! El worker valida y escribe lo mismo (`domains/ingredientes`), con los mismos textos; lo fija la
//! tabla `validacion_casos.json`.

use serde::{Deserialize, Serialize};

use crate::texto::requerido;

pub const MSG_NOMBRE_CATEGORIA: &str = "Escribe el nombre de la categoría de ingredientes.";
pub const MSG_NOMBRE_INGREDIENTE: &str = "Escribe el nombre del ingrediente.";
pub const MSG_CATEGORIA_DEL_INGREDIENTE: &str = "Elige la categoría del ingrediente.";
pub const MSG_FALTA_INGREDIENTE: &str = "Falta el ingrediente.";
pub const MSG_TIPO_DE_CAMBIO: &str = "Cada ingrediente cambiado va «sin» o «extra».";
pub const MSG_DEMASIADOS_CAMBIOS: &str = "Son demasiados ingredientes cambiados para una línea.";

/// Cuántos cambios admite una línea. Ninguna comanda de verdad se acerca; el tope sólo impide que
/// una petición rara llene la fila.
pub const MAX_CAMBIOS_POR_LINEA: usize = 100;

/// Categoría de ingredientes a crear o renombrar.
#[derive(Debug, Clone)]
pub struct CategoriaIngredienteGuardar {
    pub id: Option<String>,
    pub nombre: String,
}

impl CategoriaIngredienteGuardar {
    pub fn validar(id: Option<String>, nombre: &str) -> Result<Self, String> {
        Ok(Self {
            id: crate::texto::limpiar_opcional(id),
            nombre: requerido(nombre, MSG_NOMBRE_CATEGORIA)?,
        })
    }
}

/// Ingrediente a crear, renombrar o cambiar de categoría.
#[derive(Debug, Clone)]
pub struct IngredienteGuardar {
    pub id: Option<String>,
    pub id_categoria: String,
    pub nombre: String,
}

impl IngredienteGuardar {
    pub fn validar(id: Option<String>, id_categoria: &str, nombre: &str) -> Result<Self, String> {
        let nombre = requerido(nombre, MSG_NOMBRE_INGREDIENTE)?;
        let id_categoria = requerido(id_categoria, MSG_CATEGORIA_DEL_INGREDIENTE)?;
        Ok(Self { id: crate::texto::limpiar_opcional(id), id_categoria, nombre })
    }
}

/// «Sin» quita un ingrediente que el producto lleva; «extra» añade uno o pide más de él.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TipoCambio {
    #[serde(rename = "SIN")]
    Sin,
    #[serde(rename = "EXTRA")]
    Extra,
}

impl TipoCambio {
    pub fn desde(texto: &str) -> Result<Self, String> {
        match texto.trim() {
            "SIN" => Ok(Self::Sin),
            "EXTRA" => Ok(Self::Extra),
            _ => Err(MSG_TIPO_DE_CAMBIO.into()),
        }
    }
}

/// Un cambio tal como queda guardado en la línea. El orden de los campos es el del JSON: el worker
/// lo escribe con las mismas claves en el mismo orden (`JSON.stringify`), y así las dos bases
/// guardan el mismo texto.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CambioIngrediente {
    pub id: String,
    pub nombre: String,
    pub tipo: TipoCambio,
}

/// Valida lo que se pidió distinto en una línea.
///
/// Cada cambio necesita su ingrediente, su nombre y un tipo válido. Un ingrediente repetido cuenta
/// una vez: se queda el primero. El orden es el de la entrada, el que vio quien lo marcó. Vacío, la
/// línea va como el producto.
pub fn cambios_de_linea(
    cambios: impl IntoIterator<Item = (String, String, String)>,
) -> Result<Vec<CambioIngrediente>, String> {
    let mut out: Vec<CambioIngrediente> = Vec::new();
    for (id, nombre, tipo) in cambios {
        let id = requerido(&id, MSG_FALTA_INGREDIENTE)?;
        let nombre = requerido(&nombre, MSG_NOMBRE_INGREDIENTE)?;
        let tipo = TipoCambio::desde(&tipo)?;
        if out.iter().any(|c| c.id == id) {
            continue;
        }
        out.push(CambioIngrediente { id, nombre, tipo });
    }
    if out.len() > MAX_CAMBIOS_POR_LINEA {
        return Err(MSG_DEMASIADOS_CAMBIOS.into());
    }
    Ok(out)
}

/// La forma guardada en `Detalle_Comanda.Cambios_Ingredientes`: el JSON, o `None` si no hay
/// cambios. El worker escribe el mismo texto (`cambiosIngredientesSchema`).
pub fn forma_guardada(cambios: &[CambioIngrediente]) -> Option<String> {
    if cambios.is_empty() {
        return None;
    }
    // Una lista de textos y un enum: serializarla no puede fallar.
    serde_json::to_string(cambios).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(id: &str, nombre: &str, tipo: &str) -> (String, String, String) {
        (id.into(), nombre.into(), tipo.into())
    }

    #[test]
    fn sin_cambios_la_linea_queda_como_el_producto() {
        assert_eq!(cambios_de_linea(Vec::new()).map(|v| forma_guardada(&v)), Ok(None));
    }

    #[test]
    fn los_cambios_quedan_en_json_en_el_orden_marcado() {
        let r = cambios_de_linea(vec![c(" i2 ", " Cebolla ", "SIN"), c("i1", "Queso", "EXTRA")]).map(|v| forma_guardada(&v));
        assert_eq!(
            r,
            Ok(Some(
                r#"[{"id":"i2","nombre":"Cebolla","tipo":"SIN"},{"id":"i1","nombre":"Queso","tipo":"EXTRA"}]"#
                    .into()
            ))
        );
    }

    #[test]
    fn un_ingrediente_repetido_cuenta_una_vez() {
        let r = forma_guardada(&cambios_de_linea(vec![c("i1", "Queso", "EXTRA"), c("i1", "Queso", "SIN")]).unwrap());
        assert_eq!(r.as_deref(), Some(r#"[{"id":"i1","nombre":"Queso","tipo":"EXTRA"}]"#));
    }

    #[test]
    fn un_tipo_desconocido_se_rechaza() {
        assert_eq!(cambios_de_linea(vec![c("i1", "Queso", "MUCHO")]), Err(MSG_TIPO_DE_CAMBIO.into()));
    }
}
