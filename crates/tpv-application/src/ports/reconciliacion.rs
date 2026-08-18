//! Puerto de **reconciliación** (INV-06 / DB-14): comprobar que los valores guardados que son
//! suma de otra cosa siguen cuadrando con esa otra cosa.
//!
//! El TPV guarda dos cifras derivadas por rendimiento —el stock disponible de cada lote y el gasto
//! acumulado de cada cliente— en vez de recalcularlas en cada consulta. Eso es correcto, pero
//! significa que un fallo parcial las deja mintiendo en silencio y nadie se entera: la caja cuadra,
//! la venta se hizo, y el número simplemente se quedó viejo.
//!
//! Solo lo implementa el adaptador SQLite: esto corre en la Main, que es el escritor único.

use async_trait::async_trait;

use crate::error::AppResult;

/// Lote cuyo `Stock_Disponible` no coincide con su historial de movimientos y consumos.
#[derive(Debug, Clone)]
pub struct LoteDescuadrado {
    pub id_lote: String,
    pub codigo_lote: String,
    pub producto: String,
    /// Lo que dice la columna.
    pub guardado: f64,
    /// Lo que sale de `SUM(Movimientos_Stock.Delta) - SUM(Lote_Consumos.Cantidad)`.
    pub calculado: f64,
}

impl LoteDescuadrado {
    pub fn desviacion(&self) -> f64 {
        self.guardado - self.calculado
    }
}

/// Cliente cuyo `Total_Gastado` se ha corregido al valor que suman sus pagos.
#[derive(Debug, Clone)]
pub struct ClienteCorregido {
    pub id_cliente: String,
    pub nombre: String,
    pub antes: f64,
    pub despues: f64,
}

#[async_trait]
pub trait ReconciliacionRepository: Send + Sync {
    /// Lotes cuyo disponible se desvía más de `tolerancia` de su historial.
    ///
    /// No se corrigen solos **a propósito**: un descuadre de stock puede venir de un movimiento
    /// que falta o de una venta que no llegó a aplicarse, y no hay forma de saber cuál de los dos
    /// números es el bueno. Machacar la columna podría borrar stock real de un almacén.
    async fn lotes_descuadrados(&self, tolerancia: f64) -> AppResult<Vec<LoteDescuadrado>>;

    /// Recalcula `Clientes.Total_Gastado` desde los pagos y corrige los que se desvíen más de
    /// `tolerancia`. Devuelve los corregidos.
    ///
    /// Este **sí** se corrige solo: es una cifra íntegramente derivable de `Pagos`, así que el
    /// valor recalculado es por definición el correcto.
    async fn corregir_gasto_de_clientes(&self, tolerancia: f64)
        -> AppResult<Vec<ClienteCorregido>>;
}
