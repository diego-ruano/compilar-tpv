//! Casos de uso de mesas / salón / comandas / cocina. Local-First: validan/normalizan
//! e invocan el puerto. Las escrituras "OK" devuelven `()` (el comando mapea a "OK").

use tpv_domain::dinero::Dinero;
use std::collections::HashMap;

use tpv_contracts::mesas::{
    CategoriaVendibleOut, ComandaBarraListItem, ComandaRow, KitchenRow, MesaLineaComandaRow,
    MesaMetaOut, MesasAbrirComandaInput, MesasAddLineaComandaInput, MesasCerrarComandaInput,
    MesasCobrarDetallesInput, MesasCobrarVentaRapidaInput, MesasComandaSetTrabajadorInput,
    MesasCreateComandaBarraInput, MesasDeleteComandaBarraIfSafeInput, MesasDeleteDetalleInput,
    MesasGetOrCreateComandaBarraInput, MesasIdCategoriaArgs, MesasIdComandaArgs, MesasIdMesaArgs,
    MesasKitchenSetLineStateInput, MesasListComandasBarraArgs, MesasRemoveOnePendingDetalleInput,
    MesasSaveLayoutInput, MesasSearchProductosArgs, MesasSetReservaEstadoInput,
    MesasUpdateDetalleNotaInput, ProductoVendibleOut, SalonOut,
};
use tpv_contracts::verifactu::DestinatarioInput;
use tpv_domain::mesas::{
    limpiar_opcional, normalize_estado_cocina, normalize_metodo, requerido, AbrirComandaData,
    CobroDetalles, CobroVentaRapida,
};

use crate::error::{AppError, AppResult};
use crate::ports::mesas::MesasRepository;

/// Normaliza un id opcional: recorta y descarta vacíos.
fn opt_id(o: Option<String>) -> Option<String> {
    o.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/* Layout */

pub async fn save_layout(repo: &dyn MesasRepository, input: MesasSaveLayoutInput) -> AppResult<()> {
    repo.save_layout(input.salons).await
}

pub async fn load_layout(repo: &dyn MesasRepository) -> AppResult<Vec<SalonOut>> {
    repo.load_layout().await
}

pub async fn get_mesas_ocupadas(repo: &dyn MesasRepository) -> AppResult<HashMap<String, bool>> {
    repo.get_mesas_ocupadas().await
}

/* Reservas */

pub async fn set_reserva_estado(
    repo: &dyn MesasRepository,
    input: MesasSetReservaEstadoInput,
) -> AppResult<()> {
    let estado = requerido(&input.estado, "estado")
        .map_err(AppError::validation)?
        .to_uppercase();
    if input.id_reserva.trim().is_empty() {
        return Err(AppError::validation("ID_Reserva inválido"));
    }
    repo.set_reserva_estado(&input.id_reserva, estado).await
}

/* Comandas de mesa */

pub async fn get_comanda_abierta_by_mesa(
    repo: &dyn MesasRepository,
    args: MesasIdMesaArgs,
) -> AppResult<Option<ComandaRow>> {
    if args.id_mesa.trim().is_empty() {
        return Ok(None);
    }
    repo.get_comanda_abierta_by_mesa(&args.id_mesa).await
}

pub async fn abrir_comanda(
    repo: &dyn MesasRepository,
    input: MesasAbrirComandaInput,
) -> AppResult<Option<ComandaRow>> {
    if input.id_mesa.trim().is_empty() {
        return Err(AppError::validation("id_mesa inválido"));
    }
    let data = AbrirComandaData {
        id_mesa: input.id_mesa,
        id_trabajador_o_usuario: opt_id(input.id_usuario.or(input.id_trabajador)),
        id_reserva: opt_id(input.id_reserva),
    };
    repo.abrir_comanda(data).await
}

pub async fn comanda_set_trabajador_if_null(
    repo: &dyn MesasRepository,
    input: MesasComandaSetTrabajadorInput,
) -> AppResult<bool> {
    if input.id_comanda.trim().is_empty() {
        return Ok(false);
    }
    let id = opt_id(input.id_usuario.or(input.id_trabajador));
    repo.comanda_set_trabajador_if_null(&input.id_comanda, id)
        .await
}

pub async fn cerrar_comanda(
    repo: &dyn MesasRepository,
    input: MesasCerrarComandaInput,
) -> AppResult<()> {
    if input.id_comanda.trim().is_empty() {
        return Err(AppError::validation("id_comanda inválido"));
    }
    if input.total.es_negativo() {
        return Err(AppError::validation("total inválido"));
    }
    repo.cerrar_comanda(&input.id_comanda, input.total).await
}

pub async fn get_lineas_comanda(
    repo: &dyn MesasRepository,
    args: MesasIdComandaArgs,
) -> AppResult<Vec<MesaLineaComandaRow>> {
    if args.id_comanda.trim().is_empty() {
        return Ok(vec![]);
    }
    repo.get_lineas_comanda(&args.id_comanda).await
}

pub async fn add_linea_comanda(
    repo: &dyn MesasRepository,
    input: MesasAddLineaComandaInput,
) -> AppResult<Vec<tpv_contracts::mesas::MesaLineaComandaRow>> {
    if input.id_comanda.trim().is_empty() || input.id_producto.trim().is_empty() {
        return Err(AppError::validation("id_comanda/id_producto inválidos"));
    }
    if !input.cantidad.is_finite() || input.cantidad <= 0.0 {
        return Err(AppError::validation("cantidad inválida"));
    }
    // DB-06: Precio_Unitario nunca negativo (paridad con el worker: precio.min(0)).
    if input.precio.es_negativo() {
        return Err(AppError::validation("precio inválido (debe ser >= 0)"));
    }
    let id = opt_id(input.id_usuario.or(input.id_trabajador));
    repo.add_linea_comanda(
        &input.id_comanda,
        &input.id_producto,
        input.cantidad,
        input.precio,
        id,
    )
    .await
}

/* Barra */

pub async fn get_or_create_comanda_barra(
    repo: &dyn MesasRepository,
    input: MesasGetOrCreateComandaBarraInput,
) -> AppResult<String> {
    repo.get_or_create_comanda_barra(opt_id(input.id_trabajador))
        .await
}

/// REV-17: el cobrador llega **aparte** del input, porque sale de la sesión y no de la pantalla.
pub async fn cobrar_venta_rapida(
    repo: &dyn MesasRepository,
    id_usuario: &str,
    id_trabajador: Option<&str>,
    input: MesasCobrarVentaRapidaInput,
) -> AppResult<String> {
    let items: Vec<(String, Dinero)> = input
        .items
        .into_iter()
        // DB-06: descarta precios negativos (nunca escriben Precio_Unitario < 0). Ya no hace
        // falta comprobar que sean finitos: un `Dinero` siempre lo es.
        .filter(|it| !it.producto_id.trim().is_empty() && !it.precio.es_negativo())
        .map(|it| (it.producto_id, it.precio))
        .collect();

    let data = CobroVentaRapida {
        metodo: normalize_metodo(&input.metodo),
        items,
        id_usuario_cobrador: opt_id(Some(id_usuario.to_string())),
        id_trabajador_cobrador: opt_id(id_trabajador.map(str::to_string)),
        id_comanda: opt_id(input.id_comanda),
        destinatario: destinatario_de(input.destinatario),
    };
    repo.cobrar_venta_rapida(data).await
}

pub async fn create_comanda_barra(
    repo: &dyn MesasRepository,
    input: MesasCreateComandaBarraInput,
) -> AppResult<String> {
    repo.create_comanda_barra(opt_id(input.id_trabajador)).await
}

pub async fn list_comandas_barra(
    repo: &dyn MesasRepository,
    args: MesasListComandasBarraArgs,
) -> AppResult<Vec<ComandaBarraListItem>> {
    let include_pagadas = args.include_pagadas.unwrap_or(false);
    let limit = args.limit.unwrap_or(50).clamp(1, 200);
    repo.list_comandas_barra(include_pagadas, limit).await
}

pub async fn delete_comanda_barra_if_safe(
    repo: &dyn MesasRepository,
    input: MesasDeleteComandaBarraIfSafeInput,
) -> AppResult<bool> {
    if input.id_comanda.trim().is_empty() {
        return Ok(false);
    }
    repo.delete_comanda_barra_if_safe(&input.id_comanda).await
}

/* Meta + catálogo */

pub async fn mesas_meta_all(repo: &dyn MesasRepository) -> AppResult<HashMap<String, MesaMetaOut>> {
    repo.mesas_meta_all().await
}

pub async fn list_categorias_vendibles(
    repo: &dyn MesasRepository,
) -> AppResult<Vec<CategoriaVendibleOut>> {
    repo.list_categorias_vendibles().await
}

pub async fn list_productos_by_categoria(
    repo: &dyn MesasRepository,
    args: MesasIdCategoriaArgs,
) -> AppResult<Vec<ProductoVendibleOut>> {
    repo.list_productos_by_categoria(&args.id_categoria).await
}

pub async fn search_productos_by_nombre(
    repo: &dyn MesasRepository,
    args: MesasSearchProductosArgs,
) -> AppResult<Vec<ProductoVendibleOut>> {
    let q = args.q.or(args.query).or(args.texto).unwrap_or_default();
    repo.search_productos_by_nombre(q).await
}

/* Detalles (ticket) */

pub async fn remove_one_pending_detalle(
    repo: &dyn MesasRepository,
    input: MesasRemoveOnePendingDetalleInput,
) -> AppResult<()> {
    if input.id_comanda.trim().is_empty() || input.id_producto.trim().is_empty() {
        return Ok(());
    }
    repo.remove_one_pending_detalle(&input.id_comanda, &input.id_producto)
        .await
}

pub async fn delete_detalle(
    repo: &dyn MesasRepository,
    input: MesasDeleteDetalleInput,
) -> AppResult<()> {
    if input.id_detalle.trim().is_empty() {
        return Ok(());
    }
    repo.delete_detalle(&input.id_detalle).await
}

pub async fn update_detalle_nota(
    repo: &dyn MesasRepository,
    input: MesasUpdateDetalleNotaInput,
) -> AppResult<()> {
    if input.id_detalle.trim().is_empty() {
        return Ok(());
    }
    repo.update_detalle_nota(&input.id_detalle, limpiar_opcional(input.nota))
        .await
}

/// REV-17: quién cobra llega **aparte** del input, porque sale de la sesión.
///
/// Sigue siendo un solo valor porque `CobroDetalles` sólo tiene uno: el `ID_Trabajador_Cobrador`
/// que se guarda con el pago lo resuelve la capa de datos mirando `Trabajadores.ID_Usuario`, que es
/// exactamente lo que hacía antes con lo que mandaba la pantalla.
pub async fn cobrar_detalles(
    repo: &dyn MesasRepository,
    id_usuario: &str,
    input: MesasCobrarDetallesInput,
) -> AppResult<String> {
    let mut ids: Vec<String> = input
        .detalle_ids
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    ids.sort_unstable();
    ids.dedup();

    if input.id_comanda.trim().is_empty() || ids.is_empty() {
        // No hay nada que cobrar: tampoco hay ticket, así que no hay número que devolver.
        return Ok(String::new());
    }

    let metodo = requerido(&input.metodo, "metodo").map_err(AppError::validation)?;
    let tipo = requerido(&input.tipo, "tipo").map_err(AppError::validation)?;

    let data = CobroDetalles {
        id_comanda: input.id_comanda,
        metodo,
        tipo,
        detalle_ids: ids,
        id_usuario: opt_id(Some(id_usuario.to_string())),
        destinatario: destinatario_de(input.destinatario),
    };
    repo.cobrar_detalles(data).await
}

/* Cocina */

pub async fn kitchen_list_today_pending(repo: &dyn MesasRepository) -> AppResult<Vec<KitchenRow>> {
    repo.kitchen_list_today_pending().await
}

pub async fn kitchen_set_line_state(
    repo: &dyn MesasRepository,
    input: MesasKitchenSetLineStateInput,
) -> AppResult<()> {
    if input.id_detalle.trim().is_empty() {
        return Err(AppError::validation("ID_Detalle inválido"));
    }
    if input.id_usuario_cocinero.trim().is_empty() {
        return Err(AppError::validation("ID_Usuario_Cocinero inválido"));
    }
    // Fidelidad con el monolito: estado vacío/espacios es error (no se normaliza a PENDIENTE).
    let estado_raw = requerido(&input.estado, "estado").map_err(AppError::validation)?;
    let estado = normalize_estado_cocina(&estado_raw);
    repo.kitchen_set_line_state(&input.id_detalle, &input.id_usuario_cocinero, estado)
        .await
}

/// Traduce el destinatario del input al del dominio.
///
/// La VALIDACIÓN (nombre, NIF y su dígito de control) no se hace aquí sino en el repositorio, justo
/// antes de emitir: es donde se conoce el límite configurado del negocio y donde está la transacción
/// que hay que rodar atrás si los datos no sirven. Aquí sólo se cambia de forma.
fn destinatario_de(input: Option<DestinatarioInput>) -> Option<tpv_domain::verifactu::Destinatario> {
    input.map(|d| tpv_domain::verifactu::Destinatario {
        nombre_razon: d.nombre_razon,
        nif: d.nif,
        direccion: d.domicilio,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opt_id_recorta_y_elimina_ids_vacios() {
        assert_eq!(
            opt_id(Some("  trabajador-1  ".into())),
            Some("trabajador-1".into())
        );
        assert_eq!(opt_id(Some("   ".into())), None);
        assert_eq!(opt_id(None), None);
    }

    #[test]
    fn opt_id_conserva_el_contenido_interior() {
        assert_eq!(opt_id(Some(" usuario barra ".into())), Some("usuario barra".into()));
    }

    #[test]
    fn opt_id_descarta_distintos_tipos_de_espacio() {
        assert_eq!(opt_id(Some("\t\n".into())), None);
    }
}
