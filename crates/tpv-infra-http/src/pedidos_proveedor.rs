//! Adaptador HTTP del repositorio de pedidos a proveedores (dominio `/v1/pedidos-proveedor` del
//! worker, PED-HANDY).
//!
//! AUD-27: lo que se busca en la página va en el cuerpo de un `post_lectura`, no en la URL; en el
//! camino sólo va el id del pedido.

use std::sync::Arc;

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value as JsonValue};

use tpv_application::error::AppResult;
use tpv_application::ports::pedidos_proveedor::PedidoProveedorRepository;
use tpv_contracts::pedidos_proveedor::PedidosPageDto;
use tpv_domain::pedidos_proveedor::{LineaPedidoNueva, PedidoProveedorNuevo};

use crate::CloudClient;

pub struct HttpPedidoProveedorRepository {
    client: Arc<CloudClient>,
}

impl HttpPedidoProveedorRepository {
    pub fn new(client: Arc<CloudClient>) -> Self {
        Self { client }
    }
}

/// El cuerpo de una página: el tamaño, desde dónde y lo que se busca (o `null`).
fn cuerpo_pagina(limit: i64, offset: i64, search: Option<String>) -> JsonValue {
    json!({ "limit": limit, "offset": offset, "search": search })
}

fn cuerpo_lineas(lineas: &[LineaPedidoNueva]) -> Vec<JsonValue> {
    lineas
        .iter()
        .map(|l| {
            json!({
                "id_linea": l.id_linea,
                "nombre_producto": l.nombre_producto,
                "cantidad": l.cantidad,
                "precio_unitario": l.precio_unitario,
                "unidad": l.unidad,
            })
        })
        .collect()
}

fn cuerpo_alta(pedido: &PedidoProveedorNuevo, lineas: &[LineaPedidoNueva]) -> JsonValue {
    json!({
        "id_pedido": pedido.id_pedido,
        "id_proveedor": pedido.id_proveedor,
        "email_destino": pedido.email_destino,
        "notas": pedido.notas,
        "lineas": cuerpo_lineas(lineas),
    })
}

#[derive(Deserialize)]
struct Creado {
    id_pedido: Option<String>,
}

#[derive(Deserialize)]
struct EstadoCambiado {
    cambiado: bool,
}

#[async_trait]
impl PedidoProveedorRepository for HttpPedidoProveedorRepository {
    async fn get_page(
        &self,
        limit: i64,
        offset: i64,
        search: Option<String>,
    ) -> AppResult<PedidosPageDto> {
        self.client
            .post_lectura("/v1/pedidos-proveedor/pagina", &cuerpo_pagina(limit, offset, search))
            .await
    }

    async fn crear(
        &self,
        pedido: PedidoProveedorNuevo,
        lineas: Vec<LineaPedidoNueva>,
    ) -> AppResult<String> {
        let creado: Creado = self
            .client
            .post_json("/v1/pedidos-proveedor", &cuerpo_alta(&pedido, &lineas))
            .await?;
        Ok(creado.id_pedido.unwrap_or(pedido.id_pedido))
    }

    /// Un pedido que ya no es borrador lo rechaza la guarda del worker con `conflict` y el texto de
    /// la Main (`pedido_no_editable`): llega como error, igual que allí.
    async fn actualizar(
        &self,
        id_pedido: &str,
        id_proveedor: Option<String>,
        email_destino: Option<String>,
        notas: Option<String>,
        lineas: Vec<LineaPedidoNueva>,
    ) -> AppResult<bool> {
        let body = json!({
            "id_proveedor": id_proveedor,
            "email_destino": email_destino,
            "notas": notas,
            "lineas": cuerpo_lineas(&lineas),
        });
        let _: JsonValue = self
            .client
            .put_json(&format!("/v1/pedidos-proveedor/{id_pedido}"), &body)
            .await?;
        Ok(true)
    }

    async fn cambiar_estado(
        &self,
        id_pedido: &str,
        estado: &str,
        fecha_envio: Option<String>,
    ) -> AppResult<bool> {
        let body = json!({ "estado": estado, "fecha_envio": fecha_envio });
        let r: EstadoCambiado = self
            .client
            .put_json(&format!("/v1/pedidos-proveedor/{id_pedido}/estado"), &body)
            .await?;
        Ok(r.cambiado)
    }
}

#[cfg(test)]
mod tests {
    //! Los cuerpos llevan los nombres de campo que leen los schemas del worker
    //! (`pedidos_proveedor.schemas.ts`), y lo que se busca va en el de la página.

    use super::*;
    use tpv_domain::dinero::Dinero;

    #[test]
    fn la_pagina_lleva_la_busqueda_en_el_cuerpo() {
        assert_eq!(
            cuerpo_pagina(50, 100, Some("Cafés Ñandú".into())),
            json!({ "limit": 50, "offset": 100, "search": "Cafés Ñandú" })
        );
        assert_eq!(cuerpo_pagina(1, 0, None), json!({ "limit": 1, "offset": 0, "search": null }));
    }

    #[test]
    fn el_alta_lleva_la_cabecera_y_las_lineas_con_el_precio_en_centimos() {
        let pedido = PedidoProveedorNuevo {
            id_pedido: "p-1".into(),
            id_proveedor: Some("pr-1".into()),
            email_destino: None,
            notas: Some("urgente".into()),
        };
        let lineas = vec![LineaPedidoNueva {
            id_linea: "l-1".into(),
            nombre_producto: "Café".into(),
            cantidad: 2.5,
            precio_unitario: Some(Dinero::de_centimos(1890)),
            unidad: None,
        }];
        assert_eq!(
            cuerpo_alta(&pedido, &lineas),
            json!({
                "id_pedido": "p-1",
                "id_proveedor": "pr-1",
                "email_destino": null,
                "notas": "urgente",
                "lineas": [{
                    "id_linea": "l-1",
                    "nombre_producto": "Café",
                    "cantidad": 2.5,
                    "precio_unitario": 1890,
                    "unidad": null,
                }],
            })
        );
    }
}
