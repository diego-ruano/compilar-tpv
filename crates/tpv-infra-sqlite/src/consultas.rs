//! RI-32: consultas compartidas y errores del adaptador, sin compatibilidad con esquemas antiguos.

use crate::ejecutor::Value;
use tpv_application::error::{AppError, AppResult};
use tpv_domain::dinero::Dinero;
use crate::db::Reader;
use crate::mapping::{v_i64, v_dinero, norm_opt_string};

pub(crate) fn db_err(e: impl std::fmt::Display) -> AppError {
    AppError::repository(e.to_string())
}

pub(crate) async fn select_one_i64<C: Reader>(conn: &C, sql: &str, args: Vec<Value>) -> AppResult<Option<i64>> {
    let mut rows = conn.query(sql, args).await.map_err(db_err)?;
    if let Some(row) = rows.next().await.map_err(db_err)? {
        return Ok(v_i64(row.get_value(0).map_err(db_err)?));
    }
    Ok(None)
}

pub(crate) async fn select_one_string<C: Reader>(
    conn: &C,
    sql: &str,
    args: Vec<Value>,
) -> AppResult<Option<String>> {
    let mut rows = conn.query(sql, args).await.map_err(db_err)?;
    if let Some(row) = rows.next().await.map_err(db_err)? {
        return Ok(norm_opt_string(row.get_value(0).map_err(db_err)?));
    }
    Ok(None)
}

pub(crate) async fn select_one_dinero<C: Reader>(
    conn: &C,
    sql: &str,
    args: Vec<Value>,
) -> AppResult<Option<Dinero>> {
    let mut rows = conn.query(sql, args).await.map_err(db_err)?;
    if let Some(row) = rows.next().await.map_err(db_err)? {
        return Ok(v_dinero(row.get_value(0).map_err(db_err)?));
    }
    Ok(None)
}

pub(crate) async fn exists_by_id<C: Reader>(conn: &C, table: &str, id_col: &str, id: &str) -> AppResult<bool> {
    if id.trim().is_empty() {
        return Ok(false);
    }
    let sql = format!("SELECT 1 FROM {table} WHERE {id_col}=?1 LIMIT 1;");
    Ok(select_one_i64(conn, &sql, vec![Value::Text(id.to_string())])
        .await?
        .is_some())
}

pub(crate) async fn trabajador_id_from_usuario<C: Reader>(
    db: &C,
    id_usuario: Option<String>,
) -> AppResult<Option<String>> {
    let Some(idu) = id_usuario.filter(|s| !s.trim().is_empty()) else {
        return Ok(None);
    };
    select_one_string(
        db,
        "SELECT ID_Trabajador FROM Trabajadores WHERE ID_Usuario=?1 LIMIT 1;",
        vec![Value::Text(idu)],
    )
    .await
}

pub(crate) async fn resolve_trabajador_id_input<C: Reader>(
    db: &C,
    id_maybe: Option<String>,
) -> AppResult<Option<String>> {
    let Some(x) = id_maybe.filter(|s| !s.trim().is_empty()) else {
        return Ok(None);
    };
    if exists_by_id(db, "Trabajadores", "ID_Trabajador", &x).await? {
        return Ok(Some(x));
    }
    trabajador_id_from_usuario(db, Some(x)).await
}

pub(crate) fn update_total_comanda_sql() -> &'static str {
    r#"
    UPDATE Comandas
    SET Total_Comanda = (
      SELECT IFNULL(SUM(CAST(ROUND(COALESCE(Cantidad,1) * COALESCE(Precio_Unitario,0)) AS INTEGER)), 0)
      FROM Detalle_Comanda
      WHERE ID_Comanda = ?1
    )
    WHERE ID_Comanda = ?1;
    "#
}


/// DO-01 · Una lista de tamaño variable, como **un solo** parámetro: un array JSON de textos, para
/// `… IN (SELECT value FROM json_each(?n))`.
///
/// El SQLite del Durable Object, que es donde se aplica lo que sube la Main, admite 100 parámetros
/// por sentencia. Con un `?` por elemento, cobrar una mesa de más de 98 líneas o guardar un plano
/// con una zona de más de 98 mesas daba una sentencia que la nube rechazaba como permanente: la
/// operación acababa apartada y la nube sin esas filas hasta el contraste diario. `json_each`
/// devuelve cada texto como `TEXT`, así que la comparación es la misma que con la lista escrita.
pub(crate) fn lista_json(ids: &[String]) -> Value {
    Value::Text(serde_json::to_string(ids).unwrap_or_else(|_| "[]".to_string()))
}

/// SYN-INC-05 · Lo que se dice cuando «Cobrar todo» llega con la cuenta crecida.
pub(crate) const HAN_ANADIDO_ALGO: &str =
    "Han añadido algo a la cuenta mientras cobrabas. Revisa el total y vuelve a cobrar.";

/// SYN-INC-05 · «Cobrar todo» cobra todo: si a la comanda le queda alguna línea por cobrar que no va
/// en `detalles`, se rechaza con `Conflict`. La pantalla manda la lista de lo que veía al pulsar, y
/// mientras tanto otro equipo pudo añadir una línea (le llega por la réplica): cobrar la lista vieja
/// cerraría la cuenta con esa línea suelta. Se llama con la escritura tomada, en el mismo paso que el
/// cobro, para que nada entre entre la comprobación y el cobro.
pub(crate) async fn exigir_que_se_cobre_todo<C: Reader>(conn: &C, id_comanda: &str, detalles: &[String]) -> AppResult<()> {
    let fuera = select_one_i64(
        conn,
        "SELECT COUNT(*) FROM v_lineas_por_cobrar lp
         WHERE lp.ID_Comanda = ?1
           AND lp.ID_Detalle NOT IN (SELECT value FROM json_each(?2));",
        vec![Value::Text(id_comanda.to_string()), lista_json(detalles)],
    )
    .await?
    .unwrap_or(0);
    if fuera > 0 {
        return Err(AppError::conflict(HAN_ANADIDO_ALGO));
    }
    Ok(())
}
