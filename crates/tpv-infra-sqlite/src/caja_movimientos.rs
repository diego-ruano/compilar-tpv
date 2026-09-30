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

use crate::mapping::dinero_val;
use tpv_domain::dinero::Dinero;
use libsql::Value;

use tpv_application::error::{AppError, AppResult};

use crate::db::Writer;
use crate::util::new_id;

/// Los tipos que admite el `CHECK` de la tabla. Ampliarlo (devoluciones de VENTA-01, Veri*factu)
/// es tocar el `CHECK` y añadir aquí la constante.
pub const TIPO_COBRO: &str = "COBRO";
pub const TIPO_ANULACION: &str = "ANULACION";
/// FISCAL-01: dinero que SALE del cajon por una venta real que se devuelve. No es una
/// anulacion: la venta existio, y lo que se emite es una factura rectificativa (R5), no un
/// RF de anulacion. Se distinguen en el historial porque son dos hechos distintos y al
/// investigar un descuadre importa cual fue.
pub const TIPO_DEVOLUCION: &str = "DEVOLUCION";
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
    pub importe: Dinero,
    pub metodo_pago: Option<String>,
    pub motivo: Option<String>,
}

fn texto(v: Option<String>) -> Value {
    match v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        Some(s) => Value::Text(s),
        None => Value::Null,
    }
}

/// La sentencia de [`registrar`]. Se replica tal cual, así que su `NOT EXISTS` se ejecuta también en
/// Turso en cada cobro: `planes::tests` vigila que vaya por `ux_movcaja_pago`/`ux_movcaja_gasto` y
/// no recorra el historial (RI-04).
pub(crate) const SQL_REGISTRAR: &str = r#"
    INSERT INTO Movimientos_Caja (
      ID_Movimiento, Fecha_Hora, Tipo, ID_Pago, ID_Gasto, ID_Usuario, ID_Trabajador,
      Importe, Metodo_Pago, Motivo
    )
    SELECT ?1, datetime('now','localtime'), ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
    WHERE NOT EXISTS (
      SELECT 1 FROM Movimientos_Caja mc
      WHERE mc.Tipo = ?2
        AND (?3 IS NOT NULL OR ?4 IS NOT NULL)
        AND ((?3 IS NOT NULL AND mc.ID_Pago = ?3) OR (?4 IS NOT NULL AND mc.ID_Gasto = ?4))
    );
"#;

/// Anota el movimiento. Va por `execute` (no por `raw`): el historial de caja es justo lo que hay
/// que poder mirar desde fuera del local, así que se replica como cualquier otra escritura.
///
/// El `ID_Movimiento` se genera **aquí, antes** de la sentencia, y nunca por DEFAULT ni trigger:
/// una `TEXT PRIMARY KEY` calculada dentro del SQL se re-evaluaría al replicar y la nube y la Main
/// acabarían con dos filas distintas para el mismo hecho (CLAUDE.md §9, «IDs deterministas»).
///
/// **Idempotente por (`Tipo`, apunte).** Los cobros y los gastos se guardan con `ON CONFLICT DO
/// UPDATE` para que un reintento del cliente no duplique la venta; sin el `WHERE NOT EXISTS` de
/// abajo, ese mismo reintento sí duplicaría su movimiento —cada uno con un `ID_Movimiento` nuevo,
/// así que ninguna clave los frenaría— y el historial contaría dos cobros donde hubo uno.
pub async fn registrar<C: Writer>(db: &C, m: MovimientoCaja) -> AppResult<()> {
    db.execute(
        SQL_REGISTRAR,
        vec![
            Value::Text(new_id()),
            Value::Text(m.tipo.to_string()),
            texto(m.id_pago),
            texto(m.id_gasto),
            texto(m.id_usuario),
            texto(m.id_trabajador),
            dinero_val(m.importe.abs()),
            texto(m.metodo_pago),
            texto(m.motivo),
        ],
    )
    .await
    .map_err(|e| AppError::repository(e.to_string()))?;
    Ok(())
}
