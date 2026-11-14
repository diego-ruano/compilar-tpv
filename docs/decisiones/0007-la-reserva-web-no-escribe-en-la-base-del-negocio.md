# 0007 · La reserva web no escribe en la base del negocio

**Estado:** vigente (2026-10-17). La base del negocio ya no está en Turso, sino en el SQLite de su
Durable Object ([0008](0008-la-base-del-negocio-en-su-durable-object.md)): «Turso», aquí, es esa base.
El plan y lo que queda de él están en [estudios/reservas-web.md](../estudios/reservas-web.md).

## Contexto

- Una web tiene que aceptar reservas a cualquier hora: con la Main apagada (de noche, en vacaciones)
  o recuperándose.
- Hoy ninguna escritura entra en la nube sin una Main conectada (`main_offline`,
  [0002](0002-local-first-y-handy-sin-base-local.md)), y la base del negocio tiene un escritor que
  manda, la Main ([0003](0003-replicacion-por-sentencias-con-escritor-unico.md)).
- Escribir desde la nube con la Main apagada la convertiría en un segundo escritor: el mismo cliente
  creado en los dos lados choca con el correo único, una Main sin actualizar no sabe aplicar las
  columnas nuevas y el aviso «Nueva reserva» tendría que emitirlo el worker.
- Lo que llega de una web es anónimo, de internet y puede venir de bots. El `TenantHub` es un único
  hilo por negocio que lleva la réplica de la Main, con confirmaciones que esperan 10 s.

## Decisión

- **Un Durable Object nuevo por negocio, `AgendaWeb`**, en el mismo worker
  ([0006](0006-un-solo-worker.md)). Lee de Turso y **nunca escribe en Turso**.
- **Una reserva web vive en el SQLite de la agenda hasta que aparece en Turso**, y ocupa su mesa
  desde que se confirma. La agenda es la que reparte las mesas de la web, una petición tras otra.
- **La registra la Main**: el `TenantHub` le avisa por el WebSocket, la Main recoge las pendientes
  por REST, las registra con su caso de uso y las sube por su outbox. Lo pendiente se recoge al
  conectar y en cada reconexión.
- **Se confirma al cliente en el acto y la Main no la rechaza.** Si choca con algo que la Main
  apuntó sin red, la guarda y avisa al restaurante; si no puede registrarla, lo dice y se avisa al
  cliente.
- **Acceso público con una clave por negocio**, pública y revocable, más Turnstile y limitadores. Los
  dominios donde se puede incrustar el widget los fija el proveedor. Las respuestas públicas no
  llevan datos personales.
- **El instante de una reserva web lo pone la agenda**, en la zona horaria del negocio que escribe la
  Main (`Business_Settings.Zona_Horaria`). Es [0004](0004-la-hora-la-pone-quien-escribe.md) aplicado
  a un escritor nuevo: la reserva ocurre en la nube, y la Main copia ese literal.

## Consecuencias

- No cambian el freeze `main_offline`, el escritor único ni el cerrojo de recuperación.
- Hay una segunda clase de Durable Object y una superficie pública nueva, con su propia puerta en
  lugar de `tenantAuth`.
- **Riesgo aceptado:** una mesa vendida dos veces si la Main reserva sin internet (o en el segundo
  que tarda en replicarse). Lo resuelve el restaurante con el aviso.
- Reglas que impone:
  - la agenda no escribe en Turso;
  - el `TenantHub` no atiende tráfico público;
  - la Main nunca rechaza una reserva web confirmada;
  - una reserva pendiente se da por buena al verla en Turso, no cuando la Main acusa recibo.
