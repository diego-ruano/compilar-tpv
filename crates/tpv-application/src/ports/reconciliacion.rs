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

/// Cliente cuyo `Total_Gastado` no coincide con lo que suman sus pagos.
#[derive(Debug, Clone)]
pub struct ClienteDescuadrado {
    pub id_cliente: String,
    pub nombre: String,
    /// Lo que dice la ficha del cliente.
    pub guardado: f64,
    /// Lo que suman sus pagos.
    pub calculado: f64,
}

impl ClienteDescuadrado {
    pub fn desviacion(&self) -> f64 {
        self.guardado - self.calculado
    }
}

#[async_trait]
pub trait ReconciliacionRepository: Send + Sync {
    /// Lotes cuyo disponible se desvía más de `tolerancia` de su historial.
    ///
    /// No se corrigen solos **a propósito**: un descuadre de stock puede venir de un movimiento
    /// que falta o de una venta que no llegó a aplicarse, y no hay forma de saber cuál de los dos
    /// números es el bueno. Machacar la columna podría borrar stock real de un almacén.
    async fn lotes_descuadrados(&self, tolerancia: f64) -> AppResult<Vec<LoteDescuadrado>>;

    /// Clientes cuyo `Total_Gastado` se desvía más de `tolerancia` de lo que suman sus pagos.
    ///
    /// **Solo lee.** Aunque el valor sea derivable de `Pagos` y se podría corregir solo, el gasto
    /// acumulado de un cliente es un dato que el dueño del negocio mira y usa: que la aplicación se
    /// lo cambie por su cuenta, de madrugada y sin decir nada, es peor que enseñarle el descuadre y
    /// dejarle decidir.
    async fn clientes_descuadrados(&self, tolerancia: f64) -> AppResult<Vec<ClienteDescuadrado>>;

    /// Pone el `Total_Gastado` de un cliente en lo que suman sus pagos. Devuelve el valor
    /// resultante, o `None` si el cliente no existe.
    ///
    /// Es la única escritura del puerto y **nunca la dispara el job**: la ejecuta una persona
    /// desde la ficha del cliente, después de ver el descuadre.
    async fn recalcular_gasto(&self, id_cliente: &str) -> AppResult<Option<f64>>;
}
