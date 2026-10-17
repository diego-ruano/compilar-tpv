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

#[cfg(test)]
mod tests {
    use super::*;

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
