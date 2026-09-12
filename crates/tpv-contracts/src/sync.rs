//! Contratos de **sincronización nube → Main** (Opción 3: sentencias ya resueltas).
//!
//! El worker reenvía por WebSocket (y sirve por el catch-up) operaciones con sus sentencias
//! SQL ya resueltas (los IDs/`MAX+1` viajan literales). La Main las aplica tal cual a su
//! SQLite local mediante el comando `sync_apply_changes`.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Una sentencia de escritura ya resuelta. `args` son escalares JSON (string/number/bool/null)
/// que se enlazan a los `?` del `sql`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct SqlStatement {
    pub sql: String,
    #[ts(type = "Array<unknown>")]
    pub args: Vec<serde_json::Value>,
}

/// Una operación a aplicar de forma atómica e idempotente (por `op_id`). `seq` es el cursor
/// monotono del log de la nube; la Main lo usa como checkpoint del catch-up.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct SyncChange {
    pub op_id: String,
    #[ts(type = "number")]
    pub seq: i64,
    pub statements: Vec<SqlStatement>,
}

/// Args del comando que aplica un lote de cambios en orden de `seq`.
#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct ApplySyncChangesArgs {
    pub changes: Vec<SyncChange>,
}

/// Resultado de aplicar un lote de cambios.
///
/// Lo importante es `aplicadas`: los `op_id` que se aplicaron **de verdad**. El frontend reacciona
/// (invalidar caché, recargar el POS, releer ajustes) sólo a esos. Antes reaccionaba a todo lo que
/// RECIBÍA, incluidas sus propias operaciones que vuelven de la nube y las que el gate de
/// idempotencia descarta — así que una sola vuelta del catch-up recargaba media aplicación sin que
/// nada hubiera cambiado, y en el caso de los ajustes eso realimentaba un bucle.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct AplicacionSync {
    /// `op_id` de las operaciones aplicadas en esta llamada (sin las ya aplicadas ni las saltadas).
    pub aplicadas: Vec<String>,
    /// Checkpoint local tras el lote (último `seq` aplicado).
    #[ts(type = "number")]
    pub last_seq: i64,
}

/// Una operación pendiente en el outbox local de la Main (dirección Main → nube). El frontend
/// la envía al worker por el WebSocket (`apply`) y, al recibir el `apply_ack`, la marca enviada.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct OutboxEntry {
    #[ts(type = "number")]
    pub seq: i64,
    pub op_id: String,
    pub command_name: String,
    pub statements: Vec<SqlStatement>,
}

/// Foto de SALUD de la sincronización local (SYNC-14). La expone el comando `sync_health` para el
/// panel de Configuración → Conectividad, de modo que un fallo de convergencia deje de ser invisible.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct SyncHealth {
    /// Operaciones aún sin subir a la nube (profundidad del outbox).
    #[ts(type = "number")]
    pub outbox_pending: i64,
    /// Último `seq` aplicado localmente (checkpoint del catch-up).
    #[ts(type = "number")]
    pub last_seq: i64,
    /// Operaciones en CUARENTENA (SYNC-01): fallaron al aplicarse y se saltaron para no bloquear.
    #[ts(type = "number")]
    pub quarantined: i64,
    /// Operaciones que están fallando pero aún NO en cuarentena (reintentándose).
    #[ts(type = "number")]
    pub failing: i64,
    /// SYNC-20 · dirección SUBIDA: operaciones del outbox que ya se han llevado algún rechazo de
    /// la nube pero siguen en camino. Es el aviso temprano, antes de que se aparten.
    ///
    /// Los cuatro campos de arriba miran sólo la dirección nube→Main. Mientras fue así, un TPV
    /// cuyo outbox estaba parado porque la nube rechazaba su primera operación enseñaba un panel
    /// de salud impecable: `failing: 0`, `quarantined: 0`. El único síntoma era que `last_seq` no
    /// subía, y eso no lo mira nadie.
    #[ts(type = "number")]
    pub subida_fallando: i64,
    /// SYNC-20 · dirección SUBIDA: operaciones APARTADAS. La nube no las tiene y no va a tenerlas
    /// sin que alguien arregle la causa; el resto de la cola sigue subiendo por encima de ellas.
    #[ts(type = "number")]
    pub subida_en_cuarentena: i64,
}

/// Lo que el drenado necesita saber tras un `apply_ack` fallido (SYNC-20): si esta operación se
/// aparta o se sigue reintentando, y con qué contexto contarlo.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct OutboxFallo {
    /// Rechazos acumulados por esta operación.
    #[ts(type = "number")]
    pub intentos: i64,
    /// `true` si acaba de apartarse: el drenado debe SEGUIR con la siguiente, no parar.
    pub apartada: bool,
    /// Para el informe de telemetría. El `Statements_Json` NO sale de aquí: lleva datos del
    /// negocio y PII, y lo que hace falta para diagnosticar es qué comando falló, no con qué datos.
    pub command_name: String,
    /// SYNC-22: filas cuya reparación se ha encolado al apartar esta operación. Cero puede
    /// significar dos cosas distintas y las dos importan: que no había nada que reparar, o que las
    /// sentencias no se supieron leer (queda en el log). Nunca significa "ya está igualado": eso
    /// sólo lo prueba que la reparación llegue a subir.
    #[ts(type = "number")]
    pub reparadas: i64,
}

/* ===== Bootstrap: reconstrucción de la BD local desde la nube ===== */

/// Volcado de UNA tabla del tenant. `filas` es posicional respecto a `columnas` (con 41 tablas,
/// repetir el nombre de cada columna en cada fila multiplicaría el tamaño sin añadir nada).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct BootstrapTabla {
    pub nombre: String,
    pub columnas: Vec<String>,
    #[ts(type = "Array<Array<unknown>>")]
    pub filas: Vec<Vec<serde_json::Value>>,
    /// SYNC-19: lo que viene está recortado por la ventana de la fase 1, así que esta tabla queda
    /// pendiente de backfill. Lo decide el worker, que es donde vive la clasificación.
    ///
    /// `#[serde(default)]` porque un worker anterior a SYNC-19 no lo manda: ahí el volcado ya venía
    /// entero y no hay nada que rellenar después.
    #[serde(default)]
    pub parcial: bool,
}

/// Respuesta de `/v1/sync/bootstrap`: el estado actual del tenant y el `seq` EXACTO en el que se
/// tomó la foto (leído en la misma transacción). Ese `seq` pasa a ser el checkpoint local, de modo
/// que el catch-up siga desde justo después sin huecos ni solapes.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct BootstrapSnapshot {
    #[ts(type = "number")]
    pub seq: i64,
    /// `alias` porque la app y el worker se despliegan por separado: un TPV actualizado contra un
    /// worker viejo (o al revés) no puede quedarse sin recuperar la base por el nombre de un campo
    /// que ni siquiera se lee. El worker lo mandaba en camelCase desde el principio.
    #[serde(alias = "totalFilas")]
    #[ts(type = "number")]
    pub total_filas: i64,
    pub tablas: Vec<BootstrapTabla>,
    /// SYNC-19: las tablas a rellenar en la fase 2, **en orden de padres primero**. El orden lo
    /// decide el worker y se guarda tal cual: cada página del backfill es su propia transacción,
    /// así que una hija insertada antes que su padre no tiene dónde apoyarse.
    #[serde(default)]
    pub backfill: Vec<String>,
}

/* ===== Fase 2 (SYNC-19): el histórico que la ventana dejó fuera ===== */

/// Una página de `/v1/sync/historico`. `filas` es posicional respecto a `columnas`, igual que en
/// el volcado; el cursor viaja aparte y **no** es una columna más.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct HistoricoPagina {
    pub tabla: String,
    pub columnas: Vec<String>,
    #[ts(type = "Array<Array<unknown>>")]
    pub filas: Vec<Vec<serde_json::Value>>,
    /// `None` = esta tabla está completa. Cualquier otra cosa es "sigue pidiendo desde aquí".
    #[ts(type = "number | null")]
    pub siguiente_cursor: Option<i64>,
}

/// Estado del backfill del histórico, para el panel de Conectividad y para el aviso de las
/// estadísticas (mientras corre, un total de rango largo crece solo y parece un error de cálculo).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct BackfillEstado {
    /// Cuántas tablas quedan por completar. Cero = no hay backfill en curso.
    #[ts(type = "number")]
    pub tablas_pendientes: i64,
    /// Cuántas ha completado ya.
    #[ts(type = "number")]
    pub tablas_completadas: i64,
    /// Filas traídas hasta ahora. Es el único número que se mueve mientras una tabla grande baja,
    /// así que es lo que hace que la barra no parezca colgada.
    #[ts(type = "number")]
    pub filas_traidas: i64,
    /// La tabla que se está rellenando ahora mismo (la primera sin completar), si queda alguna.
    #[ts(optional)]
    pub tabla_actual: Option<String>,
    /// Último error del job, si el anterior intento falló. Diagnóstico, no ramificación.
    #[ts(optional)]
    pub ultimo_error: Option<String>,
}

/// Qué se restauró. `tablas_desconocidas` son las que la nube mandó y esta versión de la app no
/// tiene en su esquema: se informan en vez de fallar (un TPV con una versión por detrás debe poder
/// recuperarse igual), pero se dicen para que no pasen desapercibidas.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct BootstrapResultado {
    #[ts(type = "number")]
    pub seq: i64,
    #[ts(type = "number")]
    pub filas_restauradas: i64,
    pub tablas_restauradas: Vec<String>,
    pub tablas_desconocidas: Vec<String>,
}

/* ===== SYNC-24: contrastar la nube contra la Main ===== */

/// `COUNT(*)` de una tabla ENTERA en la nube. Es lo único que ve una fila perdida fuera de la
/// ventana, y cuesta un agregado por tabla.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct ConteoTabla {
    pub nombre: String,
    #[ts(type = "number")]
    pub filas: i64,
}

/// Respuesta de `/v1/sync/verificar`: la foto con la que se contrasta.
///
/// `ventana` reusa `BootstrapTabla` porque es exactamente la misma forma y la construye la misma
/// sentencia del worker: tener dos formas para el mismo volcado sería tener dos que pueden divergir.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct VerificacionNube {
    pub conteos: Vec<ConteoTabla>,
    pub ventana: Vec<BootstrapTabla>,
    /// La ventana no cabía y sólo vienen los conteos. Media comprobación es mejor que ninguna.
    #[serde(default)]
    pub ventana_omitida: bool,
    /// Límite inferior de la ventana que usó el worker (informativo).
    #[serde(default)]
    pub desde: String,
    /// SYNC-25: hasta qué `Seq` del log de la nube llega esta foto, **leído después de las filas**.
    ///
    /// Es lo que permite borrar arriba sin peligro. Si el checkpoint local llega hasta aquí, esta
    /// Main ya ha visto todo lo que viaja en la foto, así que una fila que le falte no puede ser
    /// «algo que acaba de escribir la Handy y todavía no me ha llegado»: es un borrado suyo que no
    /// llegó a subir. Si no llega, no se borra nada y se espera al ciclo siguiente.
    ///
    /// `#[serde(default)]` = 0 con un worker anterior, y 0 nunca alcanza al checkpoint local salvo
    /// en una base recién estrenada (donde tampoco hay nada que borrar). Falla cerrado.
    #[serde(default)]
    #[ts(type = "number")]
    pub hasta_seq: i64,
}

/// Lo que no cuadra en una tabla.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct DescuadreTabla {
    pub tabla: String,
    /// Filas que la Main tiene y la nube no. Sale de comparar los `COUNT(*)`, así que se sabe
    /// CUÁNTAS pero no cuáles: para eso haría falta la ventana local, y la definición de la ventana
    /// vive en el worker a propósito (una sola fuente). Las que importan de verdad —las de una
    /// operación apartada— ya las repara SYNC-22 en el momento, sin esperar a este contraste.
    #[ts(type = "number")]
    pub faltan: i64,
    /// Filas que la nube tiene y la Main no. Es un borrado que no llegó a subir, y **no se repara
    /// por estado**: la ausencia de una fila no es una fila que mandar (SYNC-23).
    #[ts(type = "number")]
    pub sobran: i64,
    /// Filas que están en los dos sitios con contenido distinto. Éstas SÍ se reparan.
    #[ts(type = "number")]
    pub distintas: i64,
}

/// Lo que dejó una pasada de verificación.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct ResultadoVerificacion {
    pub descuadres: Vec<DescuadreTabla>,
    /// Filas cuya reparación se ha encolado en esta pasada.
    #[ts(type = "number")]
    pub reparadas: i64,
    pub ventana_omitida: bool,
    /// SYNC-25: tablas cuyo contador no cuadra y de las que hay que pedir las claves para saber
    /// **cuáles** filas bailan, no sólo cuántas. Vacío = todo cuadra y no hay segunda fase.
    #[serde(default)]
    pub tablas_a_examinar: Vec<TablaAExaminar>,
    /// Filas de más en la nube cuyo borrado se ha encolado.
    #[serde(default)]
    #[ts(type = "number")]
    pub borradas: i64,
    /// SYNC-26: se encontraron diferencias pero NO se ha tocado nada, porque esta Main no podía
    /// afirmar que estuviera al día (checkpoint por detrás de la foto, o cuarentena de bajada).
    ///
    /// Cubre las dos operaciones y no sólo el borrado, que fue el error inicial: si la Main va
    /// atrasada, una fila «distinta» puede serlo porque la Handy acaba de escribirla y aquí
    /// todavía no ha llegado. Repararla entonces pisaría lo nuevo con lo viejo — el mismo daño que
    /// borrar de más, sólo que más difícil de ver.
    ///
    /// Se informa: es la diferencia entre «no hay nada que arreglar» y «lo hay y no me atrevo».
    #[serde(default)]
    pub aplazado: bool,
}

/// Una tabla de la que hay que pedir las claves, con las columnas que la forman.
///
/// Las columnas las decide la MAIN leyendo su propio esquema y viajan en la petición. El esquema es
/// el mismo en los dos lados, así que da igual quién lo lea; lo que no da igual es que lo lean dos
/// sitios distintos, porque entonces pueden discrepar.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct TablaAExaminar {
    pub nombre: String,
    pub claves: Vec<String>,
}

/// Las claves de una tabla en la nube (SYNC-25).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct ClavesTabla {
    pub nombre: String,
    pub columnas: Vec<String>,
    #[ts(type = "Array<Array<unknown>>")]
    pub claves: Vec<Vec<serde_json::Value>>,
    /// La tabla pasó del tope y la lista no viaja. Se dice en vez de mandar media: media lista se
    /// leería como «te sobran 400.000 filas» y provocaría un borrado masivo.
    #[serde(default)]
    pub truncada: bool,
}

/// Respuesta de `/v1/sync/verificar-claves`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct VerificacionClaves {
    pub tablas: Vec<ClavesTabla>,
}
