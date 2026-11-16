//! # Tests de contrato de LECTURA Main (Rust) ↔ worker (TS) — CLI-05 / ARCH-01
//!
//! El harness hermano de `contract_tests.rs`. Aquel fija las **escrituras** (mismo comando → mismas
//! filas); éste fija las **lecturas** (mismas filas → mismo resultado devuelto).
//!
//! ## Por qué hace falta
//!
//! La misma consulta está escrita dos veces: en Rust (`crates/tpv-infra-sqlite`, que sirve a la Main
//! contra el SQLite local) y en TypeScript (`domains/*/*.queries.ts`, que sirve a la Handy contra
//! la base de la nube). Los **datos** convergen —de eso se encarga la replicación—, pero el SQL que
//! los lee no es el mismo código, así que las mismas filas pueden acabar presentadas distinto: un
//! JOIN de más, un filtro de borrados que sólo está en un lado, un `ORDER BY` distinto, un `NULL` que
//! uno normaliza y el otro no. El fallo que produce no es corrupción de datos: es que **el camarero mire la Handy
//! y la Main y vea cosas distintas**, y nadie sepa cuál creer.
//!
//! ## Qué se compara: el VALOR DEVUELTO, y en orden
//!
//! Ésta es la diferencia de fondo con el harness de escritura. Allí se comparan las filas de una
//! tabla **como multiconjunto**, porque el orden en el que SQLite las deje no es parte del contrato.
//! Aquí no: una lectura devuelve una **lista que se pinta en la pantalla en ese orden**, así que dos
//! implementaciones que devuelvan lo mismo desordenado **no** son equivalentes. La comparación es
//! por secuencia, posición a posición.
//!
//! El punto exacto donde se comparan es el **DTO**, y no es una elección arbitraria: en modo Handy,
//! `tpv-infra-http` deserializa la respuesta JSON del worker **dentro del mismo struct** que aquí
//! devuelve el repositorio SQLite (`HttpClientesRepository::overview` → `Vec<ClienteOverview>`). O
//! sea que el contrato ya es exactamente ese, y el harness sólo lo pincha.
//!
//! ## Reglas de los casos
//!
//! - **Los IDs sí entran en el golden.** Al revés que en las escrituras: aquí no los genera nadie,
//!   los fija el `seed`. Lo que se lee es lo que se sembró.
//! - **Las fechas del seed son extremas a propósito** (`2000-…` para el pasado, `2099-…` para el
//!   futuro). Varias consultas comparan contra `date('now','localtime')` —reservas pendientes,
//!   tareas de hoy— y un seed con fechas cercanas convertiría el golden en algo que caduca. Con los
//!   extremos, el lado de la comparación en el que cae cada fila es el mismo hoy y dentro de setenta
//!   años.
//! - **Un `null` y un campo ausente son lo mismo.** Es lo que hace serde al deserializar la
//!   respuesta del worker en el DTO (`Option<T>` acepta las dos formas), así que exigir que
//!   coincidan sería inventarse un requisito que el sistema real no tiene.
//!
//! El golden lo **bendice Rust** (lado canónico: es el escritor único y el que define el DTO); el
//! worker se conforma. Regenerar: `BLESS_CONTRACT_READ=1 cargo nextest run -p tpv-infra-sqlite contract_read_tests`.

//!
//! **Los tests se llaman `dominio__caso`**, con doble guion bajo, para separar de un vistazo el
//! dominio del supuesto — y ese nombre es ademas la clave del JSON en `tests/contract/casos/`. Como
//! `non_snake_case` considera que dos guiones bajos seguidos no son snake case, se silencia abajo:
//! es la convencion del harness, no un descuido, y renombrarlos rompe esa correspondencia.
#![allow(non_snake_case)]

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{Map, Value as Json};

use tpv_application::ports::cierre_caja::CierreCajaRepository;
use tpv_application::ports::clientes::ClientesRepository;
use tpv_application::ports::configuracion::ConfiguracionRepository;
use tpv_application::ports::cuentas::{CuentasFiltro, CuentasRepository};
use tpv_application::ports::inventario::InventarioRepository;
use tpv_application::ports::login::LoginRepository;
use tpv_application::ports::mesas::MesasRepository;
use tpv_application::ports::notificaciones::NotificacionesRepository;
use tpv_application::ports::proveedores::ProveedoresRepository;
use tpv_application::ports::reservas::ReservasRepository;
use tpv_application::ports::stats::StatsRepository;
use tpv_application::ports::tareas::TareasRepository;
use tpv_application::ports::trabajadores::TrabajadoresRepository;
use tpv_application::ports::venta_rapida::VentaRapidaRepository;
use tpv_contracts::stats::{
    ClientesStatsArgs, ProductosStatsArgs, ProveedoresStatsArgs, ReservasStatsArgs, StatsRange,
    StatsTurno, TrabajadoresStatsArgs,
};
use tpv_domain::clientes::ClienteRanking;

use crate::cierre_caja::SqliteCierreCajaRepository;
use crate::clientes::SqliteClientesRepository;
use crate::configuracion::SqliteConfiguracionRepository;
use crate::contract_comun::{cell_eq, contract_dir, db_temporal, sembrar};
use crate::cuentas::SqliteCuentasRepository;
use crate::db::Db;
use crate::inventario::SqliteInventarioRepository;
use crate::login::SqliteLoginRepository;
use crate::mesas::SqliteMesasRepository;
use crate::notificaciones::SqliteNotificacionesRepository;
use crate::proveedores::SqliteProveedoresRepository;
use crate::reservas::SqliteReservasRepository;
use crate::stats::SqliteStatsRepository;
use crate::tareas::SqliteTareasRepository;
use crate::trabajadores::SqliteTrabajadoresRepository;
use crate::venta_rapida::SqliteVentaRapidaRepository;

/// Ruta del fichero (`casos` o `golden`) de una lectura. Mismo esquema que el harness de escritura
/// pero bajo `lecturas/`, para que un vistazo al árbol diga cuál es cuál.
fn ruta_caso(base: &str, nombre: &str) -> PathBuf {
    let (modulo, caso) = nombre.split_once("__").unwrap_or(("otros", nombre));
    contract_dir()
        .join("lecturas")
        .join(base)
        .join(modulo)
        .join(format!("{caso}.json"))
}

// ── Comparación estructural ORDENADA (misma spec que el lado worker) ─────────────────

/// Quita del objeto las claves cuyo valor es `null`, para que "ausente" y "null" comparen igual.
///
/// No es laxitud: es lo que de verdad ocurre en producción. La respuesta del worker se deserializa
/// en el DTO, y un `Option<T>` acepta tanto que la clave falte como que valga `null`. Exigir que
/// coincidan marcaría como divergencia algo que el sistema real no distingue.
fn sin_nulos(o: &Map<String, Json>) -> Map<String, Json> {
    o.iter()
        .filter(|(_, v)| !v.is_null())
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

/// Igualdad estructural de dos valores devueltos. Los arrays comparan **en orden**.
fn valor_eq(a: &Json, b: &Json) -> Result<(), String> {
    match (a, b) {
        (Json::Array(xs), Json::Array(ys)) => {
            if xs.len() != ys.len() {
                return Err(format!("{} elementos frente a {} esperados", xs.len(), ys.len()));
            }
            for (i, (x, y)) in xs.iter().zip(ys).enumerate() {
                valor_eq(x, y).map_err(|e| format!("[{i}] {e}"))?;
            }
            Ok(())
        }
        (Json::Object(x), Json::Object(y)) => {
            let (x, y) = (sin_nulos(x), sin_nulos(y));
            let (mut kx, mut ky): (Vec<_>, Vec<_>) = (x.keys().collect(), y.keys().collect());
            kx.sort();
            ky.sort();
            if kx != ky {
                return Err(format!("campos {kx:?} frente a {ky:?}"));
            }
            for (k, vx) in &x {
                valor_eq(vx, y.get(k).unwrap()).map_err(|e| format!(".{k} {e}"))?;
            }
            Ok(())
        }
        _ => {
            if cell_eq(a, b) {
                Ok(())
            } else {
                Err(format!("{a} frente a {b}"))
            }
        }
    }
}

/// Borra, a cualquier profundidad, los campos que el caso declara en `omitir`.
///
/// Es el equivalente de lectura a los SELECT del harness de escritura, que dejan fuera las columnas
/// no deterministas. Algunas consultas devuelven **dentro del resultado** algo que depende del
/// reloj —`punch_status` echa la fecha de hoy en el propio objeto—, y ahí no hay seed que valga: el
/// golden caducaría a medianoche. Se omite ese campo y se contrasta todo lo demás, que es lo que de
/// verdad puede divergir entre las dos implementaciones.
fn omitir_campos(v: &mut Json, campos: &[String]) {
    match v {
        Json::Object(o) => {
            for c in campos {
                o.remove(c);
            }
            for (_, val) in o.iter_mut() {
                omitir_campos(val, campos);
            }
        }
        Json::Array(a) => {
            for val in a.iter_mut() {
                omitir_campos(val, campos);
            }
        }
        _ => {}
    }
}

/// Compara el resultado obtenido contra el golden del caso, o lo bendice si `BLESS_CONTRACT_READ`.
fn comparar_o_bendecir(nombre: &str, obtenido: &Json) {
    let golden_path = ruta_caso("golden", nombre);

    if std::env::var("BLESS_CONTRACT_READ").is_ok() || !golden_path.exists() {
        std::fs::create_dir_all(golden_path.parent().unwrap()).unwrap();
        let pretty = serde_json::to_string_pretty(obtenido).unwrap();
        std::fs::write(&golden_path, pretty + "\n").unwrap();
        eprintln!("[contract-read] golden bendecido: {}", golden_path.display());
        return;
    }

    let golden: Json =
        serde_json::from_str(&std::fs::read_to_string(&golden_path).unwrap()).unwrap();

    valor_eq(obtenido, &golden)
        .unwrap_or_else(|e| panic!("contrato de lectura roto en {nombre}\n{e}"));
}

fn leer_caso(nombre: &str) -> Json {
    let path = ruta_caso("casos", nombre);
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap())
        .unwrap_or_else(|e| panic!("caso ilegible {}: {e}", path.display()))
}

fn s(v: &Json) -> String {
    v.as_str().unwrap().to_string()
}

fn opt_str(v: &Json) -> Option<String> {
    v.as_str().map(|s| s.to_string())
}

/// El rango de una estadística (`entrada.range`); sin él, hoy.
fn rango(e: &Json) -> StatsRange {
    match e.get("range") {
        Some(r) if !r.is_null() => serde_json::from_value(r.clone()).expect("rango de estadística"),
        _ => StatsRange::Hoy,
    }
}

/// `entrada` → filtro de los listados de caja (rango + búsqueda + paginación por clave). El
/// cursor se lee como lo mandaría el cliente (`cursor_fecha` + `cursor_id`), por el mismo
/// `CuentasRangoArgs::cursor` que usa el comando.
fn filtro_cuentas(e: &Json) -> CuentasFiltro {
    let args = tpv_contracts::cuentas::CuentasRangoArgs {
        del: opt_str(&e["del"]),
        al: opt_str(&e["al"]),
        q: opt_str(&e["q"]),
        page_size: e["page_size"].as_u64().map(|n| n as u32),
        cursor_fecha: opt_str(&e["cursor_fecha"]),
        cursor_id: opt_str(&e["cursor_id"]),
    };
    CuentasFiltro {
        cursor: args.cursor(),
        del: args.del,
        al: args.al,
        q: args.q,
        page_size: args.page_size,
    }
}

/// Genera **un `#[tokio::test]` por lectura**, igual que en el harness de escritura y por el mismo
/// motivo (una BD por test, que pasa o falla por su cuenta).
///
/// Añadir una lectura: crear su fixture en `tests/contract/lecturas/casos/<modulo>/`, sumar su
/// nombre aquí y en el test del worker (`test/contractLectura.test.ts`), y bendecir su golden.
macro_rules! lecturas_de_contrato {
    ($($caso:ident),* $(,)?) => {
        $(
            #[tokio::test]
            async fn $caso() {
                correr_lectura(stringify!($caso)).await;
            }
        )*
    };
}

lecturas_de_contrato! {
    clientes__overview_reciente,
    clientes__overview_por_reservas,
    clientes__overview_por_gasto,
    clientes__form,
    cuentas__entradas,
    cuentas__entradas_busqueda_paginada,
    cuentas__entradas_primera_pagina,
    cuentas__entradas_mesa_con_nombre,
    cuentas__entradas_busqueda_comodines,
    cuentas__entradas_busqueda_texto_largo,
    cuentas__entradas_busqueda_sin_acentos,
    cuentas__salidas,
    cuentas__salidas_busqueda_comodines,
    cuentas__salidas_busqueda_sin_acentos,
    cuentas__resumen,
    cuentas__resumen_busqueda_comodines,
    cuentas__resumen_busqueda_sin_acentos,
    cuentas__cierre_ultimo,
    cuentas__cierre_listar,
    cuentas__cierre_detalle,
    inventario__productos_por_categoria,
    inventario__resumen,
    mesas__lineas_comanda,
    mesas__layout,
    mesas__meta_all,
    mesas__comanda_abierta_by_mesa,
    mesas__categorias,
    mesas__productos_por_categoria,
    mesas__buscar_productos,
    mesas__buscar_productos_comodines,
    mesas__buscar_productos_texto_largo,
    mesas__buscar_productos_sin_acentos,
    mesas__cocina_pendiente,
    venta_rapida__comandas_barra,
    venta_rapida__lineas_comanda,
    venta_rapida__categorias,
    venta_rapida__productos_por_categoria,
    venta_rapida__buscar_productos,
    venta_rapida__buscar_productos_comodines,
    venta_rapida__buscar_productos_texto_largo,
    venta_rapida__buscar_productos_sin_acentos,
    venta_rapida__detalles_ver_ticket,
    venta_rapida__index_rows,
    venta_rapida__index_rows_120_tickets,
    tareas__admin,
    tareas__mias,
    tareas__trabajadores,
    tareas__papelera,
    tareas__por_id,
    tareas__asignados,
    trabajadores__asignaciones_semana,
    trabajadores__asignaciones_semana_con_predeterminado,
    trabajadores__roles,
    trabajadores__permisos_usuario,
    trabajadores__todos,
    trabajadores__detalle,
    trabajadores__id_por_usuario,
    trabajadores__turnos,
    configuracion__business,
    configuracion__ticket,
    configuracion__contact,
    inventario__categorias,
    inventario__proveedores_mini,
    inventario__alergenos,
    inventario__lotes_por_producto,
    inventario__product_detail,
    inventario__catalogo_ingredientes,
    inventario__ingredientes_de_producto,
    login__usuarios,
    login__punch_status,
    notificaciones__listar,
    notificaciones__contar_no_leidas,
    notificaciones__papelera,
    proveedores__todos,
    proveedores__categorias,
    proveedores__productos,
    proveedores__productos_todos,
    reservas__meta,
    reservas__mes,
    reservas__una,
    reservas__buscar_cliente,
    reservas__buscar_cliente_por_telefono,
    stats__categorias,
    stats__mesas,
    stats__mesas_semana,
    stats__productos,
    stats__productos_semana,
    stats__productos_vendidos,
    stats__productos_vendidos_por_categoria,
    stats__productos_nombre_que_es_un_id,
    stats__reservas,
    stats__trabajadores,
    stats__clientes,
    stats__proveedores,
    stats__proveedores_gasto_medio,
}

/// Corre la lectura del caso por su camino real (el repositorio SQLite que usa la Main) y devuelve
/// su resultado serializado. El `match` es el punto de extensión: una lectura nueva añade su brazo
/// aquí y en el lado worker (`ejecutarLectura`).
async fn ejecutar_lectura(db: &Arc<Db>, caso: &Json) -> Json {
    let e = &caso["entrada"];
    match caso["lectura"].as_str().unwrap() {
        "clientes.overview" => {
            let repo = SqliteClientesRepository::new(db.clone());
            let r = repo
                .overview(ClienteRanking::from_arg(&s(&e["ranking"])))
                .await
                .expect("overview");
            serde_json::to_value(r).unwrap()
        }
        "clientes.form" => {
            let repo = SqliteClientesRepository::new(db.clone());
            let r = repo.form(&s(&e["id_cliente"])).await.expect("form");
            serde_json::to_value(r).unwrap()
        }
        "cuentas.entradas" => {
            let repo = SqliteCuentasRepository::new(db.clone());
            let r = repo.entradas(filtro_cuentas(e)).await.expect("entradas");
            serde_json::to_value(r).unwrap()
        }
        "cuentas.salidas" => {
            let repo = SqliteCuentasRepository::new(db.clone());
            let r = repo.salidas(filtro_cuentas(e)).await.expect("salidas");
            serde_json::to_value(r).unwrap()
        }
        "cuentas.resumen" => {
            let repo = SqliteCuentasRepository::new(db.clone());
            let r = repo
                .resumen(opt_str(&e["del"]), opt_str(&e["al"]), opt_str(&e["q"]))
                .await
                .expect("resumen");
            serde_json::to_value(r).unwrap()
        }
        "inventario.productos_por_categoria" => {
            let repo = SqliteInventarioRepository::new(db.clone());
            let r = repo
                .list_productos_by_categoria(&s(&e["id_categoria"]))
                .await
                .expect("productos por categoria");
            serde_json::to_value(r).unwrap()
        }
        "inventario.resumen" => {
            let repo = SqliteInventarioRepository::new(db.clone());
            let r = repo
                .resumen(e["limit"].as_i64().unwrap_or(10))
                .await
                .expect("resumen inventario");
            serde_json::to_value(r).unwrap()
        }
        "mesas.lineas_comanda" => {
            let repo = SqliteMesasRepository::new(db.clone());
            let r = repo
                .get_lineas_comanda(&s(&e["id_comanda"]))
                .await
                .expect("lineas comanda mesa");
            serde_json::to_value(r).unwrap()
        }
        "mesas.layout" => {
            let repo = SqliteMesasRepository::new(db.clone());
            let r = repo.load_layout().await.expect("layout");
            serde_json::to_value(r).unwrap()
        }
        "mesas.meta_all" => {
            let repo = SqliteMesasRepository::new(db.clone());
            let r = repo.mesas_meta_all().await.expect("meta all");
            serde_json::to_value(r).unwrap()
        }
        "mesas.comanda_abierta_by_mesa" => {
            let repo = SqliteMesasRepository::new(db.clone());
            let r = repo
                .get_comanda_abierta_by_mesa(&s(&e["id_mesa"]))
                .await
                .expect("comanda abierta by mesa");
            serde_json::to_value(r).unwrap()
        }
        "mesas.categorias" => {
            let repo = SqliteMesasRepository::new(db.clone());
            let r = repo
                .list_categorias_vendibles()
                .await
                .expect("categorias vendibles mesas");
            serde_json::to_value(r).unwrap()
        }
        "mesas.productos_por_categoria" => {
            let repo = SqliteMesasRepository::new(db.clone());
            let r = MesasRepository::list_productos_by_categoria(&repo, &s(&e["id_categoria"]))
                .await
                .expect("productos por categoria mesas");
            serde_json::to_value(r).unwrap()
        }
        "mesas.buscar_productos" => {
            let repo = SqliteMesasRepository::new(db.clone());
            let r = repo
                .search_productos_by_nombre(s(&e["query"]))
                .await
                .expect("buscar productos mesas");
            serde_json::to_value(r).unwrap()
        }
        "mesas.cocina_pendiente" => {
            let repo = SqliteMesasRepository::new(db.clone());
            let r = repo
                .kitchen_list_today_pending()
                .await
                .expect("cocina pendiente");
            serde_json::to_value(r).unwrap()
        }
        "venta_rapida.categorias" => {
            let repo = SqliteVentaRapidaRepository::new(db.clone());
            let r = VentaRapidaRepository::list_categorias_vendibles(&repo)
                .await
                .expect("categorias vendibles vr");
            serde_json::to_value(r).unwrap()
        }
        "venta_rapida.productos_por_categoria" => {
            let repo = SqliteVentaRapidaRepository::new(db.clone());
            let r = VentaRapidaRepository::list_productos_by_categoria(&repo, &s(&e["id_categoria"]))
                .await
                .expect("productos por categoria vr");
            serde_json::to_value(r).unwrap()
        }
        "venta_rapida.buscar_productos" => {
            let repo = SqliteVentaRapidaRepository::new(db.clone());
            let r = repo
                .search_productos(s(&e["query"]), e["limit"].as_i64().unwrap_or(200))
                .await
                .expect("buscar productos vr");
            serde_json::to_value(r).unwrap()
        }
        "venta_rapida.detalles_ver_ticket" => {
            let repo = SqliteVentaRapidaRepository::new(db.clone());
            let r = repo
                .get_detalles_ver_ticket(&s(&e["id_comanda"]))
                .await
                .expect("detalles ver ticket");
            serde_json::to_value(r).unwrap()
        }
        "venta_rapida.comandas_barra" => {
            let repo = SqliteVentaRapidaRepository::new(db.clone());
            let r = repo
                .list_comandas_barra(
                    e["include_pagadas"].as_bool().unwrap_or(false),
                    e["limit"].as_i64(),
                )
                .await
                .expect("comandas barra");
            serde_json::to_value(r).unwrap()
        }
        "venta_rapida.lineas_comanda" => {
            let repo = SqliteVentaRapidaRepository::new(db.clone());
            let r = repo
                .get_lineas_comanda(&s(&e["id_comanda"]))
                .await
                .expect("lineas comanda barra");
            serde_json::to_value(r).unwrap()
        }
        "venta_rapida.index_rows" => {
            let repo = SqliteVentaRapidaRepository::new(db.clone());
            let ids = e["ids"].as_array().expect("ids").iter().map(s).collect();
            let r = repo.get_index_rows(ids).await.expect("index rows");
            serde_json::to_value(r).unwrap()
        }
        "tareas.admin" => {
            let repo = SqliteTareasRepository::new(db.clone());
            let r = repo.get_tareas_admin().await.expect("tareas admin");
            serde_json::to_value(r).unwrap()
        }
        "tareas.mias" => {
            let repo = SqliteTareasRepository::new(db.clone());
            let r = repo
                .get_mis_tareas(&s(&e["id_trabajador"]))
                .await
                .expect("mis tareas");
            serde_json::to_value(r).unwrap()
        }
        "trabajadores.asignaciones_semana" => {
            let repo = SqliteTrabajadoresRepository::new(db.clone());
            let r = repo
                .get_asignaciones_semana(s(&e["fecha_lunes"]))
                .await
                .expect("asignaciones semana");
            serde_json::to_value(r).unwrap()
        }
        "configuracion.business" => {
            let repo = SqliteConfiguracionRepository::new(db.clone());
            serde_json::to_value(repo.get_business().await.expect("business")).unwrap()
        }
        "configuracion.ticket" => {
            let repo = SqliteConfiguracionRepository::new(db.clone());
            serde_json::to_value(repo.get_ticket().await.expect("ticket")).unwrap()
        }
        "configuracion.contact" => {
            let repo = SqliteConfiguracionRepository::new(db.clone());
            serde_json::to_value(repo.get_contact().await.expect("contact")).unwrap()
        }
        "cuentas.cierre_ultimo" => {
            let repo = SqliteCierreCajaRepository::new(db.clone());
            serde_json::to_value(repo.ultimo_cierre().await.expect("ultimo cierre")).unwrap()
        }
        "cuentas.cierre_listar" => {
            let repo = SqliteCierreCajaRepository::new(db.clone());
            let r = repo
                .listar(e["limite"].as_i64().unwrap_or(50))
                .await
                .expect("listar cierres");
            serde_json::to_value(r).unwrap()
        }
        "cuentas.cierre_detalle" => {
            let repo = SqliteCierreCajaRepository::new(db.clone());
            let r = repo
                .detalle(&s(&e["id_cierre"]))
                .await
                .expect("detalle cierre");
            serde_json::to_value(r).unwrap()
        }
        "inventario.categorias" => {
            let repo = SqliteInventarioRepository::new(db.clone());
            serde_json::to_value(repo.list_categorias().await.expect("categorias inv")).unwrap()
        }
        "inventario.proveedores_mini" => {
            let repo = SqliteInventarioRepository::new(db.clone());
            serde_json::to_value(repo.list_proveedores_mini().await.expect("prov mini")).unwrap()
        }
        "inventario.alergenos" => {
            let repo = SqliteInventarioRepository::new(db.clone());
            serde_json::to_value(repo.list_alergenos().await.expect("alergenos")).unwrap()
        }
        "inventario.lotes_por_producto" => {
            let repo = SqliteInventarioRepository::new(db.clone());
            let r = repo
                .list_lotes_by_producto(&s(&e["id_producto"]))
                .await
                .expect("lotes por producto");
            serde_json::to_value(r).unwrap()
        }
        "inventario.catalogo_ingredientes" => {
            let repo = SqliteInventarioRepository::new(db.clone());
            serde_json::to_value(repo.catalogo_ingredientes().await.expect("catalogo de ingredientes")).unwrap()
        }
        "inventario.ingredientes_de_producto" => {
            let repo = SqliteInventarioRepository::new(db.clone());
            let r = repo
                .ingredientes_de_producto(&s(&e["id_producto"]))
                .await
                .expect("ingredientes de producto");
            serde_json::to_value(r).unwrap()
        }
        "inventario.product_detail" => {
            let repo = SqliteInventarioRepository::new(db.clone());
            let r = repo
                .product_detail(&s(&e["id_producto"]))
                .await
                .expect("product detail");
            serde_json::to_value(r).unwrap()
        }
        "login.usuarios" => {
            let repo = SqliteLoginRepository::new(db.clone());
            serde_json::to_value(repo.list_login_users().await.expect("login users")).unwrap()
        }
        "login.punch_status" => {
            let repo = SqliteLoginRepository::new(db.clone());
            let r = repo
                .get_today_punch_status(&s(&e["id_usuario"]))
                .await
                .expect("punch status");
            serde_json::to_value(r).unwrap()
        }
        "notificaciones.listar" => {
            let repo = SqliteNotificacionesRepository::new(db.clone());
            let r = repo
                .listar(&s(&e["id_usuario"]), e["solo_no_leidas"].as_bool().unwrap_or(false))
                .await
                .expect("listar notificaciones");
            serde_json::to_value(r).unwrap()
        }
        "notificaciones.contar_no_leidas" => {
            let repo = SqliteNotificacionesRepository::new(db.clone());
            let r = repo
                .contar_no_leidas(&s(&e["id_usuario"]))
                .await
                .expect("contar no leidas");
            serde_json::to_value(r).unwrap()
        }
        "notificaciones.papelera" => {
            let repo = SqliteNotificacionesRepository::new(db.clone());
            let r = repo
                .listar_descartadas(&s(&e["id_usuario"]))
                .await
                .expect("papelera notificaciones");
            serde_json::to_value(r).unwrap()
        }
        "proveedores.todos" => {
            let repo = SqliteProveedoresRepository::new(db.clone());
            serde_json::to_value(repo.get_all().await.expect("proveedores")).unwrap()
        }
        "proveedores.categorias" => {
            let repo = SqliteProveedoresRepository::new(db.clone());
            serde_json::to_value(repo.get_categorias().await.expect("categorias prov")).unwrap()
        }
        "proveedores.productos" => {
            let repo = SqliteProveedoresRepository::new(db.clone());
            let r = repo
                .get_productos(&s(&e["id_proveedor"]))
                .await
                .expect("productos proveedor");
            serde_json::to_value(r).unwrap()
        }
        "proveedores.productos_todos" => {
            let repo = SqliteProveedoresRepository::new(db.clone());
            serde_json::to_value(repo.get_productos_all().await.expect("productos all")).unwrap()
        }
        "reservas.meta" => {
            let repo = SqliteReservasRepository::new(db.clone());
            serde_json::to_value(repo.meta().await.expect("reservas meta")).unwrap()
        }
        "reservas.mes" => {
            let repo = SqliteReservasRepository::new(db.clone());
            let r = repo
                .mes(&s(&e["desde"]), &s(&e["hasta"]))
                .await
                .expect("reservas mes");
            serde_json::to_value(r).unwrap()
        }
        "reservas.una" => {
            let repo = SqliteReservasRepository::new(db.clone());
            serde_json::to_value(repo.reserva(&s(&e["id_reserva"])).await.expect("reservas una")).unwrap()
        }
        "reservas.buscar_cliente" => {
            let repo = SqliteReservasRepository::new(db.clone());
            let r = repo
                .buscar_cliente(opt_str(&e["telefono"]).as_deref(), opt_str(&e["email"]).as_deref())
                .await
                .expect("buscar cliente");
            serde_json::to_value(r).unwrap()
        }
        "tareas.trabajadores" => {
            let repo = SqliteTareasRepository::new(db.clone());
            serde_json::to_value(repo.get_trabajadores().await.expect("trab tareas")).unwrap()
        }
        "tareas.papelera" => {
            let repo = SqliteTareasRepository::new(db.clone());
            serde_json::to_value(repo.get_papelera().await.expect("papelera tareas")).unwrap()
        }
        "tareas.por_id" => {
            let repo = SqliteTareasRepository::new(db.clone());
            let r = repo.get_tarea_by_id(&s(&e["id_tarea"])).await.expect("tarea by id");
            serde_json::to_value(r).unwrap()
        }
        "tareas.asignados" => {
            let repo = SqliteTareasRepository::new(db.clone());
            let r = repo
                .get_tarea_asignados(&s(&e["id_tarea"]))
                .await
                .expect("asignados tarea");
            serde_json::to_value(r).unwrap()
        }
        "trabajadores.permisos_usuario" => {
            use tpv_application::ports::permisos::PermisosRepository;
            let repo = crate::permisos::SqlitePermisosRepository::new(db.clone());
            serde_json::to_value(repo.usuario(&s(&e["id_usuario"])).await.expect("permisos")).unwrap()
        }
        "trabajadores.roles" => {
            let repo = SqliteTrabajadoresRepository::new(db.clone());
            serde_json::to_value(repo.get_roles().await.expect("roles")).unwrap()
        }
        "trabajadores.todos" => {
            let repo = SqliteTrabajadoresRepository::new(db.clone());
            serde_json::to_value(repo.get_all().await.expect("trabajadores")).unwrap()
        }
        "trabajadores.detalle" => {
            let repo = SqliteTrabajadoresRepository::new(db.clone());
            let r = repo.get_detail(&s(&e["id_trabajador"])).await.expect("detalle trab");
            serde_json::to_value(r).unwrap()
        }
        "trabajadores.id_por_usuario" => {
            let repo = SqliteTrabajadoresRepository::new(db.clone());
            let r = repo
                .get_id_by_usuario(&s(&e["id_usuario"]))
                .await
                .expect("id por usuario");
            serde_json::to_value(r).unwrap()
        }
        "trabajadores.turnos" => {
            let repo = SqliteTrabajadoresRepository::new(db.clone());
            serde_json::to_value(repo.turnos_get_all().await.expect("turnos")).unwrap()
        }
        "stats.categorias" => {
            let repo = SqliteStatsRepository::new(db.clone());
            serde_json::to_value(repo.list_categorias().await.expect("stats categorias")).unwrap()
        }
        "stats.mesas" => {
            let repo = SqliteStatsRepository::new(db.clone());
            serde_json::to_value(repo.mesas(rango(e)).await.expect("stats mesas")).unwrap()
        }
        "stats.productos" => {
            let repo = SqliteStatsRepository::new(db.clone());
            let r = repo
                .productos(ProductosStatsArgs {
                    range: rango(e),
                    categoria_top_id: opt_str(&e["categoria_top_id"]),
                    categoria_worst_id: opt_str(&e["categoria_worst_id"]),
                })
                .await
                .expect("stats productos");
            serde_json::to_value(r).unwrap()
        }
        "stats.reservas" => {
            let repo = SqliteStatsRepository::new(db.clone());
            let r = repo
                .reservas(ReservasStatsArgs {
                    range: StatsRange::Hoy,
                    turno: StatsTurno::Todos,
                })
                .await
                .expect("stats reservas");
            serde_json::to_value(r).unwrap()
        }
        "stats.trabajadores" => {
            let repo = SqliteStatsRepository::new(db.clone());
            let r = repo
                .trabajadores(TrabajadoresStatsArgs { range: StatsRange::Hoy })
                .await
                .expect("stats trabajadores");
            serde_json::to_value(r).unwrap()
        }
        "stats.clientes" => {
            let repo = SqliteStatsRepository::new(db.clone());
            let r = repo
                .clientes(ClientesStatsArgs { range: StatsRange::Hoy })
                .await
                .expect("stats clientes");
            serde_json::to_value(r).unwrap()
        }
        "stats.proveedores" => {
            let repo = SqliteStatsRepository::new(db.clone());
            let r = repo
                .proveedores(ProveedoresStatsArgs { range: StatsRange::Hoy })
                .await
                .expect("stats proveedores");
            serde_json::to_value(r).unwrap()
        }
        otro => panic!("lectura sin soporte en el harness de contrato: {otro}"),
    }
}

/// Corre un caso: BD nueva, siembra, ejecuta la lectura y compara/bendice su golden.
async fn correr_lectura(nombre: &str) {
    let caso = leer_caso(nombre);
    let (db, _dir) = db_temporal().await;
    sembrar(&db, caso["seed"].as_array().unwrap()).await;
    let mut obtenido = ejecutar_lectura(&db, &caso).await;
    if let Some(campos) = caso.get("omitir").and_then(|v| v.as_array()) {
        let campos: Vec<String> = campos.iter().filter_map(|c| c.as_str().map(String::from)).collect();
        omitir_campos(&mut obtenido, &campos);
    }
    comparar_o_bendecir(nombre, &obtenido);
}
