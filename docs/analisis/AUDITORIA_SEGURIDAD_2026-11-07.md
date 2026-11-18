# Auditoría de seguridad (2026-11-07)

Auditoría del repositorio con la skill [`security-audit` de Cloudflare](https://github.com/cloudflare/security-audit-skill)
(commit `c1c8a8c` de la skill), en modo completo y perfil `standard`, sobre `main` en `3662dcde` (sin
Veri\*factu), el 7 y el 8 de noviembre de 2026; y, a continuación, investigación a fondo de cada pista,
con tests ejecutados, sobre `main` en `38a4c2db`.

## Lo que hay que saber antes de leer

- **Cómo se ha hecho.** La auditoría, seis fases con agentes separados (ver «Cómo se hizo»), sólo leyó
  código y dejó 44 pistas sin confirmar. Después, cada pista la investigó un agente distinto en una
  copia aislada del repositorio (un worktree de `main` en `38a4c2db`, sin `.dev.vars` ni `.env`):
  escribió tests temporales y los ejecutó (vitest del worker dentro de workerd, vitest del frontend con
  jsdom, nextest de Rust), consultó la documentación oficial cuando lo decidía la plataforma, valoró la
  gravedad y propuso el arreglo. No se ha cambiado código del proyecto ni se ha enviado tráfico a
  ningún despliegue.
- **Resultado.** Ninguna se descartó. Siguen abiertas 11 de la auditoría: **9 confirmadas con un test**
  (contando AUD-45, que salió al investigar) y 2 sin resolver
  porque dependen de cómo se comporta una plataforma (AUD-31 y AUD-39).
- **AUD-46 no sale de la auditoría ni es de seguridad**: es un fallo de coste que destapó la primera
  prueba de carga contra producción (10 de noviembre). Se apunta aquí con lo medido; su causa está
  **sin investigar**.
- **Gravedad**, con la escala de la revisión integral: 🔴 bloqueante · 🟠 alta · 🟡 media · 🔵
  baja/mejora. Ninguna bloqueante; una alta (AUD-46) y 11 medias. Cada sección
  dice en una línea por qué.
- **Los tests están guardados** en `C:\Users\diego\security-audit-skill\tpv-completa\run-1\investigacion\AUD-NN\tests\`,
  con la ruta que tendrían en el repositorio. Casi todos sirven de test de regresión al arreglar:
  hoy demuestran el fallo o fallan donde comprueban el arreglo.
- **Las líneas citadas son de `38a4c2db`.** `main` ha seguido avanzando desde entonces (la retirada de
  los negocios de pruebas del E2E y otros); en `licensing.helpers.ts`, las líneas a partir de la 445 se
  han movido unas seis.
- **Ninguna repite un riesgo ya aceptado** en [pendientes.md](../pendientes.md) (SEC-SESION, FABLE-E,
  LOGIN-04, LIC-02, INFRA-02, INFRA-03, RI-28-AUD). Cuando una va más allá de uno de
  ellos, se dice.
- Lo que sólo se puede decidir con un panel, una cuenta o un equipo real está reunido al final, en «Lo
  que sólo puede comprobar el responsable».
- Los IDs `AUD-NN` siguen la convención del repositorio: al arreglar una, su ID va a un comentario junto
  al arreglo y la entrada se borra de aquí.

## Resumen

La base es sólida en lo que más cuesta: autenticación del dispositivo (JWT con algoritmo fijado y firma
Ed25519 que cubre método, ruta, consulta y cuerpo), administración que falla cerrada, webhook de Stripe con
HMAC, licencias firmadas con claves fijadas, CSP estricta sin HTML inyectado en React, ningún secreto en el
historial y aislamiento entre negocios por token en las rutas de negocio. La investigación confirma casi
todas las pistas, pero rebaja muchas: bastantes exigen sacar de la app la credencial de un equipo
emparejado, o controlar la Main, y casi ninguna expone datos de otros negocios.

**La alta** (AUD-46) no es de seguridad y es lo más importante de lo que queda: el Durable Object de
cada negocio no hiberna mientras su Main está conectada, se use o no, y lo incluido en el plan de
Cloudflare sólo da así para dos o tres bares. Falta investigar la causa.

**Las medias, por bloques:**

1. **Licencias, dispositivos y acceso** (AUD-45): una consulta del banco que revoca la licencia sin
   vuelta atrás.
2. **Recursos compartidos sin cuota** (AUD-09, 12, 13, 31, 36, 38) y **correo**
   (AUD-39, 42): cualquiera o un solo negocio pueden gastar lo que es de todos (bases, códigos,
   copia diaria, CPU, cupo de correo). AUD-31 y AUD-39 siguen
   sin resolver: dependen de cómo responden los decodificadores de imagen de WebView2 y Android y el
   correo de Cloudflare.
3. **Emparejamiento** (AUD-10, 11): oráculos y frenos del emparejamiento.

## Tabla

| ID | Gravedad | Estado | Bloque | Pista |
|---|---|---|---|---|
| AUD-09 | 🟡 | Confirmado (test) | A | La primera activación crea una base de Turso por cada petición simultánea |
| AUD-45 | 🟡 | Confirmado (test) | A | Una consulta del banco (inquiry) revoca la licencia y nada la devuelve |
| AUD-10 | 🟡 | Confirmado (test) | B | `fetch-token` dice sin freno qué códigos de emparejamiento están vivos |
| AUD-11 | 🟡 | Confirmado (test) | B | La espera por fallos del `claim` se reinicia y cuenta por IP exacta |
| AUD-12 | 🟡 | Confirmado (test) | B | Los códigos de emparejamiento nunca se liberan |
| AUD-13 | 🟡 | Confirmado (test) | B | Reclamar el propio código infla la base central y deja sin copia a todos |
| AUD-46 | 🟠 | ? | F | El TenantHub no hiberna mientras hay una Main conectada |
| AUD-31 | 🟡 | Sin resolver | F | La webview pinta logos e imágenes replicados sin comprobar su forma ni RI-07 |
| AUD-36 | 🟡 | Confirmado (test) | F | Sin cuota por negocio en la organización de Turso compartida |
| AUD-38 | 🟡 | Confirmado (test) | F | Un anónimo agota las altas web de un negocio |
| AUD-39 | 🟡 | Sin resolver | G | El destinatario de los correos de reservas web admite listas y CR/LF |
| AUD-42 | 🟡 | Confirmado (test) | G | Los topes del código de cambio de correo se saltan con peticiones simultáneas |

## A · Licencias, identidad y aislamiento entre negocios

### AUD-09 · La primera activación crea una base de Turso por cada petición simultánea

- **Estado.** Confirmado con un test en workerd (base central en SQLite con su esquema; Turso, un doble).
- **Gravedad.** 🟡 media. Sin acceso ni efecto en los negocios activos, pero una compra deja decenas o
  cientos de bases: con el plan Free de Turso (100 bases; `copiaBaseCentral.ts:6` da a entender que es el
  suyo) bloquea toda primera activación; con uno de pago (sin techo desde el 2026-05-03), es basura.
- **Qué pasa.** Cada petición lee la licencia sin reservarla, estrena `tenantId` y crea tenant `active`,
  dispositivo, base, token, fila de `tenant_databases` y esquema; luego el `UPDATE` condicionado elige
  una y las demás reciben 409 `device_replaced` sin compensar. Nada lo borra (ni la purga ni
  `pruebas/retirar` de `main`). Si falla tras crear la base, la clave no se gasta: otra por reintento.
- **Dónde.** `licensing.routes.ts:203`, `:385`, `:410`, `:434-453`; `licensing.helpers.ts:501-518`.
- **Quién.** Quien tenga una clave sin estrenar: hay que comprarla. Sólo frena `LIMITADOR_LICENCIA`
  (10/min por IP exacta, aproximado y por centro de datos): con varias IP cabe toda la ráfaga, pero una
  sola por clave comprada: en workerd local, cortar la conexión a mitad no deja la clave sin gastar
  (Cloudflare dice que «puede» cortarse).
- **Cómo se ha comprobado.** `aud09PrimeraActivacion.test.ts` (Turso falso, 50 ms): 5 a la vez → 1×200,
  4×409, 5 bases, tenants y dispositivos, 4 sin licencia; con el limitador local, 12 desde una IP → 10
  bases; con el token caído, 3 reintentos → 3 bases sin fila y la clave `issued`. Falta, del responsable
  en Turso: el plan, cuántas bases hay y las consultas de huérfanos del plan de validación.
- **Arreglo.** `licenseStore.ts`: `reservarTenantDeLaLicencia` (`UPDATE licenses SET tenant_id=? WHERE
  license_id=? AND tenant_id IS NULL AND main_device_id IS NULL` y `SELECT` del que quede; `null` si ya
  hay Main) y, en `licensing.routes.ts:385`, usarlo en la primera activación (409 si `null`). En
  `tursoCreateDatabase` (`licensing.helpers.ts:478`), el 409 de Turso por nombre repetido lee la base
  (`GET …/databases/{nombre}`) y sigue. Ajustar REV-15 (`:441-451`), `licencias.md:138` y su test.
- **Test de regresión.** El mismo, con el Turso falso dando 409 al nombre repetido: la ráfaga deja una
  sola base y un tenant, y los reintentos con el token caído reutilizan esa base.

### AUD-45 · Una consulta del banco (inquiry) revoca la licencia y nada la devuelve

- **Estado.** Confirmado con test, por el worker entero (`src/index.ts`) y con eventos firmados con HMAC.
- **Gravedad.** 🟡 Media: deja sin TPV a un bar que pagó y cuyo dinero no se ha movido, y no se cura
  sola; sin atacante, rara (sobre todo Amex y Discover; Klarna, si el enlace la admite) y reversible.
- **Qué pasa.** Llega como `charge.dispute.created` con estado `warning_*`, sin retirar fondos. El
  webhook la trata como un contracargo: revoca el alta y marca el cobro `dispute`. Si no escala, se
  cierra `warning_closed` (con tarjeta, a los 120 días; no hay «ganada») y nada se restaura. La Handy
  recibe 403 `license_revoked` en un minuto y la Main se bloquea en su comprobación (≤ 6 h), sin perder
  datos (RI-09). Desrevocar a mano no quita la marca: un reembolso total posterior ya no revoca.
- **Dónde.** `stripe.routes.ts:506-508` (abre sin mirar `status`), `:512-516` (sólo `won`), `:91-95`
  (sin `funds_withdrawn`); `admin.routes.ts:264`; `stripeReversal.test.ts:52` abre con `warning_*`.
- **Quién.** El banco emisor, a menudo porque el titular no reconoce el cargo; Visa y Mastercard ya no
  usan esta fase. Nadie gana nada provocándolo: es servicio perdido para un cliente, no un ataque.
- **Cómo se ha comprobado.** `aud45ConsultaDelBanco.test.ts` (workerd, esquema de producción): consulta
  abierta → `revoked`, Main y Handy vetadas; `warning_closed` → igual; `funds_withdrawn` → `ignored`. Sus
  5 de regresión fallan hoy y pasan con el parche, solo o junto al de AUD-08 (ya en `main`); las suites existentes
  y sus copias con los arreglos, 97/97. Falta que el responsable vea en modo test (`4000000000001976`,
  `escalate_inquiry_evidence`) que al escalar llega `funds_withdrawn` (Stripe lo dice para Klarna).
- **Arreglo.** En `decidirReversion` (`stripe.routes.ts:506-516`): `warning_*` sólo se audita;
  `charge.dispute.funds_withdrawn` (en `EVENTOS_DE_REVERSION` y en el Dashboard) revierte como la
  apertura, y `closed` `lost` lo pendiente. `licencias.md:80-92` y `:378`; `stripeReversal.test.ts:52`
  a `needs_response`. Casa con el de AUD-08, ya en `main`: lo que añade va en `revertirCobros`. Lo ya revocado: desrevocar y limpiar la marca del cobro.
- **Test de regresión.** Los 4 casos «AUD-45» que el parche añade a `stripeReversal.test.ts` (hoy fallan)
  y el bloque «regresión» de `aud45ConsultaDelBanco.test.ts`.

## B · Emparejamiento de Handys

### AUD-10 · `fetch-token` dice sin freno qué códigos de emparejamiento están vivos

- **Estado.** Confirmado con un test por la ruta.
- **Gravedad.** 🟡 Media: no se elige negocio y el token exige que el dueño acepte una solicitud ajena.
- **Qué pasa.** Con una prueba inventada, `fetch-token` contesta 404 si el código no existe y 409
  `not_approved` si está vivo y pendiente (410, 409 o 403 en los otros estados) antes de mirar la
  firma, sin limitador, espera por IP ni intentos. Un `claim` sin secreto se adelanta entonces a la
  Handy y, si el dueño pulsa «Aceptar», da un token de Handy de 30 días. `cancel` y `approve` (con
  cualquier Main) sólo dicen si el código se emitió alguna vez: `pair_requests` no se purga.
- **Dónde.** `pairing.handy.ts:279-290` (firma en :298) y `:440-442`; `pairing.main.ts:167-169`.
- **Quién.** Cualquiera de internet; en `approve`, la Main de cualquier negocio.
- **Cómo se ha comprobado.** `test/aud10OraculoEmparejamiento.test.ts`, 4 casos en verde: con el
  limitador agotado, 100 sondas a códigos inexistentes dan 404 y los vivos y pendientes se separan de
  los caducados, gastados, rechazados y aprobados, a una lectura por sonda y sin anotar fallos ni
  intentos; una IP bloqueada por el `claim` sigue viendo qué código vive; la cadena acaba en un JWT
  `handy` y un alta en `devices` (aprobación simulada). En `workers.dev` (INFRA-04) no caben reglas
  propias y el BIC sólo frena los User-Agent de biblioteca. Falta que el responsable mida, leyendo la base
  central, cuántos códigos caducan sin reclamar.
- **Arreglo.** Tras leer el código, `!pr || claimed_by_device_id !== deviceId` → 404
  `pair_code_not_found` en `entregarToken` (y la firma antes de los estados) y en `soltarCodigo`; en
  `aprobarSolicitud`, 404 al de otro negocio, como `rechazarSolicitud`. Quitar `device_mismatch` y
  `wrong_tenant` de `MENSAJES` (`lib/errorCodes.ts:163,170`). Ni limitador ni espera en `fetch-token`
  (la Handy pregunta cada 1,5 s y sólo tolera `not_approved`) ni exigir el secreto del QR.
- **Test de regresión.** Los casos 1 y 3 del test, invertidos, en `emparejamiento.test.ts`: sin firma
  válida o desde otro negocio, siempre 404 `pair_code_not_found`; cambian las esperas de :530 y :548.

### AUD-11 · La espera por fallos del `claim` se reinicia y cuenta por IP exacta

- **Estado.** Confirmado con test; la mitad IPv6, confirmada en código y respaldada por docs oficiales.
- **Gravedad.** 🟡 Media.
- **Qué pasa.** La espera por tramos de `/v1/pair/claim` es «el control de verdad» contra barrer los
  10⁶ códigos (~144/día por IP). Dos fugas: (1) todo claim con éxito borra la fila de la IP
  (`olvidarFallos`), y eso pasa al reclamar un código propio pendiente (`:237`, no gasta `attempts`),
  el ya aprobado (`:199`) o el primero de uno nuevo (`crearCodigo` sin tope); (2) la clave es la cadena
  exacta de `CF-Connecting-IP`, y en IPv6 cada dirección de un /64 cuenta aparte.
- **Dónde.** `pairing.intentos.ts:81`; `pairing.handy.ts:199,237`; `pairing.avisos.ts:28`,
  `lib/limitador.ts:23`; sin tope en `pairing.main.ts:46`.
- **Quién.** La fuga (1), un negocio con licencia; la (2), cualquiera con un /64 IPv6. Ninguna logra el
  alta: la Main la aprueba a mano por huella y el código vive 10 min. Daño real: oráculo de existencia,
  estorbar un emparejamiento legítimo (409 a la Handy buena) y coste de lecturas.
- **Cómo se ha comprobado.** `aud11.defecto.test.ts` (8 casos, SQL real): 20 fallos + 10 reclamos
  propios sin un 429; 100 direcciones de un /64 = 200 fallos sin 429; con cupo 20, ~13 lecturas
  reales/min frente a ~3 sin el truco; el barrido /64 gana el claim del código vivo ajeno. La entrega
  de la IPv6 /128 se apoya en docs (workers.dev publica AAAA; Pseudo IPv4 Off por defecto); una sonda
  en vivo lo cerraría.
- **Arreglo.** Quitar las dos `olvidarFallos` de `pairing.handy.ts` (`:199`, `:237`; el olvido de 24 h
  basta) y un `claveDeFreno(ip)` que agrupe IPv6 por /64, usado en
  `segundosDeEspera`/`anotarFallo`/`olvidarFallos` y en `pasaElFiltroExterior`. Sólo ensancha la clave
  (un bar ya comparte IP): no bloquea a nadie ni exige tope en `/create`.
- **Test de regresión.** Los casos de `aud11.defecto.test.ts` con el veredicto invertido, en `describe`
  «la espera por fallos» de `test/emparejamiento.test.ts`; **actualizar** allí «emparejar bien borra la
  cuenta» (`:234`) y «cada IP lleva su cuenta» (`:258`), que hoy fijan el defecto.

### AUD-12 · Los códigos de emparejamiento nunca se liberan

- **Estado.** Confirmado con tests.
- **Gravedad.** 🟡 media.
- **Qué pasa.** `pair_code` es clave primaria global (10⁶ números), nada borra `pair_requests` y una
  fila ajena caducada hace meses ocupa su número como una viva; `/create` no tiene tope ni limitador.
  Una Main puede ir gastándolos: al 99 % fallan 9 de cada 10 llamadas de todos (~1,21 millones de
  peticiones) y al 99,9 %, 99 de cada 100 (~1,45 millones); dura hasta limpiar a mano. Antes, a ~122.000
  filas, la copia diaria no cabe (AUD-13). El uso normal también gasta: «Vincular Handy» abierta, 6/h.
- **Dónde.** `pairing.routes.ts:83` → `pairing.main.ts:62-88`; `purga.ts:68` no incluye la tabla.
- **Quién.** La Main de un negocio con licencia, también en gracia. Las Handys vinculadas y la venta
  siguen; lo que falla es vincular una Handy nueva o revincularla, en cualquier negocio.
- **Cómo se ha comprobado.** `aud12CodigosEmparejamiento.test.ts`, 13 en verde: con el sorteo fijado,
  una fila caducada ajena, en cualquier estado, da 500 y sin ella 200 con ese número; 200 creaciones
  seguidas dejan 200 vivos; la purga no toca filas de hace 400 días; por la ruta, con `tenantAuth`
  real y los cuatro limitadores llenos, 100 × 200 sin consultarlos. `aud12VincularHandyRitmo`: 7
  códigos en una hora. Falta la ocupación real: el responsable, `SELECT COUNT(*) FROM pair_requests`.
- **Arreglo.** `server/purga.ts`: `DELETE FROM pair_requests WHERE expires_at_ms < ?1` (24 h de
  retención; por caducidad, no por estado: lo que nadie toca sigue `pending`), contado en `Purgado` y
  en el log del cron. `pairing.main.ts:68-83`: el tope en la misma sentencia, `INSERT … SELECT … WHERE
  (SELECT COUNT(*) FROM pair_requests WHERE tenant_id = ?3 AND expires_at_ms >= ?5) < 20 ON
  CONFLICT(pair_code) DO NOTHING`; sin fila y con 20 vivos, 429 `too_many_attempts` con «Usa el código
  de la pantalla o espera unos minutos». Nadie vincula 20 Handys en 10 min; regla en `emparejamiento.md`.
- **Test de regresión.** Los dos casos del arreglo de ese fichero, a `purgaBaseCentral.test.ts` y a
  `emparejamiento.test.ts` (el número purgado vuelve a salir; el 21.º vivo da 429 y, caducados, 200).

### AUD-13 · Reclamar el propio código infla la base central y deja sin copia a todos

- **Estado.** Confirmado con un test local: por la ruta, con la purga, el techo real y el cron de verdad.
- **Gravedad.** 🟡 Media.
- **Qué pasa.** `claimSchema` no limita `deviceId` ni `deviceName`, y el mismo dispositivo reclama su
  código pendiente sin cupo: cada vez entra en `device_challenges` una fila con el `deviceId` entero, sin
  sumar intentos, y nada la borra. La copia diaria (PROD-02) aborta pasados 64 Mi caracteres: unas 1 340
  reclamaciones de 50 000 caracteres la paran para todos los negocios, cada día, hasta borrar las filas
  a mano. El servicio sigue y el PITR cubre 24 h. Cada una ocupa además ~150 KB en SQLite del espacio de
  Turso común: en el plan Free, rebasarlo bloquea todas las bases (el sumidero de AUD-36).
- **Dónde.** `pairing.routes.ts:60` → `pairing.handy.ts:68` → `purga.ts:68` → `copiaBaseCentral.ts:99`.
- **Quién.** Un negocio con licencia: su Main crea un código cada 10 min y un script lo reclama al ritmo
  del único freno, 20 por minuto e IP (poco más de una hora desde una). El código lleva su `tenant_id`.
- **Cómo se ha comprobado.** `aud13CrecimientoEmparejamiento.test.ts`, por la ruta: 20 reclamaciones dan
  200 y dejan 20 filas de 50 000 caracteres que la purga no toca (la 21.ª de esa IP, 429; desde otra,
  200); cada una cuesta L + 204 en el volcado. Con 1 340, el `scheduled` real no sube copia ni suena su
  latido y registra `copia_demasiado_grande`. Con 1 MiB por reclamación bastarían 64, si Turso lo acepta.
- **Arreglo.** `.max(200)` en `deviceId` y `deviceName` (`pairing.schemas.ts:53,57`, como
  `licensing.schemas.ts:3,21`), con `invalid_deviceId` en `SIN_MENSAJE_PROPIO` (`errorCodes.ts`); y en
  `purga.ts:68`, `DELETE FROM device_challenges WHERE expires_at_ms < ?1` con `ahoraMs` (el reto caduca
  con su código), con su contador en `Purgado` y en el log de `index.ts:290`. Hacen falta los dos: sin
  tope, el abuso cabe en los 10 min previos al cron; sin purga, se acumula. Ninguna Handy real lo nota.
- **Test de regresión.** Por la ruta, un `deviceId` de 201 caracteres da 400 sin dejar fila; un reto
  caducado se purga y uno vivo no; y el caso del techo real acaba con copia y con los dos latidos.

## C · Dinero, caja y réplica

## D · El puesto local frente al personal

## E · Datos personales en registros y telemetría

## F · Disponibilidad y coste del servicio compartido

### AUD-46 · El TenantHub no hiberna mientras hay una Main conectada

- **Estado.** Medido en producción con el generador de carga, el 10 de noviembre de 2026. **La causa
  está sin investigar: falta una investigación a fondo.** No sale de la auditoría ni es de seguridad.
- **Gravedad.** 🟠 Alta, la mayor de las abiertas. No rompe nada, pero cada negocio con el programa
  abierto gasta duración del Durable Object todo el rato, venda o no, y es el primer límite de la
  plataforma con mucha diferencia: los de peticiones y filas están en millones al mes.
- **Qué pasa.** Con una Main y una Handy conectadas al WebSocket y sin tráfico, el `TenantHub` del
  negocio figura activo los 60 s de cada minuto y factura 7,68 GB·s por minuto (461 por hora), sin
  recibir ninguna invocación: los pings los contesta la auto-respuesta. Según Cloudflare, un DO con los
  sockets entregados por `acceptWebSocket` hiberna al poco de quedarse sin eventos, y hibernado no
  factura duración. Lo que cuesta, si a la Main real le pasa lo mismo:
  - Los 400.000 GB·s incluidos al mes dan para unas 868 horas de Main conectada **entre todos los
    negocios**. Un bar con el PC siempre encendido (720 h) se lleva el 83 %; uno que abre 12 horas al
    día, el 41 %.
  - Pasado lo incluido, 12,50 $ por millón de GB·s: unos 2 $ al mes por cada bar de 12 horas.

  Además, el cierre limpio del cliente no se completó: tras su `close(1000)`, Cloudflare siguió contando
  las dos conexiones, y el DO activo, 40 minutos más, hasta que murió el proceso del cliente. En local
  (`wrangler dev`) ese mismo cierre termina al momento.
- **Dónde.** Sin localizar. Lo que se sabe del código, sin haber investigado:
  - El DO entrega los sockets con `acceptWebSocket` (`tenantHub.rutas.ts:118`, SYNC-16) y registra la
    auto-respuesta del ping (`tenantHub.motor.ts:136`).
  - En `durableObjects/` no hay `setTimeout` ni `setInterval`, y las únicas alarmas son las de la cola
    (SYNC-18), que estaba vacía.
  - `webSocketClose` no llama a `ws.close()` (`tenantHub.motor.ts:1479-1488`). Con fecha de
    compatibilidad desde el 2026-04-07 Cloudflare contesta sola al cierre, y `wrangler.json` lleva
    `2026-05-29`; falta ver con cuál está desplegado el worker.

  Por dónde empezar, todo sin comprobar:
  - `fetchConPlazo` (`server/db/clients.ts:32-90`): el único temporizador que usa el DO, 15 s por
    petición a Turso, que se suelta al terminar de leer el cuerpo.
  - El cliente de libsql que el DO guarda en caché 6 horas (`tenantHub.motor.ts:82`) y lo que deje
    abierto.
  - `Sentry.instrumentDurableObjectWithSentry`, que envuelve el DO (`index.ts:76`).
  - Los `waitUntil` del DO: el envío a Axiom de `emitSyncEvent` (`tenantHub.motor.ts:1188`) y la purga
    del log (`:680`).
- **Quién.** Nadie lo provoca: le pasaría a todo negocio con la Main abierta. La medida es con la Main y
  la Handy sintéticas del generador, que hablan el mismo protocolo y mandan el mismo ping que la app;
  falta confirmarlo con la Main real.
- **Cómo se ha comprobado.** Tanda `20261110-132959` de `node scripts/carga/carga.mjs --nube` contra el
  worker desplegado, con el negocio de pruebas `90b7195d-d0a7-4913-8aa4-5ff1ea4bf570` (ya retirado). Los
  datos son del GraphQL de analítica de Cloudflare, `durableObjectsPeriodicGroups` y
  `durableObjectsInvocationsAdaptiveGroups`, filtrados por el namespace de `TenantHub` y por `name` = el
  negocio, minuto a minuto (UTC):

  | Minutos | Qué hacía la tanda | Invocaciones | Activo | GB·s | Conexiones |
  |---|---|---|---|---|---|
  | 12:30 | Alta, semilla y emparejamiento | 16 | 60 s | 7,68 | 2 |
  | 12:31–12:33 | Nada: sólo los pings, cada 30 s | 0 | 60 s cada minuto | 7,68 cada minuto | 2 |
  | 12:34 | La carga: 10 escrituras de la Handy y 3 de la Main | 13 | 60 s | 7,68 | 2 |
  | 12:35 | `close(1000)` de los dos sockets | 2 | 60 s | 7,68 | 2 |
  | 12:36–13:14 | Nada: ni pings; el cliente esperaba el cierre | 0 | 60 s cada minuto | 7,68 cada minuto | 2 |
  | 13:15 | Muere el proceso del cliente | 0 | 57 s | 7,34 | 0 |
  | 13:16 | — | 0 | 0 s | 0 | 0 |

  En total, 353 GB·s en 46 minutos, con invocaciones sólo en tres. El informe de la tanda, sus ficheros,
  las dos consultas y su salida están en
  `C:\Users\diego\security-audit-skill\tpv-completa\run-1\investigacion\AUD-46\`. El generador sale ahora
  con `process.exit` al terminar, para no dejar el DO despierto esperando el cierre.
- **Qué falta investigar.**
  1. Confirmarlo con la Main real: la misma consulta con el negocio de desarrollo, o el panel de
     Cloudflare (Durable Objects → TenantHub → Metrics).
  2. Aislar la pieza que lo mantiene despierto. `wrangler dev` no mide duración, así que hay que medirlo
     desplegado: quitar o apagar una a una las candidatas de «Dónde» y repetir la medida.
  3. Acotarlo: si pasa con una sola conexión, si pasa antes de la primera escritura (sin cliente de
     Turso creado) y cuánto tarda en dormirse tras la última invocación.
  4. El cierre: por qué en producción el cliente no recibe la respuesta a su `close` y en local sí.
- **Test de regresión.** La tanda `--nube` mide la ventana «sesión abierta sin tráfico», entre la
  preparación y la carga (`scripts/carga/coste.mjs`): arreglado, tiene que dar 0 s activos y 0 GB·s.

### AUD-31 · La webview pinta logos e imágenes replicados sin comprobar su forma ni RI-07

- **Estado.** Sin resolver: la causa está confirmada con tests; el efecto depende del decodificador.
- **Gravedad.** 🟡 media; 🟠 si WebView2 o Android WebView mueren con una imagen de dimensiones enormes,
  porque el valor se replica a todos los equipos y se pinta en cada arranque, también en el login.
- **Qué pasa.** `resolveImageUrl` devuelve tal cual `data:`, URL absolutas y lo que empieza por «/», y
  hace URL `asset:` de una ruta que Rust rechaza. Los bytes de R2 no pasan por RI-07 en quien los pinta:
  la Main los escribe sin `imagenes::procesar` y la Handy los lee de r2.dev. La CSP deja pasar `data:`.
  Nadie trata la caída del renderizador: wry 0.55.1 no sobrescribe `onRenderProcessGone` (Android cierra
  la app) ni atiende `ProcessFailed` (WebView2 deja una página de error y la recuperación es de la app).
- **Dónde.** `configuracion.schemas.ts:16`, `inventario.schemas.ts:39,53` → `imageUrl.ts:64-80,97-109`;
  `lib.rs:1231-1236` (`images_ensure_local`); `images.routes.ts:120` (sólo firma y 5 MB).
- **Quién.** Quien saque las credenciales de una Handy (en Windows, del Administrador de credenciales;
  en Android, del Keystore): las rutas sólo piden `tenantAuth`. Por la interfaz está cerrado.
- **Cómo se ha comprobado.** `aud31ImagenSinForma.test.ts` en `tpv-main` (5 en verde: `data:`, `https:`,
  `//` y `http://asset.localhost` salen tal cual y `data.db` sale como `asset:appdata/data.db`) y en el
  worker (16 en verde: schemas y builders guardan esos valores y `applyViaHub` llega al `TenantHub`).
  Falta si los decodificadores acotan una imagen así: el responsable, en VM Windows y emulador sin red.
- **Arreglo.** (1) `imageUrl.ts`: aceptar sólo la forma de `REL_PATH_RE` y `/alergenos/<nombre>.png`;
  lo demás, o un fallo de `imagesEnsureLocal`, da `""`. (2) `lib.rs:1232-1235`: `imagenes::procesar`
  antes de `fs::write`; si falla, `Ok(false)`. (3) PUT `/v1/images`: rechazar si la cabecera declara más
  de 8192 px por lado o 24 Mpx. (4) Exigir esa forma en schemas y Main (`configuracion.rs:248`,
  `inventario.rs:38,124`), con casos en `validacion_casos.json`. Acotar `data:` por peso no basta.
- **Test de regresión.** Los dos tests con la expectativa invertida, un PNG de 8193×1 rechazado en el
  PUT y un test de fuente que exija `procesar` en `images_ensure_local`.

### AUD-36 · Sin cuota por negocio en la organización de Turso compartida

- **Estado.** Confirmado: test en el DO; el bloqueo de los demás negocios lo documenta Turso.
- **Gravedad.** 🟡 Media: pide una Main con licencia y se revierte (plan, revocar), pero alcanza a todos.
- **Qué pasa.** El DO ejecuta lo que la Main manda por el WebSocket (DDL, CTE recursivas, `zeroblob`)
  sin presupuesto por negocio de filas, bytes ni frecuencia, y su cola guarda lo que llegue. Las bases
  se crean sin `size_limit` en `altarialights`, la organización de la central, y los topes de Turso son
  suyos: en Free o sin excedentes, pasar uno bloquea todas sus bases (ni Handy ni réplica en ningún
  negocio) hasta el mes siguiente, y `/health` sólo lee; con excedentes, ~1 $ por millón de filas.
- **Dónde.** `tenantHub.mensajes.ts:362-497` → `tenantHub.motor.ts:401-428`; `tenantHub.cola.ts:150`
  → `motor.ts:610-641`; `licensing.helpers.ts:468` (474 en `main`); `wrangler.json:104-105`.
- **Quién.** La Main de un negocio con licencia: su dueño o quien controle el PC (`_Sync_Outbox` va sin
  firma), o una versión con un bucle. También una Handy por REST, con textos sin máximo (`notas`).
- **Cómo se ha comprobado.** `test/aud36SinCuota.test.ts` (workerd; la base, el SQLite del DO), 5/5 sin
  rechazo: tras un `CREATE TABLE`, un `apply` de 262 B escribe 5.000 filas y 5 MB; 20 seguidos, 100.000
  filas en 0,6 s; dos `bulk_apply` de 500 dejan 3,4 MB en la cola; el alta va sin `size_limit`. Bloqueo:
  turso.tech/pricing. Falta el plan y si hay excedentes (el código cita el «plan Free»): panel de Turso.
- **Arreglo.** (1) Presupuesto por negocio en el SQLite del DO (`_Presupuesto`, no en un campo): filas
  (`rowsAffected` tras `db.batch`, `motor.ts:428` y `:641`) e intentos por hora, mirado antes de
  `buildApplyBatch` (`:401`, `:610`); pasado, `presupuesto_agotado` 429 `transitorio` (la Main sigue
  cobrando y conserva la operación) y aviso a Sentry. (2) `atenderBulkApply` (`mensajes.ts:311`): como
  mucho 200 operaciones por trozo, las que ya manda la Main. (3) `size_limit` en `tursoCreateDatabase` y
  `PATCH …/configuration` a las bases que ya hay. (4) La central, en otra organización de Turso.
- **Test de regresión.** Ese test, como `presupuestoPorNegocio.test.ts`: el `apply` que pasa el tope da
  `presupuesto_agotado` sin escribir, el trozo de 501 `bulk_ack ok:false` y el alta lleva `size_limit`.

### AUD-38 · Un anónimo agota las altas web de un negocio

- **Estado.** Confirmado con tests.
- **Gravedad.** 🟡 Media: un negocio sin reservas web, cada día y sin enterarse; ni cobros ni datos.
- **Qué pasa.** `altasDesde` cuenta todas las altas de 24 h, también las que su autor anula antes de
  que la Main las recoja. Con la Main apagada, reservar y cancelar 200 veces el mismo hueco agota el
  tope sin dejar nada en el TPV ni ocupar mesa: toda alta legítima, tras elegir mesa y pasar Turnstile,
  recibe 429 `tope_reservas_negocio` («…Llama para reservar.») durante 24 h. La purga no las borra, y
  si la Main las recibe y el restaurante las cancela, siguen contando. Nadie lo reinicia desde el
  código; el operador sólo a mano, con Data Studio del panel sobre el SQLite de la agenda.
- **Dónde.** `apps/cloud-worker-licensing/src/durableObjects/agendaWeb.almacen.ts:273-279`, usado en
  `agendaWeb.motor.ts:404`; la anulación, en `agendaWeb.motor.ts:512` y `agendaWeb.almacen.ts:394-403`.
- **Quién.** Cualquiera: la clave está en la web del restaurante. Necesita un token de Turnstile por
  alta (el widget lo da; en modo gestionado sólo hay casilla si el riesgo lo pide) y los enlaces: los
  topes de correo van por dirección literal y con alias `+n` basta un buzón. Unos 20 min desde una IPv4.
- **Cómo se ha comprobado.** `aud38TopeNegocio` (el test del plan y tres variantes) y
  `aud38RutaTopeNegocio` (por `/reservas` y `/cancelar`, con `email_sends`): 40 alias × 5 ciclos, 400
  correos a un buzón, 200 anuladas, nada para la Main, la mesa libre y el 429 con su frase. Falta, para
  el responsable: los tokens sin casilla, la cuota de correo de la cuenta y si ya ha pasado (Axiom).
- **Arreglo.** En `altasDesde`, `AND estado <> 'anulada'` (una anulada no llega a la Main ni ocupa
  mesa), con `AUD-38` en el comentario; probado con `vi.mock`: el alta legítima entra y lo entregado
  sigue contando. A `pendientes.md`: 200 altas vivas falsas lo agotan igual, y el techo siguiente,
  600 correos por negocio, cae con ≥300 ciclos (entran sin confirmación; corregir `correos.ts:27`).
- **Test de regresión.** En `agendaWeb.test.ts`, junto al de la línea 364 (que sigue dando 429): 200
  altas canceladas sin `pendientes` y el alta legítima da `ok`, como en `aud38ArregloPropuesto`.

## G · Correo desde el dominio del operador

### AUD-39 · El destinatario de los correos de reservas web admite listas y CR/LF

- **Estado.** Sin resolver: lo del TPV, comprobado con tests; lo que hace Cloudflare con la cadena, no.
- **Gravedad.** 🟡 media si Cloudflare reparte la lista o deja pasar el CR LF; 🔵 baja si las rechaza.
- **Qué pasa.** `isValidEmail` y `validate_email_basic` piden seis caracteres, alguna `@`, un punto y
  ningún U+0020: pasan «a@x.es,b@y.es», `;`, `<…>`, varias `@`, TAB y CR LF. La cadena es el `to` de
  la confirmación y de la cancelación, y el tope de 10 por destinatario la cuenta tal cual: cada lista
  u orden es otro contador y un solo envío de los 600 diarios del negocio (en la prueba, 24 en una).
- **Dónde.** `clientes.schemas.ts:23-25` y `login.rs:41-44` (la Main revalida igual y la guarda en
  `Clientes.Email`) → `publico.routes.ts:191` → `correos.ts:101-116`, sin el `correoValido` de `:61`.
- **Quién.** Un anónimo con la clave pública del negocio y un token de Turnstile por alta (200 por
  negocio y día); con su buzón en la lista recibe el enlace, y cancelar manda otro y libera la mesa.
  En juego, la reputación y el cupo de la cuenta de correo, que comparten licencias, PIN y pedidos.
- **Cómo se ha comprobado.** `aud39Publico.test.ts` y `aud39Correos.test.ts` (8 en verde): lista o CR
  LF → 200 y `EMAIL.send` recibe la cadena entera; con «ana» en su tope, la lista sale; la Handy acepta
  listas sin tope de largo; en Rust (`tests/aud39_correo.rs`), la Main igual. Cloudflare documenta `to`
  como cadena o array y `E_VALIDATION_ERROR` por formato, pero no qué hace con una lista en una cadena:
  falta que el responsable, con un worker de pruebas y buzones suyos, mande `to` «a@d,b@d», «a@d;b@d»,
  «a@d» CR LF «Bcc:b@d» y «x<a@d>», y anote el `.code` o quién lo recibe.
- **Arreglo.** Una sola dirección en las dos reglas: una `@` exacta y ni espacios Unicode, ni
  controles, ni `,;<>()[]":\` (TS `/[\p{White_Space}\p{Cc},;<>()[\]":\\]/u`; Rust `is_whitespace`,
  `is_control` y la lista), con sus casos tras `validacion_casos.json:170`; y en `correos.ts:101`,
  `if (!isValidEmail(para)) return "fallido";` antes de `reservar`. No `z.email()`: es sólo ASCII.
- **Test de regresión.** Esos casos (`validacionCasos.test.ts`, `validacion_casos.rs`); lista y CR LF:
  400 sin fila en `peticiones` y `fallido` sin `send` ni fila en `email_sends` (`reservasWeb*.test.ts`).

### AUD-42 · Los topes del código de cambio de correo se saltan con peticiones simultáneas

- **Estado.** Confirmado con test.
- **Gravedad.** 🟡 media. Probabilidad baja: hacen falta la clave y el token de una Main con licencia.
  Pero sale del remitente común, y la cuota diaria de Email Service es de la cuenta: si se agota, ese
  día no salen claves, OTP de traslado, códigos del PIN, pedidos ni reservas de ningún negocio.
- **Qué pasa.** `emitirCodigo` decide la espera de 5 min y el tope de 5 por hora sobre una lectura, y
  escribe después, en otra petición a Turso, un upsert sin condición. Toda petición que lee antes de
  esa escritura pasa y manda la plantilla fija a la dirección que trae. El tope cuenta ráfagas: 5 por
  hora, y en cada una cabe lo que llegue en una vuelta a Turso. Recuperar el PIN, igual, al del negocio.
- **Dónde.** `login.routes.ts:241` → `correoRecuperacion.ts:151` → `codigosPorCorreo.ts:94-129` →
  `licenseStore.ts:1126` → `licenseEmails.ts:29`. Ningún limitador cubre `/v1/login`.
- **Quién.** Quien controle una Main con licencia: el titular (clave del equipo y token están en su
  Windows) o un programa malicioso en ella. Desde la interfaz no: el botón se desactiva mientras espera.
- **Cómo se ha comprobado.** `aud42EnviosSimultaneos.test.ts`, esquema real y EMAIL falso: 10 a la vez
  → 10 × 200 y 10 correos a 10 direcciones, `sends_in_window` = 1; 4 seguidas y 10 a la vez → 14
  correos; 5 ráfagas de 10 → 50 en 20 min. Con 400 ms por sentencia pasan las que llegan en una vuelta.
  Falta el tamaño real (latencia a Turso, cuota de la cuenta): lo ve el responsable en Cloudflare.
- **Arreglo.** En `licenseStore.ts:1125-1166`, `putEmailCode` reserva en una sentencia, como
  `reserveEmailCodeAttempt`: contador y ventana con `CASE` en SQL y `DO UPDATE … WHERE (consumed_at_ms
  IS NOT NULL OR ?ahora - created_at_ms >= ?espera) AND (?ahora - window_started_ms >= ?ventana OR
  sends_in_window < ?tope) RETURNING`. Si no vuelve fila, `codigosPorCorreo.ts:120-129` da 429
  `espera_reenvio` y no envía (94-118 queda para la cuenta atrás). Con sólo el tope saldrían cinco.
- **Test de regresión.** Los casos de 10 a la vez del test, en `correoRecuperacion.test.ts` y
  `recuperarPin.test.ts`: hoy fallan; con el arreglo inyectado pasan, y los 25 existentes también.

## H · Publicación y CI

## I · Respuestas de la API

## Lo que sólo puede comprobar el responsable

Lo que no se decide desde el repositorio ni con tests locales. Nada de esto pide tráfico de ataque contra
producción: son paneles, consultas de sólo lectura o pruebas en un entorno propio.

- **Turso** (panel y consultas de sólo lectura en la base central): el plan de la organización y si tiene
  excedentes (AUD-09, AUD-36); cuántas bases hay y cuáles quedaron huérfanas (AUD-09); cuántas filas tiene `pair_requests` y
  cuántos códigos caducan sin reclamar (AUD-10, AUD-12).
- **Cloudflare** (panel): los campos del job de Logpush, su retención y quién lo lee, y el ajuste
  `observability.redact_query_string` (los tres, en `observabilidad.md`); cuántas resoluciones de Turnstile pasan sin casilla (AUD-38); el
  cupo y el ritmo de Email Service (AUD-38, AUD-42); y la duración del `TenantHub` de un negocio
  con la Main real abierta y sin vender (AUD-46).
- **Un worker de pruebas propio con `send_email`** y sólo buzones propios: qué hace Cloudflare con una
  lista o un CR/LF en `to` (AUD-39).
- **Axiom**: que el worker desplegado tenga `AXIOM_TOKEN`, y la retención y el acceso de
  `tpv-device-logs` y `cloudflare-logpush` (`observabilidad.md`), y que lo que ya se ingirió con datos
  de clientes en los errores de la Handy se borre o caduque; si ya ha habido abuso de las altas web (AUD-38).
- **Stripe** (Dashboard y modo test): si el webhook recibe `charge.dispute.*` (AUD-45), y que al escalar
  una consulta llega `charge.dispute.funds_withdrawn` (AUD-45).
- **Equipos y entornos reales**: si WebView2 y la WebView de Android aguantan una imagen de dimensiones enormes, en una máquina virtual y un emulador sin
  red (AUD-31); y qué IP entrega `workers.dev` en IPv6 (AUD-11).

## Riesgos conocidos que esta auditoría matiza

- **LOGIN-04** se aplaza porque «exige primero acceso de lectura a la base del tenant». Pero
  `broadcastChange` reparte a todas las Handy autenticadas el SQL de cada cambio con sus argumentos,
  `Password_Hash` incluido cuando la Main crea un trabajador o cambia un PIN, mientras REST veta
  `/v1/sync/changes` a quien no es la Main.
- **LIC-02** dice que sin *pinning* no hay bypass porque la licencia va firmada. Hoy es cierto sobre todo
  porque `reqwest` 0.12 sólo confía en las raíces integradas (webpki-roots): la aserción no se compara con
  el tenant y el dispositivo locales, y su mensaje canónico une campos con `|` sin escapar (un `deviceId`
  con `|` admite otra lectura de los mismos bytes). Pasar a `reqwest` 0.13, que confía en el almacén del
  sistema, cambiaría esa conclusión.
- **SEC-SESION** se queda corto en AUD-31, que con la credencial de una Handy afecta a la Main.

## Endurecimiento (no son hallazgos)

- **Licencias y dispositivos.** Las guardas REV-07 y REV-13 dejan pasar si la fila no tiene clave
  registrada. El OTP de cambio de equipo
  se guarda como SHA-256 sin clave. `LICENSE_JWT_SECRET` firma los JWT y también es la clave HMAC de los
  códigos por correo. El JWT no exige `exp` ni audiencia. `/ws` no mira la licencia en el *upgrade*.
- **Errores con secretos.** Los minidumps de Sentry se adjuntan sin filtro. `onError` del worker
  vuelca `err.message` y `err.stack` a la consola sin `scrub`. `tenantAuth` devuelve el texto interno de
  la excepción en el 401.
- **Webview.** El ámbito del protocolo asset es `$APPDATA/**` (cubre `data.db`, copias,
  `license_state.json`) cuando basta `$APPDATA/images/**`. Falta una política de navegación
  (`on_navigation`). `core:default` concede `allow-internal-toggle-devtools` (inocuo sin la feature
  `devtools`, pero mejor denegarlo). El .exe de release atiende `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`
  con depuración remota. `TpvAndroid` se inyecta en todos los marcos. `allowBackup=false` no frena la
  transferencia entre dispositivos de Android 12 (falta `dataExtractionRules`). La guía de Android pone
  primero el APK de depuración, que no debería ir a una Handy de producción.
- **PII del personal.** Si la DEK no se puede leer al arrancar (por ejemplo el almacén de Windows lento),
  DNI, IBAN y NSS se escriben en claro, y el job que los cifra después se para en el primer conflicto
  `UNIQUE`. Los cifrados no llevan datos asociados (un valor se puede copiar a otra fila). En Windows la
  clave del dispositivo se guarda con persistencia Enterprise (viaja con perfiles móviles).
- **Réplica.** El DO ejecuta el SQL de la Main sin rechazar `ATTACH`, `DETACH`, `VACUUM INTO` ni `PRAGMA`;
  el aislamiento entre bases descansa en que Turso rechace `ATTACH` con esos tokens (la unidad quedó
  bloqueada por ese dato; conviene confirmarlo y añadir el veto). En la Main, un autorizador de SQLite en
  la conexión de `apply_one` cerraría lo mismo. `TABLAS_SOLO_MAIN` sólo mira los seis primeros caracteres.
  `broadcast` llega también a sockets que aún no han saludado. La revocación de una Handy sólo cierra su
  socket si la RPC al DO responde.
- **Correo y reservas web.** Turnstile sólo mira `success` (no `hostname` ni `action`). El tope por
  destinatario cuenta la cadena literal (los alias `+etiqueta` son destinatarios distintos) y es global
  entre negocios. `email_sends.id` es global y el `ON CONFLICT` no compara tenant. El enlace de una reserva
  sigue enseñando el día y la hora tras cambiar el cliente (riesgo aceptado en el estudio de reservas web
  para cancelar).
- **Retención.** No se purgan `device_challenges`, `pair_requests`, `license_device_otp`, `webhook_events`
  (con datos personales de Stripe) ni las altas web que la Main nunca recoge.
- **CI.** Cualquier tag `v*` dispara la publicación sin comprobar que el commit esté en `main` ni pasar por
  un `environment` con aprobación. `audit.yml` corre con `continue-on-error`. El feed del updater no firma
  versión ni canal, y las dos variantes comparten clave. El wrapper de Gradle no fija su sha256.
- **Operación.** `ipDeLaPeticion` cae a `x-forwarded-for` si falta `CF-Connecting-IP`. La CORS con
  credenciales deja en producción `localhost:1420` y los orígenes genéricos de Tauri. `tpv-license.mjs`
  manda el `ADMIN_API_TOKEN` a cualquier `TPV_API_BASE`, también `http://`, y los E2E usan el de
  producción. El `.gitignore` raíz no cubre `*.pem`, `*.key`, `*.p12`, `*.jks` ni `.env.production`, y
  `docs/analisis/evidencias-pruebas-e2e-tpv/` (569 capturas) está sin versionar ni ignorar.
- **Inventario.** Se pueden editar productos archivados por la API; `update_lote` permite cambiar
  `ID_Producto` de un lote sin movimiento de stock; el coste unitario tampoco exige signo.
- **Interruptores.** El interruptor remoto `imagenes` sólo lo mira el cliente (`drenar_imagenes`): el
  `PUT /v1/images` no lo consulta, y un cliente manipulado lo ignora.
- **Documentación.** `jobs-e-interruptores.md:95` cita `socketMain.ts::subirLoPendiente`, que ya no
  existe: `volcado_atraso` se mira en `apps/tpv-main/src-tauri/src/replicacion.rs:68`. El comentario de
  `lib.rs:972-975` da por hecho que la pantalla de vinculación no tiene candado de ruta, y lo tiene
  (`App.tsx:114`).

## Lo que está bien

- Autenticación del dispositivo: JWT HS256 con algoritmo fijado y firma Ed25519 por petición que cubre
  método, ruta, consulta, token y cuerpo exacto; el rol sale de la fila central, nunca del token.
- Aislamiento entre negocios en las rutas de negocio y en R2: el tenant sale del token, el DO se elige con
  `idFromName(tenantId)` y cada base de Turso tiene su token.
- Administración con comparación en tiempo constante que falla cerrada sin secreto; webhook de Stripe con
  HMAC, ventana de 5 minutos e idempotencia por evento.
- Licencia firmada con claves Ed25519 fijadas en el binario; `reqwest` con raíces integradas.
- Emparejamiento con secreto de 256 bits, reto de un solo uso y lista exacta en el proxy firmado del IPC.
- Webview con CSP `script-src 'self'`, sin `dangerouslySetInnerHTML` ni `eval`, sin devtools en release y
  APK de release no depurable; deny de `fs` vigilado por un test.
- Ningún secreto versionado en los 1415 commits de todas las ramas; `.env`, `.dev.vars` y la clave del
  updater ignorados.
- Clave de firma del updater aislada en su propio job (RI-25) y acciones de GitHub fijadas por SHA.
- Tests que vigilan reglas leyendo el fuente (exenciones del gate, veto antes del cuerpo, freno del PIN):
  varias pistas proponen exactamente un caso más en esos ficheros.

## Cobertura

- **78 unidades** de cobertura (superficie × frontera × subsistema × clase de ataque): 27 revisadas sin
  hallazgo, 47 con candidato, 1 bloqueada (el aislamiento por `ATTACH` entre bases de Turso, que depende
  de la configuración de Turso), 1 diferida (contrastar los lockfiles con avisos publicados exige red) y
  2 fuera de alcance (el workflow de Windows 7, que no está en `main`).
- **Cuatro olas** de búsqueda con 30 agentes, un crítico de cobertura tras cada ola y un crítico final
  distinto; los dos últimos no encontraron huecos, así que la cobertura de esta pasada se da por cerrada.
  Eso no significa que el repositorio esté agotado: la propia skill avisa de que pasadas repetidas
  encuentran más.
- **Validación:** los cazadores devolvieron 59 candidatos (54 huellas distintas: cinco las propusieron dos
  cazadores) y un verificador de la fase 3 separó una causa más (AUD-07). De esas 55 huellas, una quedó
  fuera de alcance (la de Windows 7) y diez se fusionaron con otra de la misma causa raíz: 44 causas. Cada
  una la revisó un verificador que no la había cazado (fase 3) y cada registro final otro distinto (fase 5):
  44 pendientes de validar, ninguno rechazado, ninguno confirmado. La investigación posterior confirmó 42
  (40 con un test) y dejó dos sin resolver. En la fase 5, 17 pasaron tal cual y 27
  se corrigieron (redacción, líneas, evidencias o planes) sin cambiar veredicto ni huella; las tres
  correcciones que tocaban la causa las revisó un verificador más antes de aplicarlas.
- **Fuera de alcance pero relevante:** en las ramas `compilacion-windows-7` y `con-verifactu-windows-7`,
  `release-win7.yml` compila todas las dependencias en un paso con la clave de firma del updater en el
  entorno, y esa clave es la misma que confía Windows 10/11. Merece una pasada sobre esa rama.

## Cómo se hizo

- Skill instalada en `~/.claude/skills/security-audit/`.
- Primera ejecución de la skill sobre este repositorio: no había registros anteriores que reutilizar ni
  revalidar. Sin presupuesto de agentes: 30 cazadores en cuatro olas, 5 críticos de cobertura, 44
  verificadores de candidatos (fase 3) y 47 de registros finales (fase 5: uno por registro y tres más
  para revisar las sustituciones que cambiaban la causa).
- Durante la auditoría, revisión sólo de fuente: ningún agente ejecutó código del repositorio, usó la red
  ni escribió fuera de su carpeta de trabajo.
- **La investigación** (8 de noviembre): 45 agentes, uno por pista, en ocho worktrees de `main` en
  `38a4c2db` fuera del árbol de trabajo (`C:\Users\diego\audw\`), sin `.dev.vars` ni `.env` y con su
  propio directorio de compilación. Cada uno escribió y ejecutó tests temporales (vitest del worker en
  workerd con los bindings locales, vitest del frontend, nextest de las crates sin Tauri), consultó la
  documentación oficial (Cloudflare, Turso, Stripe, GitHub, pnpm, Microsoft, Android) y dejó su resultado,
  su sección y sus tests en `run-1\investigacion\AUD-NN\`. No se compilaron la crate de Tauri ni
  `tpv-infra-licensing` (tocan el almacén de claves del sistema) ni se lanzaron los E2E. Dos pruebas se
  salieron de lo habitual: AUD-25 abrió unos segundos una ventana de WebView2 en este equipo para ver la
  navegación, y AUD-30 decodificó el logo de 3,2 GiB dentro de un tope de memoria del sistema.
- Los validadores de la skill (`validate-findings.cjs`, `validate-coverage-ledger.cjs`) no leen en Windows
  (Node no ofrece `O_NOFOLLOW`); se llamaron a sus funciones de validación con una lectura propia que
  comprueba que la entrada sea un fichero regular y no un enlace. `findings.json` y el registro de
  cobertura pasan los dos.
- Artefactos: `C:\Users\diego\security-audit-skill\tpv-completa\run-1\` (`run-metadata.json`,
  `architecture.md`, `coverage-ledger.json`, `findings.json`, `NEEDS-VALIDATION.md`, `REPORT.md`) y, de la
  investigación, `investigacion\` (un directorio por pista).
