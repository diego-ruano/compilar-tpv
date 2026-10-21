//! Dominio de **inventario**: entidades, validaciones y normalizaciones puras.

use crate::dinero::Dinero;

use crate::texto::limpiar_opcional as limpia;

/// Normaliza una lista de IDs: recorta, descarta vacíos, ordena y deduplica.
pub use crate::texto::normalizar_ids as normalize_ids;

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
            return Err("Escribe el nombre de la categoría.".into());
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

/// Datos crudos con campos nombrados (RI-48); validar produce el objeto de dominio.
#[derive(Debug, Clone)]
pub struct ProductoEntrada {
    pub id_producto: Option<String>,
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
    pub iva_percent: Option<f64>,
    pub ids_alergenos: Vec<String>,
}

impl ProductoUpsert {
    pub fn validar(input: ProductoEntrada) -> Result<Self, String> {
        let ProductoEntrada {
            id_producto,
            id_categoria,
            id_proveedor,
            nombre,
            precio_venta,
            stock_minimo,
            unidad_medida,
            nombre_imagen,
            ruta_imagen,
            cantidad_pedido_esperada,
            stock_suelto,
            iva_percent,
            ids_alergenos,
        } = input;
        let nombre = nombre.trim().to_string();
        if nombre.is_empty() {
            return Err("Escribe el nombre del producto.".into());
        }
        let id_categoria = id_categoria.trim().to_string();
        if id_categoria.is_empty() {
            return Err("Elige la categoría del producto.".into());
        }
        // RI-78: un tipo fuera de rango se rechaza. Antes caía en silencio a «hereda el del
        // negocio»: quien tecleaba «210» por «21» guardaba el producto con otro IVA y un aviso de
        // que todo había ido bien. Un tipo impositivo es un dato fiscal; no se elige por nadie.
        if let Some(iva) = iva_percent {
            crate::configuracion::validate_iva_percent(iva)?;
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
            iva_percent,
            ids_alergenos: normalize_ids(ids_alergenos),
        })
    }
}

// Los mismos textos en el worker (`inventario.schemas.ts`).
pub const MSG_CADUCIDAD_INVALIDA: &str = "Caducidad con formato inválido (se espera YYYY-MM-DD)";
pub const MSG_ENTRADA_INVALIDA: &str = "La fecha de entrada no tiene un formato válido.";
pub const MSG_CADUCIDAD_ANTERIOR: &str = "La caducidad no puede ser anterior a la fecha de entrada";

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

/// Datos crudos con campos nombrados (RI-48); validar produce el objeto de dominio.
#[derive(Debug, Clone)]
pub struct LoteEdicionEntrada {
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
    pub fn validar(input: LoteEdicionEntrada) -> Result<Self, String> {
        let LoteEdicionEntrada {
            id_lote,
            id_producto,
            codigo_lote,
            caducidad,
            fecha_entrada,
            coste_unitario,
            id_proveedor,
            notas,
        } = input;
        let id_lote = id_lote.trim().to_string();
        if id_lote.is_empty() {
            return Err("Falta el lote.".into());
        }
        // Las mismas reglas que el alta para todo lo demás; la cantidad no entra.
        let lote = LoteNuevo::validar(crate::inventario::LoteEntrada {
            id_lote: Some(id_lote.clone()),
            id_producto,
            codigo_lote,
            caducidad,
            stock_disponible: 0.0,
            fecha_entrada,
            coste_unitario,
            id_proveedor,
            notas,
        })?;
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

/// Datos crudos con campos nombrados (RI-48); validar produce el objeto de dominio.
#[derive(Debug, Clone)]
pub struct LoteEntrada {
    pub id_lote: Option<String>,
    pub id_producto: String,
    pub codigo_lote: String,
    pub caducidad: Option<String>,
    pub stock_disponible: f64,
    pub fecha_entrada: Option<String>,
    pub coste_unitario: Option<Dinero>,
    pub id_proveedor: Option<String>,
    pub notas: Option<String>,
}

impl LoteNuevo {
    pub fn validar(input: LoteEntrada) -> Result<Self, String> {
        let LoteEntrada {
            id_lote,
            id_producto,
            codigo_lote,
            caducidad,
            stock_disponible,
            fecha_entrada,
            coste_unitario,
            id_proveedor,
            notas,
        } = input;
        let id_producto = id_producto.trim().to_string();
        if id_producto.is_empty() {
            return Err("Falta el producto.".into());
        }
        let codigo_lote = codigo_lote.trim().to_string();
        if codigo_lote.is_empty() {
            return Err("Escribe el código del lote.".into());
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
        // ordene bien (`ORDER BY date(Caducidad)`: lo que SQLite no entiende es `NULL`, y un
        // `NULL` va delante de todos). Fecha_Entrada es opcional en la entrada: al crear, el SQL
        // del escritor usa la hora local si falta; al editar, conserva la fecha existente.
        // La columna del esquema es NOT NULL y no tiene DEFAULT de hora.
        //
        // RI-78: se valida el texto ENTERO, que es lo que se guarda. La caducidad es una fecha
        // sola; la entrada, una fecha o un instante completo.
        let cad_date = match &caducidad {
            Some(c) => Some(crate::fechas::fecha_ymd(c).ok_or(MSG_CADUCIDAD_INVALIDA)?),
            None => None,
        };
        let ent_date = match &fecha_entrada {
            Some(f) => Some(crate::fechas::fecha_de_instante(f).ok_or(MSG_ENTRADA_INVALIDA)?),
            None => None,
        };
        if let (Some(c), Some(e)) = (cad_date, ent_date) {
            if c < e {
                return Err(MSG_CADUCIDAD_ANTERIOR.into());
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
            return Err("Falta el lote.".into());
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
            return Err("Falta el producto.".into());
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
        ProductoUpsert::validar(crate::inventario::ProductoEntrada {
            id_producto: Some(" p1 ".into()),
            id_categoria: categoria.into(),
            id_proveedor: Some(" prov1 ".into()),
            nombre: nombre.into(),
            precio_venta: Some(Dinero::de_euros(2.5)),
            stock_minimo: Some(1.0),
            unidad_medida: Some(" unidad ".into()),
            nombre_imagen: Some(" ".into()),
            ruta_imagen: None,
            cantidad_pedido_esperada: Some(3.0),
            stock_suelto,
            iva_percent: iva,
            ids_alergenos: alergenos,
        })
    }

    #[test]
    fn el_iva_del_producto_es_un_porcentaje_o_se_rechaza() {
        // Sin tipo propio = hereda el del negocio, que es el caso normal en hostelería.
        assert_eq!(producto("Cafe", "c1", None, vec![]).unwrap().iva_percent, None);
        for valido in [0.0, 21.0, 100.0] {
            assert_eq!(
                producto_con_iva("Cafe", "c1", None, Some(valido), vec![]).unwrap().iva_percent,
                Some(valido)
            );
        }
        // RI-78: lo que no es un porcentaje se rechaza. Ni acaba en un ticket ni se convierte por
        // su cuenta en «hereda», que es otro IVA distinto del que alguien escribió.
        for absurdo in [-1.0, 100.01, 210.0, f64::NAN, f64::INFINITY] {
            assert_eq!(
                producto_con_iva("Cafe", "c1", None, Some(absurdo), vec![]).unwrap_err(),
                crate::configuracion::MSG_IVA,
                "{absurdo} no deberia aceptarse"
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
        LoteNuevo::validar(crate::inventario::LoteEntrada {
            id_lote: Some(" l1 ".into()),
            id_producto: " p1 ".into(),
            codigo_lote: " L-001 ".into(),
            caducidad: caducidad.map(str::to_string),
            stock_disponible: cantidad,
            fecha_entrada: entrada.map(str::to_string),
            coste_unitario: Some(Dinero::de_euros(1.25)),
            id_proveedor: Some(" prov1 ".into()),
            notas: Some(" fresco ".into()),
        })
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

    /// RI-78: se guarda el texto entero, así que se valida entero. Con sólo los diez primeros
    /// caracteres comprobados, lo que viniera detrás acababa en la columna.
    #[test]
    fn lote_rechaza_texto_sobrante_tras_la_fecha() {
        assert!(lote(1.0, Some("2026-12-31basura"), None).is_err());
        assert!(lote(1.0, Some("2026-12-31 00:00:00"), None).is_err(), "la caducidad es una fecha sola");
        assert!(lote(1.0, None, Some("2026-07-22 basura")).is_err());
        assert!(lote(1.0, None, Some("2026-07-22")).is_ok());
    }

    #[test]
    fn lote_exige_producto_y_codigo() {
        assert!(LoteNuevo::validar(crate::inventario::LoteEntrada {
            id_lote: None,
            id_producto: " ".into(),
            codigo_lote: "x".into(),
            caducidad: None,
            stock_disponible: 1.0,
            fecha_entrada: None,
            coste_unitario: None,
            id_proveedor: None,
            notas: None,
        }).is_err());
        assert!(LoteNuevo::validar(crate::inventario::LoteEntrada {
            id_lote: None,
            id_producto: "p".into(),
            codigo_lote: " ".into(),
            caducidad: None,
            stock_disponible: 1.0,
            fecha_entrada: None,
            coste_unitario: None,
            id_proveedor: None,
            notas: None,
        }).is_err());
    }

    #[test]
    fn update_exige_id_y_reutiliza_reglas_de_lote_pero_no_lleva_cantidad() {
        assert!(LoteUpdate::validar(crate::inventario::LoteEdicionEntrada {
            id_lote: " ".into(),
            id_producto: "p".into(),
            codigo_lote: "l".into(),
            caducidad: None,
            fecha_entrada: None,
            coste_unitario: None,
            id_proveedor: None,
            notas: None,
        }).is_err());
        assert!(LoteUpdate::validar(crate::inventario::LoteEdicionEntrada {
            id_lote: "l1".into(),
            id_producto: " ".into(),
            codigo_lote: "l".into(),
            caducidad: None,
            fecha_entrada: None,
            coste_unitario: None,
            id_proveedor: None,
            notas: None,
        }).is_err());
        let l = LoteUpdate::validar(crate::inventario::LoteEdicionEntrada {
            id_lote: " l1 ".into(),
            id_producto: " p1 ".into(),
            codigo_lote: " lote ".into(),
            caducidad: None,
            fecha_entrada: None,
            coste_unitario: None,
            id_proveedor: None,
            notas: Some(" nota ".into()),
        }).unwrap();
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
