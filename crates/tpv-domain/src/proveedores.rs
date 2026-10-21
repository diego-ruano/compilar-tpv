//! Dominio de **proveedores**: entidades y validaciones puras.

use crate::texto::limpiar_opcional as limpia;

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

/// Datos crudos con campos nombrados (RI-48); validar produce el objeto de dominio.
#[derive(Debug, Clone)]
pub struct ProveedorEntrada {
    pub id_proveedor: Option<String>,
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
    pub fn validar(input: ProveedorEntrada) -> Result<Self, String> {
        let ProveedorEntrada {
            id_proveedor,
            nombre_empresa,
            contacto,
            telefono,
            email,
            cif,
            informacion_adicional,
            nombre_imagen,
            ruta_imagen,
        } = input;
        let nombre = nombre_empresa.trim().to_string();
        if nombre.is_empty() {
            return Err("Escribe el nombre del proveedor.".into());
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
pub use crate::texto::normalizar_ids as normalizar_producto_ids;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proveedor_exige_nombre_y_limpia_campos() {
        assert!(ProveedorValidado::validar(crate::proveedores::ProveedorEntrada {
            id_proveedor: None,
            nombre_empresa: " ".into(),
            contacto: None,
            telefono: None,
            email: None,
            cif: None,
            informacion_adicional: None,
            nombre_imagen: None,
            ruta_imagen: None,
        }).is_err());
        let p = ProveedorValidado::validar(crate::proveedores::ProveedorEntrada {
            id_proveedor: Some(" pr1 ".into()),
            nombre_empresa: " Mercado ".into(),
            contacto: Some(" Ana ".into()),
            telefono: Some(" ".into()),
            email: Some(" a@b.es ".into()),
            cif: None,
            informacion_adicional: None,
            nombre_imagen: None,
            ruta_imagen: None,
        }).unwrap();
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
