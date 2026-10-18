# Reservas desde la web

**Estado:** plan aprobado el 2026-10-17, sin implementar.

> Un widget de reservas que cualquier web incrusta con una línea, conectado al TPV, y que acepta
> reservas aunque la Main esté apagada. La decisión de arquitectura y su porqué están en
> [0007](../decisiones/0007-la-reserva-web-no-escribe-en-la-base-del-negocio.md); aquí está el plan
> completo. Al ejecutarse, lo que describe pasa a `arquitectura/reservas-web.md` y este fichero
> desaparece (§15).

---

## 0. Alcance

**Entra:**

- Reserva con confirmación automática desde un widget en iframe. Primero para las webs que hacemos
  nosotros; vale igual para cualquier otra que pegue la línea.
- El cliente elige día, hora de llegada y personas, y después la mesa en el plano.
- En el TPV: qué mesas se pueden reservar y cuándo, días cerrados, interruptor general y el código
  para la web.
- Entrega de las reservas a la Main, cancelación por el cliente y correos.

**Queda fuera por ahora** (se decide cuando haga falta): página propia por negocio, plugin de
WordPress (fase 7), paquete npm o SDK, que el cliente modifique su reserva, juntar mesas, señal o
depósito, recordatorios, otros idiomas, tema del widget configurable desde el TPV y panel de
administración propio (mientras tanto, el CLI).

---

## 1. Lo decidido

| Tema | Decisión |
|---|---|
| Confirmación | Automática. El bar no acepta ni rechaza nada |
| Qué se reserva | Una mesa concreta, con la capacidad que tiene en el plano |
| Mesas que se ofrecen | Reservables desde la web, con capacidad entre N y N + 2 (N = personas), libres durante toda la reserva y sin comanda abierta |
| Duración | La del negocio (`Business_Settings.Reserva_Duracion_Min`). No hay una duración propia para la web |
| Qué mesas y cuándo | En el editor del plano, por mesa: casilla «Reservable desde la web», días de la semana, fechas opcionales (calendario) y franja horaria |
| Hora de llegada | La elige el cliente, al minuto, dentro de lo permitido |
| La franja | La reserva entera tiene que caber, con 20 minutos de tolerancia en cada extremo. Franja 12:00–16:00 y 2 h de duración: se puede llegar de 11:40 a 14:20 |
| Antelación | Desde mañana (día natural; hoy no se reserva para hoy) hasta 30 días vista |
| Días cerrados | Fechas sueltas en Configuración → Reservas, para todo el negocio |
| Interruptores | Uno general (Configuración) y uno por mesa (editor del plano) |
| Datos del cliente | Nombre, correo y teléfono obligatorios; nota opcional. Se piden **al final**, cuando ya se sabe que hay mesa |
| Ficha de cliente | Si el correo ya es de un cliente, la reserva es suya y lo escrito sólo rellena sus huecos (RES-01). Si no, cliente nuevo |
| Límite por cliente | 10 reservas activas por correo y negocio |
| Sin mesa a esa hora | El widget propone horas cercanas que sí tienen |
| Cancelación por el cliente | Desde el enlace del correo, hasta la hora de la reserva. Pasada la hora, el bar la da por no presentada |
| Mesa pisada al entregarla | La Main la guarda igualmente y avisa al restaurante para que la mueva |
| La Main no puede registrarla | Correo al cliente; la solución la decide el restaurante |
| El restaurante cambia una reserva web | Doble confirmación en el TPV y correo al cliente. Borrar una reserva web la **cancela** (§5.6) |
| Avisos al restaurante | Sólo las notificaciones de la app |
| Main apagada o recuperándose | La web sigue aceptando; lo único que espera es la entrega |
| Precio | Incluido en la licencia |
| Dirección | La del worker, `tpv-api.altarialights.workers.dev`. ⚠️ Queda pegada en cada web: cambiarla después obliga a tocarlas todas |
| Idioma | Español |
| Dónde se puede incrustar | Lista de dominios por negocio que gestiona el proveedor (CLI), no el bar |

Los valores numéricos (tolerancia, margen de plazas, días de antelación y de horizonte) se guardan
como ajustes del negocio con esos valores por defecto, para que hacerlos configurables desde el TPV
sea sólo añadir la pantalla.

---

## 2. Arquitectura

```
web del restaurante
  └─ <div data-negocio="rw_…"> + embed.js ──iframe──► /reservas-web/v1/w/rw_… (widget)
                                                         │
                                       rutas públicas /v1/publico/reservas/rw_…/*
                                          │                        │
                         lee Turso (plano, ajustes)        AgendaWeb (DO por negocio)
                                                           · decide la mesa y la guarda en su SQLite
                                                           · lee Turso, nunca escribe en él
                                                                   │ avisarReservasWeb()
                                                                   ▼
                                                           TenantHub ──{"type":"reservas_web"}──► Main
                                                                                                   │
                                     POST /v1/reservas-web/pendientes y /recogidas ◄───────────────┘
                                     la Main la registra con su caso de uso → outbox → TenantHub → Turso
```

| Pieza | Dónde | Qué hace |
|---|---|---|
| Widget | `apps/reservas-web/` (nuevo), servido por el worker | Las pantallas de reservar y de cancelar |
| Script de inserción | `apps/reservas-web/` → `embed.js` | Mete el iframe en la web y le ajusta la altura |
| Plano compartido | `packages/plano/` (nuevo) | El plano de la Main, usado también por el widget |
| Estilos compartidos | `packages/estilos/` (nuevo) | Los tokens de color de `Global.css` |
| Rutas públicas | `domains/reservas_web/publico.routes.ts` | Lo que llama el widget, con la clave del negocio |
| Rutas de la Main | `domains/reservas_web/main.routes.ts` | Clave, recogida de pendientes y avisos al cliente |
| La agenda | `durableObjects/agendaWeb*.ts` (nuevo DO `AgendaWeb`) | Disponibilidad, reparto de mesas, pendientes y enlaces de cancelar |
| `TenantHub` | `tenantHub.ts` / `tenantHub.motor.ts` | Sólo un RPC nuevo: avisar a la Main |
| Main | `use_cases/reservas_web.rs`, motor de réplica, `tpv-infra-sqlite/src/reservas_web.rs` | Recoge, registra, avisa al restaurante y encola los correos de cambios |
| Base central | `reserva_web_claves`, `reserva_web_dominios` | Qué clave es de qué negocio y dónde se puede incrustar |

### Reglas que no se rompen

1. **La agenda nunca escribe en Turso.** La base del negocio se sigue escribiendo sólo por el
   `TenantHub`, como hoy.
2. **La reserva la registra la Main**, con su caso de uso y su outbox.
3. **La Main nunca rechaza una reserva web confirmada.** Si choca con algo, la guarda y avisa; si no
   puede registrarla, lo dice para que se avise al cliente.
4. **El `TenantHub` no atiende tráfico público**: sólo recibe el aviso de la agenda.
5. **Una reserva pendiente ocupa su mesa hasta que aparece en Turso**, no hasta que la Main acusa
   recibo: entre una cosa y otra sólo existe en el outbox de la Main (la misma lección que el volcado
   del atraso, SYNC-18).
6. **Las respuestas públicas no llevan datos personales** de ninguna reserva.
7. **No cambian** el freeze `main_offline`, el escritor único ni el cerrojo de recuperación.

### Los recorridos

**Consultar.** El widget pide el negocio, el plano y las horas válidas de un día directamente a
Turso (no pasan por la agenda: no dependen de lo pendiente). Para saber qué mesas están libres
pregunta a la agenda, que suma lo que hay en Turso y lo pendiente.

**Reservar.** El widget manda la mesa elegida con los datos y el token de Turnstile. La agenda vuelve
a comprobar que la mesa sigue libre, la guarda como pendiente con un `ID_Reserva` (UUIDv7) que
genera ella, crea el enlace de cancelar y responde. El worker manda el correo de confirmación y la
agenda avisa al `TenantHub`. El cliente tiene su reserva confirmada aunque la Main esté apagada.

**Entregar.** Con la Main conectada, el aviso llega en el momento. La Main pide las pendientes por
REST, registra cada una en su base (reserva y cliente), devuelve el resultado de cada una y las sube
por su outbox. La agenda las da por vistas cuando aparecen en Turso. Si la Main estaba apagada, las
recoge al conectar.

**Cancelar.** El enlace del correo abre la página de cancelar, que pide confirmación. Si la reserva
aún no se ha entregado, la agenda la anula sin la Main. Si ya está en la Main, la agenda guarda una
petición de cancelación que se entrega igual que un alta. El cliente recibe la confirmación en el
acto.

**El restaurante cambia una reserva web.** En el TPV, con doble confirmación. La Main encola un
aviso; un job lo manda al worker cuando hay conexión, y el worker envía el correo al cliente.

**Cuándo se pisa una mesa.** Sólo si la Main apunta una reserva sin internet (no llega a la nube
hasta que vuelve la conexión) o en el segundo que tarda en replicarse. Es un riesgo aceptado:
la Main avisa al recibir la reserva web.

---

## 3. Datos

### 3.1 Base del negocio

Todo entra en `0001_inicial.sql` (decidido el 2026-10-17: se consolida y se resetean las bases de
desarrollo, como en la última consolidación).

| Cambio | Detalle |
|---|---|
| `Reservas.Origen` | `TEXT NOT NULL DEFAULT 'TPV'`, valores `TPV` y `WEB` con su trigger `ri48_*` (RI-48). Los `ON CONFLICT … DO UPDATE` de la Main y del worker no la tocan: editar una reserva web no la convierte en una del TPV |
| `Business_Settings.Reserva_Web_Activa` | `INTEGER NOT NULL DEFAULT 0`, 0/1. El interruptor general |
| `Business_Settings.Reserva_Web_Dias_Min` | `INTEGER NOT NULL DEFAULT 1`. 1 = desde mañana |
| `Business_Settings.Reserva_Web_Dias_Max` | `INTEGER NOT NULL DEFAULT 30` |
| `Business_Settings.Reserva_Web_Margen_Min` | `INTEGER NOT NULL DEFAULT 20`. Tolerancia de la franja |
| `Business_Settings.Reserva_Web_Margen_Plazas` | `INTEGER NOT NULL DEFAULT 2`. De N a N + 2 |
| `Business_Settings.Zona_Horaria` | `TEXT NOT NULL DEFAULT 'Europe/Madrid'`. La escribe la Main (§5.3) |
| `Reserva_Web_Mesas` | `ID_Mesa TEXT NOT NULL PRIMARY KEY` → `Mesas` `ON DELETE CASCADE`; `Activa INTEGER NOT NULL DEFAULT 0` (0/1). La casilla de cada mesa |
| `Reserva_Web_Franjas` | `ID_Franja TEXT NOT NULL PRIMARY KEY`; `ID_Mesa` → `Mesas` `ON DELETE CASCADE`; `Dias_Semana INTEGER NOT NULL DEFAULT 127` (máscara: 1 lunes … 64 domingo, entre 1 y 127); `Fecha_Desde` y `Fecha_Hasta` `TEXT` opcionales; `Hora_Desde` y `Hora_Hasta` `TEXT NOT NULL` (`HH:MM`, desde < hasta). Índice por `ID_Mesa`. El esquema admite varias por mesa; la pantalla edita una |
| `Reserva_Web_Cierres` | `ID_Cierre TEXT NOT NULL PRIMARY KEY`; `Dia_YMD TEXT NOT NULL UNIQUE`; `Motivo TEXT` |
| `_Reservas_Web_Avisos` (§16, local) | La cola de correos de cambios de la Main: `ID_Aviso TEXT NOT NULL PRIMARY KEY`, `ID_Reserva`, `Tipo`, `Datos_Json`, `Creado_Ms`, `Intentos`, `Ultimo_Error`. Se escribe por `raw()` y no se replica |

- Una franja vale para un día si el día de la semana está en la máscara **y** el día cae entre
  `Fecha_Desde` y `Fecha_Hasta` (cuando las hay).
- Las columnas `INTEGER` que no son dinero se declaran en
  `migrations.rs::todas_las_columnas_de_dinero_llevan_su_check`.
- `Reserva_Web_Mesas`, `Reserva_Web_Franjas` y `Reserva_Web_Cierres` se añaden a
  `lib/hub.ts::TABLAS_SOLO_MAIN`: la Handy no las escribe. Borrar una mesa desde la Handy sigue
  llevándose su configuración por la cascada, porque eso no es una sentencia suya.
- `ReservaDto` gana `origen`, en las dos lecturas del calendario (Main y `reservas.queries.ts::mes`).
- Pasos de siempre ([esquema.md](../arquitectura/esquema.md#cambiar-el-esquema)): `tenantMigrations.ts`,
  `test/helpers/esquemaTenant.ts`, la foto (`BLESS_SCHEMA_SNAPSHOT=1 …`), el reset de las bases de
  desarrollo (Turso y `data.db`) y desplegar el worker antes que la Main.

### 3.2 Base central

A mano en Turso antes de desplegar la fase 2, y reflejado en
[esquema-actual.sql](../sql/control-plane/esquema-actual.sql).

| Tabla | Columnas |
|---|---|
| `reserva_web_claves` | `clave TEXT PRIMARY KEY` (`rw_` + 128 bits aleatorios en base64url), `tenant_id TEXT NOT NULL` → `tenants` `ON DELETE CASCADE`, `created_at_ms`, `revoked_at_ms`. Índice por `tenant_id`. Una activa por negocio |
| `reserva_web_dominios` | `tenant_id`, `origen TEXT` (esquema + host + puerto, p. ej. `https://www.barpepe.es`), `created_at_ms`, `PRIMARY KEY (tenant_id, origen)` |
| `email_sends` | Columna nueva `tipo TEXT NOT NULL DEFAULT 'pedido'` (`pedido` o `reserva_web`). El tope de 100 diarios de los pedidos cuenta sólo los suyos. Los correos públicos llevan `device_id = 'web'` |

La administración va por `/v1/admin/reservas-web/:tenantId` (token de administración, todo a
`admin_audit`; `domains/reservas_web/admin.routes.ts`) y por `pnpm reservas-web:ver`,
`reservas-web:dominio-poner`, `reservas-web:dominio-quitar` y `reservas-web:revocar-clave`
(`scripts/tpv-license.mjs`, `--tenant <id> [--origen https://…]`). Un origen es esquema, host y
puerto, sin ruta: `https`, o `http://localhost` / `http://127.0.0.1` para desarrollar.

### 3.3 Almacén de la agenda

El SQLite del propio DO, creado por la agenda con su número de versión (no es una base de tenant ni
pasa por las migraciones).

| Tabla | Columnas |
|---|---|
| `peticiones` | `id_peticion` (UUIDv7), `tipo` (`alta` o `cancelacion`; una de cada como mucho por reserva), `id_reserva`, `id_mesa`, `dia_ymd`, `hora`, `comensales`, `email_hash` (SHA-256 del correo en minúsculas, para contar sin leer `datos_json`), `datos_json` (nombre, correo, teléfono y nota; sólo en un alta), `creada_local` (instante del negocio, §4.3), `creada_ms`, `estado` (`pendiente`, `entregada`, `vista`, `fallida`, `anulada`), `entregada_ms`, `intentos`, `cerrada_ms` (cuándo pasó a `vista`, `fallida` o `anulada`; de ahí cuentan los 7 días) |
| `enlaces` | `token_hash` (SHA-256 del token del enlace de cancelar), `id_reserva`, `caduca_ms` |
| `estado` | Clave y valor: la versión del esquema de la agenda |

Ciclo de una petición:

- `pendiente` → `entregada` cuando la Main la recoge.
- `entregada` → `vista` cuando el `ID_Reserva` aparece en Turso (en las lecturas del día, en
  `pendientes` y en la alarma). Al pasar a `vista` se borra `datos_json` y, a los 7 días, la fila.
- `entregada` sin aparecer en Turso en una hora → vuelve a `pendiente`. La Main la registra otra vez
  sin duplicarla (el `INSERT` es idempotente por `ID_Reserva`); cubre una Main que perdió su base o
  un outbox atascado.
- `fallida` (la Main no pudo registrarla) → correo al cliente y se borra `datos_json`.
- `pendiente` → `anulada` si el cliente la cancela antes de que la Main la recoja: se borra
  `datos_json` y la mesa queda libre en el acto.
- Los enlaces caducan un día después de la reserva (con margen por la zona: 36 h desde su hora).
- Todo está en `durableObjects/agendaWeb.almacen.ts`, síncrono a propósito.

Los datos personales sólo están en la agenda mientras la reserva espera.

---

## 4. La nube

### 4.1 La puerta pública

Las rutas públicas no llevan `tenantAuth`: no hay dispositivo ni token. El negocio sale de la clave
del camino (`:clave`), y todo lo que decide va en middlewares **delante** del validador del cuerpo
([worker.md](../arquitectura/worker.md#cómo-se-escribe-una-ruta)):

1. **Limitador por IP** `LIMITADOR_RESERVA_WEB`, el primero: es lo más barato y frena un barrido
   de claves inventadas antes de que llegue a la base central (`reserva_web_demasiadas`, 429).
2. **Resolver la clave** en `reserva_web_claves` (caché de 60 s por isolate). Sin clave o revocada:
   `reserva_web_no_disponible`.
3. **El negocio está activo (`tenants.status`) y tiene una licencia en vigor**:
   `licenciaEnUso.ts::negocioConLicenciaEnVigor`, con el mismo criterio que `vetoDeLicencia` (la
   gracia por caducidad pasa) y la licencia vista desde su Main.
4. **El interruptor `reservas_web`** no está apagado para ese negocio ni para todos (§4.7).
5. **En el alta, su limitador** `LIMITADOR_RESERVA_WEB_ALTA` **y Turnstile**: el token viaja en la
   cabecera `X-Turnstile-Token`, para comprobarlo antes de leer el cuerpo; se verifica contra
   `siteverify` con la IP del cliente. Sin `TURNSTILE_SECRET_KEY`, el alta queda cerrada (503).

Del 2 al 4 el rechazo es siempre el mismo `reserva_web_no_disponible` (404): al widget le basta con
«ahora no se puede reservar online» y el motivo queda en el log. Todo está en
`domains/reservas_web/puerta.ts`.

Después, `cuerpo(schema)` / `consulta(schema)` como en todas las rutas. Los nombres de estos
middlewares se añaden a `VETOS` en `test/vetoAntesDelCuerpo.test.ts`. El interruptor general del
negocio (`Reserva_Web_Activa`) se lee de Turso: `/negocio` contesta `reserva_web_cerrada` y el alta
también.

Sin CORS: el widget se sirve desde el mismo origen que la API (§4.6), así que las rutas públicas no
necesitan cabeceras CORS y no hay que abrirlas a ningún origen.

### 4.2 Rutas públicas — `/v1/publico/reservas/:clave/…`

| Ruta | Lee | Devuelve |
|---|---|---|
| `GET /negocio` | Turso | Nombre, dirección, teléfono y logo; responsable para el aviso de privacidad (`Razon_Social`, `CIF`); hoy en la hora del negocio; primer y último día reservables; días abiertos del horizonte (con alguna franja y sin cierre); máximo de personas (la mayor capacidad reservable); duración; la clave pública de Turnstile |
| `GET /dia?dia=` | Turso | Los tramos de hora de llegada válidos ese día (la unión de las franjas, con la tolerancia y la duración) |
| `GET /plano` | Turso | Salones (id, nombre, `Room_Points`) y mesas (id, número, forma, posición, tamaño, capacidad, si es reservable). Caché corta |
| `GET /disponibles?dia=&hora=&personas=` | Agenda | Las mesas libres y adecuadas. Si no hay ninguna, `alternativas`: hasta 4 horas a ±15, 30, 45 y 60 minutos que sí tienen mesa |
| `POST /reservas` | Agenda | `{ codigo, dia, hora, personas, mesa }`. El token del enlace sólo viaja en el correo |
| `POST /reserva` `{ token }` | Agenda y Turso | El resumen para la página de cancelar: día, hora, personas, mesa, estado y si aún se puede cancelar |
| `POST /cancelar` `{ token }` | Agenda | `{ ok }` |

`/reserva` va por POST para que el token no aparezca en ninguna URL ni en ningún log.

Identificadores de error nuevos, todos en `MENSAJES` (`lib/errorCodes.ts`) con su frase:
`reserva_web_no_disponible`, `reserva_web_demasiadas`, `reserva_web_cerrada`, `dia_no_reservable`, `hora_fuera_de_franja`,
`mesa_no_disponible` (409; el widget vuelve a pedir las disponibles), `limite_reservas_correo`,
`tope_reservas_negocio`, `verificacion_humana_fallida`, `reserva_no_cancelable` y `enlace_no_valido`.
Los de la agenda salen con su estado (`agendaWeb.motor.ts::STATUS`): 400 el día o la hora que no
valen, 409 lo que choca con el estado (`reserva_web_cerrada`, la mesa, el tope por correo, la que ya
no se puede cancelar), 429 el tope del negocio y 404 el enlace. El `codigo` del alta son los seis
últimos caracteres del `ID_Reserva`: una referencia corta para hablar con el restaurante.

La entrada del alta tiene su dominio en
[validacion_casos.json](../../crates/tpv-domain/src/validacion_casos.json) (`reserva_web`): el schema
del worker y la validación de `tpv-domain`, que la Main repite al registrarla, aceptan y rechazan lo
mismo.

### 4.3 La agenda (`AgendaWeb`)

- **Clase nueva**, en el mismo worker ([0006](../decisiones/0006-un-solo-worker.md)): migración
  `v2` con `new_sqlite_classes: ["AgendaWeb"]` en `wrangler.json`, binding `AgendaWeb`, una
  instancia por negocio (`idFromName(tenantId)`). Instrumentada con Sentry como el `TenantHub`.
- **Sin WebSockets**: atiende la petición y se duerme. Mientras duerme sólo cuenta lo que ocupa.
- **RPC**: `disponibles`, `reservar`, `consultarEnlace`, `cancelar` (para las rutas públicas),
  `pendientes` y `recogidas` (para las rutas de la Main). Los errores de negocio cruzan como resultado
  tipado, igual que `ResultadoAplicacion`.
- **Lee Turso** con el mismo resolutor de credenciales que el REST, y fija `'now'` con la hora local
  del negocio (`Zona_Horaria`), con la misma reescritura que `tenantQuery`.
- **Sin estado en campos de instancia que importe ni variables de módulo con estado**, por las mismas
  razones que el `TenantHub` ([sincronizacion.md](../arquitectura/sincronizacion.md#hibernación-del-durable-object-sync-16)).
- **Una sola alarma**, que se reprograma mientras haya algo que hacer: volver a ofrecer las
  `entregada` de más de una hora, purgar y caducar enlaces.

**Qué mesas valen** para el día D, la hora H y N personas:

1. D está entre hoy + `Dias_Min` y hoy + `Dias_Max` (hoy en la zona del negocio) y no está en
   `Reserva_Web_Cierres`. `Reserva_Web_Activa = 1`.
2. La mesa y su zona no están archivadas, tiene `Reserva_Web_Mesas.Activa = 1` y su capacidad está
   entre N y N + `Margen_Plazas`.
3. Alguna de sus franjas vale para D (§3.1) y `Hora_Desde − margen ≤ H` y
   `H + duración ≤ Hora_Hasta + margen`, con fechas y horas reales (una reserva puede pasar de la
   medianoche).
4. No choca con ninguna reserva de Turso: **el mismo SQL** que `SQL_CHOQUE_RESERVA` y
   `SQL_CHOQUE_COMANDA` de la Main, que ya existe en el worker (`reservas.queries.ts::choqueEnLaMesa`).
   Se leen las reservas de D y de D − 1, por las que cruzan la medianoche.
5. No choca con ninguna petición de alta de la agenda en `pendiente` o `entregada` que aún no esté en
   Turso.

**Reservar**:

1. Validar la entrada (§4.2) y el día y la hora (1 y 3).
2. Leer de Turso lo del día y comprobar la mesa elegida (2 a 4).
3. Topes exactos: 10 reservas activas por correo (las de Turso desde hoy con ese correo, más las
   pendientes con su `email_hash`) y un tope de altas por negocio en 24 h. Son el control exacto que
   va detrás del limitador por IP, como pide `lib/limitador.ts`.
4. **En un bloque síncrono sobre el SQLite de la agenda, sin ningún `await` en medio:** volver a
   comprobar el punto 5 e insertar la petición y el enlace. Dos altas a la vez para la misma mesa:
   gana una y la otra recibe `mesa_no_disponible`. Lo que se lee de Turso puede tener un segundo de
   retraso respecto a la Main; eso es el riesgo aceptado del §2.

   Las altas de la agenda que cuentan son las que la lectura de Turso de esa petición no trae, y
   también las que otra petición dio por `vista` desde un minuto antes de empezar a leer
   (`Lectura` en `agendaWeb.almacen.ts`): sin eso, una petición que leyó Turso antes de que llegara
   un alta, y que se resuelve después de que otra la viera, no la encontraría en ningún sitio y se
   llevaría su mesa. Lo mismo para el tope por correo.
5. `creada_local` es el instante del alta en la zona del negocio: es el `Created_At` que escribirá
   la Main. La hora la pone quien escribe, y el instante de una reserva web ocurre aquí.
6. Avisar al `TenantHub` (sin esperar respuesta ni fallar si no contesta) y devolver el resultado.

### 4.4 El `TenantHub`

Un único cambio: el RPC `avisarReservasWeb()`, que manda `{"type":"reservas_web"}` a los sockets
autenticados con rol `tpv`. No guarda nada y no pasa nada si no hay Main. Es el mismo patrón que
`avisarEmparejamiento`.

### 4.5 Rutas de la Main — `/v1/reservas-web/…`

Todas por `tenantAuth`.

| Ruta | Veto | Qué hace |
|---|---|---|
| `POST /clave` | `soloLaMain` | Devuelve la clave activa del negocio o crea una. La Main la pide desde Configuración (sólo administrador) |
| `POST /pendientes` | `soloLaMain` | Las peticiones `pendiente` de la agenda, que pasan a `entregada` |
| `POST /recogidas` | `soloLaMain` | El resultado de cada una: `registrada`, `solapada` o `fallida`. Una `fallida` dispara el correo al cliente |
| `POST /avisos` | — (Main o Handy) | El correo al cliente por un cambio del restaurante (§5.7) |

Pedir la clave sólo es posible desde una Main que ya sabe recoger reservas web: si un negocio tiene
clave, su Main sabe recibirlas. No hace falta comprobar versiones.

`/avisos` lleva `id_aviso`, `id_reserva`, `tipo` (`modificada` o `cancelada`) y los datos nuevos
(día, hora, personas, mesa). El destinatario **no** viene en el cuerpo: es el correo del cliente de
esa reserva en Turso, y sólo si es `Origen = 'WEB'` (acotado a quién, como los pedidos con
FABLE-C). Es idempotente por `id_aviso` (`email_sends.id`). Si la reserva aún no está en Turso,
contesta 404 y la Main reintenta.

### 4.6 El widget, servido por el worker

Workers Static Assets en el mismo worker, con lo compilado de `apps/reservas-web/`:

| Ruta | Qué es | Caché |
|---|---|---|
| `/reservas-web/v1/embed.js` | El script de inserción | Corta (minutos): es lo que hace que un cambio llegue a todas las webs |
| `/reservas-web/v1/w/:clave` | El HTML del widget (y `…/cancelar`), servido por el worker para poner la CSP | Sin caché |
| `/reservas-web/assets/*` | JS y CSS con huella en el nombre | Inmutable |

CSP del HTML: `default-src 'self'`; `script-src 'self' https://challenges.cloudflare.com`;
`frame-src https://challenges.cloudflare.com`; `style-src 'self'`; `img-src 'self' data:` (el logo
es un `data:`); `connect-src 'self'`; y **`frame-ancestors` con los orígenes de
`reserva_web_dominios` del negocio** (sin ninguno, `'none'`: el widget no se puede incrustar hasta
dar de alta la web). Para desarrollar, se da de alta `http://localhost:<puerto>`.

Una clave que no existe da una página «Reservas no disponibles».

### 4.7 Interruptor remoto `reservas_web`

Una variante nueva en `Interruptor` (`tpv-contracts/src/interruptores.rs`) y en `INTERRUPTORES`
(`lib/interruptores.ts`). Sólo lo mira el worker, como `cola_do`. Apagado para un negocio o para
todos, cierra las rutas públicas sin desplegar; la entrega a la Main y el TPV siguen igual.

### 4.8 Correos

Desde el worker, con el binding `EMAIL`:

- Remitente `EMAIL_RESERVAS_FROM_ADDRESS` (`reservas@altarialights.com`) con el nombre del negocio, y
  `Reply-To` el `Contact_Settings.Contact_Email` del negocio si lo tiene.
- **Sólo datos estructurados**: negocio, dirección, teléfono, día, hora, personas y mesa. Nada que
  haya escrito el visitante, tampoco su nombre: un formulario público que mete texto libre en un
  correo de nuestro dominio es una vía de spam.
- Trazas en `email_sends` con `tipo = 'reserva_web'`; tope diario por negocio y por destinatario.
- **Un correo que falla no deshace la reserva**: se registra y la reserva sigue confirmada.

| Correo | Cuándo |
|---|---|
| Confirmación, con el enlace de cancelar | Al reservar |
| Cancelación confirmada | Al cancelar desde el enlace |
| Reserva modificada | El restaurante cambia día, hora, personas o mesa (§5.6) |
| Reserva cancelada por el restaurante | El restaurante la cancela o la borra |
| No se pudo registrar | La Main devuelve `fallida`: el restaurante se pondrá en contacto |

El enlace de cancelar es `/reservas-web/v1/w/<clave>/cancelar#t=<token>`. El token va en el
fragmento, que el navegador no manda al servidor, y la página pide pulsar un botón: los filtros de
correo abren los enlaces, así que abrirlo no puede cancelar nada (lo mismo que con el código del PIN).

---

## 5. La Main

### 5.1 Configuración → Reservas

Un bloque nuevo, «Reservas desde la web», sólo para el administrador, debajo de lo que ya hay
(duración y solape):

```
┌ Reservas desde la web ──────────────────────────────────────────┐
│ Aceptar reservas desde la web               [■■■□] Activado     │
│                                                                 │
│ Código para tu web                                              │
│ ┌─────────────────────────────────────────────────┐ [Copiar]    │
│ │ <div data-negocio="rw_…"></div><script src=…>   │             │
│ └─────────────────────────────────────────────────┘             │
│                                                                 │
│ Días cerrados                                   [+ Añadir día]  │
│   24/12/2026  Nochebuena                              [Quitar]  │
│   31/12/2026                                          [Quitar]  │
└─────────────────────────────────────────────────────────────────┘
```

Sin clave todavía, en lugar del código sale «Generar código» (llama a `POST /v1/reservas-web/clave`).
La zona horaria no se enseña.

### 5.2 Editor del plano

Hoy el editor sólo añade y borra mesas. Se añade un modo **«Reserva web»**, como el de borrar: con él
armado, pulsar una mesa abre su configuración (y la mesa no se arrastra). Sólo en la Main:

```
┌ Mesa 5 ────────────────────────────────────────┐
│ ☑ Se puede reservar desde la web               │
│                                                │
│ Días      [L] [M] [X] [J] [V] [S] [D]          │
│ Fechas    desde [ 01/11/2026 ▾]  hasta [ — ▾]  │
│ Horario   de [12:00]  a [16:00]                │
│                                                │
│                     [Cancelar]  [Aceptar]      │
└────────────────────────────────────────────────┘
```

- Se guarda al pulsar «Guardar» en el modal (`reserva_web_guardar_mesa`), aparte del «Guardar
  layout»: no es la forma del plano. Lo puede quien edita el plano (`plano.gestionar`); el
  interruptor general y los días cerrados son del administrador.
- Una mesa recién añadida se configura después de guardar el plano: hasta entonces no tiene
  `ID_Mesa`, y el modal lo dice.
- Las mesas reservables llevan un punto del color de acento en el editor.

### 5.3 La zona horaria

Al arrancar, si `Business_Settings.Zona_Horaria` no coincide con la zona IANA del sistema (crate
`iana-time-zone`, que ya está en el árbol por `chrono`), la Main la escribe por `WriteGuard` y se
replica. La agenda la lee de Turso.

### 5.4 Recoger las reservas web

En el motor de réplica (`use_cases/replicacion.rs`), no como job periódico:

- Después del catch-up y la subida iniciales (si no se está recuperando).
- Al completar una recuperación.
- Al recibir `{"type":"reservas_web"}` en `atender`.

Cada vez: `POST /v1/reservas-web/pendientes` → registrar cada petición en orden (§5.5) →
`POST /v1/reservas-web/recogidas`. Las escrituras salen por el outbox en la vuelta siguiente del
motor. Durante una recuperación no se recoge nada (el cerrojo de `Db` lo impediría igualmente).

### 5.5 Registrar una reserva web

Un caso de uso propio (`tpv-application/src/use_cases/reservas_web.rs`), no `reservas::guardar`
(que trata un `id_reserva` como una edición). Una transacción local, capturada por `WriteGuard`:

- **Alta:**
  - Cliente: si ya hay uno con ese correo (`ux_clientes_email`), la reserva es suya y lo escrito
    rellena sus huecos (RES-01). Si no, un cliente nuevo con nombre, teléfono y correo, con su UUID
    antes del `INSERT`.
  - `INSERT INTO Reservas … ON CONFLICT(ID_Reserva) DO NOTHING` con el id de la agenda,
    `Origen = 'WEB'`, `Estado = 'PROXIMA'`, la mesa, `Duracion_Min = NULL` (la del negocio), la nota y
    `Created_At = creada_local`. Recibirla dos veces no la duplica.
  - Si choca con algo (el mismo `choque_en_la_mesa`), se guarda igual, aunque el negocio tenga
    prohibidos los solapes, y el resultado es `solapada`.
  - Vuelve a validar con `tpv-domain`. Lo que no pase (un bug, un dato imposible) es `fallida`, con su
    código.
- **Cancelación:** `Estado = 'CANCELADA'` si estaba `PROXIMA` o `ACTIVA`. Idempotente.

Notificaciones (a los administradores, como la de «Nueva reserva»):

| Tipo | Severidad | Texto |
|---|---|---|
| `reserva_web_nueva` | Info | «Nueva reserva web · Ana · 24/10 21:00 · Mesa 5» |
| `reserva_web_solapada` | Aviso | «Reserva web en una mesa ocupada: muévela» |
| `reserva_web_cancelada` | Info | «El cliente ha cancelado su reserva web» |
| `reserva_web_fallida` | Error | «No se pudo registrar una reserva web», con el contacto del cliente para llamarle |

### 5.6 El calendario de reservas

- Una etiqueta «Web» en las reservas con `origen = 'WEB'`.
- Al cambiar día, hora, personas o mesa, o al cancelar o borrar una reserva web, una doble
  confirmación: «Esta reserva se hizo desde la web. Se enviará un correo al cliente con el cambio.
  ¿Seguro?».
- **Borrar una reserva web la cancela** (`Estado = 'CANCELADA'`) en vez de borrar la fila: queda
  constancia, la agenda libera la mesa al verlo en Turso y el correo del cliente se sigue pudiendo
  leer de la reserva. Es una decisión de este plan; si se prefiere borrar, el correo tendría que
  salir antes de que el borrado llegue a la nube.

### 5.7 Avisar al cliente de un cambio

- `reservas::guardar` y `reservas::eliminar`: si la reserva es web y cambia algo de lo del §5.6,
  llaman al puerto nuevo `AvisosReservaWeb::encolar`, con su implementación por modo (como el
  `Notifier`).
- **Main:** fila en `_Reservas_Web_Avisos` por `raw()` y un job nuevo `avisos_reserva_web` en
  `jobs/registro.rs` (cada minuto, con conexión) que la manda a `POST /v1/reservas-web/avisos`. Un 404
  se reintenta durante 24 h; después se descarta y queda en el log.
- **Handy:** la llamada directa, que siempre tiene red.

---

## 6. La Handy

- Ve las reservas web con su etiqueta (el calendario es el mismo).
- Cambia o cancela una reserva web con la misma doble confirmación; su aviso sale directo.
- No ve la configuración de la web (ni en el editor ni en Configuración), y el worker veta sus
  tablas.
- Sin Main sigue congelada como hoy. No cambia nada más.

---

## 7. El widget

### 7.1 La aplicación

`apps/reservas-web/`: React 19, Vite y Tailwind 4, como el frontend de la Main. Sin router (dos
vistas: reservar y cancelar) y sin estado global. Llama a la API con `fetch` a rutas relativas: es
el mismo origen.

- **`packages/plano/`**: `MapCanvas`, `TableNode` y la geometría de `features/mesas/`, sin
  `useTheme` ni `MesaMetaOut`: los colores y el estado de cada mesa (libre, ocupada, seleccionada, no
  disponible) llegan por props. Lo usan la sala de la Main y el widget: un solo plano.
- **`packages/estilos/`**: los tokens de color de `Global.css` (fondos, bordes, texto, acento,
  semáforos y `@theme inline`), importados por la Main y por el widget. El widget usa el tema claro.
- Mismas formas que la app: tarjetas `bg-surface` con `rounded-2xl` y `border-border`, botón principal
  `bg-accent` con `text-accent-fg`, texto secundario `text-fg-muted`, estados con `success`, `warning`
  y `danger`.

### 7.2 Pantallas

```
1 · Cuándo                       2 · Mesa                          3 · Tus datos
┌──────────────────────────┐    ┌──────────────────────────┐      ┌──────────────────────────┐
│ Bar Pepe                 │    │ Vie 24 oct · 21:00 · 4 p │      │ Vie 24 · 21:00 · Mesa 5  │
│ ‹  octubre 2026  ›       │    │ [Interior] [Terraza]     │      │ Nombre    [__________]   │
│ L  M  X  J  V  S  D      │    │ ┌──────────────────────┐ │      │ Correo    [__________]   │
│       1  2  3  4  5      │    │ │  ▢   ◯5   ▢    ◯     │ │      │ Teléfono  [__________]   │
│ 6  7  8  9 10 11 12 ...  │    │ │  ◯   ▢    ◯7   ▢     │ │      │ Nota      [__________]   │
│ Personas   [-] 4 [+]     │    │ └──────────────────────┘ │      │ ☐ He leído la información│
│ Llegada    [21:00]       │    │ Mesas libres: 5 · 7      │      │   sobre privacidad       │
│ (de 13:40 a 14:20 y de   │    │ Mesa 5 · 4 plazas        │      │ [ Turnstile ]            │
│  19:40 a 22:20)          │    │                          │      │                          │
│          [Ver mesas]     │    │ [Atrás]   [Continuar]    │      │ [Atrás] [Confirmar]      │
└──────────────────────────┘    └──────────────────────────┘      └──────────────────────────┘

4 · Hecho                         Cancelar (desde el correo)
┌──────────────────────────┐     ┌──────────────────────────┐
│ ✓ Reserva confirmada     │     │ Tu reserva en Bar Pepe   │
│ Vie 24 oct · 21:00       │     │ Vie 24 oct · 21:00 · 4 p │
│ 4 personas · Mesa 5      │     │ Mesa 5                   │
│ Te hemos enviado un      │     │ [ Cancelar la reserva ]  │
│ correo con los detalles  │     │ (pide confirmación)      │
└──────────────────────────┘     └──────────────────────────┘
```

- **Paso 1:** sólo se pueden pulsar los días abiertos del horizonte. La hora se limita a los tramos
  válidos de ese día.
- **Paso 2:** las mesas adecuadas y libres resaltadas en el acento; el resto, en gris y sin pulsar.
  Una pestaña por salón. Debajo, la misma lista de mesas libres en botones, que hace accesible lo que
  el lienzo no es y sirve en pantallas muy pequeñas. Sin mesas: «No quedan mesas para 4 personas a
  las 21:00» y las alternativas como botones.
- **Paso 3:** el texto de privacidad nombra al negocio como responsable (el contenido lo fija
  LEGAL-01). Un `mesa_no_disponible` al confirmar vuelve al paso 2 con las mesas actualizadas.
- **Estados:** cargando; reservas cerradas o no disponibles («Ahora no se pueden hacer reservas
  online. Llama al 9xx xxx xxx», con el teléfono del negocio si se pudo leer); error de red con
  «Reintentar».

### 7.3 La línea que se pega en la web

```html
<div data-negocio="rw_…"></div>
<script src="https://tpv-api.altarialights.workers.dev/reservas-web/v1/embed.js" async></script>
```

`embed.js` (vanilla, unos 2 KB) busca los `[data-negocio]`, mete en cada uno un iframe
(`width: 100%`, sin borde, `title="Reservar mesa"`, `loading="lazy"`) y ajusta su altura con los
mensajes `postMessage` que manda el widget (con un `ResizeObserver`), aceptando sólo los que vienen
de su propio origen. No deja variables globales y no hace nada si se carga dos veces.

---

## 8. Seguridad y abuso

| Riesgo | Medida |
|---|---|
| Identificar al negocio | Clave pública por negocio, revocable desde la administración |
| Bots | Turnstile en el alta |
| Volumen | Limitadores por IP (lecturas y altas) y, detrás, los topes exactos de la agenda: 10 activas por correo y un máximo de altas por negocio al día |
| Reservas falsas para bloquear mesas | Lo anterior, más el límite por correo y la cancelación por el restaurante |
| Incrustarlo en otra web | `frame-ancestors` con los dominios del negocio |
| Datos personales | Las respuestas públicas no los llevan (con un test que lo vigile) |
| Spam con nuestro dominio | Destinatario acotado (el del alta, o el cliente de una reserva web en Turso), topes y nada de texto del visitante en los correos |
| Enlace de cancelar | 128 bits aleatorios, sólo su hash guardado, en el fragmento, y botón para confirmar |
| Detalles internos en los errores | Resuelto antes de empezar (FABLE-B): un 500 no lleva traza ni texto de Turso ([worker.md](../arquitectura/worker.md#errores)) |
| Telemetría | Lo que sale a Sentry y Axiom pasa por el filtro de datos personales; los eventos llevan ids, nunca correos ni teléfonos |
| Legal | [LEGAL-01](../pendientes.md#legal-01--rgpd): texto informativo del formulario y contrato de encargado, antes del piloto |

---

## 9. Observabilidad

- **Eventos en Axiom** (dataset de sync, `service: "tpv-reservas-web"`): `reserva_web_alta`,
  `reserva_web_rechazo` (con el motivo), `reserva_web_entregada`, `reserva_web_vista`,
  `reserva_web_reofrecida`, `reserva_web_fallida` y `reserva_web_cancelada`. Sólo ids y motivos
  (`observability/axiom.ts::reportarReservaWeb`). Los de las rutas públicas (alta, rechazo,
  cancelada) ya salen; los de la entrega llegan con ella (fase 3).
- **Sentry** en la agenda y en las rutas públicas.
- **Una anomalía que mirar**: una petición `pendiente` de más de 72 h en un negocio cuya Main se ha
  conectado en las últimas 24 h.

---

## 10. Tests

| Dónde | Qué |
|---|---|
| `tpv-domain` | La validación del alta, con su dominio en `validacion_casos.json` |
| Worker · disponibilidad | Una tabla de casos: días de la semana, fechas, la tolerancia de la franja, la capacidad de N a N + 2, cierres, antelación y horizonte, medianoche, comanda abierta, pendientes de la agenda |
| Worker · agenda | Dos altas a la vez para la misma mesa (gana una), el ciclo de una petición, la reoferta a la hora, `fallida` con su correo, la purga de datos personales, la cancelación antes y después de entregar |
| Worker · puerta pública | Clave inexistente o revocada, licencia caducada, interruptor, limitador, Turnstile, `frame-ancestors`, ningún dato personal en las respuestas |
| Worker · guardianes | `vetoAntesDelCuerpo` (con los middlewares nuevos), `mensajesDeError` (los identificadores nuevos), `TABLAS_SOLO_MAIN` con las tablas de la web |
| `tpv-infra-sqlite` | Registrar: cliente existente por correo, cliente nuevo, idempotencia por id, solape que se guarda, `Created_At` literal, captura en el outbox; cancelación idempotente; la foto del esquema; las columnas `INTEGER` declaradas |
| `tpv-application` | Recoger (orden, resultados, notificaciones) y cuándo se encola un aviso |
| Contrato | `origen` en las lecturas del calendario; editar una reserva web desde la Handy conserva `Origen` |
| Widget | Los pasos, la hora limitada a los tramos, `mesa_no_disponible`, la página de cancelar; `embed.js` |
| E2E | Alta en la web → aparece en la Main. Alta con la Main apagada → aparece al encenderla. Cancelar desde el enlace → cancelada en la Main. Cambio desde el TPV → sale el aviso |

---

## 11. Fases

Cada fase se sube y se prueba sin esperar a la siguiente.

| Fase | Entrega | Hecho cuando |
|---|---|---|
| ✅ **0 · Previos** | FABLE-B. Turnstile dado de alta (§12) | Hecho el 2026-10-17 |
| ✅ **1 · Esquema y configuración** | El esquema del §3.1 en `0001`, el reset de desarrollo, Configuración → Reservas (interruptor y días cerrados), el modo «Reserva web» del editor del plano, la zona horaria, `origen` en el calendario, `TABLAS_SOLO_MAIN` | Código y tests hechos el 2026-10-17. Falta comprobarlo con el worker desplegado: que la configuración llega a Turso |
| ✅ **2 · Agenda y API pública** | Tablas centrales, `POST /clave` y el código en Configuración, la puerta pública, las rutas públicas, `AgendaWeb`, los limitadores, el interruptor, la administración de dominios y claves | Código y tests hechos el 2026-10-18 (las altas simultáneas, también). Falta crear las tablas centrales en Turso, desplegar el worker y reservar con `curl` |
| **3 · Entrega a la Main** | `avisarReservasWeb`, `/pendientes` y `/recogidas`, la recogida en el motor, el caso de uso, las notificaciones, la cancelación entregada, la reoferta | E2E: web → Main, con la Main encendida y apagada |
| **4 · Widget** | `packages/plano`, `packages/estilos`, `apps/reservas-web`, `embed.js`, los assets en el worker y la CSP | Funciona incrustado en una página de prueba en `localhost` dada de alta |
| **5 · Correos y cambios** | Las plantillas, el enlace de cancelar, la doble confirmación, borrar = cancelar, la cola de avisos y su job | Llegan los cinco correos y se cancela desde el enlace |
| **6 · Piloto** | Los textos de LEGAL-01, `arquitectura/reservas-web.md` y la primera web propia con un bar | Un bar recibe reservas reales |
| **7 · WordPress** | El plugin: ajustes con la clave, shortcode y bloque, que imprimen la línea del §7.3 | Instalado en un WordPress de prueba |

---

## 12. Lo que no es código

**Cloudflare** (lo hace el responsable):

1. ✅ **Turnstile**: widget «Panel embebido de reservas», hostname
   `tpv-api.altarialights.workers.dev`, modo gestionado. Para desarrollar se usan las claves de
   prueba que publica la documentación de Turnstile.
2. ✅ El secreto está guardado como `TURNSTILE_SECRET_KEY` (`wrangler secret put`), y la clave
   pública, que no es secreta, como `TURNSTILE_SITE_KEY` en las `vars` de `wrangler.json`.
3. **Correo**: comprobar en Email Sending que se puede enviar desde `reservas@altarialights.com`
   (el dominio ya está dado de alta por `pedidos@`).
4. La clase nueva del DO y los dos limitadores van en `wrangler.json` y se crean al desplegar: no hay
   que tocar nada en el panel.

**Turso:** crear a mano las tablas del §3.2 en la base central antes de desplegar la fase 2, y
resetear las bases de desarrollo en la fase 1.

---

## 13. Riesgos aceptados

- **Una mesa vendida dos veces** si la Main apunta una reserva sin internet, o en el segundo que
  tarda en replicarse. Lo resuelve el restaurante con el aviso.
- **El restaurante no se entera** de una reserva web hasta que enciende la Main: los avisos son sólo
  de la app.
- **Los correos de cambios** hechos sin internet salen cuando vuelve la conexión.
- **La dirección `workers.dev`** queda pegada en cada web.

---

## 14. Después

Lo que se ha dejado para más adelante y en qué orden tiene sentido: hacer configurables desde el TPV
la tolerancia, el margen de plazas, la antelación y el horizonte (las columnas ya existen); varias
franjas por mesa en la pantalla (el esquema ya las admite); el plugin de WordPress; la página propia
por negocio (el widget ya es una página); el tema del widget desde el TPV; que el cliente modifique
su reserva; juntar mesas para grupos grandes.

---

## 15. Al terminar

- Se escribe `docs/arquitectura/reservas-web.md` con lo que haya quedado, y **este fichero se
  borra**.
- [CLAUDE.md](../../CLAUDE.md): una fila en «Antes de tocar…» y las reglas del §2 que necesiten test.
- [worker.md](../arquitectura/worker.md) (rutas públicas, la agenda, el correo),
  [sincronizacion.md](../arquitectura/sincronizacion.md) (el aviso `reservas_web` y la recogida),
  [esquema.md](../arquitectura/esquema.md), [permisos.md](../arquitectura/permisos.md) (la superficie
  pública), [jobs-e-interruptores.md](../arquitectura/jobs-e-interruptores.md) (el job y el
  interruptor), [observabilidad.md](../arquitectura/observabilidad.md) y
  [frontend.md](../arquitectura/frontend.md) (los paquetes compartidos).
- Quitar de [pendientes.md](../pendientes.md) las menciones a este plan.
