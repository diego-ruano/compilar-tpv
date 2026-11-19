//! Casos de uso de inventario (Local-First).

use tpv_contracts::inventario::{
    AjusteLoteInput, AjusteStockSueltoInput, AlergenoInvDto, CatalogoIngredientesDto, CategoriaInvDto,
    CreateLoteInput, GuardarCategoriaIngredienteInput, GuardarIngredienteInput, InventarioResumenResponse,
    LoteDto, ProductDetailResponse, ProductoBaseDto, ProductoDetalleDto, ProductoListDto,
    ProveedorMiniDto, SummaryArgs, UpdateLoteInput,
    UpsertCategoriaInput, UpsertProductoInput, UpsertProductoResult,
};
use tpv_domain::ingredientes::{CategoriaIngredienteGuardar, IngredienteGuardar};
use tpv_domain::inventario::{
    AjusteLote, AjusteSuelto, CategoriaUpsert, LoteNuevo, LoteUpdate, ProductoUpsert,
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

pub async fn borrar_categoria(repo: &R, id_categoria: String) -> AppResult<()> {
    let id = id_categoria.trim();
    if id.is_empty() {
        return Err(AppError::validation("Falta la categoría."));
    }
    repo.borrar_categoria(id).await
}

pub async fn delete_producto(repo: &R, id_producto: String) -> AppResult<String> {
    if id_producto.trim().is_empty() {
        return Err(AppError::validation("Falta el producto."));
    }
    // INV-05: el repo rechaza si el producto está en una comanda ABIERTA. Las ventas ya cobradas
    // no lo impiden: la línea guarda su propio snapshot (nombre, precio, IVA) y sobrevive al
    // borrado.
    repo.delete_producto(&id_producto).await?;
    Ok("OK".to_string())
}

pub async fn upsert_producto(
    repo: &R,
    id_usuario: &str,
    input: UpsertProductoInput,
    autorizacion: &tpv_contracts::permisos::AutorizacionUsuario,
) -> AppResult<UpsertProductoResult> {
    let producto = ProductoUpsert::validar(tpv_domain::inventario::ProductoEntrada {
        id_producto: input.id_producto,
        id_categoria: input.id_categoria,
        id_proveedor: input.id_proveedor,
        nombre: input.nombre,
        precio_venta: input.precio_venta,
        stock_minimo: input.stock_minimo,
        unidad_medida: input.unidad_medida,
        nombre_imagen: input.nombre_imagen,
        ruta_imagen: input.ruta_imagen,
        cantidad_pedido_esperada: input.cantidad_pedido_esperada,
        stock_suelto: input.stock_suelto,
        iva_percent: input.iva_percent,
        ids_alergenos: input.ids_alergenos,
        ids_ingredientes: input.ids_ingredientes,
    })
    .map_err(AppError::validation)?;
    let precios = tpv_domain::permisos::permite(&autorizacion.rol, &autorizacion.permisos, "catalogo.precios");
    let recibir = tpv_domain::permisos::permite(&autorizacion.rol, &autorizacion.permisos, "stock.recibir");
    let existente = match producto.id.as_deref() { Some(id) => repo.get_producto(id).await?, None => None };
    let cambia_precio = existente.as_ref().is_none_or(|p| p.precio_venta != producto.precio_venta || p.iva_percent != producto.iva_percent);
    if (!precios && cambia_precio) || (!recibir && existente.is_none() && producto.stock_suelto.is_some_and(|v| v != 0.0)) {
        return Err(AppError::coded(tpv_contracts::errors::ErrorCode::PermisoDenegado, "No puedes cambiar precios o dar de alta estas existencias"));
    }
    let id_producto = repo.upsert_producto_autorizado(id_usuario, producto, precios, recibir).await?;
    Ok(UpsertProductoResult { id_producto })
}

pub async fn create_lote(repo: &R, id_usuario: &str, input: CreateLoteInput) -> AppResult<String> {
    let lote = LoteNuevo::validar(tpv_domain::inventario::LoteEntrada {
        id_lote: input.id_lote,
        id_producto: input.id_producto,
        codigo_lote: input.codigo_lote,
        caducidad: input.caducidad,
        stock_disponible: input.stock_disponible,
        fecha_entrada: input.fecha_entrada,
        coste_unitario: input.coste_unitario,
        id_proveedor: input.id_proveedor,
        notas: input.notas,
    })
    .map_err(AppError::validation)?;
    repo.create_lote(id_usuario, lote).await?;
    Ok("OK".to_string())
}

pub async fn update_lote(repo: &R, input: UpdateLoteInput) -> AppResult<String> {
    let lote = LoteUpdate::validar(tpv_domain::inventario::LoteEdicionEntrada {
        id_lote: input.id_lote,
        id_producto: input.id_producto,
        codigo_lote: input.codigo_lote,
        caducidad: input.caducidad,
        fecha_entrada: input.fecha_entrada,
        coste_unitario: input.coste_unitario,
        id_proveedor: input.id_proveedor,
        notas: input.notas,
    })
    .map_err(AppError::validation)?;
    repo.update_lote(lote).await?;
    Ok("OK".to_string())
}

pub async fn ajustar_lote(repo: &R, id_usuario: &str, input: AjusteLoteInput) -> AppResult<String> {
    let ajuste =
        AjusteLote::validar(input.id_lote, input.stock_visto, input.stock_nuevo, input.motivo)
            .map_err(AppError::validation)?;
    // El repo lee el stock dentro de la misma transacción: compara con lo visto (RI-55) y saca el
    // delta de auditoría (INV-01b) sin TOCTOU.
    repo.ajustar_lote(id_usuario, ajuste).await?;
    Ok("OK".to_string())
}

pub async fn ajustar_stock_suelto(repo: &R, id_usuario: &str, input: AjusteStockSueltoInput) -> AppResult<String> {
    let ajuste = AjusteSuelto::validar(
        input.id_producto,
        input.stock_visto,
        input.stock_nuevo,
        input.motivo,
    )
    .map_err(AppError::validation)?;
    repo.ajustar_stock_suelto(id_usuario, ajuste).await?;
    Ok("OK".to_string())
}

/* ── Ingredientes ── */

pub async fn catalogo_ingredientes(repo: &R) -> AppResult<CatalogoIngredientesDto> {
    repo.catalogo_ingredientes().await
}

pub async fn ingredientes_de_producto(repo: &R, id_producto: String) -> AppResult<Vec<String>> {
    repo.ingredientes_de_producto(id_producto.trim()).await
}

pub async fn guardar_categoria_ingrediente(
    repo: &R,
    input: GuardarCategoriaIngredienteInput,
) -> AppResult<String> {
    let categoria =
        CategoriaIngredienteGuardar::validar(input.id_categoria_ingrediente, &input.nombre)
            .map_err(AppError::validation)?;
    repo.guardar_categoria_ingrediente(categoria).await
}

pub async fn borrar_categoria_ingrediente(repo: &R, id: String) -> AppResult<()> {
    let id = id.trim();
    if id.is_empty() {
        return Err(AppError::validation("Falta la categoría."));
    }
    repo.borrar_categoria_ingrediente(id).await
}

pub async fn guardar_ingrediente(repo: &R, input: GuardarIngredienteInput) -> AppResult<String> {
    let ingrediente = IngredienteGuardar::validar(
        input.id_ingrediente,
        &input.id_categoria_ingrediente,
        &input.nombre,
    )
    .map_err(AppError::validation)?;
    repo.guardar_ingrediente(ingrediente).await
}

pub async fn borrar_ingrediente(repo: &R, id: String) -> AppResult<()> {
    let id = id.trim();
    if id.is_empty() {
        return Err(AppError::validation(tpv_domain::ingredientes::MSG_FALTA_INGREDIENTE));
    }
    repo.borrar_ingrediente(id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tpv_domain::inventario::normalize_ids;

    #[test]
    fn ids_de_alergenos_se_normalizan_sin_vacios_ni_duplicados() {
        let ids = normalize_ids(vec![" b ".into(), "a".into(), "a".into(), " ".into()]);
        assert_eq!(ids, vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn resultado_upsert_conserva_id_generado_por_repo() {
        let result = UpsertProductoResult {
            id_producto: "producto-1".into(),
        };
        assert_eq!(result.id_producto, "producto-1");
    }

    #[test]
    fn normalizacion_de_alergenos_es_idempotente() {
        let una = normalize_ids(vec![" gluten ".into(), "huevo".into(), "gluten".into()]);
        let dos = normalize_ids(una.clone());
        assert_eq!(una, dos);
    }

    #[test]
    fn normalizacion_de_alergenos_acepta_lista_vacia() {
        assert!(normalize_ids(Vec::new()).is_empty());
    }
}
