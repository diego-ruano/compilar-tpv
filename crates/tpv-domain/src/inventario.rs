//! Dominio de **inventario**: entidades, validaciones y normalizaciones puras.

fn limpia(o: Option<String>) -> Option<String> {
    o.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Normaliza una lista de IDs: descarta <=0, ordena y deduplica.
pub fn normalize_ids(ids: Vec<i64>) -> Vec<i64> {
    let mut v: Vec<i64> = ids.into_iter().filter(|n| *n > 0).collect();
    v.sort_unstable();
    v.dedup();
    v
}

/// Categoría a crear/upsertar.
#[derive(Debug, Clone)]
pub struct CategoriaUpsert {
    pub id: Option<i64>,
    pub nombre: String,
    pub nombre_imagen: String,
    pub ruta_imagen: String,
    pub vendible: bool,
    pub pasa_cocina: bool,
}

impl CategoriaUpsert {
    pub fn validar(
        id_categoria: Option<i64>,
        nombre: String,
        nombre_imagen: String,
        ruta_imagen: String,
        vendible: bool,
        pasa_cocina: bool,
    ) -> Result<Self, String> {
        let nombre = nombre.trim().to_string();
        if nombre.is_empty() {
            return Err("nombre required".into());
        }
        Ok(CategoriaUpsert {
            id: id_categoria.filter(|n| *n > 0),
            nombre,
            nombre_imagen: nombre_imagen.trim().to_string(),
            ruta_imagen: ruta_imagen.trim().to_string(),
            vendible,
            pasa_cocina,
        })
    }
}

/// Producto a crear/upsertar (con sus alérgenos).
#[derive(Debug, Clone)]
pub struct ProductoUpsert {
    pub id: Option<i64>,
    pub id_categoria: i64,
    pub id_proveedor: Option<i64>,
    pub nombre: String,
    pub precio_venta: Option<f64>,
    pub stock_minimo: Option<f64>,
    pub unidad_medida: Option<String>,
    pub nombre_imagen: Option<String>,
    pub ruta_imagen: Option<String>,
    pub cantidad_pedido_esperada: Option<f64>,
    pub ids_alergenos: Vec<i64>,
}

impl ProductoUpsert {
    #[allow(clippy::too_many_arguments)]
    pub fn validar(
        id_producto: Option<i64>,
        id_categoria: i64,
        id_proveedor: Option<i64>,
        nombre: String,
        precio_venta: Option<f64>,
        stock_minimo: Option<f64>,
        unidad_medida: Option<String>,
        nombre_imagen: Option<String>,
        ruta_imagen: Option<String>,
        cantidad_pedido_esperada: Option<f64>,
        ids_alergenos: Vec<i64>,
    ) -> Result<Self, String> {
        let nombre = nombre.trim().to_string();
        if nombre.is_empty() {
            return Err("nombre required".into());
        }
        if id_categoria <= 0 {
            return Err("id_categoria inválido".into());
        }
        Ok(ProductoUpsert {
            id: id_producto.filter(|n| *n > 0),
            id_categoria,
            id_proveedor: id_proveedor.filter(|n| *n > 0),
            nombre,
            precio_venta,
            stock_minimo,
            unidad_medida: limpia(unidad_medida),
            nombre_imagen: limpia(nombre_imagen),
            ruta_imagen: limpia(ruta_imagen),
            cantidad_pedido_esperada,
            ids_alergenos: normalize_ids(ids_alergenos),
        })
    }
}

/// Lote a crear/upsertar.
#[derive(Debug, Clone)]
pub struct LoteNuevo {
    pub id: Option<i64>,
    pub id_producto: i64,
    pub codigo_lote: String,
    pub caducidad: Option<String>,
    pub cantidad_inicial: f64,
    pub stock_disponible: f64,
    pub fecha_entrada: Option<String>,
    pub coste_unitario: Option<f64>,
    pub id_proveedor: Option<i64>,
    pub notas: Option<String>,
}

impl LoteNuevo {
    #[allow(clippy::too_many_arguments)]
    pub fn validar(
        id_lote: Option<i64>,
        id_producto: i64,
        codigo_lote: String,
        caducidad: Option<String>,
        cantidad_inicial: f64,
        stock_disponible: Option<f64>,
        fecha_entrada: Option<String>,
        coste_unitario: Option<f64>,
        id_proveedor: Option<i64>,
        notas: Option<String>,
    ) -> Result<Self, String> {
        if id_producto <= 0 {
            return Err("id_producto inválido".into());
        }
        let codigo_lote = codigo_lote.trim().to_string();
        if codigo_lote.is_empty() {
            return Err("codigo_lote required".into());
        }
        if !cantidad_inicial.is_finite() || cantidad_inicial < 0.0 {
            return Err("Cantidad_Inicial inválida".into());
        }
        let stock = stock_disponible.unwrap_or(cantidad_inicial);
        if !stock.is_finite() || stock < 0.0 {
            return Err("Stock_Disponible inválido".into());
        }
        Ok(LoteNuevo {
            id: id_lote.filter(|n| *n > 0),
            id_producto,
            codigo_lote,
            caducidad: limpia(caducidad),
            cantidad_inicial,
            stock_disponible: stock,
            fecha_entrada: limpia(fecha_entrada),
            coste_unitario,
            id_proveedor,
            notas: limpia(notas),
        })
    }
}

/// Ajuste de stock de un lote.
#[derive(Debug, Clone)]
pub struct AjusteLote {
    pub id_lote: i64,
    pub stock_disponible: f64,
    pub notas: Option<String>,
}

impl AjusteLote {
    pub fn validar(
        id_lote: i64,
        stock_disponible: f64,
        notas: Option<String>,
    ) -> Result<Self, String> {
        if id_lote <= 0 {
            return Err("id_lote inválido".into());
        }
        if !stock_disponible.is_finite() || stock_disponible < 0.0 {
            return Err("Stock_Disponible inválido".into());
        }
        Ok(AjusteLote {
            id_lote,
            stock_disponible,
            notas: limpia(notas),
        })
    }
}
