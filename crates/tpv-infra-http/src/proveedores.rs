//! Adaptador HTTP del repositorio de proveedores (dominio `/v1/proveedores` del worker).

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value as JsonValue};

use tpv_application::error::AppResult;
use tpv_application::ports::proveedores::ProveedoresRepository;
use tpv_contracts::proveedores::{CategoriaProveedorDto, ProductoProveedorDto, ProveedorDto};
use tpv_domain::proveedores::ProveedorValidado;

use crate::CloudClient;

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

    async fn get_productos(&self, id_proveedor: &str) -> AppResult<Vec<ProductoProveedorDto>> {
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
        let generado = proveedor.id.is_none().then_some("id_proveedor");
        let id_proveedor = proveedor
            .id
            .unwrap_or_else(|| uuid::Uuid::now_v7().to_string());
        let body = json!({
            "id_proveedor": id_proveedor,
            "nombre_empresa": proveedor.nombre_empresa,
            "contacto": proveedor.contacto,
            "telefono": proveedor.telefono,
            "email": proveedor.email,
            "cif": proveedor.cif,
            "informacion_adicional": proveedor.informacion_adicional,
            "nombre_imagen": proveedor.nombre_imagen,
            "ruta_imagen": proveedor.ruta_imagen,
        });
        let _: (JsonValue, _) = self
            .client
            .post_json_creando("/v1/proveedores", &body, generado)
            .await?;
        Ok(true)
    }

    async fn eliminar(&self, id_proveedor: &str) -> AppResult<bool> {
        let _: JsonValue = self
            .client
            .delete_json(&format!("/v1/proveedores/{id_proveedor}"))
            .await?;
        Ok(true)
    }

    async fn set_vinculos(&self, id_proveedor: &str, producto_ids: Vec<String>) -> AppResult<bool> {
        let body = json!({ "producto_ids": producto_ids });
        let _: JsonValue = self
            .client
            .put_json(&format!("/v1/proveedores/{id_proveedor}/vinculos"), &body)
            .await?;
        Ok(true)
    }
}
