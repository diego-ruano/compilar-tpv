//! SYNC-36 · Lo que no entró de la bajada: sus datos caducan.
//!
//! Un cambio de la nube que no se puede aplicar aquí acaba, al quinto intento, en cuarentena
//! (`_Sync_Failed`, AUD-18), y una fila ahí es la barrera del contraste con la nube: con ella no se
//! repara nada, porque lo que aquí falta puede ser lo que escribió ese cambio, y repararlo sería
//! borrar arriba lo que una Handy escribió. Por eso no se retira. Pero sus sentencias llevan lo que
//! escribía (nombres, teléfonos, notas de clientes), y no tienen por qué quedarse en el equipo.
//!
//! # Los datos caducan ([`vaciar`])
//!
//! A los 30 días de apartarse (`RETENCION_CUARENTENAS_MS`, la misma que lo apartado de la subida) se
//! vacían sus sentencias y el texto de su error se queda en su clase (`unique (Comandas.ID_Mesa)`).
//! La fila sigue: su operación, su `Seq`, sus intentos, sus fechas y las filas que tocó
//! (`Filas_Json`: tabla y clave primaria, identificadores). Con eso se diagnostica sin datos de nadie
//! y se sigue sabiendo qué hay que traer de la nube, y la barrera sigue en pie.

use tpv_application::error::AppResult;
use tpv_contracts::sync::SqlStatement;

use crate::consultas::db_err;
use crate::db::{Db, Writer};
use crate::ejecutor::{Connection, Value};
use crate::filas_tocadas::{self as tocadas, Tocadas};
use crate::util::now_ms;

/* ===== Los datos caducan ===== */

/// Vacía los datos de lo que no entró de la bajada y lleva en cuarentena desde antes de
/// `antes_de_ms`, y devuelve cuántas. Ver el encabezado.
pub(crate) async fn vaciar(db: &Db, antes_de_ms: i64) -> AppResult<u64> {
    let w = db.write().await;
    let conn: &Connection = w.raw();

    let mut filas = conn
        .query(
            "SELECT Op_Id, Statements_Json, Filas_Json, Last_Error FROM _Sync_Failed \
              WHERE Quarantined = 1 AND Datos_Vaciados_At_Ms IS NULL AND Last_Failed_At_Ms < ?1 \
              ORDER BY Seq;",
            vec![Value::Integer(antes_de_ms)],
        )
        .await
        .map_err(db_err)?;
    let mut pendientes: Vec<(String, String, Option<String>, Option<String>)> = Vec::new();
    while let Some(f) = filas.next().await.map_err(db_err)? {
        let texto = |i| match f.get_value(i) {
            Ok(Value::Text(t)) => Some(t),
            _ => None,
        };
        let Some(op) = texto(0) else { continue };
        pendientes.push((op, texto(1).unwrap_or_default(), texto(2), texto(3)));
    }
    drop(filas);
    if pendientes.is_empty() {
        return Ok(0);
    }

    // Es la última ocasión de saber qué filas tocó: después ya no quedan sentencias.
    let mut vaciadas: Vec<(String, String, Option<String>)> = Vec::with_capacity(pendientes.len());
    for (op, sentencias, filas, error) in pendientes {
        let sabidas = filas.as_deref().map(Tocadas::de_json);
        let filas = match sabidas {
            Some(t) if !t.incierto => t,
            antes => {
                let sentencias: Vec<SqlStatement> = serde_json::from_str(&sentencias).unwrap_or_default();
                let ahora = if sentencias.is_empty() { None } else { Some(tocadas::de_un_cambio(conn, &sentencias).await) };
                match (ahora, antes) {
                    (Some(t), _) if !t.incierto => t,
                    (_, Some(t)) => t,
                    (Some(t), None) => t,
                    (None, None) => Tocadas::incierta(Vec::new()),
                }
            }
        };
        vaciadas.push((op, filas.a_json(), clase_de_error(error.as_deref())));
    }

    let ahora = now_ms();
    conn.transaccion(async {
        let mut n = 0u64;
        for (op, filas, error) in &vaciadas {
            n += conn
                .execute(
                    "UPDATE _Sync_Failed \
                        SET Statements_Json = '[]', Last_Error = ?2, Filas_Json = ?3, Datos_Vaciados_At_Ms = ?4 \
                      WHERE Op_Id = ?1 AND Quarantined = 1 AND Datos_Vaciados_At_Ms IS NULL;",
                    vec![
                        Value::Text(op.clone()),
                        error.clone().map_or(Value::Null, Value::Text),
                        Value::Text(filas.clone()),
                        Value::Integer(ahora),
                    ],
                )
                .await
                .map_err(db_err)?;
        }
        Ok(n)
    })
    .await
}

/// La clase de un error al aplicar un cambio, sin nada de lo que el cambio llevaba: qué restricción
/// saltó y en qué columnas, o qué no existe aquí. Lo que no es de una clase conocida es `otro`. El
/// número de la sentencia que falló, si lo dice.
pub(crate) fn clase_de_error(texto: Option<&str>) -> Option<String> {
    let texto = texto?;
    let nombres = |s: &str| -> Option<String> {
        let s = s.trim();
        (!s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ',' | ' '))).then(|| s.to_owned())
    };
    // El mensaje del motor va entre comillas invertidas (`SQLite failure: `…``).
    let motor = texto
        .find('`')
        .and_then(|i| texto[i + 1..].find('`').map(|j| &texto[i + 1..i + 1 + j]))
        .unwrap_or(texto)
        .trim();
    let con = |clase: &str, resto: &str| match nombres(resto) {
        Some(n) => format!("{clase} ({n})"),
        None => clase.to_owned(),
    };
    let clase = if let Some(r) = motor.strip_prefix("UNIQUE constraint failed:") {
        con("unique", r)
    } else if let Some(r) = motor.strip_prefix("NOT NULL constraint failed:") {
        con("not_null", r)
    } else if motor.starts_with("FOREIGN KEY constraint failed") {
        "foreign_key".to_owned()
    } else if motor.starts_with("CHECK constraint failed") {
        "check".to_owned()
    } else if let Some(r) = motor.strip_prefix("no such table:") {
        con("tabla_desconocida", r)
    } else if let Some(r) = motor.strip_prefix("no such column:") {
        con("columna_desconocida", r)
    } else if let Some(i) = motor.find("has no column named") {
        con("columna_desconocida", &motor[i + "has no column named".len()..])
    } else if motor.starts_with("datatype mismatch") {
        "tipo".to_owned()
    } else if motor.starts_with("RI48:") {
        "trigger (RI48)".to_owned()
    } else if motor.starts_with("horario_") && motor.chars().all(|c| c.is_ascii_lowercase() || c == '_') {
        format!("trigger ({motor})")
    } else {
        "otro".to_owned()
    };
    let sentencia = texto
        .find("sentencia #")
        .map(|i| texto[i + "sentencia #".len()..].chars().take_while(char::is_ascii_digit).collect::<String>())
        .filter(|n| !n.is_empty());
    Some(match sentencia {
        Some(n) => format!("sentencia #{n}: {clase}"),
        None => clase,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::filas_tocadas::FilaTocada;
    use std::sync::Arc;

    async fn base(nombre: &str) -> Arc<Db> {
        let dir = crate::test_temp::dir_temporal(&format!("cuarentenas-bajada-{nombre}"));
        Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap()
    }

    async fn sembrar(db: &Db, sql: &str) {
        let w = db.write().await;
        w.raw().execute_batch(sql).await.unwrap();
    }

    async fn fila(db: &Db, op: &str) -> Vec<Value> {
        let r = db.read().await;
        let mut f = r
            .conn()
            .query(
                "SELECT Statements_Json, Last_Error, Filas_Json, Datos_Vaciados_At_Ms, Quarantined, Attempts, Seq \
                   FROM _Sync_Failed WHERE Op_Id = ?1;",
                vec![Value::Text(op.into())],
            )
            .await
            .unwrap();
        let f = f.next().await.unwrap().expect("la fila sigue");
        (0..7).map(|i| f.get_value(i).unwrap()).collect()
    }

    #[test]
    fn la_clase_de_un_error_no_lleva_nada_de_lo_que_escribia() {
        let casos = [
            ("op a (seq 3) sentencia #2: SQLite failure: `UNIQUE constraint failed: Clientes.Email`", "sentencia #2: unique (Clientes.Email)"),
            ("SQLite failure: `FOREIGN KEY constraint failed`", "foreign_key"),
            ("op a (seq 3) sentencia #0: SQLite failure: `NOT NULL constraint failed: Mesas.ID_Zona`", "sentencia #0: not_null (Mesas.ID_Zona)"),
            ("op a (seq 3) sentencia #1: SQLite failure: `CHECK constraint failed: typeof(Importe) IN ('integer','null')`", "sentencia #1: check"),
            ("op a (seq 3) sentencia #0: SQLite failure: `no such table: Tabla_Nueva`", "sentencia #0: tabla_desconocida (Tabla_Nueva)"),
            ("op a (seq 3) sentencia #0: SQLite failure: `table Clientes has no column named Alias`", "sentencia #0: columna_desconocida (Alias)"),
            ("op a (seq 3) sentencia #0: SQLite failure: `RI48: Reservas.Estado no admitido`", "sentencia #0: trigger (RI48)"),
            ("op a (seq 3) sentencia #0: SQLite failure: `horario_solapado`", "sentencia #0: trigger (horario_solapado)"),
            // Lo que no se conoce no se copia: podría llevar un valor.
            ("op a (seq 3) sentencia #0: SQLite failure: `Ana López 600123456`", "sentencia #0: otro"),
            ("algo raro con Ana", "otro"),
        ];
        for (texto, clase) in casos {
            assert_eq!(clase_de_error(Some(texto)).as_deref(), Some(clase), "{texto}");
        }
        assert_eq!(clase_de_error(None), None);
    }

    #[tokio::test]
    async fn a_los_treinta_dias_se_vacian_sus_datos_y_la_fila_se_queda() {
        let db = base("vaciar").await;
        sembrar(&db, "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1', 'Terraza');").await;
        let sentencias = r#"[{"sql":"INSERT INTO Clientes (ID_Cliente, Nombre, Telefono) VALUES (?1, ?2, ?3);","args":["c1","Ana López","600123456"]}]"#;
        sembrar(
            &db,
            &format!(
                "INSERT INTO _Sync_Failed (Op_Id, Seq, Statements_Json, Attempts, Quarantined, Last_Error, First_Failed_At_Ms, Last_Failed_At_Ms) VALUES
                   ('vieja', 7, '{sentencias}', 5, 1, 'op vieja (seq 7) sentencia #0: SQLite failure: `UNIQUE constraint failed: Clientes.Telefono`', 100, 100),
                   ('reciente', 8, '{sentencias}', 5, 1, 'x', 100, 5000),
                   ('detenida', 9, '{sentencias}', 2, 0, 'x', 100, 100);"
            ),
        )
        .await;

        assert_eq!(vaciar(&db, 1000).await.unwrap(), 1);

        let v = fila(&db, "vieja").await;
        assert_eq!(v[0], Value::Text("[]".into()), "sin sentencias");
        assert_eq!(v[1], Value::Text("sentencia #0: unique (Clientes.Telefono)".into()));
        // Lo que tocó no se sabía (era de antes): se mira por última vez, antes de vaciarla.
        let Value::Text(filas) = &v[2] else { panic!("{v:?}") };
        let t = Tocadas::de_json(filas);
        assert!(!t.incierto, "{filas}");
        assert_eq!(t.filas, vec![FilaTocada { tabla: "Clientes".into(), clave: vec![serde_json::json!("c1")], borrada: false }]);
        assert!(matches!(v[3], Value::Integer(_)));
        assert_eq!((v[4].clone(), v[5].clone(), v[6].clone()), (Value::Integer(1), Value::Integer(5), Value::Integer(7)));
        for (i, valor) in v.iter().enumerate() {
            if let Value::Text(t) = valor {
                assert!(!t.contains("Ana") && !t.contains("600123456"), "columna {i}: {t}");
            }
        }

        // La reciente y la que se está reintentando (sin cuarentena) no se tocan.
        assert_eq!(fila(&db, "reciente").await[0], Value::Text(sentencias.into()));
        assert_eq!(fila(&db, "detenida").await[0], Value::Text(sentencias.into()));
        // Y nada se aplicó: el simulacro no deja la clienta.
        let r = db.read().await;
        let mut f = r.conn().query("SELECT COUNT(*) FROM Clientes;", ()).await.unwrap();
        assert_eq!(f.next().await.unwrap().unwrap().get::<i64>(0).unwrap(), 0);
        drop(f);
        drop(r);

        // Una vez.
        assert_eq!(vaciar(&db, 1000).await.unwrap(), 0);
    }
}
