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
}

/// Respuesta de `/v1/sync/bootstrap`: el estado actual del tenant y el `seq` EXACTO en el que se
/// tomó la foto (leído en la misma transacción). Ese `seq` pasa a ser el checkpoint local, de modo
/// que el catch-up siga desde justo después sin huecos ni solapes.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct BootstrapSnapshot {
    #[ts(type = "number")]
    pub seq: i64,
    #[ts(type = "number")]
    pub total_filas: i64,
    pub tablas: Vec<BootstrapTabla>,
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
