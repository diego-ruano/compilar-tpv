//! DO-SUBIDA · La nube de la subida completa en los tests de punta a punta: contesta los pasos
//! (`plan`, `huellas`, `tramos`, `filas`, `sobrantes`, `fin`) como el `TenantHub`
//! (`apps/cloud-worker-licensing/src/durableObjects/tenantHub.subida.ts`), sobre una base SQLite con
//! el esquema del negocio que hace de base de la nube.
//!
//! Lo que se prueba aquí es el lado de la Main: qué manda, en qué orden, qué hace con cada acuse y
//! cómo se reanuda. Que el worker aplique igual lo fijan sus tests (`test/subidaCompleta.test.ts`) y la
//! tabla de casos compartida (`verificacion_casos.json`: la huella de una fila y la suma de un tramo).

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value as Json};

use tpv_application::error::AppResult;
use tpv_application::ports::subida_completa::EnvioDeSubida;
use tpv_domain::contraste::{self as cubos, Celda};
use tpv_infra_sqlite::db::Db;
use tpv_infra_sqlite::ejecutor::Value;

/// Las tablas que no se suben, como `esTablaDeNegocio` en el worker.
fn es_del_negocio(t: &str) -> bool {
    !t.starts_with('_') && !t.starts_with("sqlite_") && !t.starts_with("Sync_") && t != "Applied_Operations" && t != "Intentos_Login"
}

/// La ventana de una tabla transaccional en el doble: lo vivo y lo de desde `?1`.
fn ventana(t: &str) -> Option<&'static str> {
    Some(match t {
        "Comandas" => "SELECT * FROM \"Comandas\" WHERE Estado = 'Abierta' OR Fecha_Hora_Apertura >= ?1",
        "Detalle_Comanda" => "SELECT * FROM \"Detalle_Comanda\" WHERE ID_Comanda IN (SELECT ID_Comanda FROM Comandas WHERE Estado = 'Abierta' OR Fecha_Hora_Apertura >= ?1)",
        "Pagos" => "SELECT * FROM \"Pagos\" WHERE ID_Comanda IN (SELECT ID_Comanda FROM Comandas WHERE Estado = 'Abierta' OR Fecha_Hora_Apertura >= ?1)",
        _ => return None,
    })
}

/// Cómo nombra el log de la nube a la Main de la subida (`dispositivo` del plan).
pub const DISPOSITIVO: &str = "main-subida";

/// Lo que la nube admite en una página de filas (`BYTES_POR_PAGINA` del worker).
const BYTES_POR_PAGINA: usize = 3 * 1024 * 1024 / 2;

pub struct NubeDeSubida {
    pub db: Arc<Db>,
    dir: PathBuf,
    /// El final del log de la nube: lo que dice el plan y lo que piden los borrados condicionados.
    pub hasta_seq: i64,
    /// El cambio vacío que abrió el log al volver (`inicioSeq` del plan). `None`: un worker
    /// anterior, que no lo dice.
    pub inicio_seq: Option<i64>,
    /// Hay algo de una Handy por encima del checkpoint de la Main: las páginas de filas se aplazan.
    pub ajeno: bool,
    /// Columnas que la nube no tiene (otra versión): no salen en el plan.
    pub sin_columnas: HashMap<String, Vec<String>>,
    /// Tras este número de páginas de filas aplicadas, el acuse se pierde (`None`).
    pub cortar_tras: Option<usize>,
    /// Todo lo que ha llegado, en orden.
    pub pasos: Vec<Json>,
    pub paginas_aplicadas: usize,
    /// El acuse de la próxima página de filas, en vez de aplicarla (un rechazo de la nube).
    pub rechazar_la_proxima: Option<Json>,
    /// Los acuses de rechazo que ha dado, por su código.
    pub rechazos: Vec<String>,
    /// Un rechazo para cada página de filas que lo pida, en vez de aplicarla (`None`: se aplica).
    pub rechazar_si: Option<Rechazo>,
    /// Un rechazo para cualquier paso que lo pida (el plan, el `fin`…), antes de mirarlo.
    pub rechazar_paso: Option<Rechazo>,
}

/// El acuse de rechazo que da la nube a una página de filas, si lo da.
pub type Rechazo = Box<dyn Fn(&Json) -> Option<Json> + Send + Sync>;

fn celda(v: &Value) -> Celda<'_> {
    match v {
        Value::Null => Celda::Nulo,
        Value::Integer(n) => Celda::entero(*n),
        Value::Real(x) => Celda::Numero(*x),
        Value::Text(t) => Celda::Texto(t.as_bytes()),
        Value::Blob(b) => Celda::Blob(b),
    }
}

fn a_valor(v: &Json) -> Value {
    match v {
        Json::Null => Value::Null,
        Json::String(s) => Value::Text(s.clone()),
        Json::Number(n) => n.as_i64().map(Value::Integer).unwrap_or_else(|| Value::Real(n.as_f64().unwrap())),
        otro => panic!("valor que la Main no manda: {otro}"),
    }
}

fn a_json(v: &Value) -> Json {
    match v {
        Value::Null => Json::Null,
        Value::Integer(n) => json!(n),
        Value::Real(x) => json!(x),
        Value::Text(t) => json!(t),
        Value::Blob(_) => Json::Null,
    }
}

fn cita(n: &str) -> String {
    format!("\"{}\"", n.replace('"', "\"\""))
}

fn huella(fila: &[Value]) -> u64 {
    let celdas: Vec<Celda<'_>> = fila.iter().map(celda).collect();
    cubos::huella_de_fila(&celdas)
}

impl NubeDeSubida {
    pub async fn nueva(nombre: &str) -> Self {
        let marca = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join("tpv_tests").join(format!("subida-{nombre}-{}-{marca}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(dir.join("nube.db").to_str().unwrap()).await.unwrap();
        let nube = Self {
            db,
            dir,
            hasta_seq: 10_000_100,
            inicio_seq: Some(10_000_100),
            ajeno: false,
            sin_columnas: HashMap::new(),
            cortar_tras: None,
            pasos: Vec::new(),
            paginas_aplicadas: 0,
            rechazar_la_proxima: None,
            rechazos: Vec::new(),
            rechazar_si: None,
            rechazar_paso: None,
        };
        // El cambio vacío que abre el log tras devolver la base (`abrirLogTrasVolver`).
        nube.sembrar(&format!(
            "INSERT INTO Sync_Changes (Seq, Op_Id, Command_Name, Statements_Json, Device_Id, Created_At_Ms) VALUES ({}, 'nube-devuelta', 'nube_devuelta', '[]', NULL, 1);",
            nube.hasta_seq
        ))
        .await;
        nube
    }

    pub async fn cerrar(self) {
        let _ = self.db.cerrar().await;
        drop(self.db);
        let _ = std::fs::remove_dir_all(&self.dir);
    }

    pub async fn sembrar(&self, sql: &str) {
        let w = self.db.write().await;
        w.raw().execute_batch(sql).await.unwrap();
    }

    pub async fn filas(&self, sql: &str, args: Vec<Value>) -> Vec<Vec<Value>> {
        let r = self.db.read().await;
        let mut f = r.conn().query(sql, args).await.unwrap();
        let mut out = Vec::new();
        while let Some(fila) = f.next().await.unwrap() {
            let mut v = Vec::new();
            let mut i = 0;
            while let Ok(x) = fila.get_value(i) {
                v.push(x);
                i += 1;
            }
            out.push(v);
        }
        out
    }

    async fn tablas(&self) -> Vec<String> {
        self.filas("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;", vec![])
            .await
            .into_iter()
            .filter_map(|f| match &f[0] {
                Value::Text(t) if es_del_negocio(t) => Some(t.clone()),
                _ => None,
            })
            .collect()
    }

    async fn columnas(&self, t: &str) -> (Vec<String>, Vec<String>) {
        let info = self.filas("SELECT name, pk FROM pragma_table_info(?1) ORDER BY cid;", vec![Value::Text(t.into())]).await;
        let mut clave: Vec<(i64, String)> = Vec::new();
        let mut cols = Vec::new();
        for f in info {
            let (Value::Text(n), Value::Integer(pk)) = (&f[0], &f[1]) else { continue };
            if *pk > 0 {
                clave.push((*pk, n.clone()));
            }
            cols.push(n.clone());
        }
        clave.sort();
        (cols, clave.into_iter().map(|(_, c)| c).collect())
    }

    /// Las filas de unas claves, por la clave en JSON.
    async fn por_clave(&self, t: &str, columnas: &[String], clave: &[String], claves: &[Json]) -> HashMap<String, Vec<Value>> {
        let lista = columnas.iter().map(|c| cita(c)).collect::<Vec<_>>().join(", ");
        let orden = clave.iter().map(|c| cita(c)).collect::<Vec<_>>().join(", ");
        let extraer = (0..clave.len()).map(|i| format!("json_extract(value, '$[{i}]')")).collect::<Vec<_>>().join(", ");
        let pos: Vec<usize> = clave.iter().map(|k| columnas.iter().position(|c| c == k).unwrap()).collect();
        let sql = format!("SELECT {lista} FROM {} WHERE ({orden}) IN (SELECT {extraer} FROM json_each(?1));", cita(t));
        self.filas(&sql, vec![Value::Text(Json::Array(claves.to_vec()).to_string())])
            .await
            .into_iter()
            .map(|f| (Json::Array(pos.iter().map(|i| a_json(&f[*i])).collect()).to_string(), f))
            .collect()
    }

    /// Aplica lo que la Main ha encolado (un borrado condicionado), como el DO, y vacía su outbox.
    pub async fn subir_outbox(&self, main: &Db) -> usize {
        let ops = {
            let r = main.read().await;
            let mut f = r.conn().query("SELECT Statements_Json FROM _Sync_Outbox WHERE Cuarentena = 0 ORDER BY Seq;", ()).await.unwrap();
            let mut ops = Vec::new();
            while let Some(fila) = f.next().await.unwrap() {
                ops.push(fila.get::<String>(0).unwrap());
            }
            ops
        };
        for op in &ops {
            let sentencias: Vec<tpv_contracts::sync::SqlStatement> = serde_json::from_str(op).unwrap();
            let w = self.db.write().await;
            for s in sentencias {
                w.raw().execute(&s.sql, s.args.iter().map(a_valor).collect::<Vec<_>>()).await.unwrap();
            }
        }
        let w = main.write().await;
        w.raw().execute("DELETE FROM _Sync_Outbox;", ()).await.unwrap();
        ops.len()
    }

    async fn contestar(&mut self, p: &Json) -> Option<Json> {
        if let Some(r) = self.rechazar_paso.as_ref().and_then(|f| f(p)) {
            self.rechazos.push(r["error"].as_str().unwrap_or("").into());
            return Some(r);
        }
        let tabla = p["tabla"].as_str().unwrap_or("").to_string();
        Some(match p["accion"].as_str().unwrap() {
            "plan" => {
                let mut tablas = Vec::new();
                let mut vivos = serde_json::Map::new();
                for t in self.tablas().await {
                    let (mut cols, clave) = self.columnas(&t).await;
                    if let Some(sin) = self.sin_columnas.get(&t) {
                        cols.retain(|c| !sin.contains(c));
                    }
                    let (sql, parcial) = match ventana(&t) {
                        Some(s) => (s.to_string(), true),
                        None => (format!("SELECT * FROM {}", cita(&t)), false),
                    };
                    let politica = match t.as_str() {
                        "Registros_Facturacion" => "solo_insertar",
                        "Serie_Facturacion" => "monotono",
                        _ => "upsert",
                    };
                    tablas.push(json!({"tabla": t, "columnas": cols, "clave": clave, "sql": sql, "parametrizada": parcial, "parcial": parcial, "politica": politica}));
                }
                let abiertas: Vec<Json> = self
                    .filas("SELECT ID_Comanda FROM Comandas WHERE Estado = 'Abierta' ORDER BY ID_Comanda;", vec![])
                    .await
                    .into_iter()
                    .map(|f| json!([a_json(&f[0])]))
                    .collect();
                if !abiertas.is_empty() {
                    vivos.insert("Comandas".into(), Json::Array(abiertas));
                }
                for (t, clave) in [("Detalle_Comanda", "ID_Detalle"), ("Pagos", "ID_Pago")] {
                    let suyas: Vec<Json> = self
                        .filas(&format!("SELECT {clave} FROM {t} WHERE ID_Comanda IN (SELECT ID_Comanda FROM Comandas WHERE Estado = 'Abierta') ORDER BY 1;"), vec![])
                        .await
                        .into_iter()
                        .map(|f| json!([a_json(&f[0])]))
                        .collect();
                    if !suyas.is_empty() {
                        vivos.insert(t.into(), Json::Array(suyas));
                    }
                }
                let mut plan = json!({"ok": true, "ventanaDias": 30, "tablas": tablas, "vivos": vivos, "vivosIncompletos": false, "hastaSeq": self.hasta_seq, "dispositivo": DISPOSITIVO});
                if let Some(inicio) = self.inicio_seq {
                    plan["inicioSeq"] = json!(inicio);
                }
                plan
            }
            "huellas" => {
                let cols: Vec<String> = serde_json::from_value(p["columnas"].clone()).unwrap();
                let (_, clave) = self.columnas(&tabla).await;
                let pares = p["huellas"].as_array().unwrap();
                let claves: Vec<Json> = pares.iter().map(|h| h[0].clone()).collect();
                let aqui = self.por_clave(&tabla, &cols, &clave, &claves).await;
                let (mut distintas, mut faltan) = (Vec::new(), Vec::new());
                for h in pares {
                    match aqui.get(&h[0].to_string()) {
                        None => {
                            distintas.push(h[0].clone());
                            faltan.push(h[0].clone());
                        }
                        Some(f) if cubos::hex64(huella(f)) != h[1].as_str().unwrap() => distintas.push(h[0].clone()),
                        Some(_) => {}
                    }
                }
                json!({"ok": true, "distintas": distintas, "faltan": faltan})
            }
            "tramos" => {
                let cols: Vec<String> = serde_json::from_value(p["columnas"].clone()).unwrap();
                let (_, clave) = self.columnas(&tabla).await;
                let lista = cols.iter().map(|c| cita(c)).collect::<Vec<_>>().join(", ");
                let orden = clave.iter().map(|c| cita(c)).collect::<Vec<_>>().join(", ");
                let mut distintos = Vec::new();
                for (i, tr) in p["tramos"].as_array().unwrap().iter().enumerate() {
                    let mut args: Vec<Value> = Vec::new();
                    let mut donde = Vec::new();
                    for (k, op) in [("desde", ">"), ("hasta", "<=")] {
                        if let Some(v) = tr[k].as_array() {
                            let marcas: Vec<String> = v.iter().map(|x| {
                                args.push(a_valor(x));
                                format!("?{}", args.len())
                            }).collect();
                            donde.push(format!("({orden}) {op} ({})", marcas.join(", ")));
                        }
                    }
                    let filas = self.filas(&format!("SELECT {lista} FROM {} WHERE {} ORDER BY {orden};", cita(&tabla), donde.join(" AND ")), args).await;
                    let suma = cubos::suma_de_huellas(filas.iter().map(|f| huella(f)));
                    if filas.len() as u64 != tr["n"].as_u64().unwrap() || cubos::hex64(suma) != tr["suma"].as_str().unwrap() {
                        distintos.push(i);
                    }
                }
                json!({"ok": true, "distintos": distintos})
            }
            "filas" => {
                // La forma, como `formaDelPaso`: una lista vacía sólo para decir que la tabla acabó,
                // y una página que no cabe se contesta para que la Main la parta.
                let lista = p["filas"].as_array().cloned().unwrap_or_default();
                if lista.is_empty() && p["ultimaDeLaTabla"] != json!(true) {
                    self.rechazos.push("subida_mal_formada".into());
                    return Some(json!({"ok": false, "error": "subida_mal_formada", "permanente": true}));
                }
                if Json::Array(lista).to_string().len() > BYTES_POR_PAGINA {
                    self.rechazos.push("subida_pagina_demasiado_grande".into());
                    return Some(json!({"ok": false, "error": "subida_pagina_demasiado_grande"}));
                }
                if let Some(r) = self.rechazar_la_proxima.take().or_else(|| self.rechazar_si.as_ref().and_then(|f| f(p))) {
                    self.rechazos.push(r["error"].as_str().unwrap_or("").into());
                    return Some(r);
                }
                if self.ajeno {
                    return Some(json!({"ok": false, "aplazada": true, "hastaSeq": self.hasta_seq + 1}));
                }
                let cols: Vec<String> = serde_json::from_value(p["columnas"].clone()).unwrap();
                let (todas, clave) = self.columnas(&tabla).await;
                assert!(cols.iter().all(|c| todas.contains(c)), "columnas que la nube no tiene: {cols:?}");
                let filas = p["filas"].as_array().unwrap().clone();
                let resto: Vec<&String> = cols.iter().filter(|c| !clave.contains(c)).collect();
                let valores = (0..cols.len()).map(|i| format!("json_extract(value, '$[{i}]')")).collect::<Vec<_>>().join(", ");
                let conflicto = clave.iter().map(|c| cita(c)).collect::<Vec<_>>().join(", ");
                let solo = tabla == "Registros_Facturacion";
                let al_chocar = if tabla == "Serie_Facturacion" {
                    format!("ON CONFLICT({conflicto}) DO UPDATE SET \"Ultimo\" = MAX(\"Ultimo\", excluded.\"Ultimo\") WHERE excluded.\"Ultimo\" > \"Ultimo\"")
                } else if solo || resto.is_empty() {
                    format!("ON CONFLICT({conflicto}) DO NOTHING")
                } else {
                    format!(
                        "ON CONFLICT({conflicto}) DO UPDATE SET {} WHERE NOT ({})",
                        resto.iter().map(|c| format!("{0} = excluded.{0}", cita(c))).collect::<Vec<_>>().join(", "),
                        resto.iter().map(|c| format!("{0} IS excluded.{0}", cita(c))).collect::<Vec<_>>().join(" AND ")
                    )
                };
                let sql = format!(
                    "INSERT INTO {} ({}) SELECT {valores} FROM json_each(?1) WHERE 1 {al_chocar};",
                    cita(&tabla),
                    cols.iter().map(|c| cita(c)).collect::<Vec<_>>().join(", ")
                );
                let pos: Vec<usize> = clave.iter().map(|k| cols.iter().position(|c| c == k).unwrap()).collect();
                let mut escritas = 0u64;
                let mut no_entraron = Vec::new();
                // Fila a fila: el doble no necesita partir por mitades para saber cuál no entra.
                for f in &filas {
                    let w = self.db.write().await;
                    match w.raw().execute(&sql, vec![Value::Text(Json::Array(vec![f.clone()]).to_string())]).await {
                        Ok(n) => escritas += n,
                        Err(e) => {
                            let t = e.to_string().to_lowercase();
                            let motivo = if t.contains("unique") { "unico" } else if t.contains("foreign key") { "foranea" } else { "check" };
                            no_entraron.push(json!({"clave": pos.iter().map(|i| f[*i].clone()).collect::<Vec<_>>(), "motivo": motivo}));
                        }
                    }
                }
                self.paginas_aplicadas += 1;
                if self.cortar_tras.is_some_and(|n| self.paginas_aplicadas >= n) {
                    self.cortar_tras = None;
                    return None;
                }
                json!({"ok": true, "escritas": escritas, "iguales": filas.len() as u64 - escritas - no_entraron.len() as u64, "noEntraron": no_entraron})
            }
            "sobrantes" => {
                let (_, clave) = self.columnas(&tabla).await;
                let orden = clave.iter().map(|c| cita(c)).collect::<Vec<_>>().join(", ");
                let suyas: HashSet<String> = p["claves"].as_array().unwrap().iter().map(|k| k.to_string()).collect();
                let mut args = Vec::new();
                let mut donde = Vec::new();
                for (k, op) in [("desde", ">"), ("hasta", "<=")] {
                    if let Some(v) = p[k].as_array() {
                        let marcas: Vec<String> = v.iter().map(|x| {
                            args.push(a_valor(x));
                            format!("?{}", args.len())
                        }).collect();
                        donde.push(format!("({orden}) {op} ({})", marcas.join(", ")));
                    }
                }
                let donde = if donde.is_empty() { String::new() } else { format!(" WHERE {}", donde.join(" AND ")) };
                let sobran: Vec<Json> = self
                    .filas(&format!("SELECT {orden} FROM {}{donde} ORDER BY {orden};", cita(&tabla)), args)
                    .await
                    .into_iter()
                    .map(|f| Json::Array(f.iter().map(a_json).collect()))
                    .filter(|k| !suyas.contains(&k.to_string()))
                    .collect();
                json!({"ok": true, "sobran": sobran, "incompleto": false, "hastaSeq": self.hasta_seq})
            }
            "fin" => json!({"ok": true, "conteos": {}, "diferencias": 0}),
            otra => panic!("paso desconocido: {otra}"),
        })
    }

    /// Cuántas filas han viajado en páginas de filas (sin contar las listas vacías).
    pub fn filas_mandadas(&self) -> usize {
        self.pasos.iter().filter(|p| p["accion"] == "filas").map(|p| p["filas"].as_array().map_or(0, Vec::len)).sum()
    }
}

#[async_trait]
impl EnvioDeSubida for NubeDeSubida {
    async fn mandar(&mut self, paso: Json) -> AppResult<Option<Json>> {
        self.pasos.push(paso.clone());
        Ok(self.contestar(&paso).await)
    }
}
