//! Casos de uso de inventario (Local-First).

use tpv_contracts::inventario::{
    AjusteLoteInput, AlergenoInvDto, CategoriaInvDto, CreateLoteInput, InventarioResumenResponse,
    LoteDto, ProductDetailResponse, ProductoBaseDto, ProductoDetalleDto, ProductoListDto,
    ProveedorMiniDto, SetProductoAlergenosInput, SummaryArgs, UpdateLoteInput,
    UpsertCategoriaInput, UpsertProductoInput, UpsertProductoResult,
};
use tpv_domain::inventario::{
    normalize_ids, AjusteLote, CategoriaUpsert, LoteNuevo, LoteUpdate, ProductoUpsert,
};

use crate::error::{AppError, AppResult};
use crate::ports::inventario::InventarioRepository;

type R = dyn InventarioRepository;

pub async fn list_categorias(repo: &R) -> AppResult<Vec<CategoriaInvDto>> {
    repo.list_categorias().await
}

pub async fn list_proveedores_mini(repo: &R) -> AppResult<Vec<ProveedorMiniDto>> {
    repo.list_proveedores_mini().await
}

pub async fn list_productos_by_categoria(
    repo: &R,
    id_categoria: String,
) -> AppResult<Vec<ProductoListDto>> {
    repo.list_productos_by_categoria(&id_categoria).await
}

pub async fn get_resumen(repo: &R, args: SummaryArgs) -> AppResult<InventarioResumenResponse> {
    repo.resumen(args.limit.unwrap_or(12)).await
}

pub async fn list_alergenos(repo: &R) -> AppResult<Vec<AlergenoInvDto>> {
    repo.list_alergenos().await
}

pub async fn get_alergenos_producto(repo: &R, id_producto: String) -> AppResult<Vec<String>> {
    repo.alergenos_producto(&id_producto).await
}

pub async fn get_producto(repo: &R, id_producto: String) -> AppResult<Option<ProductoBaseDto>> {
    repo.get_producto(&id_producto).await
}

pub async fn get_product_detail(repo: &R, id_producto: String) -> AppResult<ProductDetailResponse> {
    repo.product_detail(&id_producto).await
}

pub async fn get_producto_detalle(
    repo: &R,
    id_producto: String,
) -> AppResult<Option<ProductoDetalleDto>> {
    repo.producto_detalle(&id_producto).await
}

pub async fn list_lotes_by_producto(repo: &R, id_producto: String) -> AppResult<Vec<LoteDto>> {
    repo.list_lotes_by_producto(&id_producto).await
}

pub async fn create_categoria(repo: &R, input: UpsertCategoriaInput) -> AppResult<String> {
    let cat = CategoriaUpsert::validar(
        input.id_categoria,
        input.nombre,
        input.nombre_imagen,
        input.ruta_imagen,
        input.vendible,
        input.pasa_cocina,
    )
    .map_err(AppError::validation)?;
    repo.create_categoria(cat).await?;
    Ok("OK".to_string())
}

pub async fn set_alergenos_producto(
    repo: &R,
    input: SetProductoAlergenosInput,
) -> AppResult<String> {
    if input.id_producto.trim().is_empty() {
        return Err(AppError::validation("id_producto inválido"));
    }
    let ids = normalize_ids(input.ids_alergenos);
    repo.set_alergenos_producto(&input.id_producto, ids).await?;
    Ok("OK".to_string())
}

pub async fn delete_producto(repo: &R, id_producto: String) -> AppResult<String> {
    if id_producto.trim().is_empty() {
        return Err(AppError::validation("id_producto inválido"));
    }
    // INV-05: el repo rechaza con mensaje claro si el producto tiene histórico en Detalle_Comanda
    // (en vez de un error crudo de FK).
    repo.delete_producto(&id_producto).await?;
    Ok("OK".to_string())
}

pub async fn upsert_producto(
    repo: &R,
    input: UpsertProductoInput,
) -> AppResult<UpsertProductoResult> {
    let producto = ProductoUpsert::validar(
        input.id_producto,
        input.id_categoria,
        input.id_proveedor,
        input.nombre,
        input.precio_venta,
        input.stock_minimo,
        input.unidad_medida,
        input.nombre_imagen,
        input.ruta_imagen,
        input.cantidad_pedido_esperada,
        input.ids_alergenos,
    )
    .map_err(AppError::validation)?;
    let id_producto = repo.upsert_producto(producto).await?;
    Ok(UpsertProductoResult { id_producto })
}

pub async fn create_lote(repo: &R, input: CreateLoteInput) -> AppResult<String> {
    let lote = LoteNuevo::validar(
        input.id_lote,
        input.id_producto,
        input.codigo_lote,
        input.caducidad,
        input.cantidad_inicial,
        input.stock_disponible,
        input.fecha_entrada,
        input.coste_unitario,
        input.id_proveedor,
        input.notas,
    )
    .map_err(AppError::validation)?;
    repo.create_lote(lote).await?;
    Ok("OK".to_string())
}

pub async fn update_lote(repo: &R, input: UpdateLoteInput) -> AppResult<String> {
    let lote = LoteUpdate::validar(
        input.id_lote,
        input.id_producto,
        input.codigo_lote,
        input.caducidad,
        input.cantidad_inicial,
        input.stock_disponible,
        input.fecha_entrada,
        input.coste_unitario,
        input.id_proveedor,
        input.notas,
    )
    .map_err(AppError::validation)?;
    repo.update_lote(lote).await?;
    Ok("OK".to_string())
}

pub async fn ajustar_lote(repo: &R, input: AjusteLoteInput) -> AppResult<String> {
    let ajuste = AjusteLote::validar(input.id_lote, input.stock_disponible, input.notas)
        .map_err(AppError::validation)?;
    // Coherencia (INV-01, stock ≤ cantidad_inicial) validada en el repo, atómica con la lectura del
    // stock previo (para el delta de auditoría).
    repo.ajustar_lote(ajuste).await?;
    Ok("OK".to_string())
}
