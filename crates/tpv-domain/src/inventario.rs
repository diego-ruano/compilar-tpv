//! Dominio de **inventario**: entidades, validaciones y normalizaciones puras.

fn limpia(o: Option<String>) -> Option<String> {
    o.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Normaliza una lista de IDs: recorta, descarta vacíos, ordena y deduplica.
pub fn normalize_ids(ids: Vec<String>) -> Vec<String> {
    let mut v: Vec<String> = ids
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    v.sort_unstable();
    v.dedup();
    v
}

/// Categoría a crear/upsertar.
#[derive(Debug, Clone)]
pub struct CategoriaUpsert {
    pub id: Option<String>,
    pub nombre: String,
    pub nombre_imagen: String,
    pub ruta_imagen: String,
    pub vendible: bool,
    pub pasa_cocina: bool,
}

impl CategoriaUpsert {
    pub fn validar(
        id_categoria: Option<String>,
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
            id: id_categoria.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
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
    pub id: Option<String>,
    pub id_categoria: String,
    pub id_proveedor: Option<String>,
    pub nombre: String,
    pub precio_venta: Option<f64>,
    pub stock_minimo: Option<f64>,
    pub unidad_medida: Option<String>,
    pub nombre_imagen: Option<String>,
    pub ruta_imagen: Option<String>,
    pub cantidad_pedido_esperada: Option<f64>,
    pub ids_alergenos: Vec<String>,
}

impl ProductoUpsert {
    #[allow(clippy::too_many_arguments)]
    pub fn validar(
        id_producto: Option<String>,
        id_categoria: String,
        id_proveedor: Option<String>,
        nombre: String,
        precio_venta: Option<f64>,
        stock_minimo: Option<f64>,
        unidad_medida: Option<String>,
        nombre_imagen: Option<String>,
        ruta_imagen: Option<String>,
        cantidad_pedido_esperada: Option<f64>,
        ids_alergenos: Vec<String>,
    ) -> Result<Self, String> {
        let nombre = nombre.trim().to_string();
        if nombre.is_empty() {
            return Err("nombre required".into());
        }
        let id_categoria = id_categoria.trim().to_string();
        if id_categoria.is_empty() {
            return Err("id_categoria inválido".into());
        }
        Ok(ProductoUpsert {
            id: id_producto.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
            id_categoria,
            id_proveedor: id_proveedor.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
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
    pub id: Option<String>,
    pub id_producto: String,
    pub codigo_lote: String,
    pub caducidad: Option<String>,
    pub cantidad_inicial: f64,
    pub stock_disponible: f64,
    pub fecha_entrada: Option<String>,
    pub coste_unitario: Option<f64>,
    pub id_proveedor: Option<String>,
    pub notas: Option<String>,
}

/// Lote existente a actualizar.
#[derive(Debug, Clone)]
pub struct LoteUpdate {
    pub id_lote: String,
    pub id_producto: String,
    pub codigo_lote: String,
    pub caducidad: Option<String>,
    pub cantidad_inicial: f64,
    pub stock_disponible: f64,
    pub fecha_entrada: Option<String>,
    pub coste_unitario: Option<f64>,
    pub id_proveedor: Option<String>,
    pub notas: Option<String>,
}

impl LoteUpdate {
    #[allow(clippy::too_many_arguments)]
    pub fn validar(
        id_lote: String,
        id_producto: String,
        codigo_lote: String,
        caducidad: Option<String>,
        cantidad_inicial: f64,
        stock_disponible: f64,
        fecha_entrada: Option<String>,
        coste_unitario: Option<f64>,
        id_proveedor: Option<String>,
        notas: Option<String>,
    ) -> Result<Self, String> {
        let id_lote = id_lote.trim().to_string();
        if id_lote.is_empty() {
            return Err("id_lote inválido".into());
        }
        let lote = LoteNuevo::validar(
            Some(id_lote.clone()),
            id_producto,
            codigo_lote,
            caducidad,
            cantidad_inicial,
            Some(stock_disponible),
            fecha_entrada,
            coste_unitario,
            id_proveedor,
            notas,
        )?;
        Ok(LoteUpdate {
            id_lote,
            id_producto: lote.id_producto,
            codigo_lote: lote.codigo_lote,
            caducidad: lote.caducidad,
            cantidad_inicial: lote.cantidad_inicial,
            stock_disponible: lote.stock_disponible,
            fecha_entrada: lote.fecha_entrada,
            coste_unitario: lote.coste_unitario,
            id_proveedor: lote.id_proveedor,
            notas: lote.notas,
        })
    }
}

impl LoteNuevo {
    #[allow(clippy::too_many_arguments)]
    pub fn validar(
        id_lote: Option<String>,
        id_producto: String,
        codigo_lote: String,
        caducidad: Option<String>,
        cantidad_inicial: f64,
        stock_disponible: Option<f64>,
        fecha_entrada: Option<String>,
        coste_unitario: Option<f64>,
        id_proveedor: Option<String>,
        notas: Option<String>,
    ) -> Result<Self, String> {
        let id_producto = id_producto.trim().to_string();
        if id_producto.is_empty() {
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
            id: id_lote.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
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
    pub id_lote: String,
    pub stock_disponible: f64,
    pub notas: Option<String>,
}

impl AjusteLote {
    pub fn validar(
        id_lote: String,
        stock_disponible: f64,
        notas: Option<String>,
    ) -> Result<Self, String> {
        let id_lote = id_lote.trim().to_string();
        if id_lote.is_empty() {
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
