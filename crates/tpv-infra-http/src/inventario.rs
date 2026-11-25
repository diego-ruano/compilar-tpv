//! Adaptador HTTP del repositorio de inventario (dominio `/v1/inventario` del worker).
//!
//! `get_producto` no tiene endpoint propio: sale del detalle de producto (`GET /productos/:id`),
//! que devuelve `{ producto, alergenos }`.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value as JsonValue};

use tpv_application::error::AppResult;
use tpv_application::ports::inventario::InventarioRepository;
use tpv_contracts::inventario::{
    AlergenoInvDto, CatalogoIngredientesDto, CategoriaInvDto, InventarioResumenResponse, LoteDto,
    ProductDetailResponse, ProductoBaseDto, ProductoListDto, ProveedorMiniDto,
};
use tpv_domain::ingredientes::{CategoriaIngredienteGuardar, IngredienteGuardar};
use tpv_domain::inventario::{
    AjusteLote, AjusteSuelto, CategoriaUpsert, LoteNuevo, LoteUpdate, ProductoUpsert,
};

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

#[async_trait]
impl InventarioRepository for HttpInventarioRepository {
    // ── Ingredientes ──
    async fn catalogo_ingredientes(&self) -> AppResult<CatalogoIngredientesDto> {
        self.client.get_json("/v1/inventario/ingredientes").await
    }

    async fn ingredientes_de_producto(&self, id_producto: &str) -> AppResult<Vec<String>> {
        self.client
            .get_json(&format!("/v1/inventario/productos/{id_producto}/ingredientes"))
            .await
    }

    async fn guardar_categoria_ingrediente(&self, c: CategoriaIngredienteGuardar) -> AppResult<String> {
        let generado = c.id.is_none().then_some("id_categoria_ingrediente");
        let id = c.id.unwrap_or_else(|| uuid::Uuid::now_v7().to_string());
        let body = json!({ "id_categoria_ingrediente": id, "nombre": c.nombre });
        // En el reintento de un alta incierta (RI-64) el id que vale es el del primer envío.
        let (_, enviado): (JsonValue, _) = self
            .client
            .post_json_creando("/v1/inventario/ingredientes/categorias", &body, generado)
            .await?;
        Ok(enviado.unwrap_or(id))
    }

    async fn borrar_categoria_ingrediente(&self, id: &str) -> AppResult<()> {
        let _: JsonValue = self
            .client
            .delete_json(&format!("/v1/inventario/ingredientes/categorias/{id}"))
            .await?;
        Ok(())
    }

    async fn guardar_ingrediente(&self, i: IngredienteGuardar) -> AppResult<String> {
        let generado = i.id.is_none().then_some("id_ingrediente");
        let id = i.id.unwrap_or_else(|| uuid::Uuid::now_v7().to_string());
        let body = json!({
            "id_ingrediente": id,
            "id_categoria_ingrediente": i.id_categoria,
            "nombre": i.nombre,
        });
        let (_, enviado): (JsonValue, _) = self
            .client
            .post_json_creando("/v1/inventario/ingredientes", &body, generado)
            .await?;
        Ok(enviado.unwrap_or(id))
    }

    async fn borrar_ingrediente(&self, id: &str) -> AppResult<()> {
        let _: JsonValue = self
            .client
            .delete_json(&format!("/v1/inventario/ingredientes/{id}"))
            .await?;
        Ok(())
    }

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

    async fn get_producto(&self, id_producto: &str) -> AppResult<Option<ProductoBaseDto>> {
        Ok(self.detalle(id_producto).await?.producto)
    }

    async fn product_detail(&self, id_producto: &str) -> AppResult<ProductDetailResponse> {
        self.detalle(id_producto).await
    }

    async fn list_lotes_by_producto(&self, id_producto: &str) -> AppResult<Vec<LoteDto>> {
        self.client
            .get_json(&format!("/v1/inventario/productos/{id_producto}/lotes"))
            .await
    }

    // ── Escrituras ──
    async fn create_categoria(&self, cat: CategoriaUpsert) -> AppResult<()> {
        let generado = cat.id.is_none().then_some("id_categoria");
        let id_categoria = cat.id.unwrap_or_else(|| uuid::Uuid::now_v7().to_string());
        let body = json!({
            "id_categoria": id_categoria,
            "nombre": cat.nombre,
            "nombre_imagen": cat.nombre_imagen,
            "ruta_imagen": cat.ruta_imagen,
            "vendible": cat.vendible,
            "pasa_cocina": cat.pasa_cocina,
        });
        let _: (JsonValue, _) = self
            .client
            .post_json_creando("/v1/inventario/categorias", &body, generado)
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

    async fn borrar_categoria(&self, id_categoria: &str) -> AppResult<()> {
        let _: JsonValue = self
            .client
            .delete_json(&format!("/v1/inventario/categorias/{id_categoria}"))
            .await?;
        Ok(())
    }

    async fn upsert_producto_autorizado(&self, actor: &str, p: ProductoUpsert, precios: bool, recibir: bool) -> AppResult<String> {
        self.guardar_producto(actor,p,precios,recibir).await
    }

    async fn create_lote(&self, id_usuario: &str, lote: LoteNuevo) -> AppResult<()> {
        let generado = lote.id.is_none().then_some("id_lote");
        let id_lote = lote.id.clone().unwrap_or_else(|| uuid::Uuid::now_v7().to_string());
        let body = json!({
            "id_usuario": id_usuario,
            "id_lote": id_lote,
            "id_producto": lote.id_producto,
            "codigo_lote": lote.codigo_lote,
            "caducidad": lote.caducidad,
            "stock_disponible": lote.stock_disponible,
            "fecha_entrada": lote.fecha_entrada,
            "coste_unitario": lote.coste_unitario,
            "id_proveedor": lote.id_proveedor,
            "notas": lote.notas,
        });
        let _: (JsonValue, _) = self
            .client
            .post_json_creando("/v1/inventario/lotes", &body, generado)
            .await?;
        Ok(())
    }

    async fn update_lote(&self, lote: LoteUpdate) -> AppResult<()> {
        let body = json!({
            "id_lote": lote.id_lote,
            "id_producto": lote.id_producto,
            "codigo_lote": lote.codigo_lote,
            "caducidad": lote.caducidad,
            "fecha_entrada": lote.fecha_entrada,
            "coste_unitario": lote.coste_unitario,
            "id_proveedor": lote.id_proveedor,
            "notas": lote.notas,
        });
        let id_lote = body
            .get("id_lote")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let _: JsonValue = self
            .client
            .put_json(&format!("/v1/inventario/lotes/{id_lote}"), &body)
            .await?;
        Ok(())
    }

    async fn ajustar_lote(&self, id_usuario: &str, ajuste: AjusteLote) -> AppResult<()> {
        let body = json!({
            "id_usuario": id_usuario,
            "stock_visto": ajuste.stock_visto,
            "stock_nuevo": ajuste.stock_nuevo,
            "motivo": ajuste.motivo,
        });
        let _: JsonValue = self
            .client
            .patch_json(&format!("/v1/inventario/lotes/{}", ajuste.id_lote), &body)
            .await?;
        Ok(())
    }

    async fn ajustar_stock_suelto(&self, id_usuario: &str, ajuste: AjusteSuelto) -> AppResult<()> {
        let body = json!({
            "id_usuario": id_usuario,
            "stock_visto": ajuste.stock_visto,
            "stock_nuevo": ajuste.stock_nuevo,
            "motivo": ajuste.motivo,
        });
        let _: JsonValue = self
            .client
            .patch_json(
                &format!("/v1/inventario/productos/{}/stock-suelto", ajuste.id_producto),
                &body,
            )
            .await?;
        Ok(())
    }
}

impl HttpInventarioRepository {
    async fn guardar_producto(&self, id_usuario: &str, producto: ProductoUpsert, precios: bool, recibir: bool) -> AppResult<String> {
        let generado = producto.id.is_none().then_some("id_producto");
        let id_producto = producto
            .id
            .clone()
            .unwrap_or_else(|| uuid::Uuid::now_v7().to_string());
        let body = json!({
            "id_usuario": id_usuario,
            "conservar_precio": !precios,
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
            "iva_percent": producto.iva_percent,
            // Sin capacidad de recepción tampoco se introduce stock si desapareció el producto.
            "stock_suelto": if recibir { producto.stock_suelto } else { None },
            "ids_alergenos": producto.ids_alergenos,
            "ids_ingredientes": producto.ids_ingredientes,
        });
        // En el reintento de un alta incierta (RI-64) el id que vale es el del primer envío.
        let (_, enviado): (JsonValue, _) = self
            .client
            .post_json_creando("/v1/inventario/productos", &body, generado)
            .await?;
        Ok(enviado.unwrap_or(id_producto))
    }

}
