# Reservas desde la web

**Estado:** plan aprobado el 2026-10-17. Fases 0 a 5 y 8 (la API abierta a las webs del negocio y el
SDK, publicado en npm) hechas y en producción; faltan el piloto (fase 6) y el plugin de WordPress
(fase 7). Lo que queda por comprobar de cada fase, en el §11. La base del negocio es el SQLite de su
`TenantHub` ([0008](../decisiones/0008-la-base-del-negocio-en-su-durable-object.md)), y la base
central, el de su objeto `BaseCentral` ([0009](../decisiones/0009-la-base-central-en-su-durable-object.md)),
con sus tablas en sus migraciones.

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
- Para las webs que hacen su propio formulario: la API pública abierta a los dominios del negocio y un
  SDK, `@altarialights/reservas-web-tpv` (§7.4).

**Queda fuera por ahora** (se decide cuando haga falta): página propia por negocio, plugin de
WordPress (fase 7), que el cliente modifique su reserva, juntar mesas, señal o
depósito, recordatorios, otros idiomas, tema del widget configurable desde el TPV y panel de
administración propio (mientras tanto, el CLI).

---

## 1. Lo decidido

| Tema | Decisión |
|---|---|
| Confirmación | Automática. El bar no acepta ni rechaza nada |
| Qué se reserva | Una mesa concreta, con la capacidad que tiene en el plano |
| Mesas que se ofrecen | Reservables desde la web, con capacidad entre N y N + 2 (N = personas), libres durante toda la reserva y, si es para hoy, sin comanda abierta (una comanda abierta ocupa la mesa todo el día, como en el TPV) |
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
| El restaurante cambia una reserva web | Doble confirmación en el TPV y correo al cliente. Una reserva web no se borra: se **cancela** (§5.6) |
| Avisos al restaurante | Sólo las notificaciones de la app |
| Main apagada o recuperándose | La web sigue aceptando; lo único que espera es la entrega |
| Precio | Incluido en la licencia |
| Dirección | La del worker, `tpv-api.altarialights.workers.dev`, para todo: el widget, `embed.js`, el SDK y los enlaces de los correos (`RESERVAS_WEB_ORIGEN`). ⚠️ Queda pegada en cada web: cambiarla después obliga a tocarlas todas. Un nombre propio de `altarialights.com` saldría por IP que se bloquean cuando hay fútbol (INFRA-04, junto a `CLOUD_API_BASE`) |
| Formularios propios | La API pública con CORS para los dominios del negocio y el SDK (§7.4). Turnstile va en una página nuestra metida en un iframe (`…/verificar`): sólo funciona en los dominios dados de alta en su widget |
| Mesa automática | Sin mesa (`mesa: "auto"`), la de menos plazas en la que quepan; si empatan, la primera por `ID_Mesa`. La elige la agenda en su bloque síncrono. Sin ninguna, `sin_mesa_libre` |
| Nombres de la API | Los mismos en lo que entra y en lo que sale: `dia`, `hora`, `personas`, `mesa` (siempre el id; el nombre, `mesa_nombre`), `correo` (`correo_enviado`, si salió; `null` si aún no se sabe). Lo de dentro (la agenda y la Main) sigue con `dia_ymd`, `id_mesa` y `email` |
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
         lee la base del negocio (plano, ajustes)        AgendaWeb (DO por negocio)
                                                           · decide la mesa y la guarda en su SQLite
                                                           · lee la base del negocio, nunca escribe en ella
                                                                   │ avisarReservasWeb()
                                                                   ▼
                                                           TenantHub ──{"type":"reservas_web"}──► Main
                                                                                                   │
                                     POST /v1/reservas-web/pendientes y /recogidas ◄───────────────┘
                                     la Main la registra con su caso de uso → outbox → TenantHub → su base
```

| Pieza | Dónde | Qué hace |
|---|---|---|
| Widget | `apps/reservas-web/` (nuevo), servido por el worker | Las pantallas de reservar y de cancelar |
| Script de inserción | `apps/reservas-web/` → `embed.js` | Mete el iframe en la web y le ajusta la altura |
| SDK | `packages/reservas-web-sdk/` (`@altarialights/reservas-web-tpv`, npm y `/reservas-web/v1/sdk.js`) | Las rutas públicas como funciones, con la idempotencia, los reintentos y la casilla de Turnstile. Lo usa el widget y las webs con formulario propio |
| Casilla de Turnstile | `apps/reservas-web/` → `verificar.html`, `src/casilla.ts` | La comprobación del SDK, en el dominio del servidor, metida en la web en un iframe |
| CORS | `domains/reservas_web/cors.ts` | Que las webs del negocio, y ninguna otra, lean las respuestas desde el navegador |
| Plano compartido | `packages/plano/` (nuevo) | El plano de la Main, usado también por el widget |
| Estilos compartidos | `packages/estilos/` (nuevo) | Los tokens de color de `Global.css` |
| Rutas públicas | `domains/reservas_web/publico.routes.ts` | Lo que llama el widget, con la clave del negocio |
| Rutas de la Main | `domains/reservas_web/main.routes.ts` | Clave, recogida de pendientes y avisos al cliente |
| La agenda | `durableObjects/agendaWeb*.ts` (nuevo DO `AgendaWeb`) | Disponibilidad, reparto de mesas, pendientes y enlaces de cancelar |
| `TenantHub` | `tenantHub.ts` / `tenantHub.motor.ts` | Sólo un RPC nuevo: avisar a la Main |
| Main | `use_cases/reservas_web.rs`, motor de réplica, `tpv-infra-sqlite/src/reservas_web.rs` | Recoge, registra, avisa al restaurante y encola los correos de cambios |
| Base central | `reserva_web_claves`, `reserva_web_dominios` | Qué clave es de qué negocio y dónde se puede incrustar |

### Reglas que no se rompen

1. **La agenda nunca escribe en la base del negocio.** La base del negocio se sigue escribiendo sólo por el
   `TenantHub`, como hoy.
2. **La reserva la registra la Main**, con su caso de uso y su outbox.
3. **La Main nunca rechaza una reserva web confirmada.** Si choca con algo, la guarda y avisa; si no
   puede registrarla, lo dice para que se avise al cliente.
4. **El `TenantHub` no atiende tráfico público**: sólo recibe el aviso de la agenda.
5. **Una reserva pendiente ocupa su mesa hasta que aparece en la base del negocio**, no hasta que la Main acusa
   recibo: entre una cosa y otra sólo existe en el outbox de la Main (la misma lección que el volcado
   del atraso, SYNC-18).
6. **Las respuestas públicas no llevan datos personales** de ninguna reserva.
7. **No cambian** el freeze `main_offline`, el escritor único ni el cerrojo de recuperación.

### Los recorridos

**Consultar.** El widget pide el negocio, el plano y las horas válidas de un día directamente a
la base del negocio (no pasan por la agenda: no dependen de lo pendiente). Para saber qué mesas están libres
pregunta a la agenda, que suma lo que hay en la base del negocio y lo pendiente.

**Reservar.** El widget manda la mesa elegida con los datos y el token de Turnstile. La agenda vuelve
a comprobar que la mesa sigue libre, la guarda como pendiente con un `ID_Reserva` (UUIDv7) que
genera ella, crea el enlace de cancelar y responde. El worker manda el correo de confirmación y la
agenda avisa al `TenantHub`. El cliente tiene su reserva confirmada aunque la Main esté apagada.

**Entregar.** Con la Main conectada, el aviso llega en el momento. La Main pide las pendientes por
REST, registra cada una en su base (reserva y cliente), devuelve el resultado de cada una y las sube
por su outbox. La agenda las da por vistas cuando aparecen en la base del negocio. Si la Main estaba apagada, las
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
  desarrollo (la del `TenantHub` y `data.db`) y desplegar el worker antes que la Main.

### 3.2 Base central

Están en la primera migración de la base central,
[0001_inicial.sql](../../apps/cloud-worker-licensing/src/server/central/migraciones/0001_inicial.sql).

| Tabla | Columnas |
|---|---|
| `reserva_web_claves` | `clave TEXT PRIMARY KEY` (`rw_` + 128 bits aleatorios en base64url), `tenant_id TEXT NOT NULL` → `tenants` `ON DELETE CASCADE`, `created_at_ms`, `revoked_at_ms`. Índice por `tenant_id`. Una activa por negocio |
| `reserva_web_dominios` | `tenant_id`, `origen TEXT` (esquema + host + puerto, p. ej. `https://www.barpepe.es`), `created_at_ms`, `PRIMARY KEY (tenant_id, origen)` |
| `email_sends` | La columna `tipo TEXT NOT NULL DEFAULT 'pedido'` (`pedido` o `reserva_web`) y el índice `idx_email_sends_to_ts (to_email, sent_at_ms)` para el tope por destinatario. El tope de 100 diarios de los pedidos cuenta sólo los suyos. Los correos públicos llevan `device_id = 'web'`, y los de la agenda, `agenda` |

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
| `peticiones` | `id_peticion` (UUIDv7), `tipo` (`alta` o `cancelacion`; una de cada como mucho por reserva), `id_reserva`, `id_mesa`, `dia_ymd`, `hora`, `comensales`, `email_hash` (SHA-256 del correo en minúsculas, para contar sin leer `datos_json`), `datos_json` (nombre, correo, teléfono y nota; sólo en un alta), `creada_local` (instante del negocio, §4.3), `creada_ms`, `estado` (`pendiente`, `entregada`, `vista`, `fallida`, `anulada`), `entregada_ms`, `intentos`, `cerrada_ms` (cuándo pasó a `vista`, `fallida` o `anulada`; de ahí cuentan los 7 días), `resultado` y `codigo` (lo que contestó la Main, §5.4), `aviso_ms` (el último intento del correo de una fallida que no salió: van detrás) |
| `enlaces` | `token_hash` (SHA-256 del token del enlace de cancelar), `id_reserva`, `caduca_ms`, `por_un_cambio` (1 si llegó en el correo de un cambio del restaurante, 0 si en la confirmación; §4.8) |
| `intentos` | `clave` (la `Idempotency-Key` del widget), `respuesta_json` (lo que contestó el alta, sin datos personales), `creado_ms`. Un día |
| `altas_por_conexion` | `conexion_hash` y `creada_ms`: una fila por alta apuntada y huella, para los topes por conexión y por red (§4.3): la de la conexión y, en IPv6, otra de su /48. La huella es un HMAC, no la IP (§8). Se borra a las 24 h, cuando deja de contar |
| `correos_pendientes` | La confirmación o el «has cancelado» que la ruta no pudo mandar (§4.8): `id_correo` (su id en `email_sends`), `tipo`, `id_reserva`, `para`, `dia_ymd`, `hora`, `comensales`, `mesa`, `origen` y `clave` (de dónde sale el enlace de cancelar; el token no se guarda), `tras_el_correo`, `creado_ms` e `intento_ms` (el último intento: los que no salen van detrás). Se borra al salir, pasada la hora de la reserva o a los 7 días |
| `estado` | Clave y valor: la versión del esquema de la agenda |

Ciclo de una petición:

- `pendiente` → `entregada` cuando la Main la recoge.
- `entregada` → `vista` cuando el `ID_Reserva` aparece en la base del negocio (en las lecturas del día, en
  `pendientes` y en la alarma). Al pasar a `vista` se borra `datos_json` y, a los 7 días, la fila.
- `entregada` sin aparecer en la base del negocio en una hora → vuelve a `pendiente`. La Main la registra otra vez
  sin duplicarla (el `INSERT` es idempotente por `ID_Reserva`); cubre una Main que perdió su base o
  un outbox atascado. Sólo si la alarma ha podido mirar la base del negocio: sin ella no sabría qué ha llegado.
- Una cancelación sigue el mismo ciclo, pero está hecha (`vista`) cuando la base del negocio tiene la reserva
  fuera de `PROXIMA` (cancelada, sentada, terminada o no presentada), no cuando la Main dice que la
  ha cancelado: hasta que su outbox sube, eso
  sólo existe en su base. Se entrega con su alta delante mientras el alta no se haya visto en la base del negocio
  (la Main pudo no recibirla).
- `fallida` (la Main no pudo registrarla) → de `datos_json` queda sólo el correo, para el correo al
  cliente, que lo olvida en cuanto sale (o pasada la hora de la reserva), y la fila se va a los 7 días.
- Un alta sólo se anula en la agenda si nunca se entregó (`intentos = 0`); una que vuelve a estar
  `pendiente` porque se reofrece puede estar ya en la Main, y lleva una cancelación.
- La alarma, cada hora mientras quede algo (cada 10 minutos mientras quede un correo en
  `correos_pendientes`): da por visto lo que ya está en la base del negocio (por lotes, con un
  cursor por tipo en `estado`), reofrece, vuelve a avisar a la Main si queda algo `pendiente`, apunta
  en Axiom lo que lleva tres días sin recoger, repite los correos al cliente que no salieron (§4.8) y
  purga (también las conexiones de más de 24 h).
- El SQLite de la agenda tiene su versión en `estado` (`VERSION_AGENDA`, hoy la 7): una agenda vieja
  se pone al día al construirse el objeto (`agendaWeb.almacen.ts::migrar`).
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
6. **En lo que lleva cuerpo, un tope de 8 KB** (`topeDelCuerpo`, 413): son rutas anónimas.

Del 2 al 4 el rechazo es siempre el mismo `reserva_web_no_disponible` (404): al widget le basta con
«ahora no se puede reservar online» y el motivo queda en el log. Todo está en
`domains/reservas_web/puerta.ts`.

Después, `cuerpo(schema)` / `consulta(schema)` como en todas las rutas. Los nombres de estos
middlewares se añaden a `VETOS` en `test/vetoAntesDelCuerpo.test.ts`. El interruptor general del
negocio (`Reserva_Web_Activa`) se lee de la base del negocio: `/negocio` contesta `reserva_web_cerrada` y el alta
también.

**CORS para las webs del negocio** (`cors.ts`). El widget no lo necesita: se sirve desde el mismo
origen que la API (§4.6). Una web con su propio formulario (§7.4) sí, y sólo se le abre a los
orígenes de `reserva_web_dominios` de ese negocio, los mismos en los que se puede incrustar el
widget. No protege de quien automatiza (fuera del navegador, `Origin` es el que se quiera): eso es
lo de arriba. Va en dos piezas:

- El **preflight** (`OPTIONS`) se registra en `index.ts` delante del `OPTIONS` de todo el worker, que
  contesta a todo. Pasa por el limitador antes de mirar la clave, como la puerta; a una web que no es
  del negocio se le contesta sin permiso. Permite `Content-Type`, `X-Turnstile-Token` e
  `Idempotency-Key`, sin credenciales, y el navegador lo guarda diez minutos.
- Las **respuestas**, también las de error, llevan `Access-Control-Allow-Origin` si quien llama es una
  web del negocio, para que el SDK lea el motivo en vez de un fallo de red. Después de la puerta, con
  la clave ya resuelta: si la cortó antes de resolverla (el limitador), sólo se mira lo cacheado, para
  no abrirle a un barrido de claves la base central. Todas llevan `Vary: Origin`.

### 4.2 Rutas públicas — `/v1/publico/reservas/:clave/…`

| Ruta | Lee | Devuelve |
|---|---|---|
| `GET /negocio` | La base del negocio | Nombre, dirección, teléfono y logo; responsable para el aviso de privacidad (`Razon_Social`, `CIF`); hoy en la hora del negocio; primer y último día reservables; días abiertos del horizonte (con alguna franja y sin cierre); máximo de personas (la mayor capacidad reservable); duración; la clave pública de Turnstile |
| `GET /dia?dia=` | La base del negocio | Los tramos de hora de llegada válidos ese día (la unión de las franjas, con la tolerancia y la duración) |
| `GET /plano` | La base del negocio | Salones (id, nombre, `Room_Points`) y mesas (`id`, `nombre`, forma, posición, tamaño, capacidad, si es reservable). Caché corta. Con techo (50 salones, 500 mesas) y `completo` para decir si lo ha alcanzado |
| `GET /disponibles?dia=&hora=&personas=` | Agenda | Las mesas libres y adecuadas. Si no hay ninguna, `alternativas`: hasta 4 horas a ±15, 30, 45 y 60 minutos que sí tienen mesa |
| `POST /reservas` `{ dia, hora, personas, mesa, nombre, correo, telefono, nota }` | Agenda | `{ codigo, dia, hora, personas, mesa, mesa_nombre, correo_enviado }` (`mesa`: el id, el pedido o el asignado con `"auto"`; `correo_enviado`: si salió el de confirmación, `null` en una repetición o si lo repetirá la agenda). El token del enlace sólo viaja en el correo. Con `Idempotency-Key` (el SDK manda la misma en todos los envíos de una reserva), un intento que ya dio reserva contesta la misma, durante un día, en vez de apuntar otra |
| `POST /reserva` `{ token }` | La agenda y la base del negocio | El resumen para la página de cancelar: día, hora, personas, `mesa` y `mesa_nombre`, estado y si aún se puede cancelar |
| `POST /cancelar` `{ token }` | Agenda | `{ ok }` |

`/reserva` va por POST para que el token no aparezca en ninguna URL ni en ningún log.

Identificadores de error nuevos, todos en `MENSAJES` (`lib/errorCodes.ts`) con su frase:
`reserva_web_no_disponible`, `reserva_web_demasiadas`, `reserva_web_cerrada`, `dia_no_reservable`, `hora_fuera_de_franja`,
`mesa_no_disponible` (409; el widget vuelve a pedir las disponibles), `sin_mesa_libre` (409; con la
mesa automática no queda ninguna: hay que cambiar la hora, no la mesa), `limite_reservas_correo`,
`tope_reservas_negocio`, `tope_reservas_conexion`, `verificacion_humana_fallida`, `reserva_no_cancelable` y `enlace_no_valido`.
Los de la agenda salen con su estado (`agendaWeb.motor.ts::STATUS`): 400 el día o la hora que no
valen, 409 lo que choca con el estado (`reserva_web_cerrada`, la mesa, el tope por correo, la que ya
no se puede cancelar), 429 los topes del negocio y de la conexión y 404 el enlace. El `codigo` del alta son los seis
últimos caracteres del `ID_Reserva`: una referencia corta para hablar con el restaurante.

Los nombres de la API (los del SDK) no son los de dentro: `altaPublicaSchema` traduce el alta
(`dia`, `mesa`, `correo`) a la de la agenda y la Main (`dia_ymd`, `id_mesa`, `email`) y la valida
con `altaReservaWebSchema`. Lo que contesta cada ruta cumple los tipos del SDK
(`packages/reservas-web-sdk/src/tipos.ts`) con `satisfies`: un campo que cambia en un lado sin el
otro no compila.

La entrada del alta tiene su dominio en
[validacion_casos.json](../../crates/tpv-domain/src/validacion_casos.json) (`reserva_web`): el schema
del worker y la validación de `tpv-domain`, que la Main repite al registrarla, aceptan y rechazan lo
mismo. El correo es **una sola dirección** (`isValidEmail` / `validate_email_basic`, con sus casos en
el dominio `cliente` de la misma tabla): una `@`, un dominio con punto, y ni espacios, ni caracteres
de control, ni `,;<>()[]":\`. Va al `to` de los correos, donde una lista o un salto de línea serían
varios destinatarios o una cabecera más (AUD-39). Admite `+`, subdominios y letras no ASCII.

### 4.3 La agenda (`AgendaWeb`)

- **Clase nueva**, en el mismo worker ([0006](../decisiones/0006-un-solo-worker.md)): migración
  `v2` con `new_sqlite_classes: ["AgendaWeb"]` en `wrangler.json`, binding `AgendaWeb`, una
  instancia por negocio (`idFromName(tenantId)`). Instrumentada con Sentry como el `TenantHub`.
- **Sin WebSockets**: atiende la petición y se duerme. Mientras duerme sólo cuenta lo que ocupa.
- **RPC**: `disponibles`, `reservar`, `consultarEnlace`, `cancelar` (para las rutas públicas),
  `pendientes` y `recogidas` (para las rutas de la Main). Los errores de negocio cruzan como resultado
  tipado, igual que `ResultadoAplicacion`.
- **Lee la base del negocio** por RPC al `TenantHub`, una lectura entera por viaje (`leerParaLaWeb`,
  `domains/reservas_web/lecturasDeLaWeb.ts`), que fija `'now'` con la hora local del negocio
  (`Zona_Horaria`), con la misma reescritura que `tenantQuery`. Si el esquema del negocio va atrasado,
  lo pone al día el propio `TenantHub` al recibir la lectura. Eso es esquema, no datos del negocio, y no rompe la regla de que la agenda no
  escribe en la base del negocio.
- **Sin estado en campos de instancia que importe ni variables de módulo con estado**, por las mismas
  razones que el `TenantHub` ([sincronizacion.md](../arquitectura/sincronizacion.md#hibernación-del-durable-object-sync-16)).
- **Una sola alarma**, que se reprograma mientras haya algo que hacer: volver a ofrecer las
  `entregada` de más de una hora, repetir los correos al cliente que no salieron, purgar y caducar
  enlaces.

**Qué mesas valen** para el día D, la hora H y N personas:

1. D está entre hoy + `Dias_Min` y hoy + `Dias_Max` (hoy en la zona del negocio) y no está en
   `Reserva_Web_Cierres`. `Reserva_Web_Activa = 1`.
2. La mesa y su zona no están archivadas, tiene `Reserva_Web_Mesas.Activa = 1` y su capacidad está
   entre N y N + `Margen_Plazas`.
3. Alguna de sus franjas vale para D (§3.1) y `Hora_Desde − margen ≤ H` y
   `H + duración ≤ Hora_Hasta + margen`, con fechas y horas reales (una reserva puede pasar de la
   medianoche).
4. No choca con ninguna reserva de la base del negocio: **el mismo SQL** que `SQL_CHOQUE_RESERVA` y
   `SQL_CHOQUE_COMANDA` de la Main, que ya existe en el worker (`reservas.queries.ts::choqueEnLaMesa`).
   Se leen las reservas de D y de D − 1, por las que cruzan la medianoche.
5. No choca con ninguna petición de alta de la agenda en `pendiente` o `entregada` que aún no esté en
   la base del negocio.

**Reservar**:

1. Validar la entrada (§4.2) y el día y la hora (1 y 3).
2. Leer de la base del negocio lo del día y comprobar la mesa elegida (2 a 4).
3. Topes exactos, que son el control exacto que va detrás del limitador por IP, como pide
   `lib/limitador.ts`:
   - 10 reservas activas por correo (las de la base del negocio desde hoy con ese correo, más las pendientes con
     su `email_hash`);
   - 10 altas por conexión y negocio en 24 h (`MAX_ALTAS_DIA_CONEXION`, `tope_reservas_conexion`,
     429), **contando las que su autor anuló**: es lo que corta reservar y cancelar en bucle desde
     una conexión, que gastaba el cupo de correos del negocio. La conexión es la del limitador
     (`claveDeFreno`): la IPv4 exacta y la IPv6 por su /64. Una conexión compartida (el CGNAT de
     un móvil, una oficina) junta a mucha gente, pero que más de diez de ellos reserven por la web
     en el mismo restaurante el mismo día es rarísimo, y quien reserve por muchos puede llamar,
     que es lo que dice el mensaje. Un alta sin IP conocida (fuera de Cloudflare) no cuenta para él. La repetición de un
     mismo intento (`Idempotency-Key`) tampoco: no apunta otra alta (RW-ALTAS);
   - en IPv6, además, 30 altas por red /48 y negocio en 24 h (`MAX_ALTAS_DIA_RED`, el mismo
     `tope_reservas_conexion`), contadas igual: una casa recibe un /56 y un túnel gratuito da un /48,
     así que sólo con el /64 una persona tenía cientos de conexiones. Un operador móvil puede
     repartir /64 de un mismo /48 entre clientes distintos; que 30 de ellos reserven por la web el
     mismo día en el mismo restaurante es rarísimo. En IPv4 no hay red amplia: un /24 juntaría a
     desconocidos detrás del CGNAT. Quien tenga más de un /48 (o muchas IPv4) sigue pudiendo
     repartirse; lo frena el coste de cada red y de cada Turnstile;
   - 200 altas por negocio en 24 h, que no cuenta las que su autor anuló antes de que la Main las
     tuviera: ni llegan al TPV ni ocupan mesa (AUD-38). Con el tope por conexión, llenarlo pide al
     menos 20 conexiones distintas (en IPv6, de al menos 7 redes /48), cada una con su Turnstile.

   Los topes por conexión y por red se miran también antes de leer la base del negocio: una conexión que ya está
   en el suyo no le cuesta a nadie una lectura de la base.
4. **En un bloque síncrono sobre el SQLite de la agenda, sin ningún `await` en medio:** volver a
   comprobar el punto 5 y los topes, e insertar la petición, el enlace y la conexión. Dos altas a la vez para la misma mesa:
   gana una y la otra recibe `mesa_no_disponible`. Lo que se lee de la base del negocio puede tener un segundo de
   retraso respecto a la Main; eso es el riesgo aceptado del §2.

   Las altas de la agenda que cuentan son las que la lectura de la base del negocio de esa petición no trae, y
   también las que otra petición dio por `vista` desde un minuto antes de empezar a leer
   (`Lectura` en `agendaWeb.almacen.ts`): sin eso, una petición que leyó la base del negocio antes de que llegara
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
esa reserva en la base del negocio, y sólo si es `Origen = 'WEB'` (acotado a quién, como los pedidos con
FABLE-C). Es idempotente por `id_aviso` (`email_sends.id`). Lleva también el cliente de la
reserva y la huella de su correo (`id_cliente`, `huella_correo`) tal como los tiene quien la
cambió. Qué contesta:

- **404** (se repite): la reserva aún no está en la base del negocio, o la base del negocio no la tiene como dice el aviso (otro
  cliente, otro correo, o, en un cambio, otro día, hora, personas o mesa): el cambio aún no ha subido,
  o hubo otro después.
- **409** (se descarta): no es una reserva web (`reserva_no_web`), o un cambio de una reserva que ya
  no está por venir o que el cliente canceló desde su enlace (`aviso_superado`).
- **503** (se repite): la agenda no responde, la base central no atiende al leer la clave del negocio
  para el enlace (el `hub_unavailable` o `hub_overloaded` de siempre), o ese correo está saliendo por
  otro lado. La Main lo repite desde su cola; la Handy, que lo manda una vez, no.
- En un cambio, la agenda da un enlace de cancelar nuevo para el correo (`enlaceParaUnCambio`), que
  vale hasta un día después de la hora nueva, y alarga los que ya tenía. Si la clave no se puede leer
  por otra cosa (un error de SQL), el correo sale sin el enlace y el fallo va a Sentry.

La Main, antes de mandarlo, compara el aviso con su copia: un «cambiada» que ya no coincide (hubo
otro cambio, también de una Handy, que ya avisó) o de una reserva que ya no está por venir se
descarta.

### 4.6 El widget, servido por el worker

Workers Static Assets en el mismo worker, con lo compilado de `apps/reservas-web/`:

| Ruta | Qué es | Caché |
|---|---|---|
| `/reservas-web/v1/embed.js` | El script de inserción | Corta (minutos): es lo que hace que un cambio llegue a todas las webs |
| `/reservas-web/v1/w/:clave` | El HTML del widget (y `…/cancelar`), servido por el worker para poner la CSP | Sin caché |
| `/reservas-web/v1/w/:clave/verificar?origen=` | La casilla de Turnstile del SDK (§7.4), sólo si `origen` es una web del negocio (si no, 403), con su `frame-ancestors` y la clave pública de Turnstile puesta por el worker (`HTMLRewriter`) | Sin caché |
| `/reservas-web/v1/sdk.js` | El SDK en un fichero, para las webs que no compilan. Con `Access-Control-Allow-Origin: *`: se importa como módulo desde otro origen | Corta, como `embed.js` |
| `/reservas-web/assets/*` | JS y CSS con huella en el nombre | Inmutable |

CSP del HTML: `default-src 'self'`; `script-src 'self' https://challenges.cloudflare.com`;
`frame-src https://challenges.cloudflare.com`; `style-src 'self'`; `img-src 'self' data:` (el logo
es un `data:`); `connect-src 'self'`; y **`frame-ancestors` con los orígenes de
`reserva_web_dominios` del negocio** (sin ninguno, `'none'`: el widget no se puede incrustar hasta
dar de alta la web). Para desarrollar, se da de alta `http://localhost:<puerto>`.

Una clave que no existe da una página «Reservas no disponibles».

Tal como ha quedado (`domains/reservas_web/widget.routes.ts`): `assets` con `run_worker_first: true`,
para que todo pase por el worker y cada fichero salga con su caché; el `index.html` suelto no se sirve
(404), sólo a través de `/w/:clave`. La página de cancelar lleva siempre `frame-ancestors 'none'`: se
abre desde el correo. Además de lo de arriba, la CSP lleva `base-uri 'none'`, `form-action 'none'` y
`object-src 'none'`. Las webs de cada negocio se cachean un minuto por isolate.

El widget compilado tiene que existir antes de desplegar: `pnpm --filter tpv-api desplegar` lo compila
y despliega (en `wrangler.json`, `assets.directory` apunta a `apps/reservas-web/dist`). El mismo build
deja `verificar.html` y `v1/sdk.js`, éste compilado desde las fuentes del SDK
(`apps/reservas-web/vite.config.ts`).

La dirección que va en la línea para pegar y en los enlaces de los correos es `RESERVAS_WEB_ORIGEN`
(`claves.ts::origenDelWidget`), no la de la petición: así no depende de por qué dirección la pida la
Main. Hoy es la de `workers.dev`. Con `wrangler dev`, `RESERVAS_WEB_ORIGEN=` (vacía) en `.dev.vars`
hace que salga la local.

### 4.7 Interruptor remoto `reservas_web`

Una variante nueva en `Interruptor` (`tpv-contracts/src/interruptores.rs`) y en `INTERRUPTORES`
(`lib/interruptores.ts`). Sólo lo mira el worker. Apagado para un negocio o para
todos, cierra las rutas públicas sin desplegar; la entrega a la Main y el TPV siguen igual.

### 4.8 Correos

Desde el worker, con el binding `EMAIL`:

- Remitente `EMAIL_RESERVAS_FROM_ADDRESS` (`reservas@altarialights.com`) con el nombre del negocio, y
  `Reply-To` el `Contact_Settings.Contact_Email` del negocio si lo tiene.
- **Sólo datos estructurados**: negocio, dirección, teléfono, día, hora, personas y mesa. Nada que
  haya escrito el visitante, tampoco su nombre: un formulario público que mete texto libre en un
  correo de nuestro dominio es una vía de spam.
- La mesa, como en el widget: con el nombre que tiene en la Main, y «Mesa» delante sólo si ese
  nombre es un número a secas (`nombreDeMesa`, copiada en el worker). Si no, sale «Mesa Mesa 5».
- Trazas en `email_sends` con `tipo = 'reserva_web'` y un id por correo (`rw:<tipo>:<id>`). Antes de
  enviar se reservan, en una sola sentencia, el id y el sitio en los topes (600 por negocio y 10 por
  destinatario en 24 h, sobre lo entregado y lo que está saliendo): el mismo correo no sale dos
  veces, muchos a la vez no pasan de los topes, uno que falló se puede repetir y uno que está saliendo
  por otro lado es «en curso», que se repite. Sin la base central no se envía: no se sabría si ya
  salió.
- **Lo que no sale lo repite la agenda** (RESERVA-CORREOS). La confirmación y el «has cancelado»
  salen de la ruta del visitante; si no salen porque la base central no contesta, el binding falla,
  falta el remitente u otro los está mandando, la ruta los apunta en la agenda (`apuntarCorreoPendiente`,
  `correos_pendientes`) y su alarma los repite cada 10 minutos con el mismo id: si el primero sí
  salió, la central lo sabe y no sale otro. La confirmación se repite si la reserva sigue en pie,
  como esté entonces (en la base del negocio, o en el alta que espera), al correo de su cliente y con
  un enlace de cancelar nuevo (el del alta no se guarda en claro; del nuevo, sólo su hash, y se quita si
  el correo no sale). El «has cancelado», tal como era al cancelar. Los dos, hasta la hora de la
  reserva y como mucho una semana. Cada vuelta intenta como mucho 10, salgan o no (con la central sin
  contestar no sale ninguno); los intentados van detrás. Lo que no sale por el tope, o porque no
  salió el correo de antes (`trasElCorreo`), no se repite.
- **El destinatario se vuelve a mirar al enviar**: con un carácter de control (AUD-40) o si no es
  una sola dirección (AUD-39), no sale ni gasta cupo. La del cliente puede llegar de la Main por la
  réplica, que no pasa por ninguna validación. Sale como `invalido`, que no se repite: ni lo apunta
  la ruta, ni lo guarda la alarma, y el aviso de la Main lo da por hecho sin enviar, como sin correo.
- **Un correo que falla no deshace la reserva**: se registra y la reserva sigue confirmada.
  `enviarCorreoReservaWeb` no lanza nunca.
- Todo en `domains/reservas_web/correos.ts`.

| Correo | Cuándo | Desde |
|---|---|---|
| Confirmación, con el enlace de cancelar | Al reservar | `POST /reservas`; la respuesta dice si salió (`correo_enviado`): `null` si aún no se sabe (una repetición del alta, que no lo repite, o uno que repetirá la alarma de la agenda) |
| Cancelación confirmada | Al cancelar desde el enlace, si salió (o está saliendo) la confirmación de esa reserva: si no, no sale ni gasta cupo (`trasElCorreo`, RW-ALTAS). Si se cancela con el enlace del correo de un cambio del restaurante (`enlaces.por_un_cambio`), sale sin mirarlo: ese correo lo pidió la Main, y es por donde le llegó el enlace aunque la confirmación fallara. De una reserva apuntada hace más de 89 días ya no queda traza de su confirmación (la purga de `email_sends` es a los 90), y sale sin mirarlo: la edad sale del `ID_Reserva`, un UUIDv7 | `POST /cancelar`, al correo del cliente de la reserva en la base del negocio o, si aún no está, al del alta; si no sale, la alarma de la agenda |
| Reserva modificada | El restaurante cambia día, hora, personas o mesa (§5.6) | `POST /v1/reservas-web/avisos` (§5.7) |
| Reserva cancelada por el restaurante | El restaurante la cancela | `POST /v1/reservas-web/avisos` (§5.7) |
| No se pudo registrar | La Main devuelve `fallida`: el restaurante se pondrá en contacto | La agenda, al contestar la Main; lo que no sale lo repite la alarma hasta la hora de la reserva, y después olvida el correo |

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
replica. La agenda la lee de la base del negocio.

### 5.4 Recoger las reservas web

En el motor de réplica (`use_cases/replicacion.rs`), no como job periódico:

- Después del catch-up y la subida iniciales (si no se está recuperando).
- Al completar una recuperación.
- Al recibir `{"type":"reservas_web"}` en `atender`.

Cada vez: `POST /v1/reservas-web/pendientes` → registrar cada petición en orden (§5.5) →
`POST /v1/reservas-web/recogidas`, de 50 en 50 mientras haya más. Durante una recuperación no se
recoge nada (el cerrojo de `Db` lo impediría igualmente).

El motor sólo la pide (`ContextoReplicacion::reservas_web`): corre en segundo plano y de una en una
(`src-tauri/src/reservas_web.rs`), sin retener el bucle del socket. Al acabar, aunque sea con un
error a mitad, recarga en la pantalla las reservas, los clientes y los avisos (`sync:cambio`) y
despierta al motor para que suba ya lo registrado. El caso de uso es
`tpv-application/src/use_cases/reservas_web_recogida.rs`.

Un fallo de la base (ocupada, en recuperación, el disco) corta la tanda **sin dar nada por
fallido**: se contesta lo hecho y el resto se lo vuelve a ofrecer la agenda. `fallida` es sólo lo
que no se puede guardar por sí mismo (un dato imposible, `validation`; sin datos, `sin_datos`; una
petición mal formada, `peticion_invalida`), porque le manda un correo al cliente.

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
- **Cancelación:** `Estado = 'CANCELADA'` si aún no ha llegado (`PROXIMA`), sólo en una de
  `Origen = 'WEB'`, como al cancelar desde la pantalla. Se decide al escribir y se replica el
  `UPDATE` por id, sin condición. Idempotente: una ya cancelada, sentada o terminada es `registrada`; una que la Main no
  tiene es `fallida` (`reserva_inexistente`), para que no se le vuelva a ofrecer cada hora.

Notificaciones (a los administradores, como la de «Nueva reserva»):

| Tipo | Severidad | Texto |
|---|---|---|
| `reserva_web_nueva` | Info | «Nueva reserva web · Ana · 24/10 21:00 · Mesa 5» |
| `reserva_web_solapada` | Aviso | «Reserva web en una mesa ocupada: muévela» |
| `reserva_web_cancelada` | Info | «El cliente ha cancelado su reserva web» |
| `reserva_web_fallida` | Error | «No se pudo registrar una reserva web», con el contacto del cliente para llamarle |

### 5.6 El calendario de reservas

- Una etiqueta «Web» en las reservas con `origen = 'WEB'`.
- Al cambiar día, hora, personas o mesa de una reserva web **que está por venir** (`PROXIMA` y con su
  hora aún por llegar, la misma comparación con la que la cola descarta un aviso), una doble
  confirmación: «Esta reserva se hizo desde la web. Se enviará un correo al cliente con el cambio.
  ¿Seguro?». Al modificarla cuenta la hora nueva, que es la que lleva el correo. Una nota, la
  duración o una reserva ya pasada, sentada, terminada o cancelada no le escriben al cliente, y no
  se pregunta (`features/reservas/reservaWeb.ts`).
- **Cancelar y borrar** son dos botones. Cancelar deja la reserva en la lista, atenuada, y sólo se
  cancela la que aún no ha llegado (`PROXIMA`); borrar la quita. **Una reserva web no se borra
  nunca**, ni por venir ni ya cerrada: queda constancia, la agenda libera la mesa al verla cancelada
  en la base del negocio y el correo del cliente se sigue pudiendo leer de ella. Lo deciden el repositorio de la
  Main (`eliminar`, `cancelar`) y las rutas del worker (`DELETE /v1/reservas/:id`,
  `POST /v1/reservas/:id/cancelar`), y se replica sólo la sentencia elegida, sin condición.

### 5.7 Avisar al cliente de un cambio

- `reservas::guardar` y `reservas::cancelar` leen la reserva antes (`ReservasRepository::reserva`;
  en la Handy, `GET /v1/reservas/:id`) y después, y `aviso_al_cliente` decide: de una reserva web
  `PROXIMA`, `cancelada` si ha quedado cancelada o ya no está, `modificada` si ha cambiado lo del
  §5.6, con los datos de después. Llaman al puerto `AvisosReservaWeb::encolar`, con su implementación
  por modo (como el `Notifier`). Es best-effort: el cambio ya está hecho.
- **Main:** fila en `_Reservas_Web_Avisos` por `raw()` (`tpv-infra-sqlite/src/reservas_web_avisos.rs`)
  y el job `avisos_reserva_web` (cada minuto; con la conectividad apagada, nada), que la manda a
  `POST /v1/reservas-web/avisos` (`use_cases/reservas_web_avisos.rs`): bien, fuera de la cola; un 404
  (la reserva aún no ha subido) se repite; lo que el worker no acepta (400, 409) se descarta; otro
  error del worker (el buzón en su tope, el correo que no sale) se repite y la vuelta sigue con los
  demás, con los avisos de esa reserva detrás para no desordenarlos; sin respuesta (la red) se para la
  vuelta. Se descarta, y queda en el log, el aviso de una reserva cuya hora
  ya ha pasado (ni se intenta) y el que lleva un día de intentos (1440); lo que lleva días en la cola
  porque la Main estuvo sin conexión sale igual. El aviso lleva el cliente de la reserva tras el
  cambio (`id_cliente`): si la nube aún tiene otro, contesta 404 y se repite, para no contarle la
  reserva a quien ya no la tiene.
- **Handy:** la llamada directa, que siempre tiene red, con un `id_aviso` nuevo.

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

- **Paso 1:** sólo se pueden pulsar los días abiertos del horizonte. La hora es un campo al minuto
  que sólo vale dentro de los tramos de ese día (si no, lo dice y no deja seguir); la respuesta tardía
  de un día elegido antes se descarta.
- **Paso 2:** las mesas adecuadas y libres resaltadas en el acento; el resto, en gris y sin pulsar. El
  plano se encaja a las mesas (no al contorno del salón) con un zoom de hasta 2,5, y el lienzo es tan
  alto como pida la forma de las mesas a todo el ancho, entre 280 y 640 px
  (`PlanoWidget.tsx::altoDelPlano`; la sala de la Main sigue encajando el salón entero). Un dedo sobre
  el plano desplaza la página: el widget le quita a sus figuras el `preventDefault` con el que Konva
  cancela el toque (`Lienzo` con `dejarDesplazar`), y pulsar una mesa sigue funcionando.
  Una pestaña por salón. Debajo, la misma lista de mesas libres en botones, que hace accesible lo que
  el lienzo no es y sirve en pantallas muy pequeñas. Sin mesas: «No quedan mesas para 4 personas a
  las 21:00» y las alternativas como botones.
- **Paso 3:** el texto de privacidad nombra al negocio como responsable (el contenido lo fija
  LEGAL-01). Un `mesa_no_disponible` al confirmar vuelve al paso 2 con las mesas actualizadas.
- **Paso 4:** el código de la reserva y, según `correo` en la respuesta del alta, «te hemos enviado
  los detalles a …, con un enlace para cancelarla» o, si el correo no salió, que apunte el código y a
  qué teléfono llamar.
- El plano (React Konva, lo que más pesa) se carga al llegar al paso 2: el arranque son unos 67 KB
  comprimidos.
- **Estados:** cargando; reservas cerradas o no disponibles («Ahora no se pueden hacer reservas
  online. Llama al 9xx xxx xxx», con el teléfono del negocio si se pudo leer); error de red con
  «Reintentar».

### 7.3 La línea que se pega en la web

```html
<div data-negocio="rw_…"></div>
<script src="https://tpv-api.altarialights.workers.dev/reservas-web/v1/embed.js" async></script>
```

`embed.js` (vanilla, unos 2 KB) busca los `[data-negocio]` y mete en cada uno un iframe (sin borde,
`title="Reservar mesa"`, `loading="lazy"`). No deja variables globales y no hace nada si se carga dos
veces. **El tamaño lo decide el `div`, con el CSS de la web:**

- El ancho, siempre: el iframe ocupa el 100 % del `div`, y el widget usa todo ese ancho. A partir de
  768 px reparte los pasos en dos columnas: el calendario a un lado y las personas y la hora al otro;
  el nombre, el correo y el teléfono, de dos en dos.
- El alto: el iframe, en el flujo, toma la altura que pide el widget (los mensajes `postMessage` que
  manda con un `ResizeObserver`, aceptando sólo los de su propio origen y de ese iframe). Después se
  mide el contenido del `div`, sin padding ni bordes: si no mide lo mismo, es que su CSS le pone otro
  alto (`height`, `min-height`, `max-height`, un flex que lo estira), y el iframe lo llena y el
  widget se desplaza por dentro. Mientras se mide, un `min-height: auto` (el de un ítem de flex o de
  grid, que no encoge por debajo de su contenido) se deja a 0; uno puesto en el CSS se respeta. Todos
  los `div` se miden a la vez. Se vuelve a mirar cuando un `div` cambia de tamaño (llega su CSS,
  sale de una pestaña oculta), cuando cambian su `style` o su `class` (quitarle el alto no cambia
  ningún tamaño: el iframe ya medía eso), cuando cambia la ventana y al acabar de cargar la página;
  oculto, no se mide. Si la altura que pide el widget va y vuelve entre dos valores en medio segundo
  (una web justo al borde de su barra de desplazamiento: la barra estrecha el widget, el plano
  encoge, la barra se va…), se queda con la mayor hasta que pida otra. Dos límites conocidos, sin
  arreglar a propósito:
  - Que un antepasado cambie de clase y con ello le quite el alto al `div` sin que cambie ningún
    tamaño: el widget se queda con el alto de antes, desplazándose por dentro, hasta el próximo cambio
    de la ventana.
  - Dos widgets con `flex: 1` en la misma columna de alto fijo se la reparten si los mete la misma
    ejecución del script; si el segundo `div` se añade después y el script se vuelve a cargar para
    él, cada ejecución mide sólo los suyos y pueden desbordarla. Coordinarlas obligaría a compartir
    estado entre ejecuciones sin variables globales, y que se reajustaran entre sí podría no acabar.

```html
<div data-negocio="rw_…" style="width: 900px; height: 700px"></div>
```

### 7.4 El SDK, para un formulario propio

`packages/reservas-web-sdk/`, publicado en npm como `@altarialights/reservas-web-tpv` y servido en
`/reservas-web/v1/sdk.js`. Para las webs que hace otro con su propio diseño: las rutas públicas como
funciones (`negocio`, `horas`, `plano`, `disponibles`, `verificar`, `crearReserva`,
`consultarReserva`, `cancelarReserva`). Cómo se usa, en su
[README](../../packages/reservas-web-sdk/README.md). El widget lo usa igual, con `servidor: ""` (el
mismo origen).

- **Idempotencia.** `crearReserva` pone la `Idempotency-Key` y la repite en todos los intentos de una
  reserva, también si se vuelve a llamar tras un error; tras una reserva hecha, la siguiente lleva otra.
- **Reintentos.** Sin respuesta, con un 5xx o con `verificacion_humana_fallida`, hasta tres intentos
  (esperando 1 y 3 s), con la misma clave y un token nuevo de la casilla. Con un token suelto (el
  widget, que pinta Turnstile él mismo) no reintenta: el token sólo vale una vez.
- **La casilla de Turnstile** (`verificar`). Turnstile sólo funciona en los dominios dados de alta en
  su widget, y las webs de los restaurantes no lo están. La casilla va en una página nuestra
  (`…/verificar?origen=`) en un iframe: para Turnstile la página es siempre la nuestra. El token se le
  pasa a la web con `postMessage` sólo a `origen`, que el worker ha comprobado que es una web del
  negocio y que es la única que puede incrustarla; la web pide otra comprobación con otro mensaje,
  que sólo se atiende si viene de ella (`src/casilla.ts`). El token se gasta al usarlo y la casilla
  pide otro sola.
- **Errores.** Un solo `ErrorReservas` con `codigo` y `message`; los del SDK (`red`,
  `verificacion_pendiente`) traen su frase.
- **Sin deriva.** Los tipos de lo que va y viene están en `src/tipos.ts`, sin nada del navegador, y el
  worker los importa para comprobar sus respuestas (§4.2).
- Para publicar: `pnpm --filter @altarialights/reservas-web-tpv publish` (compila antes). En el
  repositorio el paquete apunta a las fuentes; lo publicado, a `dist/` (`publishConfig`).

---

## 8. Seguridad y abuso

| Riesgo | Medida |
|---|---|
| Identificar al negocio | Clave pública por negocio, revocable desde la administración |
| Bots | Turnstile en el alta |
| Volumen | Limitadores por IP (lecturas y altas) y, detrás, los topes exactos de la agenda: 10 activas por correo, 10 altas al día por conexión (contando las anuladas) y 200 altas al día por negocio |
| Reservas falsas para bloquear mesas | Lo anterior, más el límite por correo y la cancelación por el restaurante. Una conexión sola no llena el tope del negocio cambiando de correo, ni gasta su cupo de correos reservando y cancelando en bucle (RW-ALTAS) |
| La IP de quien reserva | La agenda no la guarda: guarda un HMAC (con `LICENSE_JWT_SECRET`) de la conexión (y en IPv6 otro de su /48) y del negocio, que no se puede deshacer probando IPs ni seguir de un negocio a otro, y lo borra a las 24 h (`puerta.ts::huellasDeLaConexion`). La fila no lleva el id de la reserva, pero su `creada_ms` es el de la petición: mientras están las dos, se puede cruzar qué alta llegó desde qué huella (no desde qué IP) |
| Incrustarlo en otra web | `frame-ancestors` con los dominios del negocio |
| Usar la API desde otra web | CORS sólo para los dominios del negocio (§4.1); la casilla de Turnstile del SDK, sólo para ellos y sólo incrustada en ellos (§7.4) |
| Datos personales | Las respuestas públicas no los llevan (con un test que lo vigile) |
| Spam con nuestro dominio | Destinatario acotado (el del alta, o el cliente de una reserva web en la base del negocio), topes y nada de texto del visitante en los correos |
| Enlace de cancelar | 128 bits aleatorios, sólo su hash guardado, en el fragmento, y botón para confirmar |
| Detalles internos en los errores | Resuelto antes de empezar (FABLE-B): un 500 no lleva traza ni texto de SQLite ([worker.md](../arquitectura/worker.md#errores)) |
| Telemetría | Lo que sale a Sentry y Axiom pasa por el filtro de datos personales; los eventos llevan ids, nunca correos ni teléfonos |
| Legal | [LEGAL-01](../pendientes.md#legal-01--rgpd): texto informativo del formulario y contrato de encargado, antes del piloto |

---

## 9. Observabilidad

- **Eventos en Axiom** (dataset de sync, `service: "tpv-reservas-web"`): `reserva_web_alta`,
  `reserva_web_alta_repetida` (un intento que se repite y recibe su reserva), `reserva_web_rechazo` (con el motivo), `reserva_web_entregada`, `reserva_web_vista`,
  `reserva_web_reofrecida`, `reserva_web_fallida`, `reserva_web_cancelada` y
  `reserva_web_atascada`. Sólo ids, cuántas y motivos (`observability/axiom.ts::reportarReservaWeb`):
  los de las rutas públicas salen de ellas y los de la entrega, de la agenda.
- **Sentry** en la agenda y en las rutas públicas.
- **Una anomalía que mirar**: `reserva_web_atascada`, que la alarma apunta cuando algo lleva más de
  72 h `pendiente`. Cruzado con la última conexión de la Main (`devices.last_seen_at_ms`) dice si es
  un negocio cerrado o una Main que no recoge.

---

## 10. Tests

| Dónde | Qué |
|---|---|
| `tpv-domain` | La validación del alta, con su dominio en `validacion_casos.json` |
| Worker · disponibilidad | Una tabla de casos: días de la semana, fechas, la tolerancia de la franja, la capacidad de N a N + 2, cierres, antelación y horizonte, medianoche, comanda abierta, pendientes de la agenda |
| Worker · agenda | Dos altas a la vez para la misma mesa (gana una), el ciclo de una petición, la reoferta a la hora, `fallida` con su correo, la purga de datos personales, la cancelación antes y después de entregar, los topes (también el de la conexión, con sus anuladas, y su purga) |
| Worker · tope por conexión | En `reservasWebPublico`: la alta n.º 11 desde una IP da 429 y desde otra entra, el mismo /64 cuenta junto, el mismo /48 tiene su tope de 30 y otro /48 entra, el bucle de reservar y cancelar se corta, la IP no queda en claro en el objeto, y el «has cancelado» no sale sin confirmación (salvo de una reserva más vieja que la traza de los correos, o con el enlace del correo de un cambio). En `agendaWeb`, varias altas a la vez desde una conexión a la que le queda una: entra una sola |
| Worker · puerta pública | Clave inexistente o revocada, licencia caducada, interruptor, limitador, Turnstile, `frame-ancestors`, ningún dato personal en las respuestas |
| Worker · guardianes | `vetoAntesDelCuerpo` (con los middlewares nuevos), `mensajesDeError` (los identificadores nuevos), `TABLAS_SOLO_MAIN` con las tablas de la web |
| `tpv-infra-sqlite` | Registrar: cliente existente por correo, cliente nuevo, idempotencia por id, solape que se guarda, `Created_At` literal, captura en el outbox; cancelación idempotente; la foto del esquema; las columnas `INTEGER` declaradas |
| `tpv-application` | Recoger (orden, resultados, notificaciones) y cuándo se encola un aviso |
| Contrato | `origen` en las lecturas del calendario; editar una reserva web desde la Handy conserva `Origen` |
| Widget | Los pasos, la hora limitada a los tramos, `mesa_no_disponible`, la página de cancelar; `embed.js`; la casilla de Turnstile del SDK (`casilla.test.ts`) |
| Worker · CORS y SDK | `reservasWebCors` (el permiso sólo para las webs del negocio, el limitador del preflight, el orden en `index.ts`), la página `…/verificar` y `sdk.js` en `reservasWebWidget`, la mesa automática (también dos a la vez) en `reservasWebPublico` |
| SDK | `packages/reservas-web-sdk/test`: las rutas, la idempotencia, los errores, la casilla y los reintentos con token nuevo |
| E2E | Alta en la web → aparece en la Main. Alta con la Main apagada → aparece al encenderla. Cancelar desde el enlace → cancelada en la Main. Cambio desde el TPV → sale el aviso |

---

## 11. Fases

Cada fase se sube y se prueba sin esperar a la siguiente.

| Fase | Entrega | Hecho cuando |
|---|---|---|
| ✅ **0 · Previos** | FABLE-B. Turnstile dado de alta (§12) | Hecho el 2026-10-17 |
| ✅ **1 · Esquema y configuración** | El esquema del §3.1 en `0001`, el reset de desarrollo, Configuración → Reservas (interruptor y días cerrados), el modo «Reserva web» del editor del plano, la zona horaria, `origen` en el calendario, `TABLAS_SOLO_MAIN` | Código y tests hechos el 2026-10-17. En producción, el widget ofrece la mesa y la franja que tiene la Main, y eso lo lee de la base del negocio. Falta probar un día cerrado: no hay ninguno |
| ✅ **2 · Agenda y API pública** | Tablas centrales, `POST /clave` y el código en Configuración, la puerta pública, las rutas públicas, `AgendaWeb`, los limitadores, el interruptor, la administración de dominios y claves | Código y tests hechos el 2026-10-18 (las altas simultáneas, también). Desplegado: del 19 al 21 de octubre entraron tres reservas desde el widget, con Turnstile. Las rutas públicas contestan a una clave que no existe sin detalles internos |
| ✅ **3 · Entrega a la Main** | `avisarReservasWeb`, `/pendientes` y `/recogidas`, la recogida en el motor, el caso de uso, las notificaciones, la cancelación entregada, la reoferta | Código y tests hechos el 2026-10-18. Comprobado en producción con la Main encendida: las tres altas y dos cancelaciones llegaron, con sus avisos, sin ninguna fallida. Falta con la Main apagada (la recoge al conectar) |
| ✅ **4 · Widget** | `packages/plano`, `packages/estilos`, `apps/reservas-web`, `embed.js`, los assets en el worker y la CSP | Código y tests hechos el 2026-10-19; el tamaño desde el CSS del `div` y el plano grande (§7.2 y §7.3), el 2026-10-21. Funciona incrustado en una web; las cabeceras (CSP, caché, `nosniff`) son las del plan. Falta ver en un navegador, con lo del 2026-10-21 desplegado, que el marco crece al llegar al plano y encoge al volver o al confirmar, con y sin alto en el `div`, y en un móvil |
| ✅ **5 · Correos y cambios** | Las plantillas, el enlace de cancelar, la doble confirmación, cancelar sin borrar, la cola de avisos y su job | Código y tests hechos el 2026-10-19. En producción llegan los correos y se cancela desde el enlace. Falta ver llegar los otros tres (cambio y cancelación por el restaurante, y el de «no se pudo registrar») |
| **6 · Piloto** | Los textos de LEGAL-01, `arquitectura/reservas-web.md` y la primera web propia con un bar | Un bar recibe reservas reales |
| **7 · WordPress** | El plugin: ajustes con la clave, shortcode y bloque, que imprimen la línea del §7.3 | Instalado en un WordPress de prueba |
| ✅ **8 · API abierta y SDK** | Los nombres unificados de la API, la mesa automática, el CORS para las webs del negocio, la casilla de Turnstile en iframe y el SDK (§7.4); la dirección de la línea y los correos, fija (`RESERVAS_WEB_ORIGEN`) | Código y tests hechos el 2026-10-24. La dirección propia se probó y se volvió a `workers.dev` el 2026-10-25 (INFRA-04). Desplegado, y el SDK publicado en npm. Falta probar un formulario propio desde una web dada de alta |

---

## 12. Lo que no es código

**Cloudflare** (lo hace el responsable):

1. ✅ **Turnstile**: widget «Panel embebido de reservas», hostname
   `tpv-api.altarialights.workers.dev`, modo gestionado. Para desarrollar se usan las claves de
   prueba que publica la documentación de Turnstile.
2. ✅ El secreto está guardado como `TURNSTILE_SECRET_KEY` (`wrangler secret put`), y la clave
   pública, que no es secreta, como `TURNSTILE_SITE_KEY` en las `vars` de `wrangler.json`.
3. ✅ **Correo**: se envía desde `reservas@altarialights.com` (el dominio ya estaba dado de alta
   por `pedidos@`). Comprobado con los correos de la fase 5, que llegan en producción.
4. La clase nueva del DO y los dos limitadores van en `wrangler.json` y se crean al desplegar: no hay
   que tocar nada en el panel.

✅ **npm:** la organización `altarialights`, con el SDK publicado (fase 8).

**Base central:** las tablas del §3.2, la columna `tipo` y el índice de `email_sends` están en su
primera migración (`server/central/migraciones/0001_inicial.sql`).

---

## 13. Riesgos aceptados

- **Una mesa vendida dos veces** si la Main apunta una reserva sin internet, o en el segundo que
  tarda en replicarse. Lo resuelve el restaurante con el aviso.
- **El restaurante no se entera** de una reserva web hasta que enciende la Main: los avisos son sólo
  de la app.
- **Los correos de cambios** hechos sin internet salen cuando vuelve la conexión.
- **El correo de un cambio hecho desde la Handy** se intenta una vez: si en ese momento falla la red
  o el correo, el cambio queda hecho y el cliente no se entera por correo. La Main lo reintenta
  desde su cola.
- **Un correo puede salir dos veces** si sale, fallan los tres intentos de apuntarlo en la base
  central, se pierde además la respuesta y quien lo mandó lo repite pasados cinco minutos.
- **El enlace de cancelar es de quien hizo la reserva.** Si el restaurante se la pasa a otro cliente
  (o le corrige el correo), los avisos de cambios van al cliente nuevo, pero el enlace del correo de
  confirmación sigue cancelando esa reserva. Atarlo al cliente obligaría a invalidarlo y mandar uno
  nuevo en cada cambio de cliente; quien reservó puede cancelar lo que reservó.
- **Cancelar desde el enlace en el segundo en que el alta se da por vista** cancela, pero puede no
  mandar el correo de «has cancelado»: la lectura de la base del negocio no trae al cliente y la agenda ya olvidó
  el correo del alta. La página de cancelar ya se lo dice.
- **La dirección `workers.dev`** queda pegada en cada web. Es lo aceptado frente a un nombre propio de
  `altarialights.com`, que caería con los bloqueos de LaLiga (INFRA-04).

---

## 14. Después

Lo que se ha dejado para más adelante y en qué orden tiene sentido: hacer configurables desde el TPV
la tolerancia, el margen de plazas, la antelación y el horizonte (las columnas ya existen); varias
franjas por mesa en la pantalla (el esquema ya las admite); el plugin de WordPress; la página propia
por negocio (el widget ya es una página); el tema del widget desde el TPV; que el enlace de cancelar
del correo pueda llevar a la página de una web propia (el SDK ya tiene `consultarReserva` y
`cancelarReserva`); que el cliente modifique su reserva; juntar mesas para grupos grandes.

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
