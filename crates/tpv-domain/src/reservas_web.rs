//! Reservas desde la web (docs/estudios/reservas-web.md): las reglas puras de su configuración.

/// La zona horaria IANA del negocio a partir de lo que su reloj se separa de UTC en invierno y en
/// verano, en minutos. La nube la necesita para saber qué es «hoy» cuando no hay un dispositivo que
/// se lo diga (las reservas desde la web).
///
/// No se lee el nombre de la zona del sistema: en Windows sólo se puede con las API de WinRT, que no
/// existen en Windows 7, y el TPV tiene una variante para él. Con los dos desfases basta, porque lo
/// único que la nube hace con la zona es pasar de UTC a la hora local, y dos zonas con los mismos
/// desfases y las mismas reglas de horario de verano dan la misma hora.
///
/// Hoy se reconocen las dos de España. Con otros desfases no hay respuesta, y quien llama deja la que
/// hubiera.
pub fn zona_por_desfases(invierno_min: i32, verano_min: i32) -> Option<&'static str> {
    match (invierno_min, verano_min) {
        (60, 120) => Some("Europe/Madrid"),
        (0, 60) => Some("Atlantic/Canary"),
        _ => None,
    }
}

/// Lo más largo que puede ser el motivo de un día cerrado: es una nota para el propio negocio.
pub const MOTIVO_CIERRE_MAX: usize = 100;

/// Un día en que la web no acepta reservas, ya normalizado.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CierreValidado {
    pub dia_ymd: String,
    pub motivo: Option<String>,
}

impl CierreValidado {
    pub fn validar(dia_ymd: &str, motivo: Option<String>) -> Result<Self, String> {
        let dia_ymd = crate::fechas::normalizar_dia(dia_ymd).ok_or_else(|| {
            format!("Formato de día inválido: '{}'. Esperado YYYY-MM-DD.", dia_ymd.trim())
        })?;
        let motivo = crate::texto::limpiar_opcional(motivo);
        if motivo.as_deref().is_some_and(|m| m.chars().count() > MOTIVO_CIERRE_MAX) {
            return Err(format!("El motivo no puede pasar de {MOTIVO_CIERRE_MAX} caracteres"));
        }
        Ok(CierreValidado { dia_ymd, motivo })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn un_dia_cerrado_es_una_fecha_real_con_un_motivo_opcional() {
        assert_eq!(
            CierreValidado::validar(" 2026-12-24 ", Some("  Nochebuena ".into())),
            Ok(CierreValidado { dia_ymd: "2026-12-24".into(), motivo: Some("Nochebuena".into()) })
        );
        assert_eq!(CierreValidado::validar("2026-12-31", Some("   ".into())).unwrap().motivo, None);
        for malo in ["", "24/12/2026", "2026-02-30"] {
            assert!(CierreValidado::validar(malo, None).is_err(), "{malo}");
        }
        assert!(CierreValidado::validar("2026-12-24", Some("x".repeat(MOTIVO_CIERRE_MAX + 1))).is_err());
        assert!(CierreValidado::validar("2026-12-24", Some("ñ".repeat(MOTIVO_CIERRE_MAX))).is_ok());
    }

    #[test]
    fn la_peninsula_y_canarias_se_distinguen_por_sus_desfases() {
        assert_eq!(zona_por_desfases(60, 120), Some("Europe/Madrid"));
        assert_eq!(zona_por_desfases(0, 60), Some("Atlantic/Canary"));
    }

    /// Un PC en UTC, uno sin horario de verano o uno de fuera: no se adivina nada.
    #[test]
    fn unos_desfases_que_no_son_de_espana_no_dan_zona() {
        for (invierno, verano) in [(0, 0), (60, 60), (-300, -240), (120, 180)] {
            assert_eq!(zona_por_desfases(invierno, verano), None, "{invierno}/{verano}");
        }
    }
}
