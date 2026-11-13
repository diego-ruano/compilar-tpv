//! Puerto de **aplicación de cambios de la nube** en la BD local de la Main.
//!
//! Lo implementa `tpv-infra-sqlite` ejecutando las sentencias ya resueltas que llegan por el
//! WebSocket (o por el catch-up al reconectar) contra el SQLite local, de forma idempotente
//! (por `op_id`) y llevando un checkpoint (`seq`) del último cambio aplicado.

use async_trait::async_trait;

use tpv_contracts::sync::{
    BackfillEstado, BootstrapResultado, BootstrapSnapshot, HistoricoPagina, OutboxEntry,
    OutboxFallo, ResultadoVerificacion, SyncChange, SyncHealth, VerificacionClaves,
    VerificacionNube,
};

use crate::error::AppResult;

/// AUD-18 · Lo que ha pasado al aplicar una tanda de cambios de la nube.
///
/// La bajada va estrictamente en orden de `Seq`: el primer cambio que falla detiene la tanda, y ni
/// se aplica nada posterior ni el checkpoint pasa por encima de él hasta que entra o pasa a
/// cuarentena. No cruza a la interfaz: es lo que se dicen el motor de réplica y el repositorio.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BajadaAplicada {
    /// `op_id` de los cambios aplicados de verdad en esta llamada: sin los que ya estaban, los que
    /// ya se habían procesado ni los que pasan a cuarentena. La interfaz reacciona sólo a éstos.
    pub aplicadas: Vec<String>,
    /// Checkpoint local tras la tanda.
    pub last_seq: i64,
    /// El cambio en el que se ha detenido la bajada, si alguno.
    pub detenida: Option<CambioDetenido>,
}

/// AUD-18 · Un cambio de la nube que ha fallado al aplicarse y aún no ha agotado sus intentos.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CambioDetenido {
    pub op_id: String,
    pub seq: i64,
    /// Intentos fallidos que lleva (`_Sync_Failed.Attempts`): con él decide el motor cuánto espera
    /// antes del siguiente.
    pub intentos: i64,
}

#[async_trait]
pub trait SyncRepository: Send + Sync {
    /// Aplica los cambios en orden de `seq`, cada uno en su transacción e idempotente por `op_id`.
    ///
    /// AUD-18 · Nunca aplica uno posterior antes que uno anterior:
    /// - un cambio con `seq` igual o menor que el checkpoint ya se procesó: no se aplica, y se
    ///   avisa con `warn`;
    /// - el primero que falla se anota en `_Sync_Failed` y detiene la tanda (`detenida`): ni lo de
    ///   detrás se aplica ni el checkpoint pasa por encima de él. Al agotar sus intentos pasa a
    ///   cuarentena, el checkpoint lo salta y la tanda sigue en orden;
    /// - mientras haya uno detenido, lo posterior no entra: la tanda se para ahí sin gastarle
    ///   intentos a nadie.
    async fn apply_changes(&self, changes: Vec<SyncChange>) -> AppResult<BajadaAplicada>;

    /// AUD-18 · El cambio en el que está detenida la bajada (el de `_Sync_Failed` que no está en
    /// cuarentena y va por delante del checkpoint), con las sentencias que se guardaron al fallar.
    /// Es lo primero que se reintenta, y así no depende de que la nube lo siga teniendo.
    async fn cambio_detenido(&self) -> AppResult<Option<SyncChange>>;

    /// Último `seq` aplicado localmente (0 si todavía ninguno).
    async fn get_checkpoint(&self) -> AppResult<i64>;

    /// Operaciones pendientes de subir a la nube (outbox local), en orden, hasta `limit`.
    async fn outbox_pending(&self, limit: i64) -> AppResult<Vec<OutboxEntry>>;

    /// Da por subidas las operaciones que la nube ha confirmado en el acuse de un lote, **todas en
    /// una transacción**: o salen todas del outbox o no sale ninguna. Si el proceso muere a mitad,
    /// el lote vuelve a subir entero y la nube contesta «ya estaba» a cada una.
    ///
    /// Cada par es `(op_id, seq)`. `seq` es el cursor que la nube asignó a la operación en su log
    /// (`Sync_Changes`). Sirve para "ascender" el registro anti-eco de `_Sync_Applied_Ops` (que se
    /// insertó con `Seq=0`) a su `Seq` real, de modo que la purga por cursor pueda retirarlo cuando
    /// el checkpoint lo supere. Si la nube no pudo devolver un `seq` (ya había purgado el log de esa
    /// operación), llega `0` y el anti-eco se queda en `Seq=0` (lo retirará la purga TTL).
    ///
    /// SYNC-26: si una de ellas es una reparación, la operación apartada que la motivó se retira con
    /// ella.
    async fn outbox_confirmar_lote(&self, confirmadas: &[(String, i64)]) -> AppResult<()>;

    /// SYNC-20: anota que la nube RECHAZÓ una operación del outbox y decide si se aparta.
    ///
    /// `permanente` lo dice la nube en su acuse: un error de SQL contra el esquema del
    /// tenant no se arregla reintentando, mientras que un corte o un timeout sí. Sin esa
    /// distinción el drenado sólo podía hacer una cosa —parar y volver a intentarlo— y una
    /// operación irreparable detenía la cola entera, en silencio y para siempre.
    async fn outbox_mark_failed(
        &self,
        op_id: &str,
        error: &str,
        permanente: bool,
    ) -> AppResult<OutboxFallo>;

    /// SYNC-24: contrasta la foto de la nube contra esta base y encola la reparación de lo que no
    /// cuadre. Devuelve qué se ha encontrado, para poder informarlo.
    ///
    /// Sólo lee y encola: no borra nada arriba ni aplica nada aquí. La Main es el escritor único,
    /// así que ante una diferencia su versión es la buena — pero "la nube tiene una fila que aquí
    /// no está" NO se resuelve borrándola: podría ser una fila recién creada por la Handy que esta
    /// Main todavía no ha recibido.
    ///
    /// Con `reparar = false` (interruptor `reparacion_nube`, PROD-06) sólo compara: no encola nada.
    async fn contrastar_con_la_nube(
        &self,
        foto: VerificacionNube,
        reparar: bool,
    ) -> AppResult<ResultadoVerificacion>;

    /// SYNC-25 · segunda fase: con las claves de la nube delante, resta los dos conjuntos.
    ///
    /// Devuelve `(descuadres, reparadas, borradas, aplazado)`. Lo que falta arriba se
    /// repara por estado; lo que sobra se borra **sólo** si esta Main puede afirmar que está al
    /// día — si no, se informa y se espera al ciclo siguiente, que es lo que impide que un dato
    /// recién creado en la Handy se borre por llegar tarde. AUD-18: con cualquier fallo de bajada
    /// en `_Sync_Failed` (en cuarentena o no) no se toca nada arriba: ni se borra ni se sube.
    ///
    /// Con `reparar = false` ni repara ni borra: sólo cuenta.
    async fn contrastar_claves(
        &self,
        respuesta: VerificacionClaves,
        hasta_seq: i64,
        reparar: bool,
    ) -> AppResult<(Vec<tpv_contracts::sync::DescuadreTabla>, i64, i64, bool)>;

    /// Purga de mantenimiento de `_Sync_Applied_Ops` que SOLO retira lo ya confirmado en la nube:
    /// registros antiguos (TTL) cuyo `Op_Id` ya no está pendiente en el outbox. Pensada para
    /// llamarse cuando el outbox queda vacío tras drenar (todo subido). Es segura por diseño: nunca
    /// borra un anti-eco cuya operación siga sin enviarse (evitaría su re-aplicación tras catch-up)
    /// ni, AUD-18, el de una operación propia cuyo `Seq` va por delante del checkpoint: volverá por
    /// el catch-up y sin él se aplicaría otra vez.
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
    ///
    /// AUD-06 · `negocio` es el de la nube de la que viene el volcado. La base queda **sellada**
    /// con él en la misma transacción, y una base que ya lleve el sello de otro negocio se rechaza:
    /// ésa se aparta entera, no se rellena con los datos de otro.
    async fn bootstrap_restaurar(
        &self,
        snapshot: BootstrapSnapshot,
        negocio: &str,
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

    /// La última escritura en la base, en milisegundos de época: una operación de aquí o un cambio
    /// aplicado de la nube. Una marca más allá de `ahora_ms` y su margen es de un reloj que estuvo
    /// adelantado y no se cree (la misma regla que el contraste, VERIF-02). Con ella el backfill
    /// decide su ritmo: más deprisa con el equipo en calma.
    async fn ultima_escritura_ms(&self, ahora_ms: i64) -> AppResult<Option<i64>>;
}
