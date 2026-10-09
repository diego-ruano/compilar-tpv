//! Dominio de **proveedores**: entidades y validaciones puras.

fn limpia(o: Option<String>) -> Option<String> {
    o.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Proveedor validado listo para upsert. `id = None` indica un alta nueva: la
/// persistencia genera un UUIDv7 antes del INSERT; con id, hace upsert por esa clave.
#[derive(Debug, Clone)]
pub struct ProveedorValidado {
    pub id: Option<String>,
    pub nombre_empresa: String,
    pub contacto: Option<String>,
    pub telefono: Option<String>,
    pub email: Option<String>,
    pub cif: Option<String>,
    pub informacion_adicional: Option<String>,
    pub nombre_imagen: Option<String>,
    pub ruta_imagen: Option<String>,
}

impl ProveedorValidado {
    #[allow(clippy::too_many_arguments)]
    pub fn validar(
        id_proveedor: Option<String>,
        nombre_empresa: String,
        contacto: Option<String>,
        telefono: Option<String>,
        email: Option<String>,
        cif: Option<String>,
        informacion_adicional: Option<String>,
        nombre_imagen: Option<String>,
        ruta_imagen: Option<String>,
    ) -> Result<Self, String> {
        let nombre = nombre_empresa.trim().to_string();
        if nombre.is_empty() {
            return Err("nombre_empresa required".into());
        }
        Ok(ProveedorValidado {
            id: id_proveedor.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
            nombre_empresa: nombre,
            contacto: limpia(contacto),
            telefono: limpia(telefono),
            email: limpia(email),
            cif: limpia(cif),
            informacion_adicional: limpia(informacion_adicional),
            nombre_imagen: limpia(nombre_imagen),
            ruta_imagen: limpia(ruta_imagen),
        })
    }
}

/// Normaliza una lista de IDs de producto: descarta vacíos, ordena y deduplica.
pub fn normalizar_producto_ids(ids: Vec<String>) -> Vec<String> {
    let mut v: Vec<String> = ids
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    v.sort_unstable();
    v.dedup();
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proveedor_exige_nombre_y_limpia_campos() {
        assert!(ProveedorValidado::validar(None, " ".into(), None, None, None, None, None, None, None).is_err());
        let p = ProveedorValidado::validar(Some(" pr1 ".into()), " Mercado ".into(), Some(" Ana ".into()), Some(" ".into()), Some(" a@b.es ".into()), None, None, None, None).unwrap();
        assert_eq!(p.id.as_deref(), Some("pr1"));
        assert_eq!(p.nombre_empresa, "Mercado");
        assert_eq!(p.contacto.as_deref(), Some("Ana"));
        assert!(p.telefono.is_none());
        assert_eq!(p.email.as_deref(), Some("a@b.es"));
    }

    #[test]
    fn ids_se_ordenan_deduplican_y_limpian() {
        assert_eq!(normalizar_producto_ids(vec![" b ".into(), "a".into(), "b".into(), " ".into()]), vec!["a", "b"]);
    }
}
