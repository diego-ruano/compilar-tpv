//! Puerto de **aplicación de cambios de la nube** en la BD local de la Main.
//!
//! Lo implementa `tpv-infra-sqlite` ejecutando las sentencias ya resueltas que llegan por el
//! WebSocket (o por el catch-up al reconectar) contra el SQLite local, de forma idempotente
//! (por `op_id`) y llevando un checkpoint (`seq`) del último cambio aplicado.

use async_trait::async_trait;

use tpv_contracts::sync::{
    BackfillEstado, BootstrapResultado, BootstrapSnapshot, ClavesPagina, FilasDeCubos,
    FilasPorClave, HistoricoPagina, OutboxEntry, OutboxFallo, ResultadoVerificacion, ResumenNube,
    SqlStatement, SyncChange, SyncHealth,
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

/// Lo que tiene que seguir igual en esta base durante toda una pasada del contraste con la nube.
///
/// El contraste compara dos fotos, la de la nube y la de aquí, y sólo valen si son del mismo
/// instante: sin nada de aquí por subir y sin nada de allí por bajar. Como una pasada son varias
/// peticiones, eso se comprueba con una **marca** que se lee al empezar y se vuelve a mirar en cada
/// paso; si ha cambiado, la base se ha movido y la pasada se deja para luego.
///
/// - `checkpoint`: hasta qué `Seq` del log de la nube ha aplicado esta Main lo de los demás. Se
///   mueve con cada cambio que baja.
/// - `escrituras`: cuántas operaciones ha generado esta base en toda su vida (el contador del
///   outbox, que no vuelve atrás). Se mueve con cada escritura de negocio de aquí.
/// - `pendientes`: las que quedan por subir. Con alguna, la nube no tiene todavía lo de aquí.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct MarcaLocal {
    pub checkpoint: i64,
    pub escrituras: i64,
    pub pendientes: i64,
}

/// Las filas de unos cubos de una tabla que se piden a la nube.
#[derive(Debug, Clone, PartialEq)]
pub struct PedidoDeFilas {
    pub tabla: String,
    /// El `desde` del resumen: la ventana es la misma.
    pub desde: String,
    /// En cuántos cubos venía resumida la tabla, y cuáles se piden.
    pub cubos: u32,
    pub pedir: Vec<u32>,
    /// El `siguiente_cursor` de la página anterior; 0 para empezar.
    pub cursor: i64,
}

/// Una página de las claves de una tabla que se pide a la nube.
#[derive(Debug, Clone, PartialEq)]
pub struct PedidoDeClaves {
    pub tabla: String,
    /// La última clave de la página anterior; `None` para empezar.
    pub cursor: Option<Vec<serde_json::Value>>,
}

/// Unas filas que se piden a la nube por su clave primaria.
#[derive(Debug, Clone, PartialEq)]
pub struct PedidoPorClave {
    pub tabla: String,
    /// Cada clave, con sus valores en el orden de la clave.
    pub claves: Vec<Vec<serde_json::Value>>,
}

/// Por dónde el contraste pide a la nube lo que le hace falta además del resumen. Lo implementa el
/// caso de uso sobre el cliente REST; el repositorio sólo sabe que puede pedir páginas.
#[async_trait]
pub trait PaginasDelContraste: Send + Sync {
    /// `/v1/sync/verificar/filas`.
    async fn filas(&self, pedido: PedidoDeFilas) -> AppResult<FilasDeCubos>;
    /// `/v1/sync/verificar/por-clave`.
    async fn por_clave(&self, pedido: PedidoPorClave) -> AppResult<FilasPorClave>;
    /// `/v1/sync/verificar/claves`.
    async fn claves(&self, pedido: PedidoDeClaves) -> AppResult<ClavesPagina>;
}

/// SYNC-29 · Lo que ha hecho una vuelta de la convergencia con el orden de la nube.
#[derive(Debug, Clone, Default)]
pub enum Convergencia {
    /// No hay ninguna fila pendiente de traer.
    #[default]
    Nada,
    /// Hay filas que traer, pero esta base tiene algo por subir o la nube va por delante de ella (o
    /// se ha movido mientras se le pedían): no se ha escrito nada y se vuelve a intentar más tarde.
    Aplazada,
    /// Se han traído y escrito aquí las que eran distintas: `escritas`, para refrescar la interfaz.
    /// `quedan`: había más de las que caben en una vuelta.
    Hecha { escritas: Vec<SqlStatement>, quedan: bool },
}

/// Lo que ha dado una pasada del contraste en el repositorio.
#[derive(Debug, Clone)]
pub enum ContrasteLocal {
    /// Se ha comparado, y encolado lo que se pudiera reparar.
    Hecho(ResultadoVerificacion),
    /// No se ha comparado, o se ha dejado a medias sin tocar nada: esta base o la nube se han
    /// movido desde que se pidió el resumen. No es un fallo; se reintenta más tarde.
    SeHaMovido,
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

    /// La marca de esta base ahora mismo ([`MarcaLocal`]), leída de una vez.
    async fn contraste_marca(&self) -> AppResult<MarcaLocal>;

    /// El contraste con la nube: compara el resumen que manda con el de esta base, baja las filas
    /// de los cubos que no cuadran y las claves de lo que no cuadra fuera de la ventana, y encola
    /// la reparación.
    ///
    /// - Una fila **distinta** se repara mandando cómo está aquí: la Main es el escritor único.
    /// - Una que **falta arriba** se sube por estado.
    /// - Una que **sobra arriba** se borra, porque sólo se compara con esta Main al día: lo que la
    ///   nube tiene y aquí no está no puede ser algo que todavía esté de camino.
    ///
    /// Nada se toca si esta Main no puede afirmar que su foto y la de la nube son del mismo
    /// instante: `marca` es la que se leyó antes de pedir el resumen, y tiene que seguir igual al
    /// comparar y, con el escritor cogido, justo antes de encolar. Tampoco con un fallo de bajada
    /// en `_Sync_Failed` (AUD-18) ni con histórico por bajar (VERIF-01): entonces se compara y se
    /// informa, y lo que habría que tocar sale como `aplazado`.
    ///
    /// SYNC-36 · Antes de comparar, lo que no entró de la bajada y está en cuarentena se trae de la
    /// nube por estado, con la foto de este resumen (`/v1/sync/verificar/por-clave`): lo que entra
    /// aquí cierra su cuarentena, y sin ninguna se repara en la misma pasada. Sólo escribe en esta
    /// base.
    ///
    /// Con `reparar = false` (interruptor `reparacion_nube`, PROD-06) sólo compara: no encola ni
    /// trae nada.
    async fn contrastar_con_la_nube(
        &self,
        resumen: ResumenNube,
        marca: MarcaLocal,
        nube: &dyn PaginasDelContraste,
        reparar: bool,
    ) -> AppResult<ContrasteLocal>;

    /// SYNC-29 · El orden de la nube manda. Al aplicar un cambio de la nube con escrituras de aquí
    /// sin ordenar todavía en sus tablas, `apply_changes` apunta las filas que toca: en la nube esas
    /// escrituras irán detrás del cambio, y aquí fueron delante. Esto trae esas filas de la nube por
    /// su clave (`/v1/sync/verificar/por-clave`) y las escribe aquí como están, sólo con nada por
    /// subir y con la foto de la nube en el checkpoint de esta Main; si no, `Aplazada` sin escribir
    /// nada. Nunca escribe en la nube ni mueve el outbox o el checkpoint.
    ///
    /// Por defecto no hay nada que traer: los dobles de los tests no marcan.
    async fn converger_con_la_nube(&self, nube: &dyn PaginasDelContraste) -> AppResult<Convergencia> {
        let _ = nube;
        Ok(Convergencia::Nada)
    }

    /// Purga de mantenimiento de `_Sync_Applied_Ops` que SOLO retira lo ya confirmado en la nube:
    /// registros antiguos (TTL) cuyo `Op_Id` ya no está pendiente en el outbox. Pensada para
    /// llamarse cuando el outbox queda vacío tras drenar (todo subido). Es segura por diseño: nunca
    /// borra un anti-eco cuya operación siga sin enviarse (evitaría su re-aplicación tras catch-up)
    /// ni, AUD-18, el de una operación propia cuyo `Seq` va por delante del checkpoint: volverá por
    /// el catch-up y sin él se aplicaría otra vez.
    async fn purge_applied_ops(&self) -> AppResult<()>;

    /// Retira las operaciones apartadas de la subida (`_Sync_Outbox` con `Cuarentena = 1`) cuyo
    /// último intento es anterior a `antes_de_ms`, y devuelve cuántas. Una apartada cuya reparación
    /// sigue por subir se queda: la retira esa subida (SYNC-26). La retención la decide el caso de
    /// uso (`use_cases::sync::RETENCION_CUARENTENAS_MS`).
    ///
    /// Las de la bajada (`_Sync_Failed`) no se retiran: un cambio de la nube que no entró en esta
    /// base es lo que le impide al contraste borrar arriba lo que aquí falta o subir lo que la nube
    /// borró (`contraste.rs::Guarda::sin_fallos`). Sin él, esta Main parecería al día sin estarlo.
    /// Sólo se vacían sus datos ([`Self::vaciar_cuarentenas_de_bajada`]), y salen cuando el
    /// contraste trae de la nube lo que tocaron (SYNC-36).
    ///
    /// Por defecto no retira nada: los dobles de los tests no tienen cuarentenas.
    async fn purgar_cuarentenas(&self, antes_de_ms: i64) -> AppResult<u64> {
        let _ = antes_de_ms;
        Ok(0)
    }

    /// SYNC-36 · Vacía los datos de lo que no entró de la bajada (`_Sync_Failed` en cuarentena) y
    /// lleva apartado desde antes de `antes_de_ms`, y devuelve cuántas. Sus sentencias llevan lo que
    /// escribía el cambio (nombres, teléfonos, notas de clientes): se vacían, y el texto de su error
    /// se queda en su clase. La fila sigue, con lo que hace falta para traerla de la nube y para
    /// diagnosticarla sin datos de nadie (su operación, su `Seq`, sus intentos, sus fechas y las
    /// filas que tocó, por su clave): sigue siendo la barrera del contraste hasta que lo que tocó
    /// esté aquí.
    ///
    /// Por defecto no vacía nada: los dobles de los tests no tienen cuarentenas.
    async fn vaciar_cuarentenas_de_bajada(&self, antes_de_ms: i64) -> AppResult<u64> {
        let _ = antes_de_ms;
        Ok(0)
    }

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
    /// - **`ON CONFLICT(<clave primaria>) DO NOTHING`**: lo que ya está en local llegó por el
    ///   catch-up y es más nuevo que esta foto del histórico. Además la fase 2 re-descarga a
    ///   propósito la ventana que ya trajo la fase 1, así que sin eso la primera página de cada
    ///   tabla reventaría por PK. Sólo la fila de la misma clave primaria se da por buena: una que
    ///   choca por otro índice único, un `NOT NULL` o un `CHECK` deshace la página y el error dice
    ///   cuál (un `INSERT OR IGNORE` se la saltaría en silencio y para siempre).
    /// - **Por la conexión CRUDA**: por `execute()` cada fila del histórico se capturaría en
    ///   `_Sync_Outbox` y el equipo devolvería a la nube, operación a operación, el histórico entero
    ///   que acaba de bajarse de ella.
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
