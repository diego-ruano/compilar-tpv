//! Adaptador SQLite del repositorio de **venta rápida** (barra). Local-First:
//! sin Applied_Operations, sin Outbox, sin idempotencia por op_id ni ramas remote_id. El cobro sí es
//! idempotente, por su `ID_Pago`, que genera la pantalla (ver `cobrar_fraccionado`).

use crate::util::{new_id, CANAL_BARRA};
use crate::consultas::{db_err, trabajador_id_from_usuario, resolve_trabajador_id_input, update_total_comanda_sql};
use tpv_domain::dinero::Dinero;
use std::sync::Arc;

use async_trait::async_trait;
use crate::ejecutor::Value;

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::venta_rapida::VentaRapidaRepository;
use tpv_contracts::venta_rapida::{
    CategoriaRow, ComandaBarraRow, IndexRow, LineaComandaRow, ProductoRow,
    VerTicketsDetalleRow, VrLineaAnadida,
};
use tpv_domain::venta_rapida::CobroFraccionado;

use crate::caja_movimientos::{self, MovimientoCaja};
use crate::db::{Db, Reader, Writer};
use crate::mapping::{norm_opt_string, v_f64, v_i64, v_string, v_dinero, dinero_val};

pub struct SqliteVentaRapidaRepository {
    db: Arc<Db>,
}

impl SqliteVentaRapidaRepository {
    pub fn new(db: Arc<Db>) -> Self {
        Self { db }
    }
    async fn confirmar_pendiente(&self, g: &crate::db::WriteGuard<'_>, mut pendiente: tpv_contracts::venta_rapida::CobroPendienteDto) -> AppResult<String> {
        let mut data = tpv_application::use_cases::venta_rapida::datos_cobro(pendiente.id_usuario.as_deref().unwrap_or_default(), pendiente.id_trabajador.as_deref(), pendiente.cobro.clone())?;
        // El método ya se validó al preparar; conservar también los apuntes internos históricos.
        data.metodo = tpv_domain::pago::normalize_metodo(&pendiente.cobro.metodo).map_err(AppError::validation)?;
        let resultado = self.ejecutar_cobro(g, data).await;
        if let Err(ref error) = resultado {
            pendiente.ultimo_error = Some(error.to_string());
            crate::cobros_pendientes::escribir(g, &pendiente).await?;
        }
        resultado
    }

    async fn ejecutar_cobro(&self, g: &crate::db::WriteGuard<'_>, data: CobroFraccionado) -> AppResult<String> {
        let db = g;

        let id_pago_final = data.id_pago.clone();

        let id_usuario = data
            .id_usuario_cobrador
            .filter(|s| !s.trim().is_empty());
        let id_trabajador_from_user = trabajador_id_from_usuario(db, id_usuario.clone()).await?;
        let id_trabajador_comanda = trabajador_id_from_comanda(db, &data.id_comanda).await?;
        let id_trabajador_cobrador = data
            .id_trabajador_cobrador
            .filter(|s| !s.trim().is_empty())
            .or(id_trabajador_from_user)
            .or(id_trabajador_comanda);

        let detalles = data.detalles.clone();

        let res: AppResult<String> = db.transaccion(async {
            // Un cobro que ya existe no se repite: se devuelve su número. Pasa cuando la aplicación
            // se cae después de este COMMIT y antes de que la pantalla quite el cobro de su cola: al
            // volver lo reintenta con el mismo id y, sin esto, se encontraba las líneas ya cobradas,
            // decía «No se pudo cobrar» y las devolvía a pendiente — con el cobro, la factura y el
            // stock ya guardados. Va antes de reservar el número y dentro de la transacción, para
            // que dos intentos a la vez no pasen los dos por aquí.
            //
            // Se devuelve aunque ese cobro se haya anulado después: el cobro ocurrió, y la anulación
            // es un hecho posterior que ya tiene su propio rastro.
            {
                let mut rows = db
                    .query(
                        "SELECT ID_Comanda, Numero_Ticket FROM Pagos WHERE ID_Pago = ?1;",
                        vec![Value::Text(id_pago_final.clone())],
                    )
                    .await
                    .map_err(db_err)?;
                if let Some(r) = rows.next().await.map_err(db_err)? {
                    let comanda = v_string(r.get_value(0).map_err(db_err)?).unwrap_or_default();
                    if comanda != data.id_comanda {
                        return Err(AppError::conflict(
                            "Ese id de cobro ya pertenece a un cobro de otra comanda",
                        ));
                    }
                    crate::cobros_pendientes::quitar(g, &id_pago_final).await?;
                    return Ok(v_string(r.get_value(1).map_err(db_err)?).unwrap_or_default());
                }
            }

            let placeholders = detalles.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            let sql = format!(
                r#"
                SELECT
                  IFNULL(SUM(CAST(ROUND(COALESCE(dc.Cantidad,1) * COALESCE(dc.Precio_Unitario,0)) AS INTEGER)), 0) AS Importe,
                  COUNT(*) AS NumValid
                FROM Detalle_Comanda dc
                WHERE dc.ID_Comanda = ?1
                  AND dc.ID_Detalle IN ({})
                  AND NOT EXISTS (SELECT 1 FROM v_lineas_cobradas pd WHERE pd.ID_Detalle = dc.ID_Detalle);
                "#,
                placeholders
            );

            let mut params: Vec<Value> = Vec::with_capacity(1 + detalles.len());
            params.push(Value::Text(data.id_comanda.clone()));
            for d in &detalles {
                params.push(Value::Text(d.clone()));
            }

            let mut rows = db.query(&sql, params).await.map_err(db_err)?;
            let (importe_total_db, num_valid) = match rows.next().await.map_err(db_err)? {
                Some(r) => {
                    let imp = v_dinero(r.get_value(0).map_err(db_err)?).unwrap_or(Dinero::CERO);
                    let n = v_i64(r.get_value(1).map_err(db_err)?).unwrap_or(0);
                    (imp, n)
                }
                None => (Dinero::CERO, 0),
            };

            if num_valid <= 0 || num_valid as usize != detalles.len() {
                return Err(AppError::conflict("No hay detalles válidos pendientes de pago"));
            }

            // AUD-17: lo que se guarda es lo que suma la base, no lo que manda la pantalla (que
            // `datos_cobro` ya mira). Con una línea en negativo, un total por debajo de cero sería
            // dinero que sale del cajón con el arqueo cuadrado. Se rechaza aquí, antes de reservar el
            // número, y vale igual para el cobro directo y para el pendiente que se reintenta.
            if importe_total_db.es_negativo() {
                return Err(AppError::validation("El importe no puede ser negativo."));
            }

            // FISCAL-01: el número se reserva DENTRO de la transacción. Antes se hacía fuera, y
            // con un contador de tickets daba igual gastar uno en un cobro que acabara en
            // ROLLBACK; ahora ese número es el de una factura, y un hueco tiene que ser un hueco
            // de verdad y no un número emitido dos veces.
            //
            // `Pagos.Numero_Ticket` guarda este mismo valor: un solo número para el papel, el
            // cobro y el registro.
            let numero_reservado = crate::verifactu::reservar_numero_factura(db).await?;
            let numero_ticket = numero_reservado.0.clone();
            // FISCAL-02: se captura aquí porque `data` se consume al construir los parámetros.
            let destinatario = data.destinatario.clone();

            if let Some(idt) = id_trabajador_cobrador.clone() {
                db.execute(
                    r#"
                    UPDATE Comandas
                    SET ID_Trabajador = ?2
                    WHERE ID_Comanda = ?1
                      AND ID_Trabajador IS NULL;
                    "#,
                    vec![Value::Text(data.id_comanda.clone()), Value::Text(idt)],
                )
                .await
                .map_err(db_err)?;
            }

            // Capturamos los detalles a cobrar (detalle, producto, cantidad) para validar
            // stock y escribir Lote_Consumos por ID_Detalle (trazabilidad FEFO).
            let mut charged: Vec<(String, String, f64)> = Vec::new();
            {
                let mut crows = db
                    .query(
                        &format!(
                            r#"
                            SELECT dc.ID_Detalle, dc.ID_Producto, CAST(COALESCE(dc.Cantidad,1) AS REAL)
                            FROM Detalle_Comanda dc
                            WHERE dc.ID_Comanda = ?1
                              AND dc.ID_Detalle IN ({})
                              AND NOT EXISTS (
                                SELECT 1 FROM v_lineas_cobradas pd WHERE pd.ID_Detalle = dc.ID_Detalle
                              )
                            ORDER BY dc.ID_Detalle;
                            "#,
                            placeholders
                        ),
                        {
                            let mut p: Vec<Value> = Vec::with_capacity(1 + detalles.len());
                            p.push(Value::Text(data.id_comanda.clone()));
                            for d in &detalles {
                                p.push(Value::Text(d.clone()));
                            }
                            p
                        },
                    )
                    .await
                    .map_err(db_err)?;

                while let Some(r) = crows.next().await.map_err(db_err)? {
                    let id_det = v_string(r.get_value(0).map_err(db_err)?).unwrap_or_default();
                    let id_prod = v_string(r.get_value(1).map_err(db_err)?).unwrap_or_default();
                    let qty = v_f64(r.get_value(2).map_err(db_err)?).unwrap_or(0.0);
                    if !id_det.is_empty() && !id_prod.is_empty() && qty > 0.0 {
                        charged.push((id_det, id_prod, qty));
                    }
                }
            }

            // VR-04: NO se valida suficiencia ni se bloquea el cobro por falta de stock. Los lotes
            // se consumen FEFO sin tomar de ninguno más de lo que tiene aquí; lo que no cubran se
            // descuenta del stock suelto del producto (que SÍ puede quedar negativo, como señal de
            // sobreventa). Un lote sólo baja de cero si una Handy lo consumió a la vez: el
            // descuento es relativo (VR-06) y los dos deltas se suman al replicar. Un
            // producto sin lotes y sin stock suelto configurado se vende sin descontar (no
            // inventariado). El exceso ya no aborta el cobro.

            // Se clonan para poder anotarlos también en el historial de caja: los originales se
            // consumen al construir los parámetros de aquí abajo.
            let usuario_mov = id_usuario.clone();
            let trabajador_mov = id_trabajador_cobrador.clone();

            db.execute(
                r#"
                INSERT INTO Pagos (
                  ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo,
                  ID_Usuario_Cobrador, ID_Trabajador_Cobrador, Numero_Ticket
                )
                VALUES (?1, ?2, datetime('now','localtime'), ?3, ?4, 'FRACCIONADO', ?5, ?6, ?7);
                "#,
                vec![
                    Value::Text(id_pago_final.clone()),
                    Value::Text(data.id_comanda.clone()),
                    Value::Text(data.metodo.to_string()),
                    dinero_val(importe_total_db),
                    usuario_mov.clone().map(Value::Text).unwrap_or(Value::Null),
                    trabajador_mov.clone().map(Value::Text).unwrap_or(Value::Null),
                    Value::Text(numero_ticket.clone()),
                ],
            )
            .await
            .map_err(db_err)?;

            // El cobro en el historial de caja (CUENTA-07), dentro de la misma transacción.
            caja_movimientos::registrar(
                db,
                MovimientoCaja {
                    tipo: caja_movimientos::TIPO_COBRO,
                    id_pago: Some(id_pago_final.clone()),
                    id_usuario: usuario_mov,
                    id_trabajador: trabajador_mov,
                    importe: importe_total_db,
                    metodo_pago: Some(data.metodo.to_string()),
                    ..Default::default()
                },
            )
            .await?;

            for det in &detalles {
                db.execute(
                    r#"
                    INSERT OR IGNORE INTO Pago_Detalles (ID_Pago, ID_Detalle)
                    SELECT ?1, dc.ID_Detalle
                    FROM Detalle_Comanda dc
                    WHERE dc.ID_Comanda = ?2
                      AND dc.ID_Detalle = ?3
                      AND NOT EXISTS (SELECT 1 FROM v_lineas_cobradas pd WHERE pd.ID_Detalle = dc.ID_Detalle);
                    "#,
                    vec![
                        Value::Text(id_pago_final.clone()),
                        Value::Text(data.id_comanda.clone()),
                        Value::Text(det.clone()),
                    ],
                )
                .await
                .map_err(db_err)?;
            }

            // Consumo de stock (lotes FEFO, luego suelto) con su traza por cobro: el mismo que el
            // cobro de mesa (RI-10). Sin validar suficiencia: ver VR-04 arriba.
            crate::consumo_stock::consumir_stock(db, &id_pago_final, &charged).await?;

            db.execute(update_total_comanda_sql(), vec![Value::Text(data.id_comanda.clone())])
                .await
                .map_err(db_err)?;

            // FISCAL-01. Dentro de la transacción del cobro y después de enlazar `Pago_Detalles`,
            // que es de donde sale el desglose de IVA del registro.
            crate::verifactu::emitir_cobro(
                db,
                &id_pago_final,
                numero_reservado,
                importe_total_db,
                // FISCAL-02: si el cliente dio sus datos sale una F1; si no, una F2 — y si el
                // importe pasa del límite de la simplificada sin datos, esto corta el cobro con
                // `factura_completa_requerida` y la pantalla los pide.
                destinatario,
            )
            .await?;

            let mut left = db
                .query(
                    r#"
                    SELECT COUNT(*)
                    FROM Detalle_Comanda dc
                    WHERE dc.ID_Comanda = ?1
                      AND NOT EXISTS (SELECT 1 FROM v_lineas_cobradas pd WHERE pd.ID_Detalle = dc.ID_Detalle);
                    "#,
                    vec![Value::Text(data.id_comanda.clone())],
                )
                .await
                .map_err(db_err)?;

            let pending_left = match left.next().await.map_err(db_err)? {
                Some(r) => v_i64(r.get_value(0).map_err(db_err)?).unwrap_or(0),
                None => 0,
            };

            if pending_left == 0 {
                db.execute(
                    r#"
                    UPDATE Comandas
                    SET
                      Estado = 'Pagada',
                      Total_Comanda = (
                        SELECT IFNULL(SUM(CAST(ROUND(COALESCE(Cantidad,1) * COALESCE(Precio_Unitario,0)) AS INTEGER)), 0)
                        FROM Detalle_Comanda
                        WHERE ID_Comanda = ?1
                      ),
                      Fecha_Hora_Cierre = datetime('now','localtime')
                    WHERE ID_Comanda = ?1;
                    "#,
                    vec![Value::Text(data.id_comanda.clone())],
                )
                .await
                .map_err(db_err)?;
            }

            crate::cobros_pendientes::quitar(g, &id_pago_final).await?;
            Ok(numero_ticket.clone())
        }).await;

        res
    }


}

/// ¿La línea `dc` sigue por cobrar? No está cobrada (`v_lineas_cobradas`) **ni la devolvió entera la
/// baja de su cobro** (`Motivo_Baja = 'DEVOLUCION'`). Esa baja deja el cobro `ANULADO`, así que sus
/// líneas salen de `v_lineas_cobradas`, pero no vuelven a cobrarse: el cliente se llevó la
/// consumición y se le devolvió el dinero (caja.md). Sin esto, el ticket salía en «Ver tickets» como
/// «SIN COBRAR», con su importe pendiente y el botón de cobrar. Lo mismo en el worker
/// (`LINEA_POR_COBRAR`, `venta_rapida.queries.ts`).
macro_rules! linea_por_cobrar {
    () => {
        "NOT EXISTS (SELECT 1 FROM v_lineas_cobradas pd WHERE pd.ID_Detalle = dc.ID_Detalle)
                  AND NOT EXISTS (
                    SELECT 1 FROM Pago_Detalles pdv JOIN Pagos pv ON pv.ID_Pago = pdv.ID_Pago
                    WHERE pdv.ID_Detalle = dc.ID_Detalle
                      AND pv.Estado = 'ANULADO' AND pv.Motivo_Baja = 'DEVOLUCION'
                  )"
    };
}

/// Lo que queda por cobrar de un ticket (`c`): sus líneas sin cobrar, cada una redondeada como se
/// cobra (CAJ-INC-03). Lo mismo en el worker (`PENDIENTE_DE_UN_TICKET`, `venta_rapida.queries.ts`).
///
/// Antes era `Total_Comanda − SUM(cobros activos)`, y una devolución es un cobro negativo activo:
/// un ticket devuelto entero (cobro de 6,03 € y devolución de −6,03 €) restaba 0 y salía con
/// «Pendiente 6,03 €». Por líneas, lo devuelto sigue cobrado (`v_lineas_cobradas`) y lo que vuelve
/// a estar pendiente tras dar de baja un cobro por error, también se ve.
const PENDIENTE_DE_UN_TICKET: &str = concat!(
    "COALESCE((
                SELECT SUM(CAST(ROUND(COALESCE(dc.Cantidad,1) * COALESCE(dc.Precio_Unitario,0)) AS INTEGER))
                FROM Detalle_Comanda dc
                WHERE dc.ID_Comanda = c.ID_Comanda
                  AND ",
    linea_por_cobrar!(),
    "
              ),0)"
);

async fn trabajador_id_from_comanda<C: Reader>(db: &C, id_comanda: &str) -> AppResult<Option<String>> {
    if id_comanda.trim().is_empty() {
        return Ok(None);
    }
    let mut rows = db
        .query(
            "SELECT ID_Trabajador FROM Comandas WHERE ID_Comanda=?1 LIMIT 1;",
            vec![Value::Text(id_comanda.to_string())],
        )
        .await
        .map_err(db_err)?;
    if let Some(r) = rows.next().await.map_err(db_err)? {
        return Ok(norm_opt_string(r.get_value(0).map_err(db_err)?));
    }
    Ok(None)
}

/// Último ticket de barra abierto (el más reciente). La venta rápida admite VARIOS tickets
/// abiertos a la vez; esto solo resuelve el "get_or_create", que reengancha con el último.
async fn find_open_barra_comanda_id<C: Reader>(db: &C) -> AppResult<Option<String>> {
    let mut rows = db
        .query(
            r#"
            SELECT ID_Comanda
            FROM Comandas
            WHERE Canal = ?1
              AND Estado = 'Abierta'
            ORDER BY datetime(Fecha_Hora_Apertura) DESC
            LIMIT 1;
            "#,
            vec![Value::Text(CANAL_BARRA.to_string())],
        )
        .await
        .map_err(db_err)?;
    let Some(r) = rows.next().await.map_err(db_err)? else {
        return Ok(None);
    };
    Ok(norm_opt_string(r.get_value(0).map_err(db_err)?))
}

#[async_trait]
impl VentaRapidaRepository for SqliteVentaRapidaRepository {
    async fn list_categorias_vendibles(&self) -> AppResult<Vec<CategoriaRow>> {
        let g = self.db.read().await;
        let db = &g;
        let mut rows = db
            .query(
                r#"
                SELECT ID_Categoria, Nombre, Nombre_Imagen, Ruta_Imagen, Vendible
                FROM Categorias_Producto
                WHERE COALESCE(Vendible,1)=1
                ORDER BY Nombre ASC;
                "#,
                (),
            )
            .await
            .map_err(db_err)?;

        let mut out = Vec::new();
        while let Some(r) = rows.next().await.map_err(db_err)? {
            out.push(CategoriaRow {
                ID_Categoria: v_string(r.get_value(0).map_err(db_err)?).unwrap_or_default(),
                Nombre: v_string(r.get_value(1).map_err(db_err)?).unwrap_or_default(),
                Nombre_Imagen: v_string(r.get_value(2).map_err(db_err)?),
                Ruta_Imagen: v_string(r.get_value(3).map_err(db_err)?),
                Vendible: v_i64(r.get_value(4).map_err(db_err)?),
            });
        }
        Ok(out)
    }

    async fn list_productos_by_categoria(&self, id_categoria: &str) -> AppResult<Vec<ProductoRow>> {
        let g = self.db.read().await;
        let db = &g;
        let mut rows = db
            .query(
                r#"
                SELECT
                  p.ID_Producto,
                  p.ID_Categoria,
                  p.Nombre,
                  COALESCE(p.Precio_Venta,0) AS Precio_Venta,
                  COALESCE(v.Stock_Actual,0) + COALESCE(p.Stock_Suelto,0) AS Stock_Actual,
                  COALESCE(p.Stock_Minimo,0) AS Stock_Minimo,
                  p.Unidad_Medida,
                  p.Nombre_Imagen,
                  p.Ruta_Imagen
                FROM Productos p
                JOIN Categorias_Producto c ON c.ID_Categoria = p.ID_Categoria
                LEFT JOIN v_inventario_producto_stock v ON v.ID_Producto = p.ID_Producto
                WHERE p.ID_Categoria = ?1
                  AND COALESCE(c.Vendible,1)=1
                  AND p.Archivado_En IS NULL
                ORDER BY p.Nombre ASC;
                "#,
                vec![Value::Text(id_categoria.to_string())],
            )
            .await
            .map_err(db_err)?;

        let mut out = Vec::new();
        while let Some(r) = rows.next().await.map_err(db_err)? {
            out.push(ProductoRow {
                ID_Producto: v_string(r.get_value(0).map_err(db_err)?).unwrap_or_default(),
                ID_Categoria: v_string(r.get_value(1).map_err(db_err)?).unwrap_or_default(),
                Nombre: v_string(r.get_value(2).map_err(db_err)?).unwrap_or_default(),
                Precio_Venta: v_dinero(r.get_value(3).map_err(db_err)?).unwrap_or(Dinero::CERO),
                Stock_Actual: v_f64(r.get_value(4).map_err(db_err)?).unwrap_or(0.0),
                Stock_Minimo: v_f64(r.get_value(5).map_err(db_err)?).unwrap_or(0.0),
                Unidad_Medida: v_string(r.get_value(6).map_err(db_err)?),
                Nombre_Imagen: v_string(r.get_value(7).map_err(db_err)?),
                Ruta_Imagen: v_string(r.get_value(8).map_err(db_err)?),
            });
        }
        Ok(out)
    }

    async fn search_productos(&self, query: String, limit: i64) -> AppResult<Vec<ProductoRow>> {
        let Some(query) = crate::busqueda::texto_a_buscar(&query) else {
            return Ok(vec![]);
        };
        let g = self.db.read().await;
        let db = &g;
        // Sin acentos ni mayúsculas (`crate::busqueda`), como en el worker (`searchProductos` de
        // `venta_rapida.queries.ts`). Con `instr` y no `LIKE`: allí el SQLite del Durable Object no
        // admite un patrón de `LIKE` de más de 50 bytes, y en un patrón el `%` y el `_` que teclea
        // el usuario son comodines.
        let mut rows = db
            .query(
                &format!(
                    r#"
                SELECT
                  p.ID_Producto,
                  p.ID_Categoria,
                  p.Nombre,
                  COALESCE(p.Precio_Venta,0) AS Precio_Venta,
                  COALESCE(v.Stock_Actual,0) + COALESCE(p.Stock_Suelto,0) AS Stock_Actual,
                  COALESCE(p.Stock_Minimo,0) AS Stock_Minimo,
                  p.Unidad_Medida,
                  p.Nombre_Imagen,
                  p.Ruta_Imagen
                FROM Productos p
                JOIN Categorias_Producto c ON c.ID_Categoria = p.ID_Categoria
                LEFT JOIN v_inventario_producto_stock v ON v.ID_Producto = p.ID_Producto
                WHERE instr({}, ?1) > 0
                  AND COALESCE(c.Vendible,1)=1
                  AND p.Archivado_En IS NULL
                ORDER BY p.Nombre ASC
                LIMIT ?2;
                "#,
                    crate::busqueda::normalizada("p.Nombre")
                ),
                vec![Value::Text(query), Value::Integer(limit)],
            )
            .await
            .map_err(db_err)?;

        let mut out = Vec::new();
        while let Some(r) = rows.next().await.map_err(db_err)? {
            out.push(ProductoRow {
                ID_Producto: v_string(r.get_value(0).map_err(db_err)?).unwrap_or_default(),
                ID_Categoria: v_string(r.get_value(1).map_err(db_err)?).unwrap_or_default(),
                Nombre: v_string(r.get_value(2).map_err(db_err)?).unwrap_or_default(),
                Precio_Venta: v_dinero(r.get_value(3).map_err(db_err)?).unwrap_or(Dinero::CERO),
                Stock_Actual: v_f64(r.get_value(4).map_err(db_err)?).unwrap_or(0.0),
                Stock_Minimo: v_f64(r.get_value(5).map_err(db_err)?).unwrap_or(0.0),
                Unidad_Medida: v_string(r.get_value(6).map_err(db_err)?),
                Nombre_Imagen: v_string(r.get_value(7).map_err(db_err)?),
                Ruta_Imagen: v_string(r.get_value(8).map_err(db_err)?),
            });
        }
        Ok(out)
    }

    async fn list_comandas_barra(&self, limit: Option<i64>) -> AppResult<Vec<ComandaBarraRow>> {
        let g = self.db.read().await;
        let db = &g;
        let lim = limit.unwrap_or(60).clamp(1, 200);

        const LINEA_POR_COBRAR: &str = linea_por_cobrar!();
        let sql = format!(
            r#"
            SELECT
              c.ID_Comanda,
              c.Fecha_Hora_Apertura,
              c.Estado,
              {PENDIENTE_DE_UN_TICKET} AS Total_Pendiente,
              COALESCE(c.Total_Comanda,0) AS Total_Comanda,
              COALESCE((
                SELECT COUNT(*)
                FROM Detalle_Comanda dc
                LEFT JOIN Productos pr ON pr.ID_Producto = dc.ID_Producto
                LEFT JOIN Categorias_Producto cat ON cat.ID_Categoria = pr.ID_Categoria
                WHERE dc.ID_Comanda = c.ID_Comanda
                  AND COALESCE(cat.Pasa_Cocina,0)=1
                  AND COALESCE(dc.Estado_Cocina,'PENDIENTE') <> 'PREPARADO'
              ),0) AS Pendientes_Cocina,
              COALESCE((
                SELECT COUNT(*)
                FROM Detalle_Comanda dc
                WHERE dc.ID_Comanda = c.ID_Comanda
                  AND {LINEA_POR_COBRAR}
              ),0) AS Pendientes_Pago
            FROM Comandas c
            WHERE c.Canal = ?2
              AND EXISTS (SELECT 1 FROM Detalle_Comanda dc WHERE dc.ID_Comanda = c.ID_Comanda)
            ORDER BY datetime(c.Fecha_Hora_Apertura) DESC, c.ID_Comanda DESC
            LIMIT ?1;
            "#
        );

        let mut rows = db
            .query(
                &sql,
                vec![Value::Integer(lim), Value::Text(CANAL_BARRA.to_string())],
            )
            .await
            .map_err(db_err)?;

        let mut out = Vec::new();
        while let Some(r) = rows.next().await.map_err(db_err)? {
            out.push(ComandaBarraRow {
                ID_Comanda: v_string(r.get_value(0).map_err(db_err)?).unwrap_or_default(),
                Fecha_Hora_Apertura: v_string(r.get_value(1).map_err(db_err)?).unwrap_or_default(),
                Estado: v_string(r.get_value(2).map_err(db_err)?).unwrap_or_else(|| "Abierta".into()),
                Total_Pendiente: v_dinero(r.get_value(3).map_err(db_err)?).unwrap_or(Dinero::CERO),
                Total_Comanda: v_dinero(r.get_value(4).map_err(db_err)?).unwrap_or(Dinero::CERO),
                Pendientes_Cocina: v_i64(r.get_value(5).map_err(db_err)?).unwrap_or(0),
                Pendientes_Pago: v_i64(r.get_value(6).map_err(db_err)?).unwrap_or(0),
            });
        }
        Ok(out)
    }

    async fn get_lineas_comanda(&self, id_comanda: &str) -> AppResult<Vec<LineaComandaRow>> {
        let g = self.db.read().await;
        let db = &g;
        let mut rows = db
            .query(
                r#"
                SELECT
                  dc.ID_Detalle,
                  dc.ID_Comanda,
                  dc.ID_Producto,
                  COALESCE(dc.Cantidad,1) AS Cantidad,
                  COALESCE(dc.Precio_Unitario,0) AS Precio_Unitario,
                  dc.Notas,
                  dc.Estado_Cocina,
                  CASE WHEN EXISTS (
                    SELECT 1 FROM v_lineas_cobradas pd WHERE pd.ID_Detalle = dc.ID_Detalle
                  ) THEN 1 ELSE 0 END AS Pagado,
                  COALESCE(dc.Nombre_Producto, p.Nombre, 'Producto') AS Nombre,
                  dc.IVA_Percent,
                  dc.Cambios_Ingredientes,
                  cat.Nombre AS Categoria
                FROM Detalle_Comanda dc
                LEFT JOIN Productos p ON p.ID_Producto = dc.ID_Producto
                LEFT JOIN Categorias_Producto cat ON cat.ID_Categoria = p.ID_Categoria
                WHERE dc.ID_Comanda = ?1
                ORDER BY dc.ID_Detalle ASC;
                "#,
                vec![Value::Text(id_comanda.to_string())],
            )
            .await
            .map_err(db_err)?;

        let mut out = Vec::new();
        while let Some(r) = rows.next().await.map_err(db_err)? {
            out.push(LineaComandaRow {
                ID_Detalle: v_string(r.get_value(0).map_err(db_err)?).unwrap_or_default(),
                ID_Comanda: v_string(r.get_value(1).map_err(db_err)?).unwrap_or_default(),
                ID_Producto: v_string(r.get_value(2).map_err(db_err)?).unwrap_or_default(),
                Cantidad: v_f64(r.get_value(3).map_err(db_err)?).unwrap_or(1.0),
                Precio_Unitario: v_dinero(r.get_value(4).map_err(db_err)?).unwrap_or(Dinero::CERO),
                Notas: v_string(r.get_value(5).map_err(db_err)?),
                Estado_Cocina: v_string(r.get_value(6).map_err(db_err)?),
                Pagado: v_i64(r.get_value(7).map_err(db_err)?).unwrap_or(0),
                Nombre: v_string(r.get_value(8).map_err(db_err)?).unwrap_or_else(|| "Producto".into()),
                IVA_Percent: v_f64(r.get_value(9).map_err(db_err)?),
                Cambios_Ingredientes: v_string(r.get_value(10).map_err(db_err)?),
                Categoria: v_string(r.get_value(11).map_err(db_err)?),
            });
        }
        Ok(out)
    }

    async fn get_index_rows(&self, ids: Vec<String>) -> AppResult<Vec<IndexRow>> {
        let g = self.db.read().await;
        let db = &g;
        if ids.is_empty() {
            return Ok(vec![]);
        }

        let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let params: Vec<Value> = ids.into_iter().map(Value::Text).collect();

        let sql = format!(
            r#"
            SELECT
              x.ID_Comanda AS ID_Comanda,
              (
                SELECT GROUP_CONCAT(nn.Nombre, ' · ')
                FROM (
                  SELECT DISTINCT COALESCE(dc2.Nombre_Producto, p2.Nombre, '') AS Nombre
                  FROM Detalle_Comanda dc2
                  LEFT JOIN Productos p2 ON p2.ID_Producto = dc2.ID_Producto
                  WHERE dc2.ID_Comanda = x.ID_Comanda
                  ORDER BY COALESCE(dc2.Nombre_Producto, p2.Nombre, '')
                ) nn
                WHERE nn.Nombre <> ''
              ) AS Productos,
              x.NumLineas AS NumLineas,
              x.Unidades AS Unidades
            FROM (
              SELECT
                dc.ID_Comanda AS ID_Comanda,
                COUNT(*) AS NumLineas,
                COALESCE(SUM(COALESCE(dc.Cantidad,1)),0) AS Unidades
              FROM Detalle_Comanda dc
              WHERE dc.ID_Comanda IN ({})
              GROUP BY dc.ID_Comanda
            ) x;
            "#,
            placeholders
        );

        let mut rows = db.query(&sql, params).await.map_err(db_err)?;

        let mut out = Vec::new();
        while let Some(r) = rows.next().await.map_err(db_err)? {
            let productos = match r.get_value(1).map_err(db_err)? {
                Value::Null => None,
                Value::Text(s) => {
                    let t = s.trim().to_string();
                    if t.is_empty() {
                        None
                    } else {
                        Some(t)
                    }
                }
                _ => None,
            };

            out.push(IndexRow {
                ID_Comanda: v_string(r.get_value(0).map_err(db_err)?).unwrap_or_default(),
                Productos: productos,
                NumLineas: v_i64(r.get_value(2).map_err(db_err)?).unwrap_or(0),
                Unidades: v_f64(r.get_value(3).map_err(db_err)?).unwrap_or(0.0),
            });
        }
        Ok(out)
    }

    async fn get_detalles_ver_ticket(
        &self,
        id_comanda: &str,
    ) -> AppResult<Vec<VerTicketsDetalleRow>> {
        let g = self.db.read().await;
        let db = &g;
        let mut rows = db
            .query(
                r#"
                SELECT
                  dc.ID_Detalle,
                  dc.ID_Producto,
                  -- El nombre congelado en la linea manda sobre el del catalogo, igual que en las
                  -- otras dos consultas de lineas (mesas y la comanda de barra). Esta se lo saltaba,
                  -- asi que un producto retirado del catalogo salia como "Producto" en ver-ticket y
                  -- con su nombre de verdad en la comanda: el mismo articulo con dos nombres segun
                  -- por donde se mirase.
                  COALESCE(dc.Nombre_Producto, p.Nombre, 'Producto') AS Nombre,
                  COALESCE(dc.Cantidad,1) AS Cantidad,
                  COALESCE(dc.Precio_Unitario,0) AS Precio_Unitario,
                  COALESCE(dc.Estado_Cocina,'PENDIENTE') AS Estado_Cocina,
                  CASE WHEN EXISTS (SELECT 1 FROM v_lineas_cobradas pd WHERE pd.ID_Detalle = dc.ID_Detalle)
                       THEN 1 ELSE 0 END AS Pagado,
                  dc.Notas,
                  dc.IVA_Percent,
                  dc.Cambios_Ingredientes
                FROM Detalle_Comanda dc
                LEFT JOIN Productos p ON p.ID_Producto = dc.ID_Producto
                WHERE dc.ID_Comanda = ?1
                ORDER BY dc.ID_Detalle ASC;
                "#,
                vec![Value::Text(id_comanda.to_string())],
            )
            .await
            .map_err(db_err)?;

        let mut out = Vec::new();
        while let Some(r) = rows.next().await.map_err(db_err)? {
            out.push(VerTicketsDetalleRow {
                ID_Detalle: v_string(r.get_value(0).map_err(db_err)?).unwrap_or_default(),
                ID_Producto: v_string(r.get_value(1).map_err(db_err)?).unwrap_or_default(),
                Nombre: v_string(r.get_value(2).map_err(db_err)?).unwrap_or_else(|| "Producto".into()),
                Cantidad: v_f64(r.get_value(3).map_err(db_err)?).unwrap_or(1.0),
                Precio_Unitario: v_dinero(r.get_value(4).map_err(db_err)?).unwrap_or(Dinero::CERO),
                Estado_Cocina: v_string(r.get_value(5).map_err(db_err)?)
                    .unwrap_or_else(|| "PENDIENTE".into()),
                Pagado: v_i64(r.get_value(6).map_err(db_err)?).unwrap_or(0),
                Notas: v_string(r.get_value(7).map_err(db_err)?),
                IVA_Percent: v_f64(r.get_value(8).map_err(db_err)?),
                Cambios_Ingredientes: v_string(r.get_value(9).map_err(db_err)?),
            });
        }
        Ok(out)
    }

    async fn create_comanda_barra(
        &self,
        id_trabajador: Option<String>,
        get_or_create: bool,
    ) -> AppResult<String> {
        let g = self.db.write().await;
        let db = &g;

        if get_or_create {
            if let Some(existing_open) = find_open_barra_comanda_id(db).await? {
                return Ok(existing_open);
            }
        }

        let id_trabajador_real = resolve_trabajador_id_input(db, id_trabajador).await?;
        let id_comanda_final = new_id();

        let res: AppResult<String> = db.transaccion(async {
            // Ticket de venta rápida: SIN mesa (Canal='BARRA'). Ya no compite con otros tickets
            // abiertos, así que tampoco hace falta la antigua purga de comandas de barra vacías
            // (existía solo para esquivar el índice único que compartían todas por la mesa BARRA).
            // AUD-16: alta pura, como la del worker (`createComandaBarra`), donde el id lo elige el
            // dispositivo y uno que ya existe no puede reabrir una comanda cobrada. Aquí el id es
            // siempre nuevo.
            db.execute(
                r#"
                INSERT INTO Comandas (
                  ID_Comanda, Fecha_Hora_Apertura, Estado, Total_Comanda, ID_Trabajador, ID_Mesa, Canal
                )
                VALUES (?1, datetime('now','localtime'), 'Abierta', 0, ?2, NULL, ?3)
                ON CONFLICT(ID_Comanda) DO NOTHING;
                "#,
                vec![
                    Value::Text(id_comanda_final.clone()),
                    id_trabajador_real.map(Value::Text).unwrap_or(Value::Null),
                    Value::Text(CANAL_BARRA.to_string()),
                ],
            )
            .await
            .map_err(db_err)?;

            Ok(id_comanda_final)
        }).await;

        res
    }

    async fn add_linea_comanda(
        &self,
        id_comanda: &str,
        id_producto: &str,
        cantidad: f64,
    ) -> AppResult<VrLineaAnadida> {
        let g = self.db.write().await;
        let db = &g;
        let id_detalle_final = new_id();

        // El nombre, el tipo de IVA y el precio se leen ANTES y se insertan como literales (igual
        // que `Estado_Cocina`): una subconsulta dentro del INSERT la reevaluaría la nube en otro
        // estado. Y se guardan en la línea porque una reimpresión tiene que enseñar lo del día de la
        // venta, y porque el producto puede haberse borrado del catálogo desde entonces (INV-05).
        // El precio sale del catálogo y no de la pantalla (RI-27).
        let producto = {
            let r = self.db.read().await;
            crate::mesas::snapshot_del_producto(&r, id_producto).await?
        };

        let precio = producto.precio;
        let res: AppResult<String> = db.transaccion(async {
            // INC-20261030-016: un ticket cobrado no admite líneas nuevas.
            crate::mesas::exigir_comanda_abierta(db, id_comanda).await?;
            // AUD-16: alta pura, como la del worker (`addLinea`), donde un id que ya existe no
            // puede mover ni reescribir una línea cobrada. Aquí el id es siempre nuevo.
            db.execute(
                r#"
                INSERT INTO Detalle_Comanda
                  (ID_Detalle, ID_Comanda, ID_Producto, Nombre_Producto, Cantidad, Precio_Unitario,
                   Notas, Estado_Cocina, IVA_Percent)
                VALUES
                  (?1, ?2, ?3, ?4, ?5, ?6, NULL, 'PENDIENTE', ?7)
                ON CONFLICT(ID_Detalle) DO NOTHING;
                "#,
                vec![
                    Value::Text(id_detalle_final.clone()),
                    Value::Text(id_comanda.to_string()),
                    Value::Text(id_producto.to_string()),
                    producto.nombre,
                    Value::Real(cantidad),
                    dinero_val(producto.precio),
                    producto.iva,
                ],
            )
            .await
            .map_err(db_err)?;

            db.execute(update_total_comanda_sql(), vec![Value::Text(id_comanda.to_string())])
                .await
                .map_err(db_err)?;

            Ok(id_detalle_final)
        }).await;

        res.map(|id_detalle| VrLineaAnadida { id_detalle, precio_unitario: precio })
    }

    async fn remove_last_unpaid_linea(
        &self,
        id_comanda: &str,
        id_producto: &str,
    ) -> AppResult<bool> {
        let g = self.db.write().await;
        let db = &g;

        let res: AppResult<bool> = db.transaccion(async {
            // RI-59: la última por clave (UUIDv7), pero antes una que cocina no haya preparado.
            db.execute(
                r#"
                DELETE FROM Detalle_Comanda
                WHERE ID_Detalle = (
                  SELECT dc.ID_Detalle
                  FROM Detalle_Comanda dc
                  WHERE dc.ID_Comanda = ?1
                    AND dc.ID_Producto = ?2
                    AND NOT EXISTS (SELECT 1 FROM v_lineas_cobradas pd WHERE pd.ID_Detalle = dc.ID_Detalle)
                  ORDER BY (COALESCE(dc.Estado_Cocina,'PENDIENTE') = 'PREPARADO') ASC, dc.ID_Detalle DESC
                  LIMIT 1
                );
                "#,
                vec![Value::Text(id_comanda.to_string()), Value::Text(id_producto.to_string())],
            )
            .await
            .map_err(db_err)?;

            db.execute(update_total_comanda_sql(), vec![Value::Text(id_comanda.to_string())])
                .await
                .map_err(db_err)?;

            Ok(true)
        }).await;

        res
    }

    async fn delete_linea_if_unpaid(&self, id_comanda: &str, id_detalle: &str) -> AppResult<bool> {
        let g = self.db.write().await;
        let db = &g;

        let res: AppResult<bool> = db.transaccion(async {
            db.execute(
                r#"
                DELETE FROM Detalle_Comanda
                WHERE ID_Detalle = ?1
                  AND ID_Comanda = ?2
                  AND NOT EXISTS (
                    SELECT 1 FROM v_lineas_cobradas pd WHERE pd.ID_Detalle = ?1
                  );
                "#,
                vec![Value::Text(id_detalle.to_string()), Value::Text(id_comanda.to_string())],
            )
            .await
            .map_err(db_err)?;

            db.execute(update_total_comanda_sql(), vec![Value::Text(id_comanda.to_string())])
                .await
                .map_err(db_err)?;

            Ok(true)
        }).await;

        res
    }

    async fn update_nota_detalle(&self, id_detalle: &str, nota: Option<String>) -> AppResult<bool> {
        let g = self.db.write().await;
        let db = &g;

        let affected = db
            .execute(
                "UPDATE Detalle_Comanda SET Notas = ?2 WHERE ID_Detalle = ?1;",
                vec![
                    Value::Text(id_detalle.to_string()),
                    nota.map(Value::Text).unwrap_or(Value::Null),
                ],
            )
            .await
            .map_err(db_err)?;

        if affected == 0 {
            return Err(AppError::not_found("Detalle no encontrado"));
        }
        Ok(true)
    }

    async fn cobrar_fraccionado(&self, data: CobroFraccionado) -> AppResult<String> {
        let g = self.db.write().await;
        let pendiente = crate::cobros_pendientes::preparar(&g, data).await?;
        self.confirmar_pendiente(&g, pendiente).await
    }

    async fn guardar_cobro_pendiente(&self, data: CobroFraccionado) -> AppResult<()> {
        let g = self.db.write().await;
        crate::cobros_pendientes::preparar(&g, data).await?;
        Ok(())
    }

    async fn listar_cobros_pendientes(&self) -> AppResult<Vec<tpv_contracts::venta_rapida::CobroPendienteDto>> {
        crate::cobros_pendientes::listar(&self.db.read().await).await
    }

    async fn resolver_cobro_pendiente(&self, input: tpv_contracts::venta_rapida::ResolverCobroPendienteInput) -> AppResult<String> {
        let g = self.db.write().await;
        let mut pendiente = crate::cobros_pendientes::listar(&g).await?.into_iter().find(|p| p.cobro.id_pago == input.id_pago)
            .ok_or_else(|| AppError::not_found("Ese cobro pendiente ya se ha resuelto"))?;
        if let Some(destinatario) = input.destinatario {
            pendiente.cobro.destinatario = Some(destinatario);
            crate::cobros_pendientes::escribir(&g, &pendiente).await?;
        }
        self.confirmar_pendiente(&g, pendiente).await
    }

    async fn cancelar_cobro_pendiente(&self, id_pago: &str) -> AppResult<bool> {
        let g = self.db.write().await;
        crate::cobros_pendientes::quitar(&g, id_pago).await
    }

    async fn delete_comanda_if_safe(&self, id_comanda: &str) -> AppResult<bool> {
        let g = self.db.write().await;
        let db = &g;

        let res: AppResult<bool> = db.transaccion(async {
            // Basta con que la comanda tenga UN cobro, activo o anulado (CUENTA-07). Y no es una
            // sutileza: `Pagos.ID_Comanda` va con `ON DELETE CASCADE`, así que borrar la comanda
            // se llevaría por delante la fila del cobro anulado — que es justo la prueba que este
            // cambio existe para conservar. Por eso se mira `Pagos` y no las líneas cobradas.
            let mut rows = db
                .query(
                    "SELECT EXISTS(SELECT 1 FROM Pagos WHERE ID_Comanda = ?1) AS HasPaid;",
                    vec![Value::Text(id_comanda.to_string())],
                )
                .await
                .map_err(db_err)?;

            let has_paid: i64 = match rows.next().await.map_err(db_err)? {
                Some(r) => v_i64(r.get_value(0).map_err(db_err)?).unwrap_or(0),
                None => 0,
            };

            if has_paid == 1 {
                return Err(AppError::conflict(
                    "La comanda tiene cobros registrados y no se puede borrar",
                ));
            }

            db.execute(
                "DELETE FROM Detalle_Comanda WHERE ID_Comanda = ?1;",
                vec![Value::Text(id_comanda.to_string())],
            )
            .await
            .map_err(db_err)?;

            let changed = db
                .execute(
                    "DELETE FROM Comandas WHERE ID_Comanda = ?1;",
                    vec![Value::Text(id_comanda.to_string())],
                )
                .await
                .map_err(db_err)?;

            if changed == 0 {
                return Err(AppError::not_found("Comanda no encontrada"));
            }

            Ok(true)
        }).await;

        res
    }
}

#[cfg(test)]
mod tests_total_negativo {
    //! AUD-17: la barra guarda lo que suma la base, no lo que manda la pantalla. Con una línea en
    //! negativo (un precio que entró de antes), la pantalla podía mandar 0 € y quedar un cobro ACTIVO
    //! de −50 € en efectivo: dinero que sale del cajón con el arqueo cuadrado. Se rechaza dentro de
    //! la transacción, antes de reservar el número, también al reintentar el cobro pendiente.

    use super::*;
    use crate::ejecutor::Connection;
    use tpv_contracts::venta_rapida::{ResolverCobroPendienteInput, VrCobrarFraccionadoInput};

    const ID: &str = "0192f7a4-3b1c-7d2e-8f00-123456789abc";
    const IMPORTE_NEGATIVO: &str = "El importe no puede ser negativo.";

    async fn preparar() -> (Arc<Db>, std::path::PathBuf) {
        let dir = crate::test_temp::dir_temporal("barra_total_negativo");
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        {
            let w = db.write().await;
            let conn: &Connection = w.raw();
            for sql in [
                "UPDATE Business_Settings SET CIF = 'B12345674', Razon_Social = 'Bar de Pruebas SL' WHERE ID = 1;",
                "INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre)
                   VALUES ('u1', '00000000-0000-7000-8000-000000000001', 'jefe@bar.example', 'x', 'Marta');",
                "INSERT INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('cat', 'Bebidas');",
                "INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta) VALUES ('ajuste', 'cat', 'Ajuste', -5000);",
                "INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura, Estado, Total_Comanda)
                   VALUES ('com', 'BARRA', '2027-01-15 12:00:00', 'Abierta', -5000);",
                "INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Cantidad, Precio_Unitario, IVA_Percent)
                   VALUES ('det-neg', 'com', 'ajuste', 1, -5000, 10);",
            ] {
                conn.execute(sql, Vec::<Value>::new())
                    .await
                    .unwrap_or_else(|e| panic!("sembrando: {sql}\n{e}"));
            }
        }
        (db, dir)
    }

    /// Todo lo que deja un cobro, número de factura incluido.
    async fn rastro(db: &Arc<Db>) -> Vec<f64> {
        let r = db.read().await;
        let mut v = Vec::new();
        for sql in [
            "SELECT COUNT(*) FROM Pagos;",
            "SELECT COUNT(*) FROM Pago_Detalles;",
            "SELECT COUNT(*) FROM Movimientos_Caja;",
            "SELECT COUNT(*) FROM Registros_Facturacion;",
            "SELECT COALESCE(SUM(Ultimo), 0) FROM Serie_Facturacion;",
        ] {
            let mut rows = r.query(sql, Vec::<Value>::new()).await.unwrap();
            let row = rows.next().await.unwrap().expect("sin filas");
            v.push(v_f64(row.get_value(0).unwrap()).unwrap_or(0.0));
        }
        v
    }

    fn es_importe_negativo(e: &AppError) -> bool {
        matches!(e, AppError::Validation(m) if m == IMPORTE_NEGATIVO)
    }

    #[tokio::test]
    async fn con_la_pantalla_en_cero_y_la_base_en_negativo_no_se_cobra_ni_al_reintentar() {
        let (db, _dir) = preparar().await;
        let repo = SqliteVentaRapidaRepository::new(db.clone());
        let nada = rastro(&db).await;
        assert_eq!(nada, vec![0.0; 5]);

        // La pantalla manda 0 €, que `datos_cobro` deja pasar; la base suma −50 €.
        let e = tpv_application::use_cases::venta_rapida::cobrar_fraccionado(
            &repo,
            "u1",
            None,
            VrCobrarFraccionadoInput {
                id_pago: ID.into(),
                id_comanda: "com".into(),
                metodo: "Efectivo".into(),
                importe_total: Dinero::CERO,
                detalles: vec!["det-neg".into()],
                destinatario: None,
            },
        )
        .await
        .unwrap_err();
        assert!(es_importe_negativo(&e), "{e:?}");
        assert_eq!(rastro(&db).await, nada, "ni pago, ni apunte, ni registro, ni número");

        // El cobro se queda pendiente con su motivo, y reintentarlo dice lo mismo sin dejar nada.
        let pendientes = repo.listar_cobros_pendientes().await.unwrap();
        assert_eq!(pendientes.len(), 1);
        assert_eq!(pendientes[0].ultimo_error.as_deref(), Some(IMPORTE_NEGATIVO));
        for _ in 0..2 {
            let e = repo
                .resolver_cobro_pendiente(ResolverCobroPendienteInput { id_pago: ID.into(), destinatario: None })
                .await
                .unwrap_err();
            assert!(es_importe_negativo(&e), "{e:?}");
            assert_eq!(rastro(&db).await, nada);
        }

        // Y se puede cancelar: la línea vuelve a quedar libre.
        assert!(repo.cancelar_cobro_pendiente(ID).await.unwrap());
        assert!(repo.listar_cobros_pendientes().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn un_pendiente_guardado_antes_tampoco_se_cobra() {
        // Un cobro que se guardó como pendiente (la pantalla lo conserva al arrancar) pasa por la
        // misma comprobación al resolverse.
        let (db, _dir) = preparar().await;
        let repo = SqliteVentaRapidaRepository::new(db.clone());
        repo.guardar_cobro_pendiente(CobroFraccionado {
            id_pago: ID.into(),
            id_comanda: "com".into(),
            metodo: tpv_domain::pago::MetodoPago::Efectivo,
            importe_total: Dinero::CERO,
            id_usuario_cobrador: Some("u1".into()),
            id_trabajador_cobrador: None,
            detalles: vec!["det-neg".into()],
            destinatario: None,
        })
        .await
        .unwrap();

        let e = repo
            .resolver_cobro_pendiente(ResolverCobroPendienteInput { id_pago: ID.into(), destinatario: None })
            .await
            .unwrap_err();
        assert!(es_importe_negativo(&e), "{e:?}");
        assert_eq!(rastro(&db).await, vec![0.0; 5]);
    }
}

#[cfg(test)]
mod tests_cobro_repetido {
    //! Cobrar dos veces el mismo cobro es cobrarlo una vez.
    //!
    //! La pantalla encola el cobro, lo manda y lo quita de la cola al volver la respuesta. Si la
    //! aplicación se cae entre el COMMIT y ese momento, al arrancar lo reintenta con el mismo id.
    //! Antes el reintento se encontraba las líneas ya cobradas y fallaba: la pantalla decía «No se
    //! pudo cobrar» y devolvía las líneas a pendiente, con el cobro, la factura y el stock guardados.

    use super::*;
    use crate::ejecutor::Connection;

    const ID: &str = "0192f7a4-3b1c-7d2e-8f00-123456789abc";

    const DOS_TICKETS_DE_BARRA: &[&str] = &[
        "UPDATE Business_Settings SET CIF = 'B12345674', Razon_Social = 'Bar de Pruebas SL'
           WHERE ID = 1;",
        "INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre)
           VALUES ('u1', '00000000-0000-7000-8000-000000000001', 'jefe@bar.example', 'x', 'Marta');",
        "INSERT INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('cat', 'Bebidas');",
        "INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta, Stock_Suelto)
           VALUES ('prod', 'cat', 'Cerveza', 300, 10);",
        "INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura, Estado, Total_Comanda)
           VALUES ('com', 'BARRA', '2027-01-15 12:00:00', 'Abierta', 300);",
        "INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Cantidad, Precio_Unitario, IVA_Percent)
           VALUES ('det', 'com', 'prod', 1, 300, 10);",
        "INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura, Estado, Total_Comanda)
           VALUES ('otra', 'BARRA', '2027-01-15 12:05:00', 'Abierta', 300);",
        "INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Cantidad, Precio_Unitario, IVA_Percent)
           VALUES ('det-otra', 'otra', 'prod', 1, 300, 10);",
    ];

    async fn preparar() -> (Arc<Db>, std::path::PathBuf) {
        let dir = crate::test_temp::dir_temporal("venta_rapida");
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        {
            let w = db.write().await;
            let conn: &Connection = w.raw();
            for sql in DOS_TICKETS_DE_BARRA {
                conn.execute(sql, Vec::<Value>::new())
                    .await
                    .unwrap_or_else(|e| panic!("sembrando: {sql}\n{e}"));
            }
        }
        (db, dir)
    }

    async fn cobrar(db: &Arc<Db>, id_pago: &str, comanda: &str, detalle: &str) -> AppResult<String> {
        SqliteVentaRapidaRepository::new(db.clone())
            .cobrar_fraccionado(CobroFraccionado {
                id_pago: id_pago.into(),
                id_comanda: comanda.into(),
                metodo: tpv_domain::pago::MetodoPago::Efectivo,
                importe_total: Dinero::CERO,
                id_usuario_cobrador: Some("u1".into()),
                id_trabajador_cobrador: None,
                detalles: vec![detalle.into()],
                destinatario: None,
            })
            .await
    }

    async fn numero(db: &Arc<Db>, sql: &str) -> f64 {
        let r = db.read().await;
        let mut rows = r.query(sql, Vec::<Value>::new()).await.unwrap();
        let row = rows.next().await.unwrap().expect("sin filas");
        v_f64(row.get_value(0).unwrap()).unwrap_or(0.0)
    }

    /// Todo lo que deja un cobro. Si un reintento añade cualquiera de estas cosas, ha cobrado otra vez.
    async fn rastro(db: &Arc<Db>) -> Vec<f64> {
        let mut v = Vec::new();
        for sql in [
            "SELECT COUNT(*) FROM Pagos;",
            "SELECT COUNT(*) FROM Pago_Detalles;",
            "SELECT COUNT(*) FROM Registros_Facturacion;",
            "SELECT COUNT(*) FROM Movimientos_Caja;",
            "SELECT COUNT(*) FROM Suelto_Consumos;",
            "SELECT Stock_Suelto FROM Productos WHERE ID_Producto = 'prod';",
            "SELECT COALESCE(SUM(Ultimo), 0) FROM Serie_Facturacion;",
        ] {
            v.push(numero(db, sql).await);
        }
        v
    }

    #[tokio::test]
    async fn repetirlo_devuelve_el_mismo_numero_sin_cobrar_otra_vez() {
        let (db, _dir) = preparar().await;
        let primero = cobrar(&db, ID, "com", "det").await.unwrap();
        assert!(!primero.is_empty());
        let tras_el_cobro = rastro(&db).await;
        assert_eq!(tras_el_cobro, vec![1.0, 1.0, 1.0, 1.0, 1.0, 9.0, 1.0]);

        let reintento = cobrar(&db, ID, "com", "det").await.unwrap();
        assert_eq!(reintento, primero, "el número es el del ticket que ya salió");
        assert_eq!(rastro(&db).await, tras_el_cobro, "ni pago, ni factura, ni stock, ni número nuevos");
    }

    #[tokio::test]
    async fn otro_id_sobre_las_mismas_lineas_se_sigue_rechazando() {
        // Lo idempotente es el cobro, no las líneas: un cobro distinto de algo ya cobrado no entra.
        let (db, _dir) = preparar().await;
        cobrar(&db, ID, "com", "det").await.unwrap();
        let antes = rastro(&db).await;

        let e = cobrar(&db, "0192f7a4-3b1c-7d2e-8f00-000000000002", "com", "det")
            .await
            .unwrap_err();
        assert_eq!(e.code(), tpv_contracts::errors::ErrorCode::Conflict);
        assert_eq!(rastro(&db).await, antes);
    }

    #[tokio::test]
    async fn el_id_de_un_cobro_de_otra_comanda_no_devuelve_su_numero() {
        // Si no, la pantalla daría por cobrada una comanda con el ticket de otra.
        let (db, _dir) = preparar().await;
        cobrar(&db, ID, "com", "det").await.unwrap();
        let antes = rastro(&db).await;

        let e = cobrar(&db, ID, "otra", "det-otra").await.unwrap_err();
        assert_eq!(e.code(), tpv_contracts::errors::ErrorCode::Conflict);
        assert_eq!(rastro(&db).await, antes);
        assert_eq!(
            numero(&db, "SELECT COUNT(*) FROM v_lineas_cobradas WHERE ID_Detalle = 'det-otra';").await,
            0.0
        );
    }

    #[tokio::test]
    async fn repetir_un_cobro_ya_anulado_no_lo_vuelve_a_cobrar() {
        // Alguien lo anuló antes de que llegara el reintento. El cobro ocurrió y la anulación
        // también: volver a cobrar desharía la decisión de quien anuló.
        let (db, _dir) = preparar().await;
        let primero = cobrar(&db, ID, "com", "det").await.unwrap();
        {
            let w = db.write().await;
            w.raw()
                .execute(
                    "UPDATE Pagos SET Estado = 'ANULADO', Anulado_En = '2027-01-15 12:10:00',
                       Anulado_Por = 'u1', Motivo_Anulacion = 'error', Motivo_Baja = 'ERROR';",
                    Vec::<Value>::new(),
                )
                .await
                .unwrap();
        }

        assert_eq!(cobrar(&db, ID, "com", "det").await.unwrap(), primero);
        assert_eq!(numero(&db, "SELECT COUNT(*) FROM Pagos;").await, 1.0);
        assert_eq!(
            numero(&db, "SELECT COUNT(*) FROM v_lineas_cobradas WHERE ID_Detalle = 'det';").await,
            0.0,
            "la línea sigue pendiente, como la dejó la anulación"
        );
    }
    #[tokio::test]
    async fn pendiente_sobrevive_al_fallo_y_otro_operador_lo_resuelve_sin_cambiar_la_atribucion() {
        let (db, _dir) = preparar().await;
        let repo = SqliteVentaRapidaRepository::new(db.clone());
        { let w = db.write().await; w.raw().execute("UPDATE Business_Settings SET CIF = NULL;", ()).await.unwrap(); }
        assert!(cobrar(&db, ID, "com", "det").await.is_err());
        let pendientes = repo.listar_cobros_pendientes().await.unwrap();
        assert_eq!(pendientes.len(), 1);
        assert_eq!(pendientes[0].id_usuario.as_deref(), Some("u1"));
        assert!(pendientes[0].ultimo_error.is_some());
        assert_eq!(numero(&db, "SELECT COUNT(*) FROM Pagos;").await, 0.0);
        { let w = db.write().await; w.raw().execute("UPDATE Business_Settings SET CIF = 'B12345674';", ()).await.unwrap(); }
        let numero_ticket = repo.resolver_cobro_pendiente(tpv_contracts::venta_rapida::ResolverCobroPendienteInput { id_pago: ID.into(), destinatario: None }).await.unwrap();
        assert!(!numero_ticket.is_empty());
        assert!(repo.listar_cobros_pendientes().await.unwrap().is_empty());
        let r = db.read().await;
        let mut rows = r.query("SELECT ID_Usuario_Cobrador FROM Pagos WHERE ID_Pago = ?1;", vec![Value::Text(ID.into())]).await.unwrap();
        assert_eq!(v_string(rows.next().await.unwrap().unwrap().get_value(0).unwrap()).as_deref(), Some("u1"));
    }

    #[tokio::test]
    async fn preparacion_no_replica_datos_personales_y_evitar_dos_intenciones_para_las_mismas_lineas() {
        let (db, _dir) = preparar().await;
        let repo = SqliteVentaRapidaRepository::new(db.clone());
        let datos = |id: &str| CobroFraccionado {
            id_pago: id.into(), id_comanda: "com".into(), metodo: tpv_domain::pago::MetodoPago::Efectivo, importe_total: Dinero::de_centimos(300),
            id_usuario_cobrador: Some("u1".into()), id_trabajador_cobrador: None, detalles: vec!["det".into()],
            destinatario: Some(tpv_domain::verifactu::Destinatario { nombre_razon: "Señor Prueba".into(), nif: "12345678Z".into(), direccion: None }),
        };
        let antes = numero(&db, "SELECT COUNT(*) FROM _Sync_Outbox;").await;
        repo.guardar_cobro_pendiente(datos(ID)).await.unwrap();
        assert_eq!(numero(&db, "SELECT COUNT(*) FROM _Sync_Outbox;").await, antes);
        let restaurado = repo.listar_cobros_pendientes().await.unwrap();
        assert_eq!(restaurado[0].cobro.destinatario.as_ref().unwrap().nombre_razon, "Señor Prueba");
        assert!(repo.guardar_cobro_pendiente(datos("0192f7a4-3b1c-7d2e-8f00-123456789abd")).await.is_err());
        assert!(repo.cancelar_cobro_pendiente(ID).await.unwrap());
        assert_eq!(numero(&db, "SELECT COUNT(*) FROM Pagos;").await, 0.0);
    }

}

#[cfg(test)]
mod tests_borrado_desde_la_handy {
    //! AUD-14: borrar un ticket desde la Handy. El worker decide con lo que ve en la nube
    //! (`hasPaidLines`) y lo que llega aquí son sus `DELETE`, por la réplica y no por
    //! `delete_comanda_if_safe`. La Main puede tener ese ticket cobrado con el cobro todavía en el
    //! outbox: la condición viaja dentro de las sentencias y se vuelve a evaluar aquí. Sin ella, la
    //! cascada de `Pagos.ID_Comanda` se llevaba el cobro, sus líneas cobradas y sus consumos, y el
    //! esperado del arqueo bajaba lo cobrado.

    use super::*;
    use crate::ejecutor::Connection;
    use crate::sync::SqliteSyncRepository;
    use serde_json::json;
    use tpv_application::ports::sync::SyncRepository;
    use tpv_contracts::sync::{SqlStatement, SyncChange};

    const PAGO: &str = "0192f7a4-3b1c-7d2e-8f00-123456789abc";

    const TICKET_ABIERTO: &[&str] = &[
        "UPDATE Business_Settings SET CIF = 'B12345674', Razon_Social = 'Bar de Pruebas SL'
           WHERE ID = 1;",
        "INSERT INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('cat', 'Bebidas');",
        "INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta)
           VALUES ('cana', 'cat', 'Caña', 200);",
        "INSERT INTO Lotes_Producto (ID_Lote, ID_Producto, Codigo_Lote, Stock_Disponible, Fecha_Entrada)
           VALUES ('lote', 'cana', 'L1', 10, '2027-01-15 10:00:00');",
        "INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura, Estado)
           VALUES ('ticket', 'BARRA', '2027-01-15 12:00:00', 'Abierta');",
        "INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Cantidad, Precio_Unitario)
           VALUES ('linea', 'ticket', 'cana', 3, 200);",
    ];

    /// Lo que difunde el `TenantHub` al borrar `ticket` desde la Handy. `contract.test.ts` del
    /// worker («borrar un ticket no se lleva su cobro») comprueba que es exactamente este texto.
    fn borrado_de_la_handy() -> Vec<SqlStatement> {
        let sin_cobros = "NOT EXISTS (SELECT 1 FROM Pagos WHERE ID_Comanda = ?1) \
            AND NOT EXISTS (SELECT 1 FROM v_lineas_cobradas v JOIN Detalle_Comanda dc \
            ON dc.ID_Detalle = v.ID_Detalle WHERE dc.ID_Comanda = ?1)";
        vec![
            SqlStatement {
                sql: format!("DELETE FROM Detalle_Comanda WHERE ID_Comanda = ?1 AND {sin_cobros};"),
                args: vec![json!("ticket")],
            },
            SqlStatement {
                sql: format!("DELETE FROM Comandas WHERE ID_Comanda = ?1 AND {sin_cobros};"),
                args: vec![json!("ticket")],
            },
        ]
    }

    async fn preparar(nombre: &str) -> (Arc<Db>, std::path::PathBuf) {
        let dir = crate::test_temp::dir_temporal(nombre);
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        {
            let w = db.write().await;
            let conn: &Connection = w.raw();
            for sql in TICKET_ABIERTO {
                conn.execute(sql, Vec::<Value>::new())
                    .await
                    .unwrap_or_else(|e| panic!("sembrando: {sql}\n{e}"));
            }
        }
        (db, dir)
    }

    async fn valor(db: &Arc<Db>, sql: &str) -> Value {
        let r = db.read().await;
        let mut rows = r.query(sql, Vec::<Value>::new()).await.unwrap();
        match rows.next().await.unwrap() {
            Some(fila) => fila.get_value(0).unwrap(),
            None => Value::Null,
        }
    }

    /// Lo que un cobro deja y lo que CUENTA-07 exige conservar.
    #[derive(Debug, PartialEq)]
    struct Foto {
        comanda: Value,
        lineas: Value,
        pagos: Value,
        efectivo_que_cuenta: Value,
        pago_detalles: Value,
        lote_consumos: Value,
        pago_del_cobro_en_caja: Value,
        pago_del_registro_fiscal: Value,
    }

    async fn foto(db: &Arc<Db>) -> Foto {
        Foto {
            comanda: valor(db, "SELECT COUNT(*) FROM Comandas WHERE ID_Comanda = 'ticket';").await,
            lineas: valor(db, "SELECT COUNT(*) FROM Detalle_Comanda WHERE ID_Comanda = 'ticket';").await,
            pagos: valor(db, "SELECT COUNT(*) FROM Pagos;").await,
            efectivo_que_cuenta: valor(
                db,
                "SELECT COALESCE(SUM(Importe_Total), 0) FROM Pagos
                  WHERE Metodo_Pago = 'Efectivo' AND Estado = 'ACTIVO';",
            )
            .await,
            pago_detalles: valor(db, "SELECT COUNT(*) FROM Pago_Detalles;").await,
            lote_consumos: valor(db, "SELECT COUNT(*) FROM Lote_Consumos;").await,
            pago_del_cobro_en_caja: valor(db, "SELECT ID_Pago FROM Movimientos_Caja WHERE Tipo = 'COBRO';").await,
            pago_del_registro_fiscal: valor(db, "SELECT ID_Pago FROM Registros_Facturacion;").await,
        }
    }

    fn cobrado() -> Foto {
        Foto {
            comanda: Value::Integer(1),
            lineas: Value::Integer(1),
            pagos: Value::Integer(1),
            efectivo_que_cuenta: Value::Integer(600),
            pago_detalles: Value::Integer(1),
            lote_consumos: Value::Integer(1),
            pago_del_cobro_en_caja: Value::Text(PAGO.into()),
            pago_del_registro_fiscal: Value::Text(PAGO.into()),
        }
    }

    #[tokio::test]
    async fn el_borrado_de_la_handy_no_se_lleva_un_cobro_sin_subir() {
        let (db, _dir) = preparar("borrado_handy_cobrado").await;
        SqliteVentaRapidaRepository::new(db.clone())
            .cobrar_fraccionado(CobroFraccionado {
                id_pago: PAGO.into(),
                id_comanda: "ticket".into(),
                metodo: tpv_domain::pago::MetodoPago::Efectivo,
                importe_total: Dinero::CERO,
                id_usuario_cobrador: None,
                id_trabajador_cobrador: None,
                detalles: vec!["linea".into()],
                destinatario: None,
            })
            .await
            .unwrap();
        let sync = SqliteSyncRepository::new(db.clone());
        assert_eq!(sync.outbox_pending(50).await.unwrap().len(), 1, "el cobro está sin subir");
        assert_eq!(foto(&db).await, cobrado());

        // Su propio borrado lo niega dentro de la transacción (CUENTA-07): no necesita la condición.
        let e = SqliteVentaRapidaRepository::new(db.clone())
            .delete_comanda_if_safe("ticket")
            .await
            .unwrap_err();
        assert_eq!(e.code(), tpv_contracts::errors::ErrorCode::Conflict);

        let r = sync
            .apply_changes(vec![SyncChange {
                op_id: "op-handy".into(),
                seq: 1,
                statements: borrado_de_la_handy(),
            }])
            .await
            .unwrap();
        assert_eq!(r.aplicadas, vec!["op-handy".to_string()], "el cambio entra, sin borrar nada");
        assert_eq!(foto(&db).await, cobrado());
        assert_eq!(sync.outbox_pending(50).await.unwrap().len(), 1, "y el cobro sigue por subir");
    }

    #[tokio::test]
    async fn sin_cobro_el_borrado_de_la_handy_se_lleva_el_ticket_entero() {
        let (db, _dir) = preparar("borrado_handy_sin_cobro").await;
        let r = SqliteSyncRepository::new(db.clone())
            .apply_changes(vec![SyncChange {
                op_id: "op-handy".into(),
                seq: 1,
                statements: borrado_de_la_handy(),
            }])
            .await
            .unwrap();
        assert_eq!(r.aplicadas, vec!["op-handy".to_string()]);
        let f = foto(&db).await;
        assert_eq!((f.comanda, f.lineas), (Value::Integer(0), Value::Integer(0)));
    }

    /// La condición también mira las líneas: una del ticket cobrada por el cobro de otra comanda no
    /// se borra, y con ella tampoco el resto del ticket. Es una subconsulta sobre la misma tabla del
    /// primer `DELETE`; aquí, evaluada por el SQLite de la Main al aplicar la réplica.
    #[tokio::test]
    async fn una_linea_cobrada_por_otra_comanda_no_se_borra() {
        let (db, _dir) = preparar("borrado_handy_linea_de_otro_cobro").await;
        {
            let w = db.write().await;
            let conn: &Connection = w.raw();
            for sql in [
                "INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Cantidad, Precio_Unitario)
                   VALUES ('linea-2', 'ticket', 'cana', 1, 200);",
                "INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura, Fecha_Hora_Cierre, Estado, Total_Comanda)
                   VALUES ('otra', 'BARRA', '2027-01-15 11:00:00', '2027-01-15 11:30:00', 'Pagada', 200);",
                "INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Cantidad, Precio_Unitario)
                   VALUES ('linea-otra', 'otra', 'cana', 1, 200);",
                "INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo)
                   VALUES ('pago-otra', 'otra', '2027-01-15 11:30:00', 'Efectivo', 800, 'FRACCIONADO');",
                "INSERT INTO Pago_Detalles (ID_Pago, ID_Detalle) VALUES ('pago-otra', 'linea-otra');",
                "INSERT INTO Pago_Detalles (ID_Pago, ID_Detalle) VALUES ('pago-otra', 'linea');",
                "INSERT INTO Lote_Consumos (ID_Detalle, ID_Lote, ID_Pago, Cantidad) VALUES ('linea', 'lote', 'pago-otra', 3);",
                "INSERT INTO Suelto_Consumos (ID_Detalle, ID_Producto, ID_Pago, Cantidad) VALUES ('linea', 'cana', 'pago-otra', 1);",
            ] {
                conn.execute(sql, Vec::<Value>::new())
                    .await
                    .unwrap_or_else(|e| panic!("sembrando: {sql}\n{e}"));
            }
        }
        async fn rastro(db: &Arc<Db>) -> Vec<Value> {
            let mut v = Vec::new();
            for sql in [
                "SELECT COUNT(*) FROM Comandas WHERE ID_Comanda = 'ticket';",
                "SELECT COUNT(*) FROM Detalle_Comanda WHERE ID_Comanda = 'ticket';",
                "SELECT COUNT(*) FROM Pago_Detalles WHERE ID_Pago = 'pago-otra';",
                "SELECT COUNT(*) FROM Lote_Consumos WHERE ID_Pago = 'pago-otra';",
                "SELECT COUNT(*) FROM Suelto_Consumos WHERE ID_Pago = 'pago-otra';",
            ] {
                v.push(valor(db, sql).await);
            }
            v
        }
        let intacto: Vec<Value> = [1, 2, 2, 1, 1].into_iter().map(Value::Integer).collect();
        assert_eq!(rastro(&db).await, intacto);

        let r = SqliteSyncRepository::new(db.clone())
            .apply_changes(vec![SyncChange {
                op_id: "op-handy".into(),
                seq: 1,
                statements: borrado_de_la_handy(),
            }])
            .await
            .unwrap();
        assert_eq!(r.aplicadas, vec!["op-handy".to_string()], "el cambio entra, sin borrar nada");
        assert_eq!(rastro(&db).await, intacto);
    }
}


#[cfg(test)]
mod tests_pendiente_de_un_ticket {
    //! CAJ-INC-03: lo que «Ver tickets» enseña como pendiente sale de las líneas sin cobrar, no de
    //! `Total_Comanda − SUM(cobros activos)`: una devolución es un cobro negativo activo.

    use super::*;
    use crate::ejecutor::Connection;

    async fn con(sentencias: &[&str]) -> (Arc<Db>, std::path::PathBuf) {
        let dir = crate::test_temp::dir_temporal("barra_pendiente");
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        {
            let w = db.write().await;
            let conn: &Connection = w.raw();
            for sql in sentencias {
                conn.execute(sql, Vec::<Value>::new())
                    .await
                    .unwrap_or_else(|e| panic!("sembrando: {sql}\n{e}"));
            }
        }
        (db, dir)
    }

    const TICKET_COBRADO: &[&str] = &[
        "INSERT INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('cat', 'Bebidas');",
        "INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta) VALUES ('caña', 'cat', 'Caña', 201);",
        "INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura, Estado, Total_Comanda)
           VALUES ('com', 'BARRA', '2026-05-10 13:00:00', 'Pagada', 603);",
        "INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Cantidad, Precio_Unitario)
           VALUES ('det', 'com', 'caña', 3, 201);",
        "INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo)
           VALUES ('pago', 'com', '2026-05-10 13:10:00', 'Efectivo', 603, 'TOTAL');",
        "INSERT INTO Pago_Detalles (ID_Pago, ID_Detalle) VALUES ('pago', 'det');",
    ];

    async fn pendiente(db: &Arc<Db>) -> Dinero {
        let filas = SqliteVentaRapidaRepository::new(db.clone()).list_comandas_barra(None).await.unwrap();
        assert_eq!(filas.len(), 1);
        filas[0].Total_Pendiente
    }

    #[tokio::test]
    async fn un_ticket_devuelto_entero_no_queda_pendiente() {
        let mut seed = TICKET_COBRADO.to_vec();
        seed.push(
            "INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo,
                                ID_Pago_Origen, Motivo_Devolucion)
               VALUES ('dev', 'com', '2026-05-10 13:20:00', 'Efectivo', -603, 'DEVOLUCION', 'pago', 'no le gustó');",
        );
        let (db, _dir) = con(&seed).await;
        assert_eq!(pendiente(&db).await, Dinero::CERO);
    }

    #[tokio::test]
    async fn dar_de_baja_el_cobro_por_error_deja_pendientes_sus_lineas() {
        let mut seed = TICKET_COBRADO.to_vec();
        seed.push(
            "INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre)
               VALUES ('u1', '00000000-0000-7000-8000-000000000001', 'jefe@bar.example', 'x', 'Marta');",
        );
        seed.push(
            "UPDATE Pagos SET Estado = 'ANULADO', Anulado_En = '2026-05-10 13:30:00', Anulado_Por = 'u1',
                    Motivo_Anulacion = 'mesa equivocada', Motivo_Baja = 'ERROR' WHERE ID_Pago = 'pago';",
        );
        let (db, _dir) = con(&seed).await;
        assert_eq!(pendiente(&db).await, Dinero::de_centimos(603));
    }

    #[tokio::test]
    async fn un_ticket_dado_de_baja_como_devolucion_entera_no_queda_por_cobrar() {
        // La baja por DEVOLUCION deja el cobro ANULADO y sus líneas fuera de `v_lineas_cobradas`,
        // pero no vuelven: el cliente se llevó la consumición y se le devolvió el dinero. Salía
        // como «SIN COBRAR», con 6,03 € pendientes y el botón de cobrar.
        let mut seed = TICKET_COBRADO.to_vec();
        seed.push(
            "INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre)
               VALUES ('u1', '00000000-0000-7000-8000-000000000001', 'jefe@bar.example', 'x', 'Marta');",
        );
        seed.push(
            "UPDATE Pagos SET Estado = 'ANULADO', Anulado_En = '2026-05-10 13:30:00', Anulado_Por = 'u1',
                    Motivo_Anulacion = 'no le gustó', Motivo_Baja = 'DEVOLUCION' WHERE ID_Pago = 'pago';",
        );
        let (db, _dir) = con(&seed).await;
        let filas = SqliteVentaRapidaRepository::new(db.clone()).list_comandas_barra(None).await.unwrap();
        assert_eq!(filas[0].Total_Pendiente, Dinero::CERO);
        assert_eq!(filas[0].Pendientes_Pago, 0, "sin líneas por cobrar, sale como cobrado");
    }
}
