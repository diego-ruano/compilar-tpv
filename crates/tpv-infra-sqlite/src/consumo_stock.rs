//! El consumo de stock de un cobro, **en un solo sitio** (RI-10).
//!
//! Había una copia del bucle por cobro: el de barra (`venta_rapida::cobrar_fraccionado`) consumía
//! de los lotes y, lo que no cubrían, del stock suelto (VR-04); el de mesa (`mesas::cobrar_*`) sólo
//! de los lotes. Un producto que se inventaría por stock suelto bajaba al venderse en barra y no al
//! venderse en mesa. Y una tercera copia (`restar_stock`) descontaba sin dejar traza. Ahora los dos
//! cobros llaman a [`consumir_stock`] y el espejo del worker es `domains/inventario/consumo.ts`.
//!
//! ## Qué hace
//!
//! Para cada línea cobrada:
//!
//! 1. **Lotes, FEFO**: por caducidad (los que no caducan, al final), luego por entrada. Nunca toma de
//!    un lote más de lo que tiene, así que este camino no deja un lote en negativo.
//! 2. **Stock suelto**: lo que los lotes no cubren se descuenta de `Productos.Stock_Suelto`, que sí
//!    puede quedar negativo (es la señal de sobreventa). Sólo si el producto lo usa
//!    (`Stock_Suelto IS NOT NULL`); si no, el producto no está inventariado y no se descuenta más.
//! 3. **La traza** de cada parte, en `Lote_Consumos` y `Suelto_Consumos`, **por cobro** (STOCK-01):
//!    es lo que permite que anular un cobro devuelva exactamente lo suyo.
//!
//! Es **best-effort**: la falta de stock no bloquea un cobro (VR-04).
//!
//! ## Por qué cada sentencia lleva literales
//!
//! Cada `UPDATE` va por `ID_Lote`/`ID_Producto` con la cantidad como valor, y se descuenta en
//! relativo y sin clamp (VR-06): la sentencia que se replica hace lo mismo en la nube, y si dos
//! cobros a la vez dejan un lote en negativo, las dos copias convergen en el mismo negativo.
//!
//! ## Por qué todo va redondeado a milésimas
//!
//! RI-26: con `REAL` sin redondear, un kilo vendido en diez raciones de 0,1 dejaba `1,39e-16` en el
//! lote, que el FEFO seguía eligiendo. Las cantidades que se calculan aquí pasan por
//! [`redondear_cantidad`] y cada `UPDATE` redondea su resultado con `ROUND(…, 3)`, en la Main y en la
//! nube por igual.

use crate::consultas::{db_err};
use crate::ejecutor::Value;

use tpv_application::error::AppResult;
use tpv_domain::cantidad::redondear_cantidad;

use crate::db::Writer;
use crate::mapping::{v_f64, v_string};

/// Consume el stock de las líneas de un cobro: `(id_detalle, id_producto, cantidad)`.
///
/// Va dentro de la transacción del cobro y **después** del `INSERT` del pago: las trazas llevan su
/// FK a `Pagos`.
pub(crate) async fn consumir_stock<C: Writer>(
    db: &C,
    id_pago: &str,
    lineas: &[(String, String, f64)],
) -> AppResult<()> {
    for (id_detalle, id_producto, cantidad) in lineas {
        // Se lee dentro de la transacción y línea a línea: dos líneas del mismo producto ven lo que
        // consumió la anterior.
        let lotes: Vec<(String, f64)> = {
            let mut rows = db
                .query(
                    r#"
                    SELECT ID_Lote, COALESCE(Stock_Disponible,0)
                    FROM Lotes_Producto
                    WHERE ID_Producto = ?1
                      AND ROUND(COALESCE(Stock_Disponible,0), 3) > 0
                    ORDER BY
                      CASE WHEN Caducidad IS NULL THEN 1 ELSE 0 END,
                      date(Caducidad) ASC,
                      datetime(Fecha_Entrada) ASC,
                      ID_Lote ASC;
                    "#,
                    vec![Value::Text(id_producto.clone())],
                )
                .await
                .map_err(db_err)?;
            let mut o = Vec::new();
            while let Some(r) = rows.next().await.map_err(db_err)? {
                let id_lote = v_string(r.get_value(0).map_err(db_err)?).unwrap_or_default();
                let stock = redondear_cantidad(v_f64(r.get_value(1).map_err(db_err)?).unwrap_or(0.0));
                if !id_lote.is_empty() && stock > 0.0 {
                    o.push((id_lote, stock));
                }
            }
            o
        };

        let mut restante = redondear_cantidad(*cantidad);
        for (id_lote, stock) in lotes {
            if restante <= 0.0 {
                break;
            }
            let toma = redondear_cantidad(restante.min(stock));
            if toma <= 0.0 {
                continue;
            }

            db.execute(
                r#"
                UPDATE Lotes_Producto
                SET Stock_Disponible = ROUND(COALESCE(Stock_Disponible,0) - ?2, 3)
                WHERE ID_Lote = ?1;
                "#,
                vec![Value::Text(id_lote.clone()), Value::Real(toma)],
            )
            .await
            .map_err(db_err)?;

            db.execute(
                r#"
                INSERT INTO Lote_Consumos (ID_Detalle, ID_Lote, ID_Pago, Cantidad)
                VALUES (?1, ?2, ?3, ?4)
                ON CONFLICT(ID_Detalle, ID_Lote, ID_Pago) DO NOTHING;
                "#,
                vec![
                    Value::Text(id_detalle.clone()),
                    Value::Text(id_lote),
                    Value::Text(id_pago.to_string()),
                    Value::Real(toma),
                ],
            )
            .await
            .map_err(db_err)?;

            restante = redondear_cantidad(restante - toma);
        }

        if restante > 0.0 {
            db.execute(
                "UPDATE Productos SET Stock_Suelto = ROUND(Stock_Suelto - ?2, 3) \
                 WHERE ID_Producto = ?1 AND Stock_Suelto IS NOT NULL;",
                vec![Value::Text(id_producto.clone()), Value::Real(restante)],
            )
            .await
            .map_err(db_err)?;

            // El EXISTS repite la condición del UPDATE de arriba para no apuntar un consumo que no
            // llegó a producirse: devolverlo al anular sería inventar stock.
            db.execute(
                r#"
                INSERT INTO Suelto_Consumos (ID_Detalle, ID_Producto, ID_Pago, Cantidad)
                SELECT ?1, ?2, ?3, ?4
                WHERE EXISTS (
                    SELECT 1 FROM Productos
                    WHERE ID_Producto = ?2 AND Stock_Suelto IS NOT NULL
                )
                ON CONFLICT(ID_Detalle, ID_Producto, ID_Pago) DO NOTHING;
                "#,
                vec![
                    Value::Text(id_detalle.clone()),
                    Value::Text(id_producto.clone()),
                    Value::Text(id_pago.to_string()),
                    Value::Real(restante),
                ],
            )
            .await
            .map_err(db_err)?;
        }
    }
    Ok(())
}

