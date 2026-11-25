//! DO-SUBIDA · La Main sube su base entera a una nube que soporte le ha devuelto en modo «main».
//!
//! Soporte puede darle a un negocio una base vacía, su copia de R2 o devolver la suya a un instante.
//! Con `--modo main`, la Main es la buena y sigue con su base, y el `TenantHub` apunta una petición
//! de subida completa que la Main recibe en su `hello_ok` (`subida: {id, estado, origen}`). Entonces
//! la Main recorre sus tablas de negocio y sube lo que la nube no tiene o tiene distinto, por pasos
//! (`{type: "subida", …}`), reanudable y sin escribir en su outbox. Lo que es SQL vive en el
//! repositorio (`tpv-infra-sqlite/src/subida_completa.rs`); el motor de réplica
//! (`use_cases/replicacion.rs`) decide cuándo se da cada paso y lo manda por el socket.

use std::time::Duration;

use async_trait::async_trait;
use serde_json::Value;

use crate::error::AppResult;

/// La petición de subida completa que trae el `hello_ok` de la Main.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeticionDeSubida {
    pub id: String,
    /// La nube ya la da por terminada (llegó su `fin`): sólo queda confirmarla con el contraste.
    pub terminada: bool,
    /// `instante`, `copia` o `base_vacia`.
    pub origen: String,
}

impl PeticionDeSubida {
    /// La del `hello_ok`, si la trae y está bien formada. Un worker anterior no la manda nunca.
    pub fn del_saludo(hello: &Value) -> Option<Self> {
        let s = hello.get("subida")?;
        let id = s.get("id")?.as_str().filter(|t| !t.is_empty() && t.len() <= 200)?.to_string();
        let terminada = match s.get("estado")?.as_str()? {
            "esperando" => false,
            "terminada" => true,
            _ => return None,
        };
        let origen = s.get("origen")?.as_str().filter(|o| matches!(*o, "instante" | "copia" | "base_vacia"))?.to_string();
        Some(Self { id, terminada, origen })
    }
}

/// Lo que se ha decidido al conciliar lo que dice la nube con lo que hay aquí.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Conciliacion {
    /// No hay subida que hacer ni que confirmar.
    Nada,
    /// Una subida nueva, desde cero.
    Empezar,
    /// La que había a medias sigue por sus cursores.
    Seguir,
    /// La nube la da por terminada: queda confirmarla con el contraste.
    Contrastar,
    /// Había una a medias y la nube ya no la pide (modo nube, caducada, huérfana, agotada o un
    /// worker anterior): se deja.
    Abandonada,
}

/// Lo que ha hecho un paso de la subida.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PasoHecho {
    /// Ha avanzado: el siguiente puede ir ya.
    Avanza,
    /// Hay operaciones del outbox por subir: van antes.
    PorSubir,
    /// La nube tiene algo de otro dispositivo que esta Main no ha bajado: ponerse al día antes.
    Aplazada,
    /// Un rechazo pasajero (el presupuesto de la hora, la base cerrada): no antes de esto.
    Esperar(Duration),
    /// No ha llegado el acuse: es el transporte, y la sesión acaba ahí.
    SinAcuse,
    /// No hay nada que subir (sin subida, o ya entregada a la nube).
    Nada,
}

/// Manda un paso por el socket y espera su acuse, atendiendo entretanto lo demás que llegue.
#[async_trait]
pub trait EnvioDeSubida: Send {
    /// `None`: no ha llegado el acuse a tiempo. No dice nada del paso.
    async fn mandar(&mut self, paso: Value) -> AppResult<Option<Value>>;
}

/// El estado local de la subida y sus pasos.
#[async_trait]
pub trait SubidaCompleta: Send + Sync {
    /// Lo que dice la nube (la petición del saludo, o ninguna) frente a lo que hay aquí. Deja aquí
    /// lo que toque: empezar de cero, seguir, pasar a contrastar o abandonar.
    async fn conciliar(&self, peticion: Option<&PeticionDeSubida>) -> AppResult<Conciliacion>;
    /// ¿Queda algo que mandar a la nube?
    async fn pendiente(&self) -> AppResult<bool>;
    /// ¿Está subido el núcleo (lo vivo y lo imprescindible para trabajar)? Sin subida en curso, sí.
    async fn nucleo_hecho(&self) -> AppResult<bool>;
    /// Un paso: lo siguiente que toca, mandado y confirmado aquí.
    async fn paso(&self, envio: &mut dyn EnvioDeSubida) -> AppResult<PasoHecho>;
    /// Las Handy se sueltan sin el núcleo subido (`NUCLEO_COMO_MUCHO`): se avisa.
    fn sueltas_sin_nucleo(&self) {}
}
