//! Dominio de **inventario**: entidades, validaciones y normalizaciones puras.

use crate::dinero::Dinero;

fn limpia(o: Option<String>) -> Option<String> {
    o.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Valida la parte de fecha de un valor de lote y la devuelve como `NaiveDate`.
///
/// Acepta `YYYY-MM-DD` (Caducidad) o `YYYY-MM-DD HH:MM:SS` (Fecha_Entrada); en el segundo
/// caso toma los 10 primeros caracteres. Rechaza fechas imposibles (p. ej. `2025-02-30`),
/// lo que mantiene ordenable el FEFO (`ORDER BY date(Caducidad)`).
fn fecha_lote_valida(s: &str) -> Option<chrono::NaiveDate> {
    let ymd = s.get(0..10)?;
    chrono::NaiveDate::parse_from_str(ymd, "%Y-%m-%d").ok()
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
    pub precio_venta: Option<Dinero>,
    pub stock_minimo: Option<f64>,
    pub unidad_medida: Option<String>,
    pub nombre_imagen: Option<String>,
    pub ruta_imagen: Option<String>,
    pub cantidad_pedido_esperada: Option<f64>,
    pub stock_suelto: Option<f64>,
    /// Tipo de IVA propio. `None` = hereda el del negocio, que es lo normal en hostelería
    /// (el consumo en local va todo al tipo reducido). Se pone solo cuando este producto
    /// tributa distinto: algo envasado para llevar, tabaco, merchandising.
    pub iva_percent: Option<f64>,
    pub ids_alergenos: Vec<String>,
}

impl ProductoUpsert {
    #[allow(clippy::too_many_arguments)]
    pub fn validar(
        id_producto: Option<String>,
        id_categoria: String,
        id_proveedor: Option<String>,
        nombre: String,
        precio_venta: Option<Dinero>,
        stock_minimo: Option<f64>,
        unidad_medida: Option<String>,
        nombre_imagen: Option<String>,
        ruta_imagen: Option<String>,
        cantidad_pedido_esperada: Option<f64>,
        stock_suelto: Option<f64>,
        iva_percent: Option<f64>,
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
            stock_suelto: stock_suelto.filter(|v| v.is_finite()),
            // Un tipo negativo o absurdo no se guarda: cae a "hereda el del negocio", que es la
            // opción segura (un IVA inventado en la fila acabaría en un ticket).
            iva_percent: iva_percent.filter(|v| v.is_finite() && *v >= 0.0 && *v <= 100.0),
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
    pub stock_disponible: f64,
    pub fecha_entrada: Option<String>,
    pub coste_unitario: Option<Dinero>,
    pub id_proveedor: Option<String>,
    pub notas: Option<String>,
}

/// Lote existente a actualizar: sus **datos**, nunca sus existencias.
///
/// RI-55: la edición llevaba el stock que el formulario había cargado y lo escribía en absoluto. Si
/// mientras estaba abierto se vendían 3 de 10, guardar sólo la caducidad devolvía el lote a 10 y
/// anotaba un ajuste de +3 «Edición del lote»: stock fantasma con justificante. Las existencias se
/// cambian con [`AjusteLote`], que comprueba que nadie las ha movido entre medias.
#[derive(Debug, Clone)]
pub struct LoteUpdate {
    pub id_lote: String,
    pub id_producto: String,
    pub codigo_lote: String,
    pub caducidad: Option<String>,
    pub fecha_entrada: Option<String>,
    pub coste_unitario: Option<Dinero>,
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
        fecha_entrada: Option<String>,
        coste_unitario: Option<Dinero>,
        id_proveedor: Option<String>,
        notas: Option<String>,
    ) -> Result<Self, String> {
        let id_lote = id_lote.trim().to_string();
        if id_lote.is_empty() {
            return Err("id_lote inválido".into());
        }
        // Las mismas reglas que el alta para todo lo demás; la cantidad no entra.
        let lote = LoteNuevo::validar(
            Some(id_lote.clone()),
            id_producto,
            codigo_lote,
            caducidad,
            0.0,
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
        stock_disponible: f64,
        fecha_entrada: Option<String>,
        coste_unitario: Option<Dinero>,
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
        // Un lote tiene UNA cantidad, la que queda, y no tiene techo: manda el recuento. El par
        // (inicial, disponible) sólo servía para rechazar un disponible mayor que el inicial, o
        // sea para impedir corregir al alza justo lo que se acababa de contar.
        if !stock_disponible.is_finite() || stock_disponible < 0.0 {
            return Err("Cantidad inválida".into());
        }

        let caducidad = limpia(caducidad);
        let fecha_entrada = limpia(fecha_entrada);

        // Validación de fechas (INV-03): formato ISO y coherencia temporal, para que el FEFO
        // ordene bien. Fecha_Entrada puede venir vacía (la BD la fija a `now` por defecto).
        let cad_date = match &caducidad {
            Some(c) => match fecha_lote_valida(c) {
                Some(d) => Some(d),
                None => return Err("Caducidad con formato inválido (se espera YYYY-MM-DD)".into()),
            },
            None => None,
        };
        let ent_date = match &fecha_entrada {
            Some(f) => match fecha_lote_valida(f) {
                Some(d) => Some(d),
                None => return Err("Fecha_Entrada con formato inválido".into()),
            },
            None => None,
        };
        if let (Some(c), Some(e)) = (cad_date, ent_date) {
            if c < e {
                return Err("La caducidad no puede ser anterior a la fecha de entrada".into());
            }
        }

        Ok(LoteNuevo {
            id: id_lote.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
            id_producto,
            codigo_lote,
            caducidad,
            stock_disponible,
            fecha_entrada,
            coste_unitario,
            id_proveedor,
            notas: limpia(notas),
        })
    }
}

/// Cuánto se puede separar lo que vio quien ajusta de lo que hay: menos de medio gramo, la mitad de la
/// precisión con que se guardan las cantidades (`crate::cantidad`).
const TOLERANCIA_STOCK_VISTO: f64 = 0.0005;

/// ¿Sigue habiendo lo que se vio? Si no, alguien vendió o ajustó mientras el formulario estaba
/// abierto y aplicar el ajuste pisaría ese movimiento (RI-55).
pub fn stock_sin_cambios(visto: Option<f64>, actual: Option<f64>) -> bool {
    match (visto, actual) {
        (None, None) => true,
        (Some(v), Some(a)) => (v - a).abs() < TOLERANCIA_STOCK_VISTO,
        _ => false,
    }
}

/// Ajuste de las existencias de un lote: un recuento, una merma, una rotura (RI-55).
///
/// Lleva **lo que se vio** además de lo que hay ahora. Un recuento es un valor absoluto —«en la
/// estantería hay 7»—, pero si entre que se abrió el formulario y se guardó se vendió algo, ese 7 ya
/// no cuenta lo mismo: el ajuste se rechaza y se vuelve a mirar, en vez de pisar la venta.
#[derive(Debug, Clone)]
pub struct AjusteLote {
    pub id_lote: String,
    pub stock_visto: f64,
    pub stock_nuevo: f64,
    pub motivo: Option<String>,
}

impl AjusteLote {
    pub fn validar(
        id_lote: String,
        stock_visto: f64,
        stock_nuevo: f64,
        motivo: Option<String>,
    ) -> Result<Self, String> {
        let id_lote = id_lote.trim().to_string();
        if id_lote.is_empty() {
            return Err("id_lote inválido".into());
        }
        // Lo visto puede ser negativo (una sobreventa); lo que queda tras el recuento, no.
        if !stock_visto.is_finite() {
            return Err("Stock visto inválido".into());
        }
        if !stock_nuevo.is_finite() || stock_nuevo < 0.0 {
            return Err("La cantidad no puede ser negativa".into());
        }
        Ok(AjusteLote {
            id_lote,
            stock_visto: crate::cantidad::redondear_cantidad(stock_visto),
            stock_nuevo: crate::cantidad::redondear_cantidad(stock_nuevo),
            motivo: limpia(motivo),
        })
    }
}

/// Ajuste del stock **suelto** de un producto (RI-55), con lo que se vio igual que [`AjusteLote`].
///
/// `None` es «este producto no lleva stock suelto»: `stock_nuevo = None` deja de llevarlo y
/// `stock_visto = None` dice que no lo llevaba. A diferencia de un lote, el suelto puede quedarse en
/// negativo (la señal de sobreventa), pero un recuento no lo deja ahí.
#[derive(Debug, Clone)]
pub struct AjusteSuelto {
    pub id_producto: String,
    pub stock_visto: Option<f64>,
    pub stock_nuevo: Option<f64>,
    pub motivo: Option<String>,
}

impl AjusteSuelto {
    pub fn validar(
        id_producto: String,
        stock_visto: Option<f64>,
        stock_nuevo: Option<f64>,
        motivo: Option<String>,
    ) -> Result<Self, String> {
        let id_producto = id_producto.trim().to_string();
        if id_producto.is_empty() {
            return Err("id_producto inválido".into());
        }
        if stock_visto.is_some_and(|v| !v.is_finite()) {
            return Err("Stock visto inválido".into());
        }
        if stock_nuevo.is_some_and(|v| !v.is_finite() || v < 0.0) {
            return Err("La cantidad no puede ser negativa".into());
        }
        Ok(AjusteSuelto {
            id_producto,
            stock_visto: stock_visto.map(crate::cantidad::redondear_cantidad),
            stock_nuevo: stock_nuevo.map(crate::cantidad::redondear_cantidad),
            motivo: limpia(motivo),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_se_recortan_ordenan_y_deduplican() {
        assert_eq!(normalize_ids(vec![" b ".into(), "a".into(), "b".into(), " ".into()]), vec!["a", "b"]);
        assert!(normalize_ids(Vec::new()).is_empty());
    }

    #[test]
    fn categoria_exige_nombre_y_normaliza_campos() {
        assert!(CategoriaUpsert::validar(None, " ".into(), "".into(), "".into(), true, false).is_err());
        let c = CategoriaUpsert::validar(Some(" c1 ".into()), " Bebidas ".into(), " foto.jpg ".into(), " images/foto.jpg ".into(), true, false).unwrap();
        assert_eq!(c.id.as_deref(), Some("c1"));
        assert_eq!(c.nombre, "Bebidas");
        assert_eq!(c.nombre_imagen, "foto.jpg");
        assert_eq!(c.ruta_imagen, "images/foto.jpg");
        assert!(c.vendible && !c.pasa_cocina);
    }

    fn producto(nombre: &str, categoria: &str, stock_suelto: Option<f64>, alergenos: Vec<String>) -> Result<ProductoUpsert, String> {
        producto_con_iva(nombre, categoria, stock_suelto, None, alergenos)
    }

    fn producto_con_iva(nombre: &str, categoria: &str, stock_suelto: Option<f64>, iva: Option<f64>, alergenos: Vec<String>) -> Result<ProductoUpsert, String> {
        ProductoUpsert::validar(Some(" p1 ".into()), categoria.into(), Some(" prov1 ".into()), nombre.into(), Some(Dinero::de_euros(2.5)), Some(1.0), Some(" unidad ".into()), Some(" ".into()), None, Some(3.0), stock_suelto, iva, alergenos)
    }

    #[test]
    fn el_iva_del_producto_solo_se_guarda_si_es_un_porcentaje_creible() {
        // Sin tipo propio = hereda el del negocio, que es el caso normal en hostelería.
        assert_eq!(producto("Cafe", "c1", None, vec![]).unwrap().iva_percent, None);
        assert_eq!(
            producto_con_iva("Cafe", "c1", None, Some(21.0), vec![]).unwrap().iva_percent,
            Some(21.0)
        );
        // Y lo que no es un porcentaje cae a "hereda", en vez de acabar en un ticket: un IVA
        // inventado en la fila es peor que no tener ninguno.
        for absurdo in [-1.0, 101.0, f64::NAN, f64::INFINITY] {
            assert_eq!(
                producto_con_iva("Cafe", "c1", None, Some(absurdo), vec![]).unwrap().iva_percent,
                None,
                "{absurdo} no deberia guardarse"
            );
        }
    }

    #[test]
    fn producto_exige_nombre_y_categoria() {
        assert!(producto(" ", "c1", None, vec![]).is_err());
        assert!(producto("Cafe", " ", None, vec![]).is_err());
    }

    #[test]
    fn producto_normaliza_opcionales_alergenos_y_stock_suelto() {
        let p = producto(" Cafe ", " c1 ", Some(4.0), vec![" gluten ".into(), "huevo".into(), "gluten".into()]).unwrap();
        assert_eq!(p.id.as_deref(), Some("p1"));
        assert_eq!(p.id_categoria, "c1");
        assert_eq!(p.id_proveedor.as_deref(), Some("prov1"));
        assert_eq!(p.nombre, "Cafe");
        assert_eq!(p.unidad_medida.as_deref(), Some("unidad"));
        assert!(p.nombre_imagen.is_none());
        assert_eq!(p.stock_suelto, Some(4.0));
        assert_eq!(p.ids_alergenos, vec!["gluten", "huevo"]);
    }

    #[test]
    fn producto_descarta_stock_suelto_no_finito() {
        assert!(producto("Cafe", "c1", Some(f64::NAN), vec![]).unwrap().stock_suelto.is_none());
        assert!(producto("Cafe", "c1", Some(f64::INFINITY), vec![]).unwrap().stock_suelto.is_none());
    }

    fn lote(cantidad: f64, caducidad: Option<&str>, entrada: Option<&str>) -> Result<LoteNuevo, String> {
        LoteNuevo::validar(Some(" l1 ".into()), " p1 ".into(), " L-001 ".into(), caducidad.map(str::to_string), cantidad, entrada.map(str::to_string), Some(Dinero::de_euros(1.25)), Some(" prov1 ".into()), Some(" fresco ".into()))
    }

    #[test]
    fn lote_valido_guarda_la_cantidad_y_normaliza() {
        let l = lote(10.0, Some("2026-12-31"), Some("2026-07-22 10:00:00")).unwrap();
        assert_eq!(l.id.as_deref(), Some("l1"));
        assert_eq!(l.id_producto, "p1");
        assert_eq!(l.codigo_lote, "L-001");
        assert_eq!(l.stock_disponible, 10.0);
        assert_eq!(l.notas.as_deref(), Some("fresco"));
    }

    #[test]
    fn lote_rechaza_cantidades_invalidas_pero_no_tiene_techo() {
        for cantidad in [-1.0, f64::NAN, f64::INFINITY] { assert!(lote(cantidad, None, None).is_err()); }
        // Cero es un lote agotado, no un error. Y no hay tope superior: la cantidad que se
        // corrige al alza es un recuento, que es justo lo que antes se rechazaba.
        assert!(lote(0.0, None, None).is_ok());
        assert!(lote(999_999.0, None, None).is_ok());
    }

    #[test]
    fn lote_valida_fechas_reales_y_orden_temporal() {
        assert!(lote(1.0, Some("2025-02-30"), None).is_err());
        assert!(lote(1.0, None, Some("fecha mala")).is_err());
        assert!(lote(1.0, Some("2026-01-01"), Some("2026-02-01")).is_err());
        assert!(lote(1.0, Some("2024-02-29"), Some("2024-02-29")).is_ok());
    }

    #[test]
    fn lote_exige_producto_y_codigo() {
        assert!(LoteNuevo::validar(None, " ".into(), "x".into(), None, 1.0, None, None, None, None).is_err());
        assert!(LoteNuevo::validar(None, "p".into(), " ".into(), None, 1.0, None, None, None, None).is_err());
    }

    #[test]
    fn update_exige_id_y_reutiliza_reglas_de_lote_pero_no_lleva_cantidad() {
        assert!(LoteUpdate::validar(" ".into(), "p".into(), "l".into(), None, None, None, None, None).is_err());
        assert!(LoteUpdate::validar("l1".into(), " ".into(), "l".into(), None, None, None, None, None).is_err());
        let l = LoteUpdate::validar(" l1 ".into(), " p1 ".into(), " lote ".into(), None, None, None, None, Some(" nota ".into())).unwrap();
        assert_eq!(l.id_lote, "l1");
        assert_eq!(l.notas.as_deref(), Some("nota"));
    }

    #[test]
    fn ajuste_exige_id_y_cantidad_nueva_finita_no_negativa() {
        assert!(AjusteLote::validar(" ".into(), 1.0, 1.0, None).is_err());
        for nuevo in [-1.0, f64::NAN, f64::INFINITY] {
            assert!(AjusteLote::validar("l1".into(), 1.0, nuevo, None).is_err());
        }
        // Lo visto sí puede ser negativo: un lote en sobreventa que se recuenta.
        let a = AjusteLote::validar(" l1 ".into(), -2.0, 0.30000000000000004, Some(" merma ".into())).unwrap();
        assert_eq!(a.id_lote, "l1");
        assert_eq!(a.stock_visto, -2.0);
        assert_eq!(a.stock_nuevo, 0.3, "se guarda redondeado a milésimas (RI-26)");
        assert_eq!(a.motivo.as_deref(), Some("merma"));
    }

    #[test]
    fn ajuste_suelto_admite_dejar_de_llevarlo_pero_no_un_negativo() {
        assert!(AjusteSuelto::validar("p".into(), Some(3.0), Some(-1.0), None).is_err());
        assert!(AjusteSuelto::validar(" ".into(), None, Some(1.0), None).is_err());
        let a = AjusteSuelto::validar("p".into(), Some(-4.0), None, None).unwrap();
        assert_eq!((a.stock_visto, a.stock_nuevo), (Some(-4.0), None));
    }

    #[test]
    fn el_stock_visto_tiene_que_seguir_siendo_el_actual() {
        assert!(stock_sin_cambios(Some(7.0), Some(7.0)));
        assert!(stock_sin_cambios(Some(7.0), Some(7.0004)), "por debajo de la precisión no es un cambio");
        assert!(!stock_sin_cambios(Some(10.0), Some(7.0)), "se vendieron 3 mientras se ajustaba");
        assert!(stock_sin_cambios(None, None));
        assert!(!stock_sin_cambios(None, Some(2.0)), "alguien le puso stock suelto entre medias");
        assert!(!stock_sin_cambios(Some(2.0), None));
    }
}
