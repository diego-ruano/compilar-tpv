//! Contratos de **sincronización nube → Main** (Opción 3: sentencias ya resueltas).
//!
//! El worker reenvía por WebSocket (y sirve por el catch-up) operaciones con sus sentencias
//! SQL ya resueltas (los IDs/`MAX+1` viajan literales). La Main las aplica tal cual a su
//! SQLite local mediante el motor nativo de replicación (RI-31/RI-57).

use serde::{Deserialize, Serialize};
/// Una sentencia de escritura ya resuelta. `args` son escalares JSON (string/number/bool/null)
/// que se enlazan a los `?` del `sql`.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct SqlStatement {
    pub sql: String,
    #[specta(type = Vec<specta_typescript::Unknown>)]
    pub args: Vec<serde_json::Value>,
}

/// Una operación a aplicar de forma atómica e idempotente (por `op_id`). `seq` es el cursor
/// monotono del log de la nube; la Main lo usa como checkpoint del catch-up.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct SyncChange {
    pub op_id: String,
    pub seq: i64,
    pub statements: Vec<SqlStatement>,
}

/// Args del comando que aplica un lote de cambios en orden de `seq`.
#[derive(Debug, Clone, Deserialize, specta::Type)]
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
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct AplicacionSync {
    /// `op_id` de las operaciones aplicadas en esta llamada (sin las ya aplicadas ni las saltadas).
    pub aplicadas: Vec<String>,
    /// Checkpoint local tras el lote (último `seq` aplicado).
    pub last_seq: i64,
}

/// Una operación pendiente del outbox (Main → nube). La envía exclusivamente el motor nativo.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct OutboxEntry {
    pub seq: i64,
    pub op_id: String,
    pub command_name: String,
    pub statements: Vec<SqlStatement>,
}

/// Foto de SALUD de la sincronización local (SYNC-14). La expone el comando `sync_health` para el
/// panel de Configuración → Conectividad, de modo que un fallo de convergencia deje de ser invisible.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct SyncHealth {
    /// Operaciones aún sin subir a la nube (profundidad del outbox).
    pub outbox_pending: i64,
    /// Último `seq` aplicado localmente (checkpoint del catch-up).
    pub last_seq: i64,
    /// Operaciones en CUARENTENA (SYNC-01): fallaron al aplicarse y se saltaron para no bloquear.
    pub quarantined: i64,
    /// Operaciones que están fallando pero aún NO en cuarentena (reintentándose).
    pub failing: i64,
    /// SYNC-20 · dirección SUBIDA: operaciones del outbox que ya se han llevado algún rechazo de
    /// la nube pero siguen en camino. Es el aviso temprano, antes de que se aparten.
    ///
    /// Los cuatro campos de arriba miran sólo la dirección nube→Main. Mientras fue así, un TPV
    /// cuyo outbox estaba parado porque la nube rechazaba su primera operación enseñaba un panel
    /// de salud impecable: `failing: 0`, `quarantined: 0`. El único síntoma era que `last_seq` no
    /// subía, y eso no lo mira nadie.
    pub subida_fallando: i64,
    /// SYNC-20 · dirección SUBIDA: operaciones APARTADAS. La nube no las tiene y no va a tenerlas
    /// sin que alguien arregle la causa; el resto de la cola sigue subiendo por encima de ellas.
    pub subida_en_cuarentena: i64,
    /// SYNC-36 · Lo que la nube ha cambiado y lleva una semana (`BAJADA_ATASCADA_TRAS_MS`) sin poder
    /// escribirse aquí: de las de `quarantined`, las que no pueden salir solas (las filas que tocan
    /// son inciertas o dudosas) o que la salida ya ha intentado y siguen ahí, mientras el contraste
    /// diario no repara nada; y (SYNC-38) las filas apuntadas para traerlas de la nube que no entran,
    /// que el contraste no toca. Lo arregla traer el estado actual de la nube, y se avisa al
    /// administrador.
    pub bajada_atascada: i64,
}

/// Lo que el drenado necesita saber tras un `apply_ack` fallido (SYNC-20): si esta operación se
/// aparta o se sigue reintentando, y con qué contexto contarlo.
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
pub struct OutboxFallo {
    /// Rechazos acumulados por esta operación.
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
    pub reparadas: i64,
}

/* ===== Bootstrap: reconstrucción de la BD local desde la nube ===== */

/// Volcado de UNA tabla del tenant. `filas` es posicional respecto a `columnas` (con 41 tablas,
/// repetir el nombre de cada columna en cada fila multiplicaría el tamaño sin añadir nada).
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct BootstrapTabla {
    pub nombre: String,
    pub columnas: Vec<String>,
    #[specta(type = Vec<Vec<specta_typescript::Unknown>>)]
    pub filas: Vec<Vec<serde_json::Value>>,
    /// SYNC-19: lo que viene está recortado por la ventana de la fase 1, así que esta tabla queda
    /// pendiente de backfill. Lo decide el worker, que es donde vive la clasificación.
    pub parcial: bool,
}

/// Respuesta de `/v1/sync/bootstrap`: el estado actual del tenant y el `seq` EXACTO en el que se
/// tomó la foto (leído en la misma transacción). Ese `seq` pasa a ser el checkpoint local, de modo
/// que el catch-up siga desde justo después sin huecos ni solapes.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct BootstrapSnapshot {
    pub seq: i64,
    pub total_filas: i64,
    pub tablas: Vec<BootstrapTabla>,
    /// SYNC-19: las tablas a rellenar en la fase 2, **en orden de padres primero**. El orden lo
    /// decide el worker y se guarda tal cual: cada página del backfill es su propia transacción,
    /// así que una hija insertada antes que su padre no tiene dónde apoyarse.
    pub backfill: Vec<String>,
    /// DO-02: desde dónde llega entera cada tabla recortada (`AAAA-MM-DD HH:MM:SS`, hora del
    /// equipo). Lo anterior baja por la fase 2. Se guarda con la cola del backfill: con él, el cierre
    /// de caja sabe si lo del periodo abierto ya está aquí. `None` si el worker no lo dice.
    #[serde(default)]
    pub ventana_desde: Option<String>,
}

/* ===== Fase 2 (SYNC-19): el histórico que la ventana dejó fuera ===== */

/// Una página de `/v1/sync/historico`. `filas` es posicional respecto a `columnas`, igual que en
/// el volcado; el cursor viaja aparte y **no** es una columna más.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct HistoricoPagina {
    pub tabla: String,
    pub columnas: Vec<String>,
    #[specta(type = Vec<Vec<specta_typescript::Unknown>>)]
    pub filas: Vec<Vec<serde_json::Value>>,
    /// `None` = esta tabla está completa. Cualquier otra cosa es "sigue pidiendo desde aquí".
    pub siguiente_cursor: Option<i64>,
}

/// Estado del backfill del histórico, para el panel de Conectividad y para el aviso de las
/// estadísticas (mientras corre, un total de rango largo crece solo y parece un error de cálculo).
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct BackfillEstado {
    /// Cuántas tablas quedan por completar. Cero = no hay backfill en curso.
    pub tablas_pendientes: i64,
    /// Cuántas ha completado ya.
    pub tablas_completadas: i64,
    /// Filas traídas hasta ahora. Es el único número que se mueve mientras una tabla grande baja,
    /// así que es lo que hace que la barra no parezca colgada.
    pub filas_traidas: i64,
    /// La tabla que se está rellenando ahora mismo (la primera sin completar), si queda alguna.
    pub tabla_actual: Option<String>,
    /// Último error del job, si el anterior intento falló. Diagnóstico, no ramificación.
    pub ultimo_error: Option<String>,
}

/// Qué se restauró. `tablas_desconocidas` son las que la nube mandó y esta versión de la app no
/// tiene en su esquema: se informan en vez de fallar (un TPV con una versión por detrás debe poder
/// recuperarse igual), pero se dicen para que no pasen desapercibidas.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct BootstrapResultado {
    pub seq: i64,
    pub filas_restauradas: i64,
    pub tablas_restauradas: Vec<String>,
    pub tablas_desconocidas: Vec<String>,
}

/* ===== El contraste con la nube, por resúmenes ===== */

/// Respuesta de `/v1/sync/verificar/resumen`: lo que la nube dice de cada tabla para que la Main
/// lo compare con su base **sin bajarse las filas**.
///
/// O bien es un resumen (`aplazar = false`), o bien la nube dice que ahora no (`aplazar = true`,
/// con su `motivo`): el negocio está escribiendo, o a esta Main le falta por aplicar algo de lo que
/// hay en el log. Lo segundo no es un fallo: se reintenta más tarde.
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
pub struct ResumenNube {
    #[serde(default)]
    pub aplazar: bool,
    /// Por qué se aplaza: `actividad`, `por_delante` o `desfase`. Diagnóstico, no ramificación.
    #[serde(default)]
    pub motivo: Option<String>,
    /// El checkpoint que mandó la Main, devuelto: por encima de él no hay en el log de la nube
    /// nada que no sea de esta Main. `None` si la nube no lo ha comprobado.
    #[serde(default)]
    pub checkpoint: Option<i64>,
    /// El `Seq` del final del log de la nube en la foto de la que sale el resumen. Las páginas
    /// de filas y de claves traen el suyo: si no es éste, la nube se ha movido entre medias.
    #[serde(default)]
    pub hasta_seq: i64,
    /// Límite inferior de la ventana. Vuelve tal cual al pedir las filas de un cubo.
    #[serde(default)]
    pub desde: String,
    /// La ventana no cabía en lo que la nube resume de una vez: sólo vienen los conteos.
    #[serde(default)]
    pub ventana_omitida: bool,
    #[serde(default)]
    pub tablas: Vec<ResumenTabla>,
}

/// Lo que el resumen dice de una tabla.
///
/// `sql` es la sentencia de su ventana, la que la nube ha resumido. La Main **ejecuta esa misma
/// sentencia** en su base: la definición de la ventana vive en el worker y en ningún otro sitio.
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
pub struct ResumenTabla {
    pub nombre: String,
    /// `COUNT(*)` de la tabla ENTERA en la nube: lo único que ve lo que falta o sobra fuera de la
    /// ventana.
    #[serde(default)]
    pub total: i64,
    /// Sin ella (ventana omitida), de esta tabla sólo se compara `total`.
    #[serde(default)]
    pub sql: Option<String>,
    #[serde(default)]
    #[specta(type = Vec<specta_typescript::Unknown>)]
    pub args: Vec<serde_json::Value>,
    /// Las columnas de la ventana, en su orden: el de los valores de cada fila resumida.
    #[serde(default)]
    pub columnas: Vec<String>,
    /// Las columnas de la clave primaria. Vacío: la tabla no tiene, y no se compara por valores.
    #[serde(default)]
    pub claves: Vec<String>,
    /// Filas de la ventana en la nube.
    #[serde(default)]
    pub filas: i64,
    /// En cuántos cubos viene resumida (`tpv_domain::contraste`).
    #[serde(default)]
    pub cubos: u32,
    /// Filas de cada cubo.
    #[serde(default)]
    pub cuentas: Vec<i64>,
    /// La suma de los hashes de las filas de cada cubo: dieciséis cifras hexadecimales.
    #[serde(default)]
    pub sumas: Vec<String>,
}

/// Una página de `/v1/sync/verificar/filas`: las filas de los cubos que no cuadraban.
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
pub struct FilasDeCubos {
    pub tabla: String,
    #[serde(default)]
    pub columnas: Vec<String>,
    #[serde(default)]
    #[specta(type = Vec<Vec<specta_typescript::Unknown>>)]
    pub filas: Vec<Vec<serde_json::Value>>,
    /// `None` = no quedan más. Cualquier otra cosa es «sigue pidiendo desde aquí».
    #[serde(default)]
    pub siguiente_cursor: Option<i64>,
    #[serde(default)]
    pub hasta_seq: i64,
}

/// Respuesta de `/v1/sync/verificar/por-clave`: las filas de unas claves, estén o no en la ventana.
/// Una clave pedida cuya fila no viene no está en la nube, salvo con `cortada`: entonces lo que no
/// ha venido se vuelve a pedir.
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
pub struct FilasPorClave {
    pub tabla: String,
    #[serde(default)]
    pub columnas: Vec<String>,
    #[serde(default)]
    #[specta(type = Vec<Vec<specta_typescript::Unknown>>)]
    pub filas: Vec<Vec<serde_json::Value>>,
    #[serde(default)]
    pub cortada: bool,
    #[serde(default)]
    pub hasta_seq: i64,
}

/// Una página de `/v1/sync/verificar/claves`: claves primarias de una tabla, en orden de clave.
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
pub struct ClavesPagina {
    pub tabla: String,
    #[serde(default)]
    pub columnas: Vec<String>,
    #[serde(default)]
    #[specta(type = Vec<Vec<specta_typescript::Unknown>>)]
    pub claves: Vec<Vec<serde_json::Value>>,
    /// La última clave de la página si queda algo detrás; `None` si era la última.
    #[serde(default)]
    #[specta(type = Option<Vec<specta_typescript::Unknown>>)]
    pub siguiente_cursor: Option<Vec<serde_json::Value>>,
    #[serde(default)]
    pub hasta_seq: i64,
}

/// Lo que no cuadra en una tabla.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct DescuadreTabla {
    pub tabla: String,
    /// Filas que la Main tiene y la nube no. Se suben por estado.
    pub faltan: i64,
    /// Filas que la nube tiene y la Main no. Es un borrado que no llegó a subir: se borran arriba
    /// sólo si esta Main puede afirmar que está al día.
    pub sobran: i64,
    /// Filas que están en los dos sitios con contenido distinto. Se reparan con el de la Main.
    pub distintas: i64,
}

/// Lo que dejó una pasada del contraste.
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
pub struct ResultadoVerificacion {
    pub descuadres: Vec<DescuadreTabla>,
    /// Filas cuya reparación se ha encolado en esta pasada.
    pub reparadas: i64,
    /// La nube no pudo resumir la ventana: sólo se han comparado los conteos (y las claves de lo
    /// que no cuadraba).
    pub ventana_omitida: bool,
    /// Filas de más en la nube cuyo borrado se ha encolado.
    #[serde(default)]
    pub borradas: i64,
    /// Se encontraron diferencias que NO se han tocado: esta Main no podía afirmar que estuviera
    /// al día (un fallo de bajada, histórico por bajar, la base se movió antes de escribir), la
    /// reparación está apagada, o la pasada llegó a su tope antes de mirarlo todo.
    ///
    /// Se informa: es la diferencia entre «no hay nada que arreglar» y «lo hay y no me atrevo».
    #[serde(default)]
    pub aplazado: bool,
    /// Filas que se han bajado de la nube para compararlas una a una: las de los cubos que no
    /// cuadraban. Cero es lo normal.
    #[serde(default)]
    pub filas_examinadas: i64,
    /// Tablas que no se han podido comparar por valores: sin clave primaria, con otras columnas
    /// que en la nube (otra versión del programa), o cuyas filas no llegaron como en el resumen.
    #[serde(default)]
    pub tablas_sin_comparar: Vec<String>,
}

/// RI-31: estado de réplica para la UI, sin SQL ni credenciales.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct EstadoReplicacion {
    pub revision: u64,
    pub estado: String,
    pub detalle: Option<String>,
    pub fase_recuperacion: String,
    pub fallos_recuperacion: u32,
    /// Las Handy siguen retenidas: desde el saludo de esta sesión (que las congela) hasta que la
    /// Main, con el outbox vacío por primera vez, manda `recovery_ready`. Después, lo que quede por
    /// subir en uso normal no las retiene. Fuera de `conectado` no significa nada.
    pub handy_retenidas: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ComandaReplicada {
    pub ids: Vec<String>,
    pub touched_comanda: bool,
    pub uncertain: bool,
    pub touched_catalog: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct CambioReplicado {
    /// None obliga a refrescar todas las consultas: una tabla sin clasificar nunca deja datos viejos.
    pub tablas: Option<Vec<String>>,
    pub comanda: ComandaReplicada,
}
