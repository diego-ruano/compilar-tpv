//! La nube del contraste en los tests de punta a punta: contesta `/v1/sync/verificar/resumen`,
//! `/filas` y `/claves` como el worker (`apps/cloud-worker-licensing/src/domains/sync/verificar.ts`),
//! sobre una base SQLite con el esquema del negocio que hace de base de la nube.
//!
//! Resume con el mismo módulo que la Main (`tpv_domain::contraste`): lo que aquí se prueba es el
//! lado de la Main —qué pide, cómo compara, qué repara— contra una nube que se porta como la de
//! verdad. Que el worker resuma igual que la Main lo fijan la tabla de casos compartida
//! (`verificacion_casos.json`) y la foto de `tests/contract/contraste/`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value as JsonValue};

use tpv_application::error::{AppError, AppResult};
use tpv_domain::contraste::{self as cubos, Celda, Resumidor};
use tpv_infra_sqlite::db::Db;
use tpv_infra_sqlite::ejecutor::Value;

/// Las tablas de la base que no son del negocio, como `esTablaDeNegocio` en el worker.
const NO_SON_DEL_NEGOCIO: [&str; 4] = ["Sync_Changes", "Applied_Operations", "Sync_Main_Checkpoints", "Intentos_Login"];

/// El límite inferior de la ventana que dice el resumen. La ventana de cada tabla la pone
/// `ventanas`; esto sólo viaja de vuelta en las páginas de filas.
pub const DESDE: &str = "2026-10-14 12:00:00";

pub struct NubeDeContraste {
    pub db: Arc<Db>,
    dir: PathBuf,
    /// El final del log de la nube.
    pub hasta_seq: Mutex<i64>,
    /// El `Seq` del último cambio que no es de la Main. Si su checkpoint no llega, se aplaza
    /// (`por_delante`), como el DO.
    pub ultimo_ajeno: Mutex<i64>,
    /// La nube dice que ahora no (`actividad`).
    pub ocupada: Mutex<bool>,
    /// La sentencia de la ventana de cada tabla. Sin ella, la tabla entera.
    pub ventanas: Mutex<HashMap<String, (String, Vec<JsonValue>)>>,
    /// Sólo los conteos, como cuando la ventana no cabe.
    pub ventana_omitida: Mutex<bool>,
    /// Cuántos cubos lleva cada tabla. Sin él, los de `cubos_para`.
    pub cubos: Mutex<Option<u32>>,
    /// Lo que cabe en una página de filas y en una de claves.
    pub filas_por_pagina: Mutex<usize>,
    pub claves_por_pagina: Mutex<usize>,
    /// Otro `hasta_seq` para las páginas: la nube se ha movido desde el resumen.
    pub hasta_seq_de_las_paginas: Mutex<Option<i64>>,
    /// La sentencia que el resumen manda para una tabla, en vez de la de su ventana (una que no es
    /// una lectura, por ejemplo). Sólo cambia lo que viaja: lo que se resume es la ventana.
    pub sentencia_mandada: Mutex<HashMap<String, String>>,
    /// Lo que se ha pedido, con su cuerpo, y los informes de salud.
    pub pedidas: Mutex<Vec<(String, JsonValue)>>,
    pub informes: Mutex<Vec<JsonValue>>,
}

fn json_de(v: &Value) -> JsonValue {
    match v {
        Value::Null => JsonValue::Null,
        Value::Integer(n) => json!(n),
        Value::Real(x) => json!(x),
        Value::Text(t) => json!(t),
        Value::Blob(b) => json!({ "blob": b.iter().map(|x| format!("{x:02x}")).collect::<String>() }),
    }
}

fn celda(v: &Value) -> Celda<'_> {
    match v {
        Value::Null => Celda::Nulo,
        Value::Integer(n) => Celda::entero(*n),
        Value::Real(x) => Celda::Numero(*x),
        Value::Text(t) => Celda::Texto(t.as_bytes()),
        Value::Blob(b) => Celda::Blob(b),
    }
}

fn argumento(v: &JsonValue) -> Value {
    match v {
        JsonValue::String(s) => Value::Text(s.clone()),
        JsonValue::Number(n) => n.as_i64().map(Value::Integer).unwrap_or_else(|| Value::Real(n.as_f64().unwrap())),
        _ => Value::Null,
    }
}

fn hash_de(valores: &[&Value]) -> u64 {
    let mut bytes = Vec::new();
    for v in valores {
        cubos::escribir_canonico(&celda(v), &mut bytes);
    }
    cubos::fnv1a64(&bytes)
}

impl NubeDeContraste {
    pub async fn nueva(nombre: &str) -> Self {
        let marca = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir()
            .join("tpv_tests")
            .join(format!("nube-{nombre}-{}-{marca}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(dir.join("nube.db").to_str().unwrap()).await.unwrap();
        Self {
            db,
            dir,
            hasta_seq: Mutex::new(0),
            ultimo_ajeno: Mutex::new(0),
            ocupada: Mutex::new(false),
            ventanas: Mutex::new(HashMap::new()),
            ventana_omitida: Mutex::new(false),
            cubos: Mutex::new(None),
            filas_por_pagina: Mutex::new(10_000),
            claves_por_pagina: Mutex::new(10_000),
            hasta_seq_de_las_paginas: Mutex::new(None),
            sentencia_mandada: Mutex::new(HashMap::new()),
            pedidas: Mutex::new(Vec::new()),
            informes: Mutex::new(Vec::new()),
        }
    }

    pub async fn cerrar(self) {
        let _ = self.db.cerrar().await;
        drop(self.db);
        let _ = std::fs::remove_dir_all(&self.dir);
    }

    /// Escribe en la base de la nube, sin pasar por ningún outbox.
    pub async fn sembrar(&self, sql: &str) {
        let w = self.db.write().await;
        w.raw().execute_batch(sql).await.unwrap();
    }

    /// Aplica a la base de la nube lo que la Main ha encolado para repararla, como el DO.
    pub async fn aplicar(&self, sentencias: &[tpv_contracts::sync::SqlStatement]) {
        let w = self.db.write().await;
        let conn = w.raw();
        conn.execute_batch("PRAGMA defer_foreign_keys = ON; BEGIN;").await.unwrap();
        for s in sentencias {
            conn.execute(&s.sql, s.args.iter().map(argumento).collect::<Vec<_>>()).await.unwrap();
        }
        conn.execute_batch("COMMIT;").await.unwrap();
    }

    pub fn rutas_pedidas(&self) -> Vec<String> {
        self.pedidas.lock().unwrap().iter().map(|(r, _)| r.clone()).collect()
    }

    async fn filas(&self, sql: &str, args: Vec<Value>, ancho: usize) -> Vec<Vec<Value>> {
        let r = self.db.read().await;
        let mut filas = r.conn().query(sql, args).await.unwrap();
        let mut salida = Vec::new();
        while let Some(f) = filas.next().await.unwrap() {
            salida.push((0..ancho).map(|i| f.get_value(i as i32).unwrap()).collect());
        }
        salida
    }

    async fn tablas(&self) -> Vec<String> {
        self.filas(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\' \
             AND name NOT LIKE 'sqlite_%' ORDER BY name;",
            vec![],
            1,
        )
        .await
        .into_iter()
        .filter_map(|f| match &f[0] {
            Value::Text(t) if !NO_SON_DEL_NEGOCIO.contains(&t.as_str()) => Some(t.clone()),
            _ => None,
        })
        .collect()
    }

    async fn columnas(&self, tabla: &str) -> (Vec<String>, Vec<String>) {
        let filas = self
            .filas("SELECT name, pk FROM pragma_table_info(?1) ORDER BY cid;", vec![Value::Text(tabla.into())], 2)
            .await;
        let columnas = filas.iter().map(|f| match &f[0] { Value::Text(t) => t.clone(), _ => String::new() }).collect();
        let mut claves: Vec<(i64, String)> = filas
            .iter()
            .filter_map(|f| match (&f[0], &f[1]) {
                (Value::Text(t), Value::Integer(pk)) if *pk > 0 => Some((*pk, t.clone())),
                _ => None,
            })
            .collect();
        claves.sort();
        (columnas, claves.into_iter().map(|(_, c)| c).collect())
    }

    fn ventana(&self, tabla: &str) -> (String, Vec<JsonValue>) {
        self.ventanas
            .lock()
            .unwrap()
            .get(tabla)
            .cloned()
            .unwrap_or_else(|| (format!("SELECT * FROM \"{tabla}\";"), vec![]))
    }

    /// Las filas de la ventana de una tabla, con las posiciones de su clave.
    async fn ventana_de(&self, tabla: &str) -> (Vec<String>, Vec<String>, Vec<usize>, Vec<Vec<Value>>) {
        let (columnas, claves) = self.columnas(tabla).await;
        let posiciones = claves.iter().map(|k| columnas.iter().position(|c| c == k).unwrap()).collect();
        let (sql, args) = self.ventana(tabla);
        let filas = self.filas(&sql, args.iter().map(argumento).collect(), columnas.len()).await;
        (columnas, claves, posiciones, filas)
    }

    fn hasta_seq_pagina(&self) -> i64 {
        self.hasta_seq_de_las_paginas.lock().unwrap().unwrap_or(*self.hasta_seq.lock().unwrap())
    }

    /// La respuesta a `ruta`, si es del contraste o el informe de salud.
    pub async fn contestar(&self, ruta: &str, cuerpo: &JsonValue) -> Option<AppResult<JsonValue>> {
        if !ruta.starts_with("/v1/sync/verificar/") && ruta != "/v1/sync/salud" {
            return None;
        }
        self.pedidas.lock().unwrap().push((ruta.to_string(), cuerpo.clone()));
        Some(Ok(match ruta {
            "/v1/sync/verificar/resumen" => self.resumen(cuerpo).await,
            "/v1/sync/verificar/filas" => self.pagina_de_filas(cuerpo).await,
            "/v1/sync/verificar/por-clave" => self.filas_por_clave(cuerpo).await,
            "/v1/sync/verificar/claves" => self.pagina_de_claves(cuerpo).await,
            "/v1/sync/salud" => {
                self.informes.lock().unwrap().push(cuerpo.clone());
                json!({ "ok": true })
            }
            otra => return Some(Err(AppError::external(format!("ruta no prevista: {otra}")))),
        }))
    }

    async fn resumen(&self, cuerpo: &JsonValue) -> JsonValue {
        let hasta_seq = *self.hasta_seq.lock().unwrap();
        let checkpoint = cuerpo["checkpoint"].as_i64();
        if *self.ocupada.lock().unwrap() {
            return json!({ "ok": true, "aplazar": true, "motivo": "actividad", "reintentar_en_s": 90, "hasta_seq": hasta_seq });
        }
        if checkpoint.unwrap_or(0) < *self.ultimo_ajeno.lock().unwrap() {
            return json!({ "ok": true, "aplazar": true, "motivo": "por_delante", "reintentar_en_s": 60, "hasta_seq": hasta_seq });
        }

        let omitida = *self.ventana_omitida.lock().unwrap();
        let mut tablas = Vec::new();
        for tabla in self.tablas().await {
            let total = match self.filas(&format!("SELECT COUNT(*) FROM \"{tabla}\";"), vec![], 1).await[0][0] {
                Value::Integer(n) => n,
                _ => 0,
            };
            if omitida {
                tablas.push(json!({ "nombre": tabla, "total": total }));
                continue;
            }
            let (columnas, claves, posiciones, filas) = self.ventana_de(&tabla).await;
            let n_cubos = self.cubos.lock().unwrap().unwrap_or_else(|| cubos::cubos_para(filas.len() as u64));
            let mut resumidor = Resumidor::nuevo(n_cubos).unwrap();
            if !claves.is_empty() {
                for f in &filas {
                    let celdas: Vec<Celda<'_>> = f.iter().map(celda).collect();
                    resumidor.fila(&celdas, &posiciones).unwrap();
                }
            }
            let r = resumidor.fin();
            let (sql, args) = self.ventana(&tabla);
            let sql = self.sentencia_mandada.lock().unwrap().get(&tabla).cloned().unwrap_or(sql);
            tablas.push(json!({
                "nombre": tabla, "total": total, "sql": sql, "args": args, "columnas": columnas,
                "claves": claves, "filas": filas.len(), "cubos": n_cubos,
                "cuentas": r.cuentas, "sumas": r.sumas.iter().map(|s| cubos::hex64(*s)).collect::<Vec<_>>(),
            }));
        }
        json!({
            "ok": true, "aplazar": false, "checkpoint": checkpoint, "hasta_seq": hasta_seq, "desde": DESDE,
            "ventana_omitida": omitida, "tablas": tablas,
        })
    }

    async fn pagina_de_filas(&self, cuerpo: &JsonValue) -> JsonValue {
        let tabla = cuerpo["tabla"].as_str().unwrap().to_string();
        let n_cubos = cuerpo["cubos"].as_u64().unwrap() as u32;
        let pedir: Vec<u32> = cuerpo["pedir"].as_array().unwrap().iter().map(|c| c.as_u64().unwrap() as u32).collect();
        let cursor = cuerpo["cursor"].as_u64().unwrap_or(0) as usize;
        let por_pagina = *self.filas_por_pagina.lock().unwrap();

        let (columnas, claves, posiciones, filas) = self.ventana_de(&tabla).await;
        let mut salida = Vec::new();
        let mut siguiente = JsonValue::Null;
        if !claves.is_empty() {
            for (i, f) in filas.iter().enumerate().skip(cursor) {
                let clave: Vec<&Value> = posiciones.iter().map(|p| &f[*p]).collect();
                if !pedir.contains(&cubos::cubo_de(hash_de(&clave), n_cubos)) {
                    continue;
                }
                if salida.len() == por_pagina {
                    siguiente = json!(i);
                    break;
                }
                salida.push(f.iter().map(json_de).collect::<Vec<_>>());
            }
        }
        json!({
            "ok": true, "tabla": tabla, "columnas": columnas, "filas": salida,
            "siguiente_cursor": siguiente, "hasta_seq": self.hasta_seq_pagina(),
        })
    }

    async fn filas_por_clave(&self, cuerpo: &JsonValue) -> JsonValue {
        let tabla = cuerpo["tabla"].as_str().unwrap().to_string();
        let (columnas, claves) = self.columnas(&tabla).await;
        let donde = claves.iter().enumerate().map(|(i, c)| format!("\"{c}\" = ?{}", i + 1)).collect::<Vec<_>>().join(" AND ");
        let mut filas = Vec::new();
        for clave in cuerpo["claves"].as_array().unwrap() {
            let args: Vec<Value> = clave.as_array().unwrap().iter().map(argumento).collect();
            let sql = format!("SELECT * FROM \"{tabla}\" WHERE {donde};");
            for f in self.filas(&sql, args, columnas.len()).await {
                filas.push(f.iter().map(json_de).collect::<Vec<_>>());
            }
        }
        json!({
            "ok": true, "tabla": tabla, "columnas": columnas, "filas": filas, "cortada": false,
            "hasta_seq": self.hasta_seq_pagina(),
        })
    }

    async fn pagina_de_claves(&self, cuerpo: &JsonValue) -> JsonValue {
        let tabla = cuerpo["tabla"].as_str().unwrap().to_string();
        let limite = *self.claves_por_pagina.lock().unwrap();
        let (_, claves) = self.columnas(&tabla).await;
        let lista = claves.iter().map(|c| format!("\"{c}\"")).collect::<Vec<_>>().join(", ");
        let cursor: Vec<JsonValue> = cuerpo["cursor"].as_array().cloned().unwrap_or_default();
        let donde = if cursor.is_empty() {
            String::new()
        } else {
            format!(" WHERE ({lista}) > ({})", (1..=cursor.len()).map(|i| format!("?{i}")).collect::<Vec<_>>().join(", "))
        };
        let mut args: Vec<Value> = cursor.iter().map(argumento).collect();
        args.push(Value::Integer(limite as i64));
        let sql = format!("SELECT {lista} FROM \"{tabla}\"{donde} ORDER BY {lista} LIMIT ?{};", args.len());
        let filas: Vec<Vec<JsonValue>> =
            self.filas(&sql, args, claves.len()).await.iter().map(|f| f.iter().map(json_de).collect()).collect();
        let siguiente = if filas.len() == limite { json!(filas.last().unwrap()) } else { JsonValue::Null };
        json!({
            "ok": true, "tabla": tabla, "columnas": claves, "claves": filas,
            "siguiente_cursor": siguiente, "hasta_seq": self.hasta_seq_pagina(),
        })
    }
}

/// Las páginas del contraste servidas por esta nube, para llamar al repositorio sin el caso de uso.
pub struct Paginas<'a>(pub &'a NubeDeContraste);

#[async_trait::async_trait]
impl tpv_application::ports::sync::PaginasDelContraste for Paginas<'_> {
    async fn filas(&self, p: tpv_application::ports::sync::PedidoDeFilas) -> AppResult<tpv_contracts::sync::FilasDeCubos> {
        let cuerpo = json!({ "tabla": p.tabla, "desde": p.desde, "cubos": p.cubos, "pedir": p.pedir, "cursor": p.cursor });
        let r = self.0.contestar("/v1/sync/verificar/filas", &cuerpo).await.unwrap()?;
        Ok(serde_json::from_value(r).unwrap())
    }
    async fn por_clave(&self, p: tpv_application::ports::sync::PedidoPorClave) -> AppResult<tpv_contracts::sync::FilasPorClave> {
        let cuerpo = json!({ "tabla": p.tabla, "claves": p.claves });
        let r = self.0.contestar("/v1/sync/verificar/por-clave", &cuerpo).await.unwrap()?;
        Ok(serde_json::from_value(r).unwrap())
    }
    async fn claves(&self, p: tpv_application::ports::sync::PedidoDeClaves) -> AppResult<tpv_contracts::sync::ClavesPagina> {
        let cuerpo = json!({ "tabla": p.tabla, "cursor": p.cursor });
        let r = self.0.contestar("/v1/sync/verificar/claves", &cuerpo).await.unwrap()?;
        Ok(serde_json::from_value(r).unwrap())
    }
}

impl NubeDeContraste {
    /// El resumen, ya leído, para quien llama al repositorio directamente.
    pub async fn resumen_para(&self, checkpoint: i64) -> tpv_contracts::sync::ResumenNube {
        let r = self.contestar("/v1/sync/verificar/resumen", &json!({ "checkpoint": checkpoint })).await.unwrap().unwrap();
        serde_json::from_value(r).unwrap()
    }
}
