//! Adaptador SQLite del repositorio de cuentas (caja). Local-First (sin outbox/applied).

use std::sync::Arc;

use async_trait::async_trait;
use libsql::Value;

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::cuentas::{AnularPagoArgs, CuentasFiltro, CuentasRepository, ClaseBaja};
use tpv_contracts::cuentas::{
    EntradaDto, LineaTicketDto, ResumenCajaDto, SalidaDto, TicketReimpresionDto,
};
use tpv_domain::cuentas::{GastoData, PagoData, ESTADO_ACTIVO, ESTADO_ANULADO};

use crate::caja_movimientos::{self, MovimientoCaja};
use crate::db::{Db, Reader, Writer};
use crate::mapping::{norm_opt_string, v_f64, v_i64, v_string};
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

/// Construye la cláusula WHERE de rango y los parámetros, dada la columna de fecha.
fn rango_where(
    del: Option<String>,
    al: Option<String>,
    fecha_expr: &str,
) -> (String, Vec<Value>) {
    let del = del.filter(|s| !s.trim().is_empty());
    let al = al.filter(|s| !s.trim().is_empty());

    let mut parts: Vec<String> = Vec::new();
    let mut params: Vec<Value> = Vec::new();

    if del.is_some() {
        parts.push(format!("date({fecha_expr}) >= date(?1)"));
    }
    let al_idx = if del.is_some() { 2 } else { 1 };
    if al.is_some() {
        parts.push(format!("date({fecha_expr}) <= date(?{al_idx})"));
    }

    if let Some(d) = del {
        params.push(Value::Text(d));
    }
    if let Some(a) = al {
        params.push(Value::Text(a));
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

/// Cláusula de paginación (`LIMIT ? OFFSET ?`) a partir de page (1-based) y page_size. Si no hay
/// paginación válida (falta page_size o es 0), devuelve cadena vacía → se listan todas las filas.
fn paginacion(params: &mut Vec<Value>, page: Option<u32>, page_size: Option<u32>) -> String {
    match page_size {
        Some(ps) if ps > 0 => {
            let page = page.unwrap_or(1).max(1);
            let offset = (page as i64 - 1) * ps as i64;
            let li = params.len() + 1;
            let oi = params.len() + 2;
            params.push(Value::Integer(ps as i64));
            params.push(Value::Integer(offset));
            format!("LIMIT ?{li} OFFSET ?{oi}")
        }
        _ => String::new(),
    }
}

/// Subquery interno de **entradas** (cobros) con las columnas calculadas (fechaHora, cliente,
/// metodo, importe). Devuelve el SQL y los parámetros del rango de fechas.
fn entradas_inner(del: Option<String>, al: Option<String>) -> (String, Vec<Value>) {
    let (where_rango, params) = rango_where(del, al, "p.Fecha_Hora");
    let sql = format!(
        r#"
        SELECT
          p.ID_Pago AS id,
          substr(p.Fecha_Hora, 1, 16) AS fechaHora,
          (
            CASE
              WHEN m.Numero_Mesa = 'BARRA' THEN 'Take away'
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
        LEFT JOIN Clientes cl ON cl.ID_Cliente = r.ID_Cliente
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
fn salidas_inner(del: Option<String>, al: Option<String>) -> (String, Vec<Value>) {
    let (where_rango, params) = rango_where(del, al, "g.Fecha");
    let sql = format!(
        r#"
        SELECT
          g.ID_Gasto AS id,
          substr(g.Fecha, 1, 10) AS fechaHora,
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
    async fn entradas(&self, filtro: CuentasFiltro) -> AppResult<Vec<EntradaDto>> {
        let (inner, mut params) = entradas_inner(filtro.del, filtro.al);
        let q_clause = q_filter(&mut params, filtro.q, ENTRADAS_Q_EXPR);
        let limit_clause = paginacion(&mut params, filtro.page, filtro.page_size);
        let sql = format!(
            "SELECT id, fechaHora, cliente, metodo, importe, estado, anuladoEn, anuladoPor, \
             motivoAnulacion FROM ({inner}) AS e {q_clause} \
             ORDER BY fechaHora DESC, id DESC {limit_clause};"
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
            let importe = v_f64(row.get_value(4).map_err(db_err)?).unwrap_or(0.0);
            let estado = v_string(row.get_value(5).map_err(db_err)?)
                .unwrap_or_else(|| ESTADO_ACTIVO.to_string());
            out.push(EntradaDto {
                id,
                fecha_hora: fecha_hora.chars().take(16).collect(),
                cliente,
                metodo,
                importe,
                estado,
                anulado_en: norm_opt_string(row.get_value(6).map_err(db_err)?),
                anulado_por: norm_opt_string(row.get_value(7).map_err(db_err)?),
                motivo_anulacion: norm_opt_string(row.get_value(8).map_err(db_err)?),
            });
        }
        Ok(out)
    }

    async fn salidas(&self, filtro: CuentasFiltro) -> AppResult<Vec<SalidaDto>> {
        let (inner, mut params) = salidas_inner(filtro.del, filtro.al);
        let q_clause = q_filter(&mut params, filtro.q, SALIDAS_Q_EXPR);
        let limit_clause = paginacion(&mut params, filtro.page, filtro.page_size);
        let sql = format!(
            "SELECT id, fechaHora, tipoGasto, concepto, importe, proveedorId, pagadoConCaja FROM ({inner}) AS g \
             {q_clause} ORDER BY fechaHora DESC, id DESC {limit_clause};"
        );

        let db = self.db.read().await;
        let mut rows = db.query(sql.as_str(), params).await.map_err(db_err)?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().await.map_err(db_err)? {
            let id = v_string(row.get_value(0).map_err(db_err)?).unwrap_or_default();
            let fecha = v_string(row.get_value(1).map_err(db_err)?).unwrap_or_default();
            let tipo = v_string(row.get_value(2).map_err(db_err)?).unwrap_or_default();
            let concepto = v_string(row.get_value(3).map_err(db_err)?).unwrap_or_default();
            let importe = v_f64(row.get_value(4).map_err(db_err)?).unwrap_or(0.0);
            let prov = norm_opt_string(row.get_value(5).map_err(db_err)?);
            let pagado_con_caja = v_i64(row.get_value(6).map_err(db_err)?).unwrap_or(0) != 0;
            out.push(SalidaDto {
                id,
                fecha_hora: fecha.chars().take(10).collect(),
                tipo_gasto: tipo,
                concepto,
                importe,
                proveedor_id: prov,
                pagado_con_caja,
            });
        }
        Ok(out)
    }

    async fn resumen(
        &self,
        del: Option<String>,
        al: Option<String>,
        q: Option<String>,
    ) -> AppResult<ResumenCajaDto> {
        let db = self.db.read().await;

        // ── Entradas: total + total por método + conteo, sobre todo el rango + búsqueda. ──
        let (entradas_inner_sql, mut e_params) = entradas_inner(del.clone(), al.clone());
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
                    v_f64(row.get_value(0).map_err(db_err)?).unwrap_or(0.0),
                    v_f64(row.get_value(1).map_err(db_err)?).unwrap_or(0.0),
                    v_f64(row.get_value(2).map_err(db_err)?).unwrap_or(0.0),
                    v_i64(row.get_value(3).map_err(db_err)?).unwrap_or(0),
                    v_i64(row.get_value(4).map_err(db_err)?).unwrap_or(0),
                    v_f64(row.get_value(5).map_err(db_err)?).unwrap_or(0.0),
                ),
                None => (0.0, 0.0, 0.0, 0, 0, 0.0),
            }
        };

        // ── Salidas: total + conteo. ──
        let (salidas_inner_sql, mut s_params) = salidas_inner(del, al);
        let s_q = q_filter(&mut s_params, q, SALIDAS_Q_EXPR);
        let s_sql = format!(
            "SELECT IFNULL(SUM(importe), 0), COUNT(*) FROM ({salidas_inner_sql}) AS g {s_q};"
        );
        let (total_salidas, count_salidas) = {
            let mut rows = db.query(s_sql.as_str(), s_params).await.map_err(db_err)?;
            match rows.next().await.map_err(db_err)? {
                Some(row) => (
                    v_f64(row.get_value(0).map_err(db_err)?).unwrap_or(0.0),
                    v_i64(row.get_value(1).map_err(db_err)?).unwrap_or(0),
                ),
                None => (0.0, 0),
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
                    Value::Real(g.importe),
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
                    Value::Real(g.importe),
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
                    v_f64(row.get_value(0).map_err(db_err)?).unwrap_or(0.0),
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
            let (importe, concepto) = importe.unwrap_or((0.0, String::new()));
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
                        SELECT IFNULL(SUM(COALESCE(dc.Cantidad,1) * COALESCE(dc.Precio_Unitario,0)), 0)
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

    async fn ticket_para_reimprimir(&self, id_pago: &str) -> AppResult<Option<TicketReimpresionDto>> {
        let r = self.db.read().await;
        let conn = r.conn();

        // Cabecera: número, método y de dónde salió. El origen se arma aquí y no en la UI para que
        // la copia diga exactamente lo mismo que dijo el original.
        let mut rows = conn
            .query(
                r#"
                SELECT
                  COALESCE(p.Numero_Ticket, '') AS Numero,
                  COALESCE(p.Metodo_Pago, '')   AS Metodo,
                  CASE
                    WHEN m.Numero_Mesa IS NOT NULL THEN 'Mesa ' || m.Numero_Mesa
                    ELSE 'Barra'
                  END AS Origen,
                  CASE WHEN COALESCE(p.Estado,'ACTIVO') = 'ANULADO' THEN 1 ELSE 0 END AS Anulado
                FROM Pagos p
                JOIN Comandas c ON c.ID_Comanda = p.ID_Comanda
                LEFT JOIN Mesas m ON m.ID_Mesa = c.ID_Mesa
                WHERE p.ID_Pago = ?1
                LIMIT 1;
                "#,
                vec![Value::Text(id_pago.to_string())],
            )
            .await
            .map_err(db_err)?;

        // Sin filtro por estado: un cobro anulado SE puede reimprimir —es la prueba de qué
        // contenía— pero la copia sale marcada, para que no circule como un cobro válido.
        let (numero_ticket, metodo_pago, origen, anulado) = match rows.next().await.map_err(db_err)?
        {
            Some(row) => (
                v_string(row.get_value(0).map_err(db_err)?).unwrap_or_default(),
                v_string(row.get_value(1).map_err(db_err)?).unwrap_or_default(),
                v_string(row.get_value(2).map_err(db_err)?).unwrap_or_default(),
                v_i64(row.get_value(3).map_err(db_err)?).unwrap_or(0) == 1,
            ),
            None => return Ok(None),
        };

        // Y las líneas que cobró ESE pago (no las de la comanda entera: un cobro fraccionado
        // imprimió solo las suyas y su copia tiene que llevar las mismas).
        let mut rows = conn
            .query(
                r#"
                SELECT
                  COALESCE(dc.Nombre_Producto, pr.Nombre, 'Producto') AS Nombre,
                  COALESCE(dc.Cantidad, 1) AS Cantidad,
                  COALESCE(dc.Precio_Unitario, 0) AS Precio,
                  dc.IVA_Percent
                FROM Pago_Detalles pd
                JOIN Detalle_Comanda dc ON dc.ID_Detalle = pd.ID_Detalle
                LEFT JOIN Productos pr ON pr.ID_Producto = dc.ID_Producto
                WHERE pd.ID_Pago = ?1
                ORDER BY dc.ID_Detalle ASC;
                "#,
                vec![Value::Text(id_pago.to_string())],
            )
            .await
            .map_err(db_err)?;

        let mut lineas = Vec::new();
        while let Some(row) = rows.next().await.map_err(db_err)? {
            lineas.push(LineaTicketDto {
                nombre: v_string(row.get_value(0).map_err(db_err)?).unwrap_or_default(),
                cantidad: v_f64(row.get_value(1).map_err(db_err)?).unwrap_or(1.0),
                precio_unitario: v_f64(row.get_value(2).map_err(db_err)?).unwrap_or(0.0),
                iva_percent: v_f64(row.get_value(3).map_err(db_err)?),
            });
        }

        Ok(Some(TicketReimpresionDto {
            numero_ticket,
            metodo_pago,
            origen,
            lineas,
            anulado,
        }))
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
    ///   de esfumarlas (Opción A del plan). Que una línea esté cobrada pasa a leerse por la vista
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
                        v_f64(row.get_value(1).map_err(db_err)?).unwrap_or(0.0),
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
            //   · ERROR      → la venta NO EXISTIÓ. Se abona el stock, las líneas vuelven a la
            //                  comanda y se emite un RF DE ANULACIÓN.
            //   · DEVOLUCION → la venta SÍ EXISTIÓ y se devuelve el dinero. El stock NO se abona
            //                  (el cliente se llevó la consumición) y las líneas NO vuelven: si
            //                  volvieran, quedarían pendientes de cobro y el camarero las cobraría
            //                  otra vez. Se emite una FACTURA RECTIFICATIVA (R5).
            //
            // Lo que hacen igual las dos es dejar de contar como venta, y por eso comparten
            // `Estado = 'ANULADO'`: al cajón le da igual por qué salió el dinero.
            if clase.devuelve_las_lineas() {
            // 2) Devolver el stock de lotes que consumió ESTE cobro. Se busca por el cobro del
            //    consumo y no por sus líneas (STOCK-01): una línea anulada y vuelta a cobrar tiene un
            //    consumo por cobro, y por la línea se devolvía también el del cobro anulado antes,
            //    que ya había vuelto. La traza se CONSERVA: el doble abono lo impide el `Estado`.
            conn.execute(
                r#"
                UPDATE Lotes_Producto
                SET Stock_Disponible = COALESCE(Stock_Disponible,0) + (
                    SELECT IFNULL(SUM(lc.Cantidad),0)
                    FROM Lote_Consumos lc
                    WHERE lc.ID_Pago = ?1 AND lc.ID_Lote = Lotes_Producto.ID_Lote
                )
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
                SET Stock_Suelto = COALESCE(Stock_Suelto,0) + (
                    SELECT IFNULL(SUM(sc.Cantidad),0)
                    FROM Suelto_Consumos sc
                    WHERE sc.ID_Pago = ?1 AND sc.ID_Producto = Productos.ID_Producto
                )
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
            }

            // 3) Restar el gasto del cliente ligado a la comanda (vía Reservas), sin bajar de 0.
            //
            //    Esto SÍ se hace en los dos casos: el cliente ya no ha gastado ese dinero, haya
            //    sido porque la venta no existía o porque se le ha devuelto.
            let importe = (importe * 100.0).round() / 100.0;
            if importe > 0.0 && !id_comanda.is_empty() {
                conn.execute(
                    r#"
                    UPDATE Clientes
                    SET Total_Gastado = MAX(0, COALESCE(Total_Gastado,0) - ?2)
                    WHERE ID_Cliente = (
                        SELECT r.ID_Cliente
                        FROM Comandas c
                        JOIN Reservas r ON r.ID_Reserva = c.ID_Reserva
                        WHERE c.ID_Comanda = ?1
                    );
                    "#,
                    vec![Value::Text(id_comanda.clone()), Value::Real(importe)],
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
                            LEFT JOIN v_lineas_cobradas pd ON pd.ID_Detalle = dc.ID_Detalle
                            WHERE dc.ID_Comanda = Comandas.ID_Comanda
                              AND pd.ID_Detalle IS NULL
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
                            LEFT JOIN v_lineas_cobradas pd ON pd.ID_Detalle = dc.ID_Detalle
                            WHERE dc.ID_Comanda = Comandas.ID_Comanda
                              AND pd.ID_Detalle IS NULL
                          )
                           AND NOT EXISTS (
                            SELECT 1 FROM Comandas abierta
                            WHERE abierta.ID_Mesa = Comandas.ID_Mesa
                              AND abierta.Estado = 'Abierta'
                              AND abierta.ID_Comanda <> Comandas.ID_Comanda
                          )
                          THEN NULL ELSE Fecha_Hora_Cierre END,
                        Total_Comanda = (
                            SELECT IFNULL(SUM(COALESCE(Cantidad,1) * COALESCE(Precio_Unitario,0)), 0)
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
           VALUES ('prod', 'cat', 'Cerveza', 3.0, 7);",
        "INSERT INTO Lotes_Producto (ID_Lote, ID_Producto, Codigo_Lote, Stock_Disponible, Fecha_Entrada)
           VALUES ('lote', 'prod', 'L-1', 18, '2026-01-01 10:00:00');",
        "INSERT INTO Clientes (ID_Cliente, Nombre, Total_Gastado) VALUES ('cli', 'Ana', 50.0);",
        "INSERT INTO Reservas (ID_Reserva, ID_Cliente, ID_Mesa, Dia_YMD, Hora, Turno, Comensales)
           VALUES ('res', 'cli', 'mesa', '2026-01-02', '13:00', 'COMIDA', 2);",
        "INSERT INTO Comandas (ID_Comanda, Canal, ID_Mesa, ID_Reserva, Fecha_Hora_Apertura, Fecha_Hora_Cierre, Estado, Total_Comanda)
           VALUES ('com', 'MESA', 'mesa', 'res', '2026-01-02 12:00:00', '2026-01-02 13:00:00', 'Pagada', 12.0);",
        "INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Cantidad, Precio_Unitario)
           VALUES ('det-lote', 'com', 'prod', 2, 3.0);",
        "INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Cantidad, Precio_Unitario)
           VALUES ('det-suelto', 'com', 'prod', 1, 3.0);",
        "INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Cantidad, Precio_Unitario)
           VALUES ('det-pendiente', 'com', 'prod', 1, 3.0);",
        "INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo)
           VALUES ('pago', 'com', '2026-01-02 13:00:00', 'Efectivo', 9.0, 'PARCIAL');",
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
                   VALUES ('pago-viejo', 'com', '2026-01-02 12:30:00', 'Efectivo', 6.0, 'PARCIAL',
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

    #[tokio::test]
    async fn el_ticket_anulado_se_puede_reimprimir_marcado() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_DE_MESA).await;
        repo(&db).anular_pago(args("pago")).await.unwrap();

        let t = repo(&db).ticket_para_reimprimir("pago").await.unwrap().unwrap();

        assert!(t.anulado, "la copia tiene que decir que ese cobro ya no vale");
        assert_eq!(t.lineas.len(), 2, "y seguir enseñando lo que se cobró");
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
            41.0,
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
            12.0,
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
            9.0,
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

        for importe in [12.5, 13.0] {
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
                importe: 12.5,
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
            12.5,
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
           VALUES ('prod', 'cat', 'Cafe', 1.2);",
        "INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura, Estado, Total_Comanda)
           VALUES ('com', 'BARRA', '2026-01-02 12:00:00', 'Pagada', 2.4);",
        "INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Cantidad, Precio_Unitario)
           VALUES ('d1', 'com', 'prod', 1, 1.2);",
        "INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Cantidad, Precio_Unitario)
           VALUES ('d2', 'com', 'prod', 1, 1.2);",
        "INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo)
           VALUES ('pago', 'com', '2026-01-02 12:30:00', 'Efectivo', 2.4, 'TOTAL');",
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
    //! El criterio de aceptación del plan entero: anular un cobro en efectivo ya **no** baja el
    //! esperado del arqueo, así que el dinero que falta sale como que falta.

    use super::tests_comunes::*;
    use super::*;
    use crate::cierre_caja::SqliteCierreCajaRepository;
    use tpv_application::ports::cierre_caja::CierreCajaRepository;
    use tpv_application::ports::cuentas::{AnularPagoArgs, CuentasRepository};

    const DOS_COBROS_EN_EFECTIVO: &[&str] = &[
        // El rol Administrador lo siembran ya las migraciones; aquí sólo hace falta el usuario que
        // firma la anulación (`Anulado_Por` es una FK y el CHECK lo exige).
        "INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre)
           VALUES ('u1', '00000000-0000-7000-8000-000000000001', 'jefe@bar.example', 'x', 'Marta');",
        "INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura, Estado)
           VALUES ('com', 'BARRA', '2026-01-02 12:00:00', 'Pagada');",
        "INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo)
           VALUES ('p1', 'com', '2026-01-02 12:30:00', 'Efectivo', 20.0, 'TOTAL');",
        "INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo)
           VALUES ('p2', 'com', '2026-01-02 13:30:00', 'Efectivo', 30.0, 'TOTAL');",
    ];

    #[tokio::test]
    async fn el_esperado_del_arqueo_no_baja_al_anular_un_cobro_en_efectivo() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, DOS_COBROS_EN_EFECTIVO).await;
        let caja = SqliteCierreCajaRepository::new(db.clone());

        assert_eq!(caja.totales_desde(None).await.unwrap().ventas_efectivo, 50.0);

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
            20.0,
            "el cobro anulado deja de ser una venta…"
        );
        // …y por eso los 30 € que faltan del cajón ya no tienen quien los tape: el esperado baja a
        // 20, el recuento dirá 20 si el dinero está y 20 menos lo que falte si no. Antes de
        // CUENTA-07 el pago desaparecía y el descuadre salía exactamente cero.
        let (n, importe) = caja.anulaciones_desde(None).await.unwrap();
        assert_eq!((n, importe), (1, 30.0), "y queda contado, que es el aviso");
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
        assert_eq!(res.total_entradas, 20.0);
        assert_eq!(res.total_efectivo, 20.0);
        assert_eq!(res.count_entradas, 1);
        assert_eq!(res.count_anuladas, 1);
        assert_eq!(res.total_anulado, 30.0);

        let filas = r.entradas(Default::default()).await.unwrap();
        assert_eq!(filas.len(), 2, "en la lista salen los dos: aquí se investiga");
        let anulada = filas.iter().find(|e| e.id == "p2").unwrap();
        assert_eq!(anulada.estado, "ANULADO");
        assert_eq!(anulada.anulado_por.as_deref(), Some("Marta"));
        assert_eq!(anulada.motivo_anulacion.as_deref(), Some("x"));
    }
}

#[cfg(test)]
mod tests_reimpresion {
    //! Lo que se puede volver a imprimir de un cobro ya hecho.
    //!
    //! Una reimpresión no es "imprimir otra vez lo que hay ahora": es sacar **el mismo papel** que
    //! salió el día de la venta. Por eso los datos salen del cobro (`Pagos` + `Pago_Detalles`) y no
    //! del producto ni de la comanda: entre medias han podido cambiar el precio, el tipo de IVA o
    //! hasta el nombre del plato, y la copia tiene que seguir diciendo lo que se cobró.

    use super::tests_comunes::*;
    use super::*;
    use tpv_application::ports::cuentas::CuentasRepository;

    /// Una venta de barra: dos cafés y una tostada, cobradas de una vez.
    const VENTA_BARRA: &[&str] = &[
        "INSERT INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('cat', 'Bar');",
        "INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta, IVA_Percent)
           VALUES ('p1', 'cat', 'Cafe con leche', 1.3, 10);",
        "INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta, IVA_Percent)
           VALUES ('p2', 'cat', 'Tostada', 2.5, 10);",
        "INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura, Estado)
           VALUES ('com', 'BARRA', '2026-01-02 12:00:00', 'Pagada');",
        "INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Nombre_Producto, Cantidad, Precio_Unitario, IVA_Percent)
           VALUES ('d1', 'com', 'p1', 'Cafe con leche', 2, 1.3, 10);",
        "INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Nombre_Producto, Cantidad, Precio_Unitario, IVA_Percent)
           VALUES ('d2', 'com', 'p2', 'Tostada', 1, 2.5, 21);",
        "INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo, Numero_Ticket)
           VALUES ('pago', 'com', '2026-01-02 12:30:00', 'EFECTIVO', 5.1, 'TOTAL', 'T-000007');",
        "INSERT INTO Pago_Detalles (ID_Pago, ID_Detalle) VALUES ('pago', 'd1');",
        "INSERT INTO Pago_Detalles (ID_Pago, ID_Detalle) VALUES ('pago', 'd2');",
    ];

    fn repo(db: &Arc<Db>) -> SqliteCuentasRepository {
        SqliteCuentasRepository::new(db.clone())
    }

    #[tokio::test]
    async fn un_cobro_que_no_existe_no_devuelve_un_ticket_vacio() {
        // Devolver Some con los campos en blanco imprimiría un papel fantasma con número vacío.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_BARRA).await;

        assert!(repo(&db).ticket_para_reimprimir("no-existe").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn la_copia_lleva_el_numero_y_el_metodo_del_cobro_original() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_BARRA).await;

        let t = repo(&db).ticket_para_reimprimir("pago").await.unwrap().unwrap();

        assert_eq!(t.numero_ticket, "T-000007");
        assert_eq!(t.metodo_pago, "EFECTIVO");
    }

    #[tokio::test]
    async fn un_ticket_de_barra_dice_barra() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_BARRA).await;

        let t = repo(&db).ticket_para_reimprimir("pago").await.unwrap().unwrap();
        assert_eq!(t.origen, "Barra");
    }

    #[tokio::test]
    async fn un_ticket_de_mesa_dice_que_mesa() {
        // El origen es lo que permite encontrar el cobro después: en un arqueo, "Mesa 4" es la
        // única pista de dónde salió ese dinero.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_BARRA).await;
        sembrar(
            &db,
            &[
                "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('zona', 'Terraza');",
                "INSERT INTO Mesas (ID_Mesa, ID_Zona, Numero_Mesa, Capacidad, Ubicacion_X, Ubicacion_Y, Shape, Width, Height)
                   VALUES ('mesa', 'zona', '4', 4, 0, 0, 'rect', 10, 10);",
                "UPDATE Comandas SET Canal = 'MESA', ID_Mesa = 'mesa' WHERE ID_Comanda = 'com';",
            ],
        )
        .await;

        let t = repo(&db).ticket_para_reimprimir("pago").await.unwrap().unwrap();
        assert_eq!(t.origen, "Mesa 4");
    }

    #[tokio::test]
    async fn la_copia_lleva_las_lineas_con_su_cantidad_y_su_precio_unitario() {
        // Dos cafés a 1,30 son "2 x 1,30", no "1 x 2,60". El importe cuadraría igual, pero la
        // copia no diría lo mismo que el original — y una copia que no coincide con el original no
        // sirve para lo que se pide: una devolución, una reclamación, un arqueo.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_BARRA).await;

        let t = repo(&db).ticket_para_reimprimir("pago").await.unwrap().unwrap();

        assert_eq!(t.lineas.len(), 2);
        assert_eq!(t.lineas[0].nombre, "Cafe con leche");
        assert_eq!(t.lineas[0].cantidad, 2.0);
        assert!((t.lineas[0].precio_unitario - 1.3).abs() < 1e-9);
    }

    #[tokio::test]
    async fn cada_linea_conserva_el_tipo_de_iva_con_el_que_se_vendio() {
        // El tipo va congelado en el detalle, no en el producto: si mañana la tostada pasa al 10 %,
        // la copia de hoy tiene que seguir enseñando el 21 % que se cobró.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_BARRA).await;
        sembrar(&db, &["UPDATE Productos SET IVA_Percent = 4 WHERE ID_Producto = 'p2';"]).await;

        let t = repo(&db).ticket_para_reimprimir("pago").await.unwrap().unwrap();

        assert_eq!(t.lineas[1].iva_percent, Some(21.0));
    }

    #[tokio::test]
    async fn un_cobro_fraccionado_solo_reimprime_sus_lineas() {
        // Dos amigos pagan por separado: cada uno se llevó un papel con lo suyo, y su copia tiene
        // que llevar lo suyo. Reimprimir la comanda entera enseñaría a uno lo que pagó el otro.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_BARRA).await;
        sembrar(
            &db,
            &[
                "DELETE FROM Pago_Detalles WHERE ID_Pago = 'pago' AND ID_Detalle = 'd2';",
                "INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo, Numero_Ticket)
                   VALUES ('pago2', 'com', '2026-01-02 12:31:00', 'TARJETA', 2.5, 'PARCIAL', 'T-000008');",
                "INSERT INTO Pago_Detalles (ID_Pago, ID_Detalle) VALUES ('pago2', 'd2');",
            ],
        )
        .await;

        let uno = repo(&db).ticket_para_reimprimir("pago").await.unwrap().unwrap();
        let otro = repo(&db).ticket_para_reimprimir("pago2").await.unwrap().unwrap();

        assert_eq!(uno.lineas.len(), 1);
        assert_eq!(uno.lineas[0].nombre, "Cafe con leche");
        assert_eq!(otro.lineas.len(), 1);
        assert_eq!(otro.lineas[0].nombre, "Tostada");
        assert_eq!(otro.metodo_pago, "TARJETA");
    }

    #[tokio::test]
    async fn borrar_un_producto_vendido_no_se_lleva_por_delante_su_ticket() {
        // INV-05: el catálogo puede quitar lo que ya no se vende. La copia del ticket sale igual,
        // con el nombre que tenía el producto el día de la venta.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_BARRA).await;

        {
            let w = db.write().await;
            w.raw()
                .execute("DELETE FROM Productos WHERE ID_Producto = 'p1';", Vec::<Value>::new())
                .await
                .expect("borrar un producto ya vendido tiene que poder hacerse");
        }

        let t = repo(&db).ticket_para_reimprimir("pago").await.unwrap().unwrap();

        assert_eq!(t.lineas.len(), 2, "no puede perderse ninguna línea del cobro");
        assert_eq!(t.lineas[0].nombre, "Cafe con leche");
        assert_eq!(t.lineas[0].cantidad, 2.0);
        assert!((t.lineas[0].precio_unitario - 1.3).abs() < 1e-9);
        assert_eq!(t.lineas[0].iva_percent, Some(10.0));
    }

    #[tokio::test]
    async fn una_linea_sin_nombre_ni_producto_no_sale_muda() {
        // El cinturón de seguridad: una línea a la que le falten las dos cosas (el snapshot y el
        // producto) sigue siendo un documento contable, y "Producto" se lee mejor que un hueco.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_BARRA).await;
        sembrar(
            &db,
            &[
                "UPDATE Detalle_Comanda SET Nombre_Producto = NULL WHERE ID_Detalle = 'd1';",
                "DELETE FROM Productos WHERE ID_Producto = 'p1';",
            ],
        )
        .await;

        let t = repo(&db).ticket_para_reimprimir("pago").await.unwrap().unwrap();
        assert_eq!(t.lineas[0].nombre, "Producto");
    }

    #[tokio::test]
    async fn un_cobro_sin_numero_de_ticket_no_revienta_la_reimpresion() {
        // Los cobros anteriores a que existiera el número correlativo lo tienen a NULL.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_BARRA).await;
        sembrar(&db, &["UPDATE Pagos SET Numero_Ticket = NULL WHERE ID_Pago = 'pago';"]).await;

        let t = repo(&db).ticket_para_reimprimir("pago").await.unwrap().unwrap();
        assert_eq!(t.numero_ticket, "");
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
           VALUES ('prod', 'cat', 'Menu de boda', 3500.0);",
        "INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura, Estado, Total_Comanda)
           VALUES ('com', 'BARRA', '2027-01-15 12:00:00', 'Abierta', 3500.0);",
        "INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Cantidad, Precio_Unitario, IVA_Percent)
           VALUES ('det', 'com', 'prod', 1, 3500.0, 10);",
    ];

    /// Un ticket normal, por debajo del límite.
    const VENTA_NORMAL: &[&str] = &[
        "UPDATE Business_Settings SET CIF = 'B12345674', Razon_Social = 'Bar de Pruebas SL'
           WHERE ID = 1;",
        "INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre)
           VALUES ('u1', '00000000-0000-7000-8000-000000000001', 'jefe@bar.example', 'x', 'Marta');",
        "INSERT INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('cat', 'Bebidas');",
        "INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta)
           VALUES ('prod', 'cat', 'Cerveza', 3.0);",
        "INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura, Estado, Total_Comanda)
           VALUES ('com', 'BARRA', '2027-01-15 12:00:00', 'Abierta', 3.0);",
        "INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Cantidad, Precio_Unitario, IVA_Percent)
           VALUES ('det', 'com', 'prod', 1, 3.0, 10);",
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
                importe_total: 0.0,
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
        // El domicilio es SÓLO para el papel: el registro no lo lleva.
        assert!(!dest.contains("Calle Mayor"), "{dest}");
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
                   VALUES ('prod', 'cat', 'Menu', 2000.0);",
                "INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura, Estado, Total_Comanda)
                   VALUES ('com', 'BARRA', '2027-01-15 12:00:00', 'Abierta', 4000.0);",
                "INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Cantidad, Precio_Unitario, IVA_Percent)
                   VALUES ('d1', 'com', 'prod', 1, 2000.0, 10);",
                "INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Cantidad, Precio_Unitario, IVA_Percent)
                   VALUES ('d2', 'com', 'prod', 1, 2000.0, 10);",
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
                importe_total: 0.0,
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

        use tpv_application::ports::verifactu::VerifactuRepository as _;
        let repo = crate::verifactu::SqliteVerifactuRepository::new(db.clone());
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

        use tpv_application::ports::verifactu::VerifactuRepository as _;
        crate::verifactu::SqliteVerifactuRepository::new(db.clone())
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

        use tpv_application::ports::verifactu::VerifactuRepository as _;
        let repo = crate::verifactu::SqliteVerifactuRepository::new(db.clone());
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

        use tpv_application::ports::verifactu::VerifactuRepository as _;
        let e = crate::verifactu::SqliteVerifactuRepository::new(db.clone())
            .emitir_sustitutiva(&num, cliente())
            .await
            .unwrap_err();
        assert!(format!("{e:?}").contains("F1"), "{e:?}");
    }

    #[tokio::test]
    async fn canjear_un_numero_que_no_existe_no_revienta() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_NORMAL).await;

        use tpv_application::ports::verifactu::VerifactuRepository as _;
        let e = crate::verifactu::SqliteVerifactuRepository::new(db.clone())
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
           VALUES ('prod', 'cat', 'Cerveza', 3.0, 10);",
        "INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura, Estado, Total_Comanda)
           VALUES ('com', 'BARRA', '2027-01-15 12:00:00', 'Pagada', 3.0);",
        "INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Cantidad, Precio_Unitario, IVA_Percent)
           VALUES ('det', 'com', 'prod', 1, 3.0, 10);",
    ];

    /// Cobra por el camino real (para que se emita el registro fiscal) y devuelve el `ID_Pago`.
    async fn cobrar(db: &Arc<Db>) -> String {
        use tpv_application::ports::venta_rapida::VentaRapidaRepository as _;
        crate::venta_rapida::SqliteVentaRapidaRepository::new(db.clone())
            .cobrar_fraccionado(tpv_domain::venta_rapida::CobroFraccionado {
                id_pago: crate::util::new_id(),
                id_comanda: "com".into(),
                metodo: "Efectivo".into(),
                importe_total: 0.0,
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
        // Y el stock tampoco vuelve: la cerveza se la bebieron.
        assert_eq!(
            escalar(&db, "SELECT Stock_Suelto FROM Productos WHERE ID_Producto='prod';").await,
            9.0
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
