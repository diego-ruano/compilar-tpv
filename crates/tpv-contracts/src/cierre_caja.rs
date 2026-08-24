//! DTOs del **cierre de caja** (arqueo). CUENTA-06.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Una moneda o billete del recuento.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct DenominacionDto {
    pub valor: f64,
    #[ts(type = "number")]
    pub unidades: i64,
}

/// Un cierre completo, con su doble recuento. Lo que pinta la ficha del histórico.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct CierreDto {
    pub id_cierre: String,
    pub fecha_hora: String,
    #[ts(optional)]
    pub id_usuario: Option<String>,
    /// Nombre de quien cerró, resuelto al leer (la fila sólo guarda el id).
    #[ts(optional)]
    pub usuario_nombre: Option<String>,
    pub fondo_inicial: f64,
    pub ventas_efectivo: f64,
    pub esperado: f64,
    pub contado: f64,
    pub descuadre: f64,
    pub dejado: f64,
    pub retirado: f64,
    #[ts(optional)]
    pub motivo: Option<String>,
    /// `None` = el cierre sigue en pie y su periodo está bloqueado.
    #[ts(optional)]
    pub reabierto_en: Option<String>,
    #[ts(optional)]
    pub reabierto_por: Option<String>,
    pub contado_denoms: Vec<DenominacionDto>,
    pub dejado_denoms: Vec<DenominacionDto>,
}

/// Una fila del histórico. Sin el desglose por denominación, que sólo se pide al abrir la ficha.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct CierreResumenDto {
    pub id_cierre: String,
    pub fecha_hora: String,
    #[ts(optional)]
    pub usuario_nombre: Option<String>,
    pub esperado: f64,
    pub contado: f64,
    pub descuadre: f64,
    pub retirado: f64,
    #[ts(optional)]
    pub motivo: Option<String>,
    #[ts(optional)]
    pub reabierto_en: Option<String>,
}

/// Lo que la pantalla necesita saber **antes** de que nadie cuente nada.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct PreparacionCierreDto {
    /// Desde cuándo está abierto el periodo. `None` = no hay ningún cierre previo, así que éste es
    /// el primero y la pantalla tiene que pedir además el fondo de partida.
    #[ts(optional)]
    pub desde: Option<String>,
    /// `true` en el primer cierre de la vida del negocio.
    pub es_primer_cierre: bool,
    /// Lo que dejó el cierre anterior. En el primero es 0 y lo declara el usuario.
    pub fondo_inicial: f64,
    pub ventas_efectivo: f64,
    pub esperado: f64,
    /// Comandas sin cobrar ahora mismo. No impide cerrar: se avisa y se sigue.
    #[ts(type = "number")]
    pub comandas_abiertas: i64,
    /// A partir de cuánto descuadre hay que escribir un motivo.
    pub umbral_descuadre: f64,
}

/* =========================================================
   Entrada (args/inputs)
========================================================= */

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct DenominacionInput {
    pub valor: f64,
    #[ts(type = "number")]
    pub unidades: i64,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct ConfirmarCierreInput {
    /// Sólo se usa en el primer cierre; en los demás manda el `dejado` del anterior y esto se
    /// ignora, para que nadie pueda reescribir el punto de partida a posteriori.
    #[serde(default)]
    #[ts(optional)]
    pub fondo_inicial: Option<f64>,
    pub contado: Vec<DenominacionInput>,
    pub dejado: Vec<DenominacionInput>,
    #[serde(default)]
    #[ts(optional)]
    pub motivo: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub id_usuario: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct CierreIdInput {
    pub id_cierre: String,
    #[serde(default)]
    #[ts(optional)]
    pub id_usuario: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct CierreListarArgs {
    #[serde(default)]
    #[ts(optional)]
    pub limite: Option<i64>,
}
