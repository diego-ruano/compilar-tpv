//! Adaptador HTTP del repositorio de proveedores (dominio `/v1/proveedores` del worker).

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value as JsonValue};

use tpv_application::error::AppResult;
use tpv_application::ports::proveedores::ProveedoresRepository;
use tpv_contracts::proveedores::{CategoriaProveedorDto, ProductoProveedorDto, ProveedorDto};
use tpv_domain::proveedores::{ProductoNuevo, ProveedorValidado};

use crate::{extract_id, CloudClient};

pub struct HttpProveedoresRepository {
    client: Arc<CloudClient>,
}

impl HttpProveedoresRepository {
    pub fn new(client: Arc<CloudClient>) -> Self {
        Self { client }
    }
}

#[async_trait]
impl ProveedoresRepository for HttpProveedoresRepository {
    async fn get_all(&self) -> AppResult<Vec<ProveedorDto>> {
        self.client.get_json("/v1/proveedores").await
    }

    async fn get_productos(&self, id_proveedor: i64) -> AppResult<Vec<ProductoProveedorDto>> {
        self.client
            .get_json(&format!("/v1/proveedores/{id_proveedor}/productos"))
            .await
    }

    async fn get_categorias(&self) -> AppResult<Vec<CategoriaProveedorDto>> {
        self.client.get_json("/v1/proveedores/categorias").await
    }

    async fn get_productos_all(&self) -> AppResult<Vec<ProductoProveedorDto>> {
        self.client.get_json("/v1/proveedores/productos").await
    }

    async fn guardar(&self, proveedor: ProveedorValidado) -> AppResult<bool> {
        let body = json!({
            "id_proveedor": proveedor.id,
            "nombre_empresa": proveedor.nombre_empresa,
            "contacto": proveedor.contacto,
            "telefono": proveedor.telefono,
            "email": proveedor.email,
            "cif": proveedor.cif,
            "informacion_adicional": proveedor.informacion_adicional,
            "nombre_imagen": proveedor.nombre_imagen,
            "ruta_imagen": proveedor.ruta_imagen,
        });
        let _: JsonValue = self.client.post_json("/v1/proveedores", &body).await?;
        Ok(true)
    }

    async fn eliminar(&self, id_proveedor: i64) -> AppResult<bool> {
        let _: JsonValue = self
            .client
            .delete_json(&format!("/v1/proveedores/{id_proveedor}"))
            .await?;
        Ok(true)
    }

    async fn set_vinculos(&self, id_proveedor: i64, producto_ids: Vec<i64>) -> AppResult<bool> {
        let body = json!({ "producto_ids": producto_ids });
        let _: JsonValue = self
            .client
            .put_json(&format!("/v1/proveedores/{id_proveedor}/vinculos"), &body)
            .await?;
        Ok(true)
    }

    async fn crear_producto(&self, producto: ProductoNuevo) -> AppResult<i64> {
        let body = json!({
            "id_producto": producto.id,
            "id_categoria": producto.id_categoria,
            "id_proveedor": producto.id_proveedor,
            "nombre": producto.nombre,
            "precio_venta": producto.precio_venta,
            "stock_actual": producto.stock_actual,
            "stock_minimo": producto.stock_minimo,
            "unidad_medida": producto.unidad_medida,
        });
        let resp: JsonValue = self
            .client
            .post_json("/v1/proveedores/productos", &body)
            .await?;
        extract_id(&resp, "id_producto")
    }
}
