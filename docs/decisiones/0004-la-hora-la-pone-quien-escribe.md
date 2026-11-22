# 0004 · La hora la pone quien escribe

**Estado:** vigente. La base del negocio ya no está en Turso, sino en el SQLite de su Durable Object: ver
[0008](0008-la-base-del-negocio-en-su-durable-object.md).

## Contexto

Una sentencia replicada con `datetime('now')` dentro la evaluaría cada base cuando la aplica: la Main
ahora, Turso segundos o días después (si la Main estuvo sin conexión) y en UTC. La misma fila tendría
horas distintas en cada sitio, y una venta de las 23:59 podría caer en otro día.

## Decisión

- **Toda forma de «ahora» se resuelve a literal antes de ejecutar.** La Main fija un instante por
  operación y reescribe las sentencias (`db.rs::rewrite_now_literals`): `'now'` con `'localtime'` a la
  hora local fija, `'now'` sin él y `CURRENT_*` a la UTC fija. **En local se ejecuta la misma sentencia que
  sube.**
- **El esquema no tiene `DEFAULT` de hora**: quien inserta la informa.
- **En la nube, la hora local del emisor viaja en `X-Client-Now`** y el `TenantHub` la usa para fijar
  `'now'` en las escrituras de la Handy (`tenantHub.tiempo.ts`). Lo que no puede fijar (`'now'` en UTC,
  `CURRENT_*`, o sin cabecera) se rechaza. La de la Handy llega con su desfase y el `TenantHub` la
  pasa a la zona del negocio antes de usarla: manda el reloj del equipo, pero la hora es la del
  negocio (MES-INC-03).
- **Las lecturas de la Handy también** se resuelven con `X-Client-Now` (`lib/tenantClient.ts::tenantQuery`):
  si no, «hoy» sería el día UTC de Turso.

## Consecuencias

- La hora del negocio es la del reloj del equipo que escribe. Corregirla con la de la nube podría fechar
  una factura antes que la anterior; cuando se aparta 5 minutos o más de la nube, una franja lo avisa
  para que se ajuste (RELOJ-01, [licencias.md](../arquitectura/licencias.md#el-aviso-del-reloj-desfasado-reloj-01)).
  Las **firmas**, en cambio, usan la hora de la nube ([licencias.md](../arquitectura/licencias.md)).
- Un `'localtime'` aplicado a un valor (`datetime(Fecha,'localtime')`) no se puede fijar: depende de quién
  lo ejecuta.
- El arnés de contrato no ve errores de zona horaria; los cubre `test/lecturasEnHoraLocal.test.ts`.
