//! RI-70: catálogo estable de capacidades. Los roles conceden acciones, no rutas ni SQL.
pub const ADMIN: &str = "Administrador";
pub const CATALOGO: &[(&str, &str, &str)] = &[
    ("servicio.vender", "Comandas, venta y cobro", "Servicio"),
    ("servicio.cocina", "Preparar líneas de cocina", "Servicio"),
    ("reservas.gestionar", "Gestionar reservas", "Servicio"),
    ("tareas.propias", "Ver y finalizar tareas propias", "Servicio"),
    ("catalogo.editar", "Crear y editar productos y categorías", "Inventario"),
    ("catalogo.precios", "Cambiar precios e IVA de productos", "Inventario"),
    ("catalogo.borrar", "Borrar o archivar productos", "Inventario"),
    ("stock.recibir", "Recibir mercancía", "Inventario"),
    ("stock.editar_lotes", "Editar datos de lotes", "Inventario"),
    ("stock.ajustar", "Ajustar existencias", "Inventario"),
    ("proveedores.gestionar", "Gestionar proveedores y vínculos", "Gestión"),
    ("pedidos.gestionar", "Gestionar pedidos a proveedores", "Gestión"),
    ("tareas.gestionar", "Administrar tareas y asignaciones", "Gestión"),
    ("horarios.gestionar", "Gestionar horarios", "Gestión"),
    ("plano.gestionar", "Editar salones y mesas", "Gestión"),
    ("estadisticas.ver", "Consultar estadísticas", "Gestión"),
    ("clientes.gestionar", "Consultar y gestionar clientes", "Gestión"),
    ("clientes.recalcular", "Recalcular gasto de clientes", "Gestión"),
    ("cuentas.cobros", "Consultar, reimprimir y devolver cobros", "Caja"),
    ("cuentas.gastos", "Consultar y gestionar gastos y totales", "Caja"),
    ("caja.cerrar", "Gestionar cierres de caja", "Caja"),
];
pub fn conocido(permiso: &str) -> bool { CATALOGO.iter().any(|(c, _, _)| *c == permiso) }
pub fn permite(rol: &str, concedidos: &[String], permiso: &str) -> bool {
    conocido(permiso) && (rol == ADMIN || concedidos.iter().any(|p| p == permiso))
}
pub fn validar_lista(permisos: &[String]) -> Result<(), String> {
    if permisos.len() > CATALOGO.len() || permisos.iter().any(|p| !conocido(p)) { return Err("Permiso desconocido".into()); }
    let mut copia = permisos.to_vec(); copia.sort(); copia.dedup();
    if copia.len() != permisos.len() { return Err("Permisos duplicados".into()); }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn se_deniega_por_defecto_y_el_admin_no_admite_capacidades_inventadas() {
        assert!(!permite("Encargado", &[], "stock.ajustar"));
        assert!(permite("Encargado", &["stock.ajustar".into()], "stock.ajustar"));
        assert!(permite(ADMIN, &[], "stock.ajustar"));
        assert!(!permite(ADMIN, &[], "usuarios.promover"));
        assert!(validar_lista(&["stock.ajustar".into(), "stock.ajustar".into()]).is_err());
    }
}
