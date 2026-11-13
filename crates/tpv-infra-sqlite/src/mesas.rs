//! Adaptador SQLite del repositorio de **mesas / salón / comandas / cocina**.
//! Las altas generan UUIDv7 con `new_id()` antes del INSERT. Las escrituras de negocio pasan
//! por `WriteGuard::execute`, que captura el SQL y sus parámetros en el outbox para replicarlos.
//! `Applied_Operations` es el control idempotente del worker; la Main usa `_Sync_Applied_Ops`.

use crate::util::new_id;
use crate::consultas::{db_err, lista_json, select_one_i64, select_one_string, select_one_dinero, resolve_trabajador_id_input, update_total_comanda_sql};
use tpv_domain::dinero::Dinero;
use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use chrono::{Local, TimeZone};
use crate::ejecutor::Value;

use crate::caja_movimientos::{self, MovimientoCaja};
use crate::db::{Db, Reader, Writer};

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::mesas::MesasRepository;
use tpv_contracts::mesas::{
    CategoriaVendibleOut, ComandaConLineasOut, ComandaRow, KitchenRow, MesaLineaComandaRow,
    MesaMetaOut, ProductoVendibleOut, ReservaMesaOut, RoomPoly, SalonInput, SalonOut, TableOut,
};
use tpv_domain::mesas::{AbrirComandaData, CobroDetalles};

use crate::mapping::{norm_opt_string, v_f64, v_i64, v_string, v_dinero, dinero_val};

pub struct SqliteMesasRepository {
    db: Arc<Db>,
}

impl SqliteMesasRepository {
    pub fn new(db: Arc<Db>) -> Self {
        Self { db }
    }
}

/// Extrae el id (UUID) embebido en un id de UI con prefijo (`db-mesa-<uuid>`).
fn parse_db_id(id: &str, prefix: &str) -> Option<String> {
    let s = id.trim();
    let rest = s.strip_prefix(prefix)?.trim();
    if rest.is_empty() {
        None
    } else {
        Some(rest.to_string())
    }
}


/// Lo que se congela del producto al vender: nombre, tipo de IVA y precio.
///
/// Se lee ANTES del INSERT y se insertan como literales, igual que `Estado_Cocina` y por el mismo
/// motivo: una subconsulta dentro del INSERT la reevaluaría la nube en otro estado y la fila
/// dejaría de ser idéntica en las dos copias.
///
/// Van EN LA LÍNEA y no se consultan al imprimir. Dos razones, y las dos importan:
///
/// - Si el producto cambia de nombre, de precio o de tipo, un ticket reimpreso tiene que seguir
///   enseñando lo que se cobró el día de la venta.
/// - Y el producto puede **dejar de existir**: el catálogo permite borrar lo que ya no se vende
///   (INV-05) y la FK deja `ID_Producto` a NULL. Sin este nombre, esa línea se quedaría muda.
///
/// El IVA es `NULL` si el producto no tiene tipo propio (hereda el del negocio).
///
/// RI-27: **el precio sale del catálogo, nunca de la pantalla.** La pantalla mandaba el de su carta
/// en caché, y tras un cambio de precio otro puesto seguía vendiendo al de antes durante minutos.
/// Un producto sin precio se vende a 0 € (es decisión del negocio; la AEAT acepta un registro a
/// cero y un tramo de base cero, probado en preproducción).
///
/// RI-54: un producto **archivado** ya no está en la carta, y una pantalla con la carta de antes
/// en caché todavía puede ofrecerlo. Se rechaza aquí, que es por donde pasa toda línea nueva.
pub(crate) async fn snapshot_del_producto<C: Reader>(conn: &C, id_producto: &str) -> AppResult<ProductoEnLinea> {
    let mut rows = conn
        .query(
            "SELECT Nombre, IVA_Percent, Archivado_En IS NOT NULL, COALESCE(Precio_Venta, 0)              FROM Productos WHERE ID_Producto = ?1 LIMIT 1;",
            vec![Value::Text(id_producto.to_string())],
        )
        .await
        .map_err(db_err)?;

    match rows.next().await.map_err(db_err)? {
        Some(row) if v_i64(row.get_value(2).map_err(db_err)?) == Some(1) => Err(AppError::validation(
            "Ese producto ya no está en la carta. Vuelve a abrir la carta y elige otro.",
        )),
        Some(row) => Ok(ProductoEnLinea {
            nombre: v_string(row.get_value(0).map_err(db_err)?)
                .map(Value::Text)
                .unwrap_or(Value::Null),
            iva: v_f64(row.get_value(1).map_err(db_err)?)
                .map(Value::Real)
                .unwrap_or(Value::Null),
            precio: v_dinero(row.get_value(3).map_err(db_err)?).unwrap_or(Dinero::CERO),
        }),
        // Sin producto no hay línea: la FK del INSERT la rechaza.
        None => Ok(ProductoEnLinea { nombre: Value::Null, iva: Value::Null, precio: Dinero::CERO }),
    }
}

/// Lo que se enseña al intentar añadir una línea a una comanda ya cobrada. El mismo texto que
/// `comanda_cobrada` en el worker (`lib/errorCodes.ts`).
pub(crate) const COMANDA_COBRADA: &str =
    "Esa cuenta ya está cobrada. Ciérrala y vuelve a abrir la mesa o un ticket nuevo.";

/// INC-20261030-016: una comanda cobrada no admite líneas nuevas. Una pantalla que se quedó con la
/// comanda de antes del cobro (otro equipo la cobró, o se cobró y se volvió a abrir la mesa) metía
/// la línea en la comanda ya `Pagada`: la mesa aparecía libre, la comanda nueva no la enseñaba y
/// nadie la iba a cobrar. Se comprueba dentro de la transacción que escribe la línea.
///
/// Una comanda que no existe pasa: la rechaza la FK del `INSERT`, como siempre.
pub(crate) async fn exigir_comanda_abierta<C: Reader>(conn: &C, id_comanda: &str) -> AppResult<()> {
    let cobrada = select_one_i64(
        conn,
        "SELECT Estado <> 'Abierta' FROM Comandas WHERE ID_Comanda = ?1 LIMIT 1;",
        vec![Value::Text(id_comanda.to_string())],
    )
    .await?;
    if cobrada == Some(1) {
        return Err(AppError::conflict(COMANDA_COBRADA));
    }
    Ok(())
}

/// Ver [`snapshot_del_producto`].
#[derive(Debug)]
pub(crate) struct ProductoEnLinea {
    pub nombre: Value,
    pub iva: Value,
    pub precio: Dinero,
}

async fn sumar_gasto_cliente_por_comanda<C: Writer>(
    db: &C,
    id_comanda: &str,
    importe: Dinero,
) -> AppResult<()> {
    if importe <= Dinero::CERO {
        return Ok(());
    }

    // El gasto se acredita al cliente de la comanda: el que ya tiene (`Comandas.ID_Cliente`) o, si
    // es su primer cobro, el de su reserva explícita. No hay fallback por reserva activa de la mesa:
    // acreditar el consumo de un walk-in a un cliente con reserva en esa mesa es incorrecto y
    // divergía de la implementación Handy (MESA-04).
    let mut rows = db
        .query(
            "SELECT c.ID_Cliente, r.ID_Cliente FROM Comandas c \
             LEFT JOIN Reservas r ON r.ID_Reserva = c.ID_Reserva \
             WHERE c.ID_Comanda = ?1 LIMIT 1;",
            vec![Value::Text(id_comanda.to_string())],
        )
        .await
        .map_err(db_err)?;
    let Some(row) = rows.next().await.map_err(db_err)? else {
        return Ok(());
    };
    let de_la_comanda = v_string(row.get_value(0).map_err(db_err)?);
    let de_la_reserva = v_string(row.get_value(1).map_err(db_err)?);
    drop(rows);

    let id_cliente = match (de_la_comanda, de_la_reserva) {
        (Some(id), _) => id,
        (None, Some(id)) => {
            // RI-61: el cliente se queda en la comanda al cobrar. Antes el gasto colgaba de la
            // reserva, y borrarla o reasignarla después le quitaba el gasto al cliente; ahora la
            // anulación y la reconciliación leen la comanda, como esto.
            db.execute("UPDATE Comandas SET ID_Cliente = ?2 WHERE ID_Comanda = ?1 AND ID_Cliente IS NULL;",
                vec![Value::Text(id_comanda.to_string()), Value::Text(id.clone())],
            ).await.map_err(db_err)?;
            id
        }
        (None, None) => return Ok(()),
    };

    db.execute(r#"
        UPDATE Clientes
        SET Total_Gastado = COALESCE(Total_Gastado,0) + ?2
        WHERE ID_Cliente = ?1;
        "#,
        vec![Value::Text(id_cliente), dinero_val(importe)],
    ).await.map_err(db_err)?;

    Ok(())
}

/// Las dos sentencias que quitan del plano las mesas que cumplen `filtro` (RI-54).
///
/// - Las que tienen historia (comandas o reservas) se **archivan**: desaparecen del plano y de las
///   reservas nuevas, y sus comandas siguen contando en las estadísticas. Antes se quedaban sin decir
///   nada y volvían a aparecer en el plano, así que una zona antigua no se podía quitar nunca.
/// - Las que no tienen historia se borran.
/// - Una mesa con una comanda **abierta** no se toca: quitarla escondería una cuenta sin cobrar.
///
/// Las condiciones van en el SQL para que la nube, al replicarlas, decida lo mismo.
fn sql_quitar_mesas(filtro: &str) -> [String; 2] {
    let historia = "(EXISTS (SELECT 1 FROM Comandas C WHERE C.ID_Mesa = Mesas.ID_Mesa) \
                    OR EXISTS (SELECT 1 FROM Reservas R WHERE R.ID_Mesa = Mesas.ID_Mesa))";
    [
        format!(
            "UPDATE Mesas SET Archivada_En = datetime('now','localtime') \
             WHERE {filtro} AND Archivada_En IS NULL AND {historia} \
               AND NOT EXISTS (SELECT 1 FROM Comandas C WHERE C.ID_Mesa = Mesas.ID_Mesa AND C.Estado = 'Abierta');"
        ),
        format!("DELETE FROM Mesas WHERE {filtro} AND NOT {historia};"),
    ]
}

/// La comanda abierta de la mesa (`bare_id_mesa`, sin el prefijo de la pantalla), si la hay.
async fn comanda_abierta_de<C: Reader>(db: &C, bare_id_mesa: &str) -> AppResult<Option<String>> {
    select_one_string(
        db,
        r#"
        SELECT ID_Comanda FROM Comandas
        WHERE ID_Mesa = ?1 AND Estado = 'Abierta'
        ORDER BY datetime(Fecha_Hora_Apertura) DESC, ID_Comanda DESC LIMIT 1;
        "#,
        vec![Value::Text(bare_id_mesa.to_string())],
    )
    .await
}

/// Abre la comanda de la mesa. Quien llama ya ha mirado que no hay una abierta.
///
/// El INSERT lleva un guard WHERE NOT EXISTS como red de seguridad ante una carrera (idempotente
/// también al replicarse): si entre la comprobación y aquí apareció una comanda abierta para la
/// mesa, no se inserta una duplicada. El índice único parcial idx_comandas_una_abierta_por_mesa lo
/// garantiza además a nivel de esquema. MESA-10: sin autoenlace de reserva; si no viene una
/// explícita, `ID_Reserva` queda NULL.
async fn insertar_comanda<W: Writer>(
    db: &W,
    bare_id_mesa: &str,
    id_trab_o_usuario: Option<String>,
    id_reserva: Option<String>,
) -> AppResult<()> {
    let id_trabajador = resolve_trabajador_id_input(db, id_trab_o_usuario).await?;
    let id_reserva = id_reserva.filter(|s| !s.trim().is_empty());
    db.execute(
        r#"
        INSERT INTO Comandas (
          ID_Comanda, ID_Mesa, ID_Trabajador, ID_Reserva, Fecha_Hora_Apertura, Total_Comanda, Estado
        )
        SELECT ?1, ?2, ?3, ?4, datetime('now','localtime'), 0, 'Abierta'
        WHERE NOT EXISTS (
          SELECT 1 FROM Comandas WHERE ID_Mesa = ?2 AND Estado = 'Abierta'
        );
        "#,
        vec![
            Value::Text(new_id()),
            Value::Text(bare_id_mesa.to_string()),
            id_trabajador.map(Value::Text).unwrap_or(Value::Null),
            id_reserva.map(Value::Text).unwrap_or(Value::Null),
        ],
    )
    .await
    .map_err(db_err)?;
    Ok(())
}

/// ¿Le falta el trabajador a la comanda y todavía se le puede poner? Lo que exige el `WHERE` de
/// `poner_trabajador_si_falta`: abierta, sin trabajador y sin líneas. Espejo de
/// `trabajadorPorPoner` en el worker.
async fn trabajador_por_poner<C: Reader>(db: &C, id_comanda: &str) -> AppResult<bool> {
    Ok(select_one_i64(
        db,
        r#"
        SELECT 1 FROM Comandas
        WHERE ID_Comanda = ?1 AND Estado = 'Abierta' AND ID_Trabajador IS NULL
          AND NOT EXISTS (SELECT 1 FROM Detalle_Comanda dc WHERE dc.ID_Comanda = ?1)
        LIMIT 1;
        "#,
        vec![Value::Text(id_comanda.to_string())],
    )
    .await?
    .is_some())
}

/// Pone el trabajador a una comanda abierta que no lo tiene y aún no tiene líneas. Si ya lo tiene
/// (lo normal al volver a una mesa), no escribe: el `UPDATE` no cambiaría nada, pero pasaría por
/// el outbox y se replicaría igual (su operación aplicada, su cambio en el log, el aviso a las Handy
/// y lo que releen). Con el escritor cogido entre mirar y escribir, nada se cuela entre medias.
async fn poner_trabajador_si_falta<W: Writer>(
    db: &W,
    id_comanda: &str,
    id_trab_o_usuario: Option<String>,
) -> AppResult<bool> {
    let Some(idt) = resolve_trabajador_id_input(db, id_trab_o_usuario).await? else {
        return Ok(false);
    };
    if !trabajador_por_poner(db, id_comanda).await? {
        return Ok(false);
    }
    let changed = db
        .execute(
            r#"
            UPDATE Comandas
            SET ID_Trabajador = ?2
            WHERE ID_Comanda = ?1
              AND Estado = 'Abierta'
              AND ID_Trabajador IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM Detalle_Comanda dc WHERE dc.ID_Comanda = ?1
              );
            "#,
            vec![Value::Text(id_comanda.to_string()), Value::Text(idt)],
        )
        .await
        .map_err(db_err)?;
    Ok(changed > 0)
}

async fn read_comanda_by_id<C: Reader>(db: &C, id_comanda: &str) -> AppResult<Option<ComandaRow>> {
    if id_comanda.trim().is_empty() {
        return Ok(None);
    }
    let mut rows = db
        .query(
            r#"
            SELECT
              ID_Comanda, ID_Mesa, ID_Trabajador, ID_Reserva,
              Fecha_Hora_Apertura, Fecha_Hora_Cierre, Total_Comanda, Estado
            FROM Comandas
            WHERE ID_Comanda = ?1
            LIMIT 1;
            "#,
            vec![Value::Text(id_comanda.to_string())],
        )
        .await
        .map_err(db_err)?;

    let Some(r) = rows.next().await.map_err(db_err)? else {
        return Ok(None);
    };

    Ok(Some(ComandaRow {
        id_comanda: v_string(r.get_value(0).map_err(db_err)?).unwrap_or_default(),
        id_mesa: v_string(r.get_value(1).map_err(db_err)?).unwrap_or_default(),
        id_trabajador: norm_opt_string(r.get_value(2).map_err(db_err)?),
        id_reserva: norm_opt_string(r.get_value(3).map_err(db_err)?),
        fecha_hora_apertura: v_string(r.get_value(4).map_err(db_err)?).unwrap_or_default(),
        fecha_hora_cierre: v_string(r.get_value(5).map_err(db_err)?),
        total_comanda: v_dinero(r.get_value(6).map_err(db_err)?).unwrap_or(Dinero::CERO),
        estado: v_string(r.get_value(7).map_err(db_err)?).unwrap_or_else(|| "Abierta".into()),
    }))
}

/// Las líneas de una comanda con su marca de cobrada. Constante para que `planes::tests` vigile el
/// plan de ESTA sentencia y no el de una copia (RI-02).
pub(crate) const SQL_LINEAS_COMANDA: &str = r#"
    SELECT
      D.ID_Detalle, D.ID_Comanda, D.ID_Producto,
      COALESCE(D.Cantidad, 1) AS Cantidad,
      COALESCE(D.Precio_Unitario, 0) AS Precio_Unitario,
      D.Notas, D.Estado_Cocina,
      COALESCE(D.Nombre_Producto, P.Nombre, 'Producto') AS Nombre,
      COALESCE(cat.Pasa_Cocina, 0) AS Pasa_Cocina,
      D.IVA_Percent,
      CASE WHEN EXISTS (
        SELECT 1 FROM v_lineas_cobradas pd WHERE pd.ID_Detalle = D.ID_Detalle
      ) THEN 1 ELSE 0 END AS Pagado
    FROM Detalle_Comanda D
    LEFT JOIN Productos P ON P.ID_Producto = D.ID_Producto
    LEFT JOIN Categorias_Producto cat ON cat.ID_Categoria = P.ID_Categoria
    WHERE D.ID_Comanda = ?1
    ORDER BY D.ID_Detalle ASC;
"#;

/// El plano de mesas: pendiente de cobro y de cocina de cada comanda abierta. Constante para que
/// `planes::tests` vigile el plan de ESTA sentencia (RI-02).
pub(crate) const SQL_MESAS_META_ALL: &str = r#"
    SELECT
      c.ID_Mesa, c.ID_Comanda,
      (
        SELECT IFNULL(SUM(CAST(ROUND(dc.Precio_Unitario * COALESCE(dc.Cantidad,1)) AS INTEGER)), 0)
        FROM Detalle_Comanda dc
        WHERE dc.ID_Comanda = c.ID_Comanda AND NOT EXISTS (SELECT 1 FROM v_lineas_cobradas pd WHERE pd.ID_Detalle = dc.ID_Detalle)
      ) AS Total_Pendiente,
      (
        SELECT COUNT(*)
        FROM Detalle_Comanda dc
        WHERE dc.ID_Comanda = c.ID_Comanda AND NOT EXISTS (SELECT 1 FROM v_lineas_cobradas pd WHERE pd.ID_Detalle = dc.ID_Detalle)
      ) AS Pendientes_Pago,
      (
        SELECT COUNT(*)
        FROM Detalle_Comanda dc
        JOIN Productos p ON p.ID_Producto = dc.ID_Producto
        JOIN Categorias_Producto cat ON cat.ID_Categoria = p.ID_Categoria
        WHERE dc.ID_Comanda = c.ID_Comanda
          AND NOT EXISTS (SELECT 1 FROM v_lineas_cobradas pd WHERE pd.ID_Detalle = dc.ID_Detalle)
          AND COALESCE(cat.Pasa_Cocina, 0) = 1
          AND COALESCE(dc.Estado_Cocina,'PENDIENTE') <> 'PREPARADO'
      ) AS Pendientes_Cocina
    FROM Comandas c
    WHERE c.Estado = 'Abierta';
"#;

/// Las reservas vivas con mesa, de las que el plano elige la de cada mesa
/// (`tpv_domain::reservas::reserva_de_cada_mesa`). El mismo texto que `SQL_RESERVAS_DEL_PLANO` en el
/// worker (`domains/mesas/mesas.queries.ts`), que es el plano de la Handy (MESAS-02).
pub(crate) const SQL_RESERVAS_DEL_PLANO: &str = r#"
    SELECT
      R.ID_Mesa, R.ID_Reserva, R.Dia_YMD, R.Hora, R.Estado, C.Nombre AS Cliente_Nombre,
      COALESCE(R.Duracion_Min,
               (SELECT Reserva_Duracion_Min FROM Business_Settings WHERE ID = 1), ?1) AS Duracion_Min
    FROM Reservas R
    -- RI-61: LEFT, porque una reserva puede no tener cliente y con un JOIN la mesa
    -- aparecía libre en el plano.
    LEFT JOIN Clientes C ON C.ID_Cliente = R.ID_Cliente
    WHERE R.ID_Mesa IS NOT NULL AND R.Estado IN ('PROXIMA','ACTIVA');
"#;

/// El tablero de cocina: líneas de cocina de las comandas de los dos últimos días que aún tienen
/// algo sin preparar. Se refresca con cada línea que se añade en cualquier sitio.
///
/// RI-18: empieza por `Comandas` (el `CROSS JOIN` fija el orden de las tablas en SQLite) y
/// compara la fecha tal cual, sin `datetime()`, para entrar por `idx_comandas_apertura`. Sin las
/// dos cosas recorría todas las líneas de la historia. Lo vigila `planes::tests`.
///
/// RI-69: la mesa va con `LEFT JOIN` porque un ticket de barra no tiene (`Canal = 'BARRA'`), y
/// con `JOIN` la comida vendida en barra no llegaba nunca a cocina. Sin mesa, `Numero_Mesa` sale
/// `NULL` y el tablero la rotula «Barra». `Productos` sí puede ir con `JOIN`: un producto con
/// líneas de comanda no se borra, se archiva (`SQL_QUITAR_PRODUCTO`).
pub(crate) const SQL_COCINA_PENDIENTE: &str = r#"
    SELECT
      c.ID_Comanda, m.Numero_Mesa, c.Fecha_Hora_Apertura,
      dc.ID_Detalle, COALESCE(dc.Cantidad,1) AS Cantidad,
      p.Nombre AS Nombre_Producto, dc.Notas,
      COALESCE(dc.Estado_Cocina,'PENDIENTE') AS Estado_Cocina,
      CASE WHEN EXISTS (
        SELECT 1 FROM v_lineas_cobradas pd WHERE pd.ID_Detalle = dc.ID_Detalle
      ) THEN 1 ELSE 0 END AS Pagado
    FROM Comandas c
    CROSS JOIN Detalle_Comanda dc ON dc.ID_Comanda = c.ID_Comanda
    LEFT JOIN Mesas m ON m.ID_Mesa = c.ID_Mesa
    JOIN Productos p ON p.ID_Producto = dc.ID_Producto
    JOIN Categorias_Producto cat ON cat.ID_Categoria = p.ID_Categoria
    WHERE COALESCE(cat.Pasa_Cocina, 0) = 1
      AND c.Fecha_Hora_Apertura >= datetime('now','localtime','-2 days')
      AND EXISTS (
        SELECT 1
        FROM Detalle_Comanda dc2
        JOIN Productos p2 ON p2.ID_Producto = dc2.ID_Producto
        JOIN Categorias_Producto cat2 ON cat2.ID_Categoria = p2.ID_Categoria
        WHERE dc2.ID_Comanda = c.ID_Comanda
          AND COALESCE(cat2.Pasa_Cocina, 0) = 1
          AND COALESCE(dc2.Estado_Cocina,'PENDIENTE') <> 'PREPARADO'
      )
    ORDER BY c.Fecha_Hora_Apertura ASC, c.ID_Comanda ASC, dc.ID_Detalle ASC;
"#;

#[async_trait]
impl MesasRepository for SqliteMesasRepository {
    /* ===== LAYOUT ===== */

    async fn save_layout(&self, salons: Vec<SalonInput>) -> AppResult<()> {
        // MESAS-01: la misma validación que el worker, por donde guarda la Handy.
        let zonas: Vec<tpv_domain::mesas::ZonaDelPlano<'_>> = salons
            .iter()
            .map(|z| tpv_domain::mesas::ZonaDelPlano {
                nombre: &z.name,
                mesas: z.tables.iter().map(|t| t.name.as_str()).collect(),
            })
            .collect();
        tpv_domain::mesas::validar_plano(&zonas).map_err(AppError::validation)?;

        // IDs de zonas existentes que el editor conserva (llegan con prefijo "db-zona-").
        let kept_zone_ids: Vec<String> = salons
            .iter()
            .filter_map(|z| parse_db_id(&z.id, "db-zona-"))
            .collect();

        // Cláusula reutilizable "... AND ID_Zona NOT IN (las conservadas)" + su argumento. DO-01: la
        // lista va entera en UN parámetro (`lista_json`), no en uno por zona.
        let not_in_clause = if kept_zone_ids.is_empty() {
            ""
        } else {
            " AND ID_Zona NOT IN (SELECT value FROM json_each(?1))"
        };
        let kept_args: Vec<Value> = if kept_zone_ids.is_empty() {
            Vec::new()
        } else {
            vec![lista_json(&kept_zone_ids)]
        };

        let g = self.db.write().await;
        let db = &g;

        let res: AppResult<()> = db.transaccion(async {
            // ── 1. Quitar las zonas borradas en el editor (las que ya no llegan) ─────────
            // RI-54: primero sus mesas (archivadas si tienen historia, borradas si no), y luego la
            // zona: archivada si le quedan mesas archivadas, borrada si no le queda ninguna. Una
            // mesa con una comanda abierta se queda, y con ella su zona.
            for sql in sql_quitar_mesas(&format!("1 = 1{not_in_clause}")) {
                db.execute(&sql, kept_args.clone()).await.map_err(db_err)?;
            }
            db.execute(
                &format!(
                    r#"UPDATE Zonas SET Archivada_En = datetime('now','localtime')
                       WHERE 1 = 1{not_in_clause}
                         AND Archivada_En IS NULL
                         AND EXISTS (SELECT 1 FROM Mesas M WHERE M.ID_Zona = Zonas.ID_Zona)
                         AND NOT EXISTS (
                           SELECT 1 FROM Mesas M WHERE M.ID_Zona = Zonas.ID_Zona AND M.Archivada_En IS NULL
                         );"#
                ),
                kept_args.clone(),
            )
            .await
            .map_err(db_err)?;
            db.execute(
                &format!(
                    r#"DELETE FROM Zonas
                       WHERE 1 = 1{not_in_clause}
                         AND NOT EXISTS (SELECT 1 FROM Mesas M WHERE M.ID_Zona = Zonas.ID_Zona);"#
                ),
                kept_args.clone(),
            )
            .await
            .map_err(db_err)?;

            // ── 2. Aparcar los nombres de las zonas conservadas a un valor temporal único ──
            // Libera los nombres reales para que los UPDATE de la fase 3 no choquen de forma
            // transitoria con el UNIQUE(Nombre_Zona) al renombrar/intercambiar zonas existentes.
            if !kept_zone_ids.is_empty() {
                db.execute(
                    "UPDATE Zonas SET Nombre_Zona = '__tmp_zona_' || ID_Zona \
                     WHERE ID_Zona IN (SELECT value FROM json_each(?1));",
                    kept_args.clone(),
                )
                .await
                .map_err(db_err)?;
            }

            // ── 3. Upsert de cada zona del editor + reconciliación de sus mesas ──────────
            for z in salons.iter() {
                let zone_name = z.name.trim().to_string();
                let points_json = serde_json::to_string(&z.room.points).map_err(db_err)?;

                let zone_id: String = if let Some(id_zona) = parse_db_id(&z.id, "db-zona-") {
                    // Zona existente (aparcada en la fase 2): fija su nombre real y los puntos.
                    db.execute(
                        r#"
                        UPDATE Zonas
                        SET Nombre_Zona = ?2, Room_Points = ?3, Updated_At = datetime('now','localtime')
                        WHERE ID_Zona = ?1;
                        "#,
                        vec![
                            Value::Text(id_zona.clone()),
                            Value::Text(zone_name.clone()),
                            Value::Text(points_json.clone()),
                        ],
                    )
                    .await
                    .map_err(db_err)?;
                    id_zona
                } else {
                    // Zona nueva: upsert por NOMBRE. Si el nombre ya existe (p. ej. una zona
                    // que sobrevivió a un borrado por tener mesas), NO choca con el UNIQUE:
                    // reutiliza esa zona en vez de crashear ("no pasa nada"). Mismo criterio
                    // que la nube (mesas.commands.ts).
                    let new_zone_id = new_id();
                    db.execute(
                        r#"
                        INSERT INTO Zonas (ID_Zona, Nombre_Zona, Room_Points, Updated_At)
                        VALUES (?1, ?2, ?3, datetime('now','localtime'))
                        ON CONFLICT(Nombre_Zona) WHERE Archivada_En IS NULL DO UPDATE SET
                          Room_Points = excluded.Room_Points,
                          Updated_At = excluded.Updated_At;
                        "#,
                        vec![
                            Value::Text(new_zone_id.clone()),
                            Value::Text(zone_name.clone()),
                            Value::Text(points_json.clone()),
                        ],
                    )
                    .await
                    .map_err(db_err)?;

                    // Resolver el ID real por nombre: si hubo conflicto es el de la zona
                    // existente (así las mesas se cuelgan de un ID_Zona que sí existe → sin FK rota).
                    let mut rows = db
                        .query(
                            "SELECT ID_Zona FROM Zonas WHERE Nombre_Zona = ?1 AND Archivada_En IS NULL LIMIT 1;",
                            vec![Value::Text(zone_name.clone())],
                        )
                        .await
                        .map_err(db_err)?;
                    match rows.next().await.map_err(db_err)? {
                        Some(r) => match r.get_value(0).map_err(db_err)? {
                            Value::Text(s) => s,
                            _ => new_zone_id,
                        },
                        None => new_zone_id,
                    }
                };

                let mut kept: Vec<String> = vec![];
                for t in z.tables.iter() {
                    if let Some(idm) = parse_db_id(&t.id, "db-mesa-") {
                        if !idm.trim().is_empty() {
                            kept.push(idm);
                        }
                    }
                }

                // DO-01: las mesas conservadas, en un solo parámetro (una zona puede tener cientos).
                let mut filtro = String::from("ID_Zona = ?1");
                let mut sql_args: Vec<Value> = vec![Value::Text(zone_id.clone())];
                if !kept.is_empty() {
                    filtro.push_str(" AND ID_Mesa NOT IN (SELECT value FROM json_each(?2))");
                    sql_args.push(lista_json(&kept));
                }
                for sql in sql_quitar_mesas(&filtro) {
                    db.execute(&sql, sql_args.clone()).await.map_err(db_err)?;
                }

                for t in z.tables.iter() {
                    let id_mesa_opt = parse_db_id(&t.id, "db-mesa-");
                    let numero_mesa = t.name.trim().to_string();
                    let capacidad = if t.seats > 0 { t.seats } else { 4 };
                    let x = t.x;
                    let y = t.y;
                    let shape = if t.shape.trim().is_empty() {
                        "rounded".to_string()
                    } else {
                        t.shape.trim().to_string()
                    };
                    let width = if t.width > 0 { t.width } else { 120 };
                    let height = if t.height > 0 { t.height } else { 70 };
                    let radius = t.radius;

                    if let Some(id_mesa) = id_mesa_opt {
                        db.execute(
                            r#"
                            UPDATE Mesas
                            SET
                              ID_Zona = ?1, Numero_Mesa = ?2, Capacidad = ?3,
                              Ubicacion_X = ?4, Ubicacion_Y = ?5,
                              Shape = ?6, Width = ?7, Height = ?8, Radius = ?9,
                              Updated_At = datetime('now','localtime')
                            WHERE ID_Mesa = ?10;
                            "#,
                            vec![
                                Value::Text(zone_id.clone()),
                                Value::Text(numero_mesa),
                                Value::Integer(capacidad),
                                Value::Integer(x),
                                Value::Integer(y),
                                Value::Text(shape),
                                Value::Integer(width),
                                Value::Integer(height),
                                radius.map(Value::Integer).unwrap_or(Value::Null),
                                Value::Text(id_mesa),
                            ],
                        )
                        .await
                        .map_err(db_err)?;
                    } else {
                        db.execute(
                            r#"
                            INSERT INTO Mesas (
                              ID_Mesa, ID_Zona, Numero_Mesa, Capacidad,
                              Ubicacion_X, Ubicacion_Y,
                              Shape, Width, Height, Radius,
                              Updated_At
                            )
                            VALUES (
                              ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
                              datetime('now','localtime')
                            )
                            ON CONFLICT(ID_Zona, Numero_Mesa) WHERE Archivada_En IS NULL DO UPDATE SET
                              Capacidad   = excluded.Capacidad,
                              Ubicacion_X = excluded.Ubicacion_X,
                              Ubicacion_Y = excluded.Ubicacion_Y,
                              Shape       = excluded.Shape,
                              Width       = excluded.Width,
                              Height      = excluded.Height,
                              Radius      = excluded.Radius,
                              Updated_At  = excluded.Updated_At;
                            "#,
                            vec![
                                Value::Text(new_id()),
                                Value::Text(zone_id.clone()),
                                Value::Text(numero_mesa),
                                Value::Integer(capacidad),
                                Value::Integer(x),
                                Value::Integer(y),
                                Value::Text(shape),
                                Value::Integer(width),
                                Value::Integer(height),
                                radius.map(Value::Integer).unwrap_or(Value::Null),
                            ],
                        )
                        .await
                        .map_err(db_err)?;
                    }
                }
            }
            Ok(())
        }).await;

        res
    }

    async fn load_layout(&self) -> AppResult<Vec<SalonOut>> {
        let g = self.db.read().await;
        let db = &g;

        let mut zonas = db
            .query(
                // RI-54: lo archivado ya no está en el plano.
                "SELECT ID_Zona, Nombre_Zona, Room_Points FROM Zonas WHERE Archivada_En IS NULL ORDER BY ID_Zona ASC;",
                (),
            )
            .await
            .map_err(db_err)?;

        let mut mesas_rows = db
            .query(
                r#"
                SELECT ID_Mesa, ID_Zona, Numero_Mesa, Capacidad,
                       Ubicacion_X, Ubicacion_Y, Shape, Width, Height, Radius
                FROM Mesas
                WHERE Archivada_En IS NULL
                ORDER BY ID_Zona ASC, ID_Mesa ASC;
                "#,
                (),
            )
            .await
            .map_err(db_err)?;

        let mut by_zona: HashMap<String, Vec<TableOut>> = HashMap::new();

        while let Some(r) = mesas_rows.next().await.map_err(db_err)? {
            let id_mesa = match r.get_value(0).map_err(db_err)? {
                Value::Text(s) => s,
                _ => continue,
            };
            let id_zona = match r.get_value(1).map_err(db_err)? {
                Value::Text(s) => s,
                _ => continue,
            };
            let numero = match r.get_value(2).map_err(db_err)? {
                Value::Text(s) => s,
                _ => format!("Mesa {id_mesa}"),
            };
            let cap = match r.get_value(3).map_err(db_err)? {
                Value::Integer(n) => n,
                _ => 4,
            };
            let x = match r.get_value(4).map_err(db_err)? {
                Value::Integer(n) => n,
                _ => 0,
            };
            let y = match r.get_value(5).map_err(db_err)? {
                Value::Integer(n) => n,
                _ => 0,
            };
            let shape = match r.get_value(6).map_err(db_err)? {
                Value::Text(s) => s,
                _ => "rounded".into(),
            };
            let w = match r.get_value(7).map_err(db_err)? {
                Value::Integer(n) => n,
                _ => 120,
            };
            let h = match r.get_value(8).map_err(db_err)? {
                Value::Integer(n) => n,
                _ => 70,
            };
            let radius = match r.get_value(9).map_err(db_err)? {
                Value::Integer(n) => Some(n),
                _ => None,
            };

            by_zona.entry(id_zona).or_default().push(TableOut {
                id: format!("db-mesa-{id_mesa}"),
                name: numero,
                x,
                y,
                width: w,
                height: h,
                radius,
                seats: cap,
                shape,
            });
        }

        let mut out: Vec<SalonOut> = vec![];

        while let Some(z) = zonas.next().await.map_err(db_err)? {
            let id_zona = match z.get_value(0).map_err(db_err)? {
                Value::Text(s) => s,
                _ => continue,
            };
            let nombre = match z.get_value(1).map_err(db_err)? {
                Value::Text(s) => s,
                _ => format!("Zona {id_zona}"),
            };
            let room_points_raw = match z.get_value(2).map_err(db_err)? {
                Value::Text(s) => s,
                _ => "[]".into(),
            };
            let points: Vec<f64> = serde_json::from_str(&room_points_raw).unwrap_or_default();

            out.push(SalonOut {
                id: format!("db-zona-{id_zona}"),
                name: nombre,
                room: RoomPoly {
                    kind: "poly".into(),
                    points,
                },
                tables: by_zona.remove(&id_zona).unwrap_or_default(),
            });
        }

        Ok(out)
    }


    /* ===== RESERVAS ===== */

    async fn set_reserva_estado(&self, id_reserva: &str, estado: tpv_domain::estados::EstadoReserva) -> AppResult<()> {
        let g = self.db.write().await;
        let db = &g;

        let res: AppResult<()> = db.transaccion(async {
            // Se decide aquí, con la reserva como está ahora: la mesa abierta enseña una foto, y
            // mientras tanto el cliente pudo cancelarla o pasar a «No vino». Se replica la escritura
            // sin condición, como siempre.
            let actual = select_one_string(
                db,
                "SELECT Estado FROM Reservas WHERE ID_Reserva = ?1;",
                vec![Value::Text(id_reserva.to_string())],
            )
            .await?;
            let escribir = tpv_domain::reservas::cambio_desde_la_mesa(actual.as_deref(), estado)
                .map_err(AppError::conflict)?;
            if !escribir {
                return Ok(());
            }
            db.execute(
                "UPDATE Reservas SET Estado=?2 WHERE ID_Reserva=?1;",
                vec![Value::Text(id_reserva.to_string()), Value::Text(estado.como_texto().to_string())],
            )
            .await
            .map_err(db_err)?;

            if matches!(estado, tpv_domain::estados::EstadoReserva::Finalizada | tpv_domain::estados::EstadoReserva::Cancelada | tpv_domain::estados::EstadoReserva::NoShow) {
                db.execute(
                    "UPDATE Comandas SET ID_Reserva = NULL WHERE ID_Reserva = ?1;",
                    vec![Value::Text(id_reserva.to_string())],
                )
                .await
                .map_err(db_err)?;
            }
            Ok(())
        }).await;

        res
    }

    /* ===== COMANDAS (mesa) ===== */

    async fn get_comanda_abierta_by_mesa(&self, id_mesa: &str) -> AppResult<Option<ComandaRow>> {
        let g = self.db.read().await;
        let db = &g;
        if id_mesa.trim().is_empty() {
            return Ok(None);
        }
        let bare_id = parse_db_id(id_mesa, "db-mesa-").unwrap_or_else(|| id_mesa.to_string());
        let id = select_one_string(
            db,
            r#"
            SELECT ID_Comanda FROM Comandas
            WHERE ID_Mesa = ?1 AND Estado = 'Abierta'
            ORDER BY datetime(Fecha_Hora_Apertura) DESC, ID_Comanda DESC LIMIT 1;
            "#,
            vec![Value::Text(bare_id)],
        )
        .await?;
        match id {
            Some(id_comanda) => read_comanda_by_id(db, &id_comanda).await,
            None => Ok(None),
        }
    }

    async fn abrir_comanda(&self, data: AbrirComandaData) -> AppResult<Option<ComandaRow>> {
        let g = self.db.write().await;
        let db = &g;
        let bare_id_mesa =
            parse_db_id(&data.id_mesa, "db-mesa-").unwrap_or_else(|| data.id_mesa.clone());

        // MESA-03: apertura idempotente por mesa. Si ya hay una comanda Abierta en la mesa,
        // la devolvemos en vez de crear una segunda (evita comandas duplicadas por doble
        // toque o apertura concurrente Main+Handy).
        if let Some(existing) = comanda_abierta_de(db, &bare_id_mesa).await? {
            return read_comanda_by_id(db, &existing).await;
        }
        insertar_comanda(db, &bare_id_mesa, data.id_trabajador_o_usuario, data.id_reserva).await?;

        // Devolvemos la comanda abierta de la mesa: la recién creada o, si hubo carrera, la
        // que ya existía.
        match comanda_abierta_de(db, &bare_id_mesa).await? {
            Some(id) => read_comanda_by_id(db, &id).await,
            None => Ok(None),
        }
    }

    async fn abrir_o_retomar_comanda(
        &self,
        data: AbrirComandaData,
    ) -> AppResult<Option<ComandaConLineasOut>> {
        let bare_id_mesa =
            parse_db_id(&data.id_mesa, "db-mesa-").unwrap_or_else(|| data.id_mesa.clone());
        // Lo mismo que `get_comanda_abierta_by_mesa` + `comanda_set_trabajador_if_null` o
        // `abrir_comanda` + `get_lineas_comanda`, que es lo que hacía la pantalla, con el escritor
        // cogido una vez. Espejo de `/v1/mesas/comandas/abrir-o-retomar` en el worker.
        let comanda = {
            let g = self.db.write().await;
            let db = &g;
            let id = match comanda_abierta_de(db, &bare_id_mesa).await? {
                Some(id) => {
                    poner_trabajador_si_falta(db, &id, data.id_trabajador_o_usuario).await?;
                    Some(id)
                }
                None => {
                    insertar_comanda(db, &bare_id_mesa, data.id_trabajador_o_usuario, data.id_reserva)
                        .await?;
                    comanda_abierta_de(db, &bare_id_mesa).await?
                }
            };
            match id {
                Some(id) => read_comanda_by_id(db, &id).await?,
                None => None,
            }
        };
        let Some(comanda) = comanda else { return Ok(None) };
        let lineas = self.get_lineas_comanda(&comanda.id_comanda).await?;
        Ok(Some(ComandaConLineasOut { comanda, lineas }))
    }

    async fn comanda_set_trabajador_if_null(
        &self,
        id_comanda: &str,
        id_trab_o_usuario: Option<String>,
    ) -> AppResult<bool> {
        let g = self.db.write().await;
        poner_trabajador_si_falta(&g, id_comanda, id_trab_o_usuario).await
    }

    async fn comanda_set_reserva_if_null(&self, id_comanda: &str, id_reserva: &str) -> AppResult<bool> {
        let g = self.db.write().await;
        let changed = g
            .execute(
                r#"
                UPDATE Comandas
                SET ID_Reserva = ?2
                WHERE ID_Comanda = ?1
                  AND Estado = 'Abierta'
                  AND ID_Reserva IS NULL
                  AND EXISTS (SELECT 1 FROM Reservas WHERE ID_Reserva = ?2);
                "#,
                vec![Value::Text(id_comanda.to_string()), Value::Text(id_reserva.to_string())],
            )
            .await
            .map_err(db_err)?;

        Ok(changed > 0)
    }

    async fn get_lineas_comanda(&self, id_comanda: &str) -> AppResult<Vec<MesaLineaComandaRow>> {
        let g = self.db.read().await;
        let db = &g;
        let mut rows = db
            .query(
                SQL_LINEAS_COMANDA,
                vec![Value::Text(id_comanda.to_string())],
            )
            .await
            .map_err(db_err)?;

        let mut out: Vec<MesaLineaComandaRow> = vec![];
        while let Some(r) = rows.next().await.map_err(db_err)? {
            let id_detalle = v_string(r.get_value(0).map_err(db_err)?).unwrap_or_default();
            if id_detalle.is_empty() {
                continue;
            }
            out.push(MesaLineaComandaRow {
                id_detalle,
                id_comanda: v_string(r.get_value(1).map_err(db_err)?).unwrap_or_default(),
                id_producto: v_string(r.get_value(2).map_err(db_err)?).unwrap_or_default(),
                cantidad: v_f64(r.get_value(3).map_err(db_err)?).unwrap_or(1.0),
                precio_unitario: v_dinero(r.get_value(4).map_err(db_err)?).unwrap_or(Dinero::CERO),
                notas: v_string(r.get_value(5).map_err(db_err)?),
                estado_cocina: v_string(r.get_value(6).map_err(db_err)?),
                nombre: v_string(r.get_value(7).map_err(db_err)?).unwrap_or_default(),
                pasa_cocina: v_i64(r.get_value(8).map_err(db_err)?).unwrap_or(0),
                iva_percent: v_f64(r.get_value(9).map_err(db_err)?),
                pagado: v_i64(r.get_value(10).map_err(db_err)?).unwrap_or(0),
            });
        }
        Ok(out)
    }

    async fn add_linea_comanda(
        &self,
        id_comanda: &str,
        id_producto: &str,
        cantidad: f64,
        id_trab_o_usuario: Option<String>,
    ) -> AppResult<Vec<MesaLineaComandaRow>> {
        {
        let g = self.db.write().await;
        let db = &g;

        let res: AppResult<()> = db.transaccion(async {
            exigir_comanda_abierta(db, id_comanda).await?;
            let id_trabajador_real = resolve_trabajador_id_input(db, id_trab_o_usuario).await?;
            if let Some(idt) = id_trabajador_real {
                db.execute(
                    r#"
                    UPDATE Comandas
                    SET ID_Trabajador = ?2
                    WHERE ID_Comanda = ?1
                      AND Estado = 'Abierta'
                      AND ID_Trabajador IS NULL;
                    "#,
                    vec![Value::Text(id_comanda.to_string()), Value::Text(idt)],
                )
                .await
                .map_err(db_err)?;
            }

            let pasa = select_one_i64(
                db,
                r#"
                SELECT COALESCE(cat.Pasa_Cocina, 0)
                FROM Productos p
                JOIN Categorias_Producto cat ON cat.ID_Categoria = p.ID_Categoria
                WHERE p.ID_Producto = ?1 LIMIT 1;
                "#,
                vec![Value::Text(id_producto.to_string())],
            )
            .await?
            .unwrap_or(0)
                == 1;

            let estado_cocina = if pasa {
                Value::Text("PENDIENTE".into())
            } else {
                Value::Null
            };

            let producto = snapshot_del_producto(db, id_producto).await?;

            db.execute(
                r#"
                INSERT INTO Detalle_Comanda (
                  ID_Detalle, ID_Comanda, ID_Producto, Nombre_Producto, Cantidad, Precio_Unitario,
                  Estado_Cocina, IVA_Percent
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8);
                "#,
                vec![
                    Value::Text(new_id()),
                    Value::Text(id_comanda.to_string()),
                    Value::Text(id_producto.to_string()),
                    producto.nombre,
                    Value::Real(cantidad),
                    dinero_val(producto.precio),
                    estado_cocina,
                    producto.iva,
                ],
            )
            .await
            .map_err(db_err)?;

            db.execute(update_total_comanda_sql(), vec![Value::Text(id_comanda.to_string())])
                .await
                .map_err(db_err)?;
            Ok(())
        }).await;

        res?;
        } // WriteGuard se suelta aquí → la pool de lectura puede actuar
        self.get_lineas_comanda(id_comanda).await
    }

    /* ===== META + CATÁLOGO ===== */

    async fn mesas_meta_all(&self) -> AppResult<HashMap<String, MesaMetaOut>> {
        let g = self.db.read().await;
        let db = &g;

        let mut rows = db
            .query(
                SQL_MESAS_META_ALL,
                (),
            )
            .await
            .map_err(db_err)?;

        let mut map: HashMap<String, MesaMetaOut> = HashMap::new();
        while let Some(r) = rows.next().await.map_err(db_err)? {
            let id_mesa = v_string(r.get_value(0).map_err(db_err)?).unwrap_or_default();
            let id_comanda = v_string(r.get_value(1).map_err(db_err)?).unwrap_or_default();
            if id_mesa.is_empty() || id_comanda.is_empty() {
                continue;
            }
            let total_pendiente = v_dinero(r.get_value(2).map_err(db_err)?).unwrap_or(Dinero::CERO);
            let pendientes_pago = v_i64(r.get_value(3).map_err(db_err)?).unwrap_or(0);
            let pendientes_cocina = v_i64(r.get_value(4).map_err(db_err)?).unwrap_or(0);

            let estado = if pendientes_pago > 0 || total_pendiente > Dinero::CERO {
                "PENDIENTE".to_string()
            } else {
                "LIBRE".to_string()
            };

            map.insert(
                id_mesa,
                MesaMetaOut {
                    ocupada: true,
                    idComanda: id_comanda.clone(),
                    id_comanda,
                    totalPendiente: total_pendiente,
                    pendientesPago: pendientes_pago,
                    pendientesCocina: pendientes_cocina,
                    estado,
                    reserva: None,
                },
            );
        }

        let mut rrows = db
            .query(SQL_RESERVAS_DEL_PLANO, vec![Value::Integer(tpv_domain::reservas::DURACION_POR_DEFECTO_MIN)])
            .await
            .map_err(db_err)?;
        let mut reservas = Vec::new();
        while let Some(r) = rrows.next().await.map_err(db_err)? {
            reservas.push(tpv_domain::reservas::ReservaDeMesa {
                id_mesa: v_string(r.get_value(0).map_err(db_err)?).unwrap_or_default(),
                id_reserva: v_string(r.get_value(1).map_err(db_err)?).unwrap_or_default(),
                dia_ymd: v_string(r.get_value(2).map_err(db_err)?).unwrap_or_default(),
                hora: v_string(r.get_value(3).map_err(db_err)?).unwrap_or_default(),
                estado: v_string(r.get_value(4).map_err(db_err)?).unwrap_or_default(),
                cliente: v_string(r.get_value(5).map_err(db_err)?).unwrap_or_default(),
                duracion_min: v_i64(r.get_value(6).map_err(db_err)?),
            });
        }

        // MESAS-02: la misma regla que el plano de la Handy, con la zona de este equipo.
        let instante = |local: chrono::NaiveDateTime| Local.from_local_datetime(&local).earliest().map(|d| d.timestamp());
        for (id_mesa, r) in tpv_domain::reservas::reserva_de_cada_mesa(reservas, Local::now().timestamp(), instante) {
            let reserva = ReservaMesaOut {
                id_reserva: r.reserva.id_reserva,
                cliente_nombre: r.reserva.cliente,
                dia_ymd: r.reserva.dia_ymd,
                hora: r.reserva.hora,
                estado: r.estado.to_string(),
                minutos_para: r.minutos_para,
            };
            map.entry(id_mesa)
                .and_modify(|m| m.reserva = Some(reserva.clone()))
                .or_insert_with(|| MesaMetaOut {
                    ocupada: false,
                    id_comanda: String::new(),
                    idComanda: String::new(),
                    totalPendiente: Dinero::CERO,
                    pendientesPago: 0,
                    pendientesCocina: 0,
                    estado: "LIBRE".into(),
                    reserva: Some(reserva),
                });
        }

        Ok(map)
    }

    async fn list_categorias_vendibles(&self) -> AppResult<Vec<CategoriaVendibleOut>> {
        let g = self.db.read().await;
        let db = &g;

        // INC-20261030-005: la categoría no vendible (materia prima) no sale en la venta, igual que
        // en la venta rápida. Es lo que promete el interruptor «¿Esta categoría es vendible?».
        let sql1 = r#"
            SELECT ID_Categoria, Nombre, Ruta_Imagen, COALESCE(Pasa_Cocina,0)
            FROM Categorias_Producto WHERE COALESCE(Vendible,1)=1 ORDER BY Nombre ASC;
        "#;

        let mut rows = db.query(sql1, ()).await.map_err(db_err)?;

        let mut out = vec![];
        while let Some(r) = rows.next().await.map_err(db_err)? {
            out.push(CategoriaVendibleOut {
                id_categoria: v_string(r.get_value(0).map_err(db_err)?).unwrap_or_default(),
                nombre: v_string(r.get_value(1).map_err(db_err)?).unwrap_or_default(),
                ruta_imagen: v_string(r.get_value(2).map_err(db_err)?),
                pasa_cocina: v_i64(r.get_value(3).map_err(db_err)?).unwrap_or(0),
            });
        }
        Ok(out)
    }

    async fn list_productos_by_categoria(
        &self,
        id_categoria: &str,
    ) -> AppResult<Vec<ProductoVendibleOut>> {
        let g = self.db.read().await;
        let db = &g;
        let sql1 = r#"
            SELECT ID_Producto, ID_Categoria, Nombre, COALESCE(Precio_Venta,0), Ruta_Imagen
            FROM Productos WHERE ID_Categoria = ?1 AND Archivado_En IS NULL ORDER BY Nombre ASC;
        "#;
        productos_query(db, sql1, vec![Value::Text(id_categoria.to_string())]).await
    }

    async fn search_productos_by_nombre(&self, q: String) -> AppResult<Vec<ProductoVendibleOut>> {
        let Some(needle) = crate::busqueda::texto_a_buscar(&q) else {
            return Ok(vec![]);
        };
        let g = self.db.read().await;
        let db = &g;
        // INC-20261030-005: el buscador tampoco ofrece productos de una categoría no vendible.
        //
        // Sin acentos ni mayúsculas (`crate::busqueda`), como en el worker (`searchProductos` de
        // `mesas.queries.ts`). Con `instr` y no `LIKE`: allí el SQLite del Durable Object no admite
        // un patrón de `LIKE` de más de 50 bytes, y en un patrón el `%` y el `_` que teclea el
        // usuario son comodines.
        let sql1 = format!(
            r#"
            SELECT p.ID_Producto, p.ID_Categoria, p.Nombre, COALESCE(p.Precio_Venta,0), p.Ruta_Imagen
            FROM Productos p
            JOIN Categorias_Producto c ON c.ID_Categoria = p.ID_Categoria
            WHERE instr({}, ?1) > 0 AND p.Archivado_En IS NULL AND COALESCE(c.Vendible,1)=1
            ORDER BY p.Nombre ASC LIMIT 200;
        "#,
            crate::busqueda::normalizada("p.Nombre")
        );
        productos_query(db, &sql1, vec![Value::Text(needle)]).await
    }

    /* ===== TICKET (detalles) ===== */

    async fn remove_one_pending_detalle(
        &self,
        id_comanda: &str,
        id_producto: &str,
    ) -> AppResult<()> {
        let g = self.db.write().await;
        let db = &g;

        let res: AppResult<()> = db.transaccion(async {
            // RI-59: «la última» es la de clave mayor (UUIDv7, también las del worker), pero antes
            // una que cocina no haya preparado: quitar una ya hecha descuadra lo que hay en el pase.
            db.execute(
                r#"
                DELETE FROM Detalle_Comanda
                WHERE ID_Detalle = (
                  SELECT dc.ID_Detalle
                  FROM Detalle_Comanda dc
                  WHERE dc.ID_Comanda = ?1
                    AND dc.ID_Producto = ?2
                    AND NOT EXISTS (SELECT 1 FROM v_lineas_cobradas pd WHERE pd.ID_Detalle = dc.ID_Detalle)
                  ORDER BY (COALESCE(dc.Estado_Cocina,'PENDIENTE') = 'PREPARADO') ASC, dc.ID_Detalle DESC LIMIT 1
                );
                "#,
                vec![Value::Text(id_comanda.to_string()), Value::Text(id_producto.to_string())],
            )
            .await
            .map_err(db_err)?;

            db.execute(update_total_comanda_sql(), vec![Value::Text(id_comanda.to_string())])
                .await
                .map_err(db_err)?;
            Ok(())
        }).await;

        res
    }

    async fn delete_detalle(&self, id_detalle: &str) -> AppResult<()> {
        let g = self.db.write().await;
        let db = &g;

        let res: AppResult<()> = db.transaccion(async {
            // RI-11: el id es un UUID de texto. Leído como entero daba `None` y el total no se
            // recalculaba nunca; lo vigila el caso de contrato `mesas__delete_detalle`.
            let id_comanda = select_one_string(
                db,
                "SELECT ID_Comanda FROM Detalle_Comanda WHERE ID_Detalle=?1 LIMIT 1;",
                vec![Value::Text(id_detalle.to_string())],
            )
            .await?;

            db.execute(
                r#"
                DELETE FROM Detalle_Comanda
                WHERE ID_Detalle = ?1
                  AND NOT EXISTS (
                    SELECT 1 FROM v_lineas_cobradas pd WHERE pd.ID_Detalle = Detalle_Comanda.ID_Detalle
                  );
                "#,
                vec![Value::Text(id_detalle.to_string())],
            )
            .await
            .map_err(db_err)?;

            if let Some(idc) = id_comanda {
                db.execute(update_total_comanda_sql(), vec![Value::Text(idc)])
                    .await
                    .map_err(db_err)?;
            }
            Ok(())
        }).await;

        res
    }

    async fn update_detalle_nota(&self, id_detalle: &str, nota: Option<String>) -> AppResult<()> {
        let g = self.db.write().await;
        let db = &g;
        db.execute(
            r#"
            UPDATE Detalle_Comanda
            SET Notas = ?2
            WHERE ID_Detalle = ?1
              AND NOT EXISTS (
                SELECT 1 FROM v_lineas_cobradas pd WHERE pd.ID_Detalle = Detalle_Comanda.ID_Detalle
              );
            "#,
            vec![
                Value::Text(id_detalle.to_string()),
                nota.map(Value::Text).unwrap_or(Value::Null),
            ],
        )
        .await
        .map_err(db_err)?;
        Ok(())
    }

    async fn cobrar_detalles(&self, data: CobroDetalles) -> AppResult<String> {
        let g = self.db.write().await;
        let db = &g;
        let ids = data.detalle_ids.clone();

        let res: AppResult<String> = db.transaccion(async {
            let id_trabajador_cobrador = resolve_trabajador_id_input(db, data.id_usuario.clone()).await?;

            // DO-01: las líneas que se cobran van en UN parámetro (un array JSON), no en uno por
            // línea: la sentencia que enlaza `Pago_Detalles` se replica, y con más de 98 líneas
            // pasaba de los 100 parámetros que admite la nube. Las lecturas usan la misma lista.
            let lista_ids = lista_json(&ids);
            let count_args: Vec<Value> = vec![Value::Text(data.id_comanda.clone()), lista_ids.clone()];

            let sql_count = r#"
                SELECT COUNT(*)
                FROM Detalle_Comanda dc
                WHERE dc.ID_Comanda = ?1
                  AND dc.ID_Detalle IN (SELECT value FROM json_each(?2))
                  AND NOT EXISTS (SELECT 1 FROM v_lineas_cobradas pd WHERE pd.ID_Detalle = dc.ID_Detalle);
                "#;
            let count = select_one_i64(db, sql_count, count_args.clone())
                .await?
                .unwrap_or(0);

            if count as usize != ids.len() {
                return Err(AppError::conflict(
                    "Algunos detalles no existen, no pertenecen a la comanda o ya están pagados.",
                ));
            }

            let sql_sum = r#"
                SELECT IFNULL(SUM(CAST(ROUND(COALESCE(dc.Cantidad,1) * COALESCE(dc.Precio_Unitario,0)) AS INTEGER)), 0)
                FROM Detalle_Comanda dc
                WHERE dc.ID_Comanda = ?1
                  AND dc.ID_Detalle IN (SELECT value FROM json_each(?2))
                  AND NOT EXISTS (SELECT 1 FROM v_lineas_cobradas pd WHERE pd.ID_Detalle = dc.ID_Detalle);
                "#;
            let total = select_one_dinero(db, sql_sum, count_args.clone())
                .await?
                .unwrap_or(Dinero::CERO);
            // AUD-17: un cobro negativo sería dinero que sale del cajón con el arqueo cuadrado (el
            // esperado baja lo mismo que falta). Como en la barra, se rechaza; uno de 0 € (una
            // invitación) sí entra. Va antes de reservar el número, y la transacción no deja nada.
            if total.es_negativo() {
                return Err(AppError::validation("El importe no puede ser negativo."));
            }

            // Numero correlativo del ticket: se reserva aqui y viaja como literal en el pago,
            // para que una reimpresion saque el mismo papel.
            // El número se reserva DENTRO de la transacción: si el cobro hace ROLLBACK, no se gasta
            // (y el registro fiscal tampoco llega a existir).
            let numero_reservado = crate::verifactu::reservar_numero_factura(db).await?;
            let numero_ticket = numero_reservado.0.clone();
            // FISCAL-02: se captura aquí porque `data` se consume al construir los parámetros.
            let destinatario = data.destinatario.clone();
            let id_pago = new_id();
            let trabajador_mov = id_trabajador_cobrador.clone();
            db.execute(r#"
                INSERT INTO Pagos (
                  ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo,
                  ID_Usuario_Cobrador, ID_Trabajador_Cobrador, Numero_Ticket
                )
                VALUES (?1, ?2, datetime('now','localtime'), ?3, ?4, ?5, ?6, ?7, ?8);
                "#,
                vec![
                    Value::Text(id_pago.clone()),
                    Value::Text(data.id_comanda.clone()),
                    Value::Text(data.metodo.to_string()),
                    dinero_val(total),
                    Value::Text(data.tipo.clone()),
                    data.id_usuario.clone().map(Value::Text).unwrap_or(Value::Null),
                    id_trabajador_cobrador.map(Value::Text).unwrap_or(Value::Null),
                    Value::Text(numero_ticket.clone()),
                ],
            ).await.map_err(db_err)?;


            // El cobro en el historial de caja (CUENTA-07). A diferencia del gasto del cliente
            // de aquí abajo, esto NO es best-effort: un cobro cuyo movimiento no se anota es
            // justo el que después no se puede investigar.
            caja_movimientos::registrar(
                db,
                MovimientoCaja {
                    tipo: caja_movimientos::TIPO_COBRO,
                    id_pago: Some(id_pago.clone()),
                    id_usuario: data.id_usuario.clone(),
                    id_trabajador: trabajador_mov,
                    importe: total,
                    metodo_pago: Some(data.metodo.to_string()),
                    ..Default::default()
                },
            )
            .await?;

            if let Err(e) = sumar_gasto_cliente_por_comanda(db, &data.id_comanda, total).await {
                // MESA-06: best-effort — el pago commitea igualmente (Total_Gastado es
                // reconciliable), pero el fallo se reporta por telemetría (tracing → Sentry),
                // no se traga en silencio con un eprintln perdido.
                tracing::warn!(
                    target: "tpv::mesas",
                    id_comanda = %data.id_comanda,
                    importe = total.centimos(),
                    error = %e,
                    "sumar_gasto_cliente_por_comanda falló; pago commiteado sin actualizar Total_Gastado"
                );
            }

            db.execute(
                r#"
                INSERT OR IGNORE INTO Pago_Detalles (ID_Pago, ID_Detalle)
                SELECT ?1, dc.ID_Detalle
                FROM Detalle_Comanda dc
                WHERE dc.ID_Comanda = ?2
                  AND dc.ID_Detalle IN (SELECT value FROM json_each(?3))
                  AND NOT EXISTS (SELECT 1 FROM v_lineas_cobradas pd WHERE pd.ID_Detalle = dc.ID_Detalle);
                "#,
                vec![
                    Value::Text(id_pago.clone()),
                    Value::Text(data.id_comanda.clone()),
                    lista_ids,
                ],
            )
            .await
            .map_err(db_err)?;

            // MESA-01: descuento de stock/lotes (FEFO) de las líneas recién cobradas. Todas
            // las de `ids` estaban pendientes (validado por el count previo), así que se
            // consumen exactamente una vez.
            let mut charged: Vec<(String, String, f64)> = Vec::new();
            {
                let mut crows = db
                    .query(
                        r#"
                        SELECT dc.ID_Detalle, dc.ID_Producto, CAST(COALESCE(dc.Cantidad,1) AS REAL)
                        FROM Detalle_Comanda dc
                        WHERE dc.ID_Comanda = ?1
                          AND dc.ID_Detalle IN (SELECT value FROM json_each(?2))
                        ORDER BY dc.ID_Detalle;
                        "#,
                        count_args.clone(),
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
            crate::consumo_stock::consumir_stock(db, &id_pago, &charged).await?;

            // FISCAL-01. Dentro de la transacción del cobro y después de enlazar `Pago_Detalles`,
            // que es de donde sale el desglose de IVA del registro.
            crate::verifactu::emitir_cobro(db, &id_pago, numero_reservado, total, destinatario)
                .await?;

            let pending_left = select_one_i64(
                db,
                r#"
                SELECT COUNT(*)
                FROM Detalle_Comanda dc
                WHERE dc.ID_Comanda = ?1 AND NOT EXISTS (SELECT 1 FROM v_lineas_cobradas pd WHERE pd.ID_Detalle = dc.ID_Detalle);
                "#,
                vec![Value::Text(data.id_comanda.clone())],
            )
            .await?
            .unwrap_or(0);

            if pending_left == 0 {
                db.execute(
                    r#"
                    UPDATE Comandas
                    SET
                      Estado = 'Pagada',
                      Total_Comanda = (
                        SELECT IFNULL(SUM(CAST(ROUND(COALESCE(Cantidad,1) * COALESCE(Precio_Unitario,0)) AS INTEGER)), 0)
                        FROM Detalle_Comanda WHERE ID_Comanda = ?1
                      ),
                      Fecha_Hora_Cierre = datetime('now','localtime')
                    WHERE ID_Comanda = ?1;
                    "#,
                    vec![Value::Text(data.id_comanda.clone())],
                )
                .await
                .map_err(db_err)?;
            } else {
                db.execute(update_total_comanda_sql(), vec![Value::Text(data.id_comanda.clone())])
                    .await
                    .map_err(db_err)?;
            }
            // RI-29: la pantalla pide el ticket por el pago, no por el número.
            Ok(id_pago)
        }).await;

        res
    }

    /* ===== COCINA ===== */

    async fn kitchen_list_today_pending(&self) -> AppResult<Vec<KitchenRow>> {
        let g = self.db.read().await;
        let db = &g;
        let mut rows = db
            .query(
                SQL_COCINA_PENDIENTE,
                (),
            )
            .await
            .map_err(db_err)?;

        let mut out: Vec<KitchenRow> = vec![];
        while let Some(r) = rows.next().await.map_err(db_err)? {
            out.push(KitchenRow {
                id_comanda: v_string(r.get_value(0).map_err(db_err)?).unwrap_or_default(),
                numero_mesa: v_string(r.get_value(1).map_err(db_err)?),
                fecha_hora_apertura: v_string(r.get_value(2).map_err(db_err)?).unwrap_or_default(),
                id_detalle: v_string(r.get_value(3).map_err(db_err)?).unwrap_or_default(),
                cantidad: v_f64(r.get_value(4).map_err(db_err)?).unwrap_or(1.0),
                nombre_producto: v_string(r.get_value(5).map_err(db_err)?).unwrap_or_default(),
                notas: v_string(r.get_value(6).map_err(db_err)?),
                estado_cocina: v_string(r.get_value(7).map_err(db_err)?),
                pagado: v_i64(r.get_value(8).map_err(db_err)?).unwrap_or(0),
            });
        }
        Ok(out)
    }

    async fn kitchen_set_line_state(
        &self,
        id_detalle: &str,
        id_usuario_cocinero: &str,
        estado: tpv_domain::estados::EstadoCocina,
    ) -> AppResult<()> {
        let g = self.db.write().await;
        let db = &g;

        if estado == tpv_domain::estados::EstadoCocina::Preparado {
            db.execute(r#"
                UPDATE Detalle_Comanda
                SET
                  Estado_Cocina = 'PREPARADO',
                  ID_Usuario_Cocinero = COALESCE(ID_Usuario_Cocinero, ?2),
                  Fecha_Hora_Cocina   = COALESCE(Fecha_Hora_Cocina, datetime('now','localtime'))
                WHERE ID_Detalle = ?1;
                "#,
                vec![Value::Text(id_detalle.to_string()), Value::Text(id_usuario_cocinero.to_string())],
            ).await.map_err(db_err)?;

        } else {
            db.execute(r#"
                UPDATE Detalle_Comanda
                SET Estado_Cocina = 'PENDIENTE', ID_Usuario_Cocinero = NULL, Fecha_Hora_Cocina = NULL
                WHERE ID_Detalle = ?1;
                "#,
                vec![Value::Text(id_detalle.to_string())],
            ).await.map_err(db_err)?;

        }
        Ok(())
    }
}

/// Helper de catálogo del esquema vigente.
async fn productos_query<C: Reader>(
    db: &C,
    sql1: &str,
    args: Vec<Value>,
) -> AppResult<Vec<ProductoVendibleOut>> {
    let mut rows = db.query(sql1, args).await.map_err(db_err)?;

    let mut out = vec![];
    while let Some(r) = rows.next().await.map_err(db_err)? {
        out.push(ProductoVendibleOut {
            id_producto: v_string(r.get_value(0).map_err(db_err)?).unwrap_or_default(),
            id_categoria: v_string(r.get_value(1).map_err(db_err)?).unwrap_or_default(),
            nombre: v_string(r.get_value(2).map_err(db_err)?).unwrap_or_default(),
            precio_venta: v_dinero(r.get_value(3).map_err(db_err)?).unwrap_or(Dinero::CERO),
            ruta_imagen: v_string(r.get_value(4).map_err(db_err)?),
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests_numero_ticket {
    //! El número que va impreso en el ticket, que desde FISCAL-01 **es el número de la factura**.
    //!
    //! Sigue siendo lo que permite atar un papel a su cobro —para una devolución, para cuadrar un
    //! arqueo o para el cliente que vuelve a reclamar— y una reimpresión sigue teniendo que sacar
    //! el mismo. Lo que cambia es lo que ese número significa: ahora es el `Num_Serie_Factura` del
    //! registro de facturación, con serie por ejercicio y reinicio anual.
    //!
    //! Y aparece una obligación que el contador de tickets no tenía: **no puede repetir un número
    //! ya emitido**. La clave única de una factura ante la AEAT es (emisor, número, fecha), y un
    //! duplicado es un registro que no entra (error 3000).

    use super::*;
    use crate::db::Db;

    async fn db_temporal() -> (Arc<Db>, std::path::PathBuf) {
        let dir = crate::test_temp::dir_temporal("numero_ticket");
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        (db, dir)
    }

    /// La serie del ejercicio en curso, que es lo que prefija todos los números.
    fn serie() -> String {
        chrono::Local::now().format("%Y").to_string()
    }

    #[tokio::test]
    async fn empieza_en_uno_y_no_repite() {
        let (db, _dir) = db_temporal().await;
        let g = db.write().await;
        let s = serie();

        assert_eq!(crate::verifactu::reservar_numero_factura(&g).await.unwrap().0, format!("{s}/000001"));
        assert_eq!(crate::verifactu::reservar_numero_factura(&g).await.unwrap().0, format!("{s}/000002"));
        assert_eq!(crate::verifactu::reservar_numero_factura(&g).await.unwrap().0, format!("{s}/000003"));
    }

    #[tokio::test]
    async fn el_formato_deja_sitio_para_crecer() {
        // Seis dígitos con ceros a la izquierda: dentro de una serie salen ordenables como texto,
        // que es como se leen en un listado. Al pasar del millón simplemente crece, no se rompe.
        let (db, _dir) = db_temporal().await;
        let g = db.write().await;
        let s = serie();

        g.execute(
            "INSERT OR REPLACE INTO Serie_Facturacion (Serie, Ultimo) VALUES (?1, 999999);",
            vec![Value::Text(s.clone())],
        )
        .await
        .unwrap();

        assert_eq!(crate::verifactu::reservar_numero_factura(&g).await.unwrap().0, format!("{s}/1000000"));
    }

    #[tokio::test]
    async fn anular_un_cobro_no_devuelve_el_numero_a_la_cola() {
        // El contador es propio, no un `SELECT MAX(...)` de los cobros. Si saliera de ahí, anular
        // el último haría que el siguiente ticket repitiera número: dos ventas distintas con el
        // mismo número es lo que convierte un arqueo en una discusión — y ahora, además, una
        // factura que la AEAT rechaza por duplicada.
        let (db, _dir) = db_temporal().await;
        let g = db.write().await;
        let s = serie();

        assert_eq!(crate::verifactu::reservar_numero_factura(&g).await.unwrap().0, format!("{s}/000001"));
        assert_eq!(crate::verifactu::reservar_numero_factura(&g).await.unwrap().0, format!("{s}/000002"));
        assert_eq!(crate::verifactu::reservar_numero_factura(&g).await.unwrap().0, format!("{s}/000003"));
    }

    #[tokio::test]
    async fn el_contador_sobrevive_a_cerrar_la_aplicacion() {
        // Vive en la BD, no en memoria: apagar el TPV por la noche no puede reiniciar la
        // numeración del día siguiente.
        let dir = crate::test_temp::dir_temporal("contador_persistente");
        std::fs::create_dir_all(&dir).unwrap();
        let ruta = dir.join("data.db").to_str().unwrap().to_string();
        let s = serie();

        {
            let db = Db::open(&ruta).await.unwrap();
            let g = db.write().await;
            crate::verifactu::reservar_numero_factura(&g).await.unwrap();
            crate::verifactu::reservar_numero_factura(&g).await.unwrap();
            drop(g);
            db.cerrar().await.unwrap();
        }

        let db = Db::open(&ruta).await.unwrap();
        let g = db.write().await;
        assert_eq!(crate::verifactu::reservar_numero_factura(&g).await.unwrap().0, format!("{s}/000003"));
    }

    #[tokio::test]
    async fn el_contador_se_replica_a_la_nube_con_el_numero_ya_puesto() {
        // La sentencia que sale al outbox es `Ultimo = Ultimo + 1`, RELATIVA: si fuera
        // `Ultimo = 7` y la nube la aplicara con otro estado, los contadores se separarían. Lo que
        // no puede pasar es que el número del papel se decida dos veces.
        let (db, _dir) = db_temporal().await;
        {
            let g = db.write().await;
            crate::verifactu::reservar_numero_factura(&g).await.unwrap();
        }

        let r = db.read().await;
        let mut rows = r
            .query(
                "SELECT Statements_Json FROM _Sync_Outbox \
                 WHERE Statements_Json LIKE '%Serie_Facturacion%' \
                   AND Statements_Json LIKE '%UPDATE%';",
                Vec::<Value>::new(),
            )
            .await
            .unwrap();
        let fila = rows.next().await.unwrap().expect("la subida del contador");
        let sql = crate::mapping::v_string(fila.get_value(0).unwrap()).unwrap_or_default();

        assert!(sql.contains("Ultimo + 1"), "la sentencia replicada no es relativa: {sql}");
    }

    #[tokio::test]
    async fn el_contador_salta_hacia_adelante_si_va_por_detras_de_lo_ya_emitido() {
        // El caso que este salto existe para cubrir: restaurar una copia local de hace tres días
        // devuelve el contador a un número YA EMITIDO. Volver a darlo sería una factura duplicada
        // (error 3000) y un registro que no entra. Un hueco en la numeración es explicable; un
        // número repetido no. SE FALLA HACIA EL HUECO.
        let (db, _dir) = db_temporal().await;
        let g = db.write().await;
        let s = serie();

        // Hay registros emitidos hasta el 500...
        g.execute(
            "INSERT INTO Registros_Facturacion (ID_Registro, Orden, Tipo, NIF_Emisor, \
               Num_Serie_Factura, Fecha_Expedicion, Serie, Numero, Nombre_Razon_Emisor, \
               Cadena_Huella, Huella, Fecha_Hora_Huso, Sistema_Json, QR_Url) \
             VALUES ('r1', 1, 'ALTA', 'B12345674', ?2, '01-01-2027', ?1, 500, 'X', 'c', 'h', \
                     '2027-01-01T00:00:00+01:00', '{}', 'u');",
            vec![Value::Text(s.clone()), Value::Text(format!("{s}/000500"))],
        )
        .await
        .unwrap();

        // ...pero el contador se quedó en el 3 (la copia restaurada es más antigua).
        g.execute(
            "INSERT OR REPLACE INTO Serie_Facturacion (Serie, Ultimo) VALUES (?1, 3);",
            vec![Value::Text(s.clone())],
        )
        .await
        .unwrap();

        assert_eq!(crate::verifactu::reservar_numero_factura(&g).await.unwrap().0, format!("{s}/000501"));
    }

    #[tokio::test]
    async fn el_salto_del_contador_es_idempotente() {
        // Se escribe con `MAX(Ultimo, ?)` y no con un `=`: aplicado dos veces da lo mismo, y
        // aplicado en la nube sobre un valor MÁS ALTO no lo baja. Un `=` replicado convertiría la
        // reparación en el problema que venía a reparar.
        let (db, _dir) = db_temporal().await;
        let g = db.write().await;
        let s = serie();

        g.execute(
            "INSERT OR REPLACE INTO Serie_Facturacion (Serie, Ultimo) VALUES (?1, 900);",
            vec![Value::Text(s.clone())],
        )
        .await
        .unwrap();
        g.execute(
            "UPDATE Serie_Facturacion SET Ultimo = MAX(Ultimo, ?2) WHERE Serie = ?1;",
            vec![Value::Text(s.clone()), Value::Integer(100)],
        )
        .await
        .unwrap();

        assert_eq!(crate::verifactu::reservar_numero_factura(&g).await.unwrap().0, format!("{s}/000901"));
    }
}

#[cfg(test)]
mod tests_snapshot_de_la_linea {
    //! De dónde salen el nombre y el tipo de IVA de cada línea.
    //!
    //! Se leen del producto en el momento de la venta y se **congelan** en `Detalle_Comanda`. Es lo
    //! que hace que una reimpresión de hace tres meses siga enseñando lo que se vendió entonces —y
    //! no lo de hoy— y lo que permite que el catálogo borre un producto sin dejar muda su venta.

    use super::*;
    use crate::db::Db;
    use crate::ejecutor::Connection;

    async fn db_temporal() -> (Arc<Db>, std::path::PathBuf) {
        let dir = crate::test_temp::dir_temporal("iva_linea");
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        (db, dir)
    }

    async fn sembrar(db: &Arc<Db>, sentencias: &[&str]) {
        let w = db.write().await;
        let conn: &Connection = w.raw();
        for sql in sentencias {
            conn.execute(sql, Vec::<Value>::new())
                .await
                .unwrap_or_else(|e| panic!("sembrando: {sql}\n{e}"));
        }
    }

    const CATALOGO: &[&str] = &[
        "INSERT INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('cat', 'Bar');",
        // Con tipo propio: una botella para llevar.
        "INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta, IVA_Percent)
           VALUES ('con', 'cat', 'Vino para llevar', 1200, 21);",
        // Sin tipo propio: hereda el del negocio.
        "INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta)
           VALUES ('sin', 'cat', 'Cafe', 130);",
    ];

    #[tokio::test]
    async fn un_producto_con_tipo_propio_lo_aporta() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, CATALOGO).await;
        let r = db.read().await;

        assert_eq!(snapshot_del_producto(&r, "con").await.unwrap().iva, Value::Real(21.0));
    }

    #[tokio::test]
    async fn un_producto_sin_tipo_deja_la_linea_en_nulo() {
        // NULL significa "el del negocio". Poner aquí un 10 por defecto congelaría en la línea un
        // tipo que el usuario no ha elegido, y cambiar el del negocio ya no afectaría a nada.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, CATALOGO).await;
        let r = db.read().await;

        assert_eq!(snapshot_del_producto(&r, "sin").await.unwrap().iva, Value::Null);
    }

    #[tokio::test]
    async fn un_producto_que_no_existe_no_inventa_un_tipo() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, CATALOGO).await;
        let r = db.read().await;

        assert_eq!(snapshot_del_producto(&r, "fantasma").await.unwrap().iva, Value::Null);
    }

    #[tokio::test]
    async fn cambiar_el_tipo_del_producto_no_toca_lo_ya_vendido() {
        // La razón de que el tipo se copie a la línea en vez de consultarse al imprimir.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, CATALOGO).await;

        let antes = {
            let r = db.read().await;
            snapshot_del_producto(&r, "con").await.unwrap().iva
        };
        sembrar(&db, &["UPDATE Productos SET IVA_Percent = 10 WHERE ID_Producto = 'con';"]).await;
        let despues = {
            let r = db.read().await;
            snapshot_del_producto(&r, "con").await.unwrap().iva
        };

        assert_eq!(antes, Value::Real(21.0));
        assert_eq!(despues, Value::Real(10.0), "las ventas nuevas sí usan el tipo nuevo");
    }

    #[tokio::test]
    async fn la_linea_nueva_lleva_el_precio_del_catalogo_de_ese_momento() {
        // RI-27: la pantalla mandaba el precio de su carta en caché, y tras subir el café otro
        // puesto lo seguía vendiendo al de antes. Ahora no lo manda: se lee aquí.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, CATALOGO).await;
        sembrar(&db, &["UPDATE Productos SET Precio_Venta = 140 WHERE ID_Producto = 'sin';"]).await;
        sembrar(
            &db,
            &["INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre) VALUES ('gratis', 'cat', 'Agua');"],
        )
        .await;
        let r = db.read().await;

        assert_eq!(snapshot_del_producto(&r, "sin").await.unwrap().precio, Dinero::de_centimos(140));
        assert_eq!(
            snapshot_del_producto(&r, "gratis").await.unwrap().precio,
            Dinero::CERO,
            "sin precio se vende a 0 €"
        );
    }
}

#[cfg(test)]
mod tests_comanda_cobrada {
    //! INC-20261030-016: una comanda cobrada no admite líneas nuevas, ni desde Mesas ni desde la
    //! barra. Una pantalla con la comanda de antes del cobro las metía en la `Pagada`, donde nadie
    //! las iba a cobrar.

    use super::*;
    use crate::db::Db;
    use crate::ejecutor::Connection;
    use crate::venta_rapida::SqliteVentaRapidaRepository;
    use tpv_application::ports::venta_rapida::VentaRapidaRepository;

    async fn db_sembrada() -> (Arc<Db>, std::path::PathBuf) {
        let dir = crate::test_temp::dir_temporal("comanda_cobrada");
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        {
            let w = db.write().await;
            let conn: &Connection = w.raw();
            for sql in [
                "INSERT INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('cat', 'Bar');",
                "INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta)
                   VALUES ('cafe', 'cat', 'Cafe', 130);",
                "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z', 'Sala');",
                "INSERT INTO Mesas (ID_Mesa, ID_Zona, Numero_Mesa, Capacidad, Ubicacion_X, Ubicacion_Y, Shape, Width, Height)
                   VALUES ('m', 'z', '1', 4, 0, 0, 'rect', 80, 80);",
                "INSERT INTO Comandas (ID_Comanda, ID_Mesa, Canal, Fecha_Hora_Apertura, Fecha_Hora_Cierre, Estado)
                   VALUES ('mesa_cobrada', 'm', 'MESA', '2026-10-30 23:00:00', '2026-10-30 23:30:00', 'Pagada');",
                "INSERT INTO Comandas (ID_Comanda, ID_Mesa, Canal, Fecha_Hora_Apertura, Estado)
                   VALUES ('mesa_abierta', 'm', 'MESA', '2026-10-30 23:35:00', 'Abierta');",
                "INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura, Fecha_Hora_Cierre, Estado)
                   VALUES ('barra_cobrada', 'BARRA', '2026-10-30 23:00:00', '2026-10-30 23:10:00', 'Pagada');",
            ] {
                conn.execute(sql, Vec::<Value>::new())
                    .await
                    .unwrap_or_else(|e| panic!("sembrando: {sql}\n{e}"));
            }
        }
        (db, dir)
    }

    async fn lineas_de(db: &Arc<Db>, id_comanda: &str) -> i64 {
        let r = db.read().await;
        select_one_i64(
            &r,
            "SELECT COUNT(*) FROM Detalle_Comanda WHERE ID_Comanda = ?1;",
            vec![Value::Text(id_comanda.to_string())],
        )
        .await
        .unwrap()
        .unwrap_or(0)
    }

    fn es_la_comanda_cobrada(e: &AppError) -> bool {
        matches!(e, AppError::Conflict(m) if m == COMANDA_COBRADA)
    }

    #[tokio::test]
    async fn mesas_no_anade_una_linea_a_la_comanda_cobrada() {
        let (db, _dir) = db_sembrada().await;
        let repo = SqliteMesasRepository::new(db.clone());

        let e = repo.add_linea_comanda("mesa_cobrada", "cafe", 1.0, None).await.unwrap_err();
        assert!(es_la_comanda_cobrada(&e), "{e:?}");
        assert_eq!(lineas_de(&db, "mesa_cobrada").await, 0);
    }

    #[tokio::test]
    async fn mesas_sigue_anadiendo_a_la_comanda_abierta() {
        let (db, _dir) = db_sembrada().await;
        let repo = SqliteMesasRepository::new(db.clone());

        repo.add_linea_comanda("mesa_abierta", "cafe", 1.0, None).await.unwrap();
        assert_eq!(lineas_de(&db, "mesa_abierta").await, 1);
    }

    #[tokio::test]
    async fn la_barra_no_anade_una_linea_al_ticket_cobrado() {
        let (db, _dir) = db_sembrada().await;
        let repo = SqliteVentaRapidaRepository::new(db.clone());

        let e = repo.add_linea_comanda("barra_cobrada", "cafe", 1.0).await.unwrap_err();
        assert!(es_la_comanda_cobrada(&e), "{e:?}");
        assert_eq!(lineas_de(&db, "barra_cobrada").await, 0);
    }
}

#[cfg(test)]
mod tests_cobro_negativo {
    //! AUD-17: un cobro de mesa en negativo era dinero que salía del cajón con el arqueo cuadrado:
    //! un pago ACTIVO de −50 € en efectivo baja el esperado lo mismo que falta. Venía de una línea con
    //! precio negativo (un producto dado de alta así desde una Handy, que la Main aplica tal cual al
    //! replicar). Se rechaza como en la barra; un cobro de 0 € (una invitación) sigue entrando.

    use super::*;
    use crate::db::Db;
    use crate::ejecutor::Connection;
    use tpv_domain::pago::MetodoPago;

    async fn db_sembrada() -> (Arc<Db>, std::path::PathBuf) {
        let dir = crate::test_temp::dir_temporal("cobro_negativo");
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        {
            let w = db.write().await;
            let conn: &Connection = w.raw();
            for sql in [
                // Con NIF: sin él no se emite el registro y no se cobra nada.
                "UPDATE Business_Settings SET CIF = 'B12345674', Razon_Social = 'Bar de Pruebas SL' WHERE ID = 1;",
                "INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre)
                   VALUES ('u1', '00000000-0000-7000-8000-000000000001', 'jefe@bar.example', 'x', 'Marta');",
                "INSERT INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('cat', 'Bar');",
                "INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta) VALUES ('ajuste', 'cat', 'Ajuste', -5000);",
                "INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta) VALUES ('agua', 'cat', 'Agua', 0);",
                "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z', 'Sala');",
                "INSERT INTO Mesas (ID_Mesa, ID_Zona, Numero_Mesa, Capacidad, Ubicacion_X, Ubicacion_Y, Shape, Width, Height)
                   VALUES ('m', 'z', '1', 4, 0, 0, 'rect', 80, 80);",
                "INSERT INTO Comandas (ID_Comanda, ID_Mesa, Canal, Fecha_Hora_Apertura, Estado, Total_Comanda)
                   VALUES ('com', 'm', 'MESA', '2026-11-08 13:00:00', 'Abierta', -5000);",
                "INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Cantidad, Precio_Unitario, IVA_Percent)
                   VALUES ('det-ajuste', 'com', 'ajuste', 1, -5000, 10);",
                "INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Cantidad, Precio_Unitario, IVA_Percent)
                   VALUES ('det-agua', 'com', 'agua', 1, 0, 10);",
            ] {
                conn.execute(sql, Vec::<Value>::new())
                    .await
                    .unwrap_or_else(|e| panic!("sembrando: {sql}\n{e}"));
            }
        }
        (db, dir)
    }

    async fn contar(db: &Arc<Db>, sql: &str) -> i64 {
        let r = db.read().await;
        select_one_i64(&r, sql, Vec::<Value>::new()).await.unwrap().unwrap_or(0)
    }

    fn cobro(detalle: &str) -> CobroDetalles {
        CobroDetalles {
            id_comanda: "com".into(),
            metodo: MetodoPago::Efectivo,
            tipo: "FRACCIONADO".into(),
            detalle_ids: vec![detalle.into()],
            id_usuario: Some("u1".into()),
            destinatario: None,
        }
    }

    #[tokio::test]
    async fn un_cobro_de_mesa_en_negativo_no_entra_ni_deja_rastro() {
        let (db, _dir) = db_sembrada().await;
        let repo = SqliteMesasRepository::new(db.clone());

        let e = repo.cobrar_detalles(cobro("det-ajuste")).await.unwrap_err();
        assert!(
            matches!(&e, AppError::Validation(m) if m == "El importe no puede ser negativo."),
            "{e:?}"
        );

        // Ni el pago, ni su apunte de caja, ni la factura, ni el número: la transacción no deja nada.
        assert_eq!(contar(&db, "SELECT COUNT(*) FROM Pagos;").await, 0);
        assert_eq!(contar(&db, "SELECT COUNT(*) FROM Movimientos_Caja;").await, 0);
        assert_eq!(contar(&db, "SELECT COUNT(*) FROM Registros_Facturacion;").await, 0);
        assert_eq!(contar(&db, "SELECT COALESCE(MAX(Ultimo), 0) FROM Serie_Facturacion;").await, 0);
        // Y la línea sigue pendiente en la comanda abierta.
        assert_eq!(contar(&db, "SELECT COUNT(*) FROM v_lineas_cobradas;").await, 0);
        assert_eq!(
            contar(&db, "SELECT COUNT(*) FROM Comandas WHERE ID_Comanda = 'com' AND Estado = 'Abierta';").await,
            1
        );
    }

    #[tokio::test]
    async fn un_cobro_de_mesa_a_cero_si_entra() {
        // Una invitación: 0 € no es negativo.
        let (db, _dir) = db_sembrada().await;
        let repo = SqliteMesasRepository::new(db.clone());

        let id_pago = repo.cobrar_detalles(cobro("det-agua")).await.expect("una invitación se cobra");
        assert_eq!(
            contar(&db, &format!("SELECT Importe_Total FROM Pagos WHERE ID_Pago = '{id_pago}' AND Estado = 'ACTIVO';")).await,
            0
        );
    }
}


#[cfg(test)]
mod tests_reservas_en_el_plano {
    //! La reserva que enseña cada mesa en el plano. Antes, una reserva por llegar pasada su hora se
    //! pintaba como sentada y se quedaba para siempre: «El cliente abandona la mesa» en una mesa a la
    //! que nadie había llegado, y sin poder marcar la llegada de quien llegaba tarde.

    use super::*;
    use crate::db::Db;

    /// Una reserva en la mesa `mesa`, a `minutos` de ahora (negativo: ya pasó su hora).
    fn reserva(id: &str, mesa: &str, minutos: i64, estado: &str) -> String {
        let hora = Local::now() + chrono::Duration::minutes(minutos);
        format!(
            "INSERT INTO Reservas (ID_Reserva, ID_Mesa, Dia_YMD, Hora, Turno, Comensales, Estado) \
             VALUES ('{id}', '{mesa}', '{}', '{}', 'CENA', 2, '{estado}');",
            hora.format("%Y-%m-%d"),
            hora.format("%H:%M"),
        )
    }

    #[tokio::test]
    async fn una_por_llegar_sigue_por_llegar_con_retraso_hasta_que_acaba_su_hueco() {
        let dir = crate::test_temp::dir_temporal("reservas_plano");
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        {
            let w = db.write().await;
            let mut sql = String::from("INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1', 'Salon');");
            for m in ["m1", "m2", "m3", "m4", "m5", "m6", "m7"] {
                sql.push_str(&format!(
                    "INSERT INTO Mesas (ID_Mesa, ID_Zona, Numero_Mesa, Capacidad, Ubicacion_X, Ubicacion_Y, \
                     Shape, Width, Height) VALUES ('{m}', 'z1', '{m}', 4, 0, 0, 'rect', 80, 80);"
                ));
            }
            // m1: llega tarde, dentro de sus dos horas. m2: ya acabó su hueco sin que llegara nadie.
            // m3: sentada desde hace horas. m4: dentro de 30 min. m5: dentro de 3 h, aún no sale.
            for s in [
                reserva("tarde", "m1", -30, "PROXIMA"),
                reserva("acabada", "m2", -150, "PROXIMA"),
                reserva("sentada", "m3", -300, "ACTIVA"),
                reserva("pronto", "m4", 30, "PROXIMA"),
                reserva("luego", "m5", 180, "PROXIMA"),
                // m6 y m7: hace hora y media. El negocio da 60 minutos; m7 trae sus 120.
                reserva("del-negocio", "m6", -90, "PROXIMA"),
                reserva("con-la-suya", "m7", -90, "PROXIMA"),
            ] {
                sql.push_str(&s);
            }
            sql.push_str(
                "UPDATE Business_Settings SET Reserva_Duracion_Min = 60 WHERE ID = 1; \
                 UPDATE Reservas SET Duracion_Min = 120 WHERE ID_Reserva = 'con-la-suya'; \
                 INSERT INTO Clientes (ID_Cliente, Nombre) VALUES ('c1', 'Ana'); \
                 UPDATE Reservas SET ID_Cliente = 'c1' WHERE ID_Reserva = 'pronto';",
            );
            w.raw().execute_batch(&sql).await.unwrap();
        }
        let meta = SqliteMesasRepository::new(db).mesas_meta_all().await.unwrap();
        let reserva_de = |m: &str| meta.get(m).and_then(|x| x.reserva.as_ref()).map(|r| (r.id_reserva.as_str(), r.estado.as_str()));

        assert_eq!(reserva_de("m1"), Some(("tarde", "PROXIMA")));
        assert!(meta["m1"].reserva.as_ref().unwrap().minutos_para < 0);
        assert_eq!(reserva_de("m2"), None);
        assert_eq!(reserva_de("m3"), Some(("sentada", "ACTIVA")));
        assert_eq!(reserva_de("m4"), Some(("pronto", "PROXIMA")));
        assert_eq!(meta["m4"].reserva.as_ref().unwrap().cliente_nombre, "Ana");
        assert_eq!(meta["m1"].reserva.as_ref().unwrap().cliente_nombre, "");
        assert_eq!(reserva_de("m5"), None);
        assert_eq!(reserva_de("m6"), None);
        assert_eq!(reserva_de("m7"), Some(("con-la-suya", "PROXIMA")));
        // Una mesa reservada y sin comanda sale libre.
        assert!(!meta["m4"].ocupada);
    }
}

#[cfg(test)]
mod tests_estado_desde_la_mesa {
    //! La mesa abierta enseña una foto de la reserva. Si mientras tanto el cliente la canceló o pasó
    //! a «No vino», marcar que ha llegado la resucitaba: ahora se decide con la reserva como está.

    use super::*;
    use crate::db::Db;
    use tpv_contracts::errors::ErrorCode;
    use tpv_domain::estados::EstadoReserva::{Activa, Finalizada};

    async fn estado(db: &Db, id: &str) -> Option<String> {
        let g = db.read().await;
        let mut rows = g
            .query("SELECT Estado FROM Reservas WHERE ID_Reserva = ?1;", vec![Value::Text(id.into())])
            .await
            .unwrap();
        rows.next().await.unwrap().and_then(|r| v_string(r.get_value(0).unwrap()))
    }

    #[tokio::test]
    async fn no_se_resucita_una_reserva_cancelada_ni_se_reescribe_lo_que_ya_esta() {
        let dir = crate::test_temp::dir_temporal("estado_desde_la_mesa");
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        db.write()
            .await
            .raw()
            .execute_batch(
                "INSERT INTO Reservas (ID_Reserva, Dia_YMD, Hora, Turno, Comensales, Estado) VALUES \
                   ('por-llegar', '2026-05-10', '21:00', 'CENA', 2, 'PROXIMA'), \
                   ('cancelada', '2026-05-10', '21:00', 'CENA', 2, 'CANCELADA'), \
                   ('no-vino', '2026-05-10', '21:00', 'CENA', 2, 'NO_SHOW');",
            )
            .await
            .unwrap();
        let repo = SqliteMesasRepository::new(db.clone());

        for id in ["cancelada", "no-vino", "no-existe"] {
            let e = repo.set_reserva_estado(id, Activa).await.unwrap_err();
            assert_eq!(e.code(), ErrorCode::Conflict, "{id}");
        }
        assert_eq!(estado(&db, "cancelada").await.as_deref(), Some("CANCELADA"));
        assert_eq!(estado(&db, "no-vino").await.as_deref(), Some("NO_SHOW"));

        repo.set_reserva_estado("por-llegar", Activa).await.unwrap();
        assert_eq!(estado(&db, "por-llegar").await.as_deref(), Some("ACTIVA"));
        // Otra vez: ya está, y no se vuelve a escribir.
        let ops = |db: Arc<Db>| async move {
            let g = db.read().await;
            let mut rows = g.query("SELECT COUNT(*) FROM _Sync_Outbox;", ()).await.unwrap();
            v_i64(rows.next().await.unwrap().unwrap().get_value(0).unwrap()).unwrap()
        };
        let antes = ops(db.clone()).await;
        repo.set_reserva_estado("por-llegar", Activa).await.unwrap();
        assert_eq!(ops(db.clone()).await, antes);

        repo.set_reserva_estado("por-llegar", Finalizada).await.unwrap();
        assert_eq!(estado(&db, "por-llegar").await.as_deref(), Some("FINALIZADA"));
    }
}

#[cfg(test)]
mod tests_abrir_o_retomar {
    //! Abrir la mesa en un paso deja lo mismo que los pasos de antes (la abierta, ponerle el
    //! trabajador o abrirla, y las líneas), y lo que no cambia nada no se escribe: una sentencia
    //! que no toca ninguna fila también pasaría por el outbox y se replicaría.

    use super::*;
    use crate::db::Db;

    async fn base() -> Arc<Db> {
        let dir = crate::test_temp::dir_temporal("abrir_o_retomar");
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        db.write()
            .await
            .raw()
            .execute_batch(
                "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1', 'Salon');
                 INSERT INTO Mesas (ID_Mesa, ID_Zona, Numero_Mesa, Capacidad, Ubicacion_X, Ubicacion_Y, Shape, Width, Height)
                   VALUES ('m1', 'z1', '1', 4, 0, 0, 'rect', 80, 80), ('m2', 'z1', '2', 4, 0, 0, 'rect', 80, 80);
                 INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre)
                   VALUES ('u1', '00000000-0000-7000-8000-000000000001', 'ana@bar.example', 'x', 'Ana'),
                          ('u2', '00000000-0000-7000-8000-000000000001', 'luis@bar.example', 'x', 'Luis');
                 INSERT INTO Trabajadores (ID_Trabajador, ID_Usuario) VALUES ('t1', 'u1'), ('t2', 'u2');
                 INSERT INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('cat', 'Bebidas');
                 INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta) VALUES ('cana', 'cat', 'Caña', 200);",
            )
            .await
            .unwrap();
        db
    }

    async fn en_el_outbox(db: &Arc<Db>) -> i64 {
        let g = db.read().await;
        let mut rows = g.query("SELECT COUNT(*) FROM _Sync_Outbox;", ()).await.unwrap();
        v_i64(rows.next().await.unwrap().unwrap().get_value(0).unwrap()).unwrap()
    }

    fn abrir(mesa: &str, quien: &str) -> AbrirComandaData {
        AbrirComandaData { id_mesa: mesa.into(), id_trabajador_o_usuario: Some(quien.into()), id_reserva: None }
    }

    #[tokio::test]
    async fn sin_comanda_la_abre_con_el_trabajador_y_sin_lineas() {
        let db = base().await;
        let repo = SqliteMesasRepository::new(db.clone());
        let r = repo.abrir_o_retomar_comanda(abrir("db-mesa-m1", "u1")).await.unwrap().unwrap();
        assert_eq!((r.comanda.id_mesa.as_str(), r.comanda.id_trabajador.as_deref()), ("m1", Some("t1")));
        assert_eq!(r.comanda.estado, "Abierta");
        assert!(r.lineas.is_empty());
        assert_eq!(en_el_outbox(&db).await, 1, "la apertura, y nada más");
        // Otra vez: la retoma, la misma, sin escribir nada.
        let otra = repo.abrir_o_retomar_comanda(abrir("m1", "u2")).await.unwrap().unwrap();
        assert_eq!(otra.comanda.id_comanda, r.comanda.id_comanda);
        assert_eq!(otra.comanda.id_trabajador.as_deref(), Some("t1"), "ya tenía trabajador");
        assert_eq!(en_el_outbox(&db).await, 1, "retomar una mesa con trabajador no escribe");
    }

    #[tokio::test]
    async fn retoma_la_abierta_con_sus_lineas_y_le_pone_el_trabajador_solo_si_le_faltaba() {
        let db = base().await;
        let repo = SqliteMesasRepository::new(db.clone());
        // Abierta desde otro sitio sin trabajador (una Handy sin sesión de trabajador).
        let abierta = repo
            .abrir_comanda(AbrirComandaData { id_mesa: "m2".into(), id_trabajador_o_usuario: None, id_reserva: None })
            .await
            .unwrap()
            .unwrap();
        let antes = en_el_outbox(&db).await;
        let r = repo.abrir_o_retomar_comanda(abrir("m2", "u2")).await.unwrap().unwrap();
        assert_eq!(r.comanda.id_comanda, abierta.id_comanda);
        assert_eq!(r.comanda.id_trabajador.as_deref(), Some("t2"), "le faltaba: se pone");
        assert_eq!(en_el_outbox(&db).await, antes + 1);

        // Con una línea ya no se le cambia nada, y tampoco se escribe.
        repo.add_linea_comanda(&abierta.id_comanda, "cana", 1.0, None).await.unwrap();
        db.write()
            .await
            .raw()
            .execute("UPDATE Comandas SET ID_Trabajador = NULL WHERE ID_Comanda = ?1;", vec![Value::Text(abierta.id_comanda.clone())])
            .await
            .unwrap();
        let antes = en_el_outbox(&db).await;
        let r = repo.abrir_o_retomar_comanda(abrir("m2", "u1")).await.unwrap().unwrap();
        assert_eq!(r.comanda.id_trabajador, None);
        assert_eq!(r.lineas.len(), 1, "las líneas vienen en el mismo paso");
        assert_eq!(r.lineas[0].id_producto, "cana");
        assert_eq!(en_el_outbox(&db).await, antes, "una comanda con líneas no cambia de trabajador");
    }

    #[tokio::test]
    async fn poner_el_trabajador_a_una_comanda_que_ya_lo_tiene_no_escribe() {
        let db = base().await;
        let repo = SqliteMesasRepository::new(db.clone());
        let c = repo.abrir_comanda(abrir("m1", "u1")).await.unwrap().unwrap();
        let antes = en_el_outbox(&db).await;
        assert!(!repo.comanda_set_trabajador_if_null(&c.id_comanda, Some("u2".into())).await.unwrap());
        assert_eq!(en_el_outbox(&db).await, antes, "un UPDATE que no cambia nada también se replicaría");
        assert_eq!(read_comanda_by_id(&db.read().await, &c.id_comanda).await.unwrap().unwrap().id_trabajador.as_deref(), Some("t1"));
    }
}
