//! Dominio de **venta rápida** (barra): validaciones y value objects puros.

use crate::dinero::Dinero;

/// Normaliza el método de pago: sólo "Tarjeta" o "Efectivo".
pub fn normalize_metodo(input: &str) -> String {
    if input.trim().eq_ignore_ascii_case("tarjeta") {
        "Tarjeta".to_string()
    } else {
        "Efectivo".to_string()
    }
}

/// Texto opcional normalizado: recorta y descarta vacíos.
pub fn limpiar_opcional(input: Option<String>) -> Option<String> {
    input.and_then(|s| {
        let t = s.trim().to_string();
        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    })
}

/// El id de un cobro, tal como lo manda la pantalla: un UUID, en su forma canónica.
///
/// Lo genera la pantalla al encolar el cobro, no la base al guardarlo, y es lo que hace que cobrar
/// dos veces el mismo intent sea un solo cobro (ver `cobrar_fraccionado` en la capa de datos). Por
/// eso se normaliza: si un reintento llegara escrito de otra forma, sería otro cobro.
pub fn id_de_cobro(input: &str) -> Option<String> {
    uuid::Uuid::parse_str(input.trim())
        .ok()
        .filter(|id| !id.is_nil())
        .map(|id| id.hyphenated().to_string())
}

/// Datos de un cobro fraccionado ya validados/normalizados.
#[derive(Debug, Clone)]
pub struct CobroFraccionado {
    /// `Pagos.ID_Pago`. Ya pasado por `id_de_cobro`.
    pub id_pago: String,
    pub id_comanda: String,
    pub metodo: String,
    pub importe_total: Dinero,
    pub id_usuario_cobrador: Option<String>,
    pub id_trabajador_cobrador: Option<String>,
    /// IDs de detalle a cobrar (no vacíos, ordenados y deduplicados).
    pub detalles: Vec<String>,
    /// FISCAL-02: datos del cliente cuando pide **factura completa** (`F1`), o cuando el importe
    /// pasa del límite de la simplificada y entonces no hay alternativa (§2.2 del plan).
    ///
    /// `None` = ticket normal (`F2`), que es el caso de casi todo. Si el importe pasa del límite y
    /// esto viene vacío, el cobro se rechaza con `factura_completa_requerida` y la pantalla pide
    /// los datos: no es un fallo, es un dato que falta.
    pub destinatario: Option<crate::verifactu::Destinatario>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metodo_normaliza_tarjeta_y_fallback_efectivo() {
        for valor in ["tarjeta", " TARJETA ", "TaRjEtA"] { assert_eq!(normalize_metodo(valor), "Tarjeta"); }
        for valor in ["", "efectivo", "bizum", "card"] { assert_eq!(normalize_metodo(valor), "Efectivo"); }
    }

    #[test]
    fn opcional_recorta_conserva_interior_y_descarta_vacio() {
        assert_eq!(limpiar_opcional(Some(" sin  cebolla ".into())), Some("sin  cebolla".into()));
        assert_eq!(limpiar_opcional(Some("\t\n".into())), None);
        assert_eq!(limpiar_opcional(None), None);
    }

    #[test]
    fn id_de_cobro_solo_acepta_un_uuid_y_lo_deja_en_forma_canonica() {
        let id = "0192f7a4-3b1c-7d2e-8f00-123456789abc";
        assert_eq!(id_de_cobro(id).as_deref(), Some(id));
        // El mismo cobro escrito de otra forma sigue siendo el mismo cobro.
        for otra_forma in [" 0192F7A4-3B1C-7D2E-8F00-123456789ABC ", "0192f7a43b1c7d2e8f00123456789abc"] {
            assert_eq!(id_de_cobro(otra_forma).as_deref(), Some(id), "{otra_forma}");
        }
        for invalido in ["", "  ", "vr_cobrar_fraccionado_tmp-1", "00000000-0000-0000-0000-000000000000"] {
            assert_eq!(id_de_cobro(invalido), None, "{invalido:?}");
        }
    }
}
