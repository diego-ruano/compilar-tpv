//! Dominio de pedidos a proveedores: entidades puras y validaciones.
//!
//! Lo que aquí se acepta o se rechaza es lo mismo que en el worker (`pedidos_proveedor.schemas.ts`),
//! con los mismos textos: lo fija `validacion_casos.json`.

use crate::dinero::Dinero;

use crate::texto::limpiar_opcional as limpia;

/// Lo más que lleva un pedido: lo que admite el correo que se le manda al proveedor
/// (`/v1/email/enviar-pedido`). Un pedido más largo no se podría mandar, y con este tope la página
/// de pedidos tiene su techo (`TECHO_LINEAS_PAGINA`).
pub const MAX_LINEAS: usize = 500;

/// Cuántas líneas lleva como mucho una página de pedidos, sumadas las de todos sus pedidos. La página
/// se corta antes del pedido que lo pasaría (siempre lleva al menos uno), y el siguiente sale en la
/// página de después: el techo va en la respuesta, no en cada pedido. El mismo número en el worker.
pub const TECHO_LINEAS_PAGINA: i64 = 2000;

pub const MSG_FALTA_EL_PEDIDO: &str = "Falta el pedido.";
pub const MSG_DEMASIADAS_LINEAS: &str = "Un pedido no puede llevar más de 500 líneas.";
pub const MSG_NOMBRE_DEL_PRODUCTO: &str = "Escribe el nombre del producto.";
pub const MSG_CANTIDAD_NEGATIVA: &str = "La cantidad no puede ser negativa.";
pub const MSG_PRECIO_NEGATIVO: &str = "El precio no puede ser negativo.";
pub const MSG_ESTADO_DEL_PEDIDO: &str = "Un pedido sólo se puede enviar o cancelar.";
/// Se edita un pedido que ya no es un borrador (otro equipo lo ha enviado o cancelado). El mismo
/// texto en el worker (`pedido_no_editable`).
pub const MSG_PEDIDO_NO_EDITABLE: &str =
    "Ese pedido ya se ha enviado o cancelado y no se puede cambiar. Cierra el formulario.";

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
            return Err(MSG_NOMBRE_DEL_PRODUCTO.into());
        }
        if !cantidad.is_finite() || cantidad < 0.0 {
            return Err(MSG_CANTIDAD_NEGATIVA.into());
        }
        if let Some(p) = precio_unitario {
            if p.es_negativo() {
                return Err(MSG_PRECIO_NEGATIVO.into());
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

/// Las líneas de un pedido, tal como llegan: cuántas son y, en su orden, cada una (la primera que no
/// vale dice por qué).
pub fn validar_lineas(lineas: Vec<LineaPedidoNueva>) -> Result<Vec<LineaPedidoNueva>, String> {
    if lineas.len() > MAX_LINEAS {
        return Err(MSG_DEMASIADAS_LINEAS.into());
    }
    lineas
        .into_iter()
        .map(|l| LineaPedidoNueva::validar(l.id_linea, l.nombre_producto, l.cantidad, l.precio_unitario, l.unidad))
        .collect()
}

#[derive(Debug, Clone)]
pub struct PedidoProveedorNuevo {
    pub id_pedido: String,
    pub id_proveedor: Option<String>,
    pub email_destino: Option<String>,
    pub notas: Option<String>,
}

impl PedidoProveedorNuevo {
    /// La cabecera de un pedido, al crearlo y al editarlo.
    pub fn validar(
        id_pedido: String,
        id_proveedor: Option<String>,
        email_destino: Option<String>,
        notas: Option<String>,
    ) -> Result<Self, String> {
        let id = id_pedido.trim().to_string();
        if id.is_empty() {
            return Err(MSG_FALTA_EL_PEDIDO.into());
        }
        Ok(Self {
            id_pedido: id,
            id_proveedor: limpia(id_proveedor),
            email_destino: limpia(email_destino),
            notas: limpia(notas),
        })
    }
}

/// El estado al que pasa un pedido: un borrador sólo se envía o se cancela. Se admite recortado, y
/// en minúsculas, como lo guarda la base.
pub fn estado_nuevo(estado: &str) -> Result<&'static str, String> {
    match estado.trim() {
        "enviado" => Ok("enviado"),
        "cancelado" => Ok("cancelado"),
        _ => Err(MSG_ESTADO_DEL_PEDIDO.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn linea(nombre: &str, cantidad: f64) -> LineaPedidoNueva {
        LineaPedidoNueva { id_linea: "l".into(), nombre_producto: nombre.into(), cantidad, precio_unitario: None, unidad: None }
    }

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
        let precio_negativo = Dinero::de_centimos(-1);
        assert!(
            LineaPedidoNueva::validar("l".into(), "x".into(), 1.0, Some(precio_negativo), None)
                .is_err()
        );
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

    #[test]
    fn las_lineas_tienen_su_tope_y_la_primera_que_no_vale_dice_por_que() {
        assert_eq!(validar_lineas(vec![linea("x", 1.0); MAX_LINEAS]).unwrap().len(), MAX_LINEAS);
        assert_eq!(validar_lineas(vec![linea("x", 1.0); MAX_LINEAS + 1]).unwrap_err(), MSG_DEMASIADAS_LINEAS);
        assert_eq!(
            validar_lineas(vec![linea("x", -1.0), linea(" ", 1.0)]).unwrap_err(),
            MSG_CANTIDAD_NEGATIVA
        );
    }

    #[test]
    fn un_borrador_solo_se_envia_o_se_cancela() {
        assert_eq!(estado_nuevo(" enviado "), Ok("enviado"));
        assert_eq!(estado_nuevo("cancelado"), Ok("cancelado"));
        for malo in ["ENVIADO", "borrador", "", "pendiente"] {
            assert_eq!(estado_nuevo(malo), Err(MSG_ESTADO_DEL_PEDIDO.to_string()), "{malo}");
        }
    }
}
