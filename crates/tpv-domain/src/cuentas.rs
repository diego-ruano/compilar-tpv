//! Dominio de **cuentas** (caja): validaciones y value objects.

pub fn requerido(input: &str, field: &str) -> Result<String, String> {
    let out = input.trim().to_string();
    if out.is_empty() {
        return Err(format!("{field} required"));
    }
    Ok(out)
}

/// Normalización del método de pago: reexporta la única implementación compartida
/// (case-insensitive) para evitar divergencias entre dominios (CUENTA-03).
pub use crate::pago::normalize_metodo;

/// Datos de un gasto (sin id; el id lo gestiona la capa de persistencia / caso de uso).
#[derive(Debug, Clone)]
pub struct GastoData {
    pub fecha: String,
    pub tipo_gasto: String,
    pub concepto: String,
    pub importe: f64,
    pub proveedor_id: Option<String>,
    /// El dinero salió del cajón (CAJA-01). Sólo estos gastos restan del esperado del arqueo.
    pub pagado_con_caja: bool,
}

/// Datos de actualización de un pago.
#[derive(Debug, Clone)]
pub struct PagoData {
    pub fecha_hora: String,
    pub metodo: String,
    pub importe: f64,
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
    /// anti-doble-abono desde que las trazas de consumo dejaron de borrarse (CUENTA-07 §6.4).
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requerido_recorta_y_nombra_el_campo_ausente() {
        assert_eq!(requerido("  concepto  ", "concepto").unwrap(), "concepto");
        assert_eq!(requerido(" \t ", "fecha").unwrap_err(), "fecha required");
    }

    #[test]
    fn metodo_compartido_es_insensible_a_mayusculas() {
        assert_eq!(normalize_metodo(" TARJETA "), "Tarjeta");
        assert_eq!(normalize_metodo("efectivo"), "Efectivo");
        assert_eq!(normalize_metodo("bizum"), "Efectivo");
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
