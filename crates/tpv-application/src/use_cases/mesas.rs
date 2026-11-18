//! Casos de uso de mesas / salón / comandas / cocina. Local-First: validan/normalizan
//! e invocan el puerto. Las escrituras "OK" devuelven `()` (el comando mapea a "OK").

use tpv_contracts::mesas::{
    CategoriaVendibleOut, ComandaConLineasOut, ComandaRow, KitchenRow, MesaLineaComandaRow,
    MesasMetaOut, MesasAbrirComandaInput, MesasAddLineaComandaInput, MesasCobrarDetallesInput, MesasComandaSetReservaInput, MesasComandaSetTrabajadorInput,
    MesasDeleteDetalleInput,
    MesasIdCategoriaArgs, MesasIdComandaArgs, MesasIdMesaArgs,
    MesasKitchenSetLineStateInput, MesasRemoveOnePendingDetalleInput,
    MesasSaveLayoutInput, MesasSearchProductosArgs, MesasSetReservaEstadoInput,
    MesasUpdateDetalleIngredientesInput, MesasUpdateDetalleNotaInput, ProductoVendibleOut, SalonOut,
};
use tpv_contracts::verifactu::DestinatarioInput;
use tpv_domain::mesas::{
    limpiar_opcional, normalize_estado_cocina, requerido, AbrirComandaData,
    CobroDetalles,
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

/* Reservas */

pub async fn set_reserva_estado(
    repo: &dyn MesasRepository,
    input: MesasSetReservaEstadoInput,
) -> AppResult<()> {
    // Desde la mesa, sólo llegar o irse; si la reserva ha cambiado mientras tanto lo dice el repo.
    let estado = tpv_domain::reservas::estado_desde_la_mesa(&input.estado).map_err(AppError::validation)?;
    if input.id_reserva.trim().is_empty() {
        return Err(AppError::validation("Falta la reserva."));
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

fn datos_para_abrir(input: MesasAbrirComandaInput) -> AppResult<AbrirComandaData> {
    if input.id_mesa.trim().is_empty() {
        return Err(AppError::validation("Falta la mesa."));
    }
    Ok(AbrirComandaData {
        id_mesa: input.id_mesa,
        id_trabajador_o_usuario: opt_id(input.id_usuario.or(input.id_trabajador)),
        id_reserva: opt_id(input.id_reserva),
    })
}

pub async fn abrir_comanda(
    repo: &dyn MesasRepository,
    input: MesasAbrirComandaInput,
) -> AppResult<Option<ComandaRow>> {
    repo.abrir_comanda(datos_para_abrir(input)?).await
}

/// Abrir o retomar la mesa en un paso: la comanda abierta (creada si no hay ninguna, con el
/// trabajador puesto si le faltaba) y sus líneas. Es lo que hace la pantalla de la mesa al abrirse;
/// en la Handy, un viaje en vez de cuatro.
pub async fn abrir_o_retomar(
    repo: &dyn MesasRepository,
    input: MesasAbrirComandaInput,
) -> AppResult<ComandaConLineasOut> {
    repo.abrir_o_retomar_comanda(datos_para_abrir(input)?)
        .await?
        .ok_or_else(|| AppError::conflict("La mesa ya no tiene la cuenta abierta: vuelve a abrirla."))
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

/// INC-20261030-007: si se abrió la mesa con la reserva todavía «Próxima», su comanda nació sin
/// reserva, y lo que se cobraba de ella no contaba en el gasto del cliente. Al marcar la llegada, si
/// el camarero dice que la cuenta abierta es de los clientes de la reserva, se enlaza aquí. Sólo una
/// comanda abierta y sin reserva: la de otra reserva no se pisa.
pub async fn comanda_set_reserva_if_null(
    repo: &dyn MesasRepository,
    input: MesasComandaSetReservaInput,
) -> AppResult<bool> {
    if input.id_comanda.trim().is_empty() {
        return Err(AppError::validation("Falta la comanda."));
    }
    if input.id_reserva.trim().is_empty() {
        return Err(AppError::validation("Falta la reserva."));
    }
    repo.comanda_set_reserva_if_null(input.id_comanda.trim(), input.id_reserva.trim()).await
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
    if input.id_comanda.trim().is_empty() {
        return Err(AppError::validation("Falta la comanda."));
    }
    if input.id_producto.trim().is_empty() {
        return Err(AppError::validation("Falta el producto."));
    }
    if !input.cantidad.is_finite() || input.cantidad <= 0.0 {
        return Err(AppError::validation("La cantidad tiene que ser mayor que cero."));
    }
    // RI-27: el precio no viene de la pantalla; lo pone el repositorio desde el catálogo.
    let id = opt_id(input.id_usuario.or(input.id_trabajador));
    repo.add_linea_comanda(&input.id_comanda, &input.id_producto, input.cantidad, id)
        .await
}

/* Meta + catálogo */

pub async fn mesas_meta_all(repo: &dyn MesasRepository) -> AppResult<MesasMetaOut> {
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

/// Lo que se pide distinto en una línea (sin cebolla, extra de queso). No cambia el precio.
pub async fn update_detalle_ingredientes(
    repo: &dyn MesasRepository,
    input: MesasUpdateDetalleIngredientesInput,
) -> AppResult<()> {
    let id_detalle = input.id_detalle.trim();
    if id_detalle.is_empty() {
        return Err(AppError::validation("Falta la línea."));
    }
    let cambios = tpv_domain::ingredientes::cambios_de_linea(
        input.cambios.into_iter().map(|c| (c.id_ingrediente, c.nombre, c.tipo)),
    )
    .map_err(AppError::validation)?;
    repo.update_detalle_ingredientes(id_detalle, &cambios).await
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
        // No hay nada que cobrar: tampoco hay pago que devolver.
        return Ok(String::new());
    }

    let metodo = tpv_domain::pago::normalize_metodo(&input.metodo).map_err(AppError::validation)?;
    let tipo = requerido(&input.tipo, "Falta el tipo de cobro.").map_err(AppError::validation)?;

    let data = CobroDetalles {
        id_comanda: input.id_comanda,
        metodo,
        tipo,
        detalle_ids: ids,
        id_usuario: opt_id(Some(id_usuario.to_string())),
        destinatario: destinatario_de(input.destinatario),
        todo: input.todo,
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
        return Err(AppError::validation("Falta la línea de la comanda."));
    }
    if input.id_usuario_cocinero.trim().is_empty() {
        return Err(AppError::validation("Falta quién cocina la línea."));
    }
    // Fidelidad con el monolito: estado vacío/espacios es error (no se normaliza a PENDIENTE).
    let estado_raw = requerido(&input.estado, "Falta el estado de la línea.").map_err(AppError::validation)?;
    let estado = normalize_estado_cocina(&estado_raw).map_err(AppError::validation)?;
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
