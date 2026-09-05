//! El **historial de caja** (`Movimientos_Caja`). CUENTA-07.
//!
//! Una fila por hecho —un cobro, una anulación, un gasto— que no se borra nunca. Es para
//! **investigar**, no para calcular: `Pagos` sigue siendo la única fuente de verdad del dinero y el
//! arqueo sigue derivando de ahí. En cuanto alguien sume el esperado desde esta tabla habrá dos
//! fuentes para la misma cifra y divergirán.
//!
//! Vive en su propio módulo y no dentro de `cuentas.rs` porque lo escriben cuatro sitios distintos
//! (el cobro de mesa, el de venta rápida, el gasto y la anulación) y una sentencia copiada cuatro
//! veces es una sentencia que dentro de un año dice cuatro cosas distintas.

use libsql::Value;

use tpv_application::error::{AppError, AppResult};

use crate::db::Writer;
use crate::util::new_id;

/// Los tipos que admite el `CHECK` de la tabla. Ampliarlo (devoluciones de VENTA-01, Veri*factu)
/// es tocar el `CHECK` y añadir aquí la constante.
pub const TIPO_COBRO: &str = "COBRO";
pub const TIPO_ANULACION: &str = "ANULACION";
pub const TIPO_GASTO: &str = "GASTO";
pub const TIPO_GASTO_ANULADO: &str = "GASTO_ANULADO";

/// Un movimiento a punto de anotarse. Todo salvo `tipo` e `importe` es opcional: un gasto no tiene
/// pago y una anulación no tiene método.
#[derive(Debug, Clone, Default)]
pub struct MovimientoCaja {
    pub tipo: &'static str,
    pub id_pago: Option<String>,
    pub id_gasto: Option<String>,
    pub id_usuario: Option<String>,
    pub id_trabajador: Option<String>,
    /// **Siempre en positivo**; el signo lo da el `tipo`. Mezclar signos en una columna que
    /// alguien va a sumar es pedir un error.
    pub importe: f64,
    pub metodo_pago: Option<String>,
    pub motivo: Option<String>,
}

fn texto(v: Option<String>) -> Value {
    match v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        Some(s) => Value::Text(s),
        None => Value::Null,
    }
}

/// Anota el movimiento. Va por `execute` (no por `raw`): el historial de caja es justo lo que hay
/// que poder mirar desde fuera del local, así que se replica como cualquier otra escritura.
///
/// El `ID_Movimiento` se genera **aquí, antes** de la sentencia, y nunca por DEFAULT ni trigger:
/// una `TEXT PRIMARY KEY` calculada dentro del SQL se re-evaluaría al replicar y la nube y la Main
/// acabarían con dos filas distintas para el mismo hecho (CLAUDE.md §9, «IDs deterministas»).
pub async fn registrar<C: Writer>(db: &C, m: MovimientoCaja) -> AppResult<()> {
    db.execute(
        r#"
        INSERT INTO Movimientos_Caja (
          ID_Movimiento, Fecha_Hora, Tipo, ID_Pago, ID_Gasto, ID_Usuario, ID_Trabajador,
          Importe, Metodo_Pago, Motivo
        )
        VALUES (?1, datetime('now','localtime'), ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9);
        "#,
        vec![
            Value::Text(new_id()),
            Value::Text(m.tipo.to_string()),
            texto(m.id_pago),
            texto(m.id_gasto),
            texto(m.id_usuario),
            texto(m.id_trabajador),
            Value::Real(m.importe.abs()),
            texto(m.metodo_pago),
            texto(m.motivo),
        ],
    )
    .await
    .map_err(|e| AppError::repository(e.to_string()))?;
    Ok(())
}
