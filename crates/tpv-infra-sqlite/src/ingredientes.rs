//! Ingredientes en la base de la Main: el catálogo (categorías e ingredientes), los que lleva cada
//! producto, y sus borrados. Lo usa `SqliteInventarioRepository`, que es quien implementa el puerto.
//!
//! El worker escribe lo mismo con sus sentencias (`domains/inventario/ingredientes.commands.ts`) y
//! los arneses de contrato fijan que las dos dejen las mismas filas. Los borrados quitan a mano y
//! en orden lo que cuelga de cada fila (DB-03, como `SQL_QUITAR_PRODUCTO`): lo que viaja a la nube
//! son estas sentencias, y las FK con cascada del esquema son la red, no el camino.

use crate::consultas::{db_err, lista_json, select_one_i64};
use crate::db::{Reader, Writer};
use crate::ejecutor::Value;
use crate::mapping::v_string;
use crate::util::new_id;

use tpv_application::error::{AppError, AppResult};
use tpv_contracts::inventario::{CatalogoIngredientesDto, CategoriaIngredienteDto, IngredienteDto};
use tpv_domain::ingredientes::{CategoriaIngredienteGuardar, IngredienteGuardar};

/// Las mismas frases que el worker (`MENSAJES` de `lib/errorCodes.ts`).
pub const MSG_CATEGORIA_REPETIDA: &str = "Ya hay una categoría de ingredientes con ese nombre.";
pub const MSG_INGREDIENTE_REPETIDO: &str = "Ya hay un ingrediente con ese nombre en esa categoría.";
pub const MSG_CATEGORIA_NO_EXISTE: &str =
    "Esa categoría de ingredientes ya no existe. Vuelve a abrir la lista de ingredientes.";

/// Las sentencias que dejan a un producto con exactamente estos ingredientes. Los ids van en un
/// único parámetro JSON (DO-01) y sólo entran los que existen: uno borrado mientras la ficha estaba
/// abierta no rompe el guardado.
pub(crate) fn sql_ingredientes_del_producto(
    id_producto: &str,
    ids: &[String],
) -> Vec<(&'static str, Vec<Value>)> {
    let mut out = vec![(
        "DELETE FROM Producto_Ingredientes WHERE ID_Producto = ?1;",
        vec![Value::Text(id_producto.to_string())],
    )];
    if !ids.is_empty() {
        out.push((
            "INSERT INTO Producto_Ingredientes (ID_Producto, ID_Ingrediente) \
             SELECT ?1, value FROM json_each(?2) \
             WHERE value IN (SELECT ID_Ingrediente FROM Ingredientes) \
             ON CONFLICT DO NOTHING;",
            vec![Value::Text(id_producto.to_string()), lista_json(ids)],
        ));
    }
    out
}

/// Borrar una categoría: primero sus ingredientes de los productos, luego sus ingredientes y luego
/// ella. El worker manda exactamente éstas (`borrarCategoriaIngrediente`).
pub(crate) const SQL_BORRAR_CATEGORIA: &[&str] = &[
    "DELETE FROM Producto_Ingredientes WHERE ID_Ingrediente IN \
     (SELECT ID_Ingrediente FROM Ingredientes WHERE ID_Categoria_Ingrediente = ?1);",
    "DELETE FROM Ingredientes WHERE ID_Categoria_Ingrediente = ?1;",
    "DELETE FROM Categorias_Ingrediente WHERE ID_Categoria_Ingrediente = ?1;",
];

/// Borrar un ingrediente: primero de los productos que lo llevan. Espejo de `borrarIngrediente`.
pub(crate) const SQL_BORRAR_INGREDIENTE: &[&str] = &[
    "DELETE FROM Producto_Ingredientes WHERE ID_Ingrediente = ?1;",
    "DELETE FROM Ingredientes WHERE ID_Ingrediente = ?1;",
];

fn texto(v: Value) -> String {
    v_string(v).unwrap_or_default()
}

pub(crate) async fn catalogo<C: Reader>(conn: &C) -> AppResult<CatalogoIngredientesDto> {
    let mut categorias = Vec::new();
    let mut rows = conn
        .query(
            "SELECT ID_Categoria_Ingrediente, Nombre FROM Categorias_Ingrediente \
             ORDER BY Nombre ASC, ID_Categoria_Ingrediente ASC;",
            (),
        )
        .await
        .map_err(db_err)?;
    while let Some(row) = rows.next().await.map_err(db_err)? {
        let g = |i: i32| row.get_value(i).map_err(db_err);
        categorias.push(CategoriaIngredienteDto { id_categoria_ingrediente: texto(g(0)?), nombre: texto(g(1)?) });
    }

    let mut ingredientes = Vec::new();
    let mut rows = conn
        .query(
            "SELECT ID_Ingrediente, ID_Categoria_Ingrediente, Nombre FROM Ingredientes \
             ORDER BY Nombre ASC, ID_Ingrediente ASC;",
            (),
        )
        .await
        .map_err(db_err)?;
    while let Some(row) = rows.next().await.map_err(db_err)? {
        let g = |i: i32| row.get_value(i).map_err(db_err);
        ingredientes.push(IngredienteDto {
            id_ingrediente: texto(g(0)?),
            id_categoria_ingrediente: texto(g(1)?),
            nombre: texto(g(2)?),
        });
    }
    Ok(CatalogoIngredientesDto { categorias, ingredientes })
}

pub(crate) async fn de_producto<C: Reader>(conn: &C, id_producto: &str) -> AppResult<Vec<String>> {
    let mut rows = conn
        .query(
            "SELECT ID_Ingrediente FROM Producto_Ingredientes WHERE ID_Producto = ?1 \
             ORDER BY ID_Ingrediente ASC;",
            vec![Value::Text(id_producto.to_string())],
        )
        .await
        .map_err(db_err)?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().await.map_err(db_err)? {
        out.push(texto(row.get_value(0).map_err(db_err)?));
    }
    Ok(out)
}

/// Crea o renombra una categoría. Un nombre que ya tiene otra se rechaza con su frase, antes de que
/// el `UNIQUE` lo haga con la del motor. Se comprueba bajo el mismo escritor que escribe.
pub(crate) async fn guardar_categoria<C: Reader + Writer>(
    conn: &C,
    c: CategoriaIngredienteGuardar,
) -> AppResult<String> {
    let id = c.id.unwrap_or_else(new_id);
    let repetida = select_one_i64(
        conn,
        "SELECT 1 FROM Categorias_Ingrediente WHERE Nombre = ?2 AND ID_Categoria_Ingrediente <> ?1 LIMIT 1;",
        vec![Value::Text(id.clone()), Value::Text(c.nombre.clone())],
    )
    .await?
    .is_some();
    if repetida {
        return Err(AppError::conflict(MSG_CATEGORIA_REPETIDA));
    }
    conn.execute(
        "INSERT INTO Categorias_Ingrediente (ID_Categoria_Ingrediente, Nombre) VALUES (?1, ?2) \
         ON CONFLICT(ID_Categoria_Ingrediente) DO UPDATE SET Nombre = excluded.Nombre;",
        vec![Value::Text(id.clone()), Value::Text(c.nombre)],
    )
    .await
    .map_err(db_err)?;
    Ok(id)
}

/// Crea, renombra o cambia de categoría un ingrediente. La categoría tiene que existir y el nombre
/// no puede repetirse dentro de ella.
pub(crate) async fn guardar_ingrediente<C: Reader + Writer>(
    conn: &C,
    i: IngredienteGuardar,
) -> AppResult<String> {
    let id = i.id.unwrap_or_else(new_id);
    let existe_categoria = select_one_i64(
        conn,
        "SELECT 1 FROM Categorias_Ingrediente WHERE ID_Categoria_Ingrediente = ?1 LIMIT 1;",
        vec![Value::Text(i.id_categoria.clone())],
    )
    .await?
    .is_some();
    if !existe_categoria {
        return Err(AppError::conflict(MSG_CATEGORIA_NO_EXISTE));
    }
    let repetido = select_one_i64(
        conn,
        "SELECT 1 FROM Ingredientes WHERE ID_Categoria_Ingrediente = ?2 AND Nombre = ?3 \
         AND ID_Ingrediente <> ?1 LIMIT 1;",
        vec![Value::Text(id.clone()), Value::Text(i.id_categoria.clone()), Value::Text(i.nombre.clone())],
    )
    .await?
    .is_some();
    if repetido {
        return Err(AppError::conflict(MSG_INGREDIENTE_REPETIDO));
    }
    conn.execute(
        "INSERT INTO Ingredientes (ID_Ingrediente, ID_Categoria_Ingrediente, Nombre) VALUES (?1, ?2, ?3) \
         ON CONFLICT(ID_Ingrediente) DO UPDATE SET \
           ID_Categoria_Ingrediente = excluded.ID_Categoria_Ingrediente, \
           Nombre = excluded.Nombre;",
        vec![Value::Text(id.clone()), Value::Text(i.id_categoria), Value::Text(i.nombre)],
    )
    .await
    .map_err(db_err)?;
    Ok(id)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::db::Db;
    use crate::inventario::SqliteInventarioRepository;
    use tpv_application::ports::inventario::InventarioRepository;
    use tpv_domain::inventario::ProductoUpsert;

    async fn base() -> Arc<Db> {
        let dir = crate::test_temp::dir_temporal("ingredientes");
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        let w = db.write().await;
        w.raw()
            .execute(
                "INSERT INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('cat', 'Cocina');",
                Vec::<Value>::new(),
            )
            .await
            .unwrap();
        drop(w);
        db
    }

    fn cat(id: &str, nombre: &str) -> CategoriaIngredienteGuardar {
        CategoriaIngredienteGuardar::validar(Some(id.into()), nombre).unwrap()
    }

    fn ingr(id: &str, cat: &str, nombre: &str) -> IngredienteGuardar {
        IngredienteGuardar::validar(Some(id.into()), cat, nombre).unwrap()
    }

    fn producto(ids: Option<Vec<&str>>) -> ProductoUpsert {
        ProductoUpsert {
            id: Some("burger".into()),
            id_categoria: "cat".into(),
            id_proveedor: None,
            nombre: "Hamburguesa".into(),
            precio_venta: None,
            stock_minimo: None,
            unidad_medida: None,
            nombre_imagen: None,
            ruta_imagen: None,
            cantidad_pedido_esperada: None,
            stock_suelto: None,
            iva_percent: None,
            ids_alergenos: vec![],
            ids_ingredientes: ids.map(|v| v.into_iter().map(String::from).collect()),
        }
    }

    #[tokio::test]
    async fn un_nombre_repetido_se_rechaza_con_su_frase() {
        let db = base().await;
        let repo = SqliteInventarioRepository::new(db.clone());
        repo.guardar_categoria_ingrediente(cat("pan", "Pan")).await.unwrap();
        let err = repo.guardar_categoria_ingrediente(cat("otra", "Pan")).await.unwrap_err();
        assert_eq!(err.to_string(), MSG_CATEGORIA_REPETIDA);
        // Renombrarse a sí misma con el mismo nombre no es repetir.
        repo.guardar_categoria_ingrediente(cat("pan", "Pan")).await.unwrap();

        repo.guardar_ingrediente(ingr("i1", "pan", "Integral")).await.unwrap();
        let err = repo.guardar_ingrediente(ingr("i2", "pan", "Integral")).await.unwrap_err();
        assert_eq!(err.to_string(), MSG_INGREDIENTE_REPETIDO);
        let err = repo.guardar_ingrediente(ingr("i3", "no-existe", "Centeno")).await.unwrap_err();
        assert_eq!(err.to_string(), MSG_CATEGORIA_NO_EXISTE);
    }

    #[tokio::test]
    async fn el_producto_guarda_sus_ingredientes_y_sin_lista_no_los_toca() {
        let db = base().await;
        let repo = SqliteInventarioRepository::new(db.clone());
        repo.guardar_categoria_ingrediente(cat("pan", "Pan")).await.unwrap();
        repo.guardar_ingrediente(ingr("i1", "pan", "Brioche")).await.unwrap();
        repo.guardar_ingrediente(ingr("i2", "pan", "Integral")).await.unwrap();

        // Uno que no existe (borrado con la ficha abierta) no rompe el guardado.
        repo.upsert_producto_autorizado("u", producto(Some(vec!["i2", "i1", "fantasma"])), true, true).await.unwrap();
        assert_eq!(repo.ingredientes_de_producto("burger").await.unwrap(), vec!["i1", "i2"]);

        repo.upsert_producto_autorizado("u", producto(None), true, true).await.unwrap();
        assert_eq!(repo.ingredientes_de_producto("burger").await.unwrap(), vec!["i1", "i2"]);

        repo.upsert_producto_autorizado("u", producto(Some(vec![])), true, true).await.unwrap();
        assert!(repo.ingredientes_de_producto("burger").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn borrar_una_categoria_se_lleva_sus_ingredientes_de_los_productos() {
        let db = base().await;
        let repo = SqliteInventarioRepository::new(db.clone());
        repo.guardar_categoria_ingrediente(cat("pan", "Pan")).await.unwrap();
        repo.guardar_categoria_ingrediente(cat("salsas", "Salsas")).await.unwrap();
        repo.guardar_ingrediente(ingr("i1", "pan", "Brioche")).await.unwrap();
        repo.guardar_ingrediente(ingr("i2", "salsas", "Ketchup")).await.unwrap();
        repo.upsert_producto_autorizado("u", producto(Some(vec!["i1", "i2"])), true, true).await.unwrap();

        repo.borrar_categoria_ingrediente("pan").await.unwrap();
        assert_eq!(repo.ingredientes_de_producto("burger").await.unwrap(), vec!["i2"]);
        let catalogo = repo.catalogo_ingredientes().await.unwrap();
        assert_eq!(catalogo.categorias.len(), 1);
        assert_eq!(catalogo.ingredientes.len(), 1);

        repo.borrar_ingrediente("i2").await.unwrap();
        assert!(repo.ingredientes_de_producto("burger").await.unwrap().is_empty());
    }
}
