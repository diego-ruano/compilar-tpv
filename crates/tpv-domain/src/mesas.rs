//! Dominio de **mesas / salón / comandas / cocina**: validaciones y value objects puros.

/// Texto obligatorio: recorta y exige no vacío.
pub use crate::texto::requerido;

/// Texto opcional normalizado: recorta y descarta vacíos.
pub use crate::texto::limpiar_opcional;

/// Normalización del método de pago: reexporta la única implementación compartida
/// (case-insensitive) para evitar divergencias entre dominios (CUENTA-03).
pub use crate::pago::normalize_metodo;

/// Normaliza el estado de cocina de una línea: "PREPARADO" o "PENDIENTE".
pub fn normalize_estado_cocina(input: &str) -> Result<crate::estados::EstadoCocina, String> {
    crate::estados::EstadoCocina::desde_texto(input)
}

/// Mismos textos en el worker (`mesas.schemas.ts`).
pub const MSG_ZONA_SIN_NOMBRE: &str = "Cada zona necesita un nombre";
pub const MSG_MESA_SIN_NOMBRE: &str = "Cada mesa necesita un nombre";

/// Una zona del plano tal como llega para guardarse: su nombre y los de sus mesas.
#[derive(Debug, Clone)]
pub struct ZonaDelPlano<'a> {
    pub nombre: &'a str,
    pub mesas: Vec<&'a str>,
}

/// MESAS-01: lo que no se guarda del plano, venga de la Main o de la Handy: una zona sin nombre, dos
/// zonas con el mismo nombre (la base no admite dos activas) o una mesa sin nombre. Los nombres se
/// comparan recortados, como se guardan. Primero las zonas y luego sus mesas.
pub fn validar_plano(zonas: &[ZonaDelPlano<'_>]) -> Result<(), String> {
    let mut vistas = std::collections::HashSet::new();
    for zona in zonas {
        let nombre = zona.nombre.trim();
        if nombre.is_empty() {
            return Err(MSG_ZONA_SIN_NOMBRE.into());
        }
        if !vistas.insert(nombre) {
            return Err(format!("Nombre de zona duplicado: «{nombre}»"));
        }
    }
    if zonas.iter().flat_map(|z| &z.mesas).any(|m| m.trim().is_empty()) {
        return Err(MSG_MESA_SIN_NOMBRE.into());
    }
    Ok(())
}

/// Datos para abrir una comanda de mesa (ya validados).
#[derive(Debug, Clone)]
pub struct AbrirComandaData {
    pub id_mesa: String,
    /// Trabajador/usuario que abre (se resuelve a ID_Trabajador en infraestructura).
    pub id_trabajador_o_usuario: Option<String>,
    pub id_reserva: Option<String>,
}

/// Datos de un cobro de detalles concretos de una comanda de mesa.
#[derive(Debug, Clone)]
pub struct CobroDetalles {
    pub id_comanda: String,
    pub metodo: crate::pago::MetodoPago,
    pub tipo: String,
    pub detalle_ids: Vec<String>,
    pub id_usuario: Option<String>,
    /// FISCAL-02: datos del cliente cuando pide **factura completa** (`F1`), o cuando el importe
    /// pasa del límite de la simplificada y entonces no hay alternativa (`tpv_domain::verifactu::cabe_en_simplificada`).
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
    fn textos_obligatorios_y_opcionales_se_normalizan() {
        assert_eq!(requerido(" mesa-1 ", "mesa").unwrap(), "mesa-1");
        assert_eq!(requerido(" ", "Falta la mesa.").unwrap_err(), "Falta la mesa.");
        assert_eq!(limpiar_opcional(Some(" nota ".into())), Some("nota".into()));
        assert_eq!(limpiar_opcional(Some(" ".into())), None);
        assert_eq!(limpiar_opcional(None), None);
    }

    #[test]
    fn cocina_admite_estados_conocidos_y_rechaza_desconocidos() {
        assert_eq!(normalize_estado_cocina(" preparado ").unwrap().como_texto(), "PREPARADO");
        assert_eq!(normalize_estado_cocina("pendiente").unwrap().como_texto(), "PENDIENTE");
        for estado in ["", "cocinando", "servido"] { assert!(normalize_estado_cocina(estado).is_err()); }
    }

    #[test]
    fn metodo_de_pago_usa_normalizador_compartido() {
        assert_eq!(normalize_metodo("TaRjEtA").unwrap().como_texto(), "Tarjeta");
        assert!(normalize_metodo("otro").is_err());
    }
}
