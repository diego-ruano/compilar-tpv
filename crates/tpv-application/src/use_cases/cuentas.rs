//! Casos de uso de cuentas (caja). Local-First.
//!
//! Nota de compatibilidad: importes/ids inválidos devuelven `Ok(false)` (no error),
//! igual que el backend antiguo; los campos de texto vacíos sí son error de validación.

use tpv_contracts::cuentas::{
    CreateGastoInput, CuentasRangoArgs, DeleteGastoInput, DeletePagoInput, EntradaDto,
    ResumenCajaDto, SalidaDto, UpdateGastoInput, UpdatePagoInput,
};
use tpv_domain::cuentas::{normalize_metodo, requerido, GastoData, PagoData};

use crate::error::{AppError, AppResult};
use crate::ports::cuentas::{CuentasFiltro, CuentasRepository};

fn filtro_de(args: CuentasRangoArgs) -> CuentasFiltro {
    CuentasFiltro {
        del: args.del,
        al: args.al,
        q: args.q,
        page: args.page,
        page_size: args.page_size,
    }
}

pub async fn get_entradas(
    repo: &dyn CuentasRepository,
    args: CuentasRangoArgs,
) -> AppResult<Vec<EntradaDto>> {
    repo.entradas(filtro_de(args)).await
}

pub async fn get_salidas(
    repo: &dyn CuentasRepository,
    args: CuentasRangoArgs,
) -> AppResult<Vec<SalidaDto>> {
    repo.salidas(filtro_de(args)).await
}

pub async fn get_resumen(
    repo: &dyn CuentasRepository,
    args: CuentasRangoArgs,
) -> AppResult<ResumenCajaDto> {
    repo.resumen(args.del, args.al, args.q).await
}

fn proveedor_para(tipo_gasto: &str, proveedor_id: Option<String>) -> Option<String> {
    if tipo_gasto == "Proveedor" {
        proveedor_id
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    } else {
        None
    }
}

pub async fn create_gasto(repo: &dyn CuentasRepository, input: CreateGastoInput) -> AppResult<bool> {
    let fecha = requerido(&input.fecha, "fecha").map_err(AppError::validation)?;
    let tipo_gasto = requerido(&input.tipo_gasto, "tipo_gasto").map_err(AppError::validation)?;
    let concepto = requerido(&input.concepto, "concepto").map_err(AppError::validation)?;

    if !input.importe.is_finite() || input.importe <= 0.0 {
        return Ok(false);
    }

    let proveedor_id = proveedor_para(&tipo_gasto, input.proveedor_id);
    let gasto = GastoData {
        fecha,
        tipo_gasto,
        concepto,
        importe: input.importe,
        proveedor_id,
    };
    let id = input
        .id_gasto
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    repo.crear_gasto(id, gasto).await
}

pub async fn update_gasto(repo: &dyn CuentasRepository, input: UpdateGastoInput) -> AppResult<bool> {
    let fecha = requerido(&input.fecha, "fecha").map_err(AppError::validation)?;
    let tipo_gasto = requerido(&input.tipo_gasto, "tipo_gasto").map_err(AppError::validation)?;
    let concepto = requerido(&input.concepto, "concepto").map_err(AppError::validation)?;

    if input.id_gasto.trim().is_empty() || !input.importe.is_finite() || input.importe <= 0.0 {
        return Ok(false);
    }

    let proveedor_id = proveedor_para(&tipo_gasto, input.proveedor_id);
    let gasto = GastoData {
        fecha,
        tipo_gasto,
        concepto,
        importe: input.importe,
        proveedor_id,
    };
    repo.actualizar_gasto(&input.id_gasto, gasto).await
}

pub async fn delete_gasto(repo: &dyn CuentasRepository, input: DeleteGastoInput) -> AppResult<bool> {
    if input.id_gasto.trim().is_empty() {
        return Ok(false);
    }
    repo.eliminar_gasto(&input.id_gasto).await
}

pub async fn update_pago(repo: &dyn CuentasRepository, input: UpdatePagoInput) -> AppResult<bool> {
    let fecha_hora = requerido(&input.fecha_hora, "fecha_hora").map_err(AppError::validation)?;
    let metodo = normalize_metodo(&input.metodo);

    // El importe del input se ignora a propósito (CUENTA-02): el repositorio lo recalcula desde los
    // `Pago_Detalles` cobrados. Sólo se permite cambiar método y fecha.
    if input.id_pago.trim().is_empty() {
        return Ok(false);
    }

    let pago = PagoData {
        fecha_hora,
        metodo,
        importe: input.importe,
    };
    repo.actualizar_pago(&input.id_pago, pago).await
}

pub async fn delete_pago(repo: &dyn CuentasRepository, input: DeletePagoInput) -> AppResult<bool> {
    if input.id_pago.trim().is_empty() {
        return Ok(false);
    }
    repo.eliminar_pago(&input.id_pago).await
}
