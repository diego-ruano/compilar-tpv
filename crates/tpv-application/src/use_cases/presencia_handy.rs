//! Presencia de la Main, independiente de Tauri y del reloj/runtime concreto.
use serde_json::Value;
use tpv_contracts::{errors::ErrorCode, socket_handy::{ConexionHandy, EstadoSocketHandy, RechazoHandy}, sync::{CambioReplicado, SqlStatement}};
use crate::error::{AppError, AppResult};
use super::avisos_nube::aviso;

pub const GRACIA_MS: u64 = 5_000;
/// Plazo del `pong` al comprobar la conexión cuando la aplicación vuelve a primer plano.
pub const PLAZO_PONG_MS: u64 = 3_000;
/// El latido del transporte va cada 30 s. Un último `pong` más viejo que esto dice que el latido
/// anterior se quedó sin respuesta o que el equipo ha estado suspendido: no hace falta otro ping
/// para saber que hay que reconectar.
pub const PONG_CADUCADO_MS: u64 = 35_000;

/// Qué hace el servicio cuando la aplicación vuelve a primer plano, vuelve la red o alguien pulsa
/// «Reintentar» (INC-20261030-019).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AlVolver {
    /// La nube ha rechazado a este equipo: volver a primer plano no lo arregla.
    Nada,
    /// La conexión parece viva: se manda un ping y sólo se reconecta si su `pong` no llega en
    /// [`PLAZO_PONG_MS`]. Cortarla sin más es pedir otro ticket, saludar de nuevo y releerlo todo.
    Comprobar,
    /// Se suelta la sesión que haya y se conecta ya.
    Reconectar,
}

pub struct PresenciaHandy {
    pub foto: EstadoSocketHandy,
    vence_gracia: Option<u64>,
}

impl Default for PresenciaHandy {
    fn default() -> Self {
        Self { foto: EstadoSocketHandy { revision: 0, generacion: 0, conexion: 0, tenant_id: None,
            estado: ConexionHandy::Pausada, main_online: None, volcando: false, rechazo: None }, vence_gracia: None }
    }
}

impl PresenciaHandy {
    pub fn activar(&mut self, tenant: Option<String>, handy: bool) {
        self.foto.generacion += 1;
        self.foto.tenant_id = tenant;
        self.foto.estado = if !handy { ConexionHandy::Pausada } else if self.foto.tenant_id.is_none() { ConexionHandy::SinIdentidad } else { ConexionHandy::Conectando };
        self.foto.main_online = None;
        self.foto.volcando = false;
        self.foto.rechazo = None;
        self.vence_gracia = None;
    }

    pub fn desconectar(&mut self, ahora_ms: u64) {
        self.foto.estado = ConexionHandy::Reintentando;
        if self.foto.main_online.is_some() {
            self.vence_gracia.get_or_insert(ahora_ms.saturating_add(GRACIA_MS));
        }
    }

    pub fn vencer_gracia(&mut self, ahora_ms: u64) -> bool {
        if self.vence_gracia.is_some_and(|vence| ahora_ms >= vence) {
            self.vence_gracia = None;
            self.foto.main_online = None;
            self.foto.volcando = false;
            return true;
        }
        false
    }

    pub fn espera_gracia(&self, ahora_ms: u64) -> Option<u64> {
        self.vence_gracia.map(|vence| vence.saturating_sub(ahora_ms))
    }

    pub fn rechazar(&mut self, codigo: ErrorCode) -> bool {
        let motivo = match codigo {
            ErrorCode::DeviceRevoked => RechazoHandy::Dispositivo,
            ErrorCode::LicenseExpired | ErrorCode::LicenseNotFound => RechazoHandy::Licencia,
            _ => return false,
        };
        self.foto.estado = ConexionHandy::Rechazada;
        self.foto.rechazo = Some(motivo);
        self.foto.main_online = None;
        self.foto.volcando = false;
        self.vence_gracia = None;
        true
    }

    /// Sólo se llama después del hello_ok validado y del main_status inicial.
    pub fn confirmar(&mut self, online: bool, volcando: bool) {
        self.foto.conexion += 1;
        self.foto.estado = ConexionHandy::Conectada;
        self.foto.main_online = Some(online);
        self.foto.volcando = volcando;
        self.foto.rechazo = None;
        self.vence_gracia = None;
    }

    /// Qué hacer al volver a primer plano. `edad_ultimo_pong_ms` es lo que hace del último `pong`
    /// de la conexión abierta, si la hay.
    ///
    /// Un intento que ya está en marcha (`Conectando`) no se corta por un aviso automático: en
    /// Android, volver de segundo plano y recuperar el foco llegan juntos, y cada uno cancelaba el
    /// intento del otro y pedía otro ticket. Si ese intento se quedó colgado al suspenderse el
    /// equipo, se espera el plazo del paso en que estaba (20 s: el ticket, abrir el socket, el
    /// saludo) y lo siguiente es reintentar. «Reintentar» (`forzar`) sí lo corta y empieza de nuevo.
    pub fn al_volver(&self, forzar: bool, edad_ultimo_pong_ms: Option<u64>) -> AlVolver {
        if forzar { return AlVolver::Reconectar; }
        // Volver a primer plano no convierte una revocación en un bucle de peticiones.
        if self.foto.rechazo.is_some() { return AlVolver::Nada; }
        if self.foto.estado == ConexionHandy::Conectando { return AlVolver::Nada; }
        if self.foto.estado != ConexionHandy::Conectada { return AlVolver::Reconectar; }
        match edad_ultimo_pong_ms {
            Some(edad) if edad <= PONG_CADUCADO_MS => AlVolver::Comprobar,
            _ => AlVolver::Reconectar,
        }
    }

    /// ¿Sigue abierta la conexión que se estaba comprobando? Un ping sin respuesta sólo corta ésa:
    /// si mientras tanto se cayó o se sustituyó, ya hay otra en marcha.
    pub fn es_la_conexion(&self, generacion: u64, conexion: u64) -> bool {
        self.foto.estado == ConexionHandy::Conectada && self.foto.generacion == generacion && self.foto.conexion == conexion
    }

    pub fn atender(&mut self, mensaje: Value) -> AppResult<Option<CambioReplicado>> {
        if self.foto.estado != ConexionHandy::Conectada { return Ok(None); }
        match mensaje.get("type").and_then(Value::as_str) {
            Some("main_status") => {
                let (online, volcando) = estado_main(&mensaje)?;
                self.foto.main_online = Some(online);
                self.foto.volcando = volcando;
            }
            Some("main_online") => self.foto.main_online = Some(true),
            Some("main_offline") => self.foto.main_online = Some(false),
            Some("main_volcando") => self.foto.volcando = booleano(&mensaje, "volcando")?,
            Some("change") => {
                let sentencias: Vec<SqlStatement> = serde_json::from_value(mensaje.get("statements").cloned().ok_or_else(|| AppError::external("Aviso sin cambios"))?)
                    .map_err(|_| AppError::external("Aviso de cambios inválido"))?;
                return Ok(Some(aviso(&sentencias)));
            }
            Some("error") => return Err(AppError::external("La nube rechazó un mensaje del socket")),
            _ => {}
        }
        Ok(None)
    }
}

pub fn estado_main(m: &Value) -> AppResult<(bool, bool)> {
    Ok((booleano(m, "online")?, booleano(m, "volcando")?))
}

fn booleano(m: &Value, campo: &str) -> AppResult<bool> {
    m.get(campo).and_then(Value::as_bool).ok_or_else(|| AppError::external("Presencia de la Main inválida"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn conectada() -> PresenciaHandy {
        let mut p = PresenciaHandy::default();
        p.activar(Some("negocio-a".into()), true); p.confirmar(true, false); p
    }
    #[test]
    fn una_caida_breve_conserva_la_presencia_y_no_extiende_la_gracia() {
        let mut p = conectada(); p.desconectar(1_000); p.desconectar(4_000);
        assert!(!p.vencer_gracia(5_999)); assert_eq!(p.foto.main_online, Some(true));
        assert!(p.vencer_gracia(6_000)); assert_eq!(p.foto.main_online, None);
    }
    #[test]
    fn reconectar_cancela_la_gracia_y_publica_una_nueva_conexion() {
        let mut p = conectada(); p.desconectar(0); p.confirmar(true, true);
        assert!(!p.vencer_gracia(6_000)); assert!(p.foto.volcando); assert_eq!(p.foto.conexion, 2);
    }
    #[test]
    fn una_revocacion_bloquea_al_instante_y_solo_una_confirmacion_la_retira() {
        let mut p = conectada(); assert!(p.rechazar(ErrorCode::DeviceRevoked));
        assert_eq!(p.foto.rechazo, Some(RechazoHandy::Dispositivo)); assert_eq!(p.foto.main_online, None);
        p.atender(json!({"type":"main_online"})).unwrap(); assert_eq!(p.foto.main_online, None);
        p.confirmar(false, false); assert!(p.foto.rechazo.is_none());
    }
    #[test]
    fn cambiar_de_vinculo_no_conserva_presencia_ni_volcado() {
        let mut p = conectada(); p.confirmar(true, true); let anterior = p.foto.generacion;
        p.activar(Some("negocio-b".into()), true);
        assert!(p.foto.generacion > anterior); assert_eq!(p.foto.main_online, None); assert!(!p.foto.volcando);
        p.activar(None, false); assert_eq!(p.foto.estado, ConexionHandy::Pausada);
    }
    #[test]
    fn un_aviso_de_cambio_no_expone_sentencias_ni_argumentos() {
        let mut p = conectada();
        let aviso = p.atender(json!({"type":"change","statements":[{"sql":"UPDATE Detalle_Comanda SET Cantidad=?1 WHERE ID_Comanda=?2","args":[2,"c1"]}]})).unwrap().unwrap();
        assert_eq!(aviso.comanda.ids, vec!["c1"]);
        let serializado = serde_json::to_string(&aviso).unwrap(); assert!(!serializado.contains("sql")); assert!(!serializado.contains("Cantidad"));
    }
    #[test]
    fn una_presencia_malformada_no_desbloquea() {
        let mut p = conectada(); p.confirmar(false, false);
        assert!(p.atender(json!({"type":"main_status","online":"false","volcando":false})).is_err());
        assert_eq!(p.foto.main_online, Some(false));
    }
    #[test]
    fn volver_a_primer_plano_con_la_conexion_abierta_la_comprueba_sin_cortarla() {
        let p = conectada();
        assert_eq!(p.al_volver(false, Some(0)), AlVolver::Comprobar);
        assert_eq!(p.al_volver(false, Some(PONG_CADUCADO_MS)), AlVolver::Comprobar);
    }
    #[test]
    fn un_ultimo_pong_viejo_reconecta_sin_esperar_a_otro() {
        // El latido va cada 30 s: pasado ese margen, el anterior ya se quedó sin respuesta (o el
        // equipo ha estado suspendido). Y sin latido que mirar, tampoco hay nada que comprobar.
        let p = conectada();
        assert_eq!(p.al_volver(false, Some(PONG_CADUCADO_MS + 1)), AlVolver::Reconectar);
        assert_eq!(p.al_volver(false, None), AlVolver::Reconectar);
    }
    #[test]
    fn sin_conexion_volver_a_primer_plano_reconecta_ya() {
        // Esperando para reintentar: volver despierta la espera y se intenta ya.
        let mut p = conectada(); p.desconectar(0);
        assert_eq!(p.al_volver(false, Some(0)), AlVolver::Reconectar);
        let mut p = PresenciaHandy::default(); p.activar(None, true);
        assert_eq!(p.foto.estado, ConexionHandy::SinIdentidad);
        assert_eq!(p.al_volver(false, None), AlVolver::Reconectar);
    }
    #[test]
    fn un_intento_en_marcha_no_lo_corta_un_aviso_automatico_pero_si_el_boton() {
        // Android avisa a la vez de que la aplicación vuelve y de que recupera el foco: el segundo
        // aviso no cancela el intento que abrió el primero ni pide otro ticket.
        let mut p = PresenciaHandy::default(); p.activar(Some("negocio-a".into()), true);
        assert_eq!(p.foto.estado, ConexionHandy::Conectando);
        assert_eq!(p.al_volver(false, None), AlVolver::Nada);
        assert_eq!(p.al_volver(false, Some(0)), AlVolver::Nada);
        assert_eq!(p.al_volver(true, None), AlVolver::Reconectar);
        // Y al caer ese intento, el siguiente aviso ya reconecta.
        p.desconectar(0);
        assert_eq!(p.al_volver(false, None), AlVolver::Reconectar);
    }
    #[test]
    fn un_rechazo_no_se_reintenta_al_volver_pero_si_con_el_boton() {
        let mut p = conectada(); assert!(p.rechazar(ErrorCode::DeviceRevoked));
        assert_eq!(p.al_volver(false, None), AlVolver::Nada);
        assert_eq!(p.al_volver(true, None), AlVolver::Reconectar);
        // El botón reconecta siempre, también con la conexión sana.
        assert_eq!(conectada().al_volver(true, Some(0)), AlVolver::Reconectar);
    }
    #[test]
    fn un_ping_sin_respuesta_solo_corta_la_conexion_que_se_comprobaba() {
        let mut p = conectada();
        let (generacion, conexion) = (p.foto.generacion, p.foto.conexion);
        assert!(p.es_la_conexion(generacion, conexion));
        // Se cayó sola mientras se esperaba el pong: ya se está reconectando.
        p.desconectar(0); assert!(!p.es_la_conexion(generacion, conexion));
        // Ya hay una conexión nueva: el ping era de la anterior.
        p.confirmar(true, false); assert!(!p.es_la_conexion(generacion, conexion));
        // Otro vínculo, aunque su contador de conexiones coincida.
        let mut otro = conectada(); otro.activar(Some("negocio-b".into()), true);
        otro.foto.conexion = conexion - 1; otro.confirmar(true, false);
        assert_eq!(otro.foto.conexion, conexion); assert!(!otro.es_la_conexion(generacion, conexion));
    }
    #[test]
    fn sin_identidad_no_acepta_presencia_y_la_licencia_se_distingue_de_la_red() {
        let mut p = PresenciaHandy::default(); p.activar(None, true);
        p.atender(json!({"type":"main_online"})).unwrap(); assert_eq!(p.foto.main_online, None);
        assert!(!p.rechazar(ErrorCode::External)); assert!(p.rechazar(ErrorCode::LicenseExpired));
        assert_eq!(p.foto.rechazo, Some(RechazoHandy::Licencia));
    }
}
