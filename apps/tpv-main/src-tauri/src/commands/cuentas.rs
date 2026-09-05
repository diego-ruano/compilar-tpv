//! Comandos Tauri de cuentas/caja (capa fina hexagonal).
//!
//! SEC-01: **toda la sección es de administrador**, lecturas incluidas. No es una ampliación
//! del gate por gusto: `PLAN_CIERRE_CAJA.md` §8 ya lo decidió ("el gate por rol en la ruta del
//! frontend y, sobre todo, en los comandos Tauri"), y hasta ahora sólo existía la mitad de UI.
//! El libro de caja dice cuánto se factura y cuánto se gasta; esconderlo del menú no es
//! esconderlo. En los que además tocan un apunte, el rol va ANTES del gate de periodo: no hay
//! por qué consultar la BD por alguien que de todos modos no puede cambiar nada.

use tauri::State;

use tpv_application::ports::cierre_caja::ApunteCaja;
use tpv_application::use_cases::cierre_caja as cierre_uc;
use tpv_application::use_cases::cuentas as uc;
use tpv_contracts::cuentas::{
    AnularPagoInput, CreateGastoInput, CuentasRangoArgs, DeleteGastoInput, EntradaDto,
    ResumenCajaDto, SalidaDto, TicketReimpresionDto, UpdateGastoInput, UpdatePagoInput,
};
use crate::{AppState, ADMIN};
use tpv_contracts::errors::AppErrorDto;

#[tauri::command]
pub async fn cuentas_get_entradas(
    state: State<'_, AppState>,
    args: CuentasRangoArgs,
) -> Result<Vec<EntradaDto>, AppErrorDto> {
    state.exigir_rol(&[ADMIN]).await?;
    let repo = state.cuentas_repo().await?;
    Ok(uc::get_entradas(repo.as_ref(), args).await?)
}

#[tauri::command]
pub async fn cuentas_get_salidas(
    state: State<'_, AppState>,
    args: CuentasRangoArgs,
) -> Result<Vec<SalidaDto>, AppErrorDto> {
    state.exigir_rol(&[ADMIN]).await?;
    let repo = state.cuentas_repo().await?;
    Ok(uc::get_salidas(repo.as_ref(), args).await?)
}

#[tauri::command]
pub async fn cuentas_get_resumen(
    state: State<'_, AppState>,
    args: CuentasRangoArgs,
) -> Result<ResumenCajaDto, AppErrorDto> {
    state.exigir_rol(&[ADMIN]).await?;
    let repo = state.cuentas_repo().await?;
    Ok(uc::get_resumen(repo.as_ref(), args).await?)
}

#[tauri::command]
pub async fn cuentas_create_gasto(
    state: State<'_, AppState>,
    args: CreateGastoInput,
) -> Result<bool, AppErrorDto> {
    // Quién registra el gasto sale de la sesión: va al historial de caja (CUENTA-07).
    let sesion = state.exigir_rol(&[ADMIN]).await?;
    let repo = state.cuentas_repo().await?;
    Ok(uc::create_gasto(repo.as_ref(), Some(&sesion.id_usuario), args).await?)
}

/// Gate del cierre de caja (CUENTA-06): un cobro o un gasto de un periodo ya cerrado no se toca.
///
/// Vive aquí, delante de los cuatro comandos que modifican caja, y no en la pantalla: un candado que
/// sólo está en la interfaz no es un candado. La fecha se lee de la BD y no se acepta de la entrada,
/// porque en un borrado sólo llega el id y porque fiarse de la fecha que manda quien quiere borrar
/// es no tener gate.
///
/// Si el apunte no existe se deja pasar: no es cosa de este gate decidir eso, y el comando de abajo
/// ya devuelve `false` cuando no encuentra la fila.
async fn exigir_periodo_abierto(
    state: &State<'_, AppState>,
    tipo: ApunteCaja,
    id: &str,
) -> Result<(), AppErrorDto> {
    let repo = state.cierre_caja_repo().await?;
    if let Some(fecha) = repo.fecha_apunte(tipo, id).await? {
        cierre_uc::exigir_periodo_abierto(repo.as_ref(), &fecha).await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn cuentas_update_gasto(
    state: State<'_, AppState>,
    args: UpdateGastoInput,
) -> Result<bool, AppErrorDto> {
    state.exigir_rol(&[ADMIN]).await?;
    exigir_periodo_abierto(&state, ApunteCaja::Gasto, &args.id_gasto).await?;
    let repo = state.cuentas_repo().await?;
    Ok(uc::update_gasto(repo.as_ref(), args).await?)
}

#[tauri::command]
pub async fn cuentas_delete_gasto(
    state: State<'_, AppState>,
    args: DeleteGastoInput,
) -> Result<bool, AppErrorDto> {
    let sesion = state.exigir_rol(&[ADMIN]).await?;
    exigir_periodo_abierto(&state, ApunteCaja::Gasto, &args.id_gasto).await?;
    let repo = state.cuentas_repo().await?;
    Ok(uc::delete_gasto(repo.as_ref(), Some(&sesion.id_usuario), args).await?)
}

#[tauri::command]
pub async fn cuentas_update_pago(
    state: State<'_, AppState>,
    args: UpdatePagoInput,
) -> Result<bool, AppErrorDto> {
    state.exigir_rol(&[ADMIN]).await?;
    exigir_periodo_abierto(&state, ApunteCaja::Pago, &args.id_pago).await?;
    let repo = state.cuentas_repo().await?;
    Ok(uc::update_pago(repo.as_ref(), args).await?)
}

/// Anula un cobro (CUENTA-07). Antes lo borraba, y ése era el agujero: el arqueo calcula
/// `esperado = fondo + cobros en efectivo`, así que borrar la fila de una venta en efectivo bajaba
/// el esperado exactamente lo mismo que faltaba en el cajón y el descuadre salía cero.
///
/// Quién anula sale de la **sesión** (SEC-01) y nunca del input: una anulación firmada con el
/// nombre que le pase la pantalla es una auditoría que da confianza sin merecerla.
#[tauri::command]
pub async fn cuentas_anular_pago(
    state: State<'_, AppState>,
    args: AnularPagoInput,
) -> Result<bool, AppErrorDto> {
    let sesion = state.exigir_rol(&[ADMIN]).await?;
    exigir_periodo_abierto(&state, ApunteCaja::Pago, &args.id_pago).await?;
    let repo = state.cuentas_repo().await?;
    Ok(uc::anular_pago(repo.as_ref(), &sesion.id_usuario, args).await?)
}

/// Devuelve un ticket ya cobrado para volver a imprimirlo: mismo número, mismos tipos de IVA y las
/// mismas líneas que cobró ese pago (no las de la comanda entera, que en un cobro fraccionado
/// serían otras). Quien imprime lo marca como COPIA.
#[tauri::command]
pub async fn cuentas_ticket_para_reimprimir(
    state: State<'_, AppState>,
    id_pago: String,
) -> Result<Option<TicketReimpresionDto>, AppErrorDto> {
    state.exigir_rol(&[ADMIN]).await?;
    let repo = state.cuentas_repo().await?;
    Ok(uc::ticket_para_reimprimir(repo.as_ref(), &id_pago).await?)
}
