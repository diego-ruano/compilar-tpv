//! Dominio de pedidos a proveedores: entidades puras y validaciones.

fn limpia(o: Option<String>) -> Option<String> {
    o.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

#[derive(Debug, Clone)]
pub struct LineaPedidoNueva {
    pub id_linea: String,
    pub nombre_producto: String,
    pub cantidad: f64,
    pub precio_unitario: Option<f64>,
    pub unidad: Option<String>,
}

impl LineaPedidoNueva {
    pub fn validar(
        id_linea: String,
        nombre_producto: String,
        cantidad: f64,
        precio_unitario: Option<f64>,
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
            if !p.is_finite() || p < 0.0 {
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
