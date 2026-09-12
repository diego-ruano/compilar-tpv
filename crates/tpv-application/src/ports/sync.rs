//! Puerto de **aplicación de cambios de la nube** en la BD local de la Main.
//!
//! Lo implementa `tpv-infra-sqlite` ejecutando las sentencias ya resueltas que llegan por el
//! WebSocket (o por el catch-up al reconectar) contra el SQLite local, de forma idempotente
//! (por `op_id`) y llevando un checkpoint (`seq`) del último cambio aplicado.

use async_trait::async_trait;

use tpv_contracts::sync::{
    AplicacionSync, BackfillEstado, BootstrapResultado, BootstrapSnapshot, HistoricoPagina,
    OutboxEntry, OutboxFallo, ResultadoVerificacion, SyncChange, SyncHealth,
    VerificacionClaves, VerificacionNube,
};

use crate::error::AppResult;

#[async_trait]
pub trait SyncRepository: Send + Sync {
    /// Aplica los cambios en orden de `seq`, saltando los `op_id` ya aplicados. Cada operación
    /// es atómica. Devuelve el nuevo checkpoint (último `seq` aplicado).
    async fn apply_changes(&self, changes: Vec<SyncChange>) -> AppResult<AplicacionSync>;

    /// Último `seq` aplicado localmente (0 si todavía ninguno).
    async fn get_checkpoint(&self) -> AppResult<i64>;

    /// Operaciones pendientes de subir a la nube (outbox local), en orden, hasta `limit`.
    async fn outbox_pending(&self, limit: i64) -> AppResult<Vec<OutboxEntry>>;

    /// Marca una operación del outbox como enviada (la nube confirmó con `apply_ack`).
    ///
    /// `seq` es el cursor que la nube asignó a la operación en su log (`Sync_Changes`). Sirve para
    /// "ascender" el registro anti-eco de `_Sync_Applied_Ops` (que se insertó con `Seq=0`) a su
    /// `Seq` real, de modo que la purga por cursor pueda retirarlo cuando el checkpoint lo supere.
    /// Si la nube no pudo devolver un `seq` (p. ej. cache-hit de idempotencia sin log), llega `0`
    /// y el anti-eco se queda en `Seq=0` (lo retirará la purga TTL una vez subido).
    async fn outbox_mark_sent(&self, op_id: &str, seq: i64) -> AppResult<()>;

    /// SYNC-20: anota que la nube RECHAZÓ una operación del outbox y decide si se aparta.
    ///
    /// `permanente` lo dice la nube en el `apply_ack`: un error de SQL contra el esquema del
    /// tenant no se arregla reintentando, mientras que un corte o un timeout sí. Sin esa
    /// distinción el drenado sólo podía hacer una cosa —parar y volver a intentarlo— y una
    /// operación irreparable detenía la cola entera, en silencio y para siempre.
    async fn outbox_mark_failed(
        &self,
        op_id: &str,
        error: &str,
        permanente: bool,
    ) -> AppResult<OutboxFallo>;

    /// Purga de mantenimiento de `_Sync_Applied_Ops` que SOLO retira lo ya confirmado en la nube:
    /// registros antiguos (TTL) cuyo `Op_Id` ya no está pendiente en el outbox. Pensada para
    /// llamarse cuando el outbox queda vacío tras drenar (todo subido). Es segura por diseño: nunca
    /// borra un anti-eco cuya operación siga sin enviarse (evitaría su re-aplicación tras catch-up).
    /// SYNC-18: marca operaciones como **aceptadas por la cola de la nube**. Su fila sigue en el
    /// outbox (la prueba de que se aplicaron es verlas volver por el catch-up), pero dejan de
    /// ofrecerse para reenviar mientras tanto.
    async fn outbox_mark_encolada(&self, op_ids: &[String]) -> AppResult<()>;

    /// Suelta las encoladas que llevan demasiado tiempo sin confirmarse: vuelven a estar
    /// disponibles para reenviar. Devuelve cuántas se soltaron. Reenviar es inocuo (la nube es
    /// idempotente por `Op_Id`), y es la red que impide que una operación se quede en el limbo si
    /// la nube la descartó o el ack se perdió.
    async fn liberar_encoladas_caducadas(&self, antiguedad_ms: i64) -> AppResult<i64>;

    /// SYNC-24: contrasta la foto de la nube contra esta base y encola la reparación de lo que no
    /// cuadre. Devuelve qué se ha encontrado, para poder informarlo.
    ///
    /// Sólo lee y encola: no borra nada arriba ni aplica nada aquí. La Main es el escritor único,
    /// así que ante una diferencia su versión es la buena — pero "la nube tiene una fila que aquí
    /// no está" NO se resuelve borrándola: podría ser una fila recién creada por la Handy que esta
    /// Main todavía no ha recibido.
    async fn contrastar_con_la_nube(
        &self,
        foto: VerificacionNube,
    ) -> AppResult<ResultadoVerificacion>;

    /// SYNC-25 · segunda fase: con las claves de la nube delante, resta los dos conjuntos.
    ///
    /// Devuelve `(descuadres, reparadas, borradas, borrado_aplazado)`. Lo que falta arriba se
    /// repara por estado; lo que sobra se borra **sólo** si esta Main puede afirmar que está al
    /// día — si no, se informa y se espera al ciclo siguiente, que es lo que impide que un dato
    /// recién creado en la Handy se borre por llegar tarde.
    async fn contrastar_claves(
        &self,
        respuesta: VerificacionClaves,
        hasta_seq: i64,
    ) -> AppResult<(Vec<tpv_contracts::sync::DescuadreTabla>, i64, i64, bool)>;

    async fn purge_applied_ops(&self) -> AppResult<()>;

    /// Foto de salud de la sincronización (profundidad de outbox, checkpoint, ops en
    /// cuarentena/fallando) para el panel de Configuración → Conectividad (SYNC-14).
    async fn health(&self) -> AppResult<SyncHealth>;

    /// **Reconstruye** la BD local a partir de un volcado de la nube: vacía las tablas de negocio
    /// y las rellena con el estado recibido, dejando el checkpoint en el `seq` de la foto.
    ///
    /// No es "aplicar cambios": es reemplazar. Se usa cuando la Main ha perdido su `data.db` y el
    /// catch-up no puede ayudar (`Sync_Changes` sólo guarda 7 días, y el estado de una tabla no es
    /// la suma de sus cambios recientes). Todo en UNA transacción: o queda la BD entera restaurada
    /// o queda como estaba, nunca a medias.
    ///
    /// Va por la conexión CRUDA, como el resto del aplicador: si pasara por la captura, la Main se
    /// replicaría a la nube el volcado que acaba de recibir de ella.
    async fn bootstrap_restaurar(
        &self,
        snapshot: BootstrapSnapshot,
    ) -> AppResult<BootstrapResultado>;

    /* ===== SYNC-19 · fase 2: el histórico que la ventana del bootstrap dejó fuera ===== */

    /// La siguiente tabla a rellenar (la primera sin completar, en orden de padres primero) y el
    /// cursor por el que se quedó. `None` = no hay backfill pendiente.
    async fn backfill_siguiente(&self) -> AppResult<Option<(String, i64)>>;

    /// Aplica una página del histórico y avanza el cursor **en la misma transacción**. Devuelve
    /// cuántas filas se procesaron.
    ///
    /// Dos cosas que no son negociables aquí, y que si se pierden no dan error sino datos malos:
    ///
    /// - **`INSERT OR IGNORE`**: lo que ya está en local llegó por el catch-up y es más nuevo que
    ///   esta foto del histórico. Además la fase 2 re-descarga a propósito la ventana que ya trajo
    ///   la fase 1, así que sin `IGNORE` la primera página de cada tabla reventaría por PK.
    /// - **Por la conexión CRUDA**: por `execute()` cada fila del histórico se capturaría en
    ///   `_Sync_Outbox` y el equipo devolvería a la nube, operación a operación y facturado como
    ///   escrituras en Turso, el histórico entero que acaba de bajarse de ella.
    async fn backfill_aplicar_pagina(&self, pagina: HistoricoPagina) -> AppResult<i64>;

    /// Deja constancia de por qué falló el último intento sobre una tabla. No mueve el cursor: lo
    /// que estaba a medias se repite, que es lo correcto siendo idempotente.
    async fn backfill_marcar_error(&self, tabla: &str, error: &str) -> AppResult<()>;

    /// Progreso del backfill, para el panel de Conectividad y el aviso de las estadísticas.
    async fn backfill_estado(&self) -> AppResult<BackfillEstado>;
}
