//! AUD-06 · El sello de la base: de qué negocio es.
//!
//! Una base sólo se usa con la licencia de su negocio (`tpv_domain::licensing::que_hacer_con_la_base`),
//! y de quién es lo dice ella misma, en `_Negocio` (migración `0002`). Va dentro del fichero, así que
//! viaja en cada copia y en cada restauración, y no depende de ninguna nota de fuera que pueda faltar
//! o quedarse a medias.
//!
//! Lo escriben la activación de la licencia (una base sin sello), la apertura de una base sin sello
//! con una licencia guardada (`connection::init_main_db`) y la reconstrucción desde la nube, dentro
//! de su transacción. Por la conexión cruda: es estado de este equipo y no se replica.

use std::path::Path;

use tpv_application::error::{AppError, AppResult};

use crate::consultas::db_err;
use crate::db::Reader;
use crate::ejecutor::{Connection, ErrorSql, Value};
use tpv_domain::licensing::Sello;

const LEER: &str = "SELECT ID_Negocio FROM _Negocio WHERE Id = 1;";

fn limpio(valor: Value) -> Option<String> {
    match valor {
        Value::Text(s) if !s.trim().is_empty() => Some(s.trim().to_string()),
        _ => None,
    }
}

/// El negocio sellado en la base de `conn`, o `None` si no lleva sello.
pub async fn leer(conn: &impl Reader) -> AppResult<Option<String>> {
    let mut filas = conn.query(LEER, ()).await.map_err(db_err)?;
    let Some(fila) = filas.next().await.map_err(db_err)? else {
        return Ok(None);
    };
    Ok(limpio(fila.get_value(0).map_err(db_err)?))
}

/// Sella con `negocio` la base de `conn`, si no lleva sello. Uno distinto no se sustituye nunca: es un
/// error, y la base se queda como estaba (AUD-06). Volver a sellar con el mismo no cambia nada. En una
/// sola sentencia: no hay hueco entre mirar el sello y escribirlo.
pub(crate) async fn escribir(conn: &Connection, negocio: &str) -> AppResult<()> {
    let negocio = negocio.trim();
    if negocio.is_empty() {
        return Err(AppError::internal("Falta el negocio con el que sellar la base."));
    }
    conn.execute(
        "INSERT INTO _Negocio (Id, ID_Negocio) VALUES (1, ?1) ON CONFLICT(Id) DO UPDATE SET ID_Negocio = excluded.ID_Negocio WHERE trim(_Negocio.ID_Negocio) = '';",
        vec![Value::Text(negocio.to_string())],
    )
    .await
    .map_err(db_err)?;
    match leer(conn).await? {
        Some(sellado) if sellado == negocio => Ok(()),
        _ => Err(AppError::conflict(
            "Estos datos ya son de otro negocio y no se pueden pasar a este. Cierra el TPV y vuelve a abrirlo.",
        )),
    }
}

/// El sello de una base que está en un fichero, sin abrirla como `Db` ni migrarla: `data.db` antes
/// de abrirla, o una copia ya descomprimida. Una base anterior a los sellos no tiene la tabla, y
/// eso es «sin sello»; un fichero que no está, también (no hay base: se creará).
///
/// Un fichero que no es una base, o está dañado, es `Sello::Ilegible`: no dice de quién es. Lo
/// demás (otro proceso la tiene bloqueada, falta permiso) es un error: no se sabe nada y no se decide
/// nada con eso.
pub fn del_fichero(ruta: &Path) -> AppResult<Sello> {
    if !ruta.is_file() {
        return Ok(Sello::Ninguno);
    }
    match leer_del_fichero(ruta) {
        Ok(valor) => Ok(Sello::leido(valor.as_deref())),
        Err(e) if es_ilegible(&e) => Ok(Sello::Ilegible),
        Err(e) => Err(db_err(ErrorSql::from(e))),
    }
}

fn es_ilegible(e: &rusqlite::Error) -> bool {
    matches!(
        e,
        rusqlite::Error::SqliteFailure(f, _)
            if matches!(f.code, rusqlite::ErrorCode::NotADatabase | rusqlite::ErrorCode::DatabaseCorrupt)
    )
}

fn leer_del_fichero(ruta: &Path) -> Result<Option<String>, rusqlite::Error> {
    use rusqlite::OpenFlags;
    // Sólo lectura: mirar el sello no crea ni toca nada.
    let conn = rusqlite::Connection::open_with_flags(
        ruta,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let _ = conn.busy_timeout(std::time::Duration::from_secs(5));
    let tiene_tabla: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = '_Negocio';",
        [],
        |f| f.get(0),
    )?;
    if tiene_tabla == 0 {
        return Ok(None);
    }
    let mut consulta = conn.prepare(LEER)?;
    let mut filas = consulta.query([])?;
    match filas.next()? {
        Some(fila) => Ok(limpio(fila.get::<_, Value>(0)?)),
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Del fichero: una base de antes de los sellos no tiene la tabla, y eso es «sin sello»; lo que
    /// no es una base no dice de quién es; y un fichero que no está, nada.
    #[test]
    fn el_sello_de_un_fichero() {
        let dir = crate::test_temp::dir_temporal("sello_del_fichero");
        std::fs::create_dir_all(&dir).unwrap();

        assert_eq!(del_fichero(&dir.join("no-esta.db")).unwrap(), Sello::Ninguno);
        assert!(!dir.join("no-esta.db").exists(), "mirar no crea el fichero");

        let antigua = dir.join("antigua.db");
        let conn = rusqlite::Connection::open(&antigua).unwrap();
        conn.execute_batch("CREATE TABLE Usuarios (ID_Usuario TEXT);").unwrap();
        drop(conn);
        assert_eq!(del_fichero(&antigua).unwrap(), Sello::Ninguno);

        let sellada = dir.join("sellada.db");
        let conn = rusqlite::Connection::open(&sellada).unwrap();
        conn.execute_batch(
            "CREATE TABLE _Negocio (Id INTEGER PRIMARY KEY, ID_Negocio TEXT NOT NULL);
             INSERT INTO _Negocio VALUES (1, ' negocio-a ');",
        )
        .unwrap();
        drop(conn);
        assert_eq!(del_fichero(&sellada).unwrap(), Sello::De("negocio-a".into()));

        // AUD-06: lo que no se deja leer no es «sin sello».
        let basura = dir.join("basura.db");
        std::fs::write(&basura, "esto no es una base de datos, aunque se llame así, y es bastante largo para tener cabecera").unwrap();
        assert_eq!(del_fichero(&basura).unwrap(), Sello::Ilegible);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// AUD-06: sellar no sustituye un sello distinto; con el mismo, no cambia nada.
    #[tokio::test]
    async fn un_sello_distinto_no_se_sustituye() {
        let dir = crate::test_temp::dir_temporal("sello_distinto");
        std::fs::create_dir_all(&dir).unwrap();
        let db = crate::db::Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        {
            let w = db.write().await;
            escribir(w.raw(), "negocio-a").await.unwrap();
            escribir(w.raw(), " negocio-a ").await.unwrap();
            let err = escribir(w.raw(), "negocio-x").await.unwrap_err();
            assert!(err.to_string().contains("ya son de otro negocio"), "{err}");
        }
        assert_eq!(leer(&db.read().await).await.unwrap().as_deref(), Some("negocio-a"));
        db.cerrar().await.unwrap();
        drop(db);
        let _ = std::fs::remove_dir_all(dir);
    }
}
