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
    id_cliente: String,
) -> AppResult<Option<ClienteForm>> {
    let id_cliente = id_cliente.trim();
    if id_cliente.is_empty() {
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

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;

    struct RepoQueNoDebeLlamarse;

    #[async_trait]
    impl ClientesRepository for RepoQueNoDebeLlamarse {
        async fn overview(&self, _: ClienteRanking) -> AppResult<Vec<ClienteOverview>> {
            panic!("repo llamado")
        }
        async fn form(&self, _: &str) -> AppResult<Option<ClienteForm>> {
            panic!("repo llamado")
        }
        async fn create(&self, _: NuevoCliente) -> AppResult<bool> {
            panic!("repo llamado")
        }
        async fn update(&self, _: Cliente) -> AppResult<bool> {
            panic!("repo llamado")
        }
    }

    #[tokio::test]
    async fn obtener_form_con_id_vacio_no_toca_repo() {
        assert!(obtener_form(&RepoQueNoDebeLlamarse, "   ".into())
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn crear_cliente_invalido_no_toca_repo() {
        let input = CreateClienteInput {
            id_cliente: None,
            nombre: " ".into(),
            email: None,
            telefono: None,
            notas: None,
        };
        assert!(matches!(
            crear_cliente(&RepoQueNoDebeLlamarse, input).await,
            Err(AppError::Validation(_))
        ));
    }

    #[tokio::test]
    async fn actualizar_cliente_exige_id_y_nombre_validos() {
        let sin_id = UpdateClienteInput { id_cliente: " ".into(), nombre: "Ana".into(), email: None, telefono: None, notas: None };
        let sin_nombre = UpdateClienteInput { id_cliente: "c1".into(), nombre: " ".into(), email: None, telefono: None, notas: None };
        assert!(matches!(actualizar_cliente(&RepoQueNoDebeLlamarse, sin_id).await, Err(AppError::Validation(_))));
        assert!(matches!(actualizar_cliente(&RepoQueNoDebeLlamarse, sin_nombre).await, Err(AppError::Validation(_))));
    }

    #[tokio::test]
    async fn crear_cliente_rechaza_email_mal_formado() {
        let input = CreateClienteInput {
            id_cliente: Some("c1".into()), nombre: "Ana".into(),
            email: Some("correo-sin-arroba".into()), telefono: None, notas: None,
        };
        assert!(matches!(crear_cliente(&RepoQueNoDebeLlamarse, input).await, Err(AppError::Validation(_))));
    }
}
