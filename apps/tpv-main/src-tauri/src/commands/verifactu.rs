//! Comandos Tauri de **Veri\*factu** (FISCAL-01). Capa fina: ni SQL ni reglas.
//!
//! Los tres son de LECTURA. La emisión no tiene comando propio a propósito: ocurre **dentro de la
//! transacción del cobro**, en el repositorio, porque ahí es donde está la transacción. Un comando
//! «emitir registro» sería la puerta a expedir una factura sin registro (o al revés), que es la
//! única forma de romper esto de verdad.

use tauri::State;

use tpv_application::use_cases::verifactu as uc;
use tpv_contracts::errors::AppErrorDto;
use tpv_contracts::verifactu::{BloqueFiscal, EstadoFiscal, RegistroFiscal};

use crate::{AppState, ADMIN};

/// El bloque fiscal de un ticket (número, QR y huella), por su número de factura.
///
/// Sirve igual para **imprimir** y para **reimprimir**: una reimpresión saca los mismos tres, y por
/// eso se leen de la fila en vez de recalcularse — recalcular daría otra hora de generación y, por
/// tanto, otra huella.
///
/// Devuelve `null` si el número está vacío o no tiene registro: es el caso de la **precuenta**, que
/// no es una factura y por tanto no lleva ni registro ni QR. Que no sea un error es lo que permite
/// que la precuenta y el ticket compartan el mismo camino de impresión.
///
/// Sin exigir rol: lo llama la impresión, que hace cualquiera que pueda cobrar.
#[tauri::command]
pub async fn verifactu_bloque_ticket(
    state: State<'_, AppState>,
    numero_ticket: String,
) -> Result<Option<BloqueFiscal>, AppErrorDto> {
    let repo = state.verifactu_repo().await?;
    Ok(uc::bloque_por_numero(repo.as_ref(), &numero_ticket).await?)
}

/// Resumen del estado fiscal para Configuración → Fiscal y para la escalera de avisos.
///
/// Sin exigir rol tampoco: el escalón de aviso lo pinta la barra de estado, que ve todo el mundo, y
/// el objetivo de la escalera es justamente que **no se pueda ignorar**.
#[tauri::command]
pub async fn verifactu_estado(state: State<'_, AppState>) -> Result<EstadoFiscal, AppErrorDto> {
    let repo = state.verifactu_repo().await?;
    Ok(uc::estado(repo.as_ref()).await?)
}

/// Los registros del panel, del más reciente al más antiguo.
///
/// Este sí es de Administrador: es el libro de facturación del negocio.
#[tauri::command]
pub async fn verifactu_listar(
    state: State<'_, AppState>,
    limite: Option<i64>,
    desplazamiento: Option<i64>,
) -> Result<Vec<RegistroFiscal>, AppErrorDto> {
    state.exigir_rol(&[ADMIN]).await?;
    let repo = state.verifactu_repo().await?;
    Ok(uc::listar(repo.as_ref(), limite, desplazamiento).await?)
}
