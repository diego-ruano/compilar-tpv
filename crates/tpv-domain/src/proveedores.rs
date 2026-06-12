//! Dominio de **proveedores**: entidades y validaciones puras.

fn limpia(o: Option<String>) -> Option<String> {
    o.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Proveedor validado listo para upsert. `id = None` => se asigna el siguiente libre.
#[derive(Debug, Clone)]
pub struct ProveedorValidado {
    pub id: Option<String>,
    pub nombre_empresa: String,
    pub contacto: Option<String>,
    pub telefono: Option<String>,
    pub email: Option<String>,
    pub cif: Option<String>,
    pub informacion_adicional: Option<String>,
    pub nombre_imagen: Option<String>,
    pub ruta_imagen: Option<String>,
}

impl ProveedorValidado {
    #[allow(clippy::too_many_arguments)]
    pub fn validar(
        id_proveedor: Option<String>,
        nombre_empresa: String,
        contacto: Option<String>,
        telefono: Option<String>,
        email: Option<String>,
        cif: Option<String>,
        informacion_adicional: Option<String>,
        nombre_imagen: Option<String>,
        ruta_imagen: Option<String>,
    ) -> Result<Self, String> {
        let nombre = nombre_empresa.trim().to_string();
        if nombre.is_empty() {
            return Err("nombre_empresa required".into());
        }
        Ok(ProveedorValidado {
            id: id_proveedor.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
            nombre_empresa: nombre,
            contacto: limpia(contacto),
            telefono: limpia(telefono),
            email: limpia(email),
            cif: limpia(cif),
            informacion_adicional: limpia(informacion_adicional),
            nombre_imagen: limpia(nombre_imagen),
            ruta_imagen: limpia(ruta_imagen),
        })
    }
}

/// Producto nuevo (creado desde la pantalla de proveedores).
#[derive(Debug, Clone)]
pub struct ProductoNuevo {
    pub id: Option<String>,
    pub id_categoria: String,
    pub id_proveedor: String,
    pub nombre: String,
    pub precio_venta: Option<f64>,
    pub stock_actual: Option<f64>,
    pub stock_minimo: Option<f64>,
    pub unidad_medida: Option<String>,
}

fn check_no_negativo(v: Option<f64>, campo: &str) -> Result<(), String> {
    if let Some(n) = v {
        if !n.is_finite() || n < 0.0 {
            return Err(format!("{campo} inválido"));
        }
    }
    Ok(())
}

impl ProductoNuevo {
    #[allow(clippy::too_many_arguments)]
    pub fn validar(
        id_producto: Option<String>,
        id_categoria: String,
        id_proveedor: String,
        nombre: String,
        precio_venta: Option<f64>,
        stock_actual: Option<f64>,
        stock_minimo: Option<f64>,
        unidad_medida: Option<String>,
    ) -> Result<Self, String> {
        let nombre = nombre.trim().to_string();
        if nombre.is_empty() {
            return Err("nombre required".into());
        }
        let id_categoria = id_categoria.trim().to_string();
        if id_categoria.is_empty() {
            return Err("ID_Categoria inválido".into());
        }
        let id_proveedor = id_proveedor.trim().to_string();
        if id_proveedor.is_empty() {
            return Err("ID_Proveedor inválido".into());
        }
        check_no_negativo(stock_actual, "Stock_Actual")?;
        check_no_negativo(precio_venta, "Precio_Venta")?;
        check_no_negativo(stock_minimo, "Stock_Minimo")?;

        Ok(ProductoNuevo {
            id: id_producto.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
            id_categoria,
            id_proveedor,
            nombre,
            precio_venta,
            stock_actual,
            stock_minimo,
            unidad_medida: limpia(unidad_medida),
        })
    }
}

/// Normaliza una lista de IDs de producto: descarta vacíos, ordena y deduplica.
pub fn normalizar_producto_ids(ids: Vec<String>) -> Vec<String> {
    let mut v: Vec<String> = ids
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    v.sort_unstable();
    v.dedup();
    v
}
