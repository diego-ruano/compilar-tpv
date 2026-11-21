//! DO-SUBIDA · La Main sube su base entera a una nube devuelta en modo «main»: el lado de la Main.
//!
//! Soporte le ha dado al negocio una base vacía, su copia de R2 o ha devuelto la suya a un instante,
//! con `--modo main`. El `TenantHub` apunta una petición de subida completa y se la dice a esta Main
//! en su `hello_ok` (`tenantHub.subida.ts`). Aquí está lo que la Main hace con ella, sin escribir
//! nunca en su outbox ni en sus tablas de negocio: todo va por `raw()` a sus tablas `_Sync_Subida*`
//! (`0005_subida_completa.sql`) y, hacia la nube, por pasos que llevan datos y no SQL.
//!
//! # Las etapas
//!
//! Con el `plan` que contesta la nube (sus tablas, sus columnas, la sentencia de la ventana de una
//! recuperación de cada una, las claves de lo que allí sigue vivo y dónde empieza su log nuevo) se
//! siembra una entrada por tabla
//! y fase, en este orden (`Turno`):
//!
//! 0. **Lo vivo de la nube** (fase 0): las comandas abiertas, el último cierre, los pedidos en
//!    borrador… que tiene la copia. De cada clave se sube la versión de aquí; la que aquí ya no
//!    está se pide borrar por el outbox (`pedir_borrados`), al acabar la etapa y hijas primero, y
//!    sólo si en la nube no ha escrito nadie más que esta Main desde el plan.
//! 1. **El núcleo** (fase 1 de la carta, las mesas, el personal y los ajustes, y lo vivo de las
//!    comandas, con todo lo que apuntan sus foráneas): lo que las Handy necesitan para trabajar.
//!    Hasta que está, siguen retenidas.
//! 2. **Lo imprescindible** del resto (fase 1).
//! 3. **Lo que sobra arriba en los maestros** (fase 4): las claves que la nube tiene y aquí no, por
//!    el outbox, como la fase 0 (y nunca lo que toca una cuarentena de bajada).
//! 4. **Los últimos días** (fase 2, la ventana de la recuperación).
//! 5. **El histórico entero** (fase 3), recorriendo cada tabla transaccional por su clave.
//!
//! Lo que la nube no deja entrar por un único o una foránea que dependía de algo que todavía no había
//! subido se vuelve a intentar al pasar de una etapa a la siguiente (`repaso`), y al final hasta
//! `MAX_REPASOS` veces más. Después, `fin`. La nube la da entonces por terminada, y aquí queda
//! `contrastando` hasta que una pasada del contraste (`verificar_nube`) sale limpia
//! (`tras_el_contraste`).
//!
//! # Qué viaja
//!
//! Lo que es igual no se reenvía: con una copia o un instante casi todo está ya arriba. El histórico
//! se compara por **tramos** (la suma de las huellas de 100 filas seguidas), los tramos distintos
//! por **huellas** de cada fila y sólo lo distinto viaja como **filas**. Con una base vacía, filas
//! directamente. La huella es la forma canónica del contraste (`tpv_domain::contraste`), la misma
//! que calcula el worker.
//!
//! # Lo que no se sube
//!
//! - Las filas que toca un cambio de la nube que no ha entrado aquí (`_Sync_Failed`, SYNC-36): las
//!   de la nube son las buenas y aquí están por detrás. Ni se suben ni se piden borrar arriba.
//! - Si de ese cambio no se sabe qué filas toca, sus tablas (en las que escriben sus sentencias; si
//!   ni eso se sabe, todas) dependen de si el cambio puede seguir arriba (`perdida_con_la_base`). Lo
//!   mismo las de una cuarentena `dudosa` que sacó de esta base por un filtro: sus filas pudieron no
//!   ser las de la nube.
//!   - Con una copia o un instante (la base devuelta puede ser posterior al cambio), o si el cambio
//!     es del log nuevo (por encima del cambio vacío con que la nube lo abrió al volver, el
//!     `inicioSeq` del plan: se escribió en la nube devuelta), la tabla entera se deja para el
//!     contraste y queda fallida: lo que aquí está y arriba falta puede ser justo lo que borró, y
//!     subirlo lo resucitaba sin que el contraste viera ya ninguna diferencia. Igual si el plan no
//!     dice dónde empieza el log nuevo (un worker anterior).
//!   - Con una base vacía y un cambio del log de antes, el cambio se perdió con la base: de esas
//!     tablas (**inciertas**) sólo sube lo que falta arriba, por las huellas, sin pisar nunca una
//!     fila que ya está (la escribió alguien en la nube devuelta), y no se pide borrar nada (ni lo
//!     vivo ni los sobrantes). En lo vivo (etapa 0) eso es nada: sus claves salen de la nube y ya
//!     están todas arriba. Lo que difiere lo ve el contraste. La tabla acaba como cualquier otra.
//! - Las filas apuntadas por el orden de la nube (SYNC-29): la nube ya tiene su versión y la
//!   convergencia la trae. Sólo se suben si arriba faltan.
//! - Un blob o una fila que no cabe en una página: se apunta y lo ve el contraste.
//!
//! El repaso aparta lo mismo que una página.
//!
//! # Los rechazos
//!
//! Uno pasajero espera 30 s. Uno permanente deja la tabla para el contraste (el del plan o el `fin`,
//! la subida). Uno sin clasificar espera 30 s, el doble con cada uno seguido hasta 30 min
//! (`espera_tras`, con la cuenta en `_Sync_Subida.Rechazos_Seguidos`), y vuelve a 30 s en cuanto un
//! paso se confirma; el plan y el `fin` no se abandonan por eso, y una página, a los `MAX_INTENTOS`,
//! deja su tabla sin esperar más pero sin poner la cuenta a cero: si la siguiente también falla a la
//! primera, la nube tiene un fallo de todas y la espera sigue creciendo. En el repaso, uno permanente
//! o sin clasificar gasta un intento de lo que mandaba.
//!
//! # El cobro no se toca
//!
//! Las lecturas van por conexiones de lectura (`foto`), el escritor sólo se coge para
//! transacciones cortas por `raw()`, y nada escribe en tablas de negocio.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{json, Value as Json};

use tpv_application::error::AppResult;
use tpv_application::ports::subida_completa::{
    Conciliacion, EnvioDeSubida, PasoHecho, PeticionDeSubida, SubidaCompleta,
};
use tpv_contracts::sync::{SqlStatement, SubidaNubeEstado};
use tpv_domain::contraste::{self as cubos, Celda};

use crate::consultas::db_err;
use crate::db::{Db, Writer};
use crate::ejecutor::{Connection, ErrorSql, Foto, ValorPrestado, Value};
use crate::filas_tocadas::{canonica_de, FilaTocada, Tocadas};
use crate::sync_reparacion::FilaAfectada;
use crate::util::now_ms;

/// Filas por página con el bar tranquilo, y con actividad.
const FILAS_CON_CALMA: usize = 2_000;
const FILAS_CON_ACTIVIDAD: usize = 500;
/// Lo menos que lleva una página partida por no caber (`subida_pagina_demasiado_grande`).
const FILAS_MINIMAS: usize = 50;
/// Lo que ocupan como mucho, en JSON, las filas de una página. La nube admite 1,5 MiB.
const BYTES_POR_PAGINA: usize = 1024 * 1024;
/// Filas por tramo al comparar el histórico.
const FILAS_POR_TRAMO: usize = 100;
/// Tramos por paso: lo que la nube admite (`TRAMOS_POR_PASO`).
const TRAMOS_POR_PASO: usize = 200;
/// Claves por paso de sobrantes (`CLAVES_POR_SOBRANTES` en la nube).
const CLAVES_POR_SOBRANTES: usize = 20_000;
/// Sin escrituras de aquí ni de la nube en este tiempo, el bar está tranquilo.
const CALMA_MS: i64 = 3 * 60 * 1000;
/// Rechazos sin clasificar de una tabla antes de dejarla como fallida.
const MAX_INTENTOS: i64 = 5;
/// Lo que se espera tras un rechazo pasajero, y tras el primero sin clasificar.
const ESPERA_PASAJERA: Duration = Duration::from_secs(30);
/// Lo más que se espera tras rechazos sin clasificar seguidos.
const ESPERA_MAXIMA: Duration = Duration::from_secs(30 * 60);
/// Veces que el repaso intenta lo que no entró.
const MAX_REPASOS: i64 = 3;
/// Sentencias por operación al pedir borrados por el outbox (como el contraste).
const BORRADOS_POR_OPERACION: usize = 500;

/// Las tablas del núcleo: lo que las Handy necesitan para trabajar. Con las de las comandas vivas.
const NUCLEO: &[&str] = &[
    "Business_Settings",
    "Ticket_Settings",
    "Contact_Settings",
    "Roles",
    "Roles_Permisos",
    "Usuarios",
    "Trabajadores",
    "Zonas",
    "Mesas",
    "Categorias_Producto",
    "Productos",
    "Alergenos",
    "Producto_Alergenos",
    "Categorias_Ingrediente",
    "Ingredientes",
    "Producto_Ingredientes",
    "Lotes_Producto",
    "Comandas",
    "Detalle_Comanda",
    "Pagos",
    "Pago_Detalles",
];

/// Los turnos, en orden.
const TURNO_VIVOS: i64 = 0;
const TURNO_NUCLEO: i64 = 1;
const TURNO_IMPRESCINDIBLE: i64 = 2;
const TURNO_SOBRANTES: i64 = 3;
const TURNO_RECIENTE: i64 = 4;
const TURNO_HISTORICO: i64 = 5;

/// La subida de esta Main, sobre su base. Se crea cada vez que se usa: no retiene la base entre
/// paso y paso (restaurar una copia en Windows necesita que nadie la tenga abierta).
pub struct SqliteSubidaCompleta {
    db: Arc<Db>,
}

/// Lo que se ha aprendido en este proceso y no hace falta recordar: filas por página tras una que no
/// cabía, y las tablas en las que conviene mandar las filas sin comparar antes. Vive lo que el
/// proceso; si se pierde, se vuelve a aprender.
static RITMO: Mutex<Option<Ritmo>> = Mutex::new(None);

#[derive(Default)]
struct Ritmo {
    /// Tope de filas por página, si una no cupo.
    tope: Option<usize>,
    /// (tabla, fase) en las que la mayoría difería: se mandan las filas sin comparar.
    directas: HashSet<(String, i64)>,
}

impl SqliteSubidaCompleta {
    pub fn new(db: Arc<Db>) -> Self {
        Self { db }
    }

    fn con_ritmo<T>(&self, f: impl FnOnce(&mut Ritmo) -> T) -> T {
        con_ritmo(f)
    }
}

fn con_ritmo<T>(f: impl FnOnce(&mut Ritmo) -> T) -> T {
    f(RITMO.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(Ritmo::default))
}

/* ===== Lo guardado ===== */

/// La fila de `_Sync_Subida`.
#[derive(Debug, Clone)]
pub(crate) struct Local {
    pub id: String,
    pub origen: String,
    pub estado: String,
    pub desde_imprescindible: Option<String>,
    pub desde_reciente: Option<String>,
    pub hasta_seq_plan: i64,
    pub nucleo_hecho: bool,
    /// Este equipo, como lo nombra el log de la nube (lo dice el plan).
    pub dispositivo: Option<String>,
}

fn texto(v: &Value) -> Option<String> {
    match v {
        Value::Text(t) => Some(t.clone()),
        _ => None,
    }
}

fn entero(v: &Value) -> i64 {
    match v {
        Value::Integer(n) => *n,
        Value::Real(x) => *x as i64,
        _ => 0,
    }
}

async fn filas(conn: &Connection, sql: &str, args: Vec<Value>) -> AppResult<Vec<Vec<Value>>> {
    let sql = sql.to_string();
    conn.foto(move |f| f.filas(&sql, &args)).await.map_err(db_err)
}

pub(crate) async fn local(conn: &Connection) -> AppResult<Option<Local>> {
    let f = filas(
        conn,
        "SELECT Id_Subida, Origen, Estado, Desde_Imprescindible, Desde_Reciente, COALESCE(Hasta_Seq_Plan, 0), \
                Nucleo_Hecho_Ms IS NOT NULL, Dispositivo FROM _Sync_Subida WHERE Id = 1;",
        vec![],
    )
    .await?;
    Ok(f.into_iter().next().map(|f| Local {
        id: texto(&f[0]).unwrap_or_default(),
        origen: texto(&f[1]).unwrap_or_default(),
        estado: texto(&f[2]).unwrap_or_default(),
        desde_imprescindible: texto(&f[3]),
        desde_reciente: texto(&f[4]),
        hasta_seq_plan: entero(&f[5]),
        nucleo_hecho: entero(&f[6]) != 0,
        dispositivo: texto(&f[7]),
    }))
}

/// ¿Hay una subida a medias (sin entregar a la nube)? La convergencia (SYNC-29) no borra aquí lo que
/// falta arriba mientras tanto: puede faltar porque la nube lo perdió, y la subida lo devuelve.
pub(crate) async fn subiendo(conn: &Connection) -> AppResult<bool> {
    Ok(local(conn).await?.is_some_and(|l| l.estado == "subiendo"))
}

/// Vacía todo lo de la subida (traer la nube, restaurar una copia local). Vale dentro de una
/// transacción. Si había una a medias, se avisa: lo que quedaba por subir se queda sin subir.
pub(crate) async fn vaciar(conn: &Connection) -> AppResult<()> {
    let mut f = conn
        .query("SELECT COUNT(*) FROM _Sync_Subida WHERE Estado IN ('subiendo', 'contrastando');", ())
        .await
        .map_err(db_err)?;
    let a_medias = match f.next().await.map_err(db_err)? {
        Some(fila) => fila.get::<i64>(0).map_err(db_err)? > 0,
        None => false,
    };
    drop(f);
    for sql in [
        "DELETE FROM _Sync_Subida_Claves;",
        "DELETE FROM _Sync_Subida_Tablas;",
        "DELETE FROM _Sync_Subida_Por_Revisar;",
        "DELETE FROM _Sync_Subida_Por_Borrar;",
        "DELETE FROM _Sync_Subida;",
    ] {
        conn.execute(sql, ()).await.map_err(db_err)?;
    }
    if a_medias {
        tracing::error!(target: "tpv::sync", evento = "subida_abandonada", "DO-SUBIDA: la base se sustituye con la subida completa a medias");
    }
    Ok(())
}

/// Lo que se apunta de una subida que se deja. Sin la subida, nada.
pub(crate) async fn abandonar_en(conn: &Connection, motivo: &str) -> AppResult<bool> {
    let n = conn
        .execute(
            "UPDATE _Sync_Subida SET Estado = 'abandonada', Ultimo_Error = ?1 \
             WHERE Id = 1 AND Estado IN ('subiendo', 'contrastando');",
            vec![Value::Text(motivo.chars().take(200).collect())],
        )
        .await
        .map_err(db_err)?;
    if n > 0 {
        tracing::error!(target: "tpv::sync", evento = "subida_abandonada", motivo, "DO-SUBIDA: se deja la subida completa a medias");
    }
    Ok(n > 0)
}

/// Lo que ha dado una pasada del contraste con la subida por confirmar: limpia, la subida queda
/// terminada; con diferencias, a la tercera pasada que llega a comparar también, y se avisa.
pub(crate) async fn tras_el_contraste(db: &Db, limpia: bool) -> AppResult<()> {
    let w = db.write().await;
    let conn = w.raw();
    let Some(pasadas) = filas(conn, "SELECT Pasadas_Contraste FROM _Sync_Subida WHERE Id = 1 AND Estado = 'contrastando';", vec![])
        .await?
        .into_iter()
        .next()
        .map(|f| entero(&f[0]) + 1)
    else {
        return Ok(());
    };
    let terminar = limpia || pasadas >= 3;
    conn.execute(
        "UPDATE _Sync_Subida SET Pasadas_Contraste = ?1, \
           Estado = CASE WHEN ?2 THEN 'terminada' ELSE Estado END, \
           Terminada_Ms = CASE WHEN ?2 THEN ?3 ELSE Terminada_Ms END \
         WHERE Id = 1;",
        vec![Value::Integer(pasadas), Value::Integer(terminar as i64), Value::Integer(now_ms())],
    )
    .await
    .map_err(db_err)?;
    if limpia {
        tracing::info!(target: "tpv::sync", evento = "subida_completa_confirmada", pasadas, "DO-SUBIDA: el contraste confirma la subida completa");
    } else if terminar {
        tracing::error!(target: "tpv::sync", evento = "subida_con_diferencias", pasadas, "DO-SUBIDA: tras tres pasadas del contraste la nube sigue sin cuadrar");
    }
    Ok(())
}

/// Lo que enseña Configuración → Conectividad.
pub async fn estado_para_la_pantalla(db: &Db) -> AppResult<Option<SubidaNubeEstado>> {
    let r = db.read().await;
    let conn = r.conn();
    let Some(l) = local(conn).await? else { return Ok(None) };
    if l.estado == "terminada" || l.estado == "abandonada" {
        return Ok(None);
    }
    let f = filas(
        conn,
        "SELECT COALESCE(MIN(CASE WHEN Estado = 0 THEN Turno END), -1), \
                COALESCE(SUM(Filas_Leidas), 0), COALESCE(SUM(Total), 0), \
                COALESCE(SUM(Estado = 0), 0), \
                (SELECT COUNT(*) FROM _Sync_Subida_Por_Revisar), \
                (SELECT Ultimo_Error IS NOT NULL FROM _Sync_Subida WHERE Id = 1), \
                (SELECT COUNT(DISTINCT Tabla) FROM _Sync_Subida_Tablas WHERE Estado = 2) \
           FROM _Sync_Subida_Tablas;",
        vec![],
    )
    .await?;
    let f = f.into_iter().next().unwrap_or_default();
    let turno = f.first().map(entero).unwrap_or(-1);
    let fase = if l.estado == "contrastando" {
        "contrastando"
    } else if l.desde_imprescindible.is_none() {
        "empezando"
    } else {
        match turno {
            TURNO_VIVOS => "vivos",
            TURNO_NUCLEO | TURNO_IMPRESCINDIBLE | TURNO_SOBRANTES => "imprescindible",
            TURNO_RECIENTE => "reciente",
            TURNO_HISTORICO => "historico",
            _ => "revisando",
        }
    };
    Ok(Some(SubidaNubeEstado {
        estado: l.estado,
        fase: fase.into(),
        filas_leidas: f.get(1).map(entero).unwrap_or(0),
        filas_total: f.get(2).map(entero).unwrap_or(0),
        tablas_pendientes: f.get(3).map(entero).unwrap_or(0),
        filas_por_revisar: f.get(4).map(entero).unwrap_or(0),
        reintentando: f.get(5).map(entero).unwrap_or(0) != 0,
        tablas_fallidas: f.get(6).map(entero).unwrap_or(0),
    }))
}

/* ===== El plan ===== */

/// Una entrada de `_Sync_Subida_Tablas`.
#[derive(Debug, Clone)]
struct Entrada {
    tabla: String,
    fase: i64,
    turno: i64,
    sql: Option<String>,
    parametrizada: bool,
    columnas: Vec<String>,
    clave: Vec<String>,
    /// `upsert`, `solo_insertar` o `monotono`: lo dice la nube en el plan.
    politica: &'static str,
    por_clave: bool,
    claves_fijadas: bool,
    cursor: Option<Vec<Json>>,
    /// Su sitio entre las tablas, padres primero.
    orden: i64,
}

/// Las columnas de una tabla y las de su clave primaria, en orden.
type ColumnasYClave = (Vec<String>, Vec<String>);

/// Las tablas de negocio de esta base, con sus columnas y su clave.
fn esquema_local(foto: &Foto<'_>) -> Result<HashMap<String, ColumnasYClave>, ErrorSql> {
    let mut out = HashMap::new();
    for f in foto.filas("SELECT name FROM sqlite_master WHERE type = 'table';", &[])? {
        let Some(Value::Text(t)) = f.into_iter().next() else { continue };
        if crate::sync::no_es_tabla_de_negocio(&t) {
            continue;
        }
        let mut columnas = Vec::new();
        let mut clave: Vec<(i64, String)> = Vec::new();
        for c in foto.filas("SELECT name, pk FROM pragma_table_info(?1) ORDER BY cid;", &[Value::Text(t.clone())])? {
            let nombre = texto(&c[0]).unwrap_or_default();
            if entero(&c[1]) > 0 {
                clave.push((entero(&c[1]), nombre.clone()));
            }
            columnas.push(nombre);
        }
        clave.sort();
        out.insert(t, (columnas, clave.into_iter().map(|(_, c)| c).collect()));
    }
    Ok(out)
}

fn cita(n: &str) -> String {
    format!("\"{}\"", n.replace('"', "\"\""))
}

fn nombre_aceptable(n: &str) -> bool {
    !n.is_empty() && n.len() <= 64 && n.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') && !n.starts_with('_')
}

/// DO-SUBIDA · Las tablas del núcleo con todas las que apuntan sus claves foráneas, hasta cerrar:
/// un producto con su proveedor o una comanda abierta con su cliente o su reserva no entran arriba
/// sin ellos, y las Handy no se sueltan hasta que el núcleo está.
fn nucleo_con_sus_padres(con_padres: &[(String, HashSet<String>)]) -> HashSet<String> {
    let padres: HashMap<&str, &HashSet<String>> = con_padres.iter().map(|(t, p)| (t.as_str(), p)).collect();
    let mut nucleo: HashSet<String> = NUCLEO.iter().map(|t| t.to_string()).collect();
    let mut por_mirar: Vec<String> = nucleo.iter().cloned().collect();
    while let Some(t) = por_mirar.pop() {
        for p in padres.get(t.as_str()).map(|p| p.iter()).into_iter().flatten() {
            if nucleo.insert(p.clone()) {
                por_mirar.push(p.clone());
            }
        }
    }
    nucleo
}

/// Siembra el plan que ha contestado la nube. Todo en una transacción por `raw()`.
async fn sembrar(db: &Db, plan: &Json, ventana_dias: i64) -> AppResult<()> {
    let r = db.read().await;
    let esquema = r.conn().foto(esquema_local).await.map_err(db_err)?;
    let nombres: Vec<String> = esquema.keys().cloned().collect();
    let con_padres = r.conn().foto(move |f| crate::contraste::padres_primero(f, &nombres)).await.map_err(db_err)?;
    drop(r);
    let nucleo = nucleo_con_sus_padres(&con_padres);
    let orden_padres: Vec<String> = con_padres.into_iter().map(|(t, _)| t).collect();
    let posicion = |t: &str| orden_padres.iter().position(|x| x == t).unwrap_or(usize::MAX) as i64;

    let tablas = plan.get("tablas").and_then(Json::as_array).cloned().unwrap_or_default();
    let vivos = plan.get("vivos").and_then(Json::as_object).cloned().unwrap_or_default();
    let mut entradas: Vec<(Entrada, i64)> = Vec::new();
    let mut claves_vivas: Vec<(String, Vec<Json>)> = Vec::new();
    for t in &tablas {
        let Some(tabla) = t.get("tabla").and_then(Json::as_str).filter(|n| nombre_aceptable(n)) else { continue };
        let Some((locales, clave_local)) = esquema.get(tabla) else {
            tracing::warn!(target: "tpv::sync", tabla, "DO-SUBIDA: la nube tiene una tabla que aquí no existe");
            continue;
        };
        let de_la_nube: Vec<String> =
            t.get("columnas").and_then(Json::as_array).map(|c| c.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect()).unwrap_or_default();
        let clave_nube: Vec<String> =
            t.get("clave").and_then(Json::as_array).map(|c| c.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect()).unwrap_or_default();
        if clave_nube.is_empty() || &clave_nube != clave_local {
            tracing::warn!(target: "tpv::sync", tabla, "DO-SUBIDA: la clave de la tabla no es la misma arriba: se deja para el contraste");
            continue;
        }
        // Las columnas que tienen los dos lados, en el orden de aquí.
        let columnas: Vec<String> = locales.iter().filter(|c| de_la_nube.contains(c)).cloned().collect();
        if columnas.len() < locales.len() {
            tracing::warn!(target: "tpv::sync", evento = "subida_columnas_omitidas", tabla, omitidas = locales.len() - columnas.len(), "DO-SUBIDA: columnas que la nube no tiene no se suben");
        }
        let parcial = t.get("parcial").and_then(Json::as_bool).unwrap_or(false);
        // Lo fiscal (`solo_insertar`, `monotono`) no se borra nunca arriba: sin sobrantes.
        let politica = match t.get("politica").and_then(Json::as_str) {
            Some("solo_insertar") => "solo_insertar",
            Some("monotono") => "monotono",
            _ => "upsert",
        };
        let sql = t.get("sql").and_then(Json::as_str).map(str::to_owned);
        let parametrizada = t.get("parametrizada").and_then(Json::as_bool).unwrap_or(false);
        let base = Entrada {
            tabla: tabla.to_string(),
            fase: 1,
            turno: if nucleo.contains(tabla) { TURNO_NUCLEO } else { TURNO_IMPRESCINDIBLE },
            sql: sql.clone(),
            parametrizada,
            columnas,
            clave: clave_local.clone(),
            politica,
            por_clave: !parcial,
            claves_fijadas: false,
            cursor: None,
            orden: posicion(tabla),
        };
        let orden = base.orden;
        if let Some(lista) = vivos.get(tabla).and_then(Json::as_array).filter(|l| !l.is_empty()) {
            entradas.push((Entrada { fase: 0, turno: TURNO_VIVOS, por_clave: false, claves_fijadas: true, sql: None, ..base.clone() }, orden));
            for k in lista {
                if let Some(k) = k.as_array() {
                    claves_vivas.push((tabla.to_string(), k.clone()));
                }
            }
        }
        entradas.push((base.clone(), orden));
        if parcial {
            entradas.push((Entrada { fase: 2, turno: TURNO_RECIENTE, ..base.clone() }, orden));
            entradas.push((Entrada { fase: 3, turno: TURNO_HISTORICO, por_clave: true, sql: None, ..base.clone() }, orden));
        } else if politica == "upsert" {
            entradas.push((Entrada { fase: 4, turno: TURNO_SOBRANTES, por_clave: true, sql: None, ..base.clone() }, orden));
        }
    }

    let ahora = chrono::Local::now();
    let desde_imprescindible = ahora.format("%Y-%m-%d %H:%M:%S").to_string();
    let desde_reciente = (ahora - chrono::Duration::days(ventana_dias.clamp(0, 3650))).format("%Y-%m-%d %H:%M:%S").to_string();
    let hasta_seq = plan.get("hastaSeq").and_then(Json::as_i64).unwrap_or(0);
    // El cambio vacío con que la nube abrió su log al volver: un worker anterior no lo dice.
    let inicio_seq = plan.get("inicioSeq").and_then(Json::as_i64).filter(|n| *n > 0);
    let incompletos = plan.get("vivosIncompletos").and_then(Json::as_bool).unwrap_or(false);
    let dispositivo = plan.get("dispositivo").and_then(Json::as_str).filter(|d| !d.is_empty() && d.len() <= 200).map(str::to_owned);

    // Lo que tiene cada tabla aquí, antes de coger el escritor: una lectura no va dentro de su transacción.
    let mut totales: HashMap<String, i64> = HashMap::new();
    {
        let r = db.read().await;
        for (e, _) in &entradas {
            if e.por_clave && e.fase != 4 && !totales.contains_key(&e.tabla) {
                totales.insert(e.tabla.clone(), contar(r.conn(), &e.tabla).await?);
            }
        }
    }

    let w = db.write().await;
    let conn = w.raw();
    conn.transaccion(async {
        conn.execute_batch(
            "DELETE FROM _Sync_Subida_Claves; DELETE FROM _Sync_Subida_Tablas; DELETE FROM _Sync_Subida_Por_Revisar; \
             DELETE FROM _Sync_Subida_Por_Borrar;",
        )
            .await
            .map_err(db_err)?;
        for (e, orden) in &entradas {
            let total = if e.por_clave && e.fase != 4 { totales.get(&e.tabla).copied().unwrap_or(0) } else { 0 };
            conn.execute(
                "INSERT INTO _Sync_Subida_Tablas (Tabla, Fase, Turno, Orden, Sql, Parametrizada, Columnas_Json, Clave_Json, \
                   Politica, Por_Clave, Claves_Fijadas, Total) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12);",
                vec![
                    Value::Text(e.tabla.clone()),
                    Value::Integer(e.fase),
                    Value::Integer(e.turno),
                    Value::Integer(*orden),
                    e.sql.clone().map_or(Value::Null, Value::Text),
                    Value::Integer(e.parametrizada as i64),
                    Value::Text(json!(e.columnas).to_string()),
                    Value::Text(json!(e.clave).to_string()),
                    Value::Text(e.politica.into()),
                    Value::Integer(e.por_clave as i64),
                    Value::Integer(e.claves_fijadas as i64),
                    Value::Integer(total),
                ],
            )
            .await
            .map_err(db_err)?;
        }
        for trozo in claves_vivas.chunks(2_000) {
            let lista: Vec<Json> = trozo.iter().map(|(t, k)| json!([t, Json::Array(k.clone()).to_string()])).collect();
            conn.execute(
                "INSERT INTO _Sync_Subida_Claves (Tabla, Fase, Clave_Json) \
                 SELECT json_extract(value, '$[0]'), 0, json_extract(value, '$[1]') FROM json_each(?1) WHERE 1 \
                 ON CONFLICT DO NOTHING;",
                vec![Value::Text(Json::Array(lista).to_string())],
            )
            .await
            .map_err(db_err)?;
        }
        conn.execute(
            "UPDATE _Sync_Subida_Tablas SET Total = (SELECT COUNT(*) FROM _Sync_Subida_Claves k \
               WHERE k.Tabla = _Sync_Subida_Tablas.Tabla AND k.Fase = 0) WHERE Fase = 0;",
            (),
        )
        .await
        .map_err(db_err)?;
        conn.execute(
            "UPDATE _Sync_Subida SET Desde_Imprescindible = ?1, Desde_Reciente = ?2, Hasta_Seq_Plan = ?3, \
               Vivos_Incompletos = ?4, Dispositivo = ?5, Inicio_Seq = ?6, Rechazos_Seguidos = 0 WHERE Id = 1;",
            vec![
                Value::Text(desde_imprescindible),
                Value::Text(desde_reciente),
                Value::Integer(hasta_seq),
                Value::Integer(incompletos as i64),
                dispositivo.map_or(Value::Null, Value::Text),
                inicio_seq.map_or(Value::Null, Value::Integer),
            ],
        )
        .await
        .map_err(db_err)?;
        Ok(())
    })
    .await?;
    if incompletos {
        tracing::warn!(target: "tpv::sync", "DO-SUBIDA: la nube tiene más claves vivas de las que caben en el plan: las demás las ve el contraste");
    }
    tracing::info!(target: "tpv::sync", evento = "subida_empezada", entradas = entradas.len(), "DO-SUBIDA: plan sembrado");
    Ok(())
}

async fn contar(conn: &Connection, tabla: &str) -> AppResult<i64> {
    Ok(filas(conn, &format!("SELECT COUNT(*) FROM {};", cita(tabla)), vec![]).await?.first().map(|f| entero(&f[0])).unwrap_or(0))
}

/* ===== Las páginas ===== */

/// Una fila leída para subir: su clave, sus valores en JSON y su huella.
#[derive(Debug, Clone)]
struct Fila {
    clave: Vec<Json>,
    valores: Vec<Json>,
    huella: u64,
}

/// La clave de una fila como la nombra la nube en sus listas (`faltan`, `noEntraron`).
fn clave_de(f: &Fila) -> String {
    Json::Array(f.clave.clone()).to_string()
}

fn celda<'a>(v: &ValorPrestado<'a>) -> Celda<'a> {
    match *v {
        ValorPrestado::Null => Celda::Nulo,
        ValorPrestado::Integer(n) => Celda::entero(n),
        ValorPrestado::Real(x) => Celda::Numero(x),
        ValorPrestado::Text(t) => Celda::Texto(t),
        ValorPrestado::Blob(b) => Celda::Blob(b),
    }
}

fn a_json(v: &ValorPrestado<'_>) -> Option<Json> {
    match *v {
        ValorPrestado::Null => Some(Json::Null),
        ValorPrestado::Integer(n) => Some(json!(n)),
        ValorPrestado::Real(x) => serde_json::Number::from_f64(x).map(Json::Number),
        ValorPrestado::Text(t) => std::str::from_utf8(t).ok().map(|s| json!(s)),
        ValorPrestado::Blob(_) => None,
    }
}

fn a_valor(v: &Json) -> Value {
    match v {
        Json::String(s) => Value::Text(s.clone()),
        Json::Number(n) => n.as_i64().map(Value::Integer).unwrap_or_else(|| Value::Real(n.as_f64().unwrap_or(0.0))),
        _ => Value::Null,
    }
}

/// La huella de una fila: el FNV-1a de su forma canónica (`tpv_domain::contraste`).
fn huella(valores: &[ValorPrestado<'_>]) -> u64 {
    let celdas: Vec<Celda<'_>> = valores.iter().map(celda).collect();
    cubos::huella_de_fila(&celdas)
}

/// Lo que se lee de una página.
#[derive(Default)]
struct Pagina {
    /// El checkpoint con el que se leyó: la nube no aplica la página si tiene algo ajeno encima.
    checkpoint: i64,
    /// Hay operaciones por subir: van antes.
    pendientes: i64,
    /// Las filas, en el orden de la página.
    filas: Vec<Fila>,
    /// Filas apuntadas por el orden de la nube: sólo se suben si arriba faltan.
    apuntadas: Vec<Fila>,
    /// Claves de la fase 0 que aquí ya no están: se piden borrar.
    borrar: Vec<Vec<Json>>,
    /// Lo que no se sube (un blob, una fila que no cabe): por revisar.
    por_revisar: Vec<(Vec<Json>, &'static str)>,
    /// Hasta dónde llega la página (su última clave), para el cursor.
    ultima: Option<Vec<Json>>,
    /// Es la última página de la entrada.
    final_: bool,
    /// Filas leídas (con las que no se suben).
    leidas: i64,
}

/// Lo que se aparta de la subida por las cuarentenas de bajada (SYNC-36).
#[derive(Default)]
struct Apartado {
    /// Las filas que toca una cuarentena, por su clave: ni se suben ni se piden borrar arriba, y
    /// quedan para el contraste.
    claves: HashSet<String>,
    /// Las tablas en las que escribe una cuarentena que no dice qué filas toca (o una `dudosa`, las
    /// que sacó por un filtro) y cuyo cambio puede seguir arriba: se dejan enteras para el contraste.
    fuera: HashSet<String>,
    /// Una de esas cuarentenas de la que no se sabe ni en qué tablas escribe: todas fuera.
    todas_fuera: bool,
    /// Las tablas en las que escribe una cuarentena que no dice qué filas toca y cuyo cambio se
    /// perdió con la base de la nube (`perdida_con_la_base`): de ellas sólo sube lo que falta arriba
    /// (nunca se pisa una fila que ya está) y no se pide borrar nada.
    inciertas: HashSet<String>,
    /// Una de esas cuarentenas de la que no se sabe ni en qué tablas escribe: todas inciertas.
    todas_inciertas: bool,
}

/// Qué se hace con una tabla según las cuarentenas de bajada.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Trato {
    /// Como cualquiera, sin las filas que toca una cuarentena (`Apartado::claves`).
    Normal,
    /// Sólo sube lo que falta arriba y no se pide borrar nada.
    SoloLoQueFalta,
    /// Entera para el contraste: no sube nada y queda fallida.
    Fuera,
}

impl Apartado {
    fn trato(&self, tabla: &str) -> Trato {
        if self.todas_fuera || self.fuera.contains(tabla) {
            Trato::Fuera
        } else if self.todas_inciertas || self.inciertas.contains(tabla) {
            Trato::SoloLoQueFalta
        } else {
            Trato::Normal
        }
    }
}

/// DO-SUBIDA · SYNC-36 · Si el cambio de una cuarentena de bajada se perdió con la base de la nube:
/// sólo cuando a la nube se le dio una base vacía y el cambio es de su log de antes (`Seq` por
/// debajo de `Inicio_Seq`, el cambio vacío con que la nube abrió el log al volver, que dice el plan).
/// Con una copia o un instante la base devuelta puede tenerlo (es posterior al cambio), y uno del log
/// nuevo se escribió en la nube devuelta: lo que falta arriba de su tabla puede ser justo lo que
/// borró, y subirlo lo resucitaba sin que el contraste lo viera ya. Eso vale también para lo que una
/// Handy escribió entre la vuelta y el plan: la frontera era el plan, y eso contaba como perdido. Sin
/// `Inicio_Seq` (un worker que no lo dice) no se sabe: no se da por perdido.
fn perdida_con_la_base(base_vacia: bool, inicio_seq: Option<i64>, seq: i64) -> bool {
    base_vacia && inicio_seq.is_some_and(|inicio| seq < inicio)
}

async fn apartado(conn: &Connection) -> AppResult<Apartado> {
    let mut a = Apartado::default();
    let subida = filas(conn, "SELECT Origen, Inicio_Seq FROM _Sync_Subida WHERE Id = 1;", vec![]).await?;
    let (base_vacia, inicio_seq) = subida.first().map_or((false, None), |f| {
        (texto(&f[0]).as_deref() == Some("base_vacia"), matches!(f[1], Value::Integer(_)).then(|| entero(&f[1])))
    });
    for f in filas(conn, "SELECT Filas_Json, Statements_Json, Seq FROM _Sync_Failed;", vec![]).await? {
        let t = f.first().and_then(texto).map(|j| Tocadas::de_json(&j)).unwrap_or_else(|| Tocadas::incierta_de_todo(Vec::new()));
        // DO-SUBIDA · SYNC-36: sin saber qué filas toca (un `Filas_Json` que falta o no se lee), las
        // tablas en las que escriben sus sentencias; y si tampoco quedan sentencias que lo digan,
        // todas. Sin tablas no se apartaba nada, y la subida pisaba arriba lo del cambio.
        let escritas = || {
            if t.tablas.is_empty() {
                let sentencias: Vec<SqlStatement> = f.get(1).and_then(texto).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
                crate::filas_tocadas::tablas_escritas(&sentencias)
            } else {
                t.tablas.clone()
            }
        };
        let inciertas = if t.incierto {
            Some(escritas())
        } else if t.dudosa {
            // DO-SUBIDA · SYNC-36: una `dudosa` dice sus filas, pero las de las tablas que sacó de esta
            // base por un filtro (`por_filtro`) se apuntaron con algo de esta Main rechazado arriba en
            // ellas, y pudieron no ser las de la nube: una fila que el cambio quitó arriba puede no
            // estar en su lista, y subirla la resucitaba. Esas tablas cuentan como las de una incierta.
            let escritas = escritas();
            let cualquiera = t.por_filtro.iter().any(|x| x == crate::filas_tocadas::TODAS);
            let filtradas: Vec<String> = escritas
                .iter()
                .filter(|x| cualquiera || t.por_filtro.iter().any(|p| p.eq_ignore_ascii_case(x)))
                .cloned()
                .collect();
            (escritas.is_empty() || !filtradas.is_empty()).then_some(filtradas)
        } else {
            None
        };
        if let Some(tablas) = inciertas {
            if perdida_con_la_base(base_vacia, inicio_seq, f.get(2).map_or(i64::MAX, entero)) {
                a.todas_inciertas |= tablas.is_empty();
                a.inciertas.extend(tablas);
            } else {
                a.todas_fuera |= tablas.is_empty();
                a.fuera.extend(tablas);
            }
        }
        for fila in &t.filas {
            if let Some(c) = canonica_de(fila) {
                a.claves.insert(c);
            }
        }
    }
    Ok(a)
}

fn canonica(tabla: &str, clave: &[Json]) -> Option<String> {
    canonica_de(&FilaTocada { tabla: tabla.to_string(), clave: clave.to_vec(), borrada: false })
}

/// Lee una página de una entrada. `tope`: filas como mucho.
fn leer_pagina(foto: &Foto<'_>, e: &Entrada, desde: Option<&str>, tope: usize) -> Result<Pagina, ErrorSql> {
    let marca = crate::contraste::leer_marca(foto)?;
    let mut p = Pagina { checkpoint: marca.checkpoint, pendientes: marca.pendientes, ..Pagina::default() };
    if p.pendientes > 0 {
        return Ok(p);
    }
    let lista = e.columnas.iter().map(|c| cita(c)).collect::<Vec<_>>().join(", ");
    let posiciones: Vec<usize> = e.clave.iter().filter_map(|k| e.columnas.iter().position(|c| c == k)).collect();
    if posiciones.len() != e.clave.len() {
        return Err(ErrorSql::Misuse("la clave no está entre las columnas".into()));
    }
    let orden = e.clave.iter().map(|c| cita(c)).collect::<Vec<_>>().join(", ");

    let mut bytes = 0usize;
    let mut tomar = |valores: &[ValorPrestado<'_>], p: &mut Pagina| -> bool {
        let clave: Option<Vec<Json>> = posiciones.iter().map(|i| a_json(&valores[*i])).collect();
        let Some(clave) = clave else { return true };
        p.leidas += 1;
        p.ultima = Some(clave.clone());
        let json: Option<Vec<Json>> = valores.iter().map(a_json).collect();
        let Some(json) = json else {
            p.por_revisar.push((clave, "otro"));
            return true;
        };
        let tam = serde_json::to_string(&json).map(|s| s.len()).unwrap_or(usize::MAX);
        if tam > BYTES_POR_PAGINA {
            p.por_revisar.push((clave, "otro"));
            return true;
        }
        bytes += tam;
        p.filas.push(Fila { clave, valores: json, huella: huella(valores) });
        bytes < BYTES_POR_PAGINA
    };

    if e.por_clave {
        let mut args = Vec::new();
        let donde = match &e.cursor {
            Some(c) => {
                args = c.iter().map(a_valor).collect();
                let marcas = (1..=args.len()).map(|i| format!("?{i}")).collect::<Vec<_>>().join(", ");
                format!(" WHERE ({orden}) > ({marcas})")
            }
            None => String::new(),
        };
        let sql = format!("SELECT {lista} FROM {}{donde} ORDER BY {orden} LIMIT {};", cita(&e.tabla), tope + 1);
        let mut n = 0usize;
        let mut lleno = false;
        foto.recorrer(&sql, &args, |v| {
            n += 1;
            if n > tope || lleno {
                return Ok(());
            }
            if !tomar(v, &mut p) {
                lleno = true;
            }
            Ok(())
        })?;
        p.final_ = n <= tope && !lleno;
    } else {
        let claves: Vec<String> = foto
            .filas(
                "SELECT Clave_Json FROM _Sync_Subida_Claves WHERE Tabla = ?1 AND Fase = ?2 AND Clave_Json > ?3 \
                 ORDER BY Clave_Json LIMIT ?4;",
                &[
                    Value::Text(e.tabla.clone()),
                    Value::Integer(e.fase),
                    Value::Text(desde.unwrap_or("").to_string()),
                    Value::Integer(tope as i64 + 1),
                ],
            )?
            .into_iter()
            .filter_map(|f| f.into_iter().next().as_ref().and_then(texto))
            .collect();
        p.final_ = claves.len() <= tope;
        let claves: Vec<String> = claves.into_iter().take(tope).collect();
        let extraer = (0..e.clave.len()).map(|i| format!("json_extract(value, '$[{i}]')")).collect::<Vec<_>>().join(", ");
        let lista_json = format!("[{}]", claves.join(","));
        let sql = format!(
            "SELECT {lista} FROM {} WHERE ({orden}) IN (SELECT {extraer} FROM json_each(?1));",
            cita(&e.tabla)
        );
        let mut por_clave: HashMap<String, Fila> = HashMap::new();
        let mut sueltas = Pagina::default();
        foto.recorrer(&sql, &[Value::Text(lista_json)], |v| {
            tomar(v, &mut sueltas);
            Ok(())
        })?;
        // DO-SUBIDA · Lo que aquí está pero no se puede mandar (no cabe en una página, un valor sin
        // JSON) queda por revisar, y no es lo que aquí ya no está: no se pide borrar arriba.
        let por_revisar: HashSet<String> = sueltas.por_revisar.iter().map(|(c, _)| Json::Array(c.clone()).to_string()).collect();
        p.por_revisar.append(&mut sueltas.por_revisar);
        for f in sueltas.filas {
            por_clave.insert(Json::Array(f.clave.clone()).to_string(), f);
        }
        for k in &claves {
            let normal = serde_json::from_str::<Json>(k).map(|j| j.to_string()).unwrap_or_default();
            match por_clave.remove(&normal) {
                Some(f) => p.filas.push(f),
                None if e.fase == 0 && !por_revisar.contains(&normal) => {
                    if let Ok(Json::Array(c)) = serde_json::from_str::<Json>(k) {
                        p.borrar.push(c);
                    }
                }
                None => {}
            }
        }
        p.leidas = claves.len() as i64;
        // El cursor de estas fases es el texto de la clave, como está guardado.
        p.ultima = claves.last().map(|k| vec![json!(k)]);
    }
    Ok(p)
}

/// Las filas en trozos que la nube admite: como mucho `FILAS_CON_CALMA` filas y `BYTES_POR_PAGINA`
/// de JSON cada uno (la nube rechaza una página de más de 1,5 MiB). Una fila que no cabe sola ya no
/// llega aquí: se queda por revisar al leerla (`leer_pagina`).
fn trozos_que_caben(filas: &[Fila]) -> Vec<&[Fila]> {
    let mut trozos = Vec::new();
    let (mut inicio, mut bytes) = (0usize, 0usize);
    for (i, f) in filas.iter().enumerate() {
        let tam = serde_json::to_string(&f.valores).map(|s| s.len()).unwrap_or(BYTES_POR_PAGINA) + 1;
        if i > inicio && (i - inicio >= FILAS_CON_CALMA || bytes + tam > BYTES_POR_PAGINA) {
            trozos.push(&filas[inicio..i]);
            inicio = i;
            bytes = 0;
        }
        bytes += tam;
    }
    if inicio < filas.len() {
        trozos.push(&filas[inicio..]);
    }
    trozos
}

/// DO-SUBIDA · El borrado de una fila que la nube tiene y esta Main no (lo vivo de una copia, el
/// sobrante de un maestro), con la condición del contraste
/// (`contraste::borrado_si_la_nube_no_ha_cambiado`: que el log llegue a `hasta_seq`, para que no
/// haga nada en una Main que lo aplique) salvo en una cosa: lo que ha escrito esta misma Main
/// (`dispositivo`) por encima de `hasta_seq` no lo frena, como tampoco aplaza una página de la
/// subida. Esta Main no tiene la fila, así que nada de lo suyo cuelga de ella; lo de una Handy (o
/// de la web) sí lo frena. Sin esto, cualquier venta subida mientras tanto dejaba el borrado en nada
/// y la comanda que aquí ya no existe seguía viva para las Handy hasta el contraste.
fn borrado_si_nadie_mas_ha_escrito(fila: &FilaAfectada, hasta_seq: i64, dispositivo: &str) -> Option<SqlStatement> {
    let (donde, mut args) = crate::sync_reparacion::donde_de_la_clave(fila)?;
    args.push(json!(hasta_seq));
    let n = args.len();
    args.push(json!(dispositivo));
    Some(SqlStatement {
        sql: format!(
            "DELETE FROM \"{}\" WHERE {donde} AND EXISTS (SELECT 1 FROM Sync_Changes WHERE Seq >= ?{n}) \
             AND NOT EXISTS (SELECT 1 FROM Sync_Changes WHERE Seq > ?{n} AND Device_Id IS NOT ?{});",
            fila.tabla,
            n + 1
        ),
        args,
    })
}

/* ===== El acuse ===== */

enum Acuse {
    Bien(Json),
    Aplazada,
    Pasajero,
    PaginaGrande,
    /// La subida entera ya no vale (la nube no la pide, o su techo se ha superado).
    SubidaRechazada(String),
    Permanente(String),
    SinClasificar(String),
}

fn leer_acuse(a: &Json) -> Acuse {
    let cierto = |c: &str| a.get(c) == Some(&Json::Bool(true));
    if cierto("ok") {
        return Acuse::Bien(a.clone());
    }
    if cierto("aplazada") {
        return Acuse::Aplazada;
    }
    let error = a.get("error").and_then(Json::as_str).unwrap_or("").chars().take(200).collect::<String>();
    if error == "subida_pagina_demasiado_grande" {
        return Acuse::PaginaGrande;
    }
    if cierto("transitorio") {
        return Acuse::Pasajero;
    }
    if matches!(error.as_str(), "subida_no_pedida" | "subida_presupuesto_superado") {
        return Acuse::SubidaRechazada(error);
    }
    if cierto("permanente") {
        return Acuse::Permanente(error);
    }
    Acuse::SinClasificar(error)
}

/* ===== El repositorio ===== */

/// De quién es el paso que la nube rechaza: dónde se apunta el rechazo.
#[derive(Clone, Copy)]
enum Quien<'a> {
    /// El plan o el `fin`: uno que no se va a admitir nunca deja la subida entera.
    Subida,
    /// Una página (o sus huellas, sus tramos, sus sobrantes): el rechazo cuenta en los intentos de
    /// su entrada, y la puede dejar fallida.
    Entrada(&'a Entrada),
    /// El repaso, con la entrada de la tabla ya hecha, que no se toca: un rechazo permanente o sin
    /// clasificar cuenta como un intento de lo que se mandaba (`Avanza`), y lo apunta el repaso.
    Repaso(&'a Entrada),
}

/// DO-SUBIDA · La espera tras `seguidos` rechazos sin clasificar seguidos: 30 s el primero, el doble
/// con cada uno más, hasta 30 min. Un rechazo que no se entiende puede durar (un worker con un fallo
/// que nadie ha clasificado): repetir el plan o el `fin` cada 30 s, sin fin, sólo cargaba la nube.
fn espera_tras(seguidos: i64) -> Duration {
    let dobles = (seguidos.clamp(1, 20) - 1) as u32;
    ESPERA_PASAJERA.saturating_mul(1u32 << dobles).min(ESPERA_MAXIMA)
}

/// Lo que hace un paso con un acuse que no es bueno. `Ok`: era bueno (lo trata quien llama).
async fn tras_un_rechazo(db: &Db, quien: Quien<'_>, acuse: Acuse) -> AppResult<Result<Json, PasoHecho>> {
    let e = match quien {
        Quien::Subida => None,
        Quien::Entrada(e) | Quien::Repaso(e) => Some(e),
    };
    // Apunta el rechazo y devuelve los sin clasificar seguidos (con éste, si lo es) y si ha dejado su
    // tabla.
    let anotar = move |error: String, fallida: bool| async move {
        let w = db.write().await;
        let conn = w.raw();
        if let Some(e) = e {
            conn.execute(
                "UPDATE _Sync_Subida_Tablas SET Intentos = Intentos + 1, Ultimo_Error = ?3, \
                   Estado = CASE WHEN ?4 OR Intentos + 1 >= ?5 THEN 2 ELSE Estado END \
                 WHERE Tabla = ?1 AND Fase = ?2;",
                vec![
                    Value::Text(e.tabla.clone()),
                    Value::Integer(e.fase),
                    Value::Text(error.clone()),
                    Value::Integer(fallida as i64),
                    Value::Integer(MAX_INTENTOS),
                ],
            )
            .await
            .map_err(db_err)?;
        }
        // Lo que enseña la pantalla: «se reintenta» sólo mientras se reintenta de verdad. Una tabla
        // que se da por fallida se cuenta aparte (`tablas_fallidas`). El código, sólo en la tabla de
        // la entrada y en la telemetría: la pantalla no enseña identificadores.
        // Un rechazo sin clasificar (no `fallida`) cuenta en los seguidos; uno permanente, no.
        // DO-SUBIDA · Uno que deja su tabla no pone la cuenta a cero: vuelve a cero sola con el
        // primer paso que la nube admita. Que la tabla siguiente también falle a la primera es la
        // firma de un worker con un fallo global sin clasificar, y empezar cada tabla por 30 s se
        // comía el plan entero en unas horas, dejando fallida cada tabla sin reintentarla.
        conn.execute(
            "UPDATE _Sync_Subida SET Ultimo_Error = CASE WHEN ?1 OR EXISTS (SELECT 1 FROM _Sync_Subida_Tablas \
               WHERE Tabla = ?2 AND Fase = ?3 AND Estado = 2) THEN NULL ELSE 'reintentando' END, \
               Rechazos_Seguidos = Rechazos_Seguidos + (NOT ?1) WHERE Id = 1;",
            vec![
                Value::Integer(fallida as i64),
                e.map_or(Value::Null, |e| Value::Text(e.tabla.clone())),
                Value::Integer(e.map_or(-1, |e| e.fase)),
            ],
        )
        .await
        .map_err(db_err)?;
        let mut f = conn
            .query(
                "SELECT Rechazos_Seguidos, EXISTS (SELECT 1 FROM _Sync_Subida_Tablas WHERE Tabla = ?1 AND Fase = ?2 AND Estado = 2) \
                   FROM _Sync_Subida WHERE Id = 1;",
                vec![e.map_or(Value::Null, |e| Value::Text(e.tabla.clone())), Value::Integer(e.map_or(-1, |e| e.fase))],
            )
            .await
            .map_err(db_err)?;
        let (seguidos, dejada) = match f.next().await.map_err(db_err)? {
            Some(fila) => (fila.get::<i64>(0).map_err(db_err)?, fila.get::<i64>(1).map_err(db_err)? != 0),
            None => (1, false),
        };
        AppResult::Ok((seguidos, dejada))
    };
    Ok(Err(match acuse {
        Acuse::Bien(j) => return Ok(Ok(j)),
        Acuse::Aplazada => PasoHecho::Aplazada,
        Acuse::Pasajero => PasoHecho::Esperar(ESPERA_PASAJERA),
        Acuse::PaginaGrande => {
            con_ritmo(|r| r.tope = Some((r.tope.unwrap_or(FILAS_CON_CALMA) / 2).max(FILAS_MINIMAS)));
            PasoHecho::Avanza
        }
        Acuse::SubidaRechazada(error) => {
            let w = db.write().await;
            abandonar_en(w.raw(), &error).await?;
            PasoHecho::Nada
        }
        Acuse::Permanente(error) if matches!(quien, Quien::Subida) => {
            // El plan o el `fin` no se van a admitir nunca: la subida entera se deja, y lo que falte
            // lo ve el contraste.
            let w = db.write().await;
            abandonar_en(w.raw(), &error).await?;
            PasoHecho::Nada
        }
        // DO-SUBIDA (repaso) · Un rechazo sin clasificar del repaso se repetía cada 30 s sin gastar
        // ningún intento, y la subida no llegaba a `fin`; y apuntado en la entrada de la tabla, ya
        // hecha, la daba por fallida sin serlo.
        Acuse::Permanente(error) | Acuse::SinClasificar(error) if matches!(quien, Quien::Repaso(_)) => {
            tracing::warn!(target: "tpv::sync", tabla = e.map(|e| e.tabla.as_str()).unwrap_or(""), error = %error, "DO-SUBIDA: la nube rechaza el repaso");
            PasoHecho::Avanza
        }
        Acuse::Permanente(error) => {
            tracing::error!(target: "tpv::sync", evento = "subida_tabla_fallida", tabla = e.map(|e| e.tabla.as_str()).unwrap_or(""), error = %error, "DO-SUBIDA: la nube rechaza una tabla de la subida");
            anotar(error, true).await?;
            PasoHecho::Avanza
        }
        // DO-SUBIDA · Un rechazo sin clasificar del plan o del `fin` se repetía cada 30 s sin fin. Ahora
        // la espera crece con los seguidos (`espera_tras`) y vuelve a 30 s en cuanto un paso se
        // confirma; sin abandonar. Uno de una página cuenta igual, y a los `MAX_INTENTOS` deja su
        // tabla como uno permanente: sigue con la siguiente sin esperar, y con la cuenta como está.
        Acuse::SinClasificar(error) => {
            let (seguidos, dejada) = anotar(error.clone(), false).await?;
            if dejada {
                tracing::error!(target: "tpv::sync", evento = "subida_tabla_fallida", tabla = e.map(|e| e.tabla.as_str()).unwrap_or(""), error = %error, "DO-SUBIDA: la nube rechaza una tabla de la subida");
                PasoHecho::Avanza
            } else {
                tracing::warn!(target: "tpv::sync", tabla = e.map(|e| e.tabla.as_str()).unwrap_or(""), error = %error, seguidos, "DO-SUBIDA: rechazo sin clasificar");
                PasoHecho::Esperar(espera_tras(seguidos))
            }
        }
    }))
}

fn leer_entrada(f: &[Value]) -> Option<Entrada> {
    let columnas: Vec<String> = serde_json::from_str(&texto(&f[6])?).ok()?;
    let clave: Vec<String> = serde_json::from_str(&texto(&f[7])?).ok()?;
    Some(Entrada {
        tabla: texto(&f[0])?,
        fase: entero(&f[1]),
        turno: entero(&f[2]),
        sql: texto(&f[3]),
        parametrizada: entero(&f[4]) != 0,
        columnas,
        clave,
        politica: match texto(&f[8]).as_deref() {
            Some("solo_insertar") => "solo_insertar",
            Some("monotono") => "monotono",
            _ => "upsert",
        },
        por_clave: entero(&f[9]) != 0,
        claves_fijadas: entero(&f[10]) != 0,
        cursor: texto(&f[11]).and_then(|c| serde_json::from_str(&c).ok()),
        orden: entero(&f[5]),
    })
}

async fn siguiente(conn: &Connection) -> AppResult<Option<Entrada>> {
    let f = filas(
        conn,
        "SELECT Tabla, Fase, Turno, Sql, Parametrizada, Orden, Columnas_Json, Clave_Json, Politica, Por_Clave, \
                Claves_Fijadas, Cursor_Json, Intentos \
           FROM _Sync_Subida_Tablas WHERE Estado = 0 ORDER BY Turno, Orden, Tabla LIMIT 1;",
        vec![],
    )
    .await?;
    Ok(f.into_iter().next().and_then(|f| leer_entrada(&f)))
}

/// Apunta los turnos que se han acabado: sus tablas subidas, y lo que no entró por un único o una
/// foránea, intentado otra vez al cambiar de etapa (`repaso`). Lo que sigue sin entrar tras ese
/// intento queda para el siguiente y no retiene a nadie.
async fn hitos(conn: &Connection) -> AppResult<()> {
    let ahora = now_ms();
    for (columna, hasta) in [("Nucleo_Hecho_Ms", TURNO_NUCLEO), ("Fase1_Hecha_Ms", TURNO_IMPRESCINDIBLE)] {
        let n = conn
            .execute(
                &format!(
                    "UPDATE _Sync_Subida SET {columna} = ?1 WHERE Id = 1 AND {columna} IS NULL \
                       AND NOT EXISTS (SELECT 1 FROM _Sync_Subida_Tablas WHERE Estado = 0 AND Turno <= ?2) \
                       AND NOT EXISTS (SELECT 1 FROM _Sync_Subida_Por_Revisar WHERE Motivo IN ('unico', 'foranea') \
                                         AND Turno <= ?2 AND Intentos < {MAX_REPASOS});"
                ),
                vec![Value::Integer(ahora), Value::Integer(hasta)],
            )
            .await
            .map_err(db_err)?;
        if n > 0 {
            tracing::info!(target: "tpv::sync", evento = "subida_fase", hito = columna, "DO-SUBIDA: etapa subida");
        }
    }
    Ok(())
}

/// Las filas de una tabla por su clave, para el repaso.
fn filas_por_clave(foto: &Foto<'_>, tabla: &str, columnas: &[String], clave: &[String], claves: &[Vec<Json>]) -> Result<Vec<Fila>, ErrorSql> {
    let lista = columnas.iter().map(|c| cita(c)).collect::<Vec<_>>().join(", ");
    let orden = clave.iter().map(|c| cita(c)).collect::<Vec<_>>().join(", ");
    let extraer = (0..clave.len()).map(|i| format!("json_extract(value, '$[{i}]')")).collect::<Vec<_>>().join(", ");
    let posiciones: Vec<usize> = clave.iter().filter_map(|k| columnas.iter().position(|c| c == k)).collect();
    let sql = format!("SELECT {lista} FROM {} WHERE ({orden}) IN (SELECT {extraer} FROM json_each(?1));", cita(tabla));
    let mut out = Vec::new();
    foto.recorrer(&sql, &[Value::Text(json!(claves).to_string())], |v| {
        let clave: Option<Vec<Json>> = posiciones.iter().map(|i| a_json(&v[*i])).collect();
        let json: Option<Vec<Json>> = v.iter().map(a_json).collect();
        if let (Some(clave), Some(valores)) = (clave, json) {
            out.push(Fila { clave, valores, huella: huella(v) });
        }
        Ok(())
    })?;
    Ok(out)
}

impl SqliteSubidaCompleta {
    /// Manda el plan y lo siembra.
    async fn plan(&self, envio: &mut dyn EnvioDeSubida, l: &Local) -> AppResult<PasoHecho> {
        let r = self.db.read().await;
        let (totales, checkpoint) = r
            .conn()
            .foto(|f| {
                let mut totales = serde_json::Map::new();
                for (t, _) in esquema_local(f)? {
                    let n = f.entero(&format!("SELECT COUNT(*) FROM {};", cita(&t)), &[])?.unwrap_or(0);
                    totales.insert(t, json!(n));
                }
                Ok((totales, crate::contraste::leer_marca(f)?.checkpoint))
            })
            .await
            .map_err(db_err)?;
        drop(r);
        let Some(acuse) = envio
            .mandar(json!({
                "accion": "plan", "id": l.id, "clientNow": crate::util::now_local_datetime(),
                "checkpoint": checkpoint, "totales": totales,
            }))
            .await?
        else {
            return Ok(PasoHecho::SinAcuse);
        };
        match tras_un_rechazo(&self.db, Quien::Subida, leer_acuse(&acuse)).await? {
            Ok(plan) => {
                let ventana = plan.get("ventanaDias").and_then(Json::as_i64).unwrap_or(30);
                sembrar(&self.db, &plan, ventana).await?;
                Ok(PasoHecho::Avanza)
            }
            Err(p) => Ok(p),
        }
    }

    /// Fija las claves de una entrada de la fase 1 o 2: ejecuta una vez la sentencia de la ventana de
    /// la nube (sólo lectura, en una foto) con el límite de esta Main y guarda sus claves.
    async fn fijar_claves(&self, e: &Entrada, l: &Local) -> AppResult<PasoHecho> {
        let desde = if e.fase == 2 { l.desde_reciente.clone() } else { l.desde_imprescindible.clone() }.unwrap_or_default();
        let sql = e.sql.clone().unwrap_or_default();
        let args = if e.parametrizada { vec![Value::Text(desde)] } else { vec![] };
        let clave = e.clave.clone();
        let r = self.db.read().await;
        let tabla = e.tabla.clone();
        let claves = r
            .conn()
            .foto(move |f| {
                // La sentencia de la ventana es un `SELECT * FROM "T"`: sus columnas son las de la
                // tabla de aquí, en su orden.
                let columnas: Vec<String> = f
                    .filas("SELECT name FROM pragma_table_info(?1) ORDER BY cid;", &[Value::Text(tabla)])?
                    .into_iter()
                    .filter_map(|c| c.first().and_then(texto))
                    .collect();
                let Some(pos) = clave.iter().map(|k| columnas.iter().position(|c| c == k)).collect::<Option<Vec<usize>>>() else {
                    return Err(ErrorSql::Misuse("la ventana no trae la clave".into()));
                };
                let mut out: Vec<String> = Vec::new();
                let devueltas = f.recorrer(&sql, &args, |v| {
                    if let Some(k) = pos.iter().map(|i| v.get(*i).and_then(a_json)).collect::<Option<Vec<Json>>>() {
                        out.push(Json::Array(k).to_string());
                    }
                    Ok(())
                })?;
                if devueltas != columnas {
                    return Err(ErrorSql::Misuse("la ventana no devuelve las columnas de la tabla".into()));
                }
                Ok(out)
            })
            .await;
        drop(r);
        let w = self.db.write().await;
        let conn = w.raw();
        let claves = match claves {
            Ok(c) => c,
            Err(err) => {
                // Una sentencia que esta versión no sabe ejecutar: la tabla se deja para el contraste.
                tracing::warn!(target: "tpv::sync", tabla = %e.tabla, error = %err, "DO-SUBIDA: la ventana de la nube no se puede ejecutar aquí");
                conn.execute(
                    "UPDATE _Sync_Subida_Tablas SET Estado = 2, Ultimo_Error = 'ventana' WHERE Tabla = ?1 AND Fase = ?2;",
                    vec![Value::Text(e.tabla.clone()), Value::Integer(e.fase)],
                )
                .await
                .map_err(db_err)?;
                return Ok(PasoHecho::Avanza);
            }
        };
        conn.transaccion(async {
            for trozo in claves.chunks(2_000) {
                conn.execute(
                    "INSERT INTO _Sync_Subida_Claves (Tabla, Fase, Clave_Json) \
                     SELECT ?1, ?2, value FROM json_each(?3) WHERE 1 ON CONFLICT DO NOTHING;",
                    vec![Value::Text(e.tabla.clone()), Value::Integer(e.fase), Value::Text(json!(trozo).to_string())],
                )
                .await
                .map_err(db_err)?;
            }
            conn.execute(
                "UPDATE _Sync_Subida_Tablas SET Claves_Fijadas = 1, Total = ?3 WHERE Tabla = ?1 AND Fase = ?2;",
                vec![Value::Text(e.tabla.clone()), Value::Integer(e.fase), Value::Integer(claves.len() as i64)],
            )
            .await
            .map_err(db_err)?;
            Ok(())
        })
        .await?;
        Ok(PasoHecho::Avanza)
    }

    /// Las filas de la página por revisar: las de las cuarentenas (fuera) y las apuntadas. Devuelve el
    /// trato de la tabla (`Apartado::trato`): con `Fuera` no se toca la página; con `SoloLoQueFalta`
    /// todo lo de la página va como lo apuntado, sólo si arriba falta (`pagina`), y no se pide borrar
    /// nada.
    async fn apartar(&self, e: &Entrada, p: &mut Pagina) -> AppResult<Trato> {
        let r = self.db.read().await;
        let ap = apartado(r.conn()).await?;
        let marcadas = crate::convergencia::marcadas(r.conn()).await?;
        drop(r);
        let trato = ap.trato(&e.tabla);
        if trato == Trato::Fuera {
            return Ok(trato);
        }
        let incierta = trato == Trato::SoloLoQueFalta;
        let filas = std::mem::take(&mut p.filas);
        for f in filas {
            let Some(c) = canonica(&e.tabla, &f.clave) else {
                p.filas.push(f);
                continue;
            };
            if ap.claves.contains(&c) {
                continue;
            }
            if marcadas.contains(&c) && !incierta {
                p.apuntadas.push(f);
            } else {
                p.filas.push(f);
            }
        }
        if incierta {
            // DO-SUBIDA · SYNC-36 · Lo que aquí falta puede ser justo lo que escribió el cambio.
            p.borrar.clear();
        } else {
            // Lo vivo de la nube que aquí ya no está, salvo lo que toca una cuarentena.
            p.borrar.retain(|k| canonica(&e.tabla, k).is_none_or(|c| !ap.claves.contains(&c)));
        }
        Ok(trato)
    }

    /// Compara las filas por sus huellas: devuelve las que la nube no tiene o tiene distintas, y de
    /// ellas las que le faltan.
    async fn distintas(&self, envio: &mut dyn EnvioDeSubida, quien: Quien<'_>, e: &Entrada, filas: &[Fila]) -> AppResult<Result<(HashSet<String>, HashSet<String>), PasoHecho>> {
        let mut distintas = HashSet::new();
        let mut faltan = HashSet::new();
        for trozo in filas.chunks(5_000) {
            let huellas: Vec<Json> = trozo.iter().map(|f| json!([f.clave, cubos::hex64(f.huella)])).collect();
            let Some(acuse) = envio
                .mandar(json!({"accion": "huellas", "id": "", "tabla": e.tabla, "columnas": e.columnas, "huellas": huellas}))
                .await?
            else {
                return Ok(Err(PasoHecho::SinAcuse));
            };
            match tras_un_rechazo(&self.db, quien, leer_acuse(&acuse)).await? {
                Ok(r) => {
                    for (lista, destino) in [("distintas", &mut distintas), ("faltan", &mut faltan)] {
                        for k in r.get(lista).and_then(Json::as_array).map(Vec::as_slice).unwrap_or_default() {
                            destino.insert(k.to_string());
                        }
                    }
                }
                Err(p) => return Ok(Err(p)),
            }
        }
        Ok(Ok((distintas, faltan)))
    }

    /// Las filas de unos tramos que no cuadran arriba.
    async fn por_tramos(&self, envio: &mut dyn EnvioDeSubida, e: &Entrada, filas: &[Fila]) -> AppResult<Result<Vec<Fila>, PasoHecho>> {
        let trozos: Vec<&[Fila]> = filas.chunks(FILAS_POR_TRAMO).collect();
        let mut desde: Option<Vec<Json>> = e.cursor.clone();
        let mut tramos = Vec::new();
        for t in &trozos {
            let hasta = t.last().map(|f| f.clave.clone()).unwrap_or_default();
            let suma = cubos::suma_de_huellas(t.iter().map(|f| f.huella));
            tramos.push(json!({"desde": desde, "hasta": hasta, "n": t.len(), "suma": cubos::hex64(suma)}));
            desde = Some(hasta);
        }
        let mut salida = Vec::new();
        for (i, lote) in tramos.chunks(TRAMOS_POR_PASO).enumerate() {
            let Some(acuse) = envio
                .mandar(json!({"accion": "tramos", "id": "", "tabla": e.tabla, "columnas": e.columnas, "tramos": lote}))
                .await?
            else {
                return Ok(Err(PasoHecho::SinAcuse));
            };
            match tras_un_rechazo(&self.db, Quien::Entrada(e), leer_acuse(&acuse)).await? {
                Ok(r) => {
                    for d in r.get("distintos").and_then(Json::as_array).map(Vec::as_slice).unwrap_or_default() {
                        if let Some(t) = d.as_u64().and_then(|d| trozos.get(i * TRAMOS_POR_PASO + d as usize)) {
                            salida.extend(t.iter().cloned());
                        }
                    }
                }
                Err(p) => return Ok(Err(p)),
            }
        }
        Ok(Ok(salida))
    }

    /// Manda unas filas y confirma aquí lo que ha pasado con ellas. `Ok(Ok(iguales))`.
    async fn mandar_filas(&self, envio: &mut dyn EnvioDeSubida, quien: Quien<'_>, e: &Entrada, filas: &[Fila], checkpoint: i64, ultima: bool) -> AppResult<Result<(i64, i64, Vec<(Vec<Json>, String)>), PasoHecho>> {
        let mut escritas = 0;
        let mut iguales = 0;
        let mut no_entraron = Vec::new();
        let trozos = trozos_que_caben(filas);
        if trozos.is_empty() && !ultima {
            // Una lista vacía sólo vale para decir que la tabla ha acabado: la nube la rechazaría.
            return Ok(Ok((0, 0, no_entraron)));
        }
        let trozos = if trozos.is_empty() { vec![&filas[..0]] } else { trozos };
        let n = trozos.len();
        for (i, t) in trozos.into_iter().enumerate() {
            let valores: Vec<&Vec<Json>> = t.iter().map(|f| &f.valores).collect();
            let Some(acuse) = envio
                .mandar(json!({
                    "accion": "filas", "id": "", "tabla": e.tabla, "columnas": e.columnas, "filas": valores,
                    "checkpoint": checkpoint, "ultimaDeLaTabla": ultima && i + 1 == n,
                }))
                .await?
            else {
                return Ok(Err(PasoHecho::SinAcuse));
            };
            match tras_un_rechazo(&self.db, quien, leer_acuse(&acuse)).await? {
                Ok(r) => {
                    escritas += r.get("escritas").and_then(Json::as_i64).unwrap_or(0);
                    iguales += r.get("iguales").and_then(Json::as_i64).unwrap_or(0);
                    for x in r.get("noEntraron").and_then(Json::as_array).map(Vec::as_slice).unwrap_or_default() {
                        if let Some(c) = x.get("clave").and_then(Json::as_array) {
                            no_entraron.push((c.clone(), x.get("motivo").and_then(Json::as_str).unwrap_or("otro").to_string()));
                        }
                    }
                }
                Err(p) => return Ok(Err(p)),
            }
        }
        Ok(Ok((escritas, iguales, no_entraron)))
    }

    /// Una página de una entrada, de punta a punta.
    async fn pagina(&self, envio: &mut dyn EnvioDeSubida, e: &Entrada, l: &Local) -> AppResult<PasoHecho> {
        let calma = {
            let r = self.db.read().await;
            let ultima = crate::verificacion_nube::ultima_escritura_creible(r.conn(), now_ms()).await?;
            ultima.is_none_or(|u| now_ms() - u >= CALMA_MS)
        };
        let tope = self.con_ritmo(|r| r.tope).unwrap_or(FILAS_CON_CALMA).min(if calma { FILAS_CON_CALMA } else { FILAS_CON_ACTIVIDAD });
        let desde = e.cursor.as_ref().and_then(|c| c.first()).and_then(Json::as_str).map(str::to_owned);
        let e2 = e.clone();
        let r = self.db.read().await;
        let mut p = r.conn().foto(move |f| leer_pagina(f, &e2, desde.as_deref(), tope)).await.map_err(db_err)?;
        drop(r);
        if p.pendientes > 0 {
            return Ok(PasoHecho::PorSubir);
        }
        let trato = self.apartar(e, &mut p).await?;
        if trato == Trato::Fuera {
            // DO-SUBIDA · SYNC-36 · Una cuarentena que no sabe qué filas toca y cuyo cambio puede
            // seguir arriba: la tabla entera se deja para el contraste, y la pantalla la cuenta.
            self.anotar_estado(e, 2, Some("cuarentena")).await?;
            tracing::warn!(target: "tpv::sync", tabla = %e.tabla, "DO-SUBIDA: una cuarentena de bajada incierta deja la tabla para el contraste");
            return Ok(PasoHecho::Avanza);
        }
        let incierta = trato == Trato::SoloLoQueFalta;

        // Qué se manda: lo que arriba es distinto o falta.
        let clave_txt = |f: &Fila| Json::Array(f.clave.clone()).to_string();
        let directa = self.con_ritmo(|r| r.directas.contains(&(e.tabla.clone(), e.fase)));
        let base_vacia = l.origen == "base_vacia";
        let leidas = std::mem::take(&mut p.filas);
        let n = leidas.len();
        let mut mandar: Vec<Fila> = if n == 0 {
            Vec::new()
        } else if incierta {
            // DO-SUBIDA · SYNC-36 · Una cuarentena de bajada que no dice qué filas toca, y cuyo cambio
            // se perdió con la base vacía que se le dio a la nube (`perdida_con_la_base`), escribe en
            // esta tabla: de ella sólo sube lo que falta arriba, por las huellas. Lo que ya está
            // arriba lo escribió alguien en la nube devuelta y no se pisa; lo ve el contraste. Dejar
            // la tabla entera fuera dejaba vacía en ella la nube.
            match self.distintas(envio, Quien::Entrada(e), e, &leidas).await? {
                Ok((_, faltan)) => leidas.into_iter().filter(|f| faltan.contains(&clave_txt(f))).collect(),
                Err(paso) => return Ok(paso),
            }
        } else if directa || (base_vacia && e.fase != 3 && e.fase != 0) {
            // Con una base vacía arriba no hay nada que comparar, salvo en el histórico, que
            // repite lo que ya subieron los últimos días.
            leidas
        } else {
            let candidatas = if e.por_clave {
                match self.por_tramos(envio, e, &leidas).await? {
                    Ok(c) => c,
                    Err(paso) => return Ok(paso),
                }
            } else {
                leidas
            };
            if candidatas.is_empty() || (e.por_clave && candidatas.len() * 2 > n) {
                // Nada distinto, o más de la mitad: entonces las filas van sin compararlas una a una.
                candidatas
            } else {
                match self.distintas(envio, Quien::Entrada(e), e, &candidatas).await? {
                    Ok((d, _)) => candidatas.into_iter().filter(|f| d.contains(&clave_txt(f))).collect(),
                    Err(paso) => return Ok(paso),
                }
            }
        };
        let total = n.max(1);
        // Las apuntadas, sólo si arriba faltan.
        if !p.apuntadas.is_empty() {
            match self.distintas(envio, Quien::Entrada(e), e, &p.apuntadas).await? {
                Ok((_, faltan)) => mandar.extend(p.apuntadas.iter().filter(|f| faltan.contains(&clave_txt(f))).cloned()),
                Err(paso) => return Ok(paso),
            }
        }

        // Fase 0: lo vivo de arriba que aquí ya no está se pide borrar por el outbox, al acabar la
        // etapa y hijas primero (`pedir_borrados`).
        if !p.borrar.is_empty() {
            self.apuntar_borrados(e, &p.borrar, l.hasta_seq_plan).await?;
        }

        let (escritas, iguales, no_entraron) = if mandar.is_empty() && !p.final_ {
            (0, 0, Vec::new())
        } else {
            match self.mandar_filas(envio, Quien::Entrada(e), e, &mandar, p.checkpoint, p.final_).await? {
                Ok(r) => r,
                Err(paso) => return Ok(paso),
            }
        };
        // Aprende si en esta tabla conviene mandar sin comparar. En una incierta se compara siempre.
        let mayoria = escritas as usize * 2 > total;
        self.con_ritmo(|r| {
            if incierta {
                return;
            }
            let k = (e.tabla.clone(), e.fase);
            if mayoria && e.por_clave {
                r.directas.insert(k);
            } else if iguales as usize * 2 > total {
                r.directas.remove(&k);
            }
        });

        self.confirmar(e, &p, escritas, no_entraron).await?;
        Ok(PasoHecho::Avanza)
    }

    async fn anotar_estado(&self, e: &Entrada, estado: i64, error: Option<&str>) -> AppResult<()> {
        let w = self.db.write().await;
        w.raw()
            .execute(
                "UPDATE _Sync_Subida_Tablas SET Estado = ?3, Ultimo_Error = COALESCE(?4, Ultimo_Error) WHERE Tabla = ?1 AND Fase = ?2;",
                vec![
                    Value::Text(e.tabla.clone()),
                    Value::Integer(e.fase),
                    Value::Integer(estado),
                    error.map_or(Value::Null, |x| Value::Text(x.into())),
                ],
            )
            .await
            .map_err(db_err)?;
        Ok(())
    }

    /// Avanza el cursor y apunta lo que no entró, en una transacción por `raw()`.
    async fn confirmar(&self, e: &Entrada, p: &Pagina, escritas: i64, no_entraron: Vec<(Vec<Json>, String)>) -> AppResult<()> {
        let w = self.db.write().await;
        let conn = w.raw();
        let cursor = p.ultima.clone().map(|c| Json::Array(c).to_string());
        conn.transaccion(async {
            // Un paso que entra apaga el «se reintenta» de la pantalla, y la espera tras un rechazo sin
            // clasificar vuelve a 30 s.
            conn.execute("UPDATE _Sync_Subida SET Ultimo_Error = NULL, Rechazos_Seguidos = 0 WHERE Id = 1;", ()).await.map_err(db_err)?;
            conn.execute(
                "UPDATE _Sync_Subida_Tablas SET Cursor_Json = COALESCE(?3, Cursor_Json), Filas_Leidas = Filas_Leidas + ?4, \
                   Filas_Escritas = Filas_Escritas + ?5, Intentos = 0, Estado = CASE WHEN ?6 THEN 1 ELSE Estado END \
                 WHERE Tabla = ?1 AND Fase = ?2;",
                vec![
                    Value::Text(e.tabla.clone()),
                    Value::Integer(e.fase),
                    cursor.map_or(Value::Null, Value::Text),
                    Value::Integer(p.leidas),
                    Value::Integer(escritas),
                    Value::Integer(p.final_ as i64),
                ],
            )
            .await
            .map_err(db_err)?;
            let revisar: Vec<Json> = no_entraron
                .iter()
                .map(|(c, m)| json!([e.tabla, Json::Array(c.clone()).to_string(), m]))
                .chain(p.por_revisar.iter().map(|(c, m)| json!([e.tabla, Json::Array(c.clone()).to_string(), m])))
                .collect();
            if !revisar.is_empty() {
                // Con su etapa: se vuelve a intentar al pasar a la siguiente (`repaso`).
                conn.execute(
                    "INSERT INTO _Sync_Subida_Por_Revisar (Tabla, Clave_Json, Motivo, Intentos, Turno) \
                     SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), 0, ?2 \
                       FROM json_each(?1) WHERE 1 \
                     ON CONFLICT(Tabla, Clave_Json) DO UPDATE SET Motivo = excluded.Motivo, Turno = excluded.Turno;",
                    vec![Value::Text(Json::Array(revisar).to_string()), Value::Integer(e.turno)],
                )
                .await
                .map_err(db_err)?;
            }
            Ok(())
        })
        .await?;
        if p.final_ {
            tracing::info!(target: "tpv::sync", evento = "subida_tabla", tabla = %e.tabla, fase = e.fase, "DO-SUBIDA: tabla subida");
            hitos(conn).await?;
        }
        Ok(())
    }

    /// Apunta unas filas que la nube tiene y aquí ya no están, con el final del log que vio la nube
    /// (`hasta_seq`). Se piden borrar al acabar la etapa, todas juntas y hijas primero
    /// (`pedir_borrados`): una por una, padres primero, el borrado de una comanda chocaría con la
    /// foránea de sus líneas, que todavía estarían arriba.
    async fn apuntar_borrados(&self, e: &Entrada, claves: &[Vec<Json>], hasta_seq: i64) -> AppResult<()> {
        if claves.is_empty() {
            return Ok(());
        }
        let lista: Vec<Json> = claves.iter().map(|k| json!([Json::Array(k.clone()).to_string()])).collect();
        let w = self.db.write().await;
        w.raw()
            .execute(
                "INSERT INTO _Sync_Subida_Por_Borrar (Tabla, Clave_Json, Turno, Orden, Hasta_Seq) \
                 SELECT ?1, json_extract(value, '$[0]'), ?2, ?3, ?4 FROM json_each(?5) WHERE 1 \
                 ON CONFLICT(Tabla, Clave_Json) DO NOTHING;",
                vec![
                    Value::Text(e.tabla.clone()),
                    Value::Integer(e.turno),
                    Value::Integer(e.orden),
                    Value::Integer(hasta_seq),
                    Value::Text(Json::Array(lista).to_string()),
                ],
            )
            .await
            .map_err(db_err)?;
        Ok(())
    }

    /// Pide borrar arriba, por el outbox, lo apuntado en las etapas anteriores a `antes_de` (todas,
    /// con `None`): en orden inverso a las foráneas (hijas primero), como el contraste, y cada fila
    /// sólo si en la nube no ha escrito nadie más que esta Main desde que lo vio (`dispositivo`).
    async fn pedir_borrados(&self, antes_de: Option<i64>, dispositivo: Option<&str>) -> AppResult<()> {
        let tope = antes_de.unwrap_or(i64::MAX);
        let apuntadas = {
            let r = self.db.read().await;
            filas(
                r.conn(),
                "SELECT b.Tabla, b.Clave_Json, b.Hasta_Seq, \
                        (SELECT t.Clave_Json FROM _Sync_Subida_Tablas t WHERE t.Tabla = b.Tabla LIMIT 1) \
                   FROM _Sync_Subida_Por_Borrar b WHERE b.Turno < ?1 \
                  ORDER BY b.Orden DESC, b.Tabla, b.Clave_Json;",
                vec![Value::Integer(tope)],
            )
            .await?
        };
        if apuntadas.is_empty() {
            return Ok(());
        }
        let mut sentencias = Vec::new();
        for f in &apuntadas {
            let (Some(tabla), Some(clave_json), Some(columnas)) = (texto(&f[0]), texto(&f[1]), texto(&f[3])) else { continue };
            let Ok(valores) = serde_json::from_str::<Vec<Json>>(&clave_json) else { continue };
            let Ok(columnas) = serde_json::from_str::<Vec<String>>(&columnas) else { continue };
            let clave = columnas
                .iter()
                .zip(&valores)
                .map(|(c, v)| (c.clone(), v.as_str().map(str::to_owned).unwrap_or_else(|| v.to_string())))
                .collect();
            let fila = FilaAfectada { tabla, clave };
            let s = match dispositivo {
                Some(d) => borrado_si_nadie_mas_ha_escrito(&fila, entero(&f[2]), d),
                None => crate::contraste::borrado_si_la_nube_no_ha_cambiado(&fila, entero(&f[2])),
            };
            sentencias.extend(s);
        }
        let w = self.db.write().await;
        let conn = w.raw();
        conn.transaccion(async {
            for op in sentencias.chunks(BORRADOS_POR_OPERACION) {
                crate::contraste::encolar_operacion(conn, op, None).await?;
            }
            conn.execute("DELETE FROM _Sync_Subida_Por_Borrar WHERE Turno < ?1;", vec![Value::Integer(tope)]).await.map_err(db_err)?;
            Ok(())
        })
        .await?;
        tracing::info!(target: "tpv::sync", filas = sentencias.len(), "DO-SUBIDA: lo que la nube tiene y aquí no, por el outbox");
        Ok(())
    }

    /// Los sobrantes de un maestro: las claves de aquí, por tramos, y lo que la nube tiene de más se
    /// pide borrar.
    async fn sobrantes(&self, envio: &mut dyn EnvioDeSubida, e: &Entrada) -> AppResult<PasoHecho> {
        let e2 = e.clone();
        let r = self.db.read().await;
        let (claves, checkpoint, pendientes, final_) = r
            .conn()
            .foto(move |f| {
                let marca = crate::contraste::leer_marca(f)?;
                let orden = e2.clave.iter().map(|c| cita(c)).collect::<Vec<_>>().join(", ");
                let mut args = Vec::new();
                let donde = match &e2.cursor {
                    Some(c) => {
                        args = c.iter().map(a_valor).collect();
                        let marcas = (1..=args.len()).map(|i| format!("?{i}")).collect::<Vec<_>>().join(", ");
                        format!(" WHERE ({orden}) > ({marcas})")
                    }
                    None => String::new(),
                };
                let sql = format!("SELECT {orden} FROM {}{donde} ORDER BY {orden} LIMIT {};", cita(&e2.tabla), CLAVES_POR_SOBRANTES + 1);
                let mut claves: Vec<Vec<Json>> = Vec::new();
                f.recorrer(&sql, &args, |v| {
                    if let Some(k) = v.iter().map(a_json).collect::<Option<Vec<Json>>>() {
                        claves.push(k);
                    }
                    Ok(())
                })?;
                let final_ = claves.len() <= CLAVES_POR_SOBRANTES;
                claves.truncate(CLAVES_POR_SOBRANTES);
                Ok((claves, marca.checkpoint, marca.pendientes, final_))
            })
            .await
            .map_err(db_err)?;
        drop(r);
        if pendientes > 0 {
            return Ok(PasoHecho::PorSubir);
        }
        let hasta = if final_ { None } else { claves.last().cloned() };
        let Some(acuse) = envio
            .mandar(json!({
                "accion": "sobrantes", "id": "", "tabla": e.tabla, "desde": e.cursor, "hasta": hasta,
                "claves": claves, "checkpoint": checkpoint,
            }))
            .await?
        else {
            return Ok(PasoHecho::SinAcuse);
        };
        let r = match tras_un_rechazo(&self.db, Quien::Entrada(e), leer_acuse(&acuse)).await? {
            Ok(r) => r,
            Err(p) => return Ok(p),
        };
        let mut sobran: Vec<Vec<Json>> =
            r.get("sobran").and_then(Json::as_array).map(|l| l.iter().filter_map(|k| k.as_array().cloned()).collect()).unwrap_or_default();
        let hasta_seq = r.get("hastaSeq").and_then(Json::as_i64).unwrap_or(0);
        if !sobran.is_empty() {
            // SYNC-36: lo que aquí falta por una cuarentena de bajada puede ser justo lo que escribió
            // ese cambio de la nube (el alta de una Handy): no se borra arriba. Con una cuarentena
            // que no sabe qué filas toca, nada de su tabla.
            let ap = {
                let r = self.db.read().await;
                apartado(r.conn()).await?
            };
            if ap.trato(&e.tabla) != Trato::Normal {
                sobran.clear();
            } else {
                sobran.retain(|k| canonica(&e.tabla, k).is_none_or(|c| !ap.claves.contains(&c)));
            }
        }
        if !sobran.is_empty() && hasta_seq > 0 {
            self.apuntar_borrados(e, &sobran, hasta_seq).await?;
        }
        let p = Pagina { ultima: claves.last().cloned(), final_, leidas: claves.len() as i64, ..Pagina::default() };
        self.confirmar(e, &p, 0, Vec::new()).await?;
        Ok(PasoHecho::Avanza)
    }

    /// El repaso de lo que no entró por un único o una foránea: otra vez, con más cosas ya arriba.
    /// Con `antes_de`, al cambiar de etapa: lo de las etapas anteriores, una vez por etapa y sin
    /// gastar sus intentos (un producto cuyo proveedor no estaba entra en cuanto el núcleo ha subido,
    /// y no hay que esperar al histórico entero). Sin él, al final: hasta `MAX_REPASOS` veces.
    /// Devuelve `None` si no queda nada que repasar.
    async fn repaso(&self, envio: &mut dyn EnvioDeSubida, antes_de: Option<i64>) -> AppResult<Option<PasoHecho>> {
        let r = self.db.read().await;
        let pendientes = filas(
            r.conn(),
            "SELECT Tabla, Clave_Json FROM _Sync_Subida_Por_Revisar \
              WHERE Motivo IN ('unico', 'foranea') AND Intentos < ?1 AND (?2 IS NULL OR Turno < ?2) \
              ORDER BY Tabla, Clave_Json LIMIT 500;",
            vec![Value::Integer(MAX_REPASOS), antes_de.map_or(Value::Null, Value::Integer)],
        )
        .await?;
        if pendientes.is_empty() {
            return Ok(None);
        }
        let tabla = texto(&pendientes[0][0]).unwrap_or_default();
        // La clave tal como está guardada, y sus valores.
        let claves: Vec<(String, Vec<Json>)> = pendientes
            .iter()
            .filter(|f| texto(&f[0]).as_deref() == Some(tabla.as_str()))
            .filter_map(|f| texto(&f[1]).map(|c| (c.clone(), serde_json::from_str::<Vec<Json>>(&c).unwrap_or_default())))
            .collect();
        let entrada = filas(
            r.conn(),
            "SELECT Tabla, Fase, Turno, Sql, Parametrizada, Orden, Columnas_Json, Clave_Json, Politica, Por_Clave, \
                    Claves_Fijadas, Cursor_Json, Intentos FROM _Sync_Subida_Tablas WHERE Tabla = ?1 ORDER BY Fase LIMIT 1;",
            vec![Value::Text(tabla.clone())],
        )
        .await?
        .into_iter()
        .next()
        .and_then(|f| leer_entrada(&f));
        let Some(e) = entrada else {
            drop(r);
            let w = self.db.write().await;
            w.raw().execute("DELETE FROM _Sync_Subida_Por_Revisar WHERE Tabla = ?1;", vec![Value::Text(tabla)]).await.map_err(db_err)?;
            return Ok(Some(PasoHecho::Avanza));
        };
        let (cols, clave) = (e.columnas.clone(), e.clave.clone());
        let cl: Vec<Vec<Json>> = claves.iter().map(|(_, k)| k.clone()).collect();
        let t = tabla.clone();
        // DO-SUBIDA (repaso) · La marca y las filas, en la misma foto, como `leer_pagina`: lo que se
        // manda es lo de ese checkpoint con el outbox vacío. En dos fotos, una venta entre medias
        // dejaba en el outbox un descuento de stock que la fila leída ya llevaba, y arriba se
        // descontaba dos veces.
        let (marca, encontradas) = r
            .conn()
            .foto(move |f| {
                let marca = crate::contraste::leer_marca(f)?;
                #[cfg(test)]
                tests::entre_la_marca_y_las_filas();
                if marca.pendientes > 0 {
                    return Ok((marca, Vec::new()));
                }
                let encontradas = filas_por_clave(f, &t, &cols, &clave, &cl)?;
                Ok((marca, encontradas))
            })
            .await
            .map_err(db_err)?;
        drop(r);
        if marca.pendientes > 0 {
            return Ok(Some(PasoHecho::PorSubir));
        }
        // DO-SUBIDA (repaso): lo que aquí ya no existe (o ya no se puede mandar) no se repasa: sale
        // de la lista sin mandar nada. Mandar una lista vacía era un rechazo permanente de la nube
        // que no movía nada, y el repaso se repetía sin fin, sin llegar nunca a `fin`.
        let halladas: HashSet<String> = encontradas.iter().map(clave_de).collect();
        // DO-SUBIDA (repaso) · Lo mismo que se aparta de una página (`apartar`). Lo que toca una
        // cuarentena de bajada (SYNC-36), o su tabla entera si no se sabe qué filas y el cambio puede
        // seguir arriba, no se sube: la versión de la nube es la buena, y sale de la lista para el
        // contraste. Una fila apuntada por el orden de la nube (SYNC-29), o cualquiera de una tabla
        // de la que sólo sube lo que falta (`Trato::SoloLoQueFalta`), sólo se sube si arriba falta;
        // si está, la trae la convergencia o la ve el contraste, y también sale. El repaso las
        // mandaba tal cual y deshacía arriba lo bueno.
        let (ap, marcadas) = {
            let r = self.db.read().await;
            (apartado(r.conn()).await?, crate::convergencia::marcadas(r.conn()).await?)
        };
        let trato = ap.trato(&tabla);
        let incierta = trato == Trato::SoloLoQueFalta;
        let mut dejadas: HashSet<String> = HashSet::new();
        let mut mandar: Vec<Fila> = Vec::new();
        let mut apuntadas: Vec<Fila> = Vec::new();
        for f in encontradas {
            let c = canonica(&tabla, &f.clave);
            if trato == Trato::Fuera || c.as_ref().is_some_and(|c| ap.claves.contains(c)) {
                dejadas.insert(clave_de(&f));
            } else if incierta || c.as_ref().is_some_and(|c| marcadas.contains(c)) {
                apuntadas.push(f);
            } else {
                mandar.push(f);
            }
        }
        // Un rechazo permanente o sin clasificar (o una página que no cabe): cuenta como un intento de
        // todas, para que el repaso no se repita sin fin. Uno pasajero no cuenta: se espera.
        let mut rechazado = false;
        // La nube ha admitido el último paso del repaso: la espera tras un rechazo vuelve a 30 s.
        let mut confirmado = false;
        if !apuntadas.is_empty() {
            match self.distintas(envio, Quien::Repaso(&e), &e, &apuntadas).await? {
                Ok((_, faltan)) => {
                    confirmado = true;
                    for f in apuntadas {
                        if faltan.contains(&clave_de(&f)) {
                            mandar.push(f);
                        } else {
                            dejadas.insert(clave_de(&f));
                        }
                    }
                }
                Err(PasoHecho::Avanza) => rechazado = true,
                Err(p) => return Ok(Some(p)),
            }
        }
        let siguen: HashSet<String> = if rechazado {
            halladas.clone()
        } else if mandar.is_empty() {
            HashSet::new()
        } else {
            match self.mandar_filas(envio, Quien::Repaso(&e), &e, &mandar, marca.checkpoint, false).await? {
                Ok((_, _, no_entraron)) => {
                    confirmado = true;
                    no_entraron.iter().map(|(c, _)| Json::Array(c.clone()).to_string()).collect()
                }
                Err(PasoHecho::Avanza) => {
                    confirmado = false;
                    halladas.clone()
                }
                Err(p) => return Ok(Some(p)),
            }
        };
        let w = self.db.write().await;
        let conn = w.raw();
        conn.transaccion(async {
            for (guardada, k) in &claves {
                let k = Json::Array(k.clone()).to_string();
                let sql = if !halladas.contains(&k) || dejadas.contains(&k) || !siguen.contains(&k) {
                    "DELETE FROM _Sync_Subida_Por_Revisar WHERE Tabla = ?1 AND Clave_Json = ?2;"
                } else if antes_de.is_some() {
                    "UPDATE _Sync_Subida_Por_Revisar SET Turno = ?3 WHERE Tabla = ?1 AND Clave_Json = ?2;"
                } else {
                    "UPDATE _Sync_Subida_Por_Revisar SET Intentos = Intentos + 1 WHERE Tabla = ?1 AND Clave_Json = ?2;"
                };
                let mut args = vec![Value::Text(tabla.clone()), Value::Text(guardada.clone())];
                if let Some(t) = antes_de.filter(|_| sql.contains("?3")) {
                    args.push(Value::Integer(t));
                }
                conn.execute(sql, args).await.map_err(db_err)?;
            }
            if confirmado {
                conn.execute("UPDATE _Sync_Subida SET Rechazos_Seguidos = 0 WHERE Id = 1;", ()).await.map_err(db_err)?;
            }
            hitos(conn).await?;
            Ok(())
        })
        .await?;
        Ok(Some(PasoHecho::Avanza))
    }

    /// `fin`: la nube la da por terminada y aquí queda por confirmar con el contraste.
    async fn fin(&self, envio: &mut dyn EnvioDeSubida, l: &Local) -> AppResult<PasoHecho> {
        let r = self.db.read().await;
        let (conteos, por_revisar) = r
            .conn()
            .foto(|f| {
                let mut conteos = serde_json::Map::new();
                for (t, _) in esquema_local(f)? {
                    conteos.insert(t.clone(), json!(f.entero(&format!("SELECT COUNT(*) FROM {};", cita(&t)), &[])?.unwrap_or(0)));
                }
                Ok((conteos, f.entero("SELECT COUNT(*) FROM _Sync_Subida_Por_Revisar;", &[])?.unwrap_or(0)))
            })
            .await
            .map_err(db_err)?;
        drop(r);
        let Some(acuse) = envio.mandar(json!({"accion": "fin", "id": l.id, "conteos": conteos, "porRevisar": por_revisar})).await? else {
            return Ok(PasoHecho::SinAcuse);
        };
        match tras_un_rechazo(&self.db, Quien::Subida, leer_acuse(&acuse)).await? {
            Ok(r) => {
                let w = self.db.write().await;
                w.raw()
                    .execute(
                        "UPDATE _Sync_Subida SET Estado = 'contrastando', Fin_Ms = ?1, Rechazos_Seguidos = 0 \
                         WHERE Id = 1 AND Estado = 'subiendo';",
                        vec![Value::Integer(now_ms())],
                    )
                    .await
                    .map_err(db_err)?;
                tracing::info!(target: "tpv::sync", evento = "subida_terminada", por_revisar, diferencias = r.get("diferencias").and_then(Json::as_i64).unwrap_or(0), "DO-SUBIDA: la nube da la subida por terminada");
                Ok(PasoHecho::Nada)
            }
            Err(p) => Ok(p),
        }
    }
}

/// El `id` de los pasos va relleno por quien manda: aquí, con el de la subida.
struct ConId<'a> {
    id: String,
    envio: &'a mut dyn EnvioDeSubida,
}

#[async_trait]
impl EnvioDeSubida for ConId<'_> {
    async fn mandar(&mut self, mut paso: Json) -> AppResult<Option<Json>> {
        if let Some(o) = paso.as_object_mut() {
            o.insert("id".into(), json!(self.id));
        }
        self.envio.mandar(paso).await
    }
}

#[async_trait]
impl SubidaCompleta for SqliteSubidaCompleta {
    async fn conciliar(&self, peticion: Option<&PeticionDeSubida>) -> AppResult<Conciliacion> {
        let w = self.db.write().await;
        let conn = w.raw();
        let l = local(conn).await?;
        let mismo = |l: &Local, p: &PeticionDeSubida| l.id == p.id;
        Ok(match (peticion, l) {
            (None, Some(l)) if l.estado == "subiendo" => {
                abandonar_en(conn, "la nube ya no pide la subida").await?;
                Conciliacion::Abandonada
            }
            (None, _) => Conciliacion::Nada,
            (Some(p), Some(l)) if p.terminada => {
                if mismo(&l, p) && l.estado == "subiendo" {
                    conn.execute(
                        "UPDATE _Sync_Subida SET Estado = 'contrastando', Fin_Ms = COALESCE(Fin_Ms, ?1) WHERE Id = 1;",
                        vec![Value::Integer(now_ms())],
                    )
                    .await
                    .map_err(db_err)?;
                    Conciliacion::Contrastar
                } else {
                    Conciliacion::Nada
                }
            }
            (Some(p), _) if p.terminada => Conciliacion::Nada,
            (Some(p), Some(l)) if mismo(&l, p) && l.estado == "subiendo" => Conciliacion::Seguir,
            (Some(p), Some(l)) if mismo(&l, p) && l.estado == "abandonada" => {
                // La misma petición, reabierta por la administración (`negocio:subida --reabrir`, tras
                // agotar su techo en un bar con mucho histórico): se sigue por los cursores, sin
                // volver a recorrer lo que ya subió.
                conn.execute("UPDATE _Sync_Subida SET Estado = 'subiendo', Ultimo_Error = NULL, Rechazos_Seguidos = 0 WHERE Id = 1;", ())
                    .await
                    .map_err(db_err)?;
                tracing::info!(target: "tpv::sync", evento = "subida_reanudada", "DO-SUBIDA: la nube vuelve a pedir la misma subida: se sigue por donde iba");
                Conciliacion::Seguir
            }
            (Some(p), Some(l)) if mismo(&l, p) && l.estado == "contrastando" => {
                // La nube no recibió el `fin`: se vuelve a mandar.
                conn.execute("UPDATE _Sync_Subida SET Estado = 'subiendo' WHERE Id = 1;", ()).await.map_err(db_err)?;
                Conciliacion::Seguir
            }
            (Some(p), _) => {
                conn.transaccion(async {
                    vaciar(conn).await?;
                    conn.execute(
                        "INSERT INTO _Sync_Subida (Id, Id_Subida, Origen, Estado, Empezada_Ms) VALUES (1, ?1, ?2, 'subiendo', ?3);",
                        vec![Value::Text(p.id.clone()), Value::Text(p.origen.clone()), Value::Integer(now_ms())],
                    )
                    .await
                    .map_err(db_err)?;
                    Ok(())
                })
                .await?;
                // Lo aprendido de otra subida no vale para ésta (otra nube, otro origen).
                *RITMO.lock().unwrap_or_else(|e| e.into_inner()) = None;
                tracing::info!(target: "tpv::sync", evento = "subida_empezada", origen = %p.origen, "DO-SUBIDA: la nube pide la base entera");
                Conciliacion::Empezar
            }
        })
    }

    async fn pendiente(&self) -> AppResult<bool> {
        let r = self.db.read().await;
        subiendo(r.conn()).await
    }

    async fn nucleo_hecho(&self) -> AppResult<bool> {
        let r = self.db.read().await;
        Ok(match local(r.conn()).await? {
            Some(l) if l.estado == "subiendo" => l.nucleo_hecho,
            _ => true,
        })
    }

    async fn paso(&self, envio: &mut dyn EnvioDeSubida) -> AppResult<PasoHecho> {
        let l = {
            let r = self.db.read().await;
            local(r.conn()).await?
        };
        let Some(l) = l.filter(|l| l.estado == "subiendo") else { return Ok(PasoHecho::Nada) };
        let mut envio = ConId { id: l.id.clone(), envio };
        if l.desde_imprescindible.is_none() {
            return self.plan(&mut envio, &l).await;
        }
        let e = {
            let r = self.db.read().await;
            siguiente(r.conn()).await?
        };
        // Al cambiar de etapa: lo que la nube tiene y aquí no, pedido borrar ya junto y hijas primero,
        // y otro intento de lo que no entró en las anteriores.
        let turno = e.as_ref().map(|e| e.turno);
        self.pedir_borrados(turno, l.dispositivo.as_deref()).await?;
        if let Some(p) = self.repaso(&mut envio, Some(turno.unwrap_or(i64::MAX))).await? {
            return Ok(p);
        }
        match e {
            Some(e) if e.fase == 4 => self.sobrantes(&mut envio, &e).await,
            Some(e) if !e.por_clave && !e.claves_fijadas => self.fijar_claves(&e, &l).await,
            Some(e) => self.pagina(&mut envio, &e, &l).await,
            None => match self.repaso(&mut envio, None).await? {
                Some(p) => Ok(p),
                None => {
                    {
                        let w = self.db.write().await;
                        hitos(w.raw()).await?;
                    }
                    self.fin(&mut envio, &l).await
                }
            },
        }
    }

    async fn abandonar(&self, motivo: &str) -> AppResult<()> {
        let w = self.db.write().await;
        abandonar_en(w.raw(), motivo).await?;
        Ok(())
    }

    fn sueltas_sin_nucleo(&self) {
        tracing::warn!(target: "tpv::sync", evento = "subida_suelta_sin_nucleo", "DO-SUBIDA: se sueltan las Handy sin el núcleo subido");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Lo que pasa en otra conexión justo después de que el repaso lea la marca (una venta que se
    /// cuela). Se usa una vez.
    type Escritura = Box<dyn FnOnce() + Send>;
    static ENTRE_LA_MARCA_Y_LAS_FILAS: Mutex<Option<Escritura>> = Mutex::new(None);

    pub(super) fn entre_la_marca_y_las_filas() {
        let escritura = ENTRE_LA_MARCA_Y_LAS_FILAS.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(f) = escritura {
            f();
        }
    }

    /// Una nube que admite todas las filas y apunta lo que le llega.
    #[derive(Default)]
    struct Nube {
        pasos: Vec<Json>,
    }

    #[async_trait]
    impl EnvioDeSubida for Nube {
        async fn mandar(&mut self, paso: Json) -> AppResult<Option<Json>> {
            let n = paso["filas"].as_array().map_or(0, Vec::len);
            self.pasos.push(paso);
            Ok(Some(json!({"ok": true, "escritas": n, "iguales": 0, "noEntraron": []})))
        }
    }

    /// DO-SUBIDA (repaso) · Una venta que entra entre la marca y las filas del repaso (su descuento en
    /// el outbox) no viaja dentro de la fila: lo mandado es lo de la marca, y el descuento sube
    /// detrás por el outbox una sola vez.
    #[tokio::test]
    async fn el_repaso_lee_la_marca_y_las_filas_en_la_misma_foto() {
        let dir = crate::test_temp::dir_temporal("subida-repaso-foto");
        let ruta = dir.join("data.db");
        let db = Db::open(ruta.to_str().unwrap()).await.unwrap();
        {
            let w = db.write().await;
            w.raw()
                .execute_batch(
                    "INSERT INTO Clientes (ID_Cliente, Nombre, Total_Gastado) VALUES ('cli-1', 'Ana', 100);
                     INSERT INTO _Sync_Subida (Id, Id_Subida, Origen, Estado, Desde_Imprescindible, Empezada_Ms)
                       VALUES (1, 's1', 'copia', 'subiendo', '2026-11-20 10:00:00', 1);
                     INSERT INTO _Sync_Subida_Tablas (Tabla, Fase, Turno, Orden, Columnas_Json, Clave_Json, Politica, Por_Clave, Estado)
                       VALUES ('Clientes', 1, 1, 0, '[\"ID_Cliente\",\"Nombre\",\"Total_Gastado\"]', '[\"ID_Cliente\"]', 'upsert', 1, 1);
                     INSERT INTO _Sync_Subida_Por_Revisar (Tabla, Clave_Json, Motivo, Intentos, Turno)
                       VALUES ('Clientes', '[\"cli-1\"]', 'foranea', 0, 1);",
                )
                .await
                .unwrap();
        }
        *ENTRE_LA_MARCA_Y_LAS_FILAS.lock().unwrap() = Some(Box::new(move || {
            let otra = rusqlite::Connection::open(&ruta).unwrap();
            otra.execute_batch(
                "UPDATE Clientes SET Total_Gastado = Total_Gastado + 50 WHERE ID_Cliente = 'cli-1';
                 INSERT INTO _Sync_Outbox (Op_Id, Command_Name, Statements_Json, Created_At_Ms)
                   VALUES ('venta', 'cobrar', '[{\"sql\":\"UPDATE Clientes SET Total_Gastado = Total_Gastado + 50 WHERE ID_Cliente = ?1;\",\"args\":[\"cli-1\"]}]', 1);",
            )
            .unwrap();
        }));
        let mut nube = Nube::default();
        let paso = SqliteSubidaCompleta::new(db.clone()).repaso(&mut nube, None).await.unwrap();
        assert!(ENTRE_LA_MARCA_Y_LAS_FILAS.lock().unwrap().is_none(), "la venta se ha colado");
        let mandadas: Vec<&Json> = nube.pasos.iter().filter(|p| p["accion"] == "filas").collect();
        match paso {
            // Lo que se mandó es lo de antes de la venta, con el checkpoint de antes.
            Some(PasoHecho::Avanza) => {
                assert_eq!(mandadas.len(), 1);
                assert_eq!(mandadas[0]["filas"], json!([["cli-1", "Ana", 100]]), "la fila de la marca, sin el descuento del outbox");
            }
            // O nada, y el outbox sube primero.
            Some(PasoHecho::PorSubir) => assert!(mandadas.is_empty()),
            otro => panic!("paso inesperado: {otro:?}"),
        }
    }

    #[test]
    fn el_acuse_se_lee_solo_por_sus_marcas_y_su_codigo() {
        assert!(matches!(leer_acuse(&json!({"ok": true})), Acuse::Bien(_)));
        assert!(matches!(leer_acuse(&json!({"ok": false, "aplazada": true, "hastaSeq": 3})), Acuse::Aplazada));
        assert!(matches!(leer_acuse(&json!({"ok": false, "error": "presupuesto_de_subida_agotado", "transitorio": true})), Acuse::Pasajero));
        assert!(matches!(leer_acuse(&json!({"ok": false, "error": "subida_pagina_demasiado_grande"})), Acuse::PaginaGrande));
        assert!(matches!(leer_acuse(&json!({"ok": false, "error": "subida_no_pedida", "permanente": true})), Acuse::SubidaRechazada(_)));
        assert!(matches!(leer_acuse(&json!({"ok": false, "error": "subida_tabla_no_admitida", "permanente": true})), Acuse::Permanente(_)));
        assert!(matches!(leer_acuse(&json!({"ok": false, "error": "algo"})), Acuse::SinClasificar(_)));
    }
}
