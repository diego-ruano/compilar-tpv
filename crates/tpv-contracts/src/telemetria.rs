//! Contrato del registro de **los fallos de comandos**.
//!
//! Todo comando pasa por `invocar` (`@tpv/client`). Cuando uno falla, la pantalla lo cuenta con
//! `telemetria_fallo_de_comando` y Rust lo escribe con `tracing`: así llega al log local y a Axiom
//! por la misma cola en disco que el resto (docs/arquitectura/observabilidad.md).

use serde::{Deserialize, Serialize};

use crate::errors::ErrorCode;

/// Qué clase de fallo es. La decide la pantalla por el código, con una tabla exhaustiva
/// (`fallosDeComandos.ts`): un código nuevo no compila hasta que alguien le asigne una.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum GravedadFallo {
    /// Una respuesta esperada: un dato que no vale, un PIN mal puesto, un permiso que no se tiene.
    Normal,
    /// Algo de fuera que no es un fallo del programa: la red, la impresora, la Main apagada.
    Entorno,
    /// Un fallo del programa: hay que mirarlo.
    Programa,
}

/// Un comando que ha fallado, tal como lo cuenta la pantalla.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct FalloDeComando {
    /// Nombre del comando (`printer_imprimir_pago`).
    pub comando: String,
    pub code: ErrorCode,
    pub gravedad: GravedadFallo,
    /// El texto del error. Sólo viaja en los de `entorno` y `programa`: el de una respuesta
    /// esperada puede llevar lo que ha escrito alguien, y para saber que pasa basta el código.
    pub mensaje: Option<String>,
    /// Ruta de la pantalla desde la que se llamó.
    pub pantalla: Option<String>,
    /// Lo que tardó el comando en fallar.
    pub duracion_ms: u32,
    /// Cuántas veces cuenta este aviso: 1, o las que se juntaron en la ventana de un minuto.
    pub veces: u32,
}
