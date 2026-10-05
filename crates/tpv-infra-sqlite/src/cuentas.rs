//! Adaptador SQLite del repositorio de cuentas (caja). Local-First (sin outbox/applied).

use tpv_domain::dinero::Dinero;
use std::sync::Arc;

use async_trait::async_trait;
use libsql::Value;

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::cuentas::{AnularPagoArgs, CuentasFiltro, CuentasRepository, ClaseBaja};
use tpv_contracts::cuentas::{
    CursorCuentas, EntradaDto, PaginaEntradas, PaginaSalidas, ResumenCajaDto, SalidaDto,
};
use tpv_domain::cuentas::{GastoData, PagoData, ESTADO_ACTIVO, ESTADO_ANULADO};

use crate::caja_movimientos::{self, MovimientoCaja};
use crate::db::{Db, Reader, Writer};
use crate::mapping::{norm_opt_string, v_i64, v_string, v_dinero, dinero_val};
use crate::util::new_id;

pub struct SqliteCuentasRepository {
    db: Arc<Db>,
}

impl SqliteCuentasRepository {
    pub fn new(db: Arc<Db>) -> Self {
        Self { db }
    }
}

fn db_err(e: impl std::fmt::Display) -> AppError {
    AppError::repository(e.to_string())
}

/// La cláusula WHERE de un listado de caja: el rango de días y, si lo hay, el cursor de la página.
///
/// `del` y `al` son días, y los dos entran: `[del, al + 1 día)`. La función va sobre el PARÁMETRO y
/// nunca sobre la columna (RI-18): `date(columna)` impedía usar el índice por fecha y cada página de
/// Cuentas recorría todos los cobros. Vale para una columna con hora (`Pagos.Fecha_Hora`) y para
/// una que sólo guarda el día (`Cuentas_Gastos.Fecha`), porque las dos están en formato canónico.
///
/// El cursor deja sólo lo que va DESPUÉS de esa fila en el orden de la lista (`fecha DESC, id
/// DESC`). Se escribe `fecha <= c AND (fecha < c OR id < c_id)` y no como `(fecha, id) < (c, c_id)`
/// para que el índice por fecha quede acotado también por arriba: es lo que hace que la página 100
/// cueste lo mismo que la primera.
fn where_listado(
    del: Option<String>,
    al: Option<String>,
    cursor: Option<&CursorCuentas>,
    fecha_col: &str,
    id_col: &str,
) -> (String, Vec<Value>) {
    let mut parts: Vec<String> = Vec::new();
    let mut params: Vec<Value> = Vec::new();

    if let Some(d) = del.filter(|s| !s.trim().is_empty()) {
        params.push(Value::Text(d));
        parts.push(format!("{fecha_col} >= date(?{})", params.len()));
    }
    if let Some(a) = al.filter(|s| !s.trim().is_empty()) {
        params.push(Value::Text(a));
        parts.push(format!("{fecha_col} < date(?{}, '+1 day')", params.len()));
    }
    if let Some(c) = cursor {
        params.push(Value::Text(c.fecha.clone()));
        let f = params.len();
        params.push(Value::Text(c.id.clone()));
        let i = params.len();
        parts.push(format!(
            "{fecha_col} <= ?{f} AND ({fecha_col} < ?{f} OR {id_col} < ?{i})"
        ));
    }

    let where_sql = if parts.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", parts.join(" AND "))
    };
    (where_sql, params)
}

/// Construye la cláusula de búsqueda de texto (`WHERE <expr> LIKE …`) sobre las columnas ya
/// calculadas del subquery interno. Añade el parámetro a `params` y numera el placeholder de forma
/// consecutiva a los ya presentes. `expr` debe ser una expresión `lower(...)` con las columnas.
fn q_filter(params: &mut Vec<Value>, q: Option<String>, expr: &str) -> String {
    match q.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        Some(qs) => {
            let idx = params.len() + 1;
            params.push(Value::Text(qs.to_string()));
            format!("WHERE {expr} LIKE '%' || lower(?{idx}) || '%'")
        }
        None => String::new(),
    }
}

/// El `LIMIT` de una página: pide UNA fila de más, que no se devuelve, para saber si hay página
/// siguiente sin contar. `None` = sin paginar (se listan todas las filas).
fn limite(params: &mut Vec<Value>, page_size: Option<u32>) -> (String, Option<usize>) {
    match page_size {
        Some(ps) if ps > 0 => {
            params.push(Value::Integer(ps as i64 + 1));
            (format!("LIMIT ?{}", params.len()), Some(ps as usize))
        }
        _ => (String::new(), None),
    }
}

/// Recorta la fila de más que pidió [`limite`] y, si la había, devuelve el cursor de la siguiente
/// página: la clave de orden de la ÚLTIMA fila que sí se devuelve.
fn cortar_pagina<T>(
    mut filas: Vec<(T, CursorCuentas)>,
    page_size: Option<usize>,
) -> (Vec<T>, Option<CursorCuentas>) {
    let hay_mas = matches!(page_size, Some(ps) if filas.len() > ps);
    if let Some(ps) = page_size {
        filas.truncate(ps);
    }
    let siguiente = if hay_mas { filas.last().map(|(_, c)| c.clone()) } else { None };
    (filas.into_iter().map(|(f, _)| f).collect(), siguiente)
}

/// Subquery interno de **entradas** (cobros) con las columnas calculadas (fechaHora, cliente,
/// metodo, importe). Devuelve el SQL y los parámetros del rango de fechas.
fn entradas_inner(
    del: Option<String>,
    al: Option<String>,
    cursor: Option<&CursorCuentas>,
) -> (String, Vec<Value>) {
    let (where_rango, params) = where_listado(del, al, cursor, "p.Fecha_Hora", "p.ID_Pago");
    let sql = format!(
        r#"
        SELECT
          p.ID_Pago AS id,
          substr(p.Fecha_Hora, 1, 16) AS fechaHora,
          p.Fecha_Hora AS orden,
          -- RI-52: un ticket de barra se reconoce por su canal. Antes se comparaba con la mesa
          -- fantasma 'BARRA' de cuando la barra era una mesa, y salía como «Venta».
          (
            CASE
              WHEN c.Canal = 'BARRA' THEN 'Barra'
              WHEN m.Numero_Mesa IS NOT NULL AND m.Numero_Mesa <> '' THEN 'Mesa ' || m.Numero_Mesa
              ELSE 'Venta'
            END
            ||
            CASE
              WHEN cl.Nombre IS NOT NULL AND cl.Nombre <> '' THEN ' / ' || cl.Nombre
              ELSE ''
            END
          ) AS cliente,
          CASE WHEN p.Metodo_Pago = 'Tarjeta' THEN 'Tarjeta' ELSE 'Efectivo' END AS metodo,
          IFNULL(p.Importe_Total, 0) AS importe,
          COALESCE(p.Estado, 'ACTIVO') AS estado,
          p.Anulado_En AS anuladoEn,
          TRIM(COALESCE(ua.Nombre,'') || CASE WHEN COALESCE(ua.Apellido,'')='' THEN '' ELSE ' ' || ua.Apellido END) AS anuladoPor,
          p.Motivo_Anulacion AS motivoAnulacion
        FROM Pagos p
        JOIN Comandas c ON c.ID_Comanda = p.ID_Comanda
        LEFT JOIN Mesas m ON m.ID_Mesa = c.ID_Mesa
        LEFT JOIN Reservas r ON r.ID_Reserva = c.ID_Reserva
        -- RI-61: el cliente de la comanda (fijado al cobrar) y, si no, el de su reserva.
        LEFT JOIN Clientes cl ON cl.ID_Cliente = COALESCE(c.ID_Cliente, r.ID_Cliente)
        LEFT JOIN Usuarios ua ON ua.ID_Usuario = p.Anulado_Por
        {where_rango}
        "#
    );
    (sql, params)
}

/// Expresión de texto buscable de una fila de entradas (para el `LIKE`).
const ENTRADAS_Q_EXPR: &str =
    "lower(fechaHora || ' ' || cliente || ' ' || metodo || ' ' || CAST(importe AS TEXT))";

/// Subquery interno de **salidas** (gastos) con el nombre del proveedor incluido para poder
/// buscarlo. Devuelve el SQL y los parámetros del rango de fechas.
fn salidas_inner(
    del: Option<String>,
    al: Option<String>,
    cursor: Option<&CursorCuentas>,
) -> (String, Vec<Value>) {
    let (where_rango, params) = where_listado(del, al, cursor, "g.Fecha", "g.ID_Gasto");
    let sql = format!(
        r#"
        SELECT
          g.ID_Gasto AS id,
          substr(g.Fecha, 1, 10) AS fechaHora,
          g.Fecha AS orden,
          g.Tipo_Gasto AS tipoGasto,
          g.Concepto AS concepto,
          g.Importe AS importe,
          g.ID_Proveedor AS proveedorId,
          g.Pagado_Con_Caja AS pagadoConCaja,
          IFNULL(pr.Nombre_Empresa, '') AS proveedorNombre
        FROM Cuentas_Gastos g
        LEFT JOIN Proveedores pr ON pr.ID_Proveedor = g.ID_Proveedor
        {where_rango}
        "#
    );
    (sql, params)
}

/// Expresión de texto buscable de una fila de salidas (incluye proveedor id y nombre).
const SALIDAS_Q_EXPR: &str = "lower(fechaHora || ' ' || tipoGasto || ' ' || concepto || ' ' || CAST(importe AS TEXT) || ' ' || IFNULL(proveedorId,'') || ' ' || proveedorNombre)";

#[async_trait]
impl CuentasRepository for SqliteCuentasRepository {
    /// Los cobros anulados **salen** en esta lista, marcados: es la pantalla donde se investiga un
    /// descuadre y esconderlos aquí devolvería el producto al estado que CUENTA-07 arregla. Quien
    /// sí los descuenta es `resumen` (los totales de cabecera).
    async fn entradas(&self, filtro: CuentasFiltro) -> AppResult<PaginaEntradas> {
        let (inner, mut params) = entradas_inner(filtro.del, filtro.al, filtro.cursor.as_ref());
        let q_clause = q_filter(&mut params, filtro.q, ENTRADAS_Q_EXPR);
        let (limit_clause, page_size) = limite(&mut params, filtro.page_size);
        // Se ordena por la columna tal cual (`orden`), no por la que se enseña (`fechaHora`, un
        // `substr`): ordenar por una expresión obligaba a leer y ordenar TODO el rango incluso
        // para la primera página (RI-18).
        let sql = format!(
            "SELECT id, fechaHora, cliente, metodo, importe, estado, anuladoEn, anuladoPor, \
             motivoAnulacion, orden FROM ({inner}) AS e {q_clause} \
             ORDER BY orden DESC, id DESC {limit_clause};"
        );

        let db = self.db.read().await;
        let mut rows = db.query(sql.as_str(), params).await.map_err(db_err)?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().await.map_err(db_err)? {
            let id = v_string(row.get_value(0).map_err(db_err)?).unwrap_or_default();
            let fecha_hora = v_string(row.get_value(1).map_err(db_err)?).unwrap_or_default();
            let cliente = v_string(row.get_value(2).map_err(db_err)?).unwrap_or_default();
            let metodo =
                v_string(row.get_value(3).map_err(db_err)?).unwrap_or_else(|| "Efectivo".into());
            let importe = v_dinero(row.get_value(4).map_err(db_err)?).unwrap_or(Dinero::CERO);
            let estado = v_string(row.get_value(5).map_err(db_err)?)
                .unwrap_or_else(|| ESTADO_ACTIVO.to_string());
            let cursor = CursorCuentas {
                fecha: v_string(row.get_value(9).map_err(db_err)?).unwrap_or_default(),
                id: id.clone(),
            };
            out.push((
                EntradaDto {
                    id,
                    fecha_hora: fecha_hora.chars().take(16).collect(),
                    cliente,
                    metodo,
                    importe,
                    estado,
                    anulado_en: norm_opt_string(row.get_value(6).map_err(db_err)?),
                    anulado_por: norm_opt_string(row.get_value(7).map_err(db_err)?),
                    motivo_anulacion: norm_opt_string(row.get_value(8).map_err(db_err)?),
                },
                cursor,
            ));
        }
        let (filas, siguiente) = cortar_pagina(out, page_size);
        Ok(PaginaEntradas { filas, siguiente })
    }

    async fn salidas(&self, filtro: CuentasFiltro) -> AppResult<PaginaSalidas> {
        let (inner, mut params) = salidas_inner(filtro.del, filtro.al, filtro.cursor.as_ref());
        let q_clause = q_filter(&mut params, filtro.q, SALIDAS_Q_EXPR);
        let (limit_clause, page_size) = limite(&mut params, filtro.page_size);
        let sql = format!(
            "SELECT id, fechaHora, tipoGasto, concepto, importe, proveedorId, pagadoConCaja, orden \
             FROM ({inner}) AS g {q_clause} ORDER BY orden DESC, id DESC {limit_clause};"
        );

        let db = self.db.read().await;
        let mut rows = db.query(sql.as_str(), params).await.map_err(db_err)?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().await.map_err(db_err)? {
            let id = v_string(row.get_value(0).map_err(db_err)?).unwrap_or_default();
            let fecha = v_string(row.get_value(1).map_err(db_err)?).unwrap_or_default();
            let tipo = v_string(row.get_value(2).map_err(db_err)?).unwrap_or_default();
            let concepto = v_string(row.get_value(3).map_err(db_err)?).unwrap_or_default();
            let importe = v_dinero(row.get_value(4).map_err(db_err)?).unwrap_or(Dinero::CERO);
            let prov = norm_opt_string(row.get_value(5).map_err(db_err)?);
            let pagado_con_caja = v_i64(row.get_value(6).map_err(db_err)?).unwrap_or(0) != 0;
            let cursor = CursorCuentas {
                fecha: v_string(row.get_value(7).map_err(db_err)?).unwrap_or_default(),
                id: id.clone(),
            };
            out.push((
                SalidaDto {
                    id,
                    fecha_hora: fecha.chars().take(10).collect(),
                    tipo_gasto: tipo,
                    concepto,
                    importe,
                    proveedor_id: prov,
                    pagado_con_caja,
                },
                cursor,
            ));
        }
        let (filas, siguiente) = cortar_pagina(out, page_size);
        Ok(PaginaSalidas { filas, siguiente })
    }

    async fn resumen(
        &self,
        del: Option<String>,
        al: Option<String>,
        q: Option<String>,
    ) -> AppResult<ResumenCajaDto> {
        let db = self.db.read().await;

        // ── Entradas: total + total por método + conteo, sobre todo el rango + búsqueda. ──
        let (entradas_inner_sql, mut e_params) = entradas_inner(del.clone(), al.clone(), None);
        let e_q = q_filter(&mut e_params, q.clone(), ENTRADAS_Q_EXPR);
        // Los cobros anulados NO entran en los totales: un ticket anulado no es una venta. Y se
        // cuentan aparte porque «3 anulaciones por 40 €» junto a un descuadre de 40 € se explica
        // solo — es el dato que no existía antes de CUENTA-07.
        let e_sql = format!(
            r#"
            SELECT
              IFNULL(SUM(CASE WHEN estado <> 'ANULADO' THEN importe ELSE 0 END), 0),
              IFNULL(SUM(CASE WHEN estado <> 'ANULADO' AND metodo = 'Efectivo' THEN importe ELSE 0 END), 0),
              IFNULL(SUM(CASE WHEN estado <> 'ANULADO' AND metodo = 'Tarjeta' THEN importe ELSE 0 END), 0),
              SUM(CASE WHEN estado <> 'ANULADO' THEN 1 ELSE 0 END),
              SUM(CASE WHEN estado =  'ANULADO' THEN 1 ELSE 0 END),
              IFNULL(SUM(CASE WHEN estado =  'ANULADO' THEN importe ELSE 0 END), 0)
            FROM ({entradas_inner_sql}) AS e {e_q};
            "#
        );
        let (
            total_entradas,
            total_efectivo,
            total_tarjeta,
            count_entradas,
            count_anuladas,
            total_anulado,
        ) = {
            let mut rows = db.query(e_sql.as_str(), e_params).await.map_err(db_err)?;
            match rows.next().await.map_err(db_err)? {
                Some(row) => (
                    v_dinero(row.get_value(0).map_err(db_err)?).unwrap_or(Dinero::CERO),
                    v_dinero(row.get_value(1).map_err(db_err)?).unwrap_or(Dinero::CERO),
                    v_dinero(row.get_value(2).map_err(db_err)?).unwrap_or(Dinero::CERO),
                    v_i64(row.get_value(3).map_err(db_err)?).unwrap_or(0),
                    v_i64(row.get_value(4).map_err(db_err)?).unwrap_or(0),
                    v_dinero(row.get_value(5).map_err(db_err)?).unwrap_or(Dinero::CERO),
                ),
                None => (Dinero::CERO, Dinero::CERO, Dinero::CERO, 0, 0, Dinero::CERO),
            }
        };

        // ── Salidas: total + conteo. ──
        let (salidas_inner_sql, mut s_params) = salidas_inner(del, al, None);
        let s_q = q_filter(&mut s_params, q, SALIDAS_Q_EXPR);
        let s_sql = format!(
            "SELECT IFNULL(SUM(importe), 0), COUNT(*) FROM ({salidas_inner_sql}) AS g {s_q};"
        );
        let (total_salidas, count_salidas) = {
            let mut rows = db.query(s_sql.as_str(), s_params).await.map_err(db_err)?;
            match rows.next().await.map_err(db_err)? {
                Some(row) => (
                    v_dinero(row.get_value(0).map_err(db_err)?).unwrap_or(Dinero::CERO),
                    v_i64(row.get_value(1).map_err(db_err)?).unwrap_or(0),
                ),
                None => (Dinero::CERO, 0),
            }
        };

        Ok(ResumenCajaDto {
            total_entradas,
            total_salidas,
            total_efectivo,
            total_tarjeta,
            count_entradas,
            count_salidas,
            count_anuladas,
            total_anulado,
        })
    }

    async fn crear_gasto(
        &self,
        id: Option<String>,
        g: GastoData,
        id_usuario: Option<&str>,
    ) -> AppResult<bool> {
        let id_gasto = id.unwrap_or_else(new_id);
        let id_gasto_mov = id_gasto.clone();
        let importe = g.importe;
        let concepto = g.concepto.clone();
        let db = self.db.write().await;
        db.execute(
                r#"
                INSERT INTO Cuentas_Gastos (ID_Gasto, Fecha, Concepto, Importe, Tipo_Gasto, ID_Proveedor, Pagado_Con_Caja)
                VALUES (?1, date(?2), ?3, ?4, ?5, ?6, ?7)
                ON CONFLICT(ID_Gasto) DO UPDATE SET
                  Fecha = excluded.Fecha,
                  Concepto = excluded.Concepto,
                  Importe = excluded.Importe,
                  Tipo_Gasto = excluded.Tipo_Gasto,
                  ID_Proveedor = excluded.ID_Proveedor,
                  Pagado_Con_Caja = excluded.Pagado_Con_Caja;
                "#,
                vec![
                    Value::Text(id_gasto),
                    Value::Text(g.fecha),
                    Value::Text(g.concepto),
                    dinero_val(g.importe),
                    Value::Text(g.tipo_gasto),
                    match g.proveedor_id {
                        Some(id) => Value::Text(id),
                        None => Value::Null,
                    },
                    Value::Integer(i64::from(g.pagado_con_caja)),
                ],
            )
            .await
            .map_err(db_err)?;

        // Y su fila en el historial de caja (CUENTA-07): una salida de dinero es un movimiento de
        // caja como lo es un cobro. El `Motivo` guarda el concepto, que es lo que se lee al
        // repasar el historial sin tener que ir a buscar el gasto.
        caja_movimientos::registrar(
            &db,
            MovimientoCaja {
                tipo: caja_movimientos::TIPO_GASTO,
                id_gasto: Some(id_gasto_mov),
                id_usuario: id_usuario.map(|s| s.to_string()),
                importe,
                motivo: Some(concepto),
                ..Default::default()
            },
        )
        .await?;
        Ok(true)
    }

    async fn actualizar_gasto(&self, id_gasto: &str, g: GastoData) -> AppResult<bool> {
        let db = self.db.write().await;
        let affected = db
            .execute(
                r#"
                UPDATE Cuentas_Gastos
                SET Fecha = date(?2), Tipo_Gasto = ?3, Concepto = ?4, Importe = ?5, ID_Proveedor = ?6,
                    Pagado_Con_Caja = ?7
                WHERE ID_Gasto = ?1;
                "#,
                vec![
                    Value::Text(id_gasto.to_string()),
                    Value::Text(g.fecha),
                    Value::Text(g.tipo_gasto),
                    Value::Text(g.concepto),
                    dinero_val(g.importe),
                    match g.proveedor_id {
                        Some(id) => Value::Text(id),
                        None => Value::Null,
                    },
                    Value::Integer(i64::from(g.pagado_con_caja)),
                ],
            )
            .await
            .map_err(db_err)?;
        Ok(affected > 0)
    }

    async fn eliminar_gasto(&self, id_gasto: &str, id_usuario: Option<&str>) -> AppResult<bool> {
        let db = self.db.write().await;

        // El importe se lee ANTES del borrado: después la fila ya no está y el historial se
        // quedaría con un movimiento de 0 €, que no dice nada de lo que se deshizo.
        let importe = {
            let mut rows = db
                .query(
                    "SELECT IFNULL(Importe,0), COALESCE(Concepto,'') FROM Cuentas_Gastos WHERE ID_Gasto = ?1 LIMIT 1;",
                    vec![Value::Text(id_gasto.to_string())],
                )
                .await
                .map_err(db_err)?;
            match rows.next().await.map_err(db_err)? {
                Some(row) => Some((
                    v_dinero(row.get_value(0).map_err(db_err)?).unwrap_or(Dinero::CERO),
                    v_string(row.get_value(1).map_err(db_err)?).unwrap_or_default(),
                )),
                None => None,
            }
        };

        let affected = db
            .execute(
                "DELETE FROM Cuentas_Gastos WHERE ID_Gasto = ?1;",
                vec![Value::Text(id_gasto.to_string())],
            )
            .await
            .map_err(db_err)?;

        if affected > 0 {
            let (importe, concepto) = importe.unwrap_or((Dinero::CERO, String::new()));
            caja_movimientos::registrar(
                &db,
                MovimientoCaja {
                    tipo: caja_movimientos::TIPO_GASTO_ANULADO,
                    id_gasto: Some(id_gasto.to_string()),
                    id_usuario: id_usuario.map(|s| s.to_string()),
                    importe,
                    motivo: Some(concepto),
                    ..Default::default()
                },
            )
            .await?;
        }
        Ok(affected > 0)
    }

    /// Actualiza un pago permitiendo cambiar sólo **método y fecha**. El `Importe_Total` **no**
    /// se toma del input: se **recalcula** desde la suma de los `Pago_Detalles` realmente cobrados
    /// (CUENTA-02), manteniendo la conciliación caja↔ventas. Así no se puede descuadrar la caja
    /// fijando un importe arbitrario.
    async fn actualizar_pago(&self, id_pago: &str, p: PagoData) -> AppResult<bool> {
        let db = self.db.write().await;
        let affected = db
            .execute(
                r#"
                UPDATE Pagos
                SET Fecha_Hora = ?2,
                    Metodo_Pago = ?3,
                    Importe_Total = (
                        SELECT IFNULL(SUM(CAST(ROUND(COALESCE(dc.Cantidad,1) * COALESCE(dc.Precio_Unitario,0)) AS INTEGER)), 0)
                        FROM Pago_Detalles pd
                        JOIN Detalle_Comanda dc ON dc.ID_Detalle = pd.ID_Detalle
                        WHERE pd.ID_Pago = ?1
                    )
                WHERE ID_Pago = ?1;
                "#,
                vec![
                    Value::Text(id_pago.to_string()),
                    Value::Text(p.fecha_hora),
                    Value::Text(p.metodo),
                ],
            )
            .await
            .map_err(db_err)?;
        Ok(affected > 0)
    }

    /// Deja anotada una apertura del cajón hecha a mano (dar cambio, cuadrar caja).
    ///
    /// Una apertura sin una venta detrás es exactamente el movimiento por el que alguien pregunta
    /// cuando al cerrar falta dinero; si no queda anotada, no hay nada que investigar. Va por
    /// `execute` y no por `raw` a propósito: es de las cosas que hay que poder mirar desde fuera
    /// del local.
    async fn registrar_apertura_cajon(&self, id_usuario: Option<String>) -> AppResult<()> {
        let w = self.db.write().await;
        w.execute(
            "INSERT INTO Aperturas_Cajon (ID_Apertura, ID_Usuario, Fecha)
             VALUES (?1, ?2, datetime('now','localtime'));",
            vec![
                Value::Text(new_id()),
                id_usuario
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .map(Value::Text)
                    .unwrap_or(Value::Null),
            ],
        )
        .await
        .map_err(db_err)?;
        Ok(())
    }

    /// El estado del cobro (`ACTIVO` / `ANULADO`), o `None` si no existe. Lo pide el caso de uso
    /// antes de decidir: la regla vive en el dominio, no aquí.
    async fn estado_pago(&self, id_pago: &str) -> AppResult<Option<String>> {
        let db = self.db.read().await;
        let mut rows = db
            .query(
                "SELECT COALESCE(Estado, 'ACTIVO') FROM Pagos WHERE ID_Pago = ?1 LIMIT 1;",
                vec![Value::Text(id_pago.to_string())],
            )
            .await
            .map_err(db_err)?;
        Ok(match rows.next().await.map_err(db_err)? {
            Some(row) => v_string(row.get_value(0).map_err(db_err)?),
            None => None,
        })
    }

    /// Anula un cobro **sin borrarlo** (CUENTA-07), revirtiendo de forma atómica todo lo que el
    /// cobro provocó: devuelve el stock consumido (por lote y suelto), resta el gasto del cliente
    /// y devuelve sus líneas a «pendientes de cobro», reabriendo la comanda si procede.
    ///
    /// **Lo que cambió respecto al borrado anterior, y por qué importa:**
    ///
    /// - La fila de `Pagos` se marca, no se borra. Borrarla bajaba el `esperado` del arqueo
    ///   exactamente lo mismo que faltaba en el cajón, así que la sisa más común de un bar salía
    ///   con descuadre cero. No era un fallo de cálculo: era que no quedaba nada con lo que
    ///   comparar.
    /// - `Detalle_Comanda` y `Pago_Detalles` se **conservan**. Son lo que permite reimprimir el
    ///   ticket anulado tal y como se emitió, y lo que devuelve las consumiciones a la mesa en vez
    ///   de esfumarlas. Que una línea esté cobrada pasa a leerse por la vista
    ///   `v_lineas_cobradas`, que sólo mira los pagos activos.
    /// - Las trazas de consumo (`Lote_Consumos`, `Suelto_Consumos`) tampoco se borran: sin ellas,
    ///   el ticket anulado perdería su trazabilidad por lote.
    ///
    /// ⚠️ **El anti-doble-abono.** Antes lo garantizaba el borrado de esas trazas: sin filas que
    /// sumar, una segunda anulación no abonaba nada. Ahora las filas siguen ahí, así que **el
    /// guardia es el `Estado`**: si el pago ya está `ANULADO` se sale antes de tocar el stock. El
    /// caso de uso lo comprueba también, pero la comprobación que cuenta es ésta, porque está
    /// DENTRO de la transacción.
    async fn anular_pago(&self, args: AnularPagoArgs) -> AppResult<bool> {
        let AnularPagoArgs {
            id_pago,
            id_usuario,
            motivo,
            clase,
        } = args;
        let g = self.db.write().await;
        let conn = &g;
        conn.execute_batch("BEGIN; PRAGMA defer_foreign_keys = ON;")
            .await
            .map_err(db_err)?;
        let res: AppResult<bool> = async {
            // 1) Comanda, importe y ESTADO del pago, antes de tocar nada.
            let (id_comanda, importe, estado, metodo) = {
                let mut rows = conn
                    .query(
                        r#"
                        SELECT ID_Comanda,
                               IFNULL(Importe_Total,0),
                               COALESCE(Estado,'ACTIVO'),
                               COALESCE(Metodo_Pago,'')
                        FROM Pagos WHERE ID_Pago = ?1 LIMIT 1;
                        "#,
                        vec![Value::Text(id_pago.clone())],
                    )
                    .await
                    .map_err(db_err)?;
                match rows.next().await.map_err(db_err)? {
                    Some(row) => (
                        v_string(row.get_value(0).map_err(db_err)?).unwrap_or_default(),
                        v_dinero(row.get_value(1).map_err(db_err)?).unwrap_or(Dinero::CERO),
                        v_string(row.get_value(2).map_err(db_err)?).unwrap_or_default(),
                        v_string(row.get_value(3).map_err(db_err)?).unwrap_or_default(),
                    ),
                    // El pago no existe: nada que revertir.
                    None => return Ok(false),
                }
            };

            // El guardia. Ver la nota de arriba: sin esto, cada pulsación del botón abonaría el
            // stock y descontaría el gasto del cliente otra vez.
            if estado.eq_ignore_ascii_case(ESTADO_ANULADO) {
                return Ok(false);
            }

            // FISCAL-01. A partir de aquí hay dos caminos y la diferencia no es cosmética:
            //
            //   · ERROR      → la venta NO EXISTIÓ. Las líneas vuelven a la comanda y se emite un
            //                  RF DE ANULACIÓN.
            //   · DEVOLUCION → la venta SÍ EXISTIÓ y se devuelve el dinero. Las líneas NO vuelven:
            //                  si volvieran, quedarían pendientes de cobro y el camarero las
            //                  cobraría otra vez. Se emite una FACTURA RECTIFICATIVA (R5).
            //
            // Lo que hacen igual las dos es dejar de contar como venta, y por eso comparten
            // `Estado = 'ANULADO'`: al cajón le da igual por qué salió el dinero. Y las dos reponen
            // el stock: lo devuelto vuelve al almacén, y lo que ya no se pueda vender se ajusta desde el
            // inventario, como cualquier merma.
            //
            // 2) Devolver el stock de lotes que consumió ESTE cobro. Se busca por el cobro del
            //    consumo y no por sus líneas (STOCK-01): una línea anulada y vuelta a cobrar tiene un
            //    consumo por cobro, y por la línea se devolvía también el del cobro anulado antes,
            //    que ya había vuelto. La traza se CONSERVA: el doble abono lo impide el `Estado`.
            //    Redondeado a milésimas como todo movimiento de stock (RI-26).
            conn.execute(
                r#"
                UPDATE Lotes_Producto
                SET Stock_Disponible = ROUND(COALESCE(Stock_Disponible,0) + (
                    SELECT IFNULL(SUM(lc.Cantidad),0)
                    FROM Lote_Consumos lc
                    WHERE lc.ID_Pago = ?1 AND lc.ID_Lote = Lotes_Producto.ID_Lote
                ), 3)
                WHERE ID_Lote IN (
                    SELECT lc.ID_Lote
                    FROM Lote_Consumos lc
                    WHERE lc.ID_Pago = ?1
                );
                "#,
                vec![Value::Text(id_pago.clone())],
            )
            .await
            .map_err(db_err)?;

            // 2-bis) Y el stock SUELTO (lo que los lotes no cubrieron, VR-04). Mismo trato.
            conn.execute(
                r#"
                UPDATE Productos
                SET Stock_Suelto = ROUND(COALESCE(Stock_Suelto,0) + (
                    SELECT IFNULL(SUM(sc.Cantidad),0)
                    FROM Suelto_Consumos sc
                    WHERE sc.ID_Pago = ?1 AND sc.ID_Producto = Productos.ID_Producto
                ), 3)
                WHERE ID_Producto IN (
                    SELECT sc.ID_Producto
                    FROM Suelto_Consumos sc
                    WHERE sc.ID_Pago = ?1
                );
                "#,
                vec![Value::Text(id_pago.clone())],
            )
            .await
            .map_err(db_err)?;

            // 3) Restar el gasto del cliente ligado a la comanda, sin bajar de 0. RI-61: el de la
            //    comanda, que se fija al cobrar, y si no lo tiene el de su reserva: así una reserva
            //    borrada o reasignada después del cobro no impide restarlo.
            //
            //    Esto SÍ se hace en los dos casos: el cliente ya no ha gastado ese dinero, haya
            //    sido porque la venta no existía o porque se le ha devuelto.
            if importe > Dinero::CERO && !id_comanda.is_empty() {
                conn.execute(
                    r#"
                    UPDATE Clientes
                    SET Total_Gastado = MAX(0, COALESCE(Total_Gastado,0) - ?2)
                    WHERE ID_Cliente = (
                        SELECT COALESCE(c.ID_Cliente, r.ID_Cliente)
                        FROM Comandas c
                        LEFT JOIN Reservas r ON r.ID_Reserva = c.ID_Reserva
                        WHERE c.ID_Comanda = ?1
                    );
                    "#,
                    vec![Value::Text(id_comanda.clone()), dinero_val(importe)],
                )
                .await
                .map_err(db_err)?;
            }

            // 4) Marcar el pago. `Anulado_En`/`Anulado_Por` son obligatorios por el CHECK de la
            //    tabla: un cobro anulado sin firma no sirve como auditoría. El `Estado <> ...` del
            //    WHERE deja el UPDATE idempotente.
            let affected = conn
                .execute(
                    r#"
                    UPDATE Pagos
                    SET Estado = 'ANULADO',
                        Anulado_En = datetime('now','localtime'),
                        Anulado_Por = ?2,
                        Motivo_Anulacion = ?3,
                        Motivo_Baja = ?4
                    WHERE ID_Pago = ?1 AND COALESCE(Estado,'ACTIVO') <> 'ANULADO';
                    "#,
                    vec![
                        Value::Text(id_pago.clone()),
                        Value::Text(id_usuario.clone()),
                        Value::Text(motivo.clone()),
                        Value::Text(clase.wire().to_string()),
                    ],
                )
                .await
                .map_err(db_err)?;

            // 5) El movimiento en el historial de caja, con el tipo que corresponde. Son dos
            //    hechos distintos y el historial existe justo para poder distinguirlos después:
            //    una devolución es dinero que sale del cajón por una venta real.
            caja_movimientos::registrar(
                conn,
                MovimientoCaja {
                    tipo: match clase {
                        ClaseBaja::Error => caja_movimientos::TIPO_ANULACION,
                        ClaseBaja::Devolucion => caja_movimientos::TIPO_DEVOLUCION,
                    },
                    id_pago: Some(id_pago.clone()),
                    id_usuario: Some(id_usuario.clone()),
                    importe,
                    metodo_pago: Some(metodo),
                    motivo: Some(motivo.clone()),
                    ..Default::default()
                },
            )
            .await?;

            // 6) Recalcular la comanda. Sus líneas vuelven a estar pendientes —el pago que las
            //    cubría ya no está activo—, así que se reabre si no hay otra comanda abierta para
            //    la misma mesa. `Total_Comanda` no cambia: las líneas siguen ahí.
            //
            //    Sólo en una anulación POR ERROR. En una devolución la mesa está cerrada y la
            //    consumición se la llevó el cliente: reabrirla pondría las líneas otra vez a cobrar.
            if clase.devuelve_las_lineas() && !id_comanda.is_empty() {
                conn.execute(
                    r#"
                    UPDATE Comandas
                    SET Estado = CASE
                          WHEN ID_Comanda = ?1
                           AND EXISTS (
                            SELECT 1 FROM Detalle_Comanda dc
                            WHERE dc.ID_Comanda = Comandas.ID_Comanda
                              AND NOT EXISTS (SELECT 1 FROM v_lineas_cobradas pd WHERE pd.ID_Detalle = dc.ID_Detalle)
                          )
                           AND NOT EXISTS (
                            SELECT 1 FROM Comandas abierta
                            WHERE abierta.ID_Mesa = Comandas.ID_Mesa
                              AND abierta.Estado = 'Abierta'
                              AND abierta.ID_Comanda <> Comandas.ID_Comanda
                          )
                          THEN 'Abierta' ELSE Estado END,
                        Fecha_Hora_Cierre = CASE
                          WHEN ID_Comanda = ?1
                           AND EXISTS (
                            SELECT 1 FROM Detalle_Comanda dc
                            WHERE dc.ID_Comanda = Comandas.ID_Comanda
                              AND NOT EXISTS (SELECT 1 FROM v_lineas_cobradas pd WHERE pd.ID_Detalle = dc.ID_Detalle)
                          )
                           AND NOT EXISTS (
                            SELECT 1 FROM Comandas abierta
                            WHERE abierta.ID_Mesa = Comandas.ID_Mesa
                              AND abierta.Estado = 'Abierta'
                              AND abierta.ID_Comanda <> Comandas.ID_Comanda
                          )
                          THEN NULL ELSE Fecha_Hora_Cierre END,
                        Total_Comanda = (
                            SELECT IFNULL(SUM(CAST(ROUND(COALESCE(Cantidad,1) * COALESCE(Precio_Unitario,0)) AS INTEGER)), 0)
                            FROM Detalle_Comanda
                            WHERE ID_Comanda = Comandas.ID_Comanda
                        )
                    WHERE ID_Comanda = ?1;
                    "#,
                    vec![Value::Text(id_comanda.clone())],
                )
                .await
                .map_err(db_err)?;
            }

            // 7) FISCAL-01: el registro de facturación, DENTRO de esta misma transacción.
            //
            //    Si `affected` es 0 el pago ya estaba anulado y no se emite nada: el registro
            //    correspondiente se emitió la primera vez, y emitir otro gastaría un número y
            //    mandaría a la AEAT un hecho que no ha ocurrido.
            if affected > 0 {
                crate::verifactu::emitir_baja_de_pago(conn, &id_pago, clase).await?;
            }

            Ok(affected > 0)
        }
        .await;
        match res {
            Ok(v) => {
                conn.execute_batch("COMMIT;").await.map_err(db_err)?;
                Ok(v)
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK;").await;
                Err(e)
            }
        }
    }
}

#[cfg(test)]
mod tests_comunes {
    //! Andamiaje compartido por los tests de este fichero: una BD de verdad en un directorio
    //! temporal, con el esquema real aplicado por las migraciones.

    use super::*;
    use crate::db::Db;
    use libsql::Connection;

    pub async fn db_temporal() -> (Arc<Db>, std::path::PathBuf) {
        let dir = crate::test_temp::dir_temporal("cuentas");
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        (db, dir)
    }

    pub async fn sembrar(db: &Arc<Db>, sentencias: &[&str]) {
        let w = db.write().await;
        let conn: &Connection = w.raw();
        for sql in sentencias {
            conn.execute(sql, Vec::<Value>::new())
                .await
                .unwrap_or_else(|e| panic!("sembrando: {sql}
{e}"));
        }
    }

    pub async fn escalar(db: &Arc<Db>, sql: &str) -> f64 {
        let r = db.read().await;
        let mut rows = r.query(sql, Vec::<Value>::new()).await.unwrap();
        let row = rows.next().await.unwrap().expect("sin filas");
        crate::mapping::v_f64(row.get_value(0).unwrap()).unwrap_or(0.0)
    }
}

#[cfg(test)]
mod tests_anulacion {
    //! Anular un cobro (CUENTA-07).
    //!
    //! El agujero que estos tests vigilan: mientras anular hacía `DELETE` de la fila de `Pagos`, el
    //! arqueo —que calcula `esperado = fondo + cobros en efectivo`— bajaba el esperado exactamente
    //! lo mismo que faltaba en el cajón. El descuadre salía **cero**. No era un fallo de cálculo:
    //! era que no quedaba nada con lo que comparar.

    use super::tests_comunes::*;
    use super::*;
    use tpv_application::ports::cuentas::{AnularPagoArgs, CuentasRepository};
    use tpv_application::ports::mesas::MesasRepository;

    /// Euros -> `Dinero`. Los supuestos se escriben en euros; lo que se compara son centimos.
    #[allow(dead_code)]
    fn eur(euros: f64) -> Dinero {
        Dinero::de_euros(euros)
    }

    /// Una venta de mesa con dos líneas: una cobrada (con consumo de lote y de suelto) y otra que
    /// se quedó pendiente. Es el estado desde el que se anula, y el que permite comprobar de una
    /// vez el stock, el gasto del cliente y la reapertura de la comanda.
    const VENTA_DE_MESA: &[&str] = &[
        // FISCAL-01: sin NIF ni razón social no se puede emitir el registro de facturación, y sin
        // registro no se puede cobrar (art. 9 RRSIF). Es la única puerta que Veri*factu añade al
        // camino de la venta, así que los tests que cobran tienen que pasarla como la pasa un bar.
        "UPDATE Business_Settings SET CIF = 'B12345674', Razon_Social = 'Bar de Pruebas SL'
           WHERE ID = 1;",
        // El rol Administrador lo siembran ya las migraciones; aquí sólo hace falta el usuario que
        // firma la anulación (`Anulado_Por` es una FK y el CHECK lo exige).
        "INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre)
           VALUES ('u1', '00000000-0000-7000-8000-000000000001', 'jefe@bar.example', 'x', 'Marta');",
        "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('zona', 'Salon');",
        "INSERT INTO Mesas (ID_Mesa, ID_Zona, Numero_Mesa, Capacidad, Ubicacion_X, Ubicacion_Y, Shape, Width, Height)
           VALUES ('mesa', 'zona', '4', 4, 0, 0, 'rect', 10, 10);",
        "INSERT INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('cat', 'Bebidas');",
        "INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta, Stock_Suelto)
           VALUES ('prod', 'cat', 'Cerveza', 300, 7);",
        "INSERT INTO Lotes_Producto (ID_Lote, ID_Producto, Codigo_Lote, Stock_Disponible, Fecha_Entrada)
           VALUES ('lote', 'prod', 'L-1', 18, '2026-01-01 10:00:00');",
        "INSERT INTO Clientes (ID_Cliente, Nombre, Total_Gastado) VALUES ('cli', 'Ana', 5000);",
        "INSERT INTO Reservas (ID_Reserva, ID_Cliente, ID_Mesa, Dia_YMD, Hora, Turno, Comensales)
           VALUES ('res', 'cli', 'mesa', '2026-01-02', '13:00', 'COMIDA', 2);",
        "INSERT INTO Comandas (ID_Comanda, Canal, ID_Mesa, ID_Reserva, Fecha_Hora_Apertura, Fecha_Hora_Cierre, Estado, Total_Comanda)
           VALUES ('com', 'MESA', 'mesa', 'res', '2026-01-02 12:00:00', '2026-01-02 13:00:00', 'Pagada', 1200);",
        "INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Cantidad, Precio_Unitario)
           VALUES ('det-lote', 'com', 'prod', 2, 300);",
        "INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Cantidad, Precio_Unitario)
           VALUES ('det-suelto', 'com', 'prod', 1, 300);",
        "INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Cantidad, Precio_Unitario)
           VALUES ('det-pendiente', 'com', 'prod', 1, 300);",
        "INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo)
           VALUES ('pago', 'com', '2026-01-02 13:00:00', 'Efectivo', 900, 'PARCIAL');",
        "INSERT INTO Pago_Detalles (ID_Pago, ID_Detalle) VALUES ('pago', 'det-lote');",
        "INSERT INTO Pago_Detalles (ID_Pago, ID_Detalle) VALUES ('pago', 'det-suelto');",
        "INSERT INTO Lote_Consumos (ID_Detalle, ID_Lote, ID_Pago, Cantidad) VALUES ('det-lote', 'lote', 'pago', 2);",
        "INSERT INTO Suelto_Consumos (ID_Detalle, ID_Producto, ID_Pago, Cantidad) VALUES ('det-suelto', 'prod', 'pago', 1);",
    ];

    fn repo(db: &Arc<Db>) -> SqliteCuentasRepository {
        SqliteCuentasRepository::new(db.clone())
    }

    fn args(id_pago: &str) -> AnularPagoArgs {
        AnularPagoArgs {
            id_pago: id_pago.to_string(),
            id_usuario: "u1".to_string(),
            motivo: "cobro duplicado".to_string(),
            // FISCAL-01: anulación POR ERROR, que es lo que hacía el botón único
            // antes de partirlo. El test sigue describiendo el mismo comportamiento.
            clase: ClaseBaja::Error,
        }
    }

    async fn texto(db: &Arc<Db>, sql: &str) -> Option<String> {
        let r = db.read().await;
        let mut rows = r.query(sql, Vec::<Value>::new()).await.unwrap();
        let row = rows.next().await.unwrap()?;
        crate::mapping::v_string(row.get_value(0).unwrap())
    }

    /* ── STOCK-01 ─────────────────────────────────────────────────────────────────────────── */

    /// Una línea cobrada, anulada y vuelta a cobrar de OTRO lote —porque el primero se agotó entre
    /// medias— tiene un consumo por cobro. Anular el segundo cobro devuelve sólo lo suyo: lo del
    /// primero ya volvió a su lote cuando se anuló aquél, y devolverlo otra vez inventaría stock.
    #[tokio::test]
    async fn anular_devuelve_solo_lo_que_consumio_ese_cobro() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_DE_MESA).await;
        sembrar(
            &db,
            &[
                "INSERT INTO Lotes_Producto (ID_Lote, ID_Producto, Codigo_Lote, Stock_Disponible, Fecha_Entrada)
                   VALUES ('lote-viejo', 'prod', 'L-0', 5, '2026-01-01 10:00:00');",
                "INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo,
                                    Estado, Anulado_En, Anulado_Por, Motivo_Anulacion, Motivo_Baja)
                   VALUES ('pago-viejo', 'com', '2026-01-02 12:30:00', 'Efectivo', 600, 'PARCIAL',
                           'ANULADO', '2026-01-02 12:40:00', 'u1', 'mesa equivocada', 'ERROR');",
                "INSERT INTO Pago_Detalles (ID_Pago, ID_Detalle) VALUES ('pago-viejo', 'det-lote');",
                "INSERT INTO Lote_Consumos (ID_Detalle, ID_Lote, ID_Pago, Cantidad)
                   VALUES ('det-lote', 'lote-viejo', 'pago-viejo', 2);",
            ],
        )
        .await;

        assert!(repo(&db).anular_pago(args("pago")).await.unwrap());

        assert_eq!(
            escalar(&db, "SELECT Stock_Disponible FROM Lotes_Producto WHERE ID_Lote='lote';").await,
            20.0,
            "lo que consumió este cobro vuelve a su lote"
        );
        assert_eq!(
            escalar(&db, "SELECT Stock_Disponible FROM Lotes_Producto WHERE ID_Lote='lote-viejo';")
                .await,
            5.0,
            "lo del cobro que se anuló antes ya había vuelto: no se devuelve dos veces"
        );
    }


    /* ── Lo que ya no se destruye ─────────────────────────────────────────────────────── */

    #[tokio::test]
    async fn anular_no_borra_el_cobro_lo_marca() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_DE_MESA).await;

        assert!(repo(&db).anular_pago(args("pago")).await.unwrap());

        assert_eq!(
            escalar(&db, "SELECT COUNT(*) FROM Pagos WHERE ID_Pago='pago';").await,
            1.0,
            "la fila del cobro tiene que seguir ahí: es la prueba de la venta"
        );
        assert_eq!(
            texto(&db, "SELECT Estado FROM Pagos WHERE ID_Pago='pago';").await,
            Some("ANULADO".into())
        );
        assert_eq!(
            texto(&db, "SELECT Anulado_Por FROM Pagos WHERE ID_Pago='pago';").await,
            Some("u1".into()),
            "quién anula sale de la sesión, y sin él el CHECK de la tabla no deja guardar"
        );
        assert_eq!(
            texto(&db, "SELECT Motivo_Anulacion FROM Pagos WHERE ID_Pago='pago';").await,
            Some("cobro duplicado".into())
        );
        assert!(
            texto(&db, "SELECT Anulado_En FROM Pagos WHERE ID_Pago='pago';")
                .await
                .is_some()
        );
    }

    #[tokio::test]
    async fn las_lineas_del_cobro_anulado_se_conservan() {
        // Son lo que permite reimprimir el ticket anulado tal y como se emitió. Sin ellas, la
        // auditoría queda coja justo en lo que más importa: qué se cobró.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_DE_MESA).await;

        repo(&db).anular_pago(args("pago")).await.unwrap();

        assert_eq!(
            escalar(&db, "SELECT COUNT(*) FROM Detalle_Comanda WHERE ID_Comanda='com';").await,
            3.0
        );
        assert_eq!(
            escalar(&db, "SELECT COUNT(*) FROM Pago_Detalles WHERE ID_Pago='pago';").await,
            2.0
        );
    }

    /* ── El stock: exactamente una vez ────────────────────────────────────────────────── */

    #[tokio::test]
    async fn anular_devuelve_el_stock_de_lote_y_el_suelto() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_DE_MESA).await;

        repo(&db).anular_pago(args("pago")).await.unwrap();

        assert_eq!(
            escalar(&db, "SELECT Stock_Disponible FROM Lotes_Producto WHERE ID_Lote='lote';").await,
            20.0
        );
        assert_eq!(
            escalar(&db, "SELECT Stock_Suelto FROM Productos WHERE ID_Producto='prod';").await,
            8.0
        );
    }

    #[tokio::test]
    async fn una_devolucion_total_tambien_repone_el_stock_de_lote_y_el_suelto() {
        // Lo devuelto vuelve al almacén igual que lo de un cobro que no debió existir: lo que no
        // cambia entre las dos clases es el stock, sino las líneas de la comanda.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_DE_MESA).await;

        repo(&db)
            .anular_pago(AnularPagoArgs { clase: ClaseBaja::Devolucion, ..args("pago") })
            .await
            .unwrap();

        assert_eq!(
            escalar(&db, "SELECT Stock_Disponible FROM Lotes_Producto WHERE ID_Lote='lote';").await,
            20.0
        );
        assert_eq!(
            escalar(&db, "SELECT Stock_Suelto FROM Productos WHERE ID_Producto='prod';").await,
            8.0
        );
    }

    #[tokio::test]
    async fn devolver_dos_veces_no_repone_el_stock_dos_veces() {
        // El guardia por `Estado` vale igual para una devolución: la segunda no hace nada.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_DE_MESA).await;
        let devolucion = || AnularPagoArgs { clase: ClaseBaja::Devolucion, ..args("pago") };

        assert!(repo(&db).anular_pago(devolucion()).await.unwrap());
        assert!(!repo(&db).anular_pago(devolucion()).await.unwrap());
        assert!(
            !repo(&db).anular_pago(args("pago")).await.unwrap(),
            "ni una anulación por error después"
        );

        assert_eq!(
            escalar(&db, "SELECT Stock_Disponible FROM Lotes_Producto WHERE ID_Lote='lote';").await,
            20.0
        );
        assert_eq!(
            escalar(&db, "SELECT Stock_Suelto FROM Productos WHERE ID_Producto='prod';").await,
            8.0
        );
    }

    #[tokio::test]
    async fn anular_dos_veces_no_abona_el_stock_dos_veces() {
        // ⚠️ El test que justifica el guardia por `Estado`. Antes, lo que impedía el doble abono
        // era que las trazas de consumo se borraban al anular. Ahora se conservan —dan
        // trazabilidad por lote al ticket anulado—, así que si el guardia se cayera, cada
        // pulsación del botón inventaría stock y le quitaría dinero al cliente.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_DE_MESA).await;

        assert!(repo(&db).anular_pago(args("pago")).await.unwrap());
        assert!(
            !repo(&db).anular_pago(args("pago")).await.unwrap(),
            "la segunda no hace nada, y lo dice"
        );

        assert_eq!(
            escalar(&db, "SELECT Stock_Disponible FROM Lotes_Producto WHERE ID_Lote='lote';").await,
            20.0,
            "el lote se abonó una sola vez"
        );
        assert_eq!(
            escalar(&db, "SELECT Stock_Suelto FROM Productos WHERE ID_Producto='prod';").await,
            8.0
        );
        assert_eq!(
            escalar(&db, "SELECT Total_Gastado FROM Clientes WHERE ID_Cliente='cli';").await,
            4100.0,
            "y el gasto del cliente también"
        );
        assert_eq!(
            escalar(&db, "SELECT COUNT(*) FROM Movimientos_Caja WHERE Tipo='ANULACION';").await,
            1.0,
            "una anulación que no ocurre no se anota"
        );
    }

    #[tokio::test]
    async fn anular_un_pago_que_no_existe_no_es_un_error() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_DE_MESA).await;

        assert!(!repo(&db).anular_pago(args("fantasma")).await.unwrap());
    }

    /* ── El gasto del cliente ─────────────────────────────────────────────────────────── */

    #[tokio::test]
    async fn el_gasto_del_cliente_baja_una_vez_y_nunca_por_debajo_de_cero() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_DE_MESA).await;
        sembrar(&db, &["UPDATE Clientes SET Total_Gastado = 4 WHERE ID_Cliente='cli';"]).await;

        repo(&db).anular_pago(args("pago")).await.unwrap();

        assert_eq!(
            escalar(&db, "SELECT Total_Gastado FROM Clientes WHERE ID_Cliente='cli';").await,
            0.0,
            "un total negativo diría que el cliente tiene saldo a favor, que no existe"
        );
    }

    /* ── Opción A: las líneas vuelven a estar pendientes ──────────────────────────────── */

    #[tokio::test]
    async fn las_lineas_del_cobro_anulado_vuelven_a_contar_como_pendientes() {
        // La vista `v_lineas_cobradas` es la que define «cobrada»: fila en `Pago_Detalles` ligada
        // a un pago ACTIVO. Sin ella, media aplicación seguiría viéndolas cobradas.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_DE_MESA).await;

        repo(&db).anular_pago(args("pago")).await.unwrap();

        assert_eq!(
            escalar(
                &db,
                "SELECT COUNT(*) FROM Detalle_Comanda dc
                 WHERE dc.ID_Comanda='com'
                   AND NOT EXISTS (SELECT 1 FROM v_lineas_cobradas pd WHERE pd.ID_Detalle = dc.ID_Detalle);"
            )
            .await,
            3.0,
            "las dos que cubría el pago anulado, más la que ya estaba pendiente"
        );
    }

    #[tokio::test]
    async fn la_comanda_se_reabre_si_le_quedan_lineas_pendientes() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_DE_MESA).await;

        repo(&db).anular_pago(args("pago")).await.unwrap();

        assert_eq!(
            texto(&db, "SELECT Estado FROM Comandas WHERE ID_Comanda='com';").await,
            Some("Abierta".into())
        );
        assert_eq!(
            texto(&db, "SELECT Fecha_Hora_Cierre FROM Comandas WHERE ID_Comanda='com';").await,
            None
        );
        assert_eq!(
            escalar(&db, "SELECT Total_Comanda FROM Comandas WHERE ID_Comanda='com';").await,
            1200.0,
            "el total no cambia: las líneas siguen en la comanda"
        );
    }

    #[tokio::test]
    async fn no_se_reabre_si_la_mesa_ya_tiene_otra_comanda_abierta() {
        // Dos comandas abiertas para la misma mesa violarían el índice único y dejarían la sala
        // enseñando dos tickets vivos donde hay uno.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_DE_MESA).await;
        sembrar(
            &db,
            &["INSERT INTO Comandas (ID_Comanda, Canal, ID_Mesa, Fecha_Hora_Apertura, Estado)
               VALUES ('com2', 'MESA', 'mesa', '2026-01-02 14:00:00', 'Abierta');"],
        )
        .await;

        repo(&db).anular_pago(args("pago")).await.unwrap();

        assert_eq!(
            texto(&db, "SELECT Estado FROM Comandas WHERE ID_Comanda='com';").await,
            Some("Pagada".into())
        );
    }

    /* ── El historial de caja ─────────────────────────────────────────────────────────── */

    #[tokio::test]
    async fn la_anulacion_deja_su_fila_en_el_historial_de_caja() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_DE_MESA).await;

        repo(&db).anular_pago(args("pago")).await.unwrap();

        assert_eq!(
            texto(&db, "SELECT Tipo FROM Movimientos_Caja;").await,
            Some("ANULACION".into())
        );
        assert_eq!(
            texto(&db, "SELECT ID_Pago FROM Movimientos_Caja;").await,
            Some("pago".into())
        );
        assert_eq!(
            texto(&db, "SELECT ID_Usuario FROM Movimientos_Caja;").await,
            Some("u1".into())
        );
        assert_eq!(
            texto(&db, "SELECT Motivo FROM Movimientos_Caja;").await,
            Some("cobro duplicado".into())
        );
        assert_eq!(
            escalar(&db, "SELECT Importe FROM Movimientos_Caja;").await,
            900.0,
            "el importe va en positivo; el signo lo da el Tipo"
        );
        assert!(
            texto(&db, "SELECT ID_Movimiento FROM Movimientos_Caja;")
                .await
                .is_some_and(|s| !s.is_empty()),
            "el UUID se genera antes del INSERT, nunca dentro de la sentencia"
        );
    }

    #[tokio::test]
    async fn el_historial_recoge_una_fila_por_cobro_y_otra_por_anulacion() {
        // El par completo. Sin la fila del cobro, el historial sólo tendría cosas deshechas y no
        // habría contra qué leerlas.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_DE_MESA).await;

        // El cobro se anota por su camino real (`cobrar_detalles`), no a mano: lo que se vigila
        // aquí es que ese camino lo haga, no que la tabla admita filas.
        crate::mesas::SqliteMesasRepository::new(db.clone())
            .cobrar_detalles(tpv_domain::mesas::CobroDetalles {
                id_comanda: "com".into(),
                detalle_ids: vec!["det-pendiente".into()],
                metodo: "Efectivo".into(),
                tipo: "PARCIAL".into(),
                id_usuario: Some("u1".into()),
                // FISCAL-02: una venta normal es un ticket (F2), sin datos de cliente.
                destinatario: None,
            })
            .await
            .unwrap();

        repo(&db).anular_pago(args("pago")).await.unwrap();

        assert_eq!(
            escalar(&db, "SELECT COUNT(*) FROM Movimientos_Caja WHERE Tipo='COBRO';").await,
            1.0
        );
        assert_eq!(
            escalar(&db, "SELECT COUNT(*) FROM Movimientos_Caja WHERE Tipo='ANULACION';").await,
            1.0
        );
        assert_eq!(
            escalar(
                &db,
                "SELECT COUNT(*) FROM Movimientos_Caja mc JOIN Pagos p ON p.ID_Pago = mc.ID_Pago;"
            )
            .await,
            2.0,
            "cada movimiento tiene que apuntar a su cobro"
        );
    }

    #[tokio::test]
    async fn guardar_dos_veces_el_mismo_apunte_no_duplica_su_movimiento() {
        // `crear_gasto` es un upsert por `ID_Gasto`, para que un reintento no duplique el gasto.
        // El movimiento sigue la misma regla: si no, el historial contaría dos salidas de dinero
        // donde hubo una — y con dos `ID_Movimiento` distintos, así que ninguna clave las
        // frenaría. La misma guardia protege al cobro, cuyo INSERT también es un upsert.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_DE_MESA).await;
        let r = repo(&db);

        for importe in [eur(12.5), eur(13.0)] {
            r.crear_gasto(
                Some("g1".into()),
                GastoData { pagado_con_caja: false,
                    fecha: "2026-01-02".into(),
                    tipo_gasto: "Otro".into(),
                    concepto: "Hielo".into(),
                    importe,
                    proveedor_id: None,
                },
                Some("u1"),
            )
            .await
            .unwrap();
        }

        assert_eq!(
            escalar(&db, "SELECT COUNT(*) FROM Movimientos_Caja WHERE ID_Gasto='g1';").await,
            1.0
        );
    }

    #[tokio::test]
    async fn un_gasto_y_su_borrado_tambien_dejan_rastro() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_DE_MESA).await;
        let r = repo(&db);

        r.crear_gasto(
            Some("g1".into()),
            GastoData { pagado_con_caja: false,
                fecha: "2026-01-02".into(),
                tipo_gasto: "Otro".into(),
                concepto: "Hielo".into(),
                importe: eur(12.5),
                proveedor_id: None,
            },
            Some("u1"),
        )
        .await
        .unwrap();
        r.eliminar_gasto("g1", Some("u1")).await.unwrap();

        assert_eq!(
            escalar(
                &db,
                "SELECT COUNT(*) FROM Movimientos_Caja WHERE Tipo='GASTO' AND ID_Gasto='g1';"
            )
            .await,
            1.0
        );
        assert_eq!(
            escalar(
                &db,
                "SELECT Importe FROM Movimientos_Caja WHERE Tipo='GASTO_ANULADO' AND ID_Gasto='g1';"
            )
            .await,
            1250.0,
            "el importe se lee ANTES de borrar la fila: después ya no hay de dónde sacarlo"
        );
    }

    /* ── La replicación ───────────────────────────────────────────────────────────────── */

    #[tokio::test]
    async fn el_outbox_captura_la_anulacion_entera() {
        // Si esto falla, la nube y la Main divergen —el cobro sigue vivo arriba y anulado abajo—
        // y no se nota hasta que alguien mira.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_DE_MESA).await;

        repo(&db).anular_pago(args("pago")).await.unwrap();

        for aguja in [
            "UPDATE Pagos",
            "Movimientos_Caja",
            "Lotes_Producto",
            "Productos",
            "Clientes",
            "UPDATE Comandas",
        ] {
            let sql = format!(
                "SELECT COUNT(*) FROM _Sync_Outbox WHERE Statements_Json LIKE '%{aguja}%';"
            );
            assert!(
                escalar(&db, &sql).await >= 1.0,
                "el outbox no ha capturado: {aguja}"
            );
        }
    }
}

#[cfg(test)]
mod tests_lineas_devueltas {
    //! Que las líneas vuelvan a la mesa no sirve de nada si el camarero no puede tocarlas
    //! (CUENTA-07 §6.5.2). Visibles y congeladas sería peor que el comportamiento anterior, en el
    //! que al menos desaparecían.

    use super::tests_comunes::*;
    use super::*;
    use crate::mesas::SqliteMesasRepository;
    use tpv_application::ports::cuentas::{AnularPagoArgs, CuentasRepository};
    use tpv_application::ports::mesas::MesasRepository;

    const VENTA_BARRA: &[&str] = &[
        // El rol Administrador lo siembran ya las migraciones; aquí sólo hace falta el usuario que
        // firma la anulación (`Anulado_Por` es una FK y el CHECK lo exige).
        "INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre)
           VALUES ('u1', '00000000-0000-7000-8000-000000000001', 'jefe@bar.example', 'x', 'Marta');",
        "INSERT INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('cat', 'Bebidas');",
        "INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta)
           VALUES ('prod', 'cat', 'Cafe', 120);",
        "INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura, Estado, Total_Comanda)
           VALUES ('com', 'BARRA', '2026-01-02 12:00:00', 'Pagada', 240);",
        "INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Cantidad, Precio_Unitario)
           VALUES ('d1', 'com', 'prod', 1, 120);",
        "INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Cantidad, Precio_Unitario)
           VALUES ('d2', 'com', 'prod', 1, 120);",
        "INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo)
           VALUES ('pago', 'com', '2026-01-02 12:30:00', 'Efectivo', 240, 'TOTAL');",
        "INSERT INTO Pago_Detalles (ID_Pago, ID_Detalle) VALUES ('pago', 'd1');",
        "INSERT INTO Pago_Detalles (ID_Pago, ID_Detalle) VALUES ('pago', 'd2');",
    ];

    fn anular(db: &Arc<Db>) -> AnularPagoArgs {
        let _ = db;
        AnularPagoArgs {
            id_pago: "pago".into(),
            id_usuario: "u1".into(),
            motivo: "error de cobro".into(),
            // FISCAL-01: anulación POR ERROR, que es lo que hacía el botón único
            // antes de partirlo. El test sigue describiendo el mismo comportamiento.
            clase: ClaseBaja::Error,
        }
    }

    #[tokio::test]
    async fn una_linea_devuelta_se_puede_quitar_por_su_id() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_BARRA).await;
        SqliteCuentasRepository::new(db.clone())
            .anular_pago(anular(&db))
            .await
            .unwrap();

        SqliteMesasRepository::new(db.clone())
            .delete_detalle("d1")
            .await
            .unwrap();

        assert_eq!(
            escalar(&db, "SELECT COUNT(*) FROM Detalle_Comanda WHERE ID_Detalle='d1';").await,
            0.0
        );
    }

    #[tokio::test]
    async fn una_linea_devuelta_se_puede_quitar_por_producto() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_BARRA).await;
        SqliteCuentasRepository::new(db.clone())
            .anular_pago(anular(&db))
            .await
            .unwrap();

        SqliteMesasRepository::new(db.clone())
            .remove_one_pending_detalle("com", "prod")
            .await
            .unwrap();

        assert_eq!(
            escalar(&db, "SELECT COUNT(*) FROM Detalle_Comanda WHERE ID_Comanda='com';").await,
            1.0
        );
    }

    #[tokio::test]
    async fn una_linea_de_un_cobro_activo_sigue_sin_poder_quitarse() {
        // La guardia no se puede aflojar de más: quitar una línea ya cobrada dejaría el ticket sin
        // lo que el cliente pagó y descuadraría la caja contra las ventas.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_BARRA).await;

        SqliteMesasRepository::new(db.clone())
            .delete_detalle("d1")
            .await
            .unwrap();
        SqliteMesasRepository::new(db.clone())
            .remove_one_pending_detalle("com", "prod")
            .await
            .unwrap();

        assert_eq!(
            escalar(&db, "SELECT COUNT(*) FROM Detalle_Comanda WHERE ID_Comanda='com';").await,
            2.0,
            "ninguna de las dos vías puede llevarse una línea cobrada"
        );
    }
}

#[cfg(test)]
mod tests_arqueo_ciego {
    //! Lo que hace útil el arqueo (CUENTA-07): anular un cobro en efectivo ya **no** baja el
    //! esperado del arqueo, así que el dinero que falta sale como que falta.

    use super::tests_comunes::*;
    use super::*;
    use crate::cierre_caja::SqliteCierreCajaRepository;
    use tpv_application::ports::cierre_caja::CierreCajaRepository;
    use tpv_application::ports::cuentas::{AnularPagoArgs, CuentasRepository};

    /// Euros -> `Dinero`. Los supuestos se escriben en euros; lo que se compara son centimos.
    #[allow(dead_code)]
    fn eur(euros: f64) -> Dinero {
        Dinero::de_euros(euros)
    }

    const DOS_COBROS_EN_EFECTIVO: &[&str] = &[
        // El rol Administrador lo siembran ya las migraciones; aquí sólo hace falta el usuario que
        // firma la anulación (`Anulado_Por` es una FK y el CHECK lo exige).
        "INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre)
           VALUES ('u1', '00000000-0000-7000-8000-000000000001', 'jefe@bar.example', 'x', 'Marta');",
        "INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura, Estado)
           VALUES ('com', 'BARRA', '2026-01-02 12:00:00', 'Pagada');",
        "INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo)
           VALUES ('p1', 'com', '2026-01-02 12:30:00', 'Efectivo', 2000, 'TOTAL');",
        "INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo)
           VALUES ('p2', 'com', '2026-01-02 13:30:00', 'Efectivo', 3000, 'TOTAL');",
    ];

    #[tokio::test]
    async fn el_esperado_del_arqueo_no_baja_al_anular_un_cobro_en_efectivo() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, DOS_COBROS_EN_EFECTIVO).await;
        let caja = SqliteCierreCajaRepository::new(db.clone());

        assert_eq!(caja.totales_desde(None).await.unwrap().ventas_efectivo, eur(50.0));

        SqliteCuentasRepository::new(db.clone())
            .anular_pago(AnularPagoArgs {
                id_pago: "p2".into(),
                id_usuario: "u1".into(),
                motivo: "se lo llevó puesto".into(),
                // FISCAL-01: anulación POR ERROR, que es lo que hacía el botón único
                // antes de partirlo. El test sigue describiendo el mismo comportamiento.
                clase: ClaseBaja::Error,
            })
            .await
            .unwrap();

        assert_eq!(
            caja.totales_desde(None).await.unwrap().ventas_efectivo,
            eur(20.0),
            "el cobro anulado deja de ser una venta…"
        );
        // …y por eso los 30 € que faltan del cajón ya no tienen quien los tape: el esperado baja a
        // 20, el recuento dirá 20 si el dinero está y 20 menos lo que falte si no. Antes de
        // CUENTA-07 el pago desaparecía y el descuadre salía exactamente cero.
        let (n, importe) = caja.anulaciones_desde(None).await.unwrap();
        assert_eq!((n, importe), (1, eur(30.0)), "y queda contado, que es el aviso");
    }

    #[tokio::test]
    async fn las_anulaciones_se_cuentan_por_cuando_se_anularon_no_por_la_venta() {
        // Lo que pertenece al periodo es el acto de anular. Una venta de anteayer anulada hoy es
        // un movimiento de HOY: es hoy cuando el dinero sale del cajón.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, DOS_COBROS_EN_EFECTIVO).await;

        SqliteCuentasRepository::new(db.clone())
            .anular_pago(AnularPagoArgs {
                id_pago: "p1".into(),
                id_usuario: "u1".into(),
                motivo: "x".into(),
                clase: ClaseBaja::Error,
            })
            .await
            .unwrap();

        let caja = SqliteCierreCajaRepository::new(db.clone());
        // Corte muy anterior a la venta: la anulación (de ahora) cae dentro.
        let (n, _) = caja.anulaciones_desde(Some("2026-01-01 00:00:00")).await.unwrap();
        assert_eq!(n, 1);
        // Corte en el futuro: fuera.
        let (n, _) = caja.anulaciones_desde(Some("2099-01-01 00:00:00")).await.unwrap();
        assert_eq!(n, 0);
    }

    #[tokio::test]
    async fn el_resumen_de_caja_deja_de_contar_los_anulados_pero_los_ensena() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, DOS_COBROS_EN_EFECTIVO).await;
        let r = SqliteCuentasRepository::new(db.clone());

        r.anular_pago(AnularPagoArgs {
            id_pago: "p2".into(),
            id_usuario: "u1".into(),
            motivo: "x".into(),
            clase: ClaseBaja::Error,
        })
        .await
        .unwrap();

        let res = r.resumen(None, None, None).await.unwrap();
        assert_eq!(res.total_entradas, eur(20.0));
        assert_eq!(res.total_efectivo, eur(20.0));
        assert_eq!(res.count_entradas, 1);
        assert_eq!(res.count_anuladas, 1);
        assert_eq!(res.total_anulado, eur(30.0));

        let filas = r.entradas(Default::default()).await.unwrap().filas;
        assert_eq!(filas.len(), 2, "en la lista salen los dos: aquí se investiga");
        let anulada = filas.iter().find(|e| e.id == "p2").unwrap();
        assert_eq!(anulada.estado, "ANULADO");
        assert_eq!(anulada.anulado_por.as_deref(), Some("Marta"));
        assert_eq!(anulada.motivo_anulacion.as_deref(), Some("x"));
    }
}

#[cfg(test)]
mod tests_paginacion {
    //! La lista de Cuentas pagina por clave (RI-18): cada página empieza justo después de la última
    //! fila de la anterior. Lo que no puede pasar es que una fila se repita o se pierda entre dos
    //! páginas, que es justo lo que pasa si el cursor y el orden no miran las mismas columnas.

    use super::tests_comunes::*;
    use super::*;

    /// Siete cobros: tres en el MISMO segundo (el orden entre ellos lo decide el id) y dos en el
    /// mismo minuto pero distinto segundo (lo decide la fecha completa, no la recortada).
    const COBROS: &[&str] = &[
        "INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura, Estado)
           VALUES ('com', 'BARRA', '2026-03-01 09:00:00', 'Pagada');",
        "INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo) VALUES
           ('a', 'com', '2026-03-01 10:00:00', 'Efectivo', 100, 'TOTAL'),
           ('b', 'com', '2026-03-01 10:00:00', 'Efectivo', 200, 'TOTAL'),
           ('c', 'com', '2026-03-01 10:00:00', 'Tarjeta', 300, 'TOTAL'),
           ('d', 'com', '2026-03-01 10:05:07', 'Efectivo', 400, 'TOTAL'),
           ('e', 'com', '2026-03-01 10:05:59', 'Efectivo', 500, 'TOTAL'),
           ('f', 'com', '2026-03-02 08:00:00', 'Efectivo', 600, 'TOTAL'),
           ('g', 'com', '2026-02-27 20:00:00', 'Efectivo', 700, 'TOTAL');",
    ];

    async fn todas_las_paginas(
        r: &SqliteCuentasRepository,
        page_size: u32,
        del: Option<&str>,
    ) -> Vec<Vec<String>> {
        let mut paginas = Vec::new();
        let mut cursor = None;
        loop {
            let p = r
                .entradas(CuentasFiltro {
                    del: del.map(String::from),
                    al: None,
                    q: None,
                    page_size: Some(page_size),
                    cursor: cursor.take(),
                })
                .await
                .unwrap();
            paginas.push(p.filas.iter().map(|e| e.id.clone()).collect());
            match p.siguiente {
                Some(c) => cursor = Some(c),
                None => break,
            }
            assert!(paginas.len() < 20, "la paginación no termina");
        }
        paginas
    }

    #[tokio::test]
    async fn recorrer_las_paginas_da_la_lista_entera_sin_repetir_ni_perder() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, COBROS).await;
        let r = SqliteCuentasRepository::new(db.clone());

        let entera: Vec<String> = r
            .entradas(Default::default())
            .await
            .unwrap()
            .filas
            .into_iter()
            .map(|e| e.id)
            .collect();
        // Fecha completa DESC y, a igual fecha, id DESC.
        assert_eq!(entera, ["f", "e", "d", "c", "b", "a", "g"]);

        for tam in 1..=8 {
            let paginas = todas_las_paginas(&r, tam, None).await;
            assert_eq!(
                paginas.concat(),
                entera,
                "con páginas de {tam}, alguna fila se repite o se pierde: {paginas:?}"
            );
            assert!(paginas.iter().all(|p| p.len() <= tam as usize));
            // Cuando el total es múltiplo del tamaño, la última página llena no dice «hay más».
            assert!(!paginas.last().unwrap().is_empty() || paginas.len() == 1);
        }
    }

    #[tokio::test]
    async fn el_cursor_lleva_la_fecha_completa_y_convive_con_el_rango() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, COBROS).await;
        let r = SqliteCuentasRepository::new(db.clone());

        let p1 = r
            .entradas(CuentasFiltro { page_size: Some(2), ..Default::default() })
            .await
            .unwrap();
        assert_eq!(
            p1.siguiente,
            Some(CursorCuentas { fecha: "2026-03-01 10:05:59".into(), id: "e".into() }),
            "el cursor es la fecha con segundos, no la recortada que se enseña"
        );
        assert_eq!(p1.filas[1].fecha_hora, "2026-03-01 10:05");

        // Con rango desde el día 1, el cobro del 27 de febrero no aparece en ninguna página.
        let paginas = todas_las_paginas(&r, 2, Some("2026-03-01")).await;
        assert_eq!(paginas.concat(), ["f", "e", "d", "c", "b", "a"]);
    }

    #[tokio::test]
    async fn los_gastos_paginan_igual_con_una_fecha_sin_hora() {
        let (db, _dir) = db_temporal().await;
        sembrar(
            &db,
            &["INSERT INTO Cuentas_Gastos (ID_Gasto, Fecha, Concepto, Importe, Tipo_Gasto) VALUES
                 ('g1', '2026-03-01', 'Hielo', 500, 'Otro'),
                 ('g2', '2026-03-01', 'Pan', 300, 'Otro'),
                 ('g3', '2026-03-02', 'Luz', 9000, 'Otro');"],
        )
        .await;
        let r = SqliteCuentasRepository::new(db.clone());

        let p1 = r
            .salidas(CuentasFiltro { page_size: Some(2), ..Default::default() })
            .await
            .unwrap();
        assert_eq!(p1.filas.iter().map(|g| g.id.as_str()).collect::<Vec<_>>(), ["g3", "g2"]);
        let p2 = r
            .salidas(CuentasFiltro { page_size: Some(2), cursor: p1.siguiente, ..Default::default() })
            .await
            .unwrap();
        assert_eq!(p2.filas.iter().map(|g| g.id.as_str()).collect::<Vec<_>>(), ["g1"]);
        assert!(p2.siguiente.is_none());
    }
}

#[cfg(test)]
// Los nombres de estos tests usan MAYUSCULAS para enfatizar la afirmacion que fijan
// (`..._NO_gasta_numero`, `..._por_RANGO_...`). Es deliberado y no es snake case.
#[allow(non_snake_case)]
mod tests_factura_completa {
    //! La factura completa (FISCAL-02): `F1` al cobrar y `F3` en sustitución.
    //!
    //! Lo que se fija aquí es el **corte de los 3.000 €**, que es la única regla de este tramo que
    //! no se puede deshacer después: emitir una `F2` por encima del límite es emitir una factura
    //! inválida —la AEAT la rechaza con el error 1150— y el registro, una vez emitido, no se
    //! modifica jamás.

    use super::tests_comunes::*;
    use super::*;
    use tpv_domain::verifactu::Destinatario;

    /// Un ticket de barra con una línea cara, para poder pasar del límite sin inventar 300 líneas.
    const VENTA_CARA: &[&str] = &[
        "UPDATE Business_Settings SET CIF = 'B12345674', Razon_Social = 'Bar de Pruebas SL'
           WHERE ID = 1;",
        "INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre)
           VALUES ('u1', '00000000-0000-7000-8000-000000000001', 'jefe@bar.example', 'x', 'Marta');",
        "INSERT INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('cat', 'Banquetes');",
        "INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta)
           VALUES ('prod', 'cat', 'Menu de boda', 350000);",
        "INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura, Estado, Total_Comanda)
           VALUES ('com', 'BARRA', '2027-01-15 12:00:00', 'Abierta', 350000);",
        "INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Cantidad, Precio_Unitario, IVA_Percent)
           VALUES ('det', 'com', 'prod', 1, 350000, 10);",
    ];

    /// Un ticket normal, por debajo del límite.
    const VENTA_NORMAL: &[&str] = &[
        "UPDATE Business_Settings SET CIF = 'B12345674', Razon_Social = 'Bar de Pruebas SL'
           WHERE ID = 1;",
        "INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre)
           VALUES ('u1', '00000000-0000-7000-8000-000000000001', 'jefe@bar.example', 'x', 'Marta');",
        "INSERT INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('cat', 'Bebidas');",
        "INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta)
           VALUES ('prod', 'cat', 'Cerveza', 300);",
        "INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura, Estado, Total_Comanda)
           VALUES ('com', 'BARRA', '2027-01-15 12:00:00', 'Abierta', 300);",
        "INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Cantidad, Precio_Unitario, IVA_Percent)
           VALUES ('det', 'com', 'prod', 1, 300, 10);",
    ];

    async fn texto(db: &Arc<Db>, sql: &str) -> Option<String> {
        let r = db.read().await;
        let mut rows = r.query(sql, Vec::<Value>::new()).await.unwrap();
        let row = rows.next().await.unwrap()?;
        crate::mapping::v_string(row.get_value(0).unwrap())
    }

    /// Cobra por el camino real de venta rápida, con o sin destinatario.
    async fn cobrar(
        db: &Arc<Db>,
        destinatario: Option<Destinatario>,
    ) -> tpv_application::error::AppResult<String> {
        use tpv_application::ports::venta_rapida::VentaRapidaRepository as _;
        crate::venta_rapida::SqliteVentaRapidaRepository::new(db.clone())
            .cobrar_fraccionado(tpv_domain::venta_rapida::CobroFraccionado {
                id_pago: crate::util::new_id(),
                id_comanda: "com".into(),
                metodo: "Efectivo".into(),
                importe_total: Dinero::CERO,
                id_usuario_cobrador: Some("u1".into()),
                id_trabajador_cobrador: None,
                detalles: vec!["det".into()],
                destinatario,
            })
            .await
    }

    fn cliente() -> Destinatario {
        Destinatario {
            nombre_razon: "Empresa Cliente SL".into(),
            nif: "B12345674".into(),
            direccion: Some("Calle Mayor 1".into()),
        }
    }

    #[tokio::test]
    async fn un_cobro_normal_sin_datos_del_cliente_emite_una_simplificada() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_NORMAL).await;
        cobrar(&db, None).await.unwrap();

        assert_eq!(
            texto(&db, "SELECT Tipo_Factura FROM Registros_Facturacion LIMIT 1;").await,
            Some("F2".into())
        );
        assert_eq!(
            texto(&db, "SELECT Destinatario_Json FROM Registros_Facturacion LIMIT 1;").await,
            None,
            "una F2 NO puede llevar destinatario (error 1190)"
        );
    }

    #[tokio::test]
    async fn con_los_datos_del_cliente_emite_factura_completa_aunque_sea_un_cafe() {
        // No hay importe mínimo: el cliente puede pedir factura por una caña.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_NORMAL).await;
        cobrar(&db, Some(cliente())).await.unwrap();

        assert_eq!(
            texto(&db, "SELECT Tipo_Factura FROM Registros_Facturacion LIMIT 1;").await,
            Some("F1".into())
        );
        let dest = texto(&db, "SELECT Destinatario_Json FROM Registros_Facturacion LIMIT 1;")
            .await
            .expect("una F1 tiene que llevar destinatario (error 1189)");
        assert!(dest.contains("Empresa Cliente SL"), "{dest}");
        assert!(dest.contains("B12345674"), "{dest}");
        // El domicilio se guarda para el papel de la factura (RI-29); al XML no va (lo fija
        // `xml.rs::el_domicilio_del_cliente_no_va_al_xml`).
        assert!(dest.contains("Calle Mayor"), "{dest}");
    }

    #[tokio::test]
    async fn por_encima_del_limite_sin_datos_el_cobro_se_RECHAZA_con_su_codigo() {
        // El corte. No se emite una F2 inválida ni se cobra a medias: la transacción rueda atrás y
        // la pantalla recibe un código por el que ramificar para pedir el NIF.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_CARA).await;

        let e = cobrar(&db, None).await.unwrap_err();
        assert_eq!(
            e.code(),
            tpv_contracts::errors::ErrorCode::FacturaCompletaRequerida,
            "la UI ramifica por el código, no por el mensaje"
        );

        // Y lo que importa de verdad: no quedó NADA a medias.
        assert_eq!(escalar(&db, "SELECT COUNT(*) FROM Pagos;").await, 0.0);
        assert_eq!(
            escalar(&db, "SELECT COUNT(*) FROM Registros_Facturacion;").await,
            0.0
        );
        assert_eq!(
            texto(&db, "SELECT Estado FROM Comandas WHERE ID_Comanda='com';").await,
            Some("Abierta".into()),
            "la comanda sigue abierta: se puede reintentar con los datos del cliente"
        );
    }

    #[tokio::test]
    async fn el_numero_no_se_gasta_en_un_cobro_rechazado() {
        // El número se reserva DENTRO de la transacción, así que el rollback lo devuelve. Si se
        // gastara, el primer cobro de verdad saldría con un hueco que nadie puede explicar.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_CARA).await;
        assert!(cobrar(&db, None).await.is_err());

        let serie = chrono::Local::now().format("%Y").to_string();
        assert_eq!(
            escalar(
                &db,
                &format!("SELECT COALESCE((SELECT Ultimo FROM Serie_Facturacion WHERE Serie='{serie}'), 0);")
            )
            .await,
            0.0
        );
    }

    #[tokio::test]
    async fn por_encima_del_limite_CON_datos_sale_una_F1() {
        // La misma venta que el test anterior, con el NIF del cliente: ahora sí se puede facturar.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_CARA).await;
        cobrar(&db, Some(cliente())).await.unwrap();

        assert_eq!(
            texto(&db, "SELECT Tipo_Factura FROM Registros_Facturacion LIMIT 1;").await,
            Some("F1".into())
        );
        assert_eq!(
            texto(&db, "SELECT Importe_Total FROM Registros_Facturacion LIMIT 1;").await,
            Some("3500.00".into())
        );
    }

    #[tokio::test]
    async fn el_limite_se_mira_sobre_el_COBRO_y_no_sobre_la_comanda() {
        // Una comanda de 4.000 € que pagan dos empresas a 2.000 € son dos simplificadas correctas,
        // y eso ya funciona con el cobro fraccionado. Es una consecuencia del modelo, no un atajo.
        let (db, _dir) = db_temporal().await;
        sembrar(
            &db,
            &[
                "UPDATE Business_Settings SET CIF = 'B12345674', Razon_Social = 'Bar SL' WHERE ID = 1;",
                "INSERT INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('cat', 'Banquetes');",
                "INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta)
                   VALUES ('prod', 'cat', 'Menu', 200000);",
                "INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura, Estado, Total_Comanda)
                   VALUES ('com', 'BARRA', '2027-01-15 12:00:00', 'Abierta', 400000);",
                "INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Cantidad, Precio_Unitario, IVA_Percent)
                   VALUES ('d1', 'com', 'prod', 1, 200000, 10);",
                "INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Cantidad, Precio_Unitario, IVA_Percent)
                   VALUES ('d2', 'com', 'prod', 1, 200000, 10);",
            ],
        )
        .await;

        use tpv_application::ports::venta_rapida::VentaRapidaRepository as _;
        let repo = crate::venta_rapida::SqliteVentaRapidaRepository::new(db.clone());
        for det in ["d1", "d2"] {
            repo.cobrar_fraccionado(tpv_domain::venta_rapida::CobroFraccionado {
                id_pago: crate::util::new_id(),
                id_comanda: "com".into(),
                metodo: "Efectivo".into(),
                importe_total: Dinero::CERO,
                id_usuario_cobrador: None,
                id_trabajador_cobrador: None,
                detalles: vec![det.into()],
                destinatario: None,
            })
            .await
            .unwrap_or_else(|e| panic!("el cobro de {det} debería salir: {e:?}"));
        }

        assert_eq!(
            escalar(
                &db,
                "SELECT COUNT(*) FROM Registros_Facturacion WHERE Tipo_Factura='F2';"
            )
            .await,
            2.0,
            "dos cobros de 2.000 € son DOS simplificadas correctas"
        );
    }

    #[tokio::test]
    async fn un_nif_de_cliente_mal_dictado_no_deja_cobrar_y_lo_dice() {
        // Y el cobro no entra: mejor pedir que lo repita con el cliente delante que mandarlo mal y
        // que vuelva como error admisible 2001 horas después.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_NORMAL).await;

        let e = cobrar(
            &db,
            Some(Destinatario {
                nombre_razon: "Empresa SL".into(),
                nif: "B12345670".into(),
                direccion: None,
            }),
        )
        .await
        .unwrap_err();
        assert!(format!("{e:?}").contains("NIF"), "{e:?}");
        assert_eq!(escalar(&db, "SELECT COUNT(*) FROM Pagos;").await, 0.0);
    }

    #[tokio::test]
    async fn el_limite_configurado_del_negocio_es_el_que_manda() {
        // `Limite_Simplif` existe porque es un número que la norma puede mover. Con 400 € (el
        // general del art. 4.1, para un negocio que no fuera hostelería) la misma venta corta antes.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_NORMAL).await;
        sembrar(&db, &["UPDATE Business_Settings SET Limite_Simplif = 2.0 WHERE ID = 1;"]).await;

        let e = cobrar(&db, None).await.unwrap_err();
        assert_eq!(
            e.code(),
            tpv_contracts::errors::ErrorCode::FacturaCompletaRequerida
        );
    }

    // ── F3: el canje posterior ──────────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn el_cliente_vuelve_con_el_ticket_y_se_emite_una_F3_que_lo_sustituye() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_NORMAL).await;
        cobrar(&db, None).await.unwrap();

        let num = texto(&db, "SELECT Num_Serie_Factura FROM Registros_Facturacion LIMIT 1;")
            .await
            .unwrap();

        let repo = crate::verifactu::CanjePorNumero(db.clone());
        let bloque = repo.emitir_sustitutiva(&num, cliente()).await.unwrap();

        assert_eq!(bloque.tipo_factura, "F3");
        // Y va en la serie ORDINARIA, no en la de rectificativas. Es el mismo art. 15.6: «las
        // facturas que se expidan en sustitución o canje de facturas simplificadas expedidas con
        // anterioridad NO TENDRÁN LA CONDICIÓN DE RECTIFICATIVAS». Mandarla a la serie `R` sería
        // declarar como rectificación algo que el reglamento dice expresamente que no lo es.
        let serie = chrono::Local::now().format("%Y").to_string();
        assert_eq!(
            bloque.num_serie_factura,
            format!("{serie}/000002"),
            "la F3 continúa la serie de las ventas"
        );
        // La simplificada original NO se toca: canjearla no es rectificarla (art. 15.6 ROF).
        assert_eq!(
            escalar(
                &db,
                "SELECT COUNT(*) FROM Registros_Facturacion WHERE Tipo_Factura='F2';"
            )
            .await,
            1.0
        );
        assert_eq!(
            escalar(&db, "SELECT COUNT(*) FROM Registros_Facturacion WHERE Tipo='ANULACION';").await,
            0.0,
            "no se anula nada"
        );
        // Y la referencia va en `FacturasSustituidas`, no en `FacturasRectificadas` (error 1116).
        let refs = texto(
            &db,
            "SELECT Referencias_Json FROM Registros_Facturacion WHERE Tipo_Factura='F3';",
        )
        .await
        .unwrap();
        assert!(refs.contains("sustituidas"), "{refs}");
        assert!(refs.contains(&num), "{refs}");
    }

    #[tokio::test]
    async fn la_F3_declara_el_mismo_dinero_que_el_ticket() {
        // No cambia el importe: lo vuelve a declarar con destinatario. Si difiriera, habría dos
        // facturas del mismo hecho diciendo cosas distintas.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_NORMAL).await;
        cobrar(&db, None).await.unwrap();
        let num = texto(&db, "SELECT Num_Serie_Factura FROM Registros_Facturacion LIMIT 1;")
            .await
            .unwrap();

        crate::verifactu::CanjePorNumero(db.clone())
            .emitir_sustitutiva(&num, cliente())
            .await
            .unwrap();

        let f2 = texto(
            &db,
            "SELECT Importe_Total FROM Registros_Facturacion WHERE Tipo_Factura='F2';",
        )
        .await;
        let f3 = texto(
            &db,
            "SELECT Importe_Total FROM Registros_Facturacion WHERE Tipo_Factura='F3';",
        )
        .await;
        assert_eq!(f2, f3);
        assert_eq!(f3, Some("3.00".into()));
    }

    #[tokio::test]
    async fn un_ticket_no_se_factura_dos_veces() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_NORMAL).await;
        cobrar(&db, None).await.unwrap();
        let num = texto(&db, "SELECT Num_Serie_Factura FROM Registros_Facturacion LIMIT 1;")
            .await
            .unwrap();

        let repo = crate::verifactu::CanjePorNumero(db.clone());
        repo.emitir_sustitutiva(&num, cliente()).await.unwrap();

        let e = repo.emitir_sustitutiva(&num, cliente()).await.unwrap_err();
        assert!(format!("{e:?}").contains("ya se emitió"), "{e:?}");
        assert_eq!(
            escalar(
                &db,
                "SELECT COUNT(*) FROM Registros_Facturacion WHERE Tipo_Factura='F3';"
            )
            .await,
            1.0
        );
    }

    #[tokio::test]
    async fn una_factura_que_ya_es_completa_no_se_canjea() {
        // Una `F1` ya lleva destinatario y una `R5` es una rectificativa: en ninguna hay nada que
        // sustituir, y dejarlo pasar emitiría una segunda factura del mismo hecho.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_NORMAL).await;
        cobrar(&db, Some(cliente())).await.unwrap();
        let num = texto(&db, "SELECT Num_Serie_Factura FROM Registros_Facturacion LIMIT 1;")
            .await
            .unwrap();

        let e = crate::verifactu::CanjePorNumero(db.clone())
            .emitir_sustitutiva(&num, cliente())
            .await
            .unwrap_err();
        assert!(format!("{e:?}").contains("F1"), "{e:?}");
    }

    #[tokio::test]
    async fn canjear_un_numero_que_no_existe_no_revienta() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_NORMAL).await;

        let e = crate::verifactu::CanjePorNumero(db.clone())
            .emitir_sustitutiva("2027/999999", cliente())
            .await
            .unwrap_err();
        assert!(format!("{e:?}").contains("No existe"), "{e:?}");
    }
}

#[cfg(test)]
// Los nombres de estos tests usan MAYUSCULAS para enfatizar la afirmacion que fijan
// (`..._NO_gasta_numero`, `..._por_RANGO_...`). Es deliberado y no es snake case.
#[allow(non_snake_case)]
mod tests_anular_vs_devolver {
    //! Los **dos instrumentos** de FISCAL-01, que hasta ahora salían por el mismo botón.
    //!
    //! La AEAT los separa sin matices:
    //!
    //! - **Anular** es para una factura que *no responde a una operación real* (art. 11.1 RRSIF):
    //!   un ticket de prueba, una formación, una mesa equivocada. Su FAQ dice que estos casos deben
    //!   ser «MUY POCO FRECUENTES».
    //! - **Rectificar** es para cuando la operación **sí existió** y hay que devolver dinero:
    //!   *«todas las facturas emitidas, en la medida en que respondan a operaciones realmente
    //!   efectuadas (como es el caso habitual) no pueden anularse»*.
    //!
    //! Y la que más se va a usar —la devolución— es justo la que no era una anulación.

    use super::tests_comunes::*;
    use super::*;

    /// El repositorio y el lector de un escalar de texto: los mismos que usa `tests_anulacion`.
    /// Están aquí y no en `tests_comunes` porque son de tres líneas y moverlos obligaría a tocar el
    /// módulo de al lado sin necesidad.
    fn repo(db: &Arc<Db>) -> SqliteCuentasRepository {
        SqliteCuentasRepository::new(db.clone())
    }

    async fn texto(db: &Arc<Db>, sql: &str) -> Option<String> {
        let r = db.read().await;
        let mut rows = r.query(sql, Vec::<Value>::new()).await.unwrap();
        let row = rows.next().await.unwrap()?;
        crate::mapping::v_string(row.get_value(0).unwrap())
    }

    /// Una venta de barra cobrada, con datos fiscales configurados para que el registro se emita.
    const VENTA_COBRADA: &[&str] = &[
        "UPDATE Business_Settings SET CIF = 'B12345674', Razon_Social = 'Bar de Pruebas SL'
           WHERE ID = 1;",
        "INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre)
           VALUES ('u1', '00000000-0000-7000-8000-000000000001', 'jefe@bar.example', 'x', 'Marta');",
        "INSERT INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('cat', 'Bebidas');",
        "INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta, Stock_Suelto)
           VALUES ('prod', 'cat', 'Cerveza', 300, 10);",
        "INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura, Estado, Total_Comanda)
           VALUES ('com', 'BARRA', '2027-01-15 12:00:00', 'Pagada', 300);",
        "INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Cantidad, Precio_Unitario, IVA_Percent)
           VALUES ('det', 'com', 'prod', 1, 300, 10);",
    ];

    /// Cobra por el camino real (para que se emita el registro fiscal) y devuelve el `ID_Pago`.
    async fn cobrar(db: &Arc<Db>) -> String {
        use tpv_application::ports::venta_rapida::VentaRapidaRepository as _;
        crate::venta_rapida::SqliteVentaRapidaRepository::new(db.clone())
            .cobrar_fraccionado(tpv_domain::venta_rapida::CobroFraccionado {
                id_pago: crate::util::new_id(),
                id_comanda: "com".into(),
                metodo: "Efectivo".into(),
                importe_total: Dinero::CERO,
                id_usuario_cobrador: Some("u1".into()),
                id_trabajador_cobrador: None,
                detalles: vec!["det".into()],
                // FISCAL-02: una venta normal es un ticket (F2), sin datos de cliente.
                destinatario: None,
            })
            .await
            .expect("el cobro tiene que salir");

        let r = db.read().await;
        let mut rows = r
            .query(
                "SELECT ID_Pago FROM Pagos WHERE ID_Comanda = 'com' LIMIT 1;",
                Vec::<Value>::new(),
            )
            .await
            .unwrap();
        let row = rows.next().await.unwrap().expect("tiene que haber un pago");
        crate::mapping::v_string(row.get_value(0).unwrap()).unwrap()
    }

    #[tokio::test]
    async fn anular_por_error_emite_un_registro_de_anulacion() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_COBRADA).await;
        let id_pago = cobrar(&db).await;

        repo(&db)
            .anular_pago(AnularPagoArgs {
                id_pago: id_pago.clone(),
                id_usuario: "u1".into(),
                motivo: "mesa equivocada".into(),
                clase: ClaseBaja::Error,
            })
            .await
            .unwrap();

        assert_eq!(
            escalar(&db, "SELECT COUNT(*) FROM Registros_Facturacion WHERE Tipo='ANULACION';").await,
            1.0,
            "una anulación por error emite un RF de anulación"
        );
        assert_eq!(
            escalar(
                &db,
                "SELECT COUNT(*) FROM Registros_Facturacion WHERE Tipo_Factura='R5';"
            )
            .await,
            0.0,
            "y NO una rectificativa"
        );
        // Anular no borra nada: el alta original sigue ahí, y los dos se remiten.
        assert_eq!(
            escalar(&db, "SELECT COUNT(*) FROM Registros_Facturacion WHERE Tipo='ALTA';").await,
            1.0
        );
        assert_eq!(
            escalar(&db, "SELECT COUNT(*) FROM _Verifactu_Envios;").await,
            2.0,
            "los dos registros se encolan para remitir"
        );
    }

    #[tokio::test]
    async fn devolver_emite_una_rectificativa_R5_con_importe_negativo() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_COBRADA).await;
        let id_pago = cobrar(&db).await;

        repo(&db)
            .anular_pago(AnularPagoArgs {
                id_pago: id_pago.clone(),
                id_usuario: "u1".into(),
                motivo: "devolución al cliente".into(),
                clase: ClaseBaja::Devolucion,
            })
            .await
            .unwrap();

        assert_eq!(
            escalar(&db, "SELECT COUNT(*) FROM Registros_Facturacion WHERE Tipo='ANULACION';").await,
            0.0,
            "una devolución NO se anula: la operación existió"
        );
        assert_eq!(
            texto(
                &db,
                "SELECT Tipo_Factura FROM Registros_Facturacion ORDER BY Orden DESC LIMIT 1;"
            )
            .await,
            Some("R5".into())
        );
        assert_eq!(
            texto(
                &db,
                "SELECT Tipo_Rectificativa FROM Registros_Facturacion ORDER BY Orden DESC LIMIT 1;"
            )
            .await,
            Some("I".into()),
            "por diferencias, no por sustitución"
        );
        assert_eq!(
            texto(
                &db,
                "SELECT Importe_Total FROM Registros_Facturacion ORDER BY Orden DESC LIMIT 1;"
            )
            .await,
            Some("-3.00".into()),
            "el importe va NEGATIVO, y es el mismo número que se cobró con el signo cambiado"
        );
    }

    #[tokio::test]
    async fn la_rectificativa_referencia_la_factura_original() {
        // Sin la referencia, la AEAT no sabe qué se está rectificando: es el bloque
        // `FacturasRectificadas`, obligatorio en una R*.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_COBRADA).await;
        let id_pago = cobrar(&db).await;

        let num_original = texto(
            &db,
            "SELECT Num_Serie_Factura FROM Registros_Facturacion WHERE Tipo='ALTA' LIMIT 1;",
        )
        .await
        .unwrap();

        repo(&db)
            .anular_pago(AnularPagoArgs {
                id_pago,
                id_usuario: "u1".into(),
                motivo: "devolución".into(),
                clase: ClaseBaja::Devolucion,
            })
            .await
            .unwrap();

        let refs = texto(
            &db,
            "SELECT Referencias_Json FROM Registros_Facturacion ORDER BY Orden DESC LIMIT 1;",
        )
        .await
        .expect("la rectificativa tiene que llevar referencias");
        assert!(refs.contains(&num_original), "{refs}");
        assert!(refs.contains("rectificadas"), "{refs}");
    }

    #[tokio::test]
    async fn la_rectificativa_gasta_numero_de_SU_PROPIA_serie() {
        // Art. 6.1.a) RD 1619/2012: «será obligatoria, EN TODO CASO, la expedición en series
        // específicas de las facturas siguientes: […] 2.º Las rectificativas.»
        //
        // Este test decía justo lo contrario hasta que se leyó el reglamento. El razonamiento que
        // lo sostenía —«serían dos contadores que mantener»— era cierto y da igual: no es un
        // argumento contra un «en todo caso».
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_COBRADA).await;
        let id_pago = cobrar(&db).await;
        let serie = chrono::Local::now().format("%Y").to_string();

        repo(&db)
            .anular_pago(AnularPagoArgs {
                id_pago,
                id_usuario: "u1".into(),
                motivo: "devolución".into(),
                clase: ClaseBaja::Devolucion,
            })
            .await
            .unwrap();

        assert_eq!(
            texto(
                &db,
                "SELECT Num_Serie_Factura FROM Registros_Facturacion WHERE Tipo_Factura='R5';"
            )
            .await,
            Some(format!("R{serie}/000001")),
            "la R5 abre su propia serie, no continúa la de las ventas"
        );
    }

    #[tokio::test]
    async fn la_rectificativa_NO_gasta_numero_de_la_serie_de_ventas() {
        // La otra mitad, y la que se nota en el libro: si la R5 consumiera un número de la serie
        // ordinaria, la venta siguiente saltaría uno y el listado tendría un hueco que no
        // corresponde a ninguna factura.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_COBRADA).await;
        let id_pago = cobrar(&db).await;
        let serie = chrono::Local::now().format("%Y").to_string();

        repo(&db)
            .anular_pago(AnularPagoArgs {
                id_pago,
                id_usuario: "u1".into(),
                motivo: "devolución".into(),
                clase: ClaseBaja::Devolucion,
            })
            .await
            .unwrap();

        // El contador de la serie ordinaria se quedó donde estaba: la venta gastó el 1 y nadie más.
        let g = db.write().await;
        assert_eq!(
            crate::verifactu::reservar_numero_factura(&g).await.unwrap().0,
            format!("{serie}/000002"),
            "la siguiente venta es la 2, no la 3"
        );
    }

    #[tokio::test]
    async fn una_devolucion_NO_devuelve_las_lineas_a_la_comanda() {
        // Es la diferencia que se nota en la barra: el cliente se llevó la consumición. Si las
        // líneas volvieran, quedarían pendientes de cobro y el camarero las cobraría otra vez.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_COBRADA).await;
        let id_pago = cobrar(&db).await;

        repo(&db)
            .anular_pago(AnularPagoArgs {
                id_pago,
                id_usuario: "u1".into(),
                motivo: "devolución".into(),
                clase: ClaseBaja::Devolucion,
            })
            .await
            .unwrap();

        assert_eq!(
            texto(&db, "SELECT Estado FROM Comandas WHERE ID_Comanda='com';").await,
            Some("Pagada".into()),
            "la comanda NO se reabre"
        );
        // El stock sí vuelve: lo devuelto vuelve al almacén.
        assert_eq!(
            escalar(&db, "SELECT Stock_Suelto FROM Productos WHERE ID_Producto='prod';").await,
            10.0
        );
    }

    #[tokio::test]
    async fn una_anulacion_por_error_SI_las_devuelve() {
        // El otro lado: la venta no existió, así que la consumición sigue en la mesa y el stock
        // nunca debió bajar.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_COBRADA).await;
        let id_pago = cobrar(&db).await;

        repo(&db)
            .anular_pago(AnularPagoArgs {
                id_pago,
                id_usuario: "u1".into(),
                motivo: "mesa equivocada".into(),
                clase: ClaseBaja::Error,
            })
            .await
            .unwrap();

        assert_eq!(
            texto(&db, "SELECT Estado FROM Comandas WHERE ID_Comanda='com';").await,
            Some("Abierta".into()),
            "la comanda se reabre: las líneas siguen pendientes de cobro"
        );
        assert_eq!(
            escalar(&db, "SELECT Stock_Suelto FROM Productos WHERE ID_Producto='prod';").await,
            10.0,
            "el stock vuelve"
        );
    }

    #[tokio::test]
    async fn el_historial_de_caja_distingue_los_dos_hechos() {
        // Al investigar un descuadre importa cuál fue: una devolución es dinero que salió por una
        // venta real, y una anulación es una venta que nunca existió.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_COBRADA).await;
        let id_pago = cobrar(&db).await;

        repo(&db)
            .anular_pago(AnularPagoArgs {
                id_pago,
                id_usuario: "u1".into(),
                motivo: "devolución".into(),
                clase: ClaseBaja::Devolucion,
            })
            .await
            .unwrap();

        assert_eq!(
            escalar(&db, "SELECT COUNT(*) FROM Movimientos_Caja WHERE Tipo='DEVOLUCION';").await,
            1.0
        );
        assert_eq!(
            escalar(&db, "SELECT COUNT(*) FROM Movimientos_Caja WHERE Tipo='ANULACION';").await,
            0.0
        );
    }

    #[tokio::test]
    async fn la_clase_queda_escrita_en_el_pago() {
        // `Motivo_Baja` es lo que permite saber después qué instrumento se usó, y es lo que lee el
        // emisor del registro. Sin esto, una reimpresión no podría decir qué pasó con ese cobro.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_COBRADA).await;
        let id_pago = cobrar(&db).await;

        repo(&db)
            .anular_pago(AnularPagoArgs {
                id_pago: id_pago.clone(),
                id_usuario: "u1".into(),
                motivo: "devolución".into(),
                clase: ClaseBaja::Devolucion,
            })
            .await
            .unwrap();

        assert_eq!(
            texto(&db, "SELECT Motivo_Baja FROM Pagos WHERE ID_Pago = (SELECT ID_Pago FROM Pagos LIMIT 1);").await,
            Some("DEVOLUCION".into())
        );
        // Y sigue contando como ANULADO para todo lo demás: al cajón le da igual por qué salió el
        // dinero, y es lo que mantiene intactas las ~14 consultas que filtran por `Estado`.
        assert_eq!(
            texto(&db, "SELECT Estado FROM Pagos LIMIT 1;").await,
            Some("ANULADO".into())
        );
    }

    #[tokio::test]
    async fn una_segunda_baja_no_emite_otro_registro() {
        // El guardia de idempotencia, visto desde lo fiscal: el segundo clic no puede gastar otro
        // número ni mandar a la AEAT un hecho que no ha ocurrido.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_COBRADA).await;
        let id_pago = cobrar(&db).await;

        let args = |c: ClaseBaja| AnularPagoArgs {
            id_pago: id_pago.clone(),
            id_usuario: "u1".into(),
            motivo: "x".into(),
            clase: c,
        };

        assert!(repo(&db).anular_pago(args(ClaseBaja::Error)).await.unwrap());
        let registros = escalar(&db, "SELECT COUNT(*) FROM Registros_Facturacion;").await;

        assert!(
            !repo(&db).anular_pago(args(ClaseBaja::Error)).await.unwrap(),
            "la segunda vez devuelve false"
        );
        assert_eq!(
            escalar(&db, "SELECT COUNT(*) FROM Registros_Facturacion;").await,
            registros,
            "y no emite ningún registro nuevo"
        );
    }
}

#[cfg(test)]
mod tests_apertura_cajon {
    //! El registro de las aperturas del cajón.
    //!
    //! Un cajón que se abre sin una venta detrás es exactamente el movimiento por el que alguien
    //! pregunta cuando al cerrar falta dinero. Si no queda anotado, no hay nada que investigar.

    use super::tests_comunes::*;
    use super::*;
    use tpv_application::ports::cuentas::CuentasRepository;

    async fn aperturas(db: &Arc<Db>) -> Vec<(String, Option<String>)> {
        let r = db.read().await;
        let mut rows = r
            .query(
                "SELECT ID_Apertura, ID_Usuario FROM Aperturas_Cajon ORDER BY Fecha;",
                Vec::<Value>::new(),
            )
            .await
            .unwrap();
        let mut out = Vec::new();
        while let Some(row) = rows.next().await.unwrap() {
            out.push((
                crate::mapping::v_string(row.get_value(0).unwrap()).unwrap_or_default(),
                crate::mapping::v_string(row.get_value(1).unwrap()),
            ));
        }
        out
    }

    #[tokio::test]
    async fn cada_apertura_queda_anotada_con_quien_la_hizo() {
        let (db, _dir) = db_temporal().await;
        sembrar(
            &db,
            UN_USUARIO,
        )
        .await;
        let repo = SqliteCuentasRepository::new(db.clone());

        repo.registrar_apertura_cajon(Some("u1".into())).await.unwrap();

        let filas = aperturas(&db).await;
        assert_eq!(filas.len(), 1);
        assert_eq!(filas[0].1.as_deref(), Some("u1"));
        assert!(!filas[0].0.is_empty(), "cada apertura necesita su propio id");
    }

    #[tokio::test]
    async fn una_apertura_sin_usuario_se_anota_igual() {
        // Es peor perder el registro que no saber quién fue: al menos queda la hora.
        let (db, _dir) = db_temporal().await;
        let repo = SqliteCuentasRepository::new(db.clone());

        repo.registrar_apertura_cajon(None).await.unwrap();

        let filas = aperturas(&db).await;
        assert_eq!(filas.len(), 1);
        assert_eq!(filas[0].1, None);
    }

    #[tokio::test]
    async fn un_usuario_en_blanco_cuenta_como_sin_usuario() {
        // Una cadena vacía en la columna se leería como un usuario existente que no existe.
        let (db, _dir) = db_temporal().await;
        let repo = SqliteCuentasRepository::new(db.clone());

        repo.registrar_apertura_cajon(Some("   ".into())).await.unwrap();

        assert_eq!(aperturas(&db).await[0].1, None);
    }

    #[tokio::test]
    async fn varias_aperturas_no_se_pisan() {
        let (db, _dir) = db_temporal().await;
        let repo = SqliteCuentasRepository::new(db.clone());

        for _ in 0..3 {
            repo.registrar_apertura_cajon(None).await.unwrap();
        }

        let filas = aperturas(&db).await;
        assert_eq!(filas.len(), 3);
        let ids: std::collections::HashSet<_> = filas.iter().map(|f| f.0.clone()).collect();
        assert_eq!(ids.len(), 3, "los ids se están repitiendo");
    }

    /// Roles + un usuario, que es lo mínimo para que la FK de `Aperturas_Cajon` esté contenta.
    const UN_USUARIO: &[&str] = &[
        "INSERT INTO Roles (ID_Rol, Nombre_Rol) VALUES ('rol', 'camarero');",
        "INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre)
           VALUES ('u1', 'rol', 'ana@bar.example', 'x', 'Ana');",
    ];

    #[tokio::test]
    async fn la_apertura_se_replica_a_la_nube() {
        // Va por `execute` y no por `raw`: el registro del cajón es justo lo que hay que poder
        // mirar desde fuera del local. Si se capturara con `raw` se quedaría en el TPV.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, UN_USUARIO).await;
        let repo = SqliteCuentasRepository::new(db.clone());

        repo.registrar_apertura_cajon(Some("u1".into())).await.unwrap();

        let r = db.read().await;
        let mut rows = r
            .query(
                "SELECT COUNT(*) FROM _Sync_Outbox WHERE Statements_Json LIKE '%Aperturas_Cajon%';",
                Vec::<Value>::new(),
            )
            .await
            .unwrap();
        let n = crate::mapping::v_f64(rows.next().await.unwrap().unwrap().get_value(0).unwrap())
            .unwrap_or(0.0);
        assert_eq!(n, 1.0, "la apertura no ha entrado en el outbox");
    }
}

#[cfg(test)]
// Los nombres usan MAYÚSCULAS para la afirmación que fijan (`..._NO_...`). Es deliberado.
#[allow(non_snake_case)]
mod tests_baja_de_un_ticket_canjeado {
    //! Dar de baja un cobro cuyo ticket se canjeó por una factura completa (`F3`).
    //!
    //! Un cobro así tiene dos altas con el mismo `ID_Pago`: la del ticket (`F2`) y la de la `F3`.
    //! La baja cogía «la última alta del pago», que era la `F3`, y dejaba el ticket como estaba: una
    //! baja por error anulaba sólo la `F3` (el ticket seguía declarado) y una devolución emitía una
    //! `R5` que rectificaba la `F3` (una factura completa, sin su cliente).
    //!
    //! Lo que fijan estos tests sale de la FAQ de desarrolladores de la AEAT (v1.3, 4-12-2025):
    //!
    //! - **Devolución** (apartado 27, casos 2 y 3): una `R5` que rectifica la simplificada original
    //!   y, a continuación, una `F3` «con los mismos datos de R5», con el cliente, que sustituye a
    //!   la `R5`.
    //! - **Error** (apartado 17.2.d): la anulación deshace la expedición de una factura que no
    //!   respondía a una operación real. La `F3` documenta esa misma operación, así que se anulan
    //!   las dos.
    //!
    //! Y la devolución de una factura completa emitida al cobrar (`F1`): su rectificativa es una
    //! `R1` con el cliente, no una `R5` (FAQ Veri*factu de la AEAT y art. 15.5 del RD 1619/2012).
    //!
    //! Se comprueba el contenido de cada registro —a qué factura apunta, con qué signo, con qué
    //! cliente, en qué serie y en qué orden— y que la cadena de huellas quede íntegra: los
    //! recuentos solos no habrían cazado que la anulación caía sobre la factura equivocada.

    use super::tests_comunes::*;
    use super::*;
    use tpv_application::ports::tickets::TicketsRepository as _;
    use tpv_domain::verifactu::Destinatario;

    pub(super) const NIF_BAR: &str = "B12345674";
    pub(super) const NIF_CLIENTE: &str = "B87654323";

    /// Dos ventas de barra de 3,00 € al 10 %, sin cobrar todavía.
    pub(super) const DOS_VENTAS: &[&str] = &[
        "UPDATE Business_Settings SET CIF = 'B12345674', Razon_Social = 'Bar de Pruebas SL'
           WHERE ID = 1;",
        "INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre)
           VALUES ('u1', '00000000-0000-7000-8000-000000000001', 'jefe@bar.example', 'x', 'Marta');",
        "INSERT INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('cat', 'Bebidas');",
        "INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta, Stock_Suelto)
           VALUES ('prod', 'cat', 'Cerveza', 300, 10);",
        "INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura, Estado, Total_Comanda)
           VALUES ('com1', 'BARRA', '2027-01-15 12:00:00', 'Abierta', 300);",
        "INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Cantidad, Precio_Unitario, IVA_Percent)
           VALUES ('det1', 'com1', 'prod', 1, 300, 10);",
        "INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura, Estado, Total_Comanda)
           VALUES ('com2', 'BARRA', '2027-01-15 12:05:00', 'Abierta', 300);",
        "INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Cantidad, Precio_Unitario, IVA_Percent)
           VALUES ('det2', 'com2', 'prod', 1, 300, 10);",
    ];

    /// Un registro de facturación, con lo que se comprueba.
    #[derive(Debug, Clone)]
    pub(super) struct Fila {
        pub(super) orden: i64,
        pub(super) tipo: String,
        pub(super) tipo_factura: Option<String>,
        pub(super) num: String,
        pub(super) fecha: String,
        pub(super) importe: Option<String>,
        pub(super) cuota: Option<String>,
        pub(super) destinatario: Option<String>,
        pub(super) referencias: Option<String>,
        pub(super) id_pago: Option<String>,
        pub(super) huella: String,
        pub(super) ant_huella: Option<String>,
        pub(super) cadena: String,
        pub(super) primer_registro: Option<String>,
        pub(super) tipo_rectificativa: Option<String>,
    }

    impl Fila {
        pub(super) fn es(&self, tipo_factura: &str) -> bool {
            self.tipo == "ALTA" && self.tipo_factura.as_deref() == Some(tipo_factura)
        }
        pub(super) fn importe(&self) -> Dinero {
            Dinero::de_texto_fiscal(self.importe.as_deref().unwrap_or("")).expect("importe legible")
        }
        pub(super) fn cuota(&self) -> Dinero {
            Dinero::de_texto_fiscal(self.cuota.as_deref().unwrap_or("")).expect("cuota legible")
        }
        /// Los números que referencia en `clave` (`"sustituidas"` / `"rectificadas"`).
        pub(super) fn refs(&self, clave: &str) -> Vec<(String, String, String)> {
            let Some(j) = self.referencias.as_deref() else { return vec![] };
            let v: serde_json::Value = serde_json::from_str(j).expect("referencias en JSON");
            v.get(clave)
                .and_then(|a| a.as_array())
                .map(|a| {
                    a.iter()
                        .map(|r| {
                            let c = |k: &str| r.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
                            (c("IDEmisorFactura"), c("NumSerieFactura"), c("FechaExpedicionFactura"))
                        })
                        .collect()
                })
                .unwrap_or_default()
        }
        pub(super) fn cliente(&self) -> Option<serde_json::Value> {
            self.destinatario.as_deref().map(|j| serde_json::from_str(j).expect("destinatario en JSON"))
        }
    }

    pub(super) async fn registros(db: &Arc<Db>) -> Vec<Fila> {
        let r = db.read().await;
        let mut rows = r
            .query(
                "SELECT Orden, Tipo, Tipo_Factura, Num_Serie_Factura, Fecha_Expedicion, Importe_Total,
                        Cuota_Total, Destinatario_Json, Referencias_Json, ID_Pago, Huella, Ant_Huella,
                        Cadena_Huella, Primer_Registro, Tipo_Rectificativa
                 FROM Registros_Facturacion ORDER BY Orden ASC;",
                Vec::<Value>::new(),
            )
            .await
            .unwrap();
        let mut out = Vec::new();
        while let Some(row) = rows.next().await.unwrap() {
            let t = |i: i32| crate::mapping::v_string(row.get_value(i).unwrap());
            out.push(Fila {
                orden: crate::mapping::v_i64(row.get_value(0).unwrap()).unwrap(),
                tipo: t(1).unwrap(),
                tipo_factura: t(2),
                num: t(3).unwrap(),
                fecha: t(4).unwrap(),
                importe: t(5),
                cuota: t(6),
                destinatario: t(7),
                referencias: t(8),
                id_pago: t(9),
                huella: t(10).unwrap(),
                ant_huella: t(11),
                cadena: t(12).unwrap(),
                primer_registro: t(13),
                tipo_rectificativa: t(14),
            });
        }
        out
    }

    /// La cadena de huellas, entera: cada huella es el SHA-256 de su cadena, cada registro apunta
    /// a la huella del anterior, el `Orden` no tiene huecos y todo se encola para remitir.
    pub(super) async fn assert_cadena_sana(db: &Arc<Db>) {
        let filas = registros(db).await;
        assert!(!filas.is_empty());
        for (i, f) in filas.iter().enumerate() {
            assert_eq!(f.orden, i as i64 + 1, "el Orden no puede tener huecos: {filas:#?}");
            assert_eq!(
                f.huella,
                tpv_domain::verifactu::huella(&f.cadena),
                "la huella del registro {} no es la de su cadena",
                f.num
            );
            if i == 0 {
                assert_eq!(f.primer_registro.as_deref(), Some("S"));
                assert_eq!(f.ant_huella, None);
            } else {
                assert_eq!(f.primer_registro, None, "sólo el primero es primer registro");
                assert_eq!(
                    f.ant_huella.as_deref(),
                    Some(filas[i - 1].huella.as_str()),
                    "el registro {} ({}) no encadena con el anterior",
                    f.num,
                    f.tipo
                );
            }
        }
        assert_eq!(
            escalar(db, "SELECT COUNT(*) FROM _Verifactu_Envios;").await,
            filas.len() as f64,
            "todo registro se encola para remitir"
        );
        assert_eq!(
            escalar(db, "SELECT COUNT(*) FROM _Verifactu_Anomalias;").await,
            0.0,
            "la comprobación del art. 7.i) no puede encontrar nada raro en la cadena"
        );
    }

    /// Cobra una comanda por el camino real de venta rápida y devuelve `(id_pago, número)`.
    pub(super) async fn cobrar(db: &Arc<Db>, comanda: &str, detalle: &str) -> (String, String) {
        use tpv_application::ports::venta_rapida::VentaRapidaRepository as _;
        let id_pago = crate::util::new_id();
        crate::venta_rapida::SqliteVentaRapidaRepository::new(db.clone())
            .cobrar_fraccionado(tpv_domain::venta_rapida::CobroFraccionado {
                id_pago: id_pago.clone(),
                id_comanda: comanda.into(),
                metodo: "Efectivo".into(),
                importe_total: Dinero::CERO,
                id_usuario_cobrador: Some("u1".into()),
                id_trabajador_cobrador: None,
                detalles: vec![detalle.into()],
                destinatario: None,
            })
            .await
            .expect("el cobro tiene que salir");
        let num = registros(db)
            .await
            .into_iter()
            .find(|f| f.id_pago.as_deref() == Some(id_pago.as_str()))
            .expect("el cobro emite su ticket")
            .num;
        (id_pago, num)
    }

    pub(super) fn cliente() -> Destinatario {
        Destinatario {
            nombre_razon: "Empresa Cliente SL".into(),
            nif: NIF_CLIENTE.into(),
            direccion: Some("Calle Mayor 1, Madrid".into()),
        }
    }

    pub(super) async fn canjear(db: &Arc<Db>, num_ticket: &str) -> tpv_application::error::AppResult<String> {
        crate::verifactu::CanjePorNumero(db.clone())
            .emitir_sustitutiva(num_ticket, cliente())
            .await
            .map(|b| b.num_serie_factura)
    }

    pub(super) async fn dar_de_baja(db: &Arc<Db>, id_pago: &str, clase: ClaseBaja) -> AppResult<bool> {
        SqliteCuentasRepository::new(db.clone())
            .anular_pago(AnularPagoArgs {
                id_pago: id_pago.into(),
                id_usuario: "u1".into(),
                motivo: "prueba".into(),
                clase,
            })
            .await
    }

    /// Un cobro con su ticket canjeado: `(id_pago, número del ticket, número de la F3)`.
    pub(super) async fn ticket_canjeado(db: &Arc<Db>) -> (String, String, String) {
        let (id_pago, ticket) = cobrar(db, "com1", "det1").await;
        let f3 = canjear(db, &ticket).await.expect("el canje tiene que salir");
        (id_pago, ticket, f3)
    }

    pub(super) fn anulaciones(filas: &[Fila]) -> Vec<&Fila> {
        filas.iter().filter(|f| f.tipo == "ANULACION").collect()
    }

    // ── Baja por error ─────────────────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn la_baja_por_error_de_un_ticket_canjeado_anula_el_ticket_Y_su_F3() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, DOS_VENTAS).await;
        let (id_pago, ticket, f3) = ticket_canjeado(&db).await;

        dar_de_baja(&db, &id_pago, ClaseBaja::Error).await.unwrap();

        let filas = registros(&db).await;
        let anuladas: Vec<&str> = anulaciones(&filas).iter().map(|f| f.num.as_str()).collect();
        assert_eq!(anuladas.len(), 2, "{filas:#?}");
        assert!(anuladas.contains(&ticket.as_str()), "el ticket tiene que quedar anulado");
        assert!(anuladas.contains(&f3.as_str()), "y la F3 que lo canjeaba, también");
    }

    #[tokio::test]
    async fn la_F3_se_anula_ANTES_que_el_ticket() {
        // Se deshace en orden inverso al que se expidió.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, DOS_VENTAS).await;
        let (id_pago, ticket, f3) = ticket_canjeado(&db).await;

        dar_de_baja(&db, &id_pago, ClaseBaja::Error).await.unwrap();

        let filas = registros(&db).await;
        let anul = anulaciones(&filas);
        assert_eq!(anul[0].num, f3);
        assert_eq!(anul[1].num, ticket);
    }

    #[tokio::test]
    async fn cada_anulacion_lleva_la_fecha_de_expedicion_de_SU_factura() {
        // El `IDFactura` de una anulación es emisor + número + fecha de la factura anulada. Con la
        // fecha de otra, la AEAT no encontraría qué anular.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, DOS_VENTAS).await;
        let (id_pago, _, _) = ticket_canjeado(&db).await;

        dar_de_baja(&db, &id_pago, ClaseBaja::Error).await.unwrap();

        let filas = registros(&db).await;
        for a in anulaciones(&filas) {
            let alta = filas
                .iter()
                .find(|f| f.tipo == "ALTA" && f.num == a.num)
                .expect("la anulación apunta a un alta que existe");
            assert_eq!(a.fecha, alta.fecha, "anulación de {}", a.num);
        }
    }

    #[tokio::test]
    async fn la_baja_por_error_de_un_ticket_canjeado_NO_emite_rectificativas_ni_F3_nuevas() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, DOS_VENTAS).await;
        let (id_pago, _, _) = ticket_canjeado(&db).await;

        dar_de_baja(&db, &id_pago, ClaseBaja::Error).await.unwrap();

        let filas = registros(&db).await;
        assert_eq!(filas.iter().filter(|f| f.es("R5")).count(), 0);
        assert_eq!(filas.iter().filter(|f| f.es("F3")).count(), 1, "sólo la del canje");
        assert_eq!(filas.iter().filter(|f| f.tipo == "ALTA").count(), 2, "las altas no se tocan");
    }

    #[tokio::test]
    async fn la_baja_por_error_sin_canje_anula_solo_el_ticket() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, DOS_VENTAS).await;
        let (id_pago, ticket) = cobrar(&db, "com1", "det1").await;

        dar_de_baja(&db, &id_pago, ClaseBaja::Error).await.unwrap();

        let filas = registros(&db).await;
        let anul = anulaciones(&filas);
        assert_eq!(anul.len(), 1);
        assert_eq!(anul[0].num, ticket);
    }

    // ── Devolución ─────────────────────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn la_devolucion_de_un_ticket_canjeado_rectifica_el_TICKET_y_no_la_F3() {
        // La F3 no es rectificativa (art. 15.6 ROF) y lo declarado a efectos del IVA es el ticket:
        // la R5 rectifica la simplificada original (FAQ, apartado 27, casos 2 y 3).
        let (db, _dir) = db_temporal().await;
        sembrar(&db, DOS_VENTAS).await;
        let (id_pago, ticket, f3) = ticket_canjeado(&db).await;

        dar_de_baja(&db, &id_pago, ClaseBaja::Devolucion).await.unwrap();

        let filas = registros(&db).await;
        let r5: Vec<&Fila> = filas.iter().filter(|f| f.es("R5")).collect();
        assert_eq!(r5.len(), 1, "{filas:#?}");
        let alta_ticket = filas.iter().find(|f| f.es("F2")).unwrap();
        assert_eq!(
            r5[0].refs("rectificadas"),
            vec![(NIF_BAR.to_string(), ticket.clone(), alta_ticket.fecha.clone())]
        );
        assert!(
            !r5[0].refs("rectificadas").iter().any(|(_, n, _)| *n == f3),
            "la R5 no puede rectificar la F3"
        );
        assert_eq!(r5[0].cliente(), None, "una R5 no lleva destinatario (error 1190)");
        assert_eq!(r5[0].importe(), Dinero::de_centimos(-300));
        assert_eq!(r5[0].cuota(), Dinero::de_centimos(-27));
        assert!(r5[0].num.starts_with('R'), "la R5 va en la serie de rectificativas: {}", r5[0].num);
    }

    #[tokio::test]
    async fn tras_la_R5_se_emite_una_F3_negativa_con_el_cliente_que_sustituye_a_la_R5() {
        // FAQ, apartado 27, casos 2 y 3: «debe emitirse nueva F3 con los mismos datos de R5».
        let (db, _dir) = db_temporal().await;
        sembrar(&db, DOS_VENTAS).await;
        let (id_pago, ticket, f3) = ticket_canjeado(&db).await;

        dar_de_baja(&db, &id_pago, ClaseBaja::Devolucion).await.unwrap();

        let filas = registros(&db).await;
        let r5 = filas.iter().find(|f| f.es("R5")).unwrap();
        let f3s: Vec<&Fila> = filas.iter().filter(|f| f.es("F3")).collect();
        assert_eq!(f3s.len(), 2, "la del canje y la de la devolución: {filas:#?}");
        let nueva = f3s.iter().find(|f| f.num != f3).unwrap();

        assert!(nueva.orden > r5.orden, "la F3 va DESPUÉS de la R5 que sustituye");
        assert_eq!(nueva.refs("sustituidas"), vec![(NIF_BAR.to_string(), r5.num.clone(), r5.fecha.clone())]);
        assert!(nueva.refs("rectificadas").is_empty(), "una F3 no rectifica (error 1117)");
        assert!(
            !nueva.refs("sustituidas").iter().any(|(_, n, _)| *n == ticket),
            "sustituye a la R5, no otra vez al ticket"
        );
        assert_eq!(nueva.importe(), r5.importe(), "los mismos datos que la R5");
        assert_eq!(nueva.cuota(), r5.cuota());
        assert_eq!(nueva.id_pago.as_deref(), Some(id_pago.as_str()));

        let c = nueva.cliente().expect("una F3 siempre lleva destinatario");
        assert_eq!(c["NIF"], NIF_CLIENTE);
        assert_eq!(c["NombreRazon"], "Empresa Cliente SL");
        assert_eq!(c["Domicilio"], "Calle Mayor 1, Madrid", "el papel de la F3 necesita el domicilio");
        assert!(!nueva.num.starts_with('R'), "una F3 va en la serie ordinaria (art. 15.6 ROF): {}", nueva.num);
    }

    #[tokio::test]
    async fn con_la_devolucion_todo_queda_a_cero() {
        // Ticket + R5 = 0 (lo que cuenta para el IVA) y F3 + F3 negativa = 0 (lo que puede deducir
        // el cliente). Si cualquiera de las dos sumas no diera cero, alguien declararía o deduciría
        // un IVA de una venta devuelta.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, DOS_VENTAS).await;
        let (id_pago, _, _) = ticket_canjeado(&db).await;

        dar_de_baja(&db, &id_pago, ClaseBaja::Devolucion).await.unwrap();

        let filas = registros(&db).await;
        let suma = |tipos: &[&str], f: fn(&Fila) -> Dinero| -> Dinero {
            filas.iter().filter(|x| tipos.iter().any(|t| x.es(t))).map(f).sum()
        };
        assert_eq!(suma(&["F2", "R5"], Fila::importe), Dinero::CERO);
        assert_eq!(suma(&["F2", "R5"], Fila::cuota), Dinero::CERO);
        assert_eq!(suma(&["F3"], Fila::importe), Dinero::CERO);
        assert_eq!(suma(&["F3"], Fila::cuota), Dinero::CERO);
    }

    #[tokio::test]
    async fn la_devolucion_de_un_ticket_canjeado_NO_anula_nada() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, DOS_VENTAS).await;
        let (id_pago, _, _) = ticket_canjeado(&db).await;

        dar_de_baja(&db, &id_pago, ClaseBaja::Devolucion).await.unwrap();

        assert!(anulaciones(&registros(&db).await).is_empty(), "la operación existió");
    }

    #[tokio::test]
    async fn la_devolucion_sin_canje_NO_emite_ninguna_F3() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, DOS_VENTAS).await;
        let (id_pago, ticket) = cobrar(&db, "com1", "det1").await;

        dar_de_baja(&db, &id_pago, ClaseBaja::Devolucion).await.unwrap();

        let filas = registros(&db).await;
        assert_eq!(filas.iter().filter(|f| f.es("F3")).count(), 0);
        let r5 = filas.iter().find(|f| f.es("R5")).unwrap();
        assert_eq!(r5.refs("rectificadas")[0].1, ticket);
    }

    // ── La cadena y los demás cobros ───────────────────────────────────────────────────────────

    #[tokio::test]
    async fn la_cadena_queda_sana_tras_canjear_y_anular() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, DOS_VENTAS).await;
        let (id_pago, _, _) = ticket_canjeado(&db).await;
        dar_de_baja(&db, &id_pago, ClaseBaja::Error).await.unwrap();
        assert_cadena_sana(&db).await;
    }

    #[tokio::test]
    async fn la_cadena_queda_sana_tras_canjear_y_devolver() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, DOS_VENTAS).await;
        let (id_pago, _, _) = ticket_canjeado(&db).await;
        dar_de_baja(&db, &id_pago, ClaseBaja::Devolucion).await.unwrap();
        assert_cadena_sana(&db).await;
    }

    #[tokio::test]
    async fn la_baja_de_un_cobro_no_toca_las_facturas_de_otro() {
        // Dos cobros canjeados; se dan de baja uno por error y otro por devolución. Cada registro
        // nuevo tiene que apuntar a las facturas de SU cobro.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, DOS_VENTAS).await;
        let (pago1, ticket1) = cobrar(&db, "com1", "det1").await;
        let (pago2, ticket2) = cobrar(&db, "com2", "det2").await;
        let f3_1 = canjear(&db, &ticket1).await.unwrap();
        let f3_2 = canjear(&db, &ticket2).await.unwrap();

        dar_de_baja(&db, &pago1, ClaseBaja::Error).await.unwrap();
        dar_de_baja(&db, &pago2, ClaseBaja::Devolucion).await.unwrap();

        let filas = registros(&db).await;
        let anuladas: Vec<&str> = anulaciones(&filas).iter().map(|f| f.num.as_str()).collect();
        assert_eq!(anuladas.len(), 2);
        assert!(anuladas.contains(&ticket1.as_str()) && anuladas.contains(&f3_1.as_str()));
        assert!(!anuladas.contains(&ticket2.as_str()) && !anuladas.contains(&f3_2.as_str()));

        let r5 = filas.iter().find(|f| f.es("R5")).unwrap();
        assert_eq!(r5.refs("rectificadas")[0].1, ticket2);
        assert_eq!(r5.id_pago.as_deref(), Some(pago2.as_str()));
        assert_cadena_sana(&db).await;
    }

    #[tokio::test]
    async fn dar_de_baja_dos_veces_no_emite_mas_registros() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, DOS_VENTAS).await;
        let (id_pago, _, _) = ticket_canjeado(&db).await;
        dar_de_baja(&db, &id_pago, ClaseBaja::Devolucion).await.unwrap();
        let antes = registros(&db).await.len();

        let _ = dar_de_baja(&db, &id_pago, ClaseBaja::Devolucion).await;
        let _ = dar_de_baja(&db, &id_pago, ClaseBaja::Error).await;

        assert_eq!(registros(&db).await.len(), antes, "un cobro dado de baja no se da de baja otra vez");
    }

    // ── El canje de un ticket que ya no cuenta ─────────────────────────────────────────────────

    #[tokio::test]
    async fn NO_se_puede_canjear_un_ticket_anulado() {
        // Un ticket anulado no tiene efecto fiscal: no hay venta que facturar al cliente.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, DOS_VENTAS).await;
        let (id_pago, ticket) = cobrar(&db, "com1", "det1").await;
        dar_de_baja(&db, &id_pago, ClaseBaja::Error).await.unwrap();
        let antes = registros(&db).await.len();

        let e = canjear(&db, &ticket).await.unwrap_err();

        assert!(format!("{e:?}").contains("anulado"), "{e:?}");
        assert_eq!(registros(&db).await.len(), antes, "no se emite nada ni se gasta número");
    }

    #[tokio::test]
    async fn NO_se_puede_canjear_un_ticket_devuelto() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, DOS_VENTAS).await;
        let (id_pago, ticket) = cobrar(&db, "com1", "det1").await;
        dar_de_baja(&db, &id_pago, ClaseBaja::Devolucion).await.unwrap();
        let antes = registros(&db).await.len();

        let e = canjear(&db, &ticket).await.unwrap_err();

        assert!(format!("{e:?}").contains("devolvió"), "{e:?}");
        assert_eq!(registros(&db).await.len(), antes);
    }

    #[tokio::test]
    async fn el_numero_de_OTRA_rectificativa_no_bloquea_el_canje() {
        // `2027/000001` es subcadena de `R2027/000001`. Se comparaba con `LIKE '%número%'`, así que
        // la F3 negativa de la devolución de otro ticket (que sustituye a `R…/000001`) hacía creer
        // que el ticket 000001 ya estaba canjeado.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, DOS_VENTAS).await;
        let (_, ticket1) = cobrar(&db, "com1", "det1").await;
        let (pago2, ticket2) = cobrar(&db, "com2", "det2").await;
        canjear(&db, &ticket2).await.unwrap();
        dar_de_baja(&db, &pago2, ClaseBaja::Devolucion).await.unwrap();

        let r5 = registros(&db).await.into_iter().find(|f| f.es("R5")).unwrap();
        assert!(r5.num.ends_with(&ticket1[ticket1.find('/').unwrap()..]), "el caso de prueba exige que el número de la R5 contenga el del ticket 1: {} / {}", r5.num, ticket1);

        canjear(&db, &ticket1).await.expect("el ticket 1 nunca se canjeó");
    }

    #[tokio::test]
    async fn un_ticket_canjeado_no_se_canjea_otra_vez() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, DOS_VENTAS).await;
        let (_, ticket, _) = ticket_canjeado(&db).await;

        let e = canjear(&db, &ticket).await.unwrap_err();
        assert!(format!("{e:?}").contains("ya se emitió"), "{e:?}");
    }

    // ── Devolución de una factura completa (F1) ────────────────────────────────────────────────

    /// Cobra con factura completa (`F1`, con el cliente) y devuelve `(id_pago, número)`.
    pub(super) async fn cobrar_con_factura(db: &Arc<Db>, comanda: &str, detalle: &str) -> (String, String) {
        use tpv_application::ports::venta_rapida::VentaRapidaRepository as _;
        let id_pago = crate::util::new_id();
        crate::venta_rapida::SqliteVentaRapidaRepository::new(db.clone())
            .cobrar_fraccionado(tpv_domain::venta_rapida::CobroFraccionado {
                id_pago: id_pago.clone(),
                id_comanda: comanda.into(),
                metodo: "Tarjeta".into(),
                importe_total: Dinero::CERO,
                id_usuario_cobrador: Some("u1".into()),
                id_trabajador_cobrador: None,
                detalles: vec![detalle.into()],
                destinatario: Some(cliente()),
            })
            .await
            .expect("el cobro con factura tiene que salir");
        let f1 = registros(db)
            .await
            .into_iter()
            .find(|f| f.id_pago.as_deref() == Some(id_pago.as_str()))
            .expect("el cobro emite su factura");
        assert!(f1.es("F1"), "con cliente, el cobro emite una F1: {f1:?}");
        (id_pago, f1.num)
    }

    #[tokio::test]
    async fn devolver_una_F1_emite_una_R1_y_NO_una_R5() {
        // La R5 es sólo para simplificadas; una devolución sobre una completa es art. 80.Dos LIVA,
        // que la AEAT encuadra en R1.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, DOS_VENTAS).await;
        let (id_pago, f1) = cobrar_con_factura(&db, "com1", "det1").await;

        dar_de_baja(&db, &id_pago, ClaseBaja::Devolucion).await.unwrap();

        let filas = registros(&db).await;
        assert_eq!(filas.iter().filter(|f| f.es("R5")).count(), 0, "{filas:#?}");
        let r1: Vec<&Fila> = filas.iter().filter(|f| f.es("R1")).collect();
        assert_eq!(r1.len(), 1);
        let r1 = r1[0];
        let alta_f1 = filas.iter().find(|f| f.es("F1")).unwrap();
        assert_eq!(r1.refs("rectificadas"), vec![(NIF_BAR.to_string(), f1, alta_f1.fecha.clone())]);
        assert_eq!(r1.tipo_rectificativa.as_deref(), Some("I"), "por diferencias");
        assert_eq!(r1.importe(), Dinero::de_centimos(-300));
        assert_eq!(r1.cuota(), Dinero::de_centimos(-27));
        assert!(r1.num.starts_with('R'), "va en la serie de rectificativas: {}", r1.num);
        assert_eq!(r1.id_pago.as_deref(), Some(id_pago.as_str()));
    }

    #[tokio::test]
    async fn la_R1_lleva_el_cliente_de_la_F1() {
        // Una rectificativa de una completa cumple el art. 6 del RD 1619/2012 (art. 15.5): nombre,
        // NIF y domicilio del destinatario. En el registro, sin él la AEAT rechaza (error 1189).
        let (db, _dir) = db_temporal().await;
        sembrar(&db, DOS_VENTAS).await;
        let (id_pago, _) = cobrar_con_factura(&db, "com1", "det1").await;

        dar_de_baja(&db, &id_pago, ClaseBaja::Devolucion).await.unwrap();

        let filas = registros(&db).await;
        let c = filas.iter().find(|f| f.es("R1")).unwrap().cliente().expect("la R1 lleva cliente");
        assert_eq!(c["NIF"], NIF_CLIENTE);
        assert_eq!(c["NombreRazon"], "Empresa Cliente SL");
        assert_eq!(c["Domicilio"], "Calle Mayor 1, Madrid");
    }

    #[tokio::test]
    async fn devolver_una_F1_la_deja_a_cero_sin_anular_ni_emitir_F3() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, DOS_VENTAS).await;
        let (id_pago, _) = cobrar_con_factura(&db, "com1", "det1").await;

        dar_de_baja(&db, &id_pago, ClaseBaja::Devolucion).await.unwrap();

        let filas = registros(&db).await;
        assert!(anulaciones(&filas).is_empty());
        assert_eq!(filas.iter().filter(|f| f.es("F3")).count(), 0);
        let suma: Dinero = filas.iter().filter(|f| f.es("F1") || f.es("R1")).map(Fila::importe).sum();
        assert_eq!(suma, Dinero::CERO);
        let cuota: Dinero = filas.iter().filter(|f| f.es("F1") || f.es("R1")).map(Fila::cuota).sum();
        assert_eq!(cuota, Dinero::CERO);
        assert_cadena_sana(&db).await;
    }

    #[tokio::test]
    async fn anular_por_error_una_F1_la_anula_sin_rectificativa() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, DOS_VENTAS).await;
        let (id_pago, f1) = cobrar_con_factura(&db, "com1", "det1").await;

        dar_de_baja(&db, &id_pago, ClaseBaja::Error).await.unwrap();

        let filas = registros(&db).await;
        let anul = anulaciones(&filas);
        assert_eq!(anul.len(), 1);
        assert_eq!(anul[0].num, f1);
        assert!(!filas.iter().any(|f| f.es("R1") || f.es("R5")));
        assert_cadena_sana(&db).await;
    }

    #[tokio::test]
    async fn la_R5_de_un_ticket_sigue_sin_cliente_y_la_R1_de_una_F1_lo_lleva_en_el_mismo_libro() {
        // Las dos claves conviven: un ticket y una factura completa devueltos el mismo día.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, DOS_VENTAS).await;
        let (pago_ticket, _) = cobrar(&db, "com1", "det1").await;
        let (pago_f1, _) = cobrar_con_factura(&db, "com2", "det2").await;

        dar_de_baja(&db, &pago_ticket, ClaseBaja::Devolucion).await.unwrap();
        dar_de_baja(&db, &pago_f1, ClaseBaja::Devolucion).await.unwrap();

        let filas = registros(&db).await;
        let r5 = filas.iter().find(|f| f.es("R5")).unwrap();
        let r1 = filas.iter().find(|f| f.es("R1")).unwrap();
        assert_eq!(r5.id_pago.as_deref(), Some(pago_ticket.as_str()));
        assert_eq!(r5.cliente(), None);
        assert_eq!(r1.id_pago.as_deref(), Some(pago_f1.as_str()));
        assert!(r1.cliente().is_some());
        assert_ne!(r5.num, r1.num, "la serie de rectificativas no repite número");
        assert_cadena_sana(&db).await;
    }

    // ── El papel ───────────────────────────────────────────────────────────────────────────────

    //
    // El papel se compone por el caso de uso real (`ticket_de_pago`), con los ajustes de la base:
    // lo que se comprueba es el payload que va a la impresora.

    pub(super) async fn papel(
        db: &Arc<Db>,
        id_pago: &str,
        num_factura: Option<&str>,
    ) -> tpv_contracts::impresion::PrintTicketPayload {
        let tickets = crate::tickets::SqliteTicketsRepository::new(db.clone());
        let config = crate::configuracion::SqliteConfiguracionRepository::new(db.clone());
        tpv_application::use_cases::tickets::ticket_de_pago(
            &tickets,
            &config,
            &tpv_contracts::impresion::TicketDePagoInput {
                id_pago: id_pago.into(),
                es_copia: false,
                num_factura: num_factura.map(str::to_string),
            },
        )
        .await
        .expect("el papel tiene que poder componerse")
    }

    pub(super) fn suma_lineas(p: &tpv_contracts::impresion::PrintTicketPayload) -> Dinero {
        p.items.iter().map(|l| l.precio_unitario.por(l.cantidad as i64)).sum()
    }

    #[tokio::test]
    async fn tras_la_devolucion_el_cobro_ofrece_sus_cuatro_facturas_en_orden() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, DOS_VENTAS).await;
        let (id_pago, ticket, f3) = ticket_canjeado(&db).await;
        dar_de_baja(&db, &id_pago, ClaseBaja::Devolucion).await.unwrap();

        let p = papel(&db, &id_pago, None).await;
        let facturas: Vec<(&str, i64)> = p
            .facturas_del_cobro
            .iter()
            .map(|f| (f.tipo_factura.as_str(), f.importe.centimos()))
            .collect();
        assert_eq!(facturas, [("F2", 300), ("F3", 300), ("R5", -300), ("F3", -300)]);
        assert_eq!(p.facturas_del_cobro[0].num_serie, ticket);
        assert_eq!(p.facturas_del_cobro[1].num_serie, f3);
    }

    #[tokio::test]
    async fn el_papel_de_la_R5_dice_que_rectifica_y_sus_lineas_cuadran_en_negativo() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, DOS_VENTAS).await;
        let (id_pago, ticket) = cobrar(&db, "com1", "det1").await;
        dar_de_baja(&db, &id_pago, ClaseBaja::Devolucion).await.unwrap();
        let filas = registros(&db).await;
        let r5 = filas.iter().find(|f| f.es("R5")).unwrap();
        let alta = filas.iter().find(|f| f.es("F2")).unwrap();

        let p = papel(&db, &id_pago, Some(&r5.num)).await;

        assert_eq!(p.numero_ticket.as_deref(), Some(r5.num.as_str()));
        assert_eq!(p.tipo_factura.as_deref(), Some("R5"));
        assert_eq!(p.rectifica.as_deref(), Some(ticket.as_str()));
        assert_eq!(p.rectifica_fecha, Some(alta.fecha.replace('-', "/")));
        assert_eq!(p.total, Some(Dinero::de_centimos(-300)));
        assert_eq!(Some(suma_lineas(&p)), p.total, "las líneas en negativo cuadran con el total");
        assert!(p.qr_url.as_deref().is_some_and(|u| u.contains("importe=-3.00")), "{:?}", p.qr_url);
        assert_eq!(p.metodo_pago, None, "una devolución no abre el cajón");
        assert!(!p.es_anulado, "el papel de la baja no se marca ANULADO");
        assert!(p.destinatario.is_none());
    }

    #[tokio::test]
    async fn el_papel_de_la_F3_negativa_lleva_el_cliente_y_sustituye_a_la_R5() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, DOS_VENTAS).await;
        let (id_pago, _, f3) = ticket_canjeado(&db).await;
        dar_de_baja(&db, &id_pago, ClaseBaja::Devolucion).await.unwrap();
        let filas = registros(&db).await;
        let r5 = filas.iter().find(|f| f.es("R5")).unwrap();
        let negativa = filas.iter().rfind(|f| f.es("F3")).unwrap();
        assert_ne!(negativa.num, f3);

        let p = papel(&db, &id_pago, Some(&negativa.num)).await;

        assert_eq!(p.tipo_factura.as_deref(), Some("F3"));
        assert_eq!(p.sustituye, vec![r5.num.clone()]);
        assert_eq!(p.destinatario.as_ref().map(|d| d.nif.as_str()), Some(NIF_CLIENTE));
        assert_eq!(p.total, Some(Dinero::de_centimos(-300)));
        assert_eq!(Some(suma_lineas(&p)), p.total);
    }

    #[tokio::test]
    async fn el_papel_de_la_R1_lleva_el_cliente_y_la_F1_que_rectifica() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, DOS_VENTAS).await;
        let (id_pago, f1) = cobrar_con_factura(&db, "com1", "det1").await;
        dar_de_baja(&db, &id_pago, ClaseBaja::Devolucion).await.unwrap();
        let r1 = registros(&db).await.into_iter().find(|f| f.es("R1")).unwrap();

        let p = papel(&db, &id_pago, Some(&r1.num)).await;

        assert_eq!(p.tipo_factura.as_deref(), Some("R1"));
        assert_eq!(p.rectifica.as_deref(), Some(f1.as_str()));
        let d = p.destinatario.expect("la R1 lleva el cliente");
        assert_eq!(d.nif, NIF_CLIENTE);
        assert_eq!(d.domicilio.as_deref(), Some("Calle Mayor 1, Madrid"));
    }

    #[tokio::test]
    async fn la_copia_del_ticket_devuelto_sale_ANULADO_y_en_positivo() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, DOS_VENTAS).await;
        let (id_pago, ticket) = cobrar(&db, "com1", "det1").await;
        dar_de_baja(&db, &id_pago, ClaseBaja::Devolucion).await.unwrap();

        let p = papel(&db, &id_pago, None).await;

        assert_eq!(p.numero_ticket.as_deref(), Some(ticket.as_str()));
        assert!(p.es_anulado);
        assert_eq!(p.total, Some(Dinero::de_centimos(300)));
        assert_eq!(Some(suma_lineas(&p)), p.total);
    }

    #[tokio::test]
    async fn la_rectificativa_de_otro_cobro_no_se_imprime_con_estas_lineas() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, DOS_VENTAS).await;
        let (pago1, _) = cobrar(&db, "com1", "det1").await;
        let (pago2, _) = cobrar(&db, "com2", "det2").await;
        dar_de_baja(&db, &pago2, ClaseBaja::Devolucion).await.unwrap();
        let r5 = registros(&db).await.into_iter().find(|f| f.es("R5")).unwrap();

        let tickets = crate::tickets::SqliteTicketsRepository::new(db.clone());
        assert!(tickets.ticket_de_pago(&pago1, Some(&r5.num)).await.is_err());
    }
}

#[cfg(test)]
#[allow(non_snake_case)]
mod tests_correccion_y_canje_multiple {
    //! Corregir el cliente de una factura completa (`F3` y `F1`) y canjear varios tickets en una
    //! sola `F3`, con lo que eso implica después para las bajas.
    //!
    //! - Corregir una `F3` (FAQ de desarrolladores de la AEAT, apartado 27, caso 1): una F3 negativa
    //!   que contrarresta la errónea y una F3 nueva con los datos buenos; el ticket no se toca.
    //! - Corregir una `F1`: una rectificativa `R4` por sustitución con `ImporteRectificacion` (FAQ del
    //!   SII 2.7 y 2.8).
    //! - Varios tickets en una `F3` (apartado 27, punto 1): desglose = suma de los declarados.

    use super::tests_baja_de_un_ticket_canjeado::*;
    use super::tests_comunes::*;
    use super::*;
    use tpv_application::ports::verifactu::VerifactuRepository as _;
    use tpv_domain::verifactu::Destinatario;

    const NIF_NUEVO: &str = "A58818501";

    fn cliente_nuevo() -> Destinatario {
        Destinatario {
            nombre_razon: "Cliente Correcto SA".into(),
            nif: NIF_NUEVO.into(),
            direccion: Some("Plaza Nueva 3, Sevilla".into()),
        }
    }

    fn repo(db: &Arc<Db>) -> crate::verifactu::SqliteVerifactuRepository {
        crate::verifactu::SqliteVerifactuRepository::new(db.clone())
    }

    async fn corregir(db: &Arc<Db>, num: &str) -> AppResult<String> {
        repo(db).corregir_factura(num, cliente_nuevo()).await.map(|b| b.num_serie_factura)
    }

    async fn canjear_cobros(db: &Arc<Db>, pagos: &[&str]) -> AppResult<String> {
        let ids: Vec<String> = pagos.iter().map(|s| s.to_string()).collect();
        repo(db).emitir_sustitutiva(&ids, cliente()).await.map(|b| b.num_serie_factura)
    }

    fn fila<'a>(filas: &'a [Fila], num: &str) -> &'a Fila {
        filas.iter().find(|f| f.tipo == "ALTA" && f.num == num).expect("la factura existe")
    }

    fn nums(refs: Vec<(String, String, String)>) -> Vec<String> {
        refs.into_iter().map(|(_, n, _)| n).collect()
    }

    // ── Corregir una F3 ────────────────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn corregir_una_F3_emite_una_negativa_igual_y_una_nueva_con_el_cliente_bueno() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, DOS_VENTAS).await;
        let (_, ticket, f3) = ticket_canjeado(&db).await;

        let nueva = corregir(&db, &f3).await.unwrap();

        let filas = registros(&db).await;
        let f3s: Vec<&Fila> = filas.iter().filter(|f| f.es("F3")).collect();
        assert_eq!(f3s.len(), 3, "{filas:#?}");
        let negativa = f3s[1];
        assert_eq!(negativa.importe(), Dinero::de_centimos(-300));
        assert_eq!(negativa.cuota(), Dinero::de_centimos(-27));
        assert_eq!(nums(negativa.refs("sustituidas")), vec![ticket.clone()], "sustituye al mismo ticket");
        assert_eq!(negativa.cliente().unwrap()["NIF"], NIF_CLIENTE, "es la errónea en negativo");

        let n = fila(&filas, &nueva);
        assert_eq!(n.importe(), Dinero::de_centimos(300));
        assert_eq!(nums(n.refs("sustituidas")), vec![ticket]);
        let c = n.cliente().unwrap();
        assert_eq!(c["NIF"], NIF_NUEVO);
        assert_eq!(c["Domicilio"], "Plaza Nueva 3, Sevilla");
        assert!(n.orden > negativa.orden, "primero se contrarresta, luego se emite la buena");

        assert!(!filas.iter().any(|f| f.es("R5") || f.es("R4")), "el ticket no se rectifica");
        assert!(anulaciones(&filas).is_empty());
        assert_cadena_sana(&db).await;
    }

    #[tokio::test]
    async fn la_F3_corregida_ya_no_es_la_vigente_y_no_se_corrige_otra_vez() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, DOS_VENTAS).await;
        let (_, _, f3) = ticket_canjeado(&db).await;
        let nueva = corregir(&db, &f3).await.unwrap();

        let e = corregir(&db, &f3).await.unwrap_err();
        assert!(format!("{e:?}").contains("vigente"), "{e:?}");
        // La nueva sí se puede volver a corregir.
        corregir(&db, &nueva).await.expect("la vigente se corrige");
        assert_cadena_sana(&db).await;
    }

    #[tokio::test]
    async fn tras_corregir_el_ticket_sigue_canjeado() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, DOS_VENTAS).await;
        let (_, ticket, f3) = ticket_canjeado(&db).await;
        corregir(&db, &f3).await.unwrap();

        let e = canjear(&db, &ticket).await.unwrap_err();
        assert!(format!("{e:?}").contains("ya se emitió"), "{e:?}");
    }

    #[tokio::test]
    async fn la_devolucion_tras_corregir_lleva_el_cliente_BUENO() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, DOS_VENTAS).await;
        let (id_pago, ticket, f3) = ticket_canjeado(&db).await;
        corregir(&db, &f3).await.unwrap();

        dar_de_baja(&db, &id_pago, ClaseBaja::Devolucion).await.unwrap();

        let filas = registros(&db).await;
        let r5 = filas.iter().find(|f| f.es("R5")).unwrap();
        assert_eq!(nums(r5.refs("rectificadas")), vec![ticket]);
        let de_la_devolucion = filas.iter().rfind(|f| f.es("F3")).unwrap();
        assert_eq!(nums(de_la_devolucion.refs("sustituidas")), vec![r5.num.clone()]);
        assert_eq!(de_la_devolucion.cliente().unwrap()["NIF"], NIF_NUEVO);
        assert_cadena_sana(&db).await;
    }

    #[tokio::test]
    async fn la_baja_por_error_tras_corregir_anula_el_ticket_y_la_F3_VIGENTE() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, DOS_VENTAS).await;
        let (id_pago, ticket, f3) = ticket_canjeado(&db).await;
        let nueva = corregir(&db, &f3).await.unwrap();

        dar_de_baja(&db, &id_pago, ClaseBaja::Error).await.unwrap();

        let filas = registros(&db).await;
        let mut anuladas: Vec<String> = anulaciones(&filas).iter().map(|f| f.num.clone()).collect();
        anuladas.sort();
        let mut esperadas = vec![ticket, nueva];
        esperadas.sort();
        assert_eq!(anuladas, esperadas, "la errónea y su negativa ya se compensan entre sí");
        assert_cadena_sana(&db).await;
    }

    #[tokio::test]
    async fn NO_se_corrige_la_F3_de_un_ticket_devuelto_ni_anulado() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, DOS_VENTAS).await;
        let (pago1, _, f3_1) = ticket_canjeado(&db).await;
        dar_de_baja(&db, &pago1, ClaseBaja::Devolucion).await.unwrap();
        assert!(corregir(&db, &f3_1).await.is_err());

        let (pago2, ticket2) = cobrar(&db, "com2", "det2").await;
        let f3_2 = canjear(&db, &ticket2).await.unwrap();
        dar_de_baja(&db, &pago2, ClaseBaja::Error).await.unwrap();
        assert!(corregir(&db, &f3_2).await.is_err());
    }

    // ── Corregir una F1 ────────────────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn corregir_una_F1_emite_una_R4_por_sustitucion_con_su_importe_rectificado() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, DOS_VENTAS).await;
        let (_, f1) = cobrar_con_factura(&db, "com1", "det1").await;

        let r4 = corregir(&db, &f1).await.unwrap();

        let filas = registros(&db).await;
        let r = fila(&filas, &r4);
        assert!(r.es("R4"), "{r:?}");
        assert_eq!(r.tipo_rectificativa.as_deref(), Some("S"));
        assert!(r.num.starts_with('R'), "serie de rectificativas: {}", r.num);
        let alta_f1 = fila(&filas, &f1);
        assert_eq!(r.refs("rectificadas"), vec![(NIF_BAR.to_string(), f1.clone(), alta_f1.fecha.clone())]);
        // Por sustitución: los importes son los correctos (los mismos) y el ImporteRectificacion
        // dice qué base y qué cuota deja de valer.
        assert_eq!(r.importe(), Dinero::de_centimos(300));
        assert_eq!(r.cuota(), Dinero::de_centimos(27));
        let v: serde_json::Value = serde_json::from_str(r.referencias.as_deref().unwrap()).unwrap();
        assert_eq!(v["importe_rectificacion"]["BaseRectificada"], "2.73");
        assert_eq!(v["importe_rectificacion"]["CuotaRectificada"], "0.27");
        assert_eq!(r.cliente().unwrap()["NIF"], NIF_NUEVO);
        assert!(anulaciones(&filas).is_empty());
        assert_cadena_sana(&db).await;
    }

    #[tokio::test]
    async fn corregir_otra_vez_rectifica_la_R4_vigente_y_no_la_F1() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, DOS_VENTAS).await;
        let (_, f1) = cobrar_con_factura(&db, "com1", "det1").await;
        let r4 = corregir(&db, &f1).await.unwrap();

        assert!(corregir(&db, &f1).await.is_err(), "la F1 ya no es la vigente");
        let r4b = corregir(&db, &r4).await.expect("la vigente sí");

        let filas = registros(&db).await;
        assert_eq!(nums(fila(&filas, &r4b).refs("rectificadas")), vec![r4]);
    }

    #[tokio::test]
    async fn la_devolucion_de_una_F1_corregida_rectifica_la_vigente_con_el_cliente_bueno() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, DOS_VENTAS).await;
        let (id_pago, f1) = cobrar_con_factura(&db, "com1", "det1").await;
        let r4 = corregir(&db, &f1).await.unwrap();

        dar_de_baja(&db, &id_pago, ClaseBaja::Devolucion).await.unwrap();

        let filas = registros(&db).await;
        let r1 = filas.iter().find(|f| f.es("R1")).unwrap();
        assert_eq!(nums(r1.refs("rectificadas")), vec![r4]);
        assert_eq!(r1.cliente().unwrap()["NIF"], NIF_NUEVO);
        assert_eq!(r1.importe(), Dinero::de_centimos(-300));
        assert_cadena_sana(&db).await;
    }

    #[tokio::test]
    async fn la_baja_por_error_de_una_F1_corregida_anula_la_R4_y_la_F1() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, DOS_VENTAS).await;
        let (id_pago, f1) = cobrar_con_factura(&db, "com1", "det1").await;
        let r4 = corregir(&db, &f1).await.unwrap();

        dar_de_baja(&db, &id_pago, ClaseBaja::Error).await.unwrap();

        let filas = registros(&db).await;
        let anul = anulaciones(&filas);
        assert_eq!(anul.len(), 2);
        assert_eq!(anul[0].num, r4, "la sustitutiva primero");
        assert_eq!(anul[1].num, f1);
        assert_cadena_sana(&db).await;
    }

    #[tokio::test]
    async fn NO_se_corrige_una_F1_devuelta() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, DOS_VENTAS).await;
        let (id_pago, f1) = cobrar_con_factura(&db, "com1", "det1").await;
        dar_de_baja(&db, &id_pago, ClaseBaja::Devolucion).await.unwrap();
        assert!(corregir(&db, &f1).await.is_err());
    }

    #[tokio::test]
    async fn NO_se_corrige_un_ticket_ni_una_rectificativa_de_devolucion() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, DOS_VENTAS).await;
        let (id_pago, ticket) = cobrar(&db, "com1", "det1").await;
        assert!(corregir(&db, &ticket).await.is_err(), "un ticket no tiene cliente");
        dar_de_baja(&db, &id_pago, ClaseBaja::Devolucion).await.unwrap();
        let r5 = registros(&db).await.into_iter().find(|f| f.es("R5")).unwrap();
        assert!(corregir(&db, &r5.num).await.is_err());
    }

    // ── Varios tickets en una F3 ───────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn una_F3_de_dos_tickets_los_sustituye_a_los_dos_y_suma_su_desglose() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, DOS_VENTAS).await;
        let (pago1, t1) = cobrar(&db, "com1", "det1").await;
        let (pago2, t2) = cobrar(&db, "com2", "det2").await;

        let f3 = canjear_cobros(&db, &[&pago1, &pago2]).await.unwrap();

        let filas = registros(&db).await;
        let f = fila(&filas, &f3);
        assert!(f.es("F3"));
        let mut sust = nums(f.refs("sustituidas"));
        sust.sort();
        assert_eq!(sust, vec![t1, t2]);
        assert_eq!(f.importe(), Dinero::de_centimos(600));
        assert_eq!(f.cuota(), Dinero::de_centimos(54));
        assert_eq!(f.id_pago, None, "es de dos cobros: no cuelga de ninguno");
        assert_eq!(f.cliente().unwrap()["NIF"], NIF_CLIENTE);
        assert_cadena_sana(&db).await;
    }

    #[tokio::test]
    async fn el_desglose_de_varios_tickets_es_la_SUMA_de_los_declarados_y_no_un_recalculo() {
        // 1,05 € al 10 %: base 0,95 y cuota 0,10. Dos tickets suman base 1,90 y cuota 0,20.
        // Recalcular desde el total (2,10) daría base 1,91 y cuota 0,19: el cliente deduciría un
        // céntimo menos de lo que se declaró en los tickets.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, DOS_VENTAS).await;
        sembrar(&db, &["UPDATE Detalle_Comanda SET Precio_Unitario = 105;"]).await;
        let (pago1, _) = cobrar(&db, "com1", "det1").await;
        let (pago2, _) = cobrar(&db, "com2", "det2").await;

        let f3 = canjear_cobros(&db, &[&pago1, &pago2]).await.unwrap();

        let filas = registros(&db).await;
        let tickets_cuota: Dinero = filas.iter().filter(|f| f.es("F2")).map(Fila::cuota).sum();
        assert_eq!(tickets_cuota, Dinero::de_centimos(20));
        assert_eq!(fila(&filas, &f3).cuota(), Dinero::de_centimos(20));
        assert_eq!(fila(&filas, &f3).importe(), Dinero::de_centimos(210));
    }

    #[tokio::test]
    async fn NO_se_canjean_varios_si_alguno_no_puede_canjearse() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, DOS_VENTAS).await;
        let (pago1, t1) = cobrar(&db, "com1", "det1").await;
        let (pago2, _) = cobrar(&db, "com2", "det2").await;
        canjear(&db, &t1).await.unwrap();
        let antes = registros(&db).await.len();

        let e = canjear_cobros(&db, &[&pago1, &pago2]).await.unwrap_err();
        assert!(format!("{e:?}").contains("ya se emitió"), "{e:?}");
        assert_eq!(registros(&db).await.len(), antes, "no se emite nada ni se gasta número");

        let e = canjear_cobros(&db, &[&pago2, &pago2]).await.unwrap_err();
        assert!(format!("{e:?}").contains("dos veces"), "{e:?}");
        assert!(canjear_cobros(&db, &[]).await.is_err());
    }

    #[tokio::test]
    async fn la_devolucion_de_un_ticket_de_una_F3_multiple_emite_su_R5_y_la_F3_de_la_R5() {
        // FAQ, apartado 27, punto 1: «Una vez rectificada la F2, hay que emitir una F3 por la
        // rectificativa simplificada». La F3 de los dos sigue vigente para el otro ticket.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, DOS_VENTAS).await;
        let (pago1, t1) = cobrar(&db, "com1", "det1").await;
        let (pago2, t2) = cobrar(&db, "com2", "det2").await;
        let f3 = canjear_cobros(&db, &[&pago1, &pago2]).await.unwrap();

        dar_de_baja(&db, &pago1, ClaseBaja::Devolucion).await.unwrap();

        let filas = registros(&db).await;
        let r5 = filas.iter().find(|f| f.es("R5")).unwrap();
        assert_eq!(nums(r5.refs("rectificadas")), vec![t1]);
        let de_la_r5 = filas.iter().rfind(|f| f.es("F3")).unwrap();
        assert_ne!(de_la_r5.num, f3);
        assert_eq!(nums(de_la_r5.refs("sustituidas")), vec![r5.num.clone()]);
        assert_eq!(de_la_r5.importe(), Dinero::de_centimos(-300));
        assert_eq!(de_la_r5.cliente().unwrap()["NIF"], NIF_CLIENTE);
        assert!(anulaciones(&filas).is_empty(), "la F3 de los dos no se anula");

        let e = canjear(&db, &t2).await.unwrap_err();
        assert!(format!("{e:?}").contains("ya se emitió"), "el otro ticket sigue canjeado: {e:?}");
        assert_cadena_sana(&db).await;
    }

    #[tokio::test]
    async fn la_baja_por_error_de_un_ticket_de_una_F3_multiple_no_anula_la_F3_la_contrarresta() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, DOS_VENTAS).await;
        let (pago1, t1) = cobrar(&db, "com1", "det1").await;
        let (pago2, t2) = cobrar(&db, "com2", "det2").await;
        let f3 = canjear_cobros(&db, &[&pago1, &pago2]).await.unwrap();

        dar_de_baja(&db, &pago1, ClaseBaja::Error).await.unwrap();

        let filas = registros(&db).await;
        let anuladas: Vec<&str> = anulaciones(&filas).iter().map(|f| f.num.as_str()).collect();
        assert_eq!(anuladas, vec![t1.as_str()], "sólo el ticket que no existió");
        let negativa = filas.iter().rfind(|f| f.es("F3")).unwrap();
        assert_ne!(negativa.num, f3);
        assert_eq!(nums(negativa.refs("sustituidas")), vec![t1.clone()]);
        assert_eq!(negativa.importe(), Dinero::de_centimos(-300));
        // Lo que queda canjeado para el cliente: la F3 de los dos menos la parte anulada.
        let neto: Dinero = filas.iter().filter(|f| f.es("F3")).map(Fila::importe).sum();
        assert_eq!(neto, Dinero::de_centimos(300));

        let e = canjear(&db, &t2).await.unwrap_err();
        assert!(format!("{e:?}").contains("ya se emitió"), "{e:?}");
        assert_cadena_sana(&db).await;
    }

    #[tokio::test]
    async fn el_papel_de_una_F3_de_varios_tickets_lleva_las_lineas_de_todos_sin_metodo_ni_cajon() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, DOS_VENTAS).await;
        let (pago1, t1) = cobrar(&db, "com1", "det1").await;
        let (pago2, t2) = cobrar(&db, "com2", "det2").await;
        let f3 = canjear_cobros(&db, &[&pago1, &pago2]).await.unwrap();

        let p = papel(&db, &pago1, Some(&f3)).await;

        assert_eq!(p.tipo_factura.as_deref(), Some("F3"));
        assert_eq!(p.total, Some(Dinero::de_centimos(600)));
        assert_eq!(Some(suma_lineas(&p)), p.total, "las líneas de los dos cobros cuadran con el total");
        assert_eq!(p.items.iter().map(|l| l.cantidad).sum::<u32>(), 2, "una cerveza de cada ticket");
        let mut sust = p.sustituye.clone();
        sust.sort();
        assert_eq!(sust, vec![t1, t2]);
        assert_eq!(p.metodo_pago, None, "no es un cobro");
        assert_eq!(p.origen, None);
        assert!(!p.abre_cajon);
        assert_eq!(p.destinatario.map(|d| d.nif), Some(NIF_CLIENTE.to_string()));

        // Se imprime igual desde el otro cobro.
        let desde_el_otro = papel(&db, &pago2, Some(&f3)).await;
        assert_eq!(desde_el_otro.total, p.total);
        assert_eq!(desde_el_otro.items.len(), p.items.len());
    }

    #[tokio::test]
    async fn cada_cobro_ofrece_la_F3_de_varios_en_su_lista_de_facturas() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, DOS_VENTAS).await;
        let (pago1, _) = cobrar(&db, "com1", "det1").await;
        let (pago2, _) = cobrar(&db, "com2", "det2").await;
        let f3 = canjear_cobros(&db, &[&pago1, &pago2]).await.unwrap();
        let nueva = corregir(&db, &f3).await.unwrap();

        for pago in [&pago1, &pago2] {
            let p = papel(&db, pago, None).await;
            let lista: Vec<(&str, i64)> = p
                .facturas_del_cobro
                .iter()
                .map(|f| (f.tipo_factura.as_str(), f.importe.centimos()))
                .collect();
            assert_eq!(lista, [("F2", 300), ("F3", 600), ("F3", -600), ("F3", 600)], "{pago}");
            assert_eq!(p.facturas_del_cobro[3].num_serie, nueva);
        }
    }

    #[tokio::test]
    async fn el_papel_de_la_negativa_de_una_F3_multiple_va_en_negativo_y_cuadra() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, DOS_VENTAS).await;
        let (pago1, _) = cobrar(&db, "com1", "det1").await;
        let (pago2, _) = cobrar(&db, "com2", "det2").await;
        let f3 = canjear_cobros(&db, &[&pago1, &pago2]).await.unwrap();
        corregir(&db, &f3).await.unwrap();
        let negativa = registros(&db).await.into_iter().filter(|f| f.es("F3")).nth(1).unwrap();

        let p = papel(&db, &pago1, Some(&negativa.num)).await;

        assert_eq!(p.total, Some(Dinero::de_centimos(-600)));
        assert_eq!(Some(suma_lineas(&p)), p.total);
    }

    #[tokio::test]
    async fn corregir_una_F3_multiple_la_reemite_con_todos_sus_tickets() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, DOS_VENTAS).await;
        let (pago1, t1) = cobrar(&db, "com1", "det1").await;
        let (pago2, t2) = cobrar(&db, "com2", "det2").await;
        let f3 = canjear_cobros(&db, &[&pago1, &pago2]).await.unwrap();

        let nueva = corregir(&db, &f3).await.unwrap();

        let filas = registros(&db).await;
        let mut sust = nums(fila(&filas, &nueva).refs("sustituidas"));
        sust.sort();
        let mut esperados = vec![t1, t2];
        esperados.sort();
        assert_eq!(sust, esperados);
        assert_eq!(fila(&filas, &nueva).importe(), Dinero::de_centimos(600));
        // La vigente es la nueva para los dos tickets: devolver uno pone su F3 con el cliente bueno.
        dar_de_baja(&db, &pago2, ClaseBaja::Devolucion).await.unwrap();
        let filas = registros(&db).await;
        let de_la_r5 = filas.iter().rfind(|f| f.es("F3")).unwrap();
        assert_eq!(de_la_r5.cliente().unwrap()["NIF"], NIF_NUEVO);
        assert_cadena_sana(&db).await;
    }
}
