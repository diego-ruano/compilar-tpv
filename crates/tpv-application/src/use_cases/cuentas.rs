//! Casos de uso de cuentas (caja). Local-First.
//!
//! Nota de compatibilidad: importes/ids inválidos devuelven `Ok(false)` (no error),
//! igual que el backend antiguo; los campos de texto vacíos sí son error de validación.

use tpv_domain::dinero::Dinero;
use tpv_contracts::cuentas::{
    AnularPagoInput, CobroDevolubleDto, CreateGastoInput, CuentasRangoArgs, DeleteGastoInput,
    DevolucionDto, DevolverLineasInput, PaginaEntradas, PaginaSalidas, ResumenCajaDto,
    UpdateGastoInput, UpdatePagoInput,
};
use tpv_domain::cuentas::{
    motivo_de_devolucion, normalize_metodo, normalize_metodo_devolucion, puede_anularse, requerido,
    GastoData, PagoData, RechazoAnulacion, RechazoDevolucion, ESTADO_ANULADO,
};

use crate::error::{AppError, AppResult};
use crate::ports::cuentas::{
    AnularPagoArgs, ClaseBaja, CuentasFiltro, CuentasRepository, DevolverLineasArgs,
};

fn filtro_de(args: CuentasRangoArgs) -> CuentasFiltro {
    let cursor = args.cursor();
    CuentasFiltro {
        del: args.del,
        al: args.al,
        q: args.q,
        page_size: args.page_size,
        cursor,
    }
}

pub async fn get_entradas(
    repo: &dyn CuentasRepository,
    args: CuentasRangoArgs,
) -> AppResult<PaginaEntradas> {
    repo.entradas(filtro_de(args)).await
}

pub async fn get_salidas(
    repo: &dyn CuentasRepository,
    args: CuentasRangoArgs,
) -> AppResult<PaginaSalidas> {
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

pub async fn create_gasto(
    repo: &dyn CuentasRepository,
    id_usuario: Option<&str>,
    input: CreateGastoInput,
) -> AppResult<bool> {
    let fecha = requerido(&input.fecha, "fecha").map_err(AppError::validation)?;
    let tipo_gasto = requerido(&input.tipo_gasto, "tipo_gasto").map_err(AppError::validation)?;
    let concepto = requerido(&input.concepto, "concepto").map_err(AppError::validation)?;

    if input.importe <= Dinero::CERO {
        return Ok(false);
    }

    let proveedor_id = proveedor_para(&tipo_gasto, input.proveedor_id);
    let gasto = GastoData {
        fecha,
        tipo_gasto,
        concepto,
        importe: input.importe,
        proveedor_id,
        pagado_con_caja: input.pagado_con_caja.unwrap_or(false),
    };
    let id = input
        .id_gasto
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    repo.crear_gasto(id, gasto, id_usuario).await
}

pub async fn update_gasto(
    repo: &dyn CuentasRepository,
    input: UpdateGastoInput,
) -> AppResult<bool> {
    let fecha = requerido(&input.fecha, "fecha").map_err(AppError::validation)?;
    let tipo_gasto = requerido(&input.tipo_gasto, "tipo_gasto").map_err(AppError::validation)?;
    let concepto = requerido(&input.concepto, "concepto").map_err(AppError::validation)?;

    if input.id_gasto.trim().is_empty() || input.importe <= Dinero::CERO {
        return Ok(false);
    }

    let proveedor_id = proveedor_para(&tipo_gasto, input.proveedor_id);
    let gasto = GastoData {
        fecha,
        tipo_gasto,
        concepto,
        importe: input.importe,
        proveedor_id,
        pagado_con_caja: input.pagado_con_caja.unwrap_or(false),
    };
    repo.actualizar_gasto(&input.id_gasto, gasto).await
}

pub async fn delete_gasto(
    repo: &dyn CuentasRepository,
    id_usuario: Option<&str>,
    input: DeleteGastoInput,
) -> AppResult<bool> {
    if input.id_gasto.trim().is_empty() {
        return Ok(false);
    }
    repo.eliminar_gasto(&input.id_gasto, id_usuario).await
}

pub async fn update_pago(repo: &dyn CuentasRepository, input: UpdatePagoInput) -> AppResult<bool> {
    let fecha_hora = requerido(&input.fecha_hora, "fecha_hora").map_err(AppError::validation)?;
    let metodo = normalize_metodo(&input.metodo);

    // El importe del input se ignora a propósito (CUENTA-02): el repositorio lo recalcula desde los
    // `Pago_Detalles` cobrados. Sólo se permite cambiar método y fecha.
    if input.id_pago.trim().is_empty() {
        return Ok(false);
    }

    // Un cobro anulado queda congelado (CUENTA-07). Cambiarle la fecha movería la anulación de
    // periodo de caja a posteriori, que es exactamente lo que el rastro existe para impedir.
    if let Some(estado) = repo.estado_pago(input.id_pago.trim()).await? {
        if estado.trim().eq_ignore_ascii_case(ESTADO_ANULADO) {
            return Err(AppError::conflict(
                "Ese cobro está anulado: ya no se puede modificar.",
            ));
        }
    }

    let pago = PagoData {
        fecha_hora,
        metodo,
        importe: input.importe,
    };
    repo.actualizar_pago(&input.id_pago, pago).await
}

/// Deja constancia de una apertura manual del cajón (ver el puerto).
pub async fn registrar_apertura_cajon(
    repo: &dyn CuentasRepository,
    id_usuario: Option<String>,
) -> AppResult<()> {
    repo.registrar_apertura_cajon(id_usuario).await
}

/// Anula un cobro. Antes se borraba (`delete_pago`); ahora se marca y se conserva (CUENTA-07).
///
/// El agujero que cierra: el arqueo calcula `esperado = fondo + cobros en efectivo`, así que
/// borrar la fila de una venta en efectivo bajaba el esperado **exactamente lo mismo** que faltaba
/// en el cajón y el descuadre salía cero. Los números eran correctos; lo que no había era nada
/// contra lo que compararlos.
///
/// `id_usuario` viene de la sesión del backend (SEC-01), no del input.
pub async fn anular_pago(
    repo: &dyn CuentasRepository,
    id_usuario: &str,
    input: AnularPagoInput,
) -> AppResult<bool> {
    let id_pago = input.id_pago.trim();
    if id_pago.is_empty() {
        return Ok(false);
    }

    // Un pago que no existe no es un error de permiso ni de motivo: es `false`, igual que antes.
    // Preguntar por el motivo de algo que no se va a hacer sólo haría escribir para nada.
    let Some(estado) = repo.estado_pago(id_pago).await? else {
        return Ok(false);
    };

    let motivo = puede_anularse(&estado, input.motivo.as_deref()).map_err(|r| match r {
        RechazoAnulacion::YaAnulado => AppError::conflict(r.mensaje()),
        RechazoAnulacion::MotivoRequerido => AppError::validation(r.mensaje()),
    })?;

    repo.anular_pago(AnularPagoArgs {
        id_pago: id_pago.to_string(),
        id_usuario: id_usuario.to_string(),
        motivo,
        // FISCAL-01. Ausente = anulación por error, que es lo que hacía este comando antes: un
        // cliente que no manda el campo sigue haciendo lo que hacía.
        clase: ClaseBaja::desde_texto(input.clase.as_deref()),
    })
    .await
}

/// El error de un rechazo de devolución: lo que hay que corregir en la pantalla es una validación;
/// lo que dice el estado del cobro, un conflicto. Lo usa también el repositorio, que comprueba lo
/// que depende de la BD.
pub fn error_de_devolucion(r: RechazoDevolucion) -> AppError {
    match r {
        RechazoDevolucion::MotivoRequerido
        | RechazoDevolucion::SinLineas
        | RechazoDevolucion::CantidadNoValida => AppError::validation(r.mensaje()),
        _ => AppError::conflict(r.mensaje()),
    }
}

/// Las líneas de un cobro con lo que queda por devolver de cada una.
pub async fn lineas_devolubles(
    repo: &dyn CuentasRepository,
    id_pago: &str,
) -> AppResult<CobroDevolubleDto> {
    repo.lineas_devolubles(id_pago.trim())
        .await?
        .ok_or_else(|| AppError::not_found("Ese cobro no existe."))
}

/// Devuelve parte de un cobro: unas líneas, o unas unidades de una línea.
///
/// Es dinero que sale, así que va como un pago negativo con su factura rectificativa
/// (`docs/arquitectura/caja.md`). El motivo es obligatorio, como al anular, y el método dice por
/// dónde salió el dinero: sólo el efectivo resta del arqueo. `id_usuario` viene de la sesión.
pub async fn devolver_lineas(
    repo: &dyn CuentasRepository,
    id_usuario: &str,
    input: DevolverLineasInput,
) -> AppResult<DevolucionDto> {
    let id_pago = input.id_pago.trim().to_string();
    if id_pago.is_empty() {
        return Err(AppError::validation("Falta el cobro que se devuelve."));
    }
    let motivo = motivo_de_devolucion(input.motivo.as_deref()).map_err(error_de_devolucion)?;

    // Una línea a cero es una que no se ha elegido; dos veces la misma, lo que se ha pedido en
    // total. Lo que no es un número positivo no se adivina.
    let mut lineas: Vec<(String, f64)> = Vec::new();
    for l in input.lineas {
        let id = l.id_detalle.trim().to_string();
        if id.is_empty() || l.cantidad == 0.0 {
            continue;
        }
        if !l.cantidad.is_finite() || l.cantidad < 0.0 {
            return Err(error_de_devolucion(RechazoDevolucion::CantidadNoValida));
        }
        match lineas.iter_mut().find(|(i, _)| *i == id) {
            Some((_, c)) => *c += l.cantidad,
            None => lineas.push((id, l.cantidad)),
        }
    }
    if lineas.is_empty() {
        return Err(error_de_devolucion(RechazoDevolucion::SinLineas));
    }

    repo.devolver_lineas(DevolverLineasArgs {
        id_pago,
        id_usuario: id_usuario.to_string(),
        motivo,
        metodo: normalize_metodo_devolucion(&input.metodo),
        lineas,
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tpv_contracts::cuentas::CursorCuentas;

    #[test]
    fn proveedor_solo_se_conserva_en_gastos_de_proveedor() {
        assert_eq!(
            proveedor_para("Proveedor", Some(" p1 ".into())),
            Some("p1".into())
        );
        assert_eq!(proveedor_para("Proveedor", Some("  ".into())), None);
        assert_eq!(proveedor_para("Otro", Some("p1".into())), None);
    }

    #[test]
    fn filtro_preserva_todos_los_argumentos() {
        let filtro = filtro_de(CuentasRangoArgs {
            del: Some("2026-01-01".into()),
            al: Some("2026-01-31".into()),
            q: Some("cafe".into()),
            page_size: Some(25),
            cursor_fecha: Some("2026-01-20 13:00:00".into()),
            cursor_id: Some("p9".into()),
        });
        assert_eq!(filtro.del.as_deref(), Some("2026-01-01"));
        assert_eq!(filtro.al.as_deref(), Some("2026-01-31"));
        assert_eq!(filtro.q.as_deref(), Some("cafe"));
        assert_eq!(filtro.page_size, Some(25));
        assert_eq!(
            filtro.cursor,
            Some(CursorCuentas { fecha: "2026-01-20 13:00:00".into(), id: "p9".into() })
        );
    }

    #[test]
    fn filtro_admite_consulta_sin_rango_ni_paginacion() {
        let filtro = filtro_de(CuentasRangoArgs {
            del: None, al: None, q: None, page_size: None, cursor_fecha: None, cursor_id: None,
        });
        assert!(filtro.del.is_none() && filtro.al.is_none() && filtro.q.is_none());
        assert!(filtro.page_size.is_none() && filtro.cursor.is_none());
    }

    #[test]
    fn medio_cursor_es_la_primera_pagina() {
        // Una parte sola no dice dónde empezar: se ignora en vez de filtrar con la mitad.
        let filtro = filtro_de(CuentasRangoArgs {
            del: None, al: None, q: None, page_size: Some(25),
            cursor_fecha: Some("2026-01-20 13:00:00".into()), cursor_id: None,
        });
        assert!(filtro.cursor.is_none());
    }

    #[test]
    fn proveedor_es_sensible_al_tipo_de_gasto_canonico() {
        assert_eq!(proveedor_para("proveedor", Some("p1".into())), None);
        assert_eq!(proveedor_para("Proveedor ", Some("p1".into())), None);
    }
}
