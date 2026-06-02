//! Casos de uso de reservas (Local-First).

use tpv_contracts::reservas::{
    ReservaDeleteInput, ReservaDto, ReservaSaveInput, ReservasGetMesArgs, ReservasMetaDto,
};
use tpv_domain::reservas::{normalize_dia_ymd, ReservaValidada};

use crate::error::{AppError, AppResult};
use crate::ports::reservas::ReservasRepository;

pub async fn get_meta(repo: &dyn ReservasRepository) -> AppResult<ReservasMetaDto> {
    repo.meta().await
}

pub async fn get_mes(
    repo: &dyn ReservasRepository,
    args: ReservasGetMesArgs,
) -> AppResult<Vec<ReservaDto>> {
    let desde = normalize_dia_ymd(&args.desde).map_err(AppError::validation)?;
    let hasta = normalize_dia_ymd(&args.hasta).map_err(AppError::validation)?;
    repo.mes(&desde, &hasta).await
}

pub async fn guardar(repo: &dyn ReservasRepository, input: ReservaSaveInput) -> AppResult<bool> {
    let validada = ReservaValidada::validar(
        input.id_reserva,
        &input.dia_ymd,
        &input.hora,
        input.turno,
        input.comensales,
        input.nota,
        input.estado,
        input.id_mesa,
        input.nombre_cliente,
        input.telefono,
        input.email,
        input.notas_cliente,
    )
    .map_err(AppError::validation)?;

    repo.guardar(validada).await
}

pub async fn eliminar(repo: &dyn ReservasRepository, input: ReservaDeleteInput) -> AppResult<bool> {
    if input.id_reserva <= 0 {
        return Err(AppError::validation("ID_Reserva inválido"));
    }
    repo.eliminar(input.id_reserva).await
}
