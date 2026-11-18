//! RI-31/RI-57: el transporte de réplica es una capacidad interna, nunca un IPC de SQL.
use std::sync::{Arc, Mutex};
use async_trait::async_trait;
use tpv_contracts::sync::SqlStatement;
use crate::{error::AppResult, ports::sync::SyncRepository};

pub use crate::ports::canal_nube::CanalNube as CanalReplicacion;

/// Las operaciones que lleva un lote como mucho (`apply_lote`). Es también lo que el `TenantHub`
/// aplica de una vez (`LOTE_MAX_OPS`, en `tenantHub.motor.ts`).
pub const LOTE_MAX_OPS: usize = 200;

/// Cuántas operaciones lleva el siguiente lote de la subida. Vive lo que el proceso, no lo que una
/// sesión: un lote que la nube no contesta acaba con la sesión, y es la siguiente la que tiene que
/// saberlo.
///
/// Un lote sin respuesta no dice nada de sus operaciones (el transporte no cuenta como intento),
/// pero dos seguidos pueden ser un lote que la nube no consigue atender. Entonces se baja a lotes de
/// una: lo que pueda entrar entra, y lo que no, queda señalado. Cada lote aplicado dobla el
/// siguiente hasta volver al tope.
#[derive(Debug)]
pub struct RitmoDeSubida {
    /// (lotes seguidos sin respuesta, operaciones del siguiente lote)
    estado: Mutex<(u32, usize)>,
}

impl Default for RitmoDeSubida {
    fn default() -> Self {
        Self { estado: Mutex::new((0, LOTE_MAX_OPS)) }
    }
}

impl RitmoDeSubida {
    fn con<T>(&self, f: impl FnOnce(&mut (u32, usize)) -> T) -> T {
        f(&mut self.estado.lock().unwrap_or_else(|e| e.into_inner()))
    }
    /// Las operaciones del lote que se va a mandar ahora.
    pub fn tamano_del_lote(&self) -> usize {
        self.con(|(sin_respuesta, tope)| {
            if *sin_respuesta >= 2 { *tope = 1; }
            *tope
        })
    }
    /// Sale un lote: hasta que llegue su acuse cuenta como sin respuesta.
    pub fn lote_enviado(&self) {
        self.con(|(sin_respuesta, _)| *sin_respuesta += 1);
    }
    /// La nube ha contestado al lote, lo que sea.
    pub fn lote_respondido(&self) {
        self.con(|(sin_respuesta, _)| *sin_respuesta = 0);
    }
    /// El lote se ha aplicado: el siguiente puede llevar el doble.
    pub fn crecer(&self) {
        self.con(|(_, tope)| *tope = (*tope * 2).min(LOTE_MAX_OPS));
    }
    /// La nube ha rechazado el lote entero sin decir por cuál: de una en una se sabe.
    pub fn de_una_en_una(&self) {
        self.con(|(_, tope)| *tope = 1);
    }
}

#[async_trait]
pub trait ContextoReplicacion: Send + Sync {
    /// Se adquiere sólo mientras se usa: retener la Db impediría restaurar una copia en Windows.
    async fn repositorio(&self) -> AppResult<Arc<dyn SyncRepository>>;
    fn cambios(&self, sentencias: &[SqlStatement]);
    fn fase_recuperacion(&self, fase: &str);
    fn solicitud_emparejamiento(&self);
    /// Que se recojan las reservas web de la agenda (docs/estudios/reservas-web.md §5.4). Sin
    /// esperar: la recogida va por REST, fuera del bucle del socket, y escribe por el outbox que el
    /// motor sube en su vuelta siguiente.
    fn reservas_web(&self);
    fn fallo_subida(&self, op_id: &str, fallo: &tpv_contracts::sync::OutboxFallo);
    async fn completar_recuperacion(&self, high_water: i64) -> AppResult<()>;
    async fn sigue_disponible(&self, recuperando: bool) -> AppResult<bool>;
    /// El ritmo de la subida, el mismo para todas las sesiones de este proceso.
    fn ritmo_de_subida(&self) -> Arc<RitmoDeSubida>;
    /// Si las Handy siguen retenidas: desde el saludo (que las congela) hasta que esta sesión manda
    /// `recovery_ready`. Lo enseña Conectividad, que sólo dice que los Handy esperan cuando es así;
    /// un outbox con algo por subir en uso normal no los retiene.
    fn handy_retenidas(&self, _retenidas: bool) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dos_lotes_sin_respuesta_bajan_a_lotes_de_una_y_cada_lote_aplicado_dobla_el_siguiente() {
        let r = RitmoDeSubida::default();
        assert_eq!(r.tamano_del_lote(), LOTE_MAX_OPS);
        // Uno sin respuesta no cambia nada: pudo ser la red.
        r.lote_enviado();
        assert_eq!(r.tamano_del_lote(), LOTE_MAX_OPS);
        // Dos seguidos: de una en una.
        r.lote_enviado();
        assert_eq!(r.tamano_del_lote(), 1);
        // Y si tampoco contesta a ésa, se insiste con ella sola.
        r.lote_enviado();
        assert_eq!(r.tamano_del_lote(), 1);
        // Contesta y se aplica: 2, 4, 8… hasta el tope.
        let mut vistos = Vec::new();
        for _ in 0..10 {
            r.lote_respondido();
            r.crecer();
            vistos.push(r.tamano_del_lote());
            r.lote_enviado();
        }
        assert_eq!(vistos, vec![2, 4, 8, 16, 32, 64, 128, 200, 200, 200]);
    }

    #[test]
    fn una_respuesta_entre_dos_silencios_no_baja_el_ritmo() {
        let r = RitmoDeSubida::default();
        r.lote_enviado();
        r.lote_respondido();
        r.crecer();
        r.lote_enviado();
        assert_eq!(r.tamano_del_lote(), LOTE_MAX_OPS);
    }

    #[test]
    fn un_lote_rechazado_entero_se_repite_de_una_en_una() {
        let r = RitmoDeSubida::default();
        r.lote_enviado();
        r.lote_respondido();
        r.de_una_en_una();
        assert_eq!(r.tamano_del_lote(), 1);
    }
}
