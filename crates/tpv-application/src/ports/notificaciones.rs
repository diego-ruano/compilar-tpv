//! Puertos de **notificaciones**: lectura/gestión (`NotificacionesRepository`) y emisión
//! (`Notifier`). El `Notifier` es la capacidad transversal: cualquier caso de uso puede recibir
//! `&dyn Notifier` y emitir un aviso en una línea, sin conocer la persistencia ni la sincronización.

use async_trait::async_trait;

use tpv_contracts::notificaciones::NotificacionRow;
use tpv_domain::notificaciones::NuevaNotificacion;

use crate::error::AppResult;

/// Lectura y gestión del estado de las notificaciones. Lo implementa `tpv-infra-sqlite`.
#[async_trait]
pub trait NotificacionesRepository: Send + Sync {
    /// Notificaciones activas visibles para `id_usuario` (por destino todos/usuario/rol), con su
    /// estado de lectura para ese usuario. Si `solo_no_leidas`, filtra las ya leídas.
    async fn listar(
        &self,
        id_usuario: &str,
        solo_no_leidas: bool,
    ) -> AppResult<Vec<NotificacionRow>>;

    /// Nº de notificaciones activas visibles y **no leídas** por `id_usuario` (para el badge).
    async fn contar_no_leidas(&self, id_usuario: &str) -> AppResult<i64>;

    // AUD-26: las escrituras de abajo reciben el usuario (el de la sesión) y sólo actúan sobre una
    // notificación dirigida a él (a todos, a él o a su rol) y, en la papelera, en el estado que
    // toca. Esa condición va dentro de la propia sentencia que escribe, no sólo en una consulta
    // previa: así nadie se cuela entre la comprobación y la escritura, y se cumple también donde se
    // aplique después (la nube). Si no la cumple, `not_found` y no se escribe nada.

    /// Marca una notificación dirigida a `id_usuario` como leída por él. Idempotente: `true` si
    /// insertó el recibo, `false` si ya estaba leída.
    async fn marcar_leida(&self, id_notificacion: &str, id_usuario: &str) -> AppResult<bool>;

    /// Marca como leídas todas las visibles y no leídas de `id_usuario`. Devuelve cuántas marcó.
    async fn marcar_todas_leidas(&self, id_usuario: &str) -> AppResult<i64>;

    /// Manda a la papelera (`Estado = 'descartada'`) una notificación activa dirigida a
    /// `id_usuario`. Reversible: la fila sigue ahí, sólo deja de aparecer en el centro.
    async fn descartar(&self, id_notificacion: &str, id_usuario: &str) -> AppResult<bool>;

    /// Contenido de la papelera visible para `id_usuario`: lo descartado, sin borrar del todo.
    async fn listar_descartadas(&self, id_usuario: &str) -> AppResult<Vec<NotificacionRow>>;

    /// Devuelve al centro (`Estado = 'activa'`) una notificación de la papelera de `id_usuario`.
    async fn restaurar(&self, id_notificacion: &str, id_usuario: &str) -> AppResult<bool>;

    /// Borra para siempre una notificación de la papelera de `id_usuario`. Sus recibos de lectura
    /// se van con ella (ON DELETE CASCADE).
    async fn eliminar(&self, id_notificacion: &str, id_usuario: &str) -> AppResult<bool>;
}

/// Puerto de **emisión** de notificaciones. Cualquier módulo lo recibe y emite en una línea.
/// La implementación persiste el aviso (y, vía captura del outbox, lo replica a la nube/Handy).
#[async_trait]
pub trait Notifier: Send + Sync {
    /// Emite una notificación. Con `clave_dedupe` y una activa con esa clave no crea otra: la
    /// actualiza (RI-12). Si cambian la severidad o el título vuelve a salir como no leída; si sólo
    /// cambia el detalle, se actualiza sin más; si no cambia nada, no se escribe. Devuelve el
    /// `ID_Notificacion` (nuevo o reutilizado).
    async fn emitir(&self, nueva: NuevaNotificacion) -> AppResult<String>;

    /// Marca como `resuelta` la notificación **activa** con esa `clave_dedupe` (si existe). Sirve
    /// para cerrar un aviso cuando su condición desaparece (stock repuesto, pedido aprobado).
    /// Devuelve `true` si resolvió alguna.
    async fn resolver_por_clave(&self, clave_dedupe: &str) -> AppResult<bool>;
}
