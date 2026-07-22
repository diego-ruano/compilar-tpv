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
    if input.id_reserva.trim().is_empty() {
        return Err(AppError::validation("ID_Reserva inválido"));
    }
    repo.eliminar(&input.id_reserva).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;

    struct RepoQueNoDebeLlamarse;
    #[async_trait]
    impl ReservasRepository for RepoQueNoDebeLlamarse {
        async fn meta(&self) -> AppResult<ReservasMetaDto> {
            panic!("repo llamado")
        }
        async fn mes(&self, _: &str, _: &str) -> AppResult<Vec<ReservaDto>> {
            panic!("repo llamado")
        }
        async fn guardar(&self, _: ReservaValidada) -> AppResult<bool> {
            panic!("repo llamado")
        }
        async fn eliminar(&self, _: &str) -> AppResult<bool> {
            panic!("repo llamado")
        }
    }

    #[tokio::test]
    async fn get_mes_rechaza_fechas_invalidas_antes_del_repo() {
        let args = ReservasGetMesArgs {
            desde: "22/07/2026".into(),
            hasta: "2026-07-31".into(),
        };
        assert!(matches!(
            get_mes(&RepoQueNoDebeLlamarse, args).await,
            Err(AppError::Validation(_))
        ));
    }

    #[tokio::test]
    async fn eliminar_exige_id() {
        let input = ReservaDeleteInput {
            id_reserva: " ".into(),
        };
        assert!(matches!(
            eliminar(&RepoQueNoDebeLlamarse, input).await,
            Err(AppError::Validation(_))
        ));
    }

    #[test]
    fn fecha_de_reserva_acepta_timestamp_y_extrae_el_dia() {
        assert_eq!(normalize_dia_ymd(" 2026-07-22T18:30:00Z ").unwrap(), "2026-07-22");
    }

    #[test]
    fn fecha_de_reserva_rechaza_formato_y_mes_imposibles() {
        assert!(normalize_dia_ymd("22-07-2026").is_err());
        assert!(normalize_dia_ymd("2026-13-01").is_err());
    }
}
