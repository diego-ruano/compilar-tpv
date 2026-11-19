// test/contractLectura.test.ts
//
// Tests de contrato de LECTURA Main(Rust) ↔ worker(TS) — CLI-05 / ARCH-01.
// Ver `tests/contract/README.md` y el lado canónico en `crates/tpv-infra-sqlite/src/contract_read_tests.rs`.
//
// El hermano de `contract.test.ts`: aquel fija las escrituras (mismo comando → mismas filas), éste
// fija las lecturas (mismas filas → mismo resultado devuelto). Aquí se siembra el MISMO estado que
// el lado Rust, se corre LA consulta de este worker y se comprueba que devuelve exactamente lo que
// devolvió el repositorio SQLite de la Main.
//
// **El orden importa.** Es la diferencia de fondo con el harness de escritura, que compara las filas
// como multiconjunto porque el orden en el que queden en la tabla no es parte del contrato. Una
// lectura, en cambio, es una lista que se pinta en la pantalla en ese orden: dos implementaciones
// que devuelvan lo mismo desordenado NO son equivalentes. Se compara por secuencia.

import { describe, it, expect } from "vitest";

import { clienteSobre } from "./helpers/clienteSql";
import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enElHub } from "./helpers/hub";

import { form as clienteForm, overview } from "../src/domains/clientes/clientes.queries";
import {
	detalleCierre,
	entradas,
	listarCierres,
	resumen as resumenCuentas,
	salidas,
	ultimoCierre,
} from "../src/domains/cuentas/cuentas.queries";
import {
	listAlergenos,
	listCategorias as listCategoriasInv,
	listLotesByProducto,
	listProductosByCategoria,
	listProveedoresMini,
	productDetail,
	resumen as resumenInventario,
} from "../src/domains/inventario/inventario.queries";
import { catalogoIngredientes, ingredientesDeProducto } from "../src/domains/inventario/ingredientes.queries";
import {
	getBusiness,
	getContact,
	getTicket,
} from "../src/domains/configuracion/configuracion.queries";
import { listLoginUsers, punchStatus } from "../src/domains/login/login.queries";
import {
	contarNoLeidas,
	listar as listarNotificaciones,
	listarPapelera,
} from "../src/domains/notificaciones/notificaciones.queries";
import { pagina as paginaDePedidos } from "../src/domains/pedidos_proveedor/pedidos_proveedor.queries";
import {
	getAll as proveedoresTodos,
	getCategorias as proveedoresCategorias,
	getProductos as proveedoresProductos,
	getProductosAll as proveedoresProductosTodos,
} from "../src/domains/proveedores/proveedores.queries";
import {
	buscarCliente as reservasBuscarCliente,
	mes as reservasMes,
	reserva as reservasUna,
	meta as reservasMeta,
} from "../src/domains/reservas/reservas.queries";
import {
	clientes as statsClientes,
	listCategorias as statsCategorias,
	mesas as statsMesas,
	productos as statsProductos,
	proveedores as statsProveedores,
	reservas as statsReservas,
	trabajadores as statsTrabajadores,
} from "../src/domains/stats/stats.queries";
import {
	all as trabajadoresTodos,
	detail as trabajadorDetalle,
	idByUsuario,
	permisosUsuario,
	roles as trabajadoresRoles,
	turnos as trabajadoresTurnos,
} from "../src/domains/trabajadores/trabajadores.queries";
import {
	categorias as categoriasMesa,
	comandaAbiertaByMesa,
	kitchenList,
	lineas as lineasMesa,
	loadLayout,
	mesasMetaAll,
	productosByCategoria as productosByCategoriaMesa,
	searchProductos as searchProductosMesa,
} from "../src/domains/mesas/mesas.queries";
import {
	getMisTareas,
	getPapelera,
	getTareaAsignados,
	getTareaById,
	getTareasAdmin,
	getTrabajadores,
} from "../src/domains/tareas/tareas.queries";
import { asignacionesSemana } from "../src/domains/trabajadores/trabajadores.queries";
import {
	categorias as categoriasBarra,
	detallesVerTicket,
	indexRows,
	lineas as lineasBarra,
	listComandas,
	productosByCategoria as productosByCategoriaBarra,
	searchProductos as searchProductosBarra,
} from "../src/domains/venta_rapida/venta_rapida.queries";

// Casos del harness. Los goldens los bendice Rust (lado canónico). Añadir uno: crear el fixture,
// bendecir su golden y sumar aquí su par caso/golden (workerd no lee del disco: los imports son
// estáticos y esbuild los empaqueta). La misma lista, en Rust, es la macro `lecturas_de_contrato!`.
import casoCliReciente from "../../../tests/contract/lecturas/casos/clientes/overview_reciente.json";
import goldenCliReciente from "../../../tests/contract/lecturas/golden/clientes/overview_reciente.json";
import casoCliReservas from "../../../tests/contract/lecturas/casos/clientes/overview_por_reservas.json";
import goldenCliReservas from "../../../tests/contract/lecturas/golden/clientes/overview_por_reservas.json";
import casoCliGasto from "../../../tests/contract/lecturas/casos/clientes/overview_por_gasto.json";
import goldenCliGasto from "../../../tests/contract/lecturas/golden/clientes/overview_por_gasto.json";
import casoCliForm from "../../../tests/contract/lecturas/casos/clientes/form.json";
import goldenCliForm from "../../../tests/contract/lecturas/golden/clientes/form.json";
import casoCtaEntradas from "../../../tests/contract/lecturas/casos/cuentas/entradas.json";
import goldenCtaEntradas from "../../../tests/contract/lecturas/golden/cuentas/entradas.json";
import casoCtaEntradasPag from "../../../tests/contract/lecturas/casos/cuentas/entradas_busqueda_paginada.json";
import goldenCtaEntradasPag from "../../../tests/contract/lecturas/golden/cuentas/entradas_busqueda_paginada.json";
import casoCtaEntradasPag1 from "../../../tests/contract/lecturas/casos/cuentas/entradas_primera_pagina.json";
import goldenCtaEntradasPag1 from "../../../tests/contract/lecturas/golden/cuentas/entradas_primera_pagina.json";
import casoCtaEntradasMesa from "../../../tests/contract/lecturas/casos/cuentas/entradas_mesa_con_nombre.json";
import goldenCtaEntradasMesa from "../../../tests/contract/lecturas/golden/cuentas/entradas_mesa_con_nombre.json";
import casoCtaSalidas from "../../../tests/contract/lecturas/casos/cuentas/salidas.json";
import goldenCtaSalidas from "../../../tests/contract/lecturas/golden/cuentas/salidas.json";
import casoCtaCierreUltimo from "../../../tests/contract/lecturas/casos/cuentas/cierre_ultimo.json";
import goldenCtaCierreUltimo from "../../../tests/contract/lecturas/golden/cuentas/cierre_ultimo.json";
import casoCtaCierreListar from "../../../tests/contract/lecturas/casos/cuentas/cierre_listar.json";
import goldenCtaCierreListar from "../../../tests/contract/lecturas/golden/cuentas/cierre_listar.json";
import casoCtaCierreDetalle from "../../../tests/contract/lecturas/casos/cuentas/cierre_detalle.json";
import goldenCtaCierreDetalle from "../../../tests/contract/lecturas/golden/cuentas/cierre_detalle.json";
import casoCtaResumen from "../../../tests/contract/lecturas/casos/cuentas/resumen.json";
import goldenCtaResumen from "../../../tests/contract/lecturas/golden/cuentas/resumen.json";
import casoInvProductos from "../../../tests/contract/lecturas/casos/inventario/productos_por_categoria.json";
import goldenInvProductos from "../../../tests/contract/lecturas/golden/inventario/productos_por_categoria.json";
import casoInvResumen from "../../../tests/contract/lecturas/casos/inventario/resumen.json";
import goldenInvResumen from "../../../tests/contract/lecturas/golden/inventario/resumen.json";
import casoMesaLineas from "../../../tests/contract/lecturas/casos/mesas/lineas_comanda.json";
import goldenMesaLineas from "../../../tests/contract/lecturas/golden/mesas/lineas_comanda.json";
import casoVrComandas from "../../../tests/contract/lecturas/casos/venta_rapida/comandas_barra.json";
import goldenVrComandas from "../../../tests/contract/lecturas/golden/venta_rapida/comandas_barra.json";
import casoVrLineas from "../../../tests/contract/lecturas/casos/venta_rapida/lineas_comanda.json";
import goldenVrLineas from "../../../tests/contract/lecturas/golden/venta_rapida/lineas_comanda.json";
import casoTareasAdmin from "../../../tests/contract/lecturas/casos/tareas/admin.json";
import goldenTareasAdmin from "../../../tests/contract/lecturas/golden/tareas/admin.json";
import casoTareasMias from "../../../tests/contract/lecturas/casos/tareas/mias.json";
import goldenTareasMias from "../../../tests/contract/lecturas/golden/tareas/mias.json";
import casoHorSemana from "../../../tests/contract/lecturas/casos/trabajadores/asignaciones_semana.json";
import goldenHorSemana from "../../../tests/contract/lecturas/golden/trabajadores/asignaciones_semana.json";
import casoHorSemanaDef from "../../../tests/contract/lecturas/casos/trabajadores/asignaciones_semana_con_predeterminado.json";
import goldenHorSemanaDef from "../../../tests/contract/lecturas/golden/trabajadores/asignaciones_semana_con_predeterminado.json";
import casoHorSemanaLibre from "../../../tests/contract/lecturas/casos/trabajadores/asignaciones_semana_con_libre.json";
import goldenHorSemanaLibre from "../../../tests/contract/lecturas/golden/trabajadores/asignaciones_semana_con_libre.json";
import casoMesaLayout from "../../../tests/contract/lecturas/casos/mesas/layout.json";
import goldenMesaLayout from "../../../tests/contract/lecturas/golden/mesas/layout.json";
import casoMesaMetaAll from "../../../tests/contract/lecturas/casos/mesas/meta_all.json";
import goldenMesaMetaAll from "../../../tests/contract/lecturas/golden/mesas/meta_all.json";
import casoMesaComandaAbierta from "../../../tests/contract/lecturas/casos/mesas/comanda_abierta_by_mesa.json";
import goldenMesaComandaAbierta from "../../../tests/contract/lecturas/golden/mesas/comanda_abierta_by_mesa.json";
import casoMesaCategorias from "../../../tests/contract/lecturas/casos/mesas/categorias.json";
import goldenMesaCategorias from "../../../tests/contract/lecturas/golden/mesas/categorias.json";
import casoMesaProductos from "../../../tests/contract/lecturas/casos/mesas/productos_por_categoria.json";
import goldenMesaProductos from "../../../tests/contract/lecturas/golden/mesas/productos_por_categoria.json";
import casoMesaBuscar from "../../../tests/contract/lecturas/casos/mesas/buscar_productos.json";
import goldenMesaBuscar from "../../../tests/contract/lecturas/golden/mesas/buscar_productos.json";
import casoMesaCocina from "../../../tests/contract/lecturas/casos/mesas/cocina_pendiente.json";
import goldenMesaCocina from "../../../tests/contract/lecturas/golden/mesas/cocina_pendiente.json";
import casoVrCategorias from "../../../tests/contract/lecturas/casos/venta_rapida/categorias.json";
import goldenVrCategorias from "../../../tests/contract/lecturas/golden/venta_rapida/categorias.json";
import casoVrProductos from "../../../tests/contract/lecturas/casos/venta_rapida/productos_por_categoria.json";
import goldenVrProductos from "../../../tests/contract/lecturas/golden/venta_rapida/productos_por_categoria.json";
import casoVrBuscar from "../../../tests/contract/lecturas/casos/venta_rapida/buscar_productos.json";
import goldenVrBuscar from "../../../tests/contract/lecturas/golden/venta_rapida/buscar_productos.json";
import casoVrVerTicket from "../../../tests/contract/lecturas/casos/venta_rapida/detalles_ver_ticket.json";
import goldenVrVerTicket from "../../../tests/contract/lecturas/golden/venta_rapida/detalles_ver_ticket.json";
import casoVrIndexRows from "../../../tests/contract/lecturas/casos/venta_rapida/index_rows.json";
import casoVrIndexRows120 from "../../../tests/contract/lecturas/casos/venta_rapida/index_rows_120_tickets.json";
import goldenVrIndexRows120 from "../../../tests/contract/lecturas/golden/venta_rapida/index_rows_120_tickets.json";
import goldenVrIndexRows from "../../../tests/contract/lecturas/golden/venta_rapida/index_rows.json";

import casoCfgBusiness from "../../../tests/contract/lecturas/casos/configuracion/business.json";
import goldenCfgBusiness from "../../../tests/contract/lecturas/golden/configuracion/business.json";
import casoCfgTicket from "../../../tests/contract/lecturas/casos/configuracion/ticket.json";
import goldenCfgTicket from "../../../tests/contract/lecturas/golden/configuracion/ticket.json";
import casoCfgContact from "../../../tests/contract/lecturas/casos/configuracion/contact.json";
import goldenCfgContact from "../../../tests/contract/lecturas/golden/configuracion/contact.json";
import casoInvCategorias from "../../../tests/contract/lecturas/casos/inventario/categorias.json";
import goldenInvCategorias from "../../../tests/contract/lecturas/golden/inventario/categorias.json";
import casoInvProvMini from "../../../tests/contract/lecturas/casos/inventario/proveedores_mini.json";
import goldenInvProvMini from "../../../tests/contract/lecturas/golden/inventario/proveedores_mini.json";
import casoInvAlergenos from "../../../tests/contract/lecturas/casos/inventario/alergenos.json";
import goldenInvAlergenos from "../../../tests/contract/lecturas/golden/inventario/alergenos.json";
import casoInvLotes from "../../../tests/contract/lecturas/casos/inventario/lotes_por_producto.json";
import goldenInvLotes from "../../../tests/contract/lecturas/golden/inventario/lotes_por_producto.json";
import casoInvDetalle from "../../../tests/contract/lecturas/casos/inventario/product_detail.json";
import casoInvCatalogoIngr from "../../../tests/contract/lecturas/casos/inventario/catalogo_ingredientes.json";
import goldenInvCatalogoIngr from "../../../tests/contract/lecturas/golden/inventario/catalogo_ingredientes.json";
import casoInvIngrProducto from "../../../tests/contract/lecturas/casos/inventario/ingredientes_de_producto.json";
import goldenInvIngrProducto from "../../../tests/contract/lecturas/golden/inventario/ingredientes_de_producto.json";
import goldenInvDetalle from "../../../tests/contract/lecturas/golden/inventario/product_detail.json";
import casoInvDetalleSinCat from "../../../tests/contract/lecturas/casos/inventario/product_detail_sin_categoria.json";
import goldenInvDetalleSinCat from "../../../tests/contract/lecturas/golden/inventario/product_detail_sin_categoria.json";
import casoLoginUsuarios from "../../../tests/contract/lecturas/casos/login/usuarios.json";
import goldenLoginUsuarios from "../../../tests/contract/lecturas/golden/login/usuarios.json";
import casoLoginPunch from "../../../tests/contract/lecturas/casos/login/punch_status.json";
import goldenLoginPunch from "../../../tests/contract/lecturas/golden/login/punch_status.json";
import casoNotifListar from "../../../tests/contract/lecturas/casos/notificaciones/listar.json";
import goldenNotifListar from "../../../tests/contract/lecturas/golden/notificaciones/listar.json";
import casoNotifContar from "../../../tests/contract/lecturas/casos/notificaciones/contar_no_leidas.json";
import goldenNotifContar from "../../../tests/contract/lecturas/golden/notificaciones/contar_no_leidas.json";
import casoNotifPapelera from "../../../tests/contract/lecturas/casos/notificaciones/papelera.json";
import goldenNotifPapelera from "../../../tests/contract/lecturas/golden/notificaciones/papelera.json";
import casoPedPagina from "../../../tests/contract/lecturas/casos/pedidos_proveedor/pagina.json";
import goldenPedPagina from "../../../tests/contract/lecturas/golden/pedidos_proveedor/pagina.json";
import casoPedBusqueda from "../../../tests/contract/lecturas/casos/pedidos_proveedor/pagina_busqueda.json";
import goldenPedBusqueda from "../../../tests/contract/lecturas/golden/pedidos_proveedor/pagina_busqueda.json";
import casoPedComodines from "../../../tests/contract/lecturas/casos/pedidos_proveedor/pagina_comodines.json";
import goldenPedComodines from "../../../tests/contract/lecturas/golden/pedidos_proveedor/pagina_comodines.json";
import casoPedSegunda from "../../../tests/contract/lecturas/casos/pedidos_proveedor/pagina_segunda.json";
import goldenPedSegunda from "../../../tests/contract/lecturas/golden/pedidos_proveedor/pagina_segunda.json";
import casoPedTecho from "../../../tests/contract/lecturas/casos/pedidos_proveedor/pagina_techo.json";
import goldenPedTecho from "../../../tests/contract/lecturas/golden/pedidos_proveedor/pagina_techo.json";
import casoProvTodos from "../../../tests/contract/lecturas/casos/proveedores/todos.json";
import goldenProvTodos from "../../../tests/contract/lecturas/golden/proveedores/todos.json";
import casoProvCategorias from "../../../tests/contract/lecturas/casos/proveedores/categorias.json";
import goldenProvCategorias from "../../../tests/contract/lecturas/golden/proveedores/categorias.json";
import casoProvProductos from "../../../tests/contract/lecturas/casos/proveedores/productos.json";
import goldenProvProductos from "../../../tests/contract/lecturas/golden/proveedores/productos.json";
import casoProvProductosTodos from "../../../tests/contract/lecturas/casos/proveedores/productos_todos.json";
import goldenProvProductosTodos from "../../../tests/contract/lecturas/golden/proveedores/productos_todos.json";
import casoResMeta from "../../../tests/contract/lecturas/casos/reservas/meta.json";
import goldenResMeta from "../../../tests/contract/lecturas/golden/reservas/meta.json";
import casoResMes from "../../../tests/contract/lecturas/casos/reservas/mes.json";
import goldenResMes from "../../../tests/contract/lecturas/golden/reservas/mes.json";
import casoResUna from "../../../tests/contract/lecturas/casos/reservas/una.json";
import goldenResUna from "../../../tests/contract/lecturas/golden/reservas/una.json";
import casoResBuscar from "../../../tests/contract/lecturas/casos/reservas/buscar_cliente.json";
import goldenResBuscar from "../../../tests/contract/lecturas/golden/reservas/buscar_cliente.json";
import casoResBuscarTel from "../../../tests/contract/lecturas/casos/reservas/buscar_cliente_por_telefono.json";
import goldenResBuscarTel from "../../../tests/contract/lecturas/golden/reservas/buscar_cliente_por_telefono.json";
import casoTareaTrab from "../../../tests/contract/lecturas/casos/tareas/trabajadores.json";
import goldenTareaTrab from "../../../tests/contract/lecturas/golden/tareas/trabajadores.json";
import casoTareaPapelera from "../../../tests/contract/lecturas/casos/tareas/papelera.json";
import goldenTareaPapelera from "../../../tests/contract/lecturas/golden/tareas/papelera.json";
import casoTareaPorId from "../../../tests/contract/lecturas/casos/tareas/por_id.json";
import goldenTareaPorId from "../../../tests/contract/lecturas/golden/tareas/por_id.json";
import casoTareaAsignados from "../../../tests/contract/lecturas/casos/tareas/asignados.json";
import goldenTareaAsignados from "../../../tests/contract/lecturas/golden/tareas/asignados.json";
import casoPermisos from "../../../tests/contract/lecturas/casos/trabajadores/permisos_usuario.json";
import goldenPermisos from "../../../tests/contract/lecturas/golden/trabajadores/permisos_usuario.json";
import casoTrabRoles from "../../../tests/contract/lecturas/casos/trabajadores/roles.json";
import goldenTrabRoles from "../../../tests/contract/lecturas/golden/trabajadores/roles.json";
import casoTrabTodos from "../../../tests/contract/lecturas/casos/trabajadores/todos.json";
import goldenTrabTodos from "../../../tests/contract/lecturas/golden/trabajadores/todos.json";
import casoTrabDetalle from "../../../tests/contract/lecturas/casos/trabajadores/detalle.json";
import goldenTrabDetalle from "../../../tests/contract/lecturas/golden/trabajadores/detalle.json";
import casoTrabIdUsuario from "../../../tests/contract/lecturas/casos/trabajadores/id_por_usuario.json";
import goldenTrabIdUsuario from "../../../tests/contract/lecturas/golden/trabajadores/id_por_usuario.json";
import casoTrabTurnos from "../../../tests/contract/lecturas/casos/trabajadores/turnos.json";
import goldenTrabTurnos from "../../../tests/contract/lecturas/golden/trabajadores/turnos.json";
import casoStatsCategorias from "../../../tests/contract/lecturas/casos/stats/categorias.json";
import goldenStatsCategorias from "../../../tests/contract/lecturas/golden/stats/categorias.json";
import casoStatsClientes from "../../../tests/contract/lecturas/casos/stats/clientes.json";
import goldenStatsClientes from "../../../tests/contract/lecturas/golden/stats/clientes.json";
import casoStatsClientesReservaTerminada from "../../../tests/contract/lecturas/casos/stats/clientes_reserva_terminada.json";
import goldenStatsClientesReservaTerminada from "../../../tests/contract/lecturas/golden/stats/clientes_reserva_terminada.json";
import casoStatsClientesMismoNombre from "../../../tests/contract/lecturas/casos/stats/clientes_mismo_nombre.json";
import goldenStatsClientesMismoNombre from "../../../tests/contract/lecturas/golden/stats/clientes_mismo_nombre.json";
import casoStatsProductos from "../../../tests/contract/lecturas/casos/stats/productos.json";
import goldenStatsProductos from "../../../tests/contract/lecturas/golden/stats/productos.json";
import casoStatsVendidos from "../../../tests/contract/lecturas/casos/stats/productos_vendidos.json";
import goldenStatsVendidos from "../../../tests/contract/lecturas/golden/stats/productos_vendidos.json";
import casoStatsVendidosCat from "../../../tests/contract/lecturas/casos/stats/productos_vendidos_por_categoria.json";
import goldenStatsVendidosCat from "../../../tests/contract/lecturas/golden/stats/productos_vendidos_por_categoria.json";
import casoStatsNombreId from "../../../tests/contract/lecturas/casos/stats/productos_nombre_que_es_un_id.json";
import goldenStatsNombreId from "../../../tests/contract/lecturas/golden/stats/productos_nombre_que_es_un_id.json";
import casoCtaEntradasComodines from "../../../tests/contract/lecturas/casos/cuentas/entradas_busqueda_comodines.json";
import goldenCtaEntradasComodines from "../../../tests/contract/lecturas/golden/cuentas/entradas_busqueda_comodines.json";
import casoCtaEntradasLargo from "../../../tests/contract/lecturas/casos/cuentas/entradas_busqueda_texto_largo.json";
import goldenCtaEntradasLargo from "../../../tests/contract/lecturas/golden/cuentas/entradas_busqueda_texto_largo.json";
import casoCtaSalidasComodines from "../../../tests/contract/lecturas/casos/cuentas/salidas_busqueda_comodines.json";
import goldenCtaSalidasComodines from "../../../tests/contract/lecturas/golden/cuentas/salidas_busqueda_comodines.json";
import casoCtaResumenComodines from "../../../tests/contract/lecturas/casos/cuentas/resumen_busqueda_comodines.json";
import goldenCtaResumenComodines from "../../../tests/contract/lecturas/golden/cuentas/resumen_busqueda_comodines.json";
import casoMesaBuscarComodines from "../../../tests/contract/lecturas/casos/mesas/buscar_productos_comodines.json";
import goldenMesaBuscarComodines from "../../../tests/contract/lecturas/golden/mesas/buscar_productos_comodines.json";
import casoMesaBuscarLargo from "../../../tests/contract/lecturas/casos/mesas/buscar_productos_texto_largo.json";
import goldenMesaBuscarLargo from "../../../tests/contract/lecturas/golden/mesas/buscar_productos_texto_largo.json";
import casoVrBuscarComodines from "../../../tests/contract/lecturas/casos/venta_rapida/buscar_productos_comodines.json";
import goldenVrBuscarComodines from "../../../tests/contract/lecturas/golden/venta_rapida/buscar_productos_comodines.json";
import casoVrBuscarLargo from "../../../tests/contract/lecturas/casos/venta_rapida/buscar_productos_texto_largo.json";
import goldenVrBuscarLargo from "../../../tests/contract/lecturas/golden/venta_rapida/buscar_productos_texto_largo.json";
import casoCtaEntradasSinAcentos from "../../../tests/contract/lecturas/casos/cuentas/entradas_busqueda_sin_acentos.json";
import goldenCtaEntradasSinAcentos from "../../../tests/contract/lecturas/golden/cuentas/entradas_busqueda_sin_acentos.json";
import casoCtaSalidasSinAcentos from "../../../tests/contract/lecturas/casos/cuentas/salidas_busqueda_sin_acentos.json";
import goldenCtaSalidasSinAcentos from "../../../tests/contract/lecturas/golden/cuentas/salidas_busqueda_sin_acentos.json";
import casoCtaSalidasProvBorrado from "../../../tests/contract/lecturas/casos/cuentas/salidas_proveedor_borrado.json";
import goldenCtaSalidasProvBorrado from "../../../tests/contract/lecturas/golden/cuentas/salidas_proveedor_borrado.json";
import casoCtaSalidasProvBorradoBusq from "../../../tests/contract/lecturas/casos/cuentas/salidas_proveedor_borrado_busqueda.json";
import goldenCtaSalidasProvBorradoBusq from "../../../tests/contract/lecturas/golden/cuentas/salidas_proveedor_borrado_busqueda.json";
import casoCtaResumenSinAcentos from "../../../tests/contract/lecturas/casos/cuentas/resumen_busqueda_sin_acentos.json";
import goldenCtaResumenSinAcentos from "../../../tests/contract/lecturas/golden/cuentas/resumen_busqueda_sin_acentos.json";
import casoMesaBuscarSinAcentos from "../../../tests/contract/lecturas/casos/mesas/buscar_productos_sin_acentos.json";
import goldenMesaBuscarSinAcentos from "../../../tests/contract/lecturas/golden/mesas/buscar_productos_sin_acentos.json";
import casoVrBuscarSinAcentos from "../../../tests/contract/lecturas/casos/venta_rapida/buscar_productos_sin_acentos.json";
import goldenVrBuscarSinAcentos from "../../../tests/contract/lecturas/golden/venta_rapida/buscar_productos_sin_acentos.json";
import casoStatsTrabajadores from "../../../tests/contract/lecturas/casos/stats/trabajadores.json";
import goldenStatsTrabajadores from "../../../tests/contract/lecturas/golden/stats/trabajadores.json";
import casoStatsTrabajadoresRetirado from "../../../tests/contract/lecturas/casos/stats/trabajadores_retirado.json";
import goldenStatsTrabajadoresRetirado from "../../../tests/contract/lecturas/golden/stats/trabajadores_retirado.json";
import casoStatsReservas from "../../../tests/contract/lecturas/casos/stats/reservas.json";
import goldenStatsReservas from "../../../tests/contract/lecturas/golden/stats/reservas.json";
import casoStatsReservasSinMesa from "../../../tests/contract/lecturas/casos/stats/reservas_sin_mesa.json";
import goldenStatsReservasSinMesa from "../../../tests/contract/lecturas/golden/stats/reservas_sin_mesa.json";
import casoStatsProveedores from "../../../tests/contract/lecturas/casos/stats/proveedores.json";
import goldenStatsProveedores from "../../../tests/contract/lecturas/golden/stats/proveedores.json";
import casoStatsGastoMedio from "../../../tests/contract/lecturas/casos/stats/proveedores_gasto_medio.json";
import goldenStatsGastoMedio from "../../../tests/contract/lecturas/golden/stats/proveedores_gasto_medio.json";
import casoStatsProveedoresSinClave from "../../../tests/contract/lecturas/casos/stats/proveedores_sin_clave.json";
import goldenStatsProveedoresSinClave from "../../../tests/contract/lecturas/golden/stats/proveedores_sin_clave.json";
import casoStatsMesas from "../../../tests/contract/lecturas/casos/stats/mesas.json";
import goldenStatsMesas from "../../../tests/contract/lecturas/golden/stats/mesas.json";
import casoStatsMesasSemana from "../../../tests/contract/lecturas/casos/stats/mesas_semana.json";
import goldenStatsMesasSemana from "../../../tests/contract/lecturas/golden/stats/mesas_semana.json";
import casoStatsProductosSemana from "../../../tests/contract/lecturas/casos/stats/productos_semana.json";
import goldenStatsProductosSemana from "../../../tests/contract/lecturas/golden/stats/productos_semana.json";

const CASOS = [
	{ nombre: "clientes_overview_reciente", caso: casoCliReciente, golden: goldenCliReciente },
	{ nombre: "clientes_overview_por_reservas", caso: casoCliReservas, golden: goldenCliReservas },
	{ nombre: "clientes_overview_por_gasto", caso: casoCliGasto, golden: goldenCliGasto },
	{ nombre: "clientes_form", caso: casoCliForm, golden: goldenCliForm },
	{ nombre: "cuentas_entradas", caso: casoCtaEntradas, golden: goldenCtaEntradas },
	{
		nombre: "cuentas_entradas_busqueda_paginada",
		caso: casoCtaEntradasPag,
		golden: goldenCtaEntradasPag,
	},
	{
		nombre: "cuentas_entradas_primera_pagina",
		caso: casoCtaEntradasPag1,
		golden: goldenCtaEntradasPag1,
	},
	{
		nombre: "cuentas_entradas_mesa_con_nombre",
		caso: casoCtaEntradasMesa,
		golden: goldenCtaEntradasMesa,
	},
	{ nombre: "cuentas_salidas", caso: casoCtaSalidas, golden: goldenCtaSalidas },
	{ nombre: "cuentas_resumen", caso: casoCtaResumen, golden: goldenCtaResumen },
	{ nombre: "cuentas_cierre_ultimo", caso: casoCtaCierreUltimo, golden: goldenCtaCierreUltimo },
	{ nombre: "cuentas_cierre_listar", caso: casoCtaCierreListar, golden: goldenCtaCierreListar },
	{ nombre: "cuentas_cierre_detalle", caso: casoCtaCierreDetalle, golden: goldenCtaCierreDetalle },
	{
		nombre: "inventario_productos_por_categoria",
		caso: casoInvProductos,
		golden: goldenInvProductos,
	},
	{ nombre: "inventario_resumen", caso: casoInvResumen, golden: goldenInvResumen },
	{ nombre: "mesas_lineas_comanda", caso: casoMesaLineas, golden: goldenMesaLineas },
	{ nombre: "venta_rapida_comandas_barra", caso: casoVrComandas, golden: goldenVrComandas },
	{ nombre: "venta_rapida_lineas_comanda", caso: casoVrLineas, golden: goldenVrLineas },
	{ nombre: "tareas_admin", caso: casoTareasAdmin, golden: goldenTareasAdmin },
	{ nombre: "tareas_mias", caso: casoTareasMias, golden: goldenTareasMias },
	{ nombre: "trabajadores_asignaciones_semana", caso: casoHorSemana, golden: goldenHorSemana },
	{
		nombre: "trabajadores_asignaciones_semana_con_predeterminado",
		caso: casoHorSemanaDef,
		golden: goldenHorSemanaDef,
	},
	{
		nombre: "trabajadores_asignaciones_semana_con_libre",
		caso: casoHorSemanaLibre,
		golden: goldenHorSemanaLibre,
	},
	{ nombre: "mesas_layout", caso: casoMesaLayout, golden: goldenMesaLayout },
	{ nombre: "mesas_meta_all", caso: casoMesaMetaAll, golden: goldenMesaMetaAll },
	{
		nombre: "mesas_comanda_abierta_by_mesa",
		caso: casoMesaComandaAbierta,
		golden: goldenMesaComandaAbierta,
	},
	{ nombre: "mesas_categorias", caso: casoMesaCategorias, golden: goldenMesaCategorias },
	{ nombre: "mesas_productos_por_categoria", caso: casoMesaProductos, golden: goldenMesaProductos },
	{ nombre: "mesas_buscar_productos", caso: casoMesaBuscar, golden: goldenMesaBuscar },
	{ nombre: "mesas_cocina_pendiente", caso: casoMesaCocina, golden: goldenMesaCocina },
	{ nombre: "venta_rapida_categorias", caso: casoVrCategorias, golden: goldenVrCategorias },
	{
		nombre: "venta_rapida_productos_por_categoria",
		caso: casoVrProductos,
		golden: goldenVrProductos,
	},
	{ nombre: "venta_rapida_buscar_productos", caso: casoVrBuscar, golden: goldenVrBuscar },
	{
		nombre: "venta_rapida_detalles_ver_ticket",
		caso: casoVrVerTicket,
		golden: goldenVrVerTicket,
	},
	{ nombre: "venta_rapida_index_rows", caso: casoVrIndexRows, golden: goldenVrIndexRows },
	{ nombre: "venta_rapida_index_rows_120_tickets", caso: casoVrIndexRows120, golden: goldenVrIndexRows120 },
	{ nombre: "configuracion_business", caso: casoCfgBusiness, golden: goldenCfgBusiness },
	{ nombre: "configuracion_ticket", caso: casoCfgTicket, golden: goldenCfgTicket },
	{ nombre: "configuracion_contact", caso: casoCfgContact, golden: goldenCfgContact },
	{ nombre: "inventario_categorias", caso: casoInvCategorias, golden: goldenInvCategorias },
	{ nombre: "inventario_proveedores_mini", caso: casoInvProvMini, golden: goldenInvProvMini },
	{ nombre: "inventario_alergenos", caso: casoInvAlergenos, golden: goldenInvAlergenos },
	{ nombre: "inventario_lotes_por_producto", caso: casoInvLotes, golden: goldenInvLotes },
	{ nombre: "inventario_product_detail", caso: casoInvDetalle, golden: goldenInvDetalle },
	{ nombre: "inventario_product_detail_sin_categoria", caso: casoInvDetalleSinCat, golden: goldenInvDetalleSinCat },
	{ nombre: "inventario_catalogo_ingredientes", caso: casoInvCatalogoIngr, golden: goldenInvCatalogoIngr },
	{ nombre: "inventario_ingredientes_de_producto", caso: casoInvIngrProducto, golden: goldenInvIngrProducto },
	{ nombre: "login_usuarios", caso: casoLoginUsuarios, golden: goldenLoginUsuarios },
	{ nombre: "login_punch_status", caso: casoLoginPunch, golden: goldenLoginPunch },
	{ nombre: "notificaciones_listar", caso: casoNotifListar, golden: goldenNotifListar },
	{ nombre: "notificaciones_contar_no_leidas", caso: casoNotifContar, golden: goldenNotifContar },
	{ nombre: "notificaciones_papelera", caso: casoNotifPapelera, golden: goldenNotifPapelera },
	{ nombre: "pedidos_proveedor_pagina", caso: casoPedPagina, golden: goldenPedPagina },
	{ nombre: "pedidos_proveedor_pagina_busqueda", caso: casoPedBusqueda, golden: goldenPedBusqueda },
	{ nombre: "pedidos_proveedor_pagina_comodines", caso: casoPedComodines, golden: goldenPedComodines },
	{ nombre: "pedidos_proveedor_pagina_segunda", caso: casoPedSegunda, golden: goldenPedSegunda },
	{ nombre: "pedidos_proveedor_pagina_techo", caso: casoPedTecho, golden: goldenPedTecho },
	{ nombre: "proveedores_todos", caso: casoProvTodos, golden: goldenProvTodos },
	{ nombre: "proveedores_categorias", caso: casoProvCategorias, golden: goldenProvCategorias },
	{ nombre: "proveedores_productos", caso: casoProvProductos, golden: goldenProvProductos },
	{ nombre: "proveedores_productos_todos", caso: casoProvProductosTodos, golden: goldenProvProductosTodos },
	{ nombre: "reservas_meta", caso: casoResMeta, golden: goldenResMeta },
	{ nombre: "reservas_mes", caso: casoResMes, golden: goldenResMes },
	{ nombre: "reservas_una", caso: casoResUna, golden: goldenResUna },
	{ nombre: "reservas_buscar_cliente", caso: casoResBuscar, golden: goldenResBuscar },
	{ nombre: "reservas_buscar_cliente_por_telefono", caso: casoResBuscarTel, golden: goldenResBuscarTel },
	{ nombre: "tareas_trabajadores", caso: casoTareaTrab, golden: goldenTareaTrab },
	{ nombre: "tareas_papelera", caso: casoTareaPapelera, golden: goldenTareaPapelera },
	{ nombre: "tareas_por_id", caso: casoTareaPorId, golden: goldenTareaPorId },
	{ nombre: "tareas_asignados", caso: casoTareaAsignados, golden: goldenTareaAsignados },
	{ nombre: "trabajadores_permisos", caso:casoPermisos, golden:goldenPermisos },
	{ nombre: "trabajadores_roles", caso: casoTrabRoles, golden: goldenTrabRoles },
	{ nombre: "trabajadores_todos", caso: casoTrabTodos, golden: goldenTrabTodos },
	{ nombre: "trabajadores_detalle", caso: casoTrabDetalle, golden: goldenTrabDetalle },
	{ nombre: "trabajadores_id_por_usuario", caso: casoTrabIdUsuario, golden: goldenTrabIdUsuario },
	{ nombre: "trabajadores_turnos", caso: casoTrabTurnos, golden: goldenTrabTurnos },
	{ nombre: "stats_categorias", caso: casoStatsCategorias, golden: goldenStatsCategorias },
	{ nombre: "stats_mesas", caso: casoStatsMesas, golden: goldenStatsMesas },
	{ nombre: "stats_mesas_semana", caso: casoStatsMesasSemana, golden: goldenStatsMesasSemana },
	{ nombre: "stats_productos_semana", caso: casoStatsProductosSemana, golden: goldenStatsProductosSemana },
	{ nombre: "stats_proveedores", caso: casoStatsProveedores, golden: goldenStatsProveedores },
	{ nombre: "stats_proveedores_gasto_medio", caso: casoStatsGastoMedio, golden: goldenStatsGastoMedio },
	{
		nombre: "stats_proveedores_sin_clave",
		caso: casoStatsProveedoresSinClave,
		golden: goldenStatsProveedoresSinClave,
	},
	{ nombre: "stats_productos", caso: casoStatsProductos, golden: goldenStatsProductos },
	{ nombre: "stats_productos_vendidos", caso: casoStatsVendidos, golden: goldenStatsVendidos },
	{
		nombre: "stats_productos_vendidos_por_categoria",
		caso: casoStatsVendidosCat,
		golden: goldenStatsVendidosCat,
	},
	{
		nombre: "stats_productos_nombre_que_es_un_id",
		caso: casoStatsNombreId,
		golden: goldenStatsNombreId,
	},
	{ nombre: "stats_clientes", caso: casoStatsClientes, golden: goldenStatsClientes },
	{
		nombre: "stats_clientes_reserva_terminada",
		caso: casoStatsClientesReservaTerminada,
		golden: goldenStatsClientesReservaTerminada,
	},
	{ nombre: "stats_clientes_mismo_nombre", caso: casoStatsClientesMismoNombre, golden: goldenStatsClientesMismoNombre },
	{ nombre: "stats_reservas", caso: casoStatsReservas, golden: goldenStatsReservas },
	{ nombre: "stats_reservas_sin_mesa", caso: casoStatsReservasSinMesa, golden: goldenStatsReservasSinMesa },
	{ nombre: "stats_trabajadores", caso: casoStatsTrabajadores, golden: goldenStatsTrabajadores },
	{ nombre: "stats_trabajadores_retirado", caso: casoStatsTrabajadoresRetirado, golden: goldenStatsTrabajadoresRetirado },
	// Las búsquedas de texto: el % y el _ tal cual, y un texto de más de 50 bytes.
	{ nombre: "cuentas_entradas_busqueda_comodines", caso: casoCtaEntradasComodines, golden: goldenCtaEntradasComodines },
	{ nombre: "cuentas_entradas_busqueda_texto_largo", caso: casoCtaEntradasLargo, golden: goldenCtaEntradasLargo },
	{ nombre: "cuentas_salidas_busqueda_comodines", caso: casoCtaSalidasComodines, golden: goldenCtaSalidasComodines },
	{ nombre: "cuentas_resumen_busqueda_comodines", caso: casoCtaResumenComodines, golden: goldenCtaResumenComodines },
	{ nombre: "mesas_buscar_productos_comodines", caso: casoMesaBuscarComodines, golden: goldenMesaBuscarComodines },
	{ nombre: "mesas_buscar_productos_texto_largo", caso: casoMesaBuscarLargo, golden: goldenMesaBuscarLargo },
	{ nombre: "venta_rapida_buscar_productos_comodines", caso: casoVrBuscarComodines, golden: goldenVrBuscarComodines },
	{ nombre: "venta_rapida_buscar_productos_texto_largo", caso: casoVrBuscarLargo, golden: goldenVrBuscarLargo },
	{ nombre: "cuentas_entradas_busqueda_sin_acentos", caso: casoCtaEntradasSinAcentos, golden: goldenCtaEntradasSinAcentos },
	{ nombre: "cuentas_salidas_busqueda_sin_acentos", caso: casoCtaSalidasSinAcentos, golden: goldenCtaSalidasSinAcentos },
	{ nombre: "cuentas_salidas_proveedor_borrado", caso: casoCtaSalidasProvBorrado, golden: goldenCtaSalidasProvBorrado },
	{
		nombre: "cuentas_salidas_proveedor_borrado_busqueda",
		caso: casoCtaSalidasProvBorradoBusq,
		golden: goldenCtaSalidasProvBorradoBusq,
	},
	{ nombre: "cuentas_resumen_busqueda_sin_acentos", caso: casoCtaResumenSinAcentos, golden: goldenCtaResumenSinAcentos },
	{ nombre: "mesas_buscar_productos_sin_acentos", caso: casoMesaBuscarSinAcentos, golden: goldenMesaBuscarSinAcentos },
	{ nombre: "venta_rapida_buscar_productos_sin_acentos", caso: casoVrBuscarSinAcentos, golden: goldenVrBuscarSinAcentos },
];

// ── Comparación estructural ORDENADA (misma spec que el lado Rust) ───────────────────

const TOL = 1e-9;

const aNumero = (v: any): number => (typeof v === "bigint" ? Number(v) : v);

function celdaIgual(a: any, b: any): boolean {
	if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
	const numericos =
		["number", "bigint"].includes(typeof a) || ["number", "bigint"].includes(typeof b);
	if (numericos) return Math.abs(aNumero(a) - aNumero(b)) < TOL;
	return a === b;
}

/**
 * Claves con valor no nulo, ordenadas.
 *
 * Un `null` y una clave ausente cuentan como lo mismo, y no por laxitud: en producción esta
 * respuesta la deserializa `tpv-infra-http` dentro del DTO, y un `Option<T>` de serde acepta las dos
 * formas. Exigir que coincidan sería inventarse un requisito que el sistema real no tiene.
 */
function clavesUtiles(o: any): string[] {
	return Object.keys(o)
		.filter((k) => o[k] !== null && o[k] !== undefined)
		.sort();
}

/** Devuelve el error encontrado, o `null` si son estructuralmente iguales. Los arrays van EN ORDEN. */
function valorIgual(a: any, b: any): string | null {
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b)) return `uno es lista y el otro no`;
		if (a.length !== b.length) {
			return `${a.length} elementos frente a ${b.length} esperados`;
		}
		for (let i = 0; i < a.length; i++) {
			const e = valorIgual(a[i], b[i]);
			if (e) return `[${i}] ${e}`;
		}
		return null;
	}

	const objetos =
		a !== null && b !== null && typeof a === "object" && typeof b === "object";
	if (objetos) {
		const ka = clavesUtiles(a);
		const kb = clavesUtiles(b);
		if (ka.join(",") !== kb.join(",")) {
			return `campos [${ka}] frente a [${kb}]`;
		}
		for (const k of ka) {
			const e = valorIgual(a[k], b[k]);
			if (e) return `.${k} ${e}`;
		}
		return null;
	}

	return celdaIgual(a, b) ? null : `${JSON.stringify(a)} frente a ${JSON.stringify(b)}`;
}

/**
 * Borra, a cualquier profundidad, los campos que el caso declara en `omitir`.
 *
 * Es el equivalente de lectura a los SELECT del harness de escritura, que dejan fuera las columnas
 * no deterministas. Algunas consultas devuelven **dentro del resultado** algo que depende del reloj
 * —`punch_status` echa la fecha de hoy en el propio objeto—, y ahí no hay seed que valga: el golden
 * caducaría a medianoche.
 */
function omitirCampos(v: any, campos: string[]): any {
	if (Array.isArray(v)) return v.map((x) => omitirCampos(x, campos));
	if (v !== null && typeof v === "object") {
		const out: Record<string, any> = {};
		for (const [k, val] of Object.entries(v)) {
			if (campos.includes(k)) continue;
			out[k] = omitirCampos(val, campos);
		}
		return out;
	}
	return v;
}

/** Corre la lectura del caso por su camino real. El `switch` es el punto de extensión: una lectura
 *  nueva añade su brazo aquí y en el lado Rust (`ejecutar_lectura`). */
/** El cursor de un listado de caja, como lo compone `listadoSchema` desde sus dos parámetros. */
function cursorDe(e: any): { fecha: string; id: string } | null {
	return e.cursor_fecha && e.cursor_id ? { fecha: e.cursor_fecha, id: e.cursor_id } : null;
}

async function ejecutarLectura(db: any, caso: any): Promise<any> {
	const e = caso.entrada ?? {};
	switch (caso.lectura) {
		case "clientes.overview":
			return overview(db, e.ranking);
		case "clientes.form":
			return clienteForm(db, e.id_cliente);
		case "cuentas.entradas":
			return entradas(db, e.del ?? null, e.al ?? null, e.q ?? null, e.page_size ?? null, cursorDe(e));
		case "cuentas.salidas":
			return salidas(db, e.del ?? null, e.al ?? null, e.q ?? null, e.page_size ?? null, cursorDe(e));
		case "cuentas.cierre_ultimo":
			return ultimoCierre(db);
		case "cuentas.cierre_listar":
			return listarCierres(db, e.limite ?? 50);
		case "cuentas.cierre_detalle":
			return detalleCierre(db, e.id_cierre);
		case "cuentas.resumen":
			return resumenCuentas(db, e.del ?? null, e.al ?? null, e.q ?? null);
		case "inventario.productos_por_categoria":
			return listProductosByCategoria(db, e.id_categoria);
		case "inventario.resumen":
			return resumenInventario(db, e.limit);
		case "mesas.lineas_comanda":
			return lineasMesa(db, e.id_comanda);
		case "mesas.layout":
			return loadLayout(db);
		case "mesas.meta_all":
			// Sin hora de la Handy: cuenta el reloj, como la Main con el suyo.
			return mesasMetaAll(db, null);
		case "mesas.comanda_abierta_by_mesa":
			return comandaAbiertaByMesa(db, e.id_mesa);
		case "mesas.categorias":
			return categoriasMesa(db);
		case "mesas.productos_por_categoria":
			return productosByCategoriaMesa(db, e.id_categoria);
		case "mesas.buscar_productos":
			return searchProductosMesa(db, e.query);
		case "mesas.cocina_pendiente":
			return kitchenList(db);
		case "venta_rapida.comandas_barra":
			return listComandas(db, e.limit);
		case "venta_rapida.lineas_comanda":
			return lineasBarra(db, e.id_comanda);
		case "venta_rapida.categorias":
			return categoriasBarra(db);
		case "venta_rapida.productos_por_categoria":
			return productosByCategoriaBarra(db, e.id_categoria);
		case "venta_rapida.buscar_productos":
			return searchProductosBarra(db, e.query, e.limit);
		case "venta_rapida.detalles_ver_ticket":
			return detallesVerTicket(db, e.id_comanda);
		case "venta_rapida.index_rows":
			return indexRows(db, e.ids);
		case "tareas.admin":
			return getTareasAdmin(db);
		case "tareas.mias":
			return getMisTareas(db, e.id_trabajador);
		case "trabajadores.asignaciones_semana":
			return asignacionesSemana(db, e.fecha_lunes);
		case "configuracion.business":
			return getBusiness(db);
		case "configuracion.ticket":
			return getTicket(db);
		case "configuracion.contact":
			return getContact(db);
		case "inventario.categorias":
			return listCategoriasInv(db);
		case "inventario.proveedores_mini":
			return listProveedoresMini(db);
		case "inventario.alergenos":
			return listAlergenos(db);
		case "inventario.lotes_por_producto":
			return listLotesByProducto(db, e.id_producto);
		case "inventario.catalogo_ingredientes":
			return catalogoIngredientes(db);
		case "inventario.ingredientes_de_producto":
			return ingredientesDeProducto(db, e.id_producto);
		case "inventario.product_detail":
			return productDetail(db, e.id_producto);
		case "login.usuarios":
			return listLoginUsers(db);
		case "login.punch_status":
			return punchStatus(db, e.id_usuario);
		case "notificaciones.listar":
			return listarNotificaciones(db, e.id_usuario, e.solo_no_leidas);
		case "notificaciones.contar_no_leidas":
			return contarNoLeidas(db, e.id_usuario);
		case "notificaciones.papelera":
			return listarPapelera(db, e.id_usuario);
		case "pedidos_proveedor.pagina":
			return paginaDePedidos(db, e.limit, e.offset, e.search ?? null);
		case "proveedores.todos":
			return proveedoresTodos(db);
		case "proveedores.categorias":
			return proveedoresCategorias(db);
		case "proveedores.productos":
			return proveedoresProductos(db, e.id_proveedor);
		case "proveedores.productos_todos":
			return proveedoresProductosTodos(db);
		case "reservas.meta":
			return reservasMeta(db);
		case "reservas.mes":
			return reservasMes(db, e.desde, e.hasta);
		case "reservas.una":
			return reservasUna(db, e.id_reserva);
		case "reservas.buscar_cliente":
			return reservasBuscarCliente(db, e.telefono ?? null, e.email ?? null);
		case "tareas.trabajadores":
			return getTrabajadores(db);
		case "tareas.papelera":
			return getPapelera(db);
		case "tareas.por_id":
			return getTareaById(db, e.id_tarea);
		case "tareas.asignados":
			return getTareaAsignados(db, e.id_tarea);
		case "trabajadores.permisos_usuario":
			return permisosUsuario(db, e.id_usuario);
		case "trabajadores.roles":
			return trabajadoresRoles(db);
		case "trabajadores.todos":
			return trabajadoresTodos(db);
		case "trabajadores.detalle":
			return trabajadorDetalle(db, e.id_trabajador);
		case "trabajadores.id_por_usuario":
			return idByUsuario(db, e.id_usuario);
		case "trabajadores.turnos":
			return trabajadoresTurnos(db);
		case "stats.categorias":
			return statsCategorias(db);
		case "stats.mesas":
			return statsMesas(db, e.range ?? "hoy");
		case "stats.proveedores":
			return statsProveedores(db, "hoy");
		case "stats.trabajadores":
			return statsTrabajadores(db, "hoy");
		case "stats.reservas":
			return statsReservas(db, "hoy", "TODOS");
		case "stats.clientes":
			return statsClientes(db, "hoy");
		case "stats.productos":
			return statsProductos(db, e.range ?? "hoy", e.categoria_top_id ?? null, e.categoria_worst_id ?? null);
		default:
			throw new Error(`lectura sin soporte en el harness de contrato: ${caso.lectura}`);
	}
}

describe("contrato de lectura Main↔worker · resultado == golden", () => {
	for (const { nombre, caso, golden } of CASOS) {
		it(`${nombre}: devuelve lo mismo que la Main`, async () => {
			await enElHub(`contract-lectura-${nombre}`, async (hub: any) => {
				const sql = hub.state.storage.sql;
				const db = clienteSobre(sql);

				// 1) Esquema real + siembra del caso (idéntica al lado Rust).
				crearEsquemaTenant(sql);
				for (const s of (caso as any).seed) sql.exec(s);

				// 2) La consulta por su camino real.
				const crudo = await ejecutarLectura(db, caso);
				const obtenido = omitirCampos(crudo, (caso as any).omitir ?? []);

				// 3) Resultado frente al golden que bendijo Rust.
				const err = valorIgual(obtenido, golden);
				expect(err, `${nombre}: ${err}`).toBeNull();
			});
		});
	}
});
