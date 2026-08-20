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

use libsql::{Connection, Value};
use serde_json::{Map, Value as Json};

use tpv_domain::venta_rapida::CobroFraccionado;
use tpv_application::ports::venta_rapida::VentaRapidaRepository;

use crate::db::{Db, Reader};
use crate::venta_rapida::SqliteVentaRapidaRepository;

/// Tolerancia al comparar números (stock decimal, importes): absorbe el ruido de coma flotante.
const TOL: f64 = 1e-9;

fn contract_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/contract")
}

fn uniq() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    format!("{}_{}", std::process::id(), COUNTER.fetch_add(1, Ordering::Relaxed))
}

async fn db_temporal() -> (Arc<Db>, PathBuf) {
    let dir = std::env::temp_dir().join(format!("tpv_contract_{}", uniq()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
    (db, dir)
}

async fn sembrar(db: &Arc<Db>, sentencias: &[Json]) {
    let w = db.write().await;
    let conn: &Connection = w.raw();
    for s in sentencias {
        let sql = s.as_str().expect("cada seed es un string SQL");
        conn.execute(sql, Vec::<Value>::new())
            .await
            .unwrap_or_else(|e| panic!("sembrando: {sql}\n{e}"));
    }
}

/// `libsql::Value` → `serde_json::Value`. Los blobs no se replican, así que no aparecen aquí.
fn cell_to_json(v: Value) -> Json {
    match v {
        Value::Null => Json::Null,
        Value::Integer(i) => Json::from(i),
        Value::Real(f) => Json::from(f),
        Value::Text(s) => Json::String(s),
        Value::Blob(_) => Json::Null,
    }
}

/// Nombres de columna del SELECT (entre `SELECT` y `FROM`). Los SELECT del harness son planos a
/// propósito (sin `*`, sin subconsultas), así que este parseo simple basta.
fn columnas(select: &str) -> Vec<String> {
    let up = select.to_uppercase();
    let ini = up.find("SELECT ").expect("SELECT") + "SELECT ".len();
    let fin = up.find(" FROM ").expect("FROM");
    select[ini..fin]
        .split(',')
        .map(|c| c.trim().to_string())
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

/// Igualdad estructural de dos celdas: números con tolerancia; strings/null exactos.
fn cell_eq(a: &Json, b: &Json) -> bool {
    match (a, b) {
        (Json::Null, Json::Null) => true,
        (Json::Bool(x), Json::Bool(y)) => x == y,
        (Json::String(x), Json::String(y)) => x == y,
        (Json::Number(_), Json::Number(_)) => {
            (a.as_f64().unwrap_or(f64::NAN) - b.as_f64().unwrap_or(f64::NAN)).abs() < TOL
        }
        _ => false,
    }
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
    let golden_path = contract_dir().join("golden").join(format!("{nombre}.json"));

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
    let path = contract_dir().join("casos").join(format!("{nombre}.json"));
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

/// Casos del harness. Añadir uno: crear su fixture en `tests/contract/casos/`, bendecir su golden
/// (`BLESS_CONTRACT=1 cargo test -p tpv-infra-sqlite contrato_`) y sumar su nombre aquí y en el test
/// del worker (`test/contractVentaRapida.test.ts`).
const CASOS: &[&str] = &[
    "venta_rapida__cobro_fraccionado_un_lote",
    "venta_rapida__cobro_fraccionado_fefo_multilote",
];

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
        otro => panic!("comando sin soporte en el harness de contrato: {otro}"),
    }
}

#[tokio::test]
async fn contrato_efecto_coincide_con_el_golden() {
    for nombre in CASOS {
        let caso = leer_caso(nombre);
        let (db, _dir) = db_temporal().await;
        sembrar(&db, caso["seed"].as_array().unwrap()).await;
        aplicar_comando(&db, &caso).await;
        let estado = estado_resultante(&db, caso["snapshot"].as_object().unwrap()).await;
        comparar_o_bendecir(nombre, &estado);
    }
}
