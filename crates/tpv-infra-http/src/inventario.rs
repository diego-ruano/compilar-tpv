//! Adaptador HTTP del repositorio de inventario (dominio `/v1/inventario` del worker).
//!
//! `get_producto` y `producto_detalle` no tienen endpoint propio: se derivan del detalle de
//! producto (`GET /productos/:id`), que devuelve `{ producto, alergenos }`.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value as JsonValue};

use tpv_application::error::AppResult;
use tpv_application::ports::inventario::InventarioRepository;
use tpv_contracts::inventario::{
    AlergenoInvDto, AlergenoMiniDto, CategoriaInvDto, InventarioResumenResponse, LoteDto,
    ProductDetailResponse, ProductoBaseDto, ProductoDetalleDto, ProductoListDto, ProveedorMiniDto,
};
use tpv_domain::inventario::{AjusteLote, CategoriaUpsert, LoteNuevo, ProductoUpsert};

use crate::CloudClient;

pub struct HttpInventarioRepository {
    client: Arc<CloudClient>,
}

impl HttpInventarioRepository {
    pub fn new(client: Arc<CloudClient>) -> Self {
        Self { client }
    }

    async fn detalle(&self, id_producto: &str) -> AppResult<ProductDetailResponse> {
        self.client
            .get_json(&format!("/v1/inventario/productos/{id_producto}"))
            .await
    }
}

fn alergeno_mini(a: AlergenoInvDto) -> AlergenoMiniDto {
    AlergenoMiniDto {
        id_alergeno: a.id_alergeno,
        nombre: a.nombre,
        ruta_imagen: a.ruta_imagen,
    }
}

#[async_trait]
impl InventarioRepository for HttpInventarioRepository {
    // ── Lecturas ──
    async fn list_categorias(&self) -> AppResult<Vec<CategoriaInvDto>> {
        self.client.get_json("/v1/inventario/categorias").await
    }

    async fn list_proveedores_mini(&self) -> AppResult<Vec<ProveedorMiniDto>> {
        self.client.get_json("/v1/inventario/proveedores-mini").await
    }

    async fn list_productos_by_categoria(
        &self,
        id_categoria: &str,
    ) -> AppResult<Vec<ProductoListDto>> {
        self.client
            .get_query("/v1/inventario/productos", &[("categoria", id_categoria.to_string())])
            .await
    }

    async fn resumen(&self, limit: i64) -> AppResult<InventarioResumenResponse> {
        self.client
            .get_query("/v1/inventario/resumen", &[("limit", limit.to_string())])
            .await
    }

    async fn list_alergenos(&self) -> AppResult<Vec<AlergenoInvDto>> {
        self.client.get_json("/v1/inventario/alergenos").await
    }

    async fn alergenos_producto(&self, id_producto: &str) -> AppResult<Vec<String>> {
        self.client
            .get_json(&format!("/v1/inventario/productos/{id_producto}/alergenos"))
            .await
    }

    async fn get_producto(&self, id_producto: &str) -> AppResult<Option<ProductoBaseDto>> {
        Ok(self.detalle(id_producto).await?.producto)
    }

    async fn product_detail(&self, id_producto: &str) -> AppResult<ProductDetailResponse> {
        self.detalle(id_producto).await
    }

    async fn producto_detalle(&self, id_producto: &str) -> AppResult<Option<ProductoDetalleDto>> {
        let resp = self.detalle(id_producto).await?;
        Ok(resp.producto.map(|producto| ProductoDetalleDto {
            producto,
            alergs: resp.alergenos.into_iter().map(alergeno_mini).collect(),
        }))
    }

    async fn list_lotes_by_producto(&self, id_producto: &str) -> AppResult<Vec<LoteDto>> {
        self.client
            .get_json(&format!("/v1/inventario/productos/{id_producto}/lotes"))
            .await
    }

    // ── Escrituras ──
    async fn create_categoria(&self, cat: CategoriaUpsert) -> AppResult<()> {
        let id_categoria = cat.id.unwrap_or_else(|| uuid::Uuid::now_v7().to_string());
        let body = json!({
            "id_categoria": id_categoria,
            "nombre": cat.nombre,
            "nombre_imagen": cat.nombre_imagen,
            "ruta_imagen": cat.ruta_imagen,
            "vendible": cat.vendible,
            "pasa_cocina": cat.pasa_cocina,
        });
        let _: JsonValue = self.client.post_json("/v1/inventario/categorias", &body).await?;
        Ok(())
    }

    async fn set_alergenos_producto(&self, id_producto: &str, ids: Vec<String>) -> AppResult<()> {
        let body = json!({ "ids_alergenos": ids });
        let _: JsonValue = self
            .client
            .put_json(&format!("/v1/inventario/productos/{id_producto}/alergenos"), &body)
            .await?;
        Ok(())
    }

    async fn delete_producto(&self, id_producto: &str) -> AppResult<()> {
        let _: JsonValue = self
            .client
            .delete_json(&format!("/v1/inventario/productos/{id_producto}"))
            .await?;
        Ok(())
    }

    async fn upsert_producto(&self, producto: ProductoUpsert) -> AppResult<String> {
        let id_producto = producto
            .id
            .clone()
            .unwrap_or_else(|| uuid::Uuid::now_v7().to_string());
        let body = json!({
            "id_producto": id_producto,
            "id_categoria": producto.id_categoria,
            "id_proveedor": producto.id_proveedor,
            "nombre": producto.nombre,
            "precio_venta": producto.precio_venta,
            "stock_minimo": producto.stock_minimo,
            "unidad_medida": producto.unidad_medida,
            "nombre_imagen": producto.nombre_imagen,
            "ruta_imagen": producto.ruta_imagen,
            "cantidad_pedido_esperada": producto.cantidad_pedido_esperada,
            "ids_alergenos": producto.ids_alergenos,
        });
        let _: JsonValue = self.client.post_json("/v1/inventario/productos", &body).await?;
        Ok(id_producto)
    }

    async fn create_lote(&self, lote: LoteNuevo) -> AppResult<()> {
        let id_lote = lote.id.clone().unwrap_or_else(|| uuid::Uuid::now_v7().to_string());
        let body = json!({
            "id_lote": id_lote,
            "id_producto": lote.id_producto,
            "codigo_lote": lote.codigo_lote,
            "caducidad": lote.caducidad,
            "cantidad_inicial": lote.cantidad_inicial,
            "stock_disponible": lote.stock_disponible,
            "fecha_entrada": lote.fecha_entrada,
            "coste_unitario": lote.coste_unitario,
            "id_proveedor": lote.id_proveedor,
            "notas": lote.notas,
        });
        let _: JsonValue = self.client.post_json("/v1/inventario/lotes", &body).await?;
        Ok(())
    }

    async fn ajustar_lote(&self, ajuste: AjusteLote) -> AppResult<()> {
        let body = json!({
            "stock_disponible": ajuste.stock_disponible,
            "notas": ajuste.notas,
        });
        let _: JsonValue = self
            .client
            .patch_json(&format!("/v1/inventario/lotes/{}", ajuste.id_lote), &body)
            .await?;
        Ok(())
    }
}
