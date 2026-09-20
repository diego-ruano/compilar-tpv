//! Dominio de pedidos a proveedores: entidades puras y validaciones.

use crate::dinero::Dinero;

fn limpia(o: Option<String>) -> Option<String> {
    o.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

#[derive(Debug, Clone)]
pub struct LineaPedidoNueva {
    pub id_linea: String,
    pub nombre_producto: String,
    pub cantidad: f64,
    pub precio_unitario: Option<Dinero>,
    pub unidad: Option<String>,
}

impl LineaPedidoNueva {
    pub fn validar(
        id_linea: String,
        nombre_producto: String,
        cantidad: f64,
        precio_unitario: Option<Dinero>,
        unidad: Option<String>,
    ) -> Result<Self, String> {
        let nombre = nombre_producto.trim().to_string();
        if nombre.is_empty() {
            return Err("nombre_producto required".into());
        }
        if !cantidad.is_finite() || cantidad < 0.0 {
            return Err("cantidad inválida".into());
        }
        if let Some(p) = precio_unitario {
            if p.es_negativo() {
                return Err("precio_unitario inválido".into());
            }
        }
        Ok(Self {
            id_linea: id_linea.trim().to_string(),
            nombre_producto: nombre,
            cantidad,
            precio_unitario,
            unidad: limpia(unidad),
        })
    }
}

#[derive(Debug, Clone)]
pub struct PedidoProveedorNuevo {
    pub id_pedido: String,
    pub id_proveedor: Option<String>,
    pub email_destino: Option<String>,
    pub notas: Option<String>,
}

impl PedidoProveedorNuevo {
    pub fn validar(
        id_pedido: String,
        id_proveedor: Option<String>,
        email_destino: Option<String>,
        notas: Option<String>,
    ) -> Result<Self, String> {
        let id = id_pedido.trim().to_string();
        if id.is_empty() {
            return Err("id_pedido required".into());
        }
        Ok(Self {
            id_pedido: id,
            id_proveedor: limpia(id_proveedor),
            email_destino: limpia(email_destino),
            notas: limpia(notas),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linea_valida_normaliza_textos_y_permite_cero() {
        let l = LineaPedidoNueva::validar(" l1 ".into(), " Tomate ".into(), 0.0, Some(Dinero::CERO), Some(" kg ".into())).unwrap();
        assert_eq!(l.id_linea, "l1");
        assert_eq!(l.nombre_producto, "Tomate");
        assert_eq!(l.cantidad, 0.0);
        assert_eq!(l.precio_unitario, Some(Dinero::CERO));
        assert_eq!(l.unidad.as_deref(), Some("kg"));
    }

    #[test]
    fn linea_rechaza_nombre_cantidad_y_precio_invalidos() {
        assert!(LineaPedidoNueva::validar("l".into(), " ".into(), 1.0, None, None).is_err());
        for cantidad in [-1.0, f64::NAN, f64::INFINITY] {
            assert!(LineaPedidoNueva::validar("l".into(), "x".into(), cantidad, None, None).is_err());
        }
        for precio in [Dinero::de_centimos(-1)] {
            assert!(LineaPedidoNueva::validar("l".into(), "x".into(), 1.0, Some(precio), None).is_err());
        }
    }

    #[test]
    fn pedido_exige_id_y_limpia_opcionales() {
        assert!(PedidoProveedorNuevo::validar(" ".into(), None, None, None).is_err());
        let p = PedidoProveedorNuevo::validar(" p1 ".into(), Some(" prov1 ".into()), Some(" ".into()), Some(" urgente ".into())).unwrap();
        assert_eq!(p.id_pedido, "p1");
        assert_eq!(p.id_proveedor.as_deref(), Some("prov1"));
        assert!(p.email_destino.is_none());
        assert_eq!(p.notas.as_deref(), Some("urgente"));
    }
}
