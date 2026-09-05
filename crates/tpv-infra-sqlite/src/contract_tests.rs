//! # Tests de contrato Main (Rust) ↔ worker (TS) — ARCH-01
//!
//! La lógica de convertir un comando de negocio en sentencias SQL vive **dos veces** (Rust en la
//! Main, TypeScript en el worker) y tiene que comportarse **igual** para que la replicación converja.
//! Se igualan a mano y ya han divergido (MESA-04/MESA-07). Este harness pincha esa igualdad.
//!
//! **Qué se compara: el EFECTO, no el texto SQL.** Los dos lados escribieron su SQL por separado, así
//! que el texto difiere aunque el resultado sea idéntico; comparar el texto daría falsos positivos.
//! Lo que importa para la convergencia es que, partiendo del **mismo estado sembrado**, aplicar el
//! comando deje **las mismas filas**. Así que el "golden" es el estado resultante (las filas de las
//! tablas que toca el comando), y cada lado corre su propia implementación y compara contra él.
//!
//! **Contrato compartido** (mismo en los dos lados, documentado en `tests/contract/README.md`):
//! - Un **caso** (`tests/contract/casos/<nombre>.json`) trae: `seed` (SQL de siembra), `entrada` (el
//!   input del comando) y `snapshot` (un SELECT por tabla a inspeccionar). Los SELECT **omiten a
//!   propósito** las columnas no deterministas (UUIDs generados, `Fecha_Hora`): lo que queda es el
//!   efecto determinista (importes, stock por lote, consumos, qué detalles se cobraron).
//! - El **golden** (`tests/contract/golden/<nombre>.json`) es `{ tabla: [filas] }`.
//! - La comparación es por **multiconjunto** de filas (sin orden) con igualdad estructural (números
//!   como números, con tolerancia). El golden lo **bendice Rust** (lado canónico: escritor único);
//!   el worker se conforma. Regenerar: `BLESS_CONTRACT=1 cargo test -p tpv-infra-sqlite contrato_`.
#![cfg(test)]

use std::path::PathBuf;
use std::sync::Arc;

use libsql::Value;
use serde_json::{Map, Value as Json};

use tpv_application::ports::clientes::ClientesRepository;
use tpv_application::ports::configuracion::ConfiguracionRepository;
use tpv_application::ports::cuentas::CuentasRepository;
use tpv_application::ports::inventario::InventarioRepository;
use tpv_application::ports::login::LoginRepository;
use tpv_application::ports::mesas::MesasRepository;
use tpv_application::ports::notificaciones::{NotificacionesRepository, Notifier};
use tpv_application::ports::proveedores::ProveedoresRepository;
use tpv_application::ports::reservas::ReservasRepository;
use tpv_application::ports::tareas::TareasRepository;
use tpv_application::ports::trabajadores::TrabajadoresRepository;
use tpv_application::ports::venta_rapida::VentaRapidaRepository;
use tpv_contracts::mesas::SalonInput;
use tpv_contracts::venta_rapida::StockLinea;
use tpv_domain::clientes::{Cliente, NuevoCliente};
use tpv_domain::cuentas::{normalize_metodo, GastoData, PagoData};
use tpv_domain::inventario::{AjusteLote, CategoriaUpsert, LoteNuevo, LoteUpdate, ProductoUpsert};
use tpv_domain::mesas::{AbrirComandaData, CobroDetalles};
use tpv_domain::notificaciones::NuevaNotificacion;
use tpv_domain::proveedores::{ProductoNuevo, ProveedorValidado};
use tpv_domain::reservas::{ClienteReserva, ReservaValidada};
use tpv_domain::tareas::TareaData;
use tpv_domain::trabajadores::{AsignacionCambios, AsignacionNueva};
use tpv_domain::venta_rapida::CobroFraccionado;

use crate::clientes::SqliteClientesRepository;
use crate::configuracion::SqliteConfiguracionRepository;
use crate::contract_comun::{cell_eq, cell_to_json, contract_dir, db_temporal, sembrar};
use crate::cuentas::SqliteCuentasRepository;
use crate::db::{Db, Reader};
use crate::inventario::SqliteInventarioRepository;
use crate::login::SqliteLoginRepository;
use crate::mesas::SqliteMesasRepository;
use crate::notificaciones::SqliteNotificacionesRepository;
use crate::proveedores::SqliteProveedoresRepository;
use crate::reservas::SqliteReservasRepository;
use crate::tareas::SqliteTareasRepository;
use crate::trabajadores::SqliteTrabajadoresRepository;
use crate::venta_rapida::SqliteVentaRapidaRepository;

/// Ruta del fichero (`casos` o `golden`) de un caso. Se organizan por módulo: el nombre lógico
/// `<modulo>__<caso>` vive en `<base>/<modulo>/<caso>.json`.
fn ruta_caso(base: &str, nombre: &str) -> PathBuf {
    let (modulo, caso) = nombre.split_once("__").unwrap_or(("otros", nombre));
    contract_dir().join(base).join(modulo).join(format!("{caso}.json"))
}

/// Nombres de columna del SELECT (entre `SELECT` y `FROM`). Los SELECT del harness son planos a
/// propósito (sin `*`, sin subconsultas), así que este parseo simple basta.
///
/// Tiene que dar **el mismo nombre que devolvería SQLite**, porque el lado worker no parsea nada:
/// lee las claves de la fila que le da libsql y las compara contra este golden. Por eso:
/// `X AS Y` → `Y` (manda el alias) y `M.Numero_Mesa` → `Numero_Mesa` (SQLite quita el prefijo de
/// tabla). Sin esto, un snapshot con JOIN —necesario cuando el ID de la fila lo genera cada lado
/// por su cuenta y hay que anclarse a otra columna— compararía claves distintas y saldría rojo por
/// un motivo que no es la divergencia que se busca.
fn columnas(select: &str) -> Vec<String> {
    let up = select.to_uppercase();
    let ini = up.find("SELECT ").expect("SELECT") + "SELECT ".len();
    let fin = up.find(" FROM ").expect("FROM");
    select[ini..fin]
        .split(',')
        .map(|c| {
            let c = c.trim();
            let up_c = c.to_uppercase();
            let base = match up_c.rfind(" AS ") {
                Some(i) => &c[i + " AS ".len()..],
                None => c,
            };
            let base = base.trim();
            match base.rsplit_once('.') {
                Some((_, col)) => col.to_string(),
                None => base.to_string(),
            }
        })
        .collect()
}

/// Corre un SELECT del snapshot y devuelve sus filas como objetos JSON `{columna: valor}`.
async fn snapshot_tabla(db: &Arc<Db>, select: &str) -> Vec<Json> {
    let cols = columnas(select);
    let r = db.read().await;
    let mut rows = r.query(select, Vec::<Value>::new()).await.unwrap();
    let mut out = Vec::new();
    while let Some(row) = rows.next().await.unwrap() {
        let mut obj = Map::new();
        for (i, col) in cols.iter().enumerate() {
            obj.insert(col.clone(), cell_to_json(row.get_value(i as i32).unwrap()));
        }
        out.push(Json::Object(obj));
    }
    out
}

/// Igualdad de dos filas (mismos campos, valores estructuralmente iguales).
fn row_eq(a: &Json, b: &Json) -> bool {
    let (Some(oa), Some(ob)) = (a.as_object(), b.as_object()) else {
        return false;
    };
    if oa.len() != ob.len() {
        return false;
    }
    oa.iter().all(|(k, va)| ob.get(k).is_some_and(|vb| cell_eq(va, vb)))
}

/// Compara dos tablas como multiconjuntos (sin depender del orden de las filas).
fn multiset_eq(got: &[Json], want: &[Json], tabla: &str) -> Result<(), String> {
    if got.len() != want.len() {
        return Err(format!(
            "{tabla}: {} filas frente a {} esperadas\n  obtenido: {}\n  golden:   {}",
            got.len(),
            want.len(),
            Json::Array(got.to_vec()),
            Json::Array(want.to_vec())
        ));
    }
    let mut restantes: Vec<&Json> = want.iter().collect();
    for fila in got {
        match restantes.iter().position(|w| row_eq(fila, w)) {
            Some(i) => {
                restantes.swap_remove(i);
            }
            None => {
                return Err(format!("{tabla}: fila sin equivalente en el golden: {fila}"));
            }
        }
    }
    Ok(())
}

/// Ejecuta el snapshot completo del caso contra la BD y devuelve `{ tabla: [filas] }`.
async fn estado_resultante(db: &Arc<Db>, snapshot: &Map<String, Json>) -> Json {
    let mut estado = Map::new();
    for (tabla, select) in snapshot {
        let sql = select.as_str().expect("cada snapshot es un SELECT");
        estado.insert(tabla.clone(), Json::Array(snapshot_tabla(db, sql).await));
    }
    Json::Object(estado)
}

/// Compara el estado obtenido contra el golden del caso, o lo bendice si `BLESS_CONTRACT` está.
fn comparar_o_bendecir(nombre: &str, estado: &Json) {
    let golden_path = ruta_caso("golden", nombre);

    if std::env::var("BLESS_CONTRACT").is_ok() || !golden_path.exists() {
        std::fs::create_dir_all(golden_path.parent().unwrap()).unwrap();
        let pretty = serde_json::to_string_pretty(estado).unwrap();
        std::fs::write(&golden_path, pretty + "\n").unwrap();
        eprintln!("[contract] golden bendecido: {}", golden_path.display());
        return;
    }

    let golden: Json =
        serde_json::from_str(&std::fs::read_to_string(&golden_path).unwrap()).unwrap();

    let (obj_got, obj_want) = (estado.as_object().unwrap(), golden.as_object().unwrap());
    assert_eq!(
        obj_got.keys().collect::<Vec<_>>(),
        obj_want.keys().collect::<Vec<_>>(),
        "las tablas del snapshot no coinciden con el golden"
    );
    for (tabla, got) in obj_got {
        let want = obj_want.get(tabla).unwrap();
        multiset_eq(
            got.as_array().unwrap(),
            want.as_array().unwrap(),
            tabla,
        )
        .unwrap_or_else(|e| panic!("contrato roto en {nombre}\n{e}"));
    }
}

fn leer_caso(nombre: &str) -> Json {
    let path = ruta_caso("casos", nombre);
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap())
        .unwrap_or_else(|e| panic!("caso ilegible {}: {e}", path.display()))
}

fn strings(v: &Json) -> Vec<String> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_str().unwrap().to_string())
        .collect()
}

/// Campo opcional del `entrada`: `null`/ausente → `None`, string → `Some`.
fn opt_str(v: &Json) -> Option<String> {
    v.as_str().map(|s| s.to_string())
}

/// `entrada` → `GastoData`: lo comparten el alta y la edición de gastos.
fn gasto_del_caso(e: &Json) -> GastoData {
    GastoData {
        fecha: s(&e["fecha"]),
        tipo_gasto: s(&e["tipo_gasto"]),
        concepto: s(&e["concepto"]),
        importe: e["importe"].as_f64().unwrap_or(0.0),
        proveedor_id: opt_str(&e["proveedor_id"]),
    }
}

fn s(v: &Json) -> String {
    v.as_str().unwrap().to_string()
}

/// Genera **un `#[tokio::test]` por caso** (en vez de un solo bucle). Abrir muchas BD libsql en un
/// mismo test dispara un crash nativo intermitente en Windows (`STATUS_ACCESS_VIOLATION`); un test
/// por caso —cada uno con su propia BD— es el patrón estable del resto de la suite. El identificador
/// del test **es** el nombre del caso (`<modulo>__<caso>`), que también es la ruta de su fixture.
///
/// Añadir un caso: crear su fixture en `tests/contract/casos/<modulo>/`, sumar su nombre aquí y en el
/// test del worker (`test/contract.test.ts`), y bendecir su golden.
/// Correr/bendecir: `cargo test -p tpv-infra-sqlite contract_tests` (con `BLESS_CONTRACT=1` regenera).
macro_rules! casos_de_contrato {
    ($($caso:ident),* $(,)?) => {
        $(
            #[tokio::test]
            async fn $caso() {
                correr_caso(stringify!($caso)).await;
            }
        )*
    };
}

casos_de_contrato! {
    venta_rapida__cobro_fraccionado_un_lote,
    venta_rapida__cobro_fraccionado_fefo_multilote,
    mesas__cobrar_detalles_un_lote,
    clientes__crear,
    clientes__actualizar,
    tareas__crear,
    tareas__actualizar,
    tareas__set_asignaciones,
    tareas__eliminar,
    tareas__restaurar,
    tareas__vaciar_papelera,
    tareas__marcar_finalizada,
    inventario__create_lote,
    inventario__create_categoria,
    inventario__upsert_producto,
    inventario__set_alergenos,
    inventario__delete_producto,
    inventario__update_lote,
    inventario__ajustar_lote,
    configuracion__patch_business,
    configuracion__patch_contact,
    configuracion__patch_ticket,
    proveedores__guardar,
    proveedores__eliminar,
    proveedores__set_vinculos,
    proveedores__crear_producto,
    reservas__guardar_cliente_nuevo,
    reservas__guardar_cliente_existente,
    reservas__guardar_sin_mesa,
    reservas__eliminar,
    venta_rapida__create_comanda_barra,
    venta_rapida__add_linea,
    venta_rapida__remove_last_unpaid_linea,
    venta_rapida__delete_linea_if_unpaid,
    venta_rapida__update_nota_detalle,
    venta_rapida__restar_stock,
    venta_rapida__delete_comanda_if_safe,
    mesas__save_layout,
    mesas__set_reserva_estado,
    mesas__abrir_comanda,
    mesas__set_trabajador_if_null,
    mesas__cerrar_comanda,
    mesas__add_linea,
    mesas__remove_one_pending_detalle,
    mesas__delete_detalle,
    mesas__update_detalle_nota,
    mesas__kitchen_set_line_state,
    cuentas__create_gasto,
    cuentas__update_gasto,
    cuentas__delete_gasto,
    cuentas__update_pago,
    cuentas__anular_pago,
    notificaciones__crear,
    notificaciones__crear_dedupe,
    notificaciones__marcar_leida,
    notificaciones__marcar_leidas_batch,
    notificaciones__resolver_por_clave,
    notificaciones__descartar,
    notificaciones__restaurar,
    notificaciones__eliminar,
    login__set_turno_partido,
    login__punch_entrada,
    login__punch_salida,
    horarios__copiar_semana,
    horarios__create_asignacion,
    horarios__update_asignacion,
    horarios__delete_asignacion,
}

/// Corre el comando del caso por su camino real (el que captura el efecto en la BD). El `match` es
/// el punto de extensión: un dominio nuevo añade su brazo aquí y en el lado worker.
async fn aplicar_comando(db: &Arc<Db>, caso: &Json) {
    let e = &caso["entrada"];
    match caso["comando"].as_str().unwrap() {
        "venta_rapida.cobrar_fraccionado" => {
            let repo = SqliteVentaRapidaRepository::new(db.clone());
            repo.cobrar_fraccionado(CobroFraccionado {
                id_comanda: e["id_comanda"].as_str().unwrap().to_string(),
                metodo: e["metodo"].as_str().unwrap().to_string(),
                // El importe lo recalcula el comando desde la BD (se ignora el de entrada).
                importe_total: 0.0,
                id_usuario_cobrador: None,
                id_trabajador_cobrador: None,
                detalles: strings(&e["detalles"]),
            })
            .await
            .expect("el cobro debe aplicarse");
        }
        "mesas.cobrar_detalles" => {
            let repo = SqliteMesasRepository::new(db.clone());
            repo.cobrar_detalles(CobroDetalles {
                id_comanda: e["id_comanda"].as_str().unwrap().to_string(),
                metodo: e["metodo"].as_str().unwrap().to_string(),
                tipo: e["tipo"].as_str().unwrap().to_string(),
                detalle_ids: strings(&e["detalle_ids"]),
                id_usuario: None,
            })
            .await
            .expect("el cobro de mesa debe aplicarse");
        }
        "clientes.crear" => {
            let repo = SqliteClientesRepository::new(db.clone());
            repo.create(NuevoCliente {
                id: opt_str(&e["id_cliente"]),
                nombre: s(&e["nombre"]),
                email: opt_str(&e["email"]),
                telefono: opt_str(&e["telefono"]),
                notas: opt_str(&e["notas"]),
            })
            .await
            .expect("alta de cliente");
        }
        "clientes.actualizar" => {
            let repo = SqliteClientesRepository::new(db.clone());
            repo.update(Cliente {
                id: s(&e["id_cliente"]),
                nombre: s(&e["nombre"]),
                email: opt_str(&e["email"]),
                telefono: opt_str(&e["telefono"]),
                notas: opt_str(&e["notas"]),
            })
            .await
            .expect("edición de cliente");
        }
        "tareas.crear" => {
            let repo = SqliteTareasRepository::new(db.clone());
            repo.create_tarea(
                TareaData {
                    titulo: s(&e["titulo"]),
                    descripcion: opt_str(&e["descripcion"]),
                    fecha_limite: opt_str(&e["fecha_limite"]),
                },
                strings(&e["ids_trabajadores"]),
            )
            .await
            .expect("crear tarea");
        }
        "tareas.actualizar" => {
            let repo = SqliteTareasRepository::new(db.clone());
            repo.update_tarea(
                &s(&e["id_tarea"]),
                TareaData {
                    titulo: s(&e["titulo"]),
                    descripcion: opt_str(&e["descripcion"]),
                    fecha_limite: opt_str(&e["fecha_limite"]),
                },
            )
            .await
            .expect("actualizar tarea");
        }
        "tareas.set_asignaciones" => {
            let repo = SqliteTareasRepository::new(db.clone());
            repo.set_asignaciones(&s(&e["id_tarea"]), strings(&e["ids_trabajadores"]))
                .await
                .expect("set asignaciones");
        }
        "tareas.eliminar" => {
            let repo = SqliteTareasRepository::new(db.clone());
            repo.delete_tarea(&s(&e["id_tarea"])).await.expect("eliminar tarea");
        }
        "tareas.restaurar" => {
            let repo = SqliteTareasRepository::new(db.clone());
            repo.restaurar_tarea(&s(&e["id_tarea"])).await.expect("restaurar tarea");
        }
        "tareas.vaciar_papelera" => {
            let repo = SqliteTareasRepository::new(db.clone());
            repo.vaciar_papelera().await.expect("vaciar papelera");
        }
        "tareas.marcar_finalizada" => {
            let repo = SqliteTareasRepository::new(db.clone());
            repo.marcar_finalizada(&s(&e["id_tarea"]), &s(&e["id_trabajador"]))
                .await
                .expect("marcar finalizada");
        }
        "inventario.create_lote" => {
            let repo = SqliteInventarioRepository::new(db.clone());
            repo.create_lote(LoteNuevo {
                id: opt_str(&e["id_lote"]),
                id_producto: s(&e["id_producto"]),
                codigo_lote: s(&e["codigo_lote"]),
                caducidad: opt_str(&e["caducidad"]),
                stock_disponible: e["stock_disponible"].as_f64().unwrap(),
                fecha_entrada: opt_str(&e["fecha_entrada"]),
                coste_unitario: e["coste_unitario"].as_f64(),
                id_proveedor: opt_str(&e["id_proveedor"]),
                notas: opt_str(&e["notas"]),
            })
            .await
            .expect("crear lote");
        }
        "inventario.create_categoria" => {
            let repo = SqliteInventarioRepository::new(db.clone());
            repo.create_categoria(CategoriaUpsert {
                id: opt_str(&e["id_categoria"]),
                nombre: s(&e["nombre"]),
                nombre_imagen: s(&e["nombre_imagen"]),
                ruta_imagen: s(&e["ruta_imagen"]),
                vendible: e["vendible"].as_bool().unwrap(),
                pasa_cocina: e["pasa_cocina"].as_bool().unwrap(),
            })
            .await
            .expect("crear categoria");
        }
        "inventario.upsert_producto" => {
            let repo = SqliteInventarioRepository::new(db.clone());
            repo.upsert_producto(ProductoUpsert {
                id: opt_str(&e["id_producto"]),
                id_categoria: s(&e["id_categoria"]),
                id_proveedor: opt_str(&e["id_proveedor"]),
                nombre: s(&e["nombre"]),
                precio_venta: e["precio_venta"].as_f64(),
                stock_minimo: e["stock_minimo"].as_f64(),
                unidad_medida: opt_str(&e["unidad_medida"]),
                nombre_imagen: opt_str(&e["nombre_imagen"]),
                ruta_imagen: opt_str(&e["ruta_imagen"]),
                cantidad_pedido_esperada: e["cantidad_pedido_esperada"].as_f64(),
                stock_suelto: e["stock_suelto"].as_f64(),
                iva_percent: e["iva_percent"].as_f64(),
                ids_alergenos: strings(&e["ids_alergenos"]),
            })
            .await
            .expect("upsert producto");
        }
        "inventario.set_alergenos" => {
            let repo = SqliteInventarioRepository::new(db.clone());
            repo.set_alergenos_producto(&s(&e["id_producto"]), strings(&e["ids_alergenos"]))
                .await
                .expect("set alergenos");
        }
        "inventario.delete_producto" => {
            let repo = SqliteInventarioRepository::new(db.clone());
            repo.delete_producto(&s(&e["id_producto"])).await.expect("delete producto");
        }
        "inventario.update_lote" => {
            let repo = SqliteInventarioRepository::new(db.clone());
            repo.update_lote(LoteUpdate {
                id_lote: s(&e["id_lote"]),
                id_producto: s(&e["id_producto"]),
                codigo_lote: s(&e["codigo_lote"]),
                caducidad: opt_str(&e["caducidad"]),
                stock_disponible: e["stock_disponible"].as_f64().unwrap(),
                fecha_entrada: opt_str(&e["fecha_entrada"]),
                coste_unitario: e["coste_unitario"].as_f64(),
                id_proveedor: opt_str(&e["id_proveedor"]),
                notas: opt_str(&e["notas"]),
            })
            .await
            .expect("update lote");
        }
        "inventario.ajustar_lote" => {
            let repo = SqliteInventarioRepository::new(db.clone());
            repo.ajustar_lote(AjusteLote {
                id_lote: s(&e["id_lote"]),
                stock_disponible: e["stock_disponible"].as_f64().unwrap(),
                notas: opt_str(&e["notas"]),
            })
            .await
            .expect("ajustar lote");
        }
        "config.patch_business" => {
            let repo = SqliteConfiguracionRepository::new(db.clone());
            repo.patch_business(&e["patch"]).await.expect("patch business");
        }
        "config.patch_contact" => {
            let repo = SqliteConfiguracionRepository::new(db.clone());
            repo.patch_contact(&e["patch"]).await.expect("patch contact");
        }
        "config.patch_ticket" => {
            let repo = SqliteConfiguracionRepository::new(db.clone());
            repo.patch_ticket(&e["patch"]).await.expect("patch ticket");
        }
        "proveedores.guardar" => {
            let repo = SqliteProveedoresRepository::new(db.clone());
            repo.guardar(ProveedorValidado {
                id: opt_str(&e["id_proveedor"]),
                nombre_empresa: s(&e["nombre_empresa"]),
                contacto: opt_str(&e["contacto"]),
                telefono: opt_str(&e["telefono"]),
                email: opt_str(&e["email"]),
                cif: opt_str(&e["cif"]),
                informacion_adicional: opt_str(&e["informacion_adicional"]),
                nombre_imagen: opt_str(&e["nombre_imagen"]),
                ruta_imagen: opt_str(&e["ruta_imagen"]),
            })
            .await
            .expect("guardar proveedor");
        }
        "proveedores.eliminar" => {
            let repo = SqliteProveedoresRepository::new(db.clone());
            repo.eliminar(&s(&e["id_proveedor"])).await.expect("eliminar proveedor");
        }
        "proveedores.set_vinculos" => {
            let repo = SqliteProveedoresRepository::new(db.clone());
            repo.set_vinculos(&s(&e["id_proveedor"]), strings(&e["producto_ids"]))
                .await
                .expect("set vinculos");
        }
        "proveedores.crear_producto" => {
            let repo = SqliteProveedoresRepository::new(db.clone());
            repo.crear_producto(ProductoNuevo {
                id: opt_str(&e["id_producto"]),
                id_categoria: s(&e["id_categoria"]),
                id_proveedor: s(&e["id_proveedor"]),
                nombre: s(&e["nombre"]),
                precio_venta: e["precio_venta"].as_f64(),
                stock_actual: e["stock_actual"].as_f64(),
                stock_minimo: e["stock_minimo"].as_f64(),
                unidad_medida: opt_str(&e["unidad_medida"]),
            })
            .await
            .expect("crear producto");
        }
        "reservas.guardar" => {
            let repo = SqliteReservasRepository::new(db.clone());
            repo.guardar(ReservaValidada {
                id: opt_str(&e["id_reserva"]),
                id_mesa: opt_str(&e["id_mesa"]),
                dia_ymd: s(&e["dia_ymd"]),
                hora: s(&e["hora"]),
                turno: s(&e["turno"]),
                comensales: e["comensales"].as_i64().unwrap(),
                nota: opt_str(&e["nota"]),
                estado: s(&e["estado"]),
                cliente: ClienteReserva {
                    nombre: s(&e["nombre_cliente"]),
                    email: opt_str(&e["email"]),
                    telefono: opt_str(&e["telefono"]),
                    notas: opt_str(&e["notas_cliente"]),
                },
            })
            .await
            .expect("guardar reserva");
        }
        "reservas.eliminar" => {
            let repo = SqliteReservasRepository::new(db.clone());
            repo.eliminar(&s(&e["id_reserva"])).await.expect("eliminar reserva");
        }
        "venta_rapida.create_comanda_barra" => {
            let repo = SqliteVentaRapidaRepository::new(db.clone());
            repo.create_comanda_barra(None, false).await.expect("create comanda barra");
        }
        "venta_rapida.add_linea" => {
            let repo = SqliteVentaRapidaRepository::new(db.clone());
            repo.add_linea_comanda(
                &s(&e["id_comanda"]),
                &s(&e["id_producto"]),
                e["cantidad"].as_f64().unwrap(),
                e["precio_unitario"].as_f64().unwrap(),
            )
            .await
            .expect("add linea");
        }
        "venta_rapida.remove_last_unpaid_linea" => {
            let repo = SqliteVentaRapidaRepository::new(db.clone());
            repo.remove_last_unpaid_linea(&s(&e["id_comanda"]), &s(&e["id_producto"]))
                .await
                .expect("remove last unpaid");
        }
        "venta_rapida.delete_linea_if_unpaid" => {
            let repo = SqliteVentaRapidaRepository::new(db.clone());
            repo.delete_linea_if_unpaid(&s(&e["id_comanda"]), &s(&e["id_detalle"]))
                .await
                .expect("delete linea if unpaid");
        }
        "venta_rapida.update_nota_detalle" => {
            let repo = SqliteVentaRapidaRepository::new(db.clone());
            repo.update_nota_detalle(&s(&e["id_detalle"]), opt_str(&e["nota"]))
                .await
                .expect("update nota detalle");
        }
        "venta_rapida.restar_stock" => {
            let repo = SqliteVentaRapidaRepository::new(db.clone());
            let lineas = e["lineas"]
                .as_array()
                .unwrap()
                .iter()
                .map(|l| StockLinea {
                    producto_id: s(&l["producto_id"]),
                    cantidad: l["cantidad"].as_f64().unwrap(),
                })
                .collect();
            repo.restar_stock(lineas).await.expect("restar stock");
        }
        "venta_rapida.delete_comanda_if_safe" => {
            let repo = SqliteVentaRapidaRepository::new(db.clone());
            repo.delete_comanda_if_safe(&s(&e["id_comanda"]))
                .await
                .expect("delete comanda if safe");
        }
        "mesas.save_layout" => {
            let repo = SqliteMesasRepository::new(db.clone());
            // El `entrada` se deserializa al DTO real (`SalonInput`), no a mano: así el fixture no
            // puede quedarse desalineado con la forma que de verdad recibe el comando.
            let salons: Vec<SalonInput> =
                serde_json::from_value(e["salons"].clone()).expect("salons del fixture");
            repo.save_layout(salons).await.expect("save layout");
        }
        "mesas.set_reserva_estado" => {
            let repo = SqliteMesasRepository::new(db.clone());
            repo.set_reserva_estado(&s(&e["id_reserva"]), s(&e["estado"]))
                .await
                .expect("set reserva estado");
        }
        "cuentas.create_gasto" => {
            let repo = SqliteCuentasRepository::new(db.clone());
            repo.crear_gasto(opt_str(&e["id_gasto"]), gasto_del_caso(e), None)
                .await
                .expect("crear gasto");
        }
        "cuentas.update_gasto" => {
            let repo = SqliteCuentasRepository::new(db.clone());
            repo.actualizar_gasto(&s(&e["id_gasto"]), gasto_del_caso(e))
                .await
                .expect("actualizar gasto");
        }
        "cuentas.delete_gasto" => {
            let repo = SqliteCuentasRepository::new(db.clone());
            repo.eliminar_gasto(&s(&e["id_gasto"]), None).await.expect("eliminar gasto");
        }
        "cuentas.update_pago" => {
            let repo = SqliteCuentasRepository::new(db.clone());
            repo.actualizar_pago(
                &s(&e["id_pago"]),
                PagoData {
                    fecha_hora: s(&e["fecha_hora"]),
                    // La normalización del método (CUENTA-03) vive en el CASO DE USO, no en el
                    // repositorio, y el otro lado la aplica en su builder: hay que entrar a la
                    // misma altura o el test compararía dos caminos distintos y cantaría una
                    // divergencia que no existe.
                    metodo: normalize_metodo(&s(&e["metodo"])),
                    // El importe del formulario se IGNORA a propósito (CUENTA-02): el comando lo
                    // recalcula desde las líneas cobradas. Se manda un valor absurdo para que, si
                    // algún día dejara de ignorarse, el golden lo cante.
                    importe: -1.0,
                },
            )
            .await
            .expect("actualizar pago");
        }
        "cuentas.anular_pago" => {
            let repo = SqliteCuentasRepository::new(db.clone());
            // Quién anula y por qué llegan del caso porque en el TPV llegan de la sesión: el
            // fixture hace de sesión para que los dos lados escriban la misma firma.
            repo.anular_pago(tpv_application::ports::cuentas::AnularPagoArgs {
                id_pago: s(&e["id_pago"]),
                id_usuario: s(&e["id_usuario"]),
                motivo: s(&e["motivo"]),
            })
            .await
            .expect("anular pago");
        }
        "notificaciones.crear" => {
            let repo = SqliteNotificacionesRepository::new(db.clone());
            // `validar` es parte del camino real (normaliza severidad/textos): el fixture entrega
            // los datos crudos, como los entrega la UI.
            let nueva = NuevaNotificacion::validar(
                s(&e["tipo"]),
                &s(&e["severidad"]),
                s(&e["titulo"]),
                opt_str(&e["cuerpo"]),
                &s(&e["destino_tipo"]),
                opt_str(&e["destino_valor"]),
                opt_str(&e["accion"]),
                opt_str(&e["payload"]),
                opt_str(&e["clave_dedupe"]),
                opt_str(&e["expira_en"]),
            )
            .expect("notificacion valida");
            repo.emitir(nueva).await.expect("emitir notificacion");
        }
        "notificaciones.marcar_leida" => {
            let repo = SqliteNotificacionesRepository::new(db.clone());
            repo.marcar_leida(&s(&e["id_notificacion"]), &s(&e["id_usuario"]))
                .await
                .expect("marcar leida");
        }
        "notificaciones.marcar_leidas_batch" => {
            let repo = SqliteNotificacionesRepository::new(db.clone());
            repo.marcar_todas_leidas(&s(&e["id_usuario"]))
                .await
                .expect("marcar todas leidas");
        }
        "notificaciones.resolver_por_clave" => {
            let repo = SqliteNotificacionesRepository::new(db.clone());
            repo.resolver_por_clave(&s(&e["clave_dedupe"]))
                .await
                .expect("resolver por clave");
        }
        "mesas.abrir_comanda" => {
            let repo = SqliteMesasRepository::new(db.clone());
            repo.abrir_comanda(AbrirComandaData {
                id_mesa: s(&e["id_mesa"]),
                id_trabajador_o_usuario: None,
                id_reserva: None,
            })
            .await
            .expect("abrir comanda");
        }
        "mesas.set_trabajador_if_null" => {
            let repo = SqliteMesasRepository::new(db.clone());
            repo.comanda_set_trabajador_if_null(
                &s(&e["id_comanda"]),
                opt_str(&e["id_trabajador_o_usuario"]),
            )
            .await
            .expect("set trabajador if null");
        }
        "mesas.cerrar_comanda" => {
            let repo = SqliteMesasRepository::new(db.clone());
            repo.cerrar_comanda(&s(&e["id_comanda"]), e["total"].as_f64().unwrap())
                .await
                .expect("cerrar comanda");
        }
        "mesas.add_linea" => {
            let repo = SqliteMesasRepository::new(db.clone());
            repo.add_linea_comanda(
                &s(&e["id_comanda"]),
                &s(&e["id_producto"]),
                e["cantidad"].as_f64().unwrap(),
                e["precio"].as_f64().unwrap(),
                None,
            )
            .await
            .expect("add linea mesa");
        }
        "mesas.remove_one_pending_detalle" => {
            let repo = SqliteMesasRepository::new(db.clone());
            repo.remove_one_pending_detalle(&s(&e["id_comanda"]), &s(&e["id_producto"]))
                .await
                .expect("remove one pending");
        }
        "mesas.delete_detalle" => {
            let repo = SqliteMesasRepository::new(db.clone());
            repo.delete_detalle(&s(&e["id_detalle"])).await.expect("delete detalle");
        }
        "mesas.update_detalle_nota" => {
            let repo = SqliteMesasRepository::new(db.clone());
            repo.update_detalle_nota(&s(&e["id_detalle"]), opt_str(&e["nota"]))
                .await
                .expect("update detalle nota");
        }
        "mesas.kitchen_set_line_state" => {
            let repo = SqliteMesasRepository::new(db.clone());
            repo.kitchen_set_line_state(
                &s(&e["id_detalle"]),
                &s(&e["id_usuario_cocinero"]),
                s(&e["estado"]),
            )
            .await
            .expect("kitchen set line state");
        }
        "login.punch" => {
            // Se llama a `exec_punch` (el efecto) y no a `repo.punch`, que antes verifica el PIN:
            // el PIN es autenticación, no forma parte del contrato de replicación.
            let conn = db.write().await;
            crate::login::exec_punch(&conn, &s(&e["id_usuario"]), &s(&e["tipo"]), None, None)
                .await
                .expect("fichaje");
        }
        "login.set_turno_partido" => {
            let repo = SqliteLoginRepository::new(db.clone());
            repo.set_turno_partido(
                &s(&e["id_usuario"]),
                opt_str(&e["fecha"]),
                e["turno_partido"].as_bool().unwrap(),
            )
            .await
            .expect("set turno partido");
        }
        "horarios.copiar_semana" => {
            let repo = SqliteTrabajadoresRepository::new(db.clone());
            repo.copy_semana(
                s(&e["from_monday"]),
                s(&e["to_monday"]),
                e["overwrite"].as_bool().unwrap_or(false),
            )
            .await
            .expect("copiar semana");
        }
        "horarios.create_asignacion" => {
            let repo = SqliteTrabajadoresRepository::new(db.clone());
            repo.create_asignacion(AsignacionNueva {
                id_trabajador: s(&e["id_trabajador"]),
                fecha: s(&e["fecha"]),
                id_turno: s(&e["id_turno"]),
                area: s(&e["area"]),
                hora_inicio: opt_str(&e["hora_inicio"]),
                hora_fin: opt_str(&e["hora_fin"]),
                notas: opt_str(&e["notas"]),
            })
            .await
            .expect("create asignacion");
        }
        "horarios.update_asignacion" => {
            let repo = SqliteTrabajadoresRepository::new(db.clone());
            repo.update_asignacion(
                &s(&e["id_asignacion"]),
                AsignacionCambios {
                    id_turno: s(&e["id_turno"]),
                    area: s(&e["area"]),
                    hora_inicio: opt_str(&e["hora_inicio"]),
                    hora_fin: opt_str(&e["hora_fin"]),
                    notas: opt_str(&e["notas"]),
                },
            )
            .await
            .expect("update asignacion");
        }
        "horarios.delete_asignacion" => {
            let repo = SqliteTrabajadoresRepository::new(db.clone());
            repo.delete_asignacion(&s(&e["id_asignacion"]))
                .await
                .expect("delete asignacion");
        }
        "notificaciones.descartar" => {
            let repo = SqliteNotificacionesRepository::new(db.clone());
            repo.descartar(&s(&e["id_notificacion"])).await.expect("descartar");
        }
        "notificaciones.restaurar" => {
            let repo = SqliteNotificacionesRepository::new(db.clone());
            repo.restaurar(&s(&e["id_notificacion"])).await.expect("restaurar");
        }
        "notificaciones.eliminar" => {
            let repo = SqliteNotificacionesRepository::new(db.clone());
            repo.eliminar(&s(&e["id_notificacion"])).await.expect("eliminar");
        }
        otro => panic!("comando sin soporte en el harness de contrato: {otro}"),
    }
}

/// Corre un caso: BD nueva, siembra, aplica el comando (que deja su efecto en la BD) y
/// compara/bendice su golden. Cada `#[tokio::test]` generado por `casos_de_contrato!` llama aquí.
async fn correr_caso(nombre: &str) {
    let caso = leer_caso(nombre);
    let (db, _dir) = db_temporal().await;
    sembrar(&db, caso["seed"].as_array().unwrap()).await;
    aplicar_comando(&db, &caso).await;
    let estado = estado_resultante(&db, caso["snapshot"].as_object().unwrap()).await;
    comparar_o_bendecir(nombre, &estado);
}
