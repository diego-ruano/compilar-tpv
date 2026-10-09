//! RI-70: concesiones replicables y autorización leída de la base vigente.
use std::sync::Arc;
use async_trait::async_trait;
use libsql::Value;
use tpv_application::{error::{AppError, AppResult}, ports::permisos::PermisosRepository};
use tpv_contracts::{errors::ErrorCode, permisos::*};
use crate::{db::{Db, Reader, Writer}, util::new_id};
fn err(e: impl std::fmt::Display) -> AppError { AppError::repository(e.to_string()) }
pub struct SqlitePermisosRepository { db: Arc<Db> }
impl SqlitePermisosRepository { pub fn new(db: Arc<Db>) -> Self { Self { db } } }
async fn concesiones<C: Reader>(db: &C, id_rol: &str) -> AppResult<Vec<String>> {
    let mut filas = db.query("SELECT Permiso FROM Roles_Permisos WHERE ID_Rol=?1 ORDER BY Permiso", vec![Value::Text(id_rol.into())]).await.map_err(err)?;
    let mut out = Vec::new();
    while let Some(f) = filas.next().await.map_err(err)? { out.push(f.get::<String>(0).map_err(err)?); }
    Ok(out)
}
#[async_trait]
impl PermisosRepository for SqlitePermisosRepository {
    async fn usuario(&self, id_usuario: &str) -> AppResult<Option<AutorizacionUsuario>> {
        let db = self.db.read().await;
        // Una consulta: el rol y sus permisos pertenecen al mismo snapshot SQLite.
        let mut filas = db.query("SELECT r.Nombre_Rol, p.Permiso FROM Usuarios u JOIN Roles r ON r.ID_Rol=u.ID_Rol LEFT JOIN Roles_Permisos p ON p.ID_Rol=r.ID_Rol WHERE u.ID_Usuario=?1 AND u.Estado='Activo' ORDER BY p.Permiso", vec![Value::Text(id_usuario.into())]).await.map_err(err)?;
        let mut u = None;
        while let Some(f) = filas.next().await.map_err(err)? {
            let datos = u.get_or_insert(AutorizacionUsuario { rol:f.get::<String>(0).map_err(err)?, permisos:Vec::new() });
            if let Value::Text(p) = f.get_value(1).map_err(err)? { datos.permisos.push(p); }
        }
        Ok(u)
    }
    async fn roles(&self) -> AppResult<Vec<RolPermisos>> {
        let db = self.db.read().await;
        let mut filas = db.query("SELECT r.ID_Rol, r.Nombre_Rol, p.Permiso FROM Roles r LEFT JOIN Roles_Permisos p ON p.ID_Rol=r.ID_Rol ORDER BY r.Nombre_Rol, p.Permiso", ()).await.map_err(err)?;
        let mut out: Vec<RolPermisos> = Vec::new();
        while let Some(f) = filas.next().await.map_err(err)? {
            let id = f.get::<String>(0).map_err(err)?;
            if out.last().is_none_or(|r| r.id_rol != id) { out.push(RolPermisos { id_rol:id, nombre:f.get::<String>(1).map_err(err)?, permisos:Vec::new() }); }
            if let Value::Text(p) = f.get_value(2).map_err(err)? { out.last_mut().expect("rol insertado").permisos.push(p); }
        }
        Ok(out)
    }
    async fn guardar(&self, actor: &str, input: GuardarPermisosInput) -> AppResult<()> {
        tpv_domain::permisos::validar_lista(&input.permisos).map_err(AppError::validation)?;
        let db = self.db.write().await;
        db.transaccion(async {
            let mut filas = db.query("SELECT 1 FROM Usuarios u JOIN Roles r ON r.ID_Rol=u.ID_Rol WHERE u.ID_Usuario=?1 AND u.Estado='Activo' AND r.Nombre_Rol='Administrador'", vec![Value::Text(actor.into())]).await.map_err(err)?;
            if filas.next().await.map_err(err)?.is_none() { return Err(AppError::coded(ErrorCode::PermisoDenegado, "Sólo un administrador puede cambiar permisos")); }
            let mut filas = db.query("SELECT Nombre_Rol FROM Roles WHERE ID_Rol=?1", vec![Value::Text(input.id_rol.clone())]).await.map_err(err)?;
            let nombre = filas.next().await.map_err(err)?.ok_or_else(|| AppError::not_found("Rol no encontrado"))?.get::<String>(0).map_err(err)?;
            if nombre == tpv_domain::permisos::ADMIN { return Err(AppError::coded(ErrorCode::PermisoDenegado, "Los permisos del administrador no se modifican")); }
            let actuales = concesiones(&db, &input.id_rol).await?;
            let mut vistos = input.permisos_vistos.clone(); vistos.sort();
            if actuales != vistos { return Err(AppError::conflict("Los permisos han cambiado. Recarga antes de guardar")); }
            db.execute("DELETE FROM Roles_Permisos WHERE ID_Rol=?1", vec![Value::Text(input.id_rol.clone())]).await.map_err(err)?;
            for permiso in input.permisos {
                db.execute("INSERT INTO Roles_Permisos (ID_Rol_Permiso, ID_Rol, Permiso) VALUES (?1,?2,?3)", vec![Value::Text(new_id()),Value::Text(input.id_rol.clone()),Value::Text(permiso)]).await.map_err(err)?;
            }
            Ok(())
        }).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract_comun::{db_temporal, sembrar};
    const CAMARERO: &str = "00000000-0000-7000-8000-000000000002";
    async fn preparar() -> Arc<Db> {
        let (db, _) = db_temporal().await;
        sembrar(&db, &[
            serde_json::json!("INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre) VALUES ('admin','00000000-0000-7000-8000-000000000001','a@test','h','Admin')"),
            serde_json::json!("INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre) VALUES ('camarero','00000000-0000-7000-8000-000000000002','c@test','h','Camarero')"),
        ]).await; db
    }
    #[tokio::test]
    async fn editar_catalogo_sin_precios_no_pisa_un_precio_cambiado() {
        use tpv_application::ports::inventario::InventarioRepository;
        let db = preparar().await;
        sembrar(&db, &[
            serde_json::json!("INSERT INTO Categorias_Producto (ID_Categoria,Nombre) VALUES ('cat','Categoría')"),
            serde_json::json!("INSERT INTO Productos (ID_Producto,ID_Categoria,Nombre,Precio_Venta) VALUES ('p','cat','Original',100)"),
        ]).await;
        let repo = crate::inventario::SqliteInventarioRepository::new(db.clone());
        let producto = tpv_domain::inventario::ProductoUpsert {
            id:Some("p".into()),id_categoria:"cat".into(),id_proveedor:None,nombre:"Nombre editado".into(),
            precio_venta:Some(tpv_domain::dinero::Dinero::de_centimos(100)),stock_minimo:None,unidad_medida:None,nombre_imagen:None,ruta_imagen:None,cantidad_pedido_esperada:None,stock_suelto:None,iva_percent:None,ids_alergenos:vec![],
        };
        repo.upsert_producto_autorizado("camarero",producto.clone(),false,false).await.unwrap();
        db.write().await.raw().execute("UPDATE Productos SET Precio_Venta=200 WHERE ID_Producto='p'",()).await.unwrap();
        assert_eq!(repo.upsert_producto_autorizado("camarero",producto,false,false).await.unwrap_err().code(),ErrorCode::PermisoDenegado);
        let actual = repo.get_producto("p").await.unwrap().unwrap();
        assert_eq!(actual.precio_venta.unwrap().centimos(),200);
    }

    #[tokio::test]
    async fn cambiar_un_rol_revoca_permisos_sin_relogin_y_replica_la_edicion() {
        let db = preparar().await; let repo = SqlitePermisosRepository::new(db.clone());
        let antes = repo.usuario("camarero").await.unwrap().unwrap();
        assert!(antes.permisos.contains(&"cuentas.cobros".into()));
        repo.guardar("admin", GuardarPermisosInput { id_rol:CAMARERO.into(),permisos_vistos:antes.permisos,permisos:vec!["tareas.propias".into()] }).await.unwrap();
        let despues = repo.usuario("camarero").await.unwrap().unwrap();
        assert_eq!(despues.permisos, vec!["tareas.propias"]);
        use tpv_application::ports::sync::SyncRepository;
        let pendientes = crate::sync::SqliteSyncRepository::new(db).outbox_pending(20).await.unwrap();
        assert_eq!(pendientes.len(), 1);
        assert!(pendientes[0].statements.iter().any(|s| s.sql.contains("Roles_Permisos")));
    }
    #[tokio::test]
    async fn una_pantalla_antigua_no_pisa_los_permisos_y_el_admin_no_se_desarma() {
        let db = preparar().await; let repo = SqlitePermisosRepository::new(db);
        let vistos = repo.usuario("camarero").await.unwrap().unwrap().permisos;
        let input = GuardarPermisosInput {id_rol:CAMARERO.into(),permisos_vistos:vistos,permisos:vec![]};
        repo.guardar("admin",input.clone()).await.unwrap();
        assert_eq!(repo.guardar("admin",input).await.unwrap_err().code(), ErrorCode::Conflict);
        assert_eq!(repo.guardar("admin",GuardarPermisosInput{id_rol:"00000000-0000-7000-8000-000000000001".into(),permisos_vistos:vec![],permisos:vec![]}).await.unwrap_err().code(),ErrorCode::PermisoDenegado);
    }
    #[tokio::test]
    async fn el_usuario_inactivo_no_autoriza_ni_administra_y_los_permisos_desconocidos_se_rechazan() {
        let db = preparar().await; let repo = SqlitePermisosRepository::new(db.clone());
        let input = GuardarPermisosInput {id_rol:CAMARERO.into(),permisos_vistos:vec![],permisos:vec![]};
        assert_eq!(repo.guardar("camarero",input.clone()).await.unwrap_err().code(),ErrorCode::PermisoDenegado);
        db.write().await.raw().execute("UPDATE Usuarios SET Estado='Inactivo' WHERE ID_Usuario='admin'",()).await.unwrap();
        assert!(repo.usuario("admin").await.unwrap().is_none());
        assert_eq!(repo.guardar("admin",input).await.unwrap_err().code(),ErrorCode::PermisoDenegado);
        let malas = GuardarPermisosInput {id_rol:CAMARERO.into(),permisos_vistos:vec![],permisos:vec!["usuarios.promover".into()]};
        assert_eq!(repo.guardar("admin",malas).await.unwrap_err().code(),ErrorCode::Validation);
    }
}
