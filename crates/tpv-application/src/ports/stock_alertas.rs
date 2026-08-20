//! Puerto de **alertas de stock**: detectar productos con stock total negativo (sobreventa) para
//! avisar una vez por producto. Desde que los lotes pueden quedar en negativo (VR-06, migración
//! 0003), un producto puede acabar con stock total por debajo de cero; esto es la señal honesta de
//! que se ha vendido más de lo registrado y hay que recontar.
//!
//! Solo lo implementa el adaptador SQLite: corre en la Main, que es el escritor único.

use async_trait::async_trait;

use crate::error::AppResult;

/// Producto cuyo stock total (`SUM(lotes.Stock_Disponible) + Stock_Suelto`) es negativo.
#[derive(Debug, Clone)]
pub struct ProductoNegativo {
    pub id_producto: String,
    pub nombre: String,
    /// Stock total del producto, negativo (unidades sobrevendidas).
    pub stock_total: f64,
}

#[async_trait]
pub trait StockAlertasRepository: Send + Sync {
    /// Productos cuyo stock total es negativo (por debajo de una tolerancia mínima que absorbe el
    /// ruido de sumar muchos `REAL`). Es la señal de sobreventa que se avisa.
    async fn productos_en_negativo(&self) -> AppResult<Vec<ProductoNegativo>>;

    /// IDs de producto que HOY tienen una notificación de stock negativo **activa** (su
    /// `Clave_Dedupe` empieza por `prefijo`). Sirve para resolver las de los productos que ya se
    /// recuperaron: si un id está aquí pero ya no aparece en `productos_en_negativo`, su aviso se
    /// cierra y volverá a saltar si el producto reincide.
    async fn productos_con_alerta_activa(&self, prefijo: &str) -> AppResult<Vec<String>>;
}
