//! Comandos Tauri del **registro de facturación** (FISCAL-01). Capa fina: ni SQL ni reglas.
//!
//! La emisión de un alta no tiene comando propio a propósito: ocurre **dentro de la transacción
//! del cobro** (o de la baja de un cobro), en el repositorio, porque ahí es donde está la
//! transacción. Un comando «emitir registro» sería la puerta a expedir una factura sin registro (o
//! al revés), que es la única forma de romper esto de verdad. Los únicos que escriben un registro
//! son la `F3` de un ticket ya expedido y la corrección del cliente de una factura completa, y los
//! dos parten de un registro que ya existe.

use tauri::State;

use tpv_application::use_cases::verifactu as uc;
use tpv_contracts::errors::AppErrorDto;
use tpv_contracts::verifactu::{BloqueFiscal, CanjeableDto, EstadoFiscal};

use crate::{AppState, ADMIN};

/// ¿Están los datos fiscales del negocio? Lo leen el aviso de datos fiscales y Configuración →
/// Fiscal.
///
/// Sin exigir rol: el aviso sale a quien esté delante, porque sin esos datos el siguiente cobro
/// va a fallar.
#[tauri::command]
#[specta::specta]
pub async fn verifactu_estado(state: State<'_, AppState>) -> Result<EstadoFiscal, AppErrorDto> {
    let repo = state.verifactu_repo().await?;
    Ok(uc::estado(repo.as_ref()).await?)
}

/// Emite una **factura completa en sustitución** de los tickets de unos cobros (`F3`,
/// FISCAL-02): uno, o varios del mismo cliente en una sola factura.
///
/// Es el camino del cliente que vuelve con el ticket —o con los de un periodo— y pide factura. Los
/// tickets **no se tocan**: canjearlos por una completa no es rectificarlos (art. 15.6 ROF), así
/// que se emite una `F3` que los sustituye y que sí lleva destinatario.
///
/// Es de Administrador, como el resto de Cuentas: emite un documento fiscal nuevo.
#[tauri::command]
#[specta::specta]
pub async fn verifactu_emitir_factura_de_tickets(
    state: State<'_, AppState>,
    id_pagos: Vec<String>,
    destinatario: tpv_contracts::verifactu::DestinatarioInput,
) -> Result<BloqueFiscal, AppErrorDto> {
    state.exigir_rol(&[ADMIN]).await?;
    let repo = state.verifactu_repo().await?;
    Ok(uc::emitir_sustitutiva(repo.as_ref(), &id_pagos, destinatario).await?)
}

/// Qué tickets de estos cobros se pueden canjear por una factura completa, y por qué no los que no
/// (DOC-INC-01). Lo pide Cuentas al elegir varios tickets para una factura: así la casilla de uno ya
/// facturado sale desactivada con el motivo, en vez de rechazarlo al final. Administrador, como
/// emitirla.
#[tauri::command]
#[specta::specta]
pub async fn verifactu_facturas_canjeables(
    state: State<'_, AppState>,
    id_pagos: Vec<String>,
) -> Result<Vec<CanjeableDto>, AppErrorDto> {
    state.exigir_rol(&[ADMIN]).await?;
    let repo = state.verifactu_repo().await?;
    Ok(uc::facturas_canjeables(repo.as_ref(), &id_pagos).await?)
}

/// Corrige los datos del cliente de una factura completa ya expedida (una `F3` o una `F1`).
/// Devuelve la factura nueva, que es la que se imprime. Administrador, como emitirla.
#[tauri::command]
#[specta::specta]
pub async fn verifactu_corregir_factura(
    state: State<'_, AppState>,
    num_factura: String,
    destinatario: tpv_contracts::verifactu::DestinatarioInput,
) -> Result<BloqueFiscal, AppErrorDto> {
    state.exigir_rol(&[ADMIN]).await?;
    let repo = state.verifactu_repo().await?;
    Ok(uc::corregir_factura(repo.as_ref(), &num_factura, destinatario).await?)
}
