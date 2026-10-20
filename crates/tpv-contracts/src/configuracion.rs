//! Contratos (DTOs) de la frontera UI<->Rust para **configuración**.

use tpv_domain::dinero::Dinero;

use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct BusinessSettings {
    pub business_name: String,
    pub logo_data_url: Option<String>,
    pub direccion: String,
    pub telefono: String,
    pub cif: String,
    pub mensaje_footer: String,
    pub iva_percent: f64,
    /// A partir de cuánto descuadre el cierre de caja pide un motivo escrito (CUENTA-06).
    pub umbral_descuadre: Dinero,

    // ── Datos fiscales (FISCAL-01, Veri*factu) ──────────────────────────────────────────────────
    /// `NombreRazon` del obligado a expedir la factura. **No es `business_name`**: uno es el rótulo
    /// («Bar La Plaza») y el otro quien factura («Francisco García SL»). El ticket enseña los dos;
    /// el registro que se remite a la AEAT, sólo este.
    pub razon_social: String,
    /// `DescripcionOperacion`, campo obligatorio de hasta 500 caracteres. Texto fijo configurable y
    /// no un resumen de las líneas: los nombres de producto los escribe el usuario, y un campo
    /// obligatorio que puede llegar vacío o con basura es un rechazo garantizado.
    pub descripcion_op: String,
    /// Límite (IVA incluido) por encima del cual ya no cabe una simplificada (`F2`) y hay que
    /// emitir factura completa. 3.000 € en hostelería (art. 4.2 RD 1619/2012).
    pub limite_simplif: Dinero,
    /// `"produccion"` | `"pruebas"`. Cambia a la vez el endpoint del servicio web y la URL del QR.
    pub verifactu_entorno: String,

    // ── Reservas (RI-61) ────────────────────────────────────────────────────────────────────────
    /// Minutos que dura una reserva que no elige su duración.
    pub reserva_duracion_min: i64,
    /// `"avisar"` | `"prohibir"`: qué pasa cuando dos reservas de la misma mesa se pisan.
    pub reserva_solape: String,
    /// A los cuántos minutos de su hora se marca «No vino» una reserva a la que no ha llegado nadie;
    /// 0 = nunca. Lo aplica el job `reservas_no_vino` de la Main.
    pub reserva_no_vino_min: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct TicketSettings {
    pub show_logo: bool,
    pub show_business_name: bool,
    pub show_address: bool,
    pub show_phone: bool,
    pub show_footer_message: bool,
    pub paper_width_mm: i64,

    // ── Parámetros de impresión (antes columnas muertas del esquema, ahora respetadas
    //    por el renderizado ESC/POS en `printing.rs`). ──
    /// DPI de la impresora térmica (203 | 300). Usado para convertir márgenes mm→dots/líneas.
    pub paper_dpi: i64,
    /// Caracteres por línea del cuerpo del ticket (fuente A). Autoritativo sobre el ancho de papel.
    pub chars_per_line: i64,
    /// Márgenes del ticket en milímetros.
    pub margin_top_mm: f64,
    pub margin_bottom_mm: f64,
    pub margin_left_mm: f64,
    pub margin_right_mm: f64,
    /// Escala global de la fuente (0.5–2.0). El builder ESC/POS la mapea a magnificación entera.
    pub font_scale: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ContactSettings {
    pub contact_email: String,
    pub contact_phone: String,
}

/// RI-87: ausente conserva el valor; presente se deserializa estrictamente como T.
/// Sólo CampoPatch<Option<T>> permite vaciar con null (por ejemplo el logo).
#[derive(Debug, Clone, Default)]
pub enum CampoPatch<T> {
    #[default]
    Ausente,
    Valor(T),
}
impl<T> CampoPatch<T> {
    pub fn ausente(&self) -> bool { matches!(self, Self::Ausente) }
}
impl<T: Serialize> Serialize for CampoPatch<T> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Ausente => serializer.serialize_none(),
            Self::Valor(valor) => valor.serialize(serializer),
        }
    }
}
impl<'de, T: Deserialize<'de>> Deserialize<'de> for CampoPatch<T> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        T::deserialize(deserializer).map(Self::Valor)
    }
}
impl<T: specta::Type> specta::Type for CampoPatch<T> {
    fn definition(types: &mut specta::Types) -> specta::datatype::DataType { T::definition(types) }
}

// Un número de entrada JSON no puede ser NaN ni infinito; serde rechaza null en f64.
pub struct NumeroPatch;
impl specta::Type for NumeroPatch {
    fn definition(_: &mut specta::Types) -> specta::datatype::DataType {
        specta_typescript::define("number").into()
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct BusinessSettingsPatch {
    #[serde(default, skip_serializing_if = "CampoPatch::ausente")]
    #[specta(optional)]
    pub business_name: CampoPatch<String>,
    #[serde(default, skip_serializing_if = "CampoPatch::ausente")]
    #[specta(optional)]
    pub logo_data_url: CampoPatch<Option<String>>,
    #[serde(default, skip_serializing_if = "CampoPatch::ausente")]
    #[specta(optional)]
    pub direccion: CampoPatch<String>,
    #[serde(default, skip_serializing_if = "CampoPatch::ausente")]
    #[specta(optional)]
    pub telefono: CampoPatch<String>,
    #[serde(default, skip_serializing_if = "CampoPatch::ausente")]
    #[specta(optional)]
    pub cif: CampoPatch<String>,
    #[serde(default, skip_serializing_if = "CampoPatch::ausente")]
    #[specta(optional)]
    pub mensaje_footer: CampoPatch<String>,
    #[serde(default, skip_serializing_if = "CampoPatch::ausente")]
    #[specta(optional, type = CampoPatch<NumeroPatch>)]
    pub iva_percent: CampoPatch<f64>,
    #[serde(default, skip_serializing_if = "CampoPatch::ausente")]
    #[specta(optional)]
    pub umbral_descuadre: CampoPatch<Dinero>,
    #[serde(default, skip_serializing_if = "CampoPatch::ausente")]
    #[specta(optional)]
    pub razon_social: CampoPatch<String>,
    #[serde(default, skip_serializing_if = "CampoPatch::ausente")]
    #[specta(optional)]
    pub descripcion_op: CampoPatch<String>,
    #[serde(default, skip_serializing_if = "CampoPatch::ausente")]
    #[specta(optional)]
    pub limite_simplif: CampoPatch<Dinero>,
    #[serde(default, skip_serializing_if = "CampoPatch::ausente")]
    #[specta(optional)]
    pub verifactu_entorno: CampoPatch<String>,
    #[serde(default, skip_serializing_if = "CampoPatch::ausente")]
    #[specta(optional)]
    pub reserva_duracion_min: CampoPatch<i64>,
    #[serde(default, skip_serializing_if = "CampoPatch::ausente")]
    #[specta(optional)]
    pub reserva_solape: CampoPatch<String>,
    #[serde(default, skip_serializing_if = "CampoPatch::ausente")]
    #[specta(optional)]
    pub reserva_no_vino_min: CampoPatch<i64>,
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct BusinessSettingsPatchInput {
    pub patch: BusinessSettingsPatch,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct TicketSettingsPatch {
    #[serde(default, skip_serializing_if = "CampoPatch::ausente")]
    #[specta(optional)]
    pub show_logo: CampoPatch<bool>,
    #[serde(default, skip_serializing_if = "CampoPatch::ausente")]
    #[specta(optional)]
    pub show_business_name: CampoPatch<bool>,
    #[serde(default, skip_serializing_if = "CampoPatch::ausente")]
    #[specta(optional)]
    pub show_address: CampoPatch<bool>,
    #[serde(default, skip_serializing_if = "CampoPatch::ausente")]
    #[specta(optional)]
    pub show_phone: CampoPatch<bool>,
    #[serde(default, skip_serializing_if = "CampoPatch::ausente")]
    #[specta(optional)]
    pub show_footer_message: CampoPatch<bool>,
    #[serde(default, skip_serializing_if = "CampoPatch::ausente")]
    #[specta(optional)]
    pub paper_width_mm: CampoPatch<i64>,
    #[serde(default, skip_serializing_if = "CampoPatch::ausente")]
    #[specta(optional)]
    pub paper_dpi: CampoPatch<i64>,
    #[serde(default, skip_serializing_if = "CampoPatch::ausente")]
    #[specta(optional)]
    pub chars_per_line: CampoPatch<i64>,
    #[serde(default, skip_serializing_if = "CampoPatch::ausente")]
    #[specta(optional, type = CampoPatch<NumeroPatch>)]
    pub margin_top_mm: CampoPatch<f64>,
    #[serde(default, skip_serializing_if = "CampoPatch::ausente")]
    #[specta(optional, type = CampoPatch<NumeroPatch>)]
    pub margin_bottom_mm: CampoPatch<f64>,
    #[serde(default, skip_serializing_if = "CampoPatch::ausente")]
    #[specta(optional, type = CampoPatch<NumeroPatch>)]
    pub margin_left_mm: CampoPatch<f64>,
    #[serde(default, skip_serializing_if = "CampoPatch::ausente")]
    #[specta(optional, type = CampoPatch<NumeroPatch>)]
    pub margin_right_mm: CampoPatch<f64>,
    #[serde(default, skip_serializing_if = "CampoPatch::ausente")]
    #[specta(optional, type = CampoPatch<NumeroPatch>)]
    pub font_scale: CampoPatch<f64>,
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct TicketSettingsPatchInput {
    pub patch: TicketSettingsPatch,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ContactSettingsPatch {
    #[serde(default, skip_serializing_if = "CampoPatch::ausente")]
    #[specta(optional)]
    pub contact_email: CampoPatch<String>,
    #[serde(default, skip_serializing_if = "CampoPatch::ausente")]
    #[specta(optional)]
    pub contact_phone: CampoPatch<String>,
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ContactSettingsPatchInput {
    pub patch: ContactSettingsPatch,
}

#[cfg(test)]
mod tests_patch {
    use super::*;
    #[test]
    fn ausencia_null_valor_y_false_son_distintos() {
        for valor in [serde_json::json!({}), serde_json::json!({"logo_data_url": null}), serde_json::json!({"logo_data_url": "data:x", "iva_percent": 0.0, "umbral_descuadre": 750})] {
            let patch: BusinessSettingsPatch = serde_json::from_value(valor.clone()).unwrap();
            assert_eq!(serde_json::to_value(patch).unwrap(), valor);
        }
        let patch: TicketSettingsPatch = serde_json::from_value(serde_json::json!({"show_logo": false})).unwrap();
        assert_eq!(serde_json::to_value(patch).unwrap(), serde_json::json!({"show_logo": false}));
    }
    #[test]
    fn rechaza_claves_desconocidas_y_tipos_incorrectos() {
        for valor in [serde_json::json!({"businessName": "X"}), serde_json::json!({"business_name": null}), serde_json::json!({"iva_percent": "10"}), serde_json::json!({"umbral_descuadre": 1.5})] {
            assert!(serde_json::from_value::<BusinessSettingsPatch>(valor).is_err());
        }
    }
}
