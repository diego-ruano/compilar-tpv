//! Casos de uso de clientes (Local-First: lectura/escritura directa contra el repo).

use tpv_contracts::clientes::{
    ClienteForm, ClienteOverview, CreateClienteInput, UpdateClienteInput,
};
use tpv_domain::clientes::{Cliente, ClienteRanking, NuevoCliente};

use crate::error::{AppError, AppResult};
use crate::ports::clientes::ClientesRepository;

/// Overview de clientes según el ranking recibido de la UI.
pub async fn listar_overview(
    repo: &dyn ClientesRepository,
    ranking_arg: &str,
) -> AppResult<Vec<ClienteOverview>> {
    repo.overview(ClienteRanking::from_arg(ranking_arg)).await
}

/// Formulario de un cliente. Id no positivo => `None` (sin tocar el repo).
pub async fn obtener_form(
    repo: &dyn ClientesRepository,
    id_cliente: i64,
) -> AppResult<Option<ClienteForm>> {
    if id_cliente <= 0 {
        return Ok(None);
    }
    repo.form(id_cliente).await
}

/// Crea un cliente tras validar en el dominio.
pub async fn crear_cliente(
    repo: &dyn ClientesRepository,
    input: CreateClienteInput,
) -> AppResult<bool> {
    let nuevo = NuevoCliente::validar(
        input.id_cliente,
        input.nombre,
        input.email,
        input.telefono,
        input.notas,
    )
    .map_err(AppError::validation)?;

    repo.create(nuevo).await
}

/// Actualiza un cliente tras validar en el dominio.
pub async fn actualizar_cliente(
    repo: &dyn ClientesRepository,
    input: UpdateClienteInput,
) -> AppResult<bool> {
    let cliente = Cliente::validar_edicion(
        input.id_cliente,
        input.nombre,
        input.email,
        input.telefono,
        input.notas,
    )
    .map_err(AppError::validation)?;

    repo.update(cliente).await
}
