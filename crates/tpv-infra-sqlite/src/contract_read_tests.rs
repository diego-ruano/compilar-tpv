//! # Tests de contrato de LECTURA Main (Rust) ↔ worker (TS) — CLI-05 / ARCH-01
//!
//! El harness hermano de `contract_tests.rs`. Aquel fija las **escrituras** (mismo comando → mismas
//! filas); éste fija las **lecturas** (mismas filas → mismo resultado devuelto).
//!
//! ## Por qué hace falta
//!
//! La misma consulta está escrita dos veces: en Rust (`crates/tpv-infra-sqlite`, que sirve a la Main
//! contra el SQLite local) y en TypeScript (`domains/*/*.queries.ts`, que sirve a la Handy contra
//! Turso). Los **datos** convergen —de eso se encarga la replicación—, pero el SQL que los lee no es
//! el mismo código, así que las mismas filas pueden acabar presentadas distinto: un JOIN de más, un
//! filtro de borrados que sólo está en un lado, un `ORDER BY` distinto, un `NULL` que uno normaliza
//! y el otro no. El fallo que produce no es corrupción de datos: es que **el camarero mire la Handy
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
//! worker se conforma. Regenerar: `BLESS_CONTRACT_READ=1 cargo test -p tpv-infra-sqlite lectura_`.

#![cfg(test)]

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{Map, Value as Json};

use tpv_application::ports::clientes::ClientesRepository;
use tpv_application::ports::cuentas::{CuentasFiltro, CuentasRepository};
use tpv_application::ports::inventario::InventarioRepository;
use tpv_application::ports::mesas::MesasRepository;
use tpv_application::ports::tareas::TareasRepository;
use tpv_application::ports::trabajadores::TrabajadoresRepository;
use tpv_application::ports::venta_rapida::VentaRapidaRepository;
use tpv_domain::clientes::ClienteRanking;

use crate::clientes::SqliteClientesRepository;
use crate::contract_comun::{cell_eq, contract_dir, db_temporal, sembrar};
use crate::cuentas::SqliteCuentasRepository;
use crate::db::Db;
use crate::inventario::SqliteInventarioRepository;
use crate::mesas::SqliteMesasRepository;
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

/// `entrada` → filtro de los listados de caja (rango + búsqueda + paginación).
fn filtro_cuentas(e: &Json) -> CuentasFiltro {
    CuentasFiltro {
        del: opt_str(&e["del"]),
        al: opt_str(&e["al"]),
        q: opt_str(&e["q"]),
        page: e["page"].as_u64().map(|n| n as u32),
        page_size: e["page_size"].as_u64().map(|n| n as u32),
    }
}

/// Genera **un `#[tokio::test]` por lectura**, igual que en el harness de escritura y por el mismo
/// motivo (una BD libsql por test: abrir muchas en uno solo revienta en Windows).
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
    cuentas__salidas,
    cuentas__resumen,
    inventario__productos_por_categoria,
    inventario__resumen,
    mesas__lineas_comanda,
    venta_rapida__comandas_barra,
    venta_rapida__lineas_comanda,
    tareas__admin,
    tareas__mias,
    trabajadores__asignaciones_semana,
    trabajadores__asignaciones_semana_con_predeterminado,
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
        "mesas.ocupadas" => {
            let repo = SqliteMesasRepository::new(db.clone());
            let r = repo.get_mesas_ocupadas().await.expect("mesas ocupadas");
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
        otro => panic!("lectura sin soporte en el harness de contrato: {otro}"),
    }
}

/// Corre un caso: BD nueva, siembra, ejecuta la lectura y compara/bendice su golden.
async fn correr_lectura(nombre: &str) {
    let caso = leer_caso(nombre);
    let (db, _dir) = db_temporal().await;
    sembrar(&db, caso["seed"].as_array().unwrap()).await;
    let obtenido = ejecutar_lectura(&db, &caso).await;
    comparar_o_bendecir(nombre, &obtenido);
}
