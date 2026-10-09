//! Dominio de **cuentas** (caja): validaciones y value objects.

use crate::dinero::Dinero;

pub use crate::texto::requerido;

/// Normalización del método de pago: reexporta la única implementación compartida
/// (case-insensitive) para evitar divergencias entre dominios (CUENTA-03).
pub use crate::pago::{normalize_metodo, normalize_metodo_devolucion};

use crate::cantidad::redondear_cantidad;

/// Datos de un gasto (sin id; el id lo gestiona la capa de persistencia / caso de uso).
#[derive(Debug, Clone)]
pub struct GastoData {
    pub fecha: String,
    pub tipo_gasto: String,
    pub concepto: String,
    pub importe: Dinero,
    pub proveedor_id: Option<String>,
    /// El dinero salió del cajón (CAJA-01). Sólo estos gastos restan del esperado del arqueo.
    pub pagado_con_caja: bool,
}

/// Datos de actualización de un pago.
#[derive(Debug, Clone)]
pub struct PagoData {
    pub fecha_hora: String,
    pub metodo: crate::pago::MetodoPago,
    pub importe: Dinero,
}

/// Estado de un cobro. Vive en `Pagos.Estado`; un cobro anulado **no se borra** (CUENTA-07).
pub const ESTADO_ACTIVO: &str = "ACTIVO";
pub const ESTADO_ANULADO: &str = "ANULADO";

/// Por qué no se puede anular un cobro. Son las dos razones que dependen sólo del pago y de lo
/// que se ha escrito, sin mirar la BD.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RechazoAnulacion {
    /// Ya está anulado. Se rechaza en vez de dejarlo pasar en silencio: quien pulsa dos veces
    /// tiene que enterarse de que la segunda no ha hecho nada y —sobre todo— la reversión del
    /// stock y del gasto del cliente sólo puede ocurrir una vez. Este estado **es** el guardia
    /// anti-doble-abono desde que las trazas de consumo dejaron de borrarse (CUENTA-07).
    YaAnulado,
    /// Falta el motivo. Anular es la operación por la que se va el dinero de un bar sin dejar
    /// rastro; quién y cuándo los pone el sistema, el porqué sólo puede ponerlo quien anula.
    MotivoRequerido,
}

impl RechazoAnulacion {
    pub fn mensaje(self) -> &'static str {
        match self {
            RechazoAnulacion::YaAnulado => "Ese cobro ya está anulado.",
            RechazoAnulacion::MotivoRequerido => {
                "Escribe el motivo de la anulación: queda registrado con tu nombre."
            }
        }
    }
}

/// ¿Se puede anular este cobro? Devuelve el motivo ya recortado, listo para guardar.
///
/// **Que el cobro sea de un cierre ya hecho no importa aquí, y es a propósito** (CAJA-01): anular
/// no se bloquea por fecha. Lo que le pasa a ese cierre —el aviso antes de confirmar y la
/// rectificación después— vive en `use_cases::rectificacion_caja`, que es quien sabe a qué cierre
/// pertenece cada apunte.
pub fn puede_anularse(estado: &str, motivo: Option<&str>) -> Result<String, RechazoAnulacion> {
    if estado.trim().eq_ignore_ascii_case(ESTADO_ANULADO) {
        return Err(RechazoAnulacion::YaAnulado);
    }
    let motivo = motivo.unwrap_or("").trim().to_string();
    if motivo.is_empty() {
        return Err(RechazoAnulacion::MotivoRequerido);
    }
    Ok(motivo)
}

/// El `Tipo` de una devolución de parte de un cobro: un pago negativo que apunta al cobro devuelto.
pub const TIPO_DEVOLUCION: &str = "DEVOLUCION";

/// Por qué no se puede devolver lo que se ha pedido.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RechazoDevolucion {
    /// Como al anular: el dinero sale del cajón y el porqué sólo lo sabe quien lo devuelve.
    MotivoRequerido,
    /// No se ha elegido ninguna línea.
    SinLineas,
    /// Una cantidad que no es un número positivo.
    CantidadNoValida,
    /// Más unidades de las que quedan por devolver de esa línea.
    MasDeLoQueQueda,
    /// Una línea que no es de ese cobro.
    LineaAjena,
    /// El cobro está dado de baja: ya no hay nada que devolver.
    CobroDadoDeBaja,
    /// Es una devolución: se devuelve el cobro, no la devolución.
    EsUnaDevolucion,
    /// El importe del cobro no es la suma de sus líneas (un cobro antiguo prorrateado): devolver
    /// por líneas no sabría cuánto se pagó de cada una. Queda la devolución total.
    NoCuadra,
    /// Lo elegido no se cobró (líneas a 0 €): no hay dinero que devolver.
    SinImporte,
}

impl RechazoDevolucion {
    pub fn mensaje(self) -> &'static str {
        match self {
            RechazoDevolucion::MotivoRequerido => {
                "Escribe el motivo de la devolución: queda registrado con tu nombre."
            }
            RechazoDevolucion::SinLineas => "Elige qué se devuelve.",
            RechazoDevolucion::CantidadNoValida => "Las unidades a devolver tienen que ser más de cero.",
            RechazoDevolucion::MasDeLoQueQueda => {
                "No quedan tantas unidades por devolver de esa línea."
            }
            RechazoDevolucion::LineaAjena => "Esa línea no es de este cobro.",
            RechazoDevolucion::CobroDadoDeBaja => "Ese cobro está dado de baja: no queda nada que devolver.",
            RechazoDevolucion::EsUnaDevolucion => {
                "Eso es una devolución: lo que se devuelve es el cobro original."
            }
            RechazoDevolucion::NoCuadra => {
                "Este cobro no cuadra con sus líneas, así que no se puede devolver por partes: haz la devolución total."
            }
            RechazoDevolucion::SinImporte => "Eso no se cobró: no hay dinero que devolver.",
        }
    }
}

/// El motivo de una devolución, recortado. Obligatorio.
pub fn motivo_de_devolucion(motivo: Option<&str>) -> Result<String, RechazoDevolucion> {
    let m = motivo.unwrap_or("").trim().to_string();
    if m.is_empty() {
        return Err(RechazoDevolucion::MotivoRequerido);
    }
    Ok(m)
}

/// Cuántas unidades de una línea se devuelven, ya redondeadas a milésimas como toda cantidad
/// (RI-26). `cobradas` es la cantidad de la línea y `devueltas` lo que ya devolvieron otras
/// devoluciones vigentes del mismo cobro.
pub fn unidades_a_devolver(pedidas: f64, cobradas: f64, devueltas: f64) -> Result<f64, RechazoDevolucion> {
    // Un NaN o un infinito salen de redondear como cero.
    let pedidas = redondear_cantidad(pedidas);
    if pedidas <= 0.0 {
        return Err(RechazoDevolucion::CantidadNoValida);
    }
    let quedan = redondear_cantidad(cobradas - devueltas);
    if pedidas > quedan + 1e-9 {
        return Err(RechazoDevolucion::MasDeLoQueQueda);
    }
    Ok(pedidas)
}

/// El dinero que se devuelve de una línea al devolver `unidades` de ella cuando ya se habían
/// devuelto `antes`.
///
/// No es `unidades × precio`: es lo devuelto en total después menos lo devuelto antes, cada uno
/// redondeado como el SQL del cobro redondea una línea (`CAST(ROUND(Cantidad * Precio_Unitario))`,
/// que es `Dinero::escala`). Así las devoluciones de una línea, sumadas, dan **exactamente** lo que
/// se cobró por ella, también al peso: devolver 0,35 kg y luego el resto no deja un céntimo suelto.
pub fn importe_devuelto(precio_unitario: Dinero, antes: f64, unidades: f64) -> Dinero {
    let despues = redondear_cantidad(antes + unidades);
    precio_unitario.escala(despues) - precio_unitario.escala(antes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn el_motivo_de_una_devolucion_es_obligatorio() {
        assert_eq!(motivo_de_devolucion(Some("  frío  ")).unwrap(), "frío");
        assert_eq!(motivo_de_devolucion(None).unwrap_err(), RechazoDevolucion::MotivoRequerido);
        assert_eq!(motivo_de_devolucion(Some("  ")).unwrap_err(), RechazoDevolucion::MotivoRequerido);
    }

    #[test]
    fn no_se_devuelve_mas_de_lo_que_queda() {
        assert_eq!(unidades_a_devolver(1.0, 3.0, 0.0).unwrap(), 1.0);
        assert_eq!(unidades_a_devolver(2.0, 3.0, 1.0).unwrap(), 2.0);
        assert_eq!(unidades_a_devolver(1.0, 3.0, 2.5).unwrap_err(), RechazoDevolucion::MasDeLoQueQueda);
        assert_eq!(unidades_a_devolver(1.0, 3.0, 3.0).unwrap_err(), RechazoDevolucion::MasDeLoQueQueda);
        // Al peso, con el residuo de coma flotante que deja restar 0,1 a 0,3.
        assert_eq!(unidades_a_devolver(0.2, 0.3, 0.1).unwrap(), 0.2);
    }

    #[test]
    fn una_cantidad_que_no_es_positiva_no_vale() {
        for mala in [0.0, -1.0, 0.0004, f64::NAN, f64::INFINITY] {
            assert_eq!(
                unidades_a_devolver(mala, 3.0, 0.0).unwrap_err(),
                RechazoDevolucion::CantidadNoValida,
                "{mala}"
            );
        }
    }

    #[test]
    fn las_devoluciones_de_una_linea_suman_lo_cobrado() {
        // 3 cañas a 2,50: una y luego dos.
        let precio = Dinero::de_centimos(250);
        assert_eq!(importe_devuelto(precio, 0.0, 1.0), Dinero::de_centimos(250));
        assert_eq!(importe_devuelto(precio, 1.0, 2.0), Dinero::de_centimos(500));

        // 0,35 kg a 12,99 €/kg = 4,5465 → 4,55 cobrados. Devueltos en 0,1 + 0,1 + 0,15.
        let kilo = Dinero::de_centimos(1299);
        let cobrado = kilo.escala(0.35);
        let partes = [
            importe_devuelto(kilo, 0.0, 0.1),
            importe_devuelto(kilo, 0.1, 0.1),
            importe_devuelto(kilo, 0.2, 0.15),
        ];
        assert_eq!(partes.iter().copied().fold(Dinero::CERO, |a, b| a + b), cobrado);
    }

    #[test]
    fn requerido_recorta_y_nombra_el_campo_ausente() {
        assert_eq!(requerido("  concepto  ", "concepto").unwrap(), "concepto");
        assert_eq!(requerido(" \t ", "fecha").unwrap_err(), "fecha required");
    }

    #[test]
    fn metodo_compartido_es_insensible_a_mayusculas() {
        assert_eq!(normalize_metodo(" TARJETA ").unwrap().como_texto(), "Tarjeta");
        assert_eq!(normalize_metodo("efectivo").unwrap().como_texto(), "Efectivo");
        assert!(normalize_metodo("bizum").is_err());
    }

    #[test]
    fn un_cobro_activo_con_motivo_se_puede_anular() {
        assert_eq!(
            puede_anularse(ESTADO_ACTIVO, Some("  cobro duplicado  ")).unwrap(),
            "cobro duplicado"
        );
    }

    #[test]
    fn un_cobro_ya_anulado_no_se_vuelve_a_anular() {
        // Dejarlo pasar en silencio abonaría el stock y el gasto del cliente una segunda vez.
        assert_eq!(
            puede_anularse(ESTADO_ANULADO, Some("otra vez")).unwrap_err(),
            RechazoAnulacion::YaAnulado
        );
        assert_eq!(
            puede_anularse("anulado", Some("otra vez")).unwrap_err(),
            RechazoAnulacion::YaAnulado
        );
    }

    #[test]
    fn el_motivo_es_obligatorio_y_no_vale_en_blanco() {
        assert_eq!(
            puede_anularse(ESTADO_ACTIVO, None).unwrap_err(),
            RechazoAnulacion::MotivoRequerido
        );
        assert_eq!(
            puede_anularse(ESTADO_ACTIVO, Some("   
 ")).unwrap_err(),
            RechazoAnulacion::MotivoRequerido
        );
    }

    #[test]
    fn ya_anulado_gana_a_la_falta_de_motivo() {
        // Mandar a redactar el porqué de algo que de todos modos no se va a hacer es hacer perder
        // el tiempo; el mensaje útil es "ya está anulado".
        assert_eq!(
            puede_anularse(ESTADO_ANULADO, None).unwrap_err(),
            RechazoAnulacion::YaAnulado
        );
    }

    #[test]
    fn un_estado_desconocido_no_bloquea_la_anulacion() {
        // El CHECK del esquema sólo admite ACTIVO/ANULADO; si apareciera otra cosa, lo peligroso
        // sería lo contrario: un cobro que nadie puede anular.
        assert!(puede_anularse("", Some("x")).is_ok());
    }
}
