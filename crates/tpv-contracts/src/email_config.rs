//! Contratos (DTOs) de la frontera UI<->Rust para el envío de pedidos por correo.
//!
//! Ya NO hay configuración SMTP (DB-04): todo el correo se envía por el worker, así que aquí solo
//! viven los DTOs de la petición de envío.

use tpv_domain::dinero::Dinero;

use serde::Deserialize;
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct LineaEmailInput {
    pub nombre_producto: String,
    pub cantidad: f64,
    #[serde(default)]
    pub precio_unitario: Option<Dinero>,
    #[serde(default)]
    pub unidad: Option<String>,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct EnviarPedidoEmailInput {
    pub email_destino: String,
    pub nombre_proveedor: String,
    #[serde(default)]
    pub notas: Option<String>,
    pub lineas: Vec<LineaEmailInput>,
    /// La clave de este envío: la misma mientras se reintenta el mismo pedido (`claveDeEnvio.ts`).
    /// Si el primer intento llegó a salir y se perdió la respuesta, la nube no lo vuelve a mandar.
    pub id_envio: String,
}
