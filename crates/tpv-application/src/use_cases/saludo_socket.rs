//! Saludo del protocolo existente, con plazo y rol confirmado por el servidor.
use std::time::{Duration, Instant};
use serde_json::{json, Value};
use tpv_contracts::licensing::FirmaDispositivo;
use crate::{error::{AppError, AppResult}, ports::canal_nube::CanalNube};

/// Devuelve el `hello_ok`: la Main lee de él la petición de subida completa (DO-SUBIDA); la Handy
/// lo descarta.
pub async fn saludar<F>(canal: &mut dyn CanalNube, mut firmar: F, rol: &str, recuperando: bool) -> AppResult<Value>
where F: FnMut(&str) -> AppResult<FirmaDispositivo> + Send {
    let fin = Instant::now() + Duration::from_secs(20);
    let mut firmado = false;
    loop {
        let espera = fin.saturating_duration_since(Instant::now());
        if espera.is_zero() { return Err(AppError::external("El socket no confirmó la identidad")); }
        let m = canal.recibir(espera).await?.ok_or_else(|| AppError::external("El socket no confirmó la identidad"))?;
        match m.get("type").and_then(Value::as_str) {
            Some("challenge") if !firmado => {
                let nonce = m.get("nonceB64").and_then(Value::as_str).ok_or_else(|| AppError::external("Reto del socket inválido"))?;
                let firma = firmar(nonce)?;
                canal.enviar(json!({"type":"helloSigned","ts":firma.ts,"sigB64":firma.sig_b64,"nonceB64":nonce,"recovering":recuperando})).await?;
                firmado = true;
            }
            Some("hello_ok") if firmado && m.get("authed") == Some(&Value::Bool(true)) && m.get("role").and_then(Value::as_str) == Some(rol) => return Ok(m),
            Some("hello_ok" | "hello_error" | "error" | "challenge") => return Err(AppError::external("La nube rechazó el saludo del dispositivo")),
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use std::collections::VecDeque;
    struct Canal { mensajes: VecDeque<Value>, enviados: Vec<Value> }
    #[async_trait]
    impl CanalNube for Canal {
        async fn enviar(&mut self, m: Value) -> AppResult<()> { self.enviados.push(m); Ok(()) }
        async fn recibir(&mut self, _: Duration) -> AppResult<Option<Value>> { Ok(self.mensajes.pop_front()) }
    }
    fn canal(ultimo: Value) -> Canal { Canal { mensajes: VecDeque::from([json!({"type":"challenge","nonceB64":"reto"}), ultimo]), enviados: vec![] } }
    fn firma(_: &str) -> AppResult<FirmaDispositivo> { Ok(FirmaDispositivo { ts: 10, sig_b64: "firma".into() }) }
    #[tokio::test]
    async fn exige_la_confirmacion_del_rol_y_conserva_la_recuperacion_main() {
        let mut c = canal(json!({"type":"hello_ok","role":"tpv","authed":true}));
        saludar(&mut c, firma, "tpv", true).await.unwrap(); assert_eq!(c.enviados[0]["recovering"], true);
        let mut c = canal(json!({"type":"hello_ok","role":"tpv","authed":true}));
        assert!(saludar(&mut c, firma, "handy", false).await.is_err());
    }
    #[tokio::test]
    async fn atiende_el_error_real_del_worker_sin_filtrar_su_detalle() {
        let mut c = canal(json!({"type":"error","error":"hello_failed","details":"secreto"}));
        let error = saludar(&mut c, firma, "handy", false).await.unwrap_err();
        assert!(!error.to_string().contains("secreto")); assert!(c.mensajes.is_empty());
    }
    #[tokio::test]
    async fn sin_confirmacion_o_con_un_nonce_repetido_no_se_autentica() {
        let mut c = canal(json!({"type":"challenge","nonceB64":"otro"}));
        assert!(saludar(&mut c, firma, "handy", false).await.is_err()); assert_eq!(c.enviados.len(), 1);
        let mut c = Canal { mensajes: VecDeque::new(), enviados: vec![] };
        assert!(saludar(&mut c, firma, "handy", false).await.is_err());
    }
}
