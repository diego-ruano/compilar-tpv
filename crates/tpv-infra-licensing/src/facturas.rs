//! El PDF de las facturas completas en la nube (`/v1/facturas`, docs/arquitectura/worker.md
//! § Facturas en PDF): subirlo y bajarlo, firmado como la Main.
//!
//! Las dos rutas son sólo de la Main vigente y van firmadas como las de imágenes (`enviar_firmado`:
//! JWT + device-proof sobre el camino y los bytes del cuerpo, y la repetición si la nube rechaza
//! la hora). En el camino o en el cuerpo sólo viaja el `ID_Registro`, un UUID; nunca el número de
//! la factura ni el NIF (AUD-27).

use async_trait::async_trait;
use reqwest::Method;

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::facturas_pdf::{FacturasNube, SubidaFactura};

use crate::PairingAdapter;

/// Las facturas de UN negocio en la nube.
///
/// AUD-06 · `negocio` es el de la base de la que salen las facturas (su sello). Cada petición
/// comprueba al firmar que el token es de ese negocio: si la licencia cambia a media pasada, la
/// factura no acaba en la carpeta de otro.
pub struct FacturasEnLaNube {
    adaptador: PairingAdapter,
    negocio: String,
}

impl FacturasEnLaNube {
    pub fn new(adaptador: PairingAdapter, negocio: impl Into<String>) -> Self {
        Self { adaptador, negocio: negocio.into() }
    }
}

/// Un `ID_Registro` es un UUID: 36 caracteres, cifras hexadecimales y guiones en su sitio. Lo
/// demás no se manda (el worker lo rechazaría igual, y no se pone en un camino nada que no se sepa
/// qué es).
fn es_uuid(id: &str) -> bool {
    id.len() == 36
        && id.char_indices().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// El camino de la subida de un registro.
fn camino_de_subida(id_registro: &str) -> Option<String> {
    es_uuid(id_registro).then(|| format!("/v1/facturas/{id_registro}"))
}

/// Lo que contesta la subida. Un 400 o un 413 son por lo que se ha mandado (no es un PDF, pasa del
/// tope, el id no vale) y repetirlo no cambia nada; lo demás (credenciales, licencia, un fallo de
/// la nube) no dice nada de la factura.
fn clasificar_subida(status: u16, cuerpo: &[u8]) -> AppResult<SubidaFactura> {
    if (200..300).contains(&status) {
        let ya_estaba = serde_json::from_slice::<serde_json::Value>(cuerpo)
            .ok()
            .and_then(|v| v.get("ya_estaba").and_then(|b| b.as_bool()))
            .unwrap_or(false);
        return Ok(if ya_estaba { SubidaFactura::YaEstaba } else { SubidaFactura::Guardada });
    }
    let texto = String::from_utf8_lossy(cuerpo);
    if matches!(status, 400 | 413) {
        return Ok(SubidaFactura::Rechazada {
            motivo: AppError::from_api_body(status, &texto).to_string(),
        });
    }
    // AUD-28: lo que falló y su status; nada del cuerpo.
    Err(AppError::rechazo("factura_upload", status, &texto))
}

#[async_trait]
impl FacturasNube for FacturasEnLaNube {
    async fn subir(&self, id_registro: &str, pdf: &[u8]) -> AppResult<SubidaFactura> {
        let Some(camino) = camino_de_subida(id_registro) else {
            return Ok(SubidaFactura::Rechazada { motivo: "factura_id_no_valido".into() });
        };
        let (status, cuerpo) = self
            .adaptador
            .enviar_firmado(
                "tpv",
                Method::PUT,
                &camino,
                pdf,
                Some("application/pdf"),
                Some(&self.negocio),
            )
            .await?;
        clasificar_subida(status, &cuerpo)
    }

    async fn bajar(&self, id_registro: &str) -> AppResult<Option<Vec<u8>>> {
        if !es_uuid(id_registro) {
            return Ok(None);
        }
        // El cuerpo entra en la firma: se manda exactamente este, sin volver a serializarlo.
        let cuerpo = serde_json::to_vec(&serde_json::json!({ "id_registro": id_registro }))
            .map_err(|e| AppError::internal(format!("cuerpo_no_serializable:{:?}", e.classify())))?;
        let (status, bytes) = self
            .adaptador
            .enviar_firmado(
                "tpv",
                Method::POST,
                "/v1/facturas/descargar",
                &cuerpo,
                Some("application/json"),
                Some(&self.negocio),
            )
            .await?;
        if status == 404 {
            return Ok(None);
        }
        if !(200..300).contains(&status) {
            // AUD-28: lo que falló y su status; nada del cuerpo.
            return Err(AppError::rechazo("factura_download", status, &String::from_utf8_lossy(&bytes)));
        }
        Ok(Some(bytes))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "0190f3a1-7b2c-4d4e-8f00-123456789abc";

    #[test]
    fn solo_un_uuid_va_en_el_camino() {
        assert_eq!(camino_de_subida(ID).as_deref(), Some("/v1/facturas/0190f3a1-7b2c-4d4e-8f00-123456789abc"));
        assert!(camino_de_subida(&ID.to_uppercase()).is_some());
        for malo in ["", "F-000001", "../images/x.png", "0190f3a1-7b2c-4d4e-8f00-123456789ab", "0190f3a1/7b2c-4d4e-8f00-123456789abc", " 0190f3a1-7b2c-4d4e-8f00-123456789ab"] {
            assert!(camino_de_subida(malo).is_none(), "{malo:?}");
        }
    }

    #[test]
    fn la_respuesta_de_la_subida_dice_si_ya_estaba() {
        assert_eq!(clasificar_subida(200, br#"{"ok":true,"ya_estaba":false}"#).unwrap(), SubidaFactura::Guardada);
        assert_eq!(clasificar_subida(200, br#"{"ok":true,"ya_estaba":true}"#).unwrap(), SubidaFactura::YaEstaba);
    }

    #[test]
    fn lo_que_se_rechaza_por_lo_que_es_se_aparta_y_lo_demas_es_un_fallo_de_la_nube() {
        for status in [400, 413] {
            assert!(matches!(
                clasificar_subida(status, br#"{"ok":false,"code":"validation","error":"factura_no_es_pdf"}"#),
                Ok(SubidaFactura::Rechazada { .. })
            ));
        }
        for status in [401, 403, 404, 429, 500, 502, 503] {
            assert!(clasificar_subida(status, br#"{"ok":false,"error":"forbidden_not_tpv"}"#).is_err(), "{status}");
        }
    }

    #[test]
    fn un_fallo_no_cuenta_lo_que_traia_el_cuerpo() {
        let e = clasificar_subida(502, b"<html>pagina de un intermediario con datos</html>").unwrap_err();
        assert!(!e.to_string().contains("datos"), "{e}");
    }
}
