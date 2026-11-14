# Pruebas de carga

`pnpm carga` monta un negocio de pruebas con una Main y una Handy sintéticas, lanza un plan de
peticiones variadas de un servicio y mide lo que cuesta en Cloudflare y en Turso. El código está en
[scripts/carga/](../../scripts/carga/) y cada tanda deja su carpeta en `target/carga/`.

## Qué hace una tanda

1. **Preparación**, como el primer día de un bar:
   - licencia de pruebas (`pruebas: true`) y su activación en la Main, que crea la base del negocio
     en su `TenantHub` con el esquema y el administrador inicial;
   - el socket de la Main, que saluda en recuperación como la real (AUD-15: congela a las Handy), y su
     catch-up;
   - la semilla de la Main por el socket, en lotes `apply_lote` como `subir_pendientes`: el PIN del
     administrador, los datos del negocio, 2 categorías, 4 productos, el plano con sus mesas, un
     camarero sin PIN y un cliente; después, `recovery_ready` suelta a las Handy;
   - una Handy emparejada (`create` → `claim` → `approve` → `fetch-token`), su socket y el login del
     camarero.
2. **Carga**: 33 pasos por vuelta, a 1 por segundo:
   - 3 `OPTIONS` que el worker contesta sin base: la referencia de lo que tarda la red en esa tanda;
   - 14 pantallas de la Handy;
   - 10 escrituras suyas: abrir o retomar la mesa, líneas, quitar una, nota, cocina, clientes y
     fichaje;
   - un login con PIN, que es lo que más CPU gasta en el worker;
   - 3 operaciones de la Main por el socket, cada una en su `apply_lote` (abrir mesa, añadir línea y
     cobrar);
   - 2 peticiones de la Main por REST (catch-up e interruptores).

   La Handy trabaja en su mesa y la Main en la 2, para que no se pisen. Los pasos van en serie: si
   uno tarda más de lo que le toca, el siguiente sale en cuanto termina. Con `--vueltas n` el servicio
   se repite sobre el mismo negocio: la Handy abre una mesa nueva en cada vuelta, la Main vuelve a
   abrir y cobrar la suya, y el fichaje sólo va en las dos primeras (entrada y salida: una segunda
   entrada el mismo día sin turno partido es un 409, AUD-47).
3. **Comprobación de la subida** (en local, o en la nube con `--sin-medir`): lo que la Main dio por
   confirmado se contrasta con el log de la nube, leído entero por `/v1/sync/changes` desde 0. Cada
   operación tiene que estar una vez, con el `Seq` de su acuse; a la Handy le tiene que haber llegado
   su `change` una vez, y a la Main ninguno de los suyos. Si no cuadra, la tanda falla. Con la medida
   de Cloudflare no se hace: sus peticiones caerían en el minuto de la carga.
4. **Cierre y medida.** Se cierran los sockets, se mide y, en la nube, se retira el negocio.

Las peticiones son las de la app:
- la firma del dispositivo (`DEVICE_PROOF`), `x-client-now` y `x-idempotency-key`;
- el saludo firmado del socket y el ping exacto `{"type":"ping"}`, que contesta el edge sin
  despertar al `TenantHub`.

Las operaciones de la Main llevan el SQL que sube su outbox (`crates/tpv-infra-sqlite`), con la hora
en literal, en lotes de hasta 200 operaciones y 256 KB de sentencias, y el acuse trae el veredicto
de cada una (aplicada, ya estaba, sin intentar o rechazada). De cada petición se guarda el desglose
de `Server-Timing` que el worker da a un dispositivo autenticado: lo que se fue en la base central y
en el `TenantHub`. Si cambia el formato de la firma, del socket o de una ruta, la tanda recibe un 401
o un rechazo y se para: hay que poner al día `scripts/carga/`. `node --test
scripts/carga/firma.test.mjs` fija la firma contra los valores de `device.rs`.

## En este equipo: `pnpm carga --local`

No sale nada a internet ni gasta cuota.

**Requisitos:**
- `pnpm install`;
- el widget compilado en `apps/reservas-web/dist` (`pnpm --filter @tpv/reservas-web build`);
- la CLI de Turso en el WSL (usa `~/.turso/sqld`).

**Qué monta:**
- Un `sqld` en el WSL con la base central, cargada con `docs/sql/control-plane/esquema-actual.sql`.
- Delante del `sqld`, un proxy que suma las filas leídas y escritas de cada paso. Son las que factura
  Turso, contadas por el mismo motor.
- El worker empaquetado con `wrangler deploy --dry-run` y arrancado con `wrangler dev --local`, sin
  cron, con secretos de usar y tirar y `TURSO_DATABASE_URL` apuntando a la central local.
- La base del negocio es el SQLite de su `TenantHub`, que `wrangler dev` guarda en la carpeta de la
  tanda: el alta la crea igual que en la nube.

Antes de empezar se comprueba que `/health` pasa por la base central local. Al acabar se paran
wrangler y el `sqld` y se borra su base.

**Qué no mide:** la CPU, la duración del Durable Object, sus filas leídas y escritas, la latencia
real ni el coste de los isolates. Hay un solo isolate, así que sus cachés de 60 s hacen que la base
central se lea mucho menos que en la nube.

## En la nube: `node scripts/carga/carga.mjs --nube`

Va contra el worker desplegado (`TPV_API_BASE` o `--base`) con el `ADMIN_API_TOKEN` del `.env` de la
raíz. Mejor con `node` que con `pnpm carga --nube`: en Windows, Ctrl+C sobre pnpm devuelve el prompt
mientras la tanda sigue detrás, y un segundo Ctrl+C la mataría sin limpiar.

**Antes de empezar se niega si:**
- es entre las 06:20 y las 07:30 UTC, porque una tanda con sus medidas puede durar media hora y
  pisaría el cron diario de las 07:00;
- hay licencias de pruebas sin anular, porque la retirada se las llevaría también: es global;
- no puede leer el plan de Turso con la CLI del WSL, o Turso va por encima del 80 % en algo. En el plan
  gratuito, pasarse bloquea todas las bases de la organización, también `tpv-control`;
- la CLI no ve `tpv-control`: estaría mirando otra organización.

**Frenos durante la tanda.** Se para ante cualquiera de estos:
- un 401 o un 403;
- un 5xx en la preparación, o dos en la carga;
- una operación de la Main rechazada;
- las peticiones de `--tope` (150 por defecto) antes de limpiar.

Cada uno de esos fallos manda eventos a Axiom o a Sentry, y por eso no se insiste. Ctrl+C deja de
avanzar, se salta las medidas y va directo a retirar. La limpieza no tiene frenos ni tope, y repite
lo que falle.

**Medida:**
- **Turso**, con `turso db inspect` del WSL. Decide por la base del negocio:
  - espera un minuto y medio y pide tres lecturas iguales seguidas;
  - tras el alta, la base no puede estar a cero; tras la carga, tiene que haber cambiado.

  Se mide siempre antes de retirar, porque una base borrada ya no se puede consultar. `tpv-control`
  se lee a la vez, pero sólo como dato orientativo: es compartida.
- **Cloudflare**, con el GraphQL de analítica y la sesión de wrangler de este equipo
  (`wrangler auth token`, sin dejar el token en los logs de wrangler). Mide cinco ventanas, cada una
  en sus propios minutos porque los Durable Objects se agregan por minuto:
  - la preparación;
  - los minutos entre la preparación y la carga, con la sesión abierta y sin tráfico: lo que cuesta
    una Main conectada sin que nadie toque nada;
  - la carga;
  - el cierre de los sockets, que es coste de la sesión y no de los pasos;
  - una de control sin prueba, que da el ruido de fondo.

  Empieza a leer 5 minutos después de la carga. Da la medida por buena cuando dos lecturas coinciden y
  recogen al menos las peticiones que el generador sabe que mandó. Si no se asienta,
  `pnpm carga --medir <carpeta>` vuelve a medir y rehace el informe.

Las peticiones al worker no salen del GraphQL, que mezcla las invocaciones del Durable Object: las
cuenta el propio generador.

**Limpieza:** `/v1/admin/pruebas/retirar` borra la base de Turso y anula la licencia. El negocio sólo
se da por retirado si la licencia quedó anulada y Turso no devolvió fallos para su base. Si la
activación no llegó a contestar, la base que pudiera haber creado no la ve la retirada: el informe
dice cómo encontrarla. Quedan, como con los E2E, el almacenamiento del Durable Object del negocio y
las filas de `devices` de los dos equipos sintéticos.

`pnpm carga --retirar` lista los negocios de pruebas sin retirar; `pnpm carga --retirar --si` los
retira todos y reintenta las bases que una retirada anterior no pudo borrar.

No se lanza a la vez que una tanda de E2E: cada una retira todos los negocios de pruebas.

## Opciones

| Opción | Qué hace |
|---|---|
| `--ritmo <n>` | Peticiones por segundo de la carga (1 por defecto, 5 como mucho) |
| `--vueltas <n>` | Repite el servicio sobre el mismo negocio (1 por defecto, 20 como mucho); el tope tiene que dar para todas |
| `--tope <n>` | Peticiones como mucho antes de limpiar (150 por defecto, 70 como mínimo) |
| `--sin-retirar` | En la nube, deja vivo el negocio de pruebas |
| `--sin-medir` | En la nube, no espera a medir Turso ni Cloudflare (la cuota de Turso se mira igual) |
| `--medir <carpeta>` | Vuelve a medir Cloudflare de una tanda en la nube |
| `--retirar [--si]` | Lista los negocios de pruebas; con `--si`, los retira todos |

## Lo que deja cada tanda

En `target/carga/<fecha>-<local|nube>/`:
- `informe.md`: el resultado de cada paso, los tiempos por tipo, la subida de la Main (sus lotes y
  el contraste con el log de la nube), el coste y cuántos pasos de esa mezcla caben al mes en lo
  incluido.
- `peticiones.jsonl`: cada petición con su tiempo, su resultado y su `Server-Timing`.
- `estado.json`: los identificadores del negocio, las ventanas de tiempo y lo que dio el contraste.
- En local: `turso-local.json`, `worker.log` y el log del `sqld`.
- En la nube: `coste.json`.
