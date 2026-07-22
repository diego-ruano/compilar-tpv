//! Casos de uso de proveedores (Local-First).

use tpv_contracts::proveedores::{
    CategoriaProveedorDto, ProductoProveedorDto, ProveedorDto, ProveedorSaveInput,
    ProveedoresCreateProductoInput, ProveedoresSetVinculosInput,
};
use tpv_domain::proveedores::{normalizar_producto_ids, ProductoNuevo, ProveedorValidado};

use crate::error::{AppError, AppResult};
use crate::ports::proveedores::ProveedoresRepository;

pub async fn get_all(repo: &dyn ProveedoresRepository) -> AppResult<Vec<ProveedorDto>> {
    repo.get_all().await
}

pub async fn get_productos(
    repo: &dyn ProveedoresRepository,
    id_proveedor: String,
) -> AppResult<Vec<ProductoProveedorDto>> {
    let id_proveedor = id_proveedor.trim();
    if id_proveedor.is_empty() {
        return Err(AppError::validation("ID_Proveedor inválido"));
    }
    repo.get_productos(id_proveedor).await
}

pub async fn get_categorias(
    repo: &dyn ProveedoresRepository,
) -> AppResult<Vec<CategoriaProveedorDto>> {
    repo.get_categorias().await
}

pub async fn get_productos_all(
    repo: &dyn ProveedoresRepository,
) -> AppResult<Vec<ProductoProveedorDto>> {
    repo.get_productos_all().await
}

pub async fn guardar(
    repo: &dyn ProveedoresRepository,
    input: ProveedorSaveInput,
) -> AppResult<bool> {
    let proveedor = ProveedorValidado::validar(
        input.id_proveedor,
        input.nombre_empresa,
        input.contacto,
        input.telefono,
        input.email,
        input.cif,
        input.informacion_adicional,
        input.nombre_imagen,
        input.ruta_imagen,
    )
    .map_err(AppError::validation)?;
    repo.guardar(proveedor).await
}

pub async fn eliminar(repo: &dyn ProveedoresRepository, id_proveedor: String) -> AppResult<bool> {
    let id_proveedor = id_proveedor.trim();
    if id_proveedor.is_empty() {
        return Err(AppError::validation("ID_Proveedor inválido"));
    }
    repo.eliminar(id_proveedor).await
}

pub async fn set_vinculos(
    repo: &dyn ProveedoresRepository,
    input: ProveedoresSetVinculosInput,
) -> AppResult<bool> {
    let id_proveedor = input.id_proveedor.trim().to_string();
    if id_proveedor.is_empty() {
        return Err(AppError::validation("ID_Proveedor inválido"));
    }
    let ids = normalizar_producto_ids(input.producto_ids);
    repo.set_vinculos(&id_proveedor, ids).await
}

pub async fn crear_producto(
    repo: &dyn ProveedoresRepository,
    input: ProveedoresCreateProductoInput,
) -> AppResult<String> {
    let producto = ProductoNuevo::validar(
        input.id_producto,
        input.id_categoria,
        input.id_proveedor,
        input.nombre,
        input.precio_venta,
        input.stock_actual,
        input.stock_minimo,
        input.unidad_medida,
    )
    .map_err(AppError::validation)?;
    repo.crear_producto(producto).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;

    struct RepoQueNoDebeLlamarse;
    #[async_trait]
    impl ProveedoresRepository for RepoQueNoDebeLlamarse {
        async fn get_all(&self) -> AppResult<Vec<ProveedorDto>> {
            panic!("repo llamado")
        }
        async fn get_productos(&self, _: &str) -> AppResult<Vec<ProductoProveedorDto>> {
            panic!("repo llamado")
        }
        async fn get_categorias(&self) -> AppResult<Vec<CategoriaProveedorDto>> {
            panic!("repo llamado")
        }
        async fn get_productos_all(&self) -> AppResult<Vec<ProductoProveedorDto>> {
            panic!("repo llamado")
        }
        async fn guardar(&self, _: ProveedorValidado) -> AppResult<bool> {
            panic!("repo llamado")
        }
        async fn eliminar(&self, _: &str) -> AppResult<bool> {
            panic!("repo llamado")
        }
        async fn set_vinculos(&self, _: &str, _: Vec<String>) -> AppResult<bool> {
            panic!("repo llamado")
        }
        async fn crear_producto(&self, _: ProductoNuevo) -> AppResult<String> {
            panic!("repo llamado")
        }
    }

    #[tokio::test]
    async fn ids_vacios_se_rechazan_antes_del_repo() {
        assert!(matches!(
            get_productos(&RepoQueNoDebeLlamarse, " ".into()).await,
            Err(AppError::Validation(_))
        ));
        assert!(matches!(
            eliminar(&RepoQueNoDebeLlamarse, " ".into()).await,
            Err(AppError::Validation(_))
        ));
    }

    #[tokio::test]
    async fn set_vinculos_exige_proveedor() {
        let input = ProveedoresSetVinculosInput {
            id_proveedor: " ".into(),
            producto_ids: vec!["p1".into()],
        };
        assert!(matches!(
            set_vinculos(&RepoQueNoDebeLlamarse, input).await,
            Err(AppError::Validation(_))
        ));
    }

    #[test]
    fn ids_de_productos_se_recortan_ordenan_y_deduplican() {
        let ids = normalizar_producto_ids(vec![" p2 ".into(), "p1".into(), "p2".into(), " ".into()]);
        assert_eq!(ids, vec!["p1".to_string(), "p2".to_string()]);
    }

    #[test]
    fn normalizar_vinculos_es_idempotente() {
        let una = normalizar_producto_ids(vec!["p2".into(), "p1".into()]);
        assert_eq!(normalizar_producto_ids(una.clone()), una);
    }
}
