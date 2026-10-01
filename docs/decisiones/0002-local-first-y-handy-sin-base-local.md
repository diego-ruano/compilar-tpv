# 0002 · La Main es Local-First; la Handy no tiene base local

**Estado:** vigente.

## Contexto

Un bar no puede dejar de cobrar porque se caiga internet. A la vez, las tablets de los camareros
(Handy) tienen que ver lo mismo que la caja, y tener dos bases locales escribiendo a la vez obligaría a
resolver conflictos.

## Decisión

- **La Main** (el TPV de la barra, Windows) vende siempre contra su **SQLite local** (`data.db` en
  AppData). Cuando hay red replica a la nube; si no, acumula y sube después
  ([sincronizacion.md](../arquitectura/sincronizacion.md)). No hay ajuste online/offline: conecta cuando
  puede.
- **La Handy** (Android) **no tiene base local**: lee y escribe por REST contra el worker, que trabaja
  sobre la base del tenant en Turso, y recibe avisos de cambio por WebSocket para refrescar.
- **La Handy depende de que haya una Main conectada**: sin ella, el `TenantHub` la congela
  (`main_offline`).
- **Cobrar, la caja y el registro fiscal son de la Main**: el número correlativo, el cajón y la cadena de
  facturas tienen un solo dueño. El worker los veta a la Handy.

## Consecuencias

- Sin internet la Main sigue vendiendo; la Handy no.
- Perder la base de la Main es un problema propio, con su pantalla de recuperación
  ([recuperacion.md](../arquitectura/recuperacion.md)).
- El código de la Handy es el mismo binario; en Android se compila sin lo de escritorio
  ([compilar-android.md](../guias/compilar-android.md)).
