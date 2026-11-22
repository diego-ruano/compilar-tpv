//! Puerto de persistencia de clientes.

use async_trait::async_trait;

use tpv_contracts::clientes::{ClienteForm, ClienteOverview, ClientesParaFactura};
use tpv_domain::clientes::{Cliente, ClienteRanking, DatosFiscales, NuevoCliente};

use crate::error::AppResult;

/// Repositorio de clientes. Lo implementa `tpv-infra-sqlite` contra la BD local.
#[async_trait]
pub trait ClientesRepository: Send + Sync {
    /// Top/listado de clientes según el criterio de ranking.
    async fn overview(&self, ranking: ClienteRanking) -> AppResult<Vec<ClienteOverview>>;

    /// Datos de formulario de un cliente, o `None` si no existe.
    async fn form(&self, id_cliente: &str) -> AppResult<Option<ClienteForm>>;

    /// Crea (o upserta por id) un cliente. Devuelve `true` si quedó persistido.
    async fn create(&self, nuevo: NuevoCliente) -> AppResult<bool>;

    /// Actualiza un cliente existente. Devuelve `true` si afectó alguna fila.
    async fn update(&self, cliente: Cliente) -> AppResult<bool>;
}

/// Las fichas de cliente desde el formulario de la factura completa (FISCAL-02). Sólo lo implementa
/// la Main: es la que cobra y la que factura.
#[async_trait]
pub trait ClientesFacturaRepository: Send + Sync {
    /// Todas las fichas, con lo justo para elegir una y facturarle, y la del cliente de la comanda
    /// (por su reserva), si se pide una y lo tiene.
    async fn para_factura(&self, id_comanda: Option<&str>) -> AppResult<ClientesParaFactura>;

    /// La ficha con ese NIF (ya normalizado). Si hubiera varias, la más reciente.
    async fn id_por_nif(&self, nif: &str) -> AppResult<Option<String>>;

    /// Escribe los tres datos fiscales de una ficha, sin tocar lo demás. `false` si no existe.
    async fn actualizar_datos_fiscales(&self, id_cliente: &str, datos: &DatosFiscales) -> AppResult<bool>;

    /// Da de alta una ficha con ese nombre y esos datos fiscales. Devuelve su id.
    async fn alta_con_datos_fiscales(&self, nombre: &str, datos: &DatosFiscales) -> AppResult<String>;

    /// FISCAL-03 · El gasto de estos cobros pasa a la ficha: su comanda queda a nombre de este
    /// cliente, y se re-deriva el gasto suyo y el de quien lo tuviera antes (el de la comanda o el de
    /// su reserva). Devuelve cuántas comandas han cambiado de cliente.
    async fn apuntar_gasto(&self, id_cliente: &str, ids_pago: &[String]) -> AppResult<u64>;
}
