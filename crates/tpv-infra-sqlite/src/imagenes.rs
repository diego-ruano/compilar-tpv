//! OBS-06 · Las referencias de imagen de la base del negocio.
//!
//! Una imagen guardada por la app se llama con un UUID (`images/{carpeta}/{uuid}.{ext}`), y su
//! ruta viaja en la URL con la que se sube, se sirve y se borra. Las heredadas, guardadas antes con
//! el nombre que alguien les dio, la Main las renombra antes de subir nada (`images_backfill`, en el
//! shell): el fichero lo mueve el shell y las filas que la usan, esto.

use tpv_application::error::AppResult;

use crate::consultas::db_err;
use crate::db::{Db, Reader, Writer};
use crate::ejecutor::Value;

/// Las tablas que apuntan a una imagen guardada: su ruta (`Ruta_Imagen`) y el nombre de su fichero
/// (`Nombre_Imagen`).
const TABLAS_CON_IMAGEN: [&str; 4] = ["Productos", "Categorias_Producto", "Proveedores", "Alergenos"];

/// Las tablas de `TABLAS_CON_IMAGEN` con alguna fila que usa la imagen `rel`.
async fn tablas_que_la_usan(lector: &impl Reader, rel: &str) -> AppResult<Vec<&'static str>> {
    let mut tablas = Vec::new();
    for tabla in TABLAS_CON_IMAGEN {
        let mut filas = lector
            .query(
                &format!("SELECT 1 FROM {tabla} WHERE Ruta_Imagen = ?1 LIMIT 1;"),
                vec![Value::Text(rel.to_owned())],
            )
            .await
            .map_err(db_err)?;
        if filas.next().await.map_err(db_err)?.is_some() {
            tablas.push(tabla);
        }
    }
    Ok(tablas)
}

/// ¿Alguna fila usa la imagen `rel`? Una heredada que no usa nadie no se renombra ni se sube.
pub async fn imagen_en_uso(db: &Db, rel: &str) -> AppResult<bool> {
    Ok(!tablas_que_la_usan(&db.read().await, rel).await?.is_empty())
}

/// Cambia la imagen `antes` por `despues` en las filas que la usan: su ruta y el nombre de su
/// fichero. Va en una transacción y por `WriteGuard`, así que sube a la nube como cualquier
/// escritura y la nube y las Handy la aplican. Lo que la usa se mira dentro de la misma
/// transacción, y sólo se escribe en esas tablas: lo que sube no lleva sentencias que no cambian
/// nada. Devuelve cuántas filas ha cambiado; 0 si ya no la usa nadie.
pub async fn renombrar_imagen(db: &Db, antes: &str, despues: &str) -> AppResult<u64> {
    let nombre = despues.rsplit('/').next().unwrap_or(despues).to_owned();
    let escritor = db.write().await;
    let conn = &escritor;
    conn.transaccion(async {
        let mut cambiadas = 0;
        for tabla in tablas_que_la_usan(conn, antes).await? {
            cambiadas += conn
                .execute(
                    &format!("UPDATE {tabla} SET Ruta_Imagen = ?2, Nombre_Imagen = ?3 WHERE Ruta_Imagen = ?1;"),
                    vec![
                        Value::Text(antes.to_owned()),
                        Value::Text(despues.to_owned()),
                        Value::Text(nombre.clone()),
                    ],
                )
                .await
                .map_err(db_err)?;
        }
        Ok(cambiadas)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ejecutor::Connection;
    use std::sync::Arc;

    const HEREDADA: &str = "images/proveedores/Juan-Perez.jpg";
    const OPACA: &str = "images/proveedores/0190f3a1-7b2c-4d4e-8f00-123456789abc.jpg";

    async fn base(nombre: &str) -> Arc<Db> {
        let dir = crate::test_temp::dir_temporal(nombre);
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        let w = db.write().await;
        let conn: &Connection = w.raw();
        for sql in [
            "INSERT INTO Proveedores (ID_Proveedor, Nombre_Empresa, Nombre_Imagen, Ruta_Imagen) VALUES ('prov', 'Juan', 'Juan-Perez.jpg', 'images/proveedores/Juan-Perez.jpg');",
            "INSERT INTO Proveedores (ID_Proveedor, Nombre_Empresa, Nombre_Imagen, Ruta_Imagen) VALUES ('otro', 'Otro', 'otra.jpg', 'images/proveedores/otra.jpg');",
            "INSERT INTO Categorias_Producto (ID_Categoria, Nombre, Nombre_Imagen, Ruta_Imagen) VALUES ('cat', 'Bar', 'Juan-Perez.jpg', 'images/proveedores/Juan-Perez.jpg');",
        ] {
            conn.execute(sql, Vec::<Value>::new()).await.unwrap();
        }
        drop(w);
        db
    }

    async fn texto(db: &Db, sql: &str) -> Vec<String> {
        let r = db.read().await;
        let mut filas = r.query(sql, Vec::<Value>::new()).await.unwrap();
        let mut salida = Vec::new();
        while let Some(fila) = filas.next().await.unwrap() {
            salida.push(crate::mapping::v_string(fila.get_value(0).unwrap()).unwrap_or_default());
        }
        salida
    }

    #[tokio::test]
    async fn renombra_las_filas_que_la_usan_y_lo_sube_en_una_operacion() {
        let db = base("imagen_heredada").await;
        assert!(imagen_en_uso(&db, HEREDADA).await.unwrap());

        assert_eq!(renombrar_imagen(&db, HEREDADA, OPACA).await.unwrap(), 2);

        let nombre = OPACA.rsplit('/').next().unwrap();
        assert_eq!(
            texto(&db, "SELECT Ruta_Imagen || '|' || Nombre_Imagen FROM Proveedores ORDER BY ID_Proveedor;").await,
            vec!["images/proveedores/otra.jpg|otra.jpg".to_string(), format!("{OPACA}|{nombre}")],
        );
        assert_eq!(texto(&db, "SELECT Ruta_Imagen FROM Categorias_Producto;").await, vec![OPACA.to_string()]);
        assert!(!imagen_en_uso(&db, HEREDADA).await.unwrap());

        // Una operación en el outbox, con una sentencia por tabla que la usaba: ni las de las
        // tablas que no la usan, ni el nombre heredado fuera de su condición.
        let outbox = texto(&db, "SELECT Statements_Json FROM _Sync_Outbox;").await;
        assert_eq!(outbox.len(), 1, "{outbox:?}");
        let sentencias: Vec<serde_json::Value> = serde_json::from_str(&outbox[0]).unwrap();
        let sql: Vec<&str> = sentencias.iter().map(|s| s["sql"].as_str().unwrap()).collect();
        assert_eq!(sql.len(), 2, "{sql:?}");
        assert!(sql[0].starts_with("UPDATE Categorias_Producto SET Ruta_Imagen"), "{sql:?}");
        assert!(sql[1].starts_with("UPDATE Proveedores SET Ruta_Imagen"), "{sql:?}");
    }

    #[tokio::test]
    async fn una_que_no_usa_nadie_no_escribe_nada() {
        let db = base("imagen_sin_uso").await;
        assert!(!imagen_en_uso(&db, "images/productos/nadie.jpg").await.unwrap());
        assert_eq!(renombrar_imagen(&db, "images/productos/nadie.jpg", OPACA).await.unwrap(), 0);
        assert!(texto(&db, "SELECT Statements_Json FROM _Sync_Outbox;").await.is_empty());
    }
}
