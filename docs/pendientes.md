# Pendientes

Lo que está abierto y no depende de que alguien se acuerde. Cada punto dice qué falta, por qué
importa y qué se ha decidido. **Lo que se resuelve se borra de aquí**: la traza del arreglo queda en
el código (un comentario con su ID, `git grep -n "FABLE-B"`) y en el commit.

Severidad: 🔴 bloqueante · 🟠 alta · 🟡 media · 🔵 baja

| ID | Sev | Qué | Estado |
|---|---|---|---|
| [VF-VUELTA](#vf-vuelta--volver-a-poner-verifactu) | 🔴 | Volver a poner Veri\*factu antes de que sea obligatorio | Aplazado; vive en `con-verifactu` |
| [LEGAL-01](#legal-01--rgpd) | 🟠 | Papeleo RGPD de encargado del tratamiento | Sin empezar |
| [LEGAL-02](#legal-02--reglamento-de-ciberresiliencia) | 🟠 | Reglamento de Ciberresiliencia | Sin empezar |
| [ARCH-01](#arch-01--doble-implementación-mainworker) | 🟠 | Doble implementación Main/worker | Refactor gradual tras el lanzamiento |
| [DB-14](#db-14--retención-y-archivado) | 🟡 | Sin retención ni archivado de datos de negocio | Decidido: archivo en R2, falta medir |
| [CENTRAL-RETENCION](#central-retencion--nada-purga-webhook_events-ni-admin_audit) | 🟡 | Nada purga `webhook_events` ni `admin_audit` de la base central | Sin decidir |
| [COPIAS-RETENCION](#copias-retencion--las-copias-de-un-negocio-que-ya-no-copia-no-se-borran-nunca) | 🟡 | Las copias de un negocio retirado o cuyo objeto se ha perdido no se borran nunca | Lo decide el responsable |
| [INFRA-01](#infra-01--entorno-de-staging) | 🟡 | No hay entorno de staging | Aplazado |
| [INFRA-02](#infra-02--instalador-sin-firmar) | 🟡 | El instalador no va firmado (Authenticode) | Aceptado a sabiendas |
| [SUBIDA-TECHO](#subida-techo--el-techo-total-de-la-subida-completa) | 🔵 | El techo de 60 millones de filas de la subida completa, sin medir con bares reales | Medir en producción |
| [VUELTA-DESHACER](#vuelta-deshacer--deshacer-la-vuelta-de-un-negocio-lo-dejaría-cerrado) | 🟡 | Deshacer la vuelta a un instante de un negocio lo dejaría cerrado | Sin comprobar: en local no existe |
| [CENTRAL-RESTAURAR](#central-restaurar--la-central-se-restaura-en-una-sola-llamada) | 🔵 | La central se restaura en una sola llamada, de 30 s como mucho | Avisa el cron; sin hacer |
| [CENTRAL-AUTH](#central-auth--tenantauth-lee-la-central-en-tres-viajes) | 🔵 | `tenantAuth` lee la base central en tres viajes, que podrían ser uno | Sin decidir; hacia los 1.000 negocios |
| [SOCKET-DISPERSION](#socket-dispersion--el-reintento-del-socket-casi-sin-dispersión) | 🔵 | Tras una caída o un despliegue, todos los equipos reconectan a la vez | Sin decidir; hacia los 1.000 negocios |
| [CLAVES-SIN-CORREO](#claves-sin-correo--las-claves-de-un-cobro-que-no-llegaron-a-salir) | 🔵 | Un comprador puede quedarse sin el correo de sus claves, que se reenvía a mano tras el aviso en Sentry | Lo decide el responsable |
| [TRASLADO-REINTENTO](#traslado-reintento--un-traslado-de-licencia-que-falla-a-medias) | 🔵 | Un traslado de licencia que falla a medias pide otro código, o se queda sin sus avisos | Sin decidir |
| [CORREO-CONFIRMAR](#correo-confirmar--el-código-del-correo-de-recuperación-se-gasta-sin-cambiarlo) | 🔵 | El código del correo de recuperación se puede gastar sin cambiarlo, y «Acabamos de enviarte un código» sin que haya salido | Sin decidir |
| [EMPAREJAR-TOKEN](#emparejar-token--recoger-el-token-de-una-handy-son-tres-escrituras-sueltas) | 🔵 | Recoger el token de una Handy son tres escrituras sueltas | Sin decidir |
| [EMPAREJAR-ESPERA](#emparejar-espera--la-handy-deja-de-esperar-la-aprobación-al-primer-503-o-429) | 🔵 | La Handy deja de esperar la aprobación de la Main al primer 503 o 429 | Sin hacer |
| [CUPO-SATURADA](#cupo-saturada--el-cupo-diario-de-correo-no-se-aplica-con-la-central-saturada) | 🔵 | Con la central saturada, el cupo diario de correo de pedidos no se aplica | Lo decide el responsable |
| [RESERVA-CORREOS](#reserva-correos--los-correos-de-una-reserva-web-que-se-pierden-con-la-central-saturada) | 🔵 | Con la central saturada, la confirmación de una reserva web (con su enlace de cancelar) y el «has cancelado» no salen, y nadie los repite | Sin hacer |
| [AVISO-CADUCIDAD](#aviso-caducidad--un-aviso-de-caducidad-que-no-sale-nunca) | 🔵 | Un fallo de la central alrededor de la marca de un aviso de caducidad deja ese aviso sin salir | Sin hacer |
| [SEC-SESION](#sec-sesion--sesión-personal-verificable-en-el-worker-y-la-autoría-ri-28-aud) | 🟡 | El Worker autentica al dispositivo, sin sesión personal verificable; con RI-28-AUD (autoría de apertura/líneas y tareas ajenas) | Aplazado; se hacen juntos más adelante |
| [FABLE-E](#fable-e--sin-nonce-en-el-device-proof) | 🔵 | Sin nonce anti-repetición en el device-proof | Aplazado |
| [LOGIN-04](#login-04--el-hash-del-pin-se-puede-romper-offline) | 🔵 | El hash del PIN se puede romper offline | Aplazado |
| [LIC-02](#lic-02--sin-certificate-pinning) | 🔵 | Sin *certificate pinning* del host de la API | Aplazado |

---

## Veri\*factu

### VF-VUELTA · Volver a poner Veri\*factu

Esta rama no remite a la AEAT. Veri\*factu entero —remisión, certificado, QR en el papel, avisos,
anomalías, exportación, declaración responsable y modo prueba— está en `con-verifactu` (Windows 10
y 11) y `con-verifactu-windows-7`, tal como estaba el 25-10-2026. La retirada es un solo commit de
`main` (`git log --oneline --grep "sin Veri"`): volver a ponerlo empieza por revertirlo sobre la
rama de trabajo y resolver lo que haya cambiado desde entonces. Lo que se ha escrito después para
esta rama no lo devuelve la reversión: [tickets.md](arquitectura/tickets.md) y los comentarios del
papel (`impresion.rs`, `printing.rs`, `printerApis.ts`, `PrintTicketModal.tsx`) describen un ticket
sin el QR, y hay que volver a ponerlo en ellos.

Con él vuelve lo que estaba pendiente allí:

- **La identidad del productor**: `PRODUCTOR_NIF` está vacío y sin él no se remite. Falta saber si
  el productor será un autónomo o una sociedad, y confirmar `PRODUCTOR_NOMBRE_RAZON`,
  `PRODUCTOR_NOMBRE_SISTEMA` y `PRODUCTOR_ID_SISTEMA`.
- **El texto de la declaración responsable** (art. 13 RRSIF), que es un borrador.
- **Quitar el modo prueba**, que vuelve con la reversión.
- **Qué se hace con lo emitido en esta rama.** Esos registros tienen su huella y su QR, pero no fila
  en `_Verifactu_Envios`: tras revertir, `resembrar_cola_de_envio` los encolaría todos para remitir.
  Hay que decidir entonces si se remiten.
- **`Registros_Facturacion.Sin_Registro_Previo`**: `verifactu.rs` la lee y la lleva al XML, pero
  ningún camino la rellena. Decidir cuándo vale `S` (la anulación de un registro que nunca llegó a
  la AEAT) o quitarla.

La fecha la anunció Hacienda el 5 de octubre de 2026
([nota informativa](https://www.hacienda.gob.es/sgt/gabsehacienda/nota-informativa-verifactu.pdf)):
aplazar Veri\*factu hasta octubre de 2028 para que coincida con la factura electrónica obligatoria
de quien factura hasta 8 millones al año. **Todavía no está en el BOE.** Hasta que salga, lo vigente
es el Real Decreto-ley 15/2025: 1 de enero de 2027 para los contribuyentes del Impuesto sobre
Sociedades y 1 de julio de 2027 para el resto
([AEAT](https://sede.agenciatributaria.gob.es/Sede/iva/sistemas-informaticos-facturacion-verifactu/nota-informativa-ampliacion-plazo-adaptacion-facturacion.html)).
Si al acercarse el 1 de enero de 2027 no se ha publicado, la fecha que vale es esa.

---

## Legal

### LEGAL-01 · RGPD

El TPV guarda datos de clientes (nombre, teléfono, email, notas) y PII del personal, y los replica a
la nube: somos **encargado del tratamiento**. Falta el contrato de encargado, la política de
privacidad, el ejercicio de derechos (exportar y borrar un cliente) y la política de retención.

La reserva web ([plan](estudios/reservas-web.md)) recoge esos datos directamente del público: su
formulario necesita el texto informativo, con el negocio como responsable, antes del piloto.

El cifrado de la PII del personal no la pone fuera de nuestro alcance: el texto cifrado está en la
base del negocio en la nube y la DEK en el control-plane
([arquitectura/licencias.md](arquitectura/licencias.md)). Hay que declararlo así.

Marco de la política de retención (fuentes oficiales):

- Limitación del plazo de conservación: RGPD art. 5.1.e
  ([AEPD](https://www.aepd.es/derechos-y-deberes/cumple-tus-deberes/principios)).
- Derecho de supresión: RGPD art. 17; no procede si conservar es una obligación legal
  ([AEPD](https://www.aepd.es/derechos-y-deberes/conoce-tus-derechos/derecho-de-supresion-al-olvido)).
- Suprimir empieza por bloquear: LOPDGDD art. 32
  ([BOE-A-2018-16673](https://www.boe.es/buscar/act.php?id=BOE-A-2018-16673)).
- Plazos que obligan a conservar: documentación del negocio, **6 años** (Código de Comercio art. 30,
  [BOE-A-1885-6627](https://www.boe.es/buscar/act.php?id=BOE-A-1885-6627)); registros de jornada,
  **4 años** (Estatuto de los Trabajadores art. 34.9,
  [RDL 8/2019](https://www.boe.es/buscar/doc.php?id=BOE-A-2019-3481)); registros de facturación, no
  se purgan (DB-14).

### LEGAL-02 · Reglamento de Ciberresiliencia

El TPV es un *producto con elementos digitales* del Reglamento (UE) 2024/2847
([BOE](https://www.boe.es/buscar/doc.php?id=DOUE-L-2024-81720),
[Comisión](https://digital-strategy.ec.europa.eu/en/policies/cra-summary)).

- **Desde el 11 de septiembre de 2026:** notificar las vulnerabilidades explotadas activamente y los
  incidentes graves al CSIRT del país del establecimiento principal (y a ENISA) por la plataforma
  única: alerta temprana en 24 h, notificación en 72 h, informe final a los 14 días de la corrección
  o al mes de la notificación
  ([Comisión](https://digital-strategy.ec.europa.eu/en/policies/cra-reporting)).
- **Desde el 11 de diciembre de 2027:** el reglamento entero, incluida la información para el usuario
  del Anexo II.

Falta: saber a qué CSIRT le toca y cómo se notifica en 24 h, y leer el Anexo II en el texto oficial
antes de redactar esa información.

---

## Seguridad

### SEC-SESION · Sesión personal verificable en el Worker, y la autoría (RI-28-AUD)

Aplazado explícitamente; se hace junto con RI-28-AUD, más adelante. Los permisos personales y las
atribuciones se comprueban en Rust, tanto Main como Handy. El Worker sigue autenticando el
dispositivo con JWT + device-proof: los IDs de usuario que recibe desde un adaptador son
atribuciones del cliente, **no prueba de una sesión personal**. No dar por resuelta la autorización
por trabajador del servidor.

Al retomarlo: emitir la sesión tras verificar el PIN con LOGIN-01; ligarla a tenant, dispositivo y
usuario; mantener la credencial en Rust; comprobar usuario activo, permisos y propiedad del recurso
en middleware/casos de uso; establecer caducidad y revocación al cerrar sesión o modificar permisos.
No confiar en el rol ni en el autor enviados en el cuerpo. Adaptar login, puertos/HTTP, Worker,
contratos y pruebas de suplantación y revocación. La Main debe conservar su funcionamiento offline,
y la sincronización de fondo y los flujos de arranque/recuperación no dependen de una sesión personal.

**RI-28-AUD · La autoría y la administración de tareas.** Aplazado por decisión de producto. **No
incluye las correcciones originales de RI-28**: las atribuciones existentes y los movimientos
manuales de stock deben obtener su autor de la sesión Rust; un trabajador solo puede finalizar su
propia asignación. Pendiente:

- Registrar por separado el usuario que abrió una comanda y el que creó cada línea. El responsable
  de la comanda puede cambiar; su autor original debe permanecer inmutable. Esto requiere columnas,
  dominio/puertos, contratos, SQLite, HTTP, Worker y pruebas de replicación. No implica un historial
  completo de ediciones y borrados.
- Permitir al administrador finalizar una asignación de otro trabajador, registrando el actor real
  separado del destinatario. El administrador ya ve el listado global y las asignaciones; falta la
  acción en esa vista. Cada finalización afecta a una asignación, no a todos los destinatarios.
- Los trabajadores no pueden delegar ni actuar en nombre de otro. Comprobar autorización sobre el
  recurso y conservar quién realizó la acción también al replicar, reintentar y recuperar una copia.

### FABLE-E · Sin nonce en el device-proof

La firma del dispositivo cubre método, ruta, token y cuerpo, pero no lleva nonce: dentro de la
ventana de ±2 minutos (`MAX_SKEW_MS` en `server/middleware/auth.ts`) una petición firmada se podría
reproducir tal cual. Aplazado: hay que haber capturado el tráfico (va por TLS) y las escrituras son
idempotentes por `Op_Id`. Cuando se retome hace falta un almacén de nonces compartido entre isolates
(KV es eventualmente consistente; un Durable Object o una tabla con TTL sí sirven) y un despliegue en
tres pasos: worker tolerante, clientes nuevos, worker estricto.

La firma de `/v1/license/activate` es ese mismo device-proof y comparte la ventana. Una activación
ya aceptada que se repite tal cual dentro de ella **vuelve a ejecutarse**, no sólo a contestar
(`test/activarConFirma.test.ts`):

- La primera activación, o la del mismo equipo: vuelve a dar de alta el dispositivo (le quita una
  revocación posterior), repone los datos del negocio que llevaba la petición (el nombre), pasa otra
  vez por el aprovisionamiento de su base y entrega de nuevo la DEK y un token. No abre otro negocio
  ni mueve la caducidad.
- El cambio de equipo: el código ya está consumido y la licencia ya es de ese equipo, así que entra
  como el caso anterior, sin anotar otro traslado.
- El canje: no se repite. La clave ya está canjeada y contesta `license_already_used`, sin DEK ni
  token, con `soloSumar` o sin él y aunque la licencia que recibió el tiempo se haya anulado o
  trasladado después: una clave canjeada no vuelve a sumar ni estrena un negocio (AUD-07).

Lo que queda, entonces, es de la primera activación y del cambio de equipo: quien haya capturado
una de esas peticiones entera puede, durante dos minutos, deshacer la baja de ese equipo, reponer
el nombre del negocio y recibir otra vez su DEK y un token.

### LOGIN-04 · El hash del PIN se puede romper offline

PBKDF2-HMAC-SHA256, 100.000 iteraciones, sal de 16 bytes por usuario (`tpv-domain/src/login.rs`,
`PBKDF2_ITERS`). `Usuarios.Password_Hash` se replica a la nube porque el worker verifica el PIN de la
Handy. Con un PIN de 4 cifras (10⁴ candidatos), probarlos todos contra un hash cuesta décimas de
segundo en una GPU de consumo.

- 100.000 es el techo de `crypto.subtle` en Cloudflare Workers, no del plan: subirlo no se puede, y a
  600.000 tampoco cambiaría nada con ese espacio de claves.
- Lo que movería la aguja, por coste: **PIN más largo** para administradores (el dominio exige
  `len >= 4`); un **pepper** fuera de la base (secreto del worker más almacén de secretos de la Main;
  perderlo deja a todos fuera); un KDF más fuerte, que aporta menos que los dos anteriores.
- Dejar de replicar `Password_Hash` está descartado: la Handy lo necesita.
- El ataque online ya lo corta el bloqueo escalado (LOGIN-01), y el rehash al iniciar sesión
  (`tpv-infra-sqlite/src/login.rs`) migraría los hashes solos si cambia el esquema.

Aplazado: exige primero acceso de lectura a la base del tenant.

### LIC-02 · Sin certificate pinning

`http_client()` (`tpv-infra-licensing/src/lib.rs`) no fija el certificado del host. No habilita ningún
bypass: el estado de licencia va firmado con ed25519 y la clave pública está fijada en el binario
(`LICENSE_SIGNING_PUBLIC_KEYS_B64`), y el emparejamiento firma con la clave del dispositivo. Queda como
extra opcional, a revisar al fijar el modelo de precios.

---

## Infraestructura y operación

### INFRA-01 · Entorno de staging

Hay un worker (`tpv-api`), una base de control y un juego de secretos, y los binarios apuntan a ellos
por constante. No hay dónde probar un cambio del worker, del esquema de la nube o de licencias antes
de que lo vea un cliente. Aplazado a cuando el SaaS esté asentado: es duplicar la infraestructura.
Por orden de dependencia:

1. Un `env.staging` en `wrangler.json` con su `name` y sus `vars` (`ENVIRONMENT: "staging"`,
   `EMAIL_*`). Sus Durable Objects (`TenantHub`, `AgendaWeb` y `BaseCentral`) serían otros espacios
   de nombres.
2. Todos los secretos repetidos con `--env staging`.
3. **Su propia base central**: en otro worker, `BaseCentral` es otro objeto, que nace sin aprovisionar
   y se aprovisiona con `pnpm central:aprovisionar -- --si` apuntando `TPV_API_BASE` a staging.
   Compartir la de producción sería escribir sobre datos de clientes. Las bases de los negocios van
   con su `TenantHub`, que ya es otro.
4. Otros buckets de R2: el de las imágenes y los de las copias. La URL de las imágenes de la Handy sale de `CLOUD_API_BASE` (`handy_url_imagenes`, punto 6), y el `img-src` de la CSP la repite.
5. Stripe en modo test, con su webhook y sus Prices.
6. Cliente compilable contra staging: `CLOUD_API_BASE` (`tpv-infra-licensing/src/lib.rs`) y
   `LICENSE_SIGNING_PUBLIC_KEYS_B64` están fijados en el código; hay que hacerlos configurables al
   compilar (como `TPV_SENTRY_DSN`). El WebSocket nativo deriva su URL de `CLOUD_API_BASE`.
7. Etiqueta de entorno: `tpv_telemetry::Environment` sólo tiene `Dev` y `Prod`, y el entorno de Sentry
   lo decide `lib.rs::entorno_de_sentry` (`e2e` / `dev` / `prod`).
8. Correo contenido: staging no puede mandar pedidos a proveedores reales.
9. Un workflow que despliegue staging.

El canal de actualizaciones ya existe: el TPV de staging se marca como bar piloto y recibe las versiones
de `beta` antes que nadie ([publicar-version.md](guias/publicar-version.md#bares-piloto-y-promoción-ri-30)).

Los puntos 1–4 ya bastan para probar el backend con `curl` o el CLI de licencias; el 6 es lo que hace
falta para probar la aplicación.

### INFRA-02 · Instalador sin firmar

`tauri.conf.json` empaqueta NSIS sin Authenticode. La firma ed25519 del updater protege las
actualizaciones, no la primera instalación. **Aceptado** mientras no haya ingresos: SmartScreen avisa
pero deja instalar («Más información → Ejecutar de todas formas»). Azure Trusted Signing evita el token
hardware de un certificado EV.

### SUBIDA-TECHO · El techo total de la subida completa

La subida completa de la Main a una nube devuelta (DO-SUBIDA,
[worker.md](arquitectura/worker.md)) tiene un techo total de filas escritas, índices y triggers
incluidos: el menor entre 60 millones y diez veces lo que la Main declaró en su plan
(`LIMITES_DE_SUBIDA.filasTotales` en `tenantHub.subida.ts`). Al pasarlo, la petición queda `agotada`
y la reabre la administración con `pnpm negocio:subida -- --reabrir`, que sigue por donde iba
([restaurar-un-negocio.md](guias/restaurar-un-negocio.md)).

El 60 es una estimación: un bar de mil comandas diarias escribe unos 70-80 millones de filas en dos
años, así que uno con mucho movimiento, años de histórico y una base vacía llegaría al techo. Subirlo
es también subir lo que puede escribir un cliente que abuse. Falta medir cuánto escribe un bar real
al año (las filas de su base y las escritas por la subida) y ajustarlo con ese dato.

### VUELTA-DESHACER · Deshacer la vuelta de un negocio lo dejaría cerrado

Al volver a un instante (DO-03, `tenantHub.instante.ts`), el `TenantHub` deja su marca de vuelta en
curso hasta reiniciarse. Según la documentación de Cloudflare, el marcador de deshacer que devuelve
`onNextSessionRestoreBookmark` es el estado del objeto «justo antes de la recuperación», así que lleva
la marca dentro (`durableObjects/instantes.ts`). Al deshacer, el objeto arrancaría con la marca:
`trasVolver` contestaría `vuelta_sin_aplicar`, y `getTenantDb`, `tenant_db_restaurando`, para siempre.
La base central lo resuelve quitando al arrancar la marca que quede (`baseCentral.ts`, `ponerAlDia`);
en el negocio no vale tal cual, porque `trasVolver` usa la marca para saber que tiene que abrir el log
por encima.

En local no se puede comprobar (no hay vuelta a un instante). Toca en el simulacro de vuelta en
producción: volver, deshacer y ver si el negocio atiende.

### CENTRAL-RESTAURAR · La central se restaura en una sola llamada

Restaurar la central desde una copia (`baseCentral.restaurar.ts`) va entero dentro de un
`blockConcurrencyWhile`, que reinicia el objeto pasados 30 s; la marca de restauración lo deja
entonces sin atender, y cada intento volvería a cortarse. Medido en local, 150.000 filas de las más
caras tardan como mucho la mitad, y el cron avisa a Sentry cuando la copia del día pasa de ahí
(`FILAS_QUE_SE_RESTAURAN_DE_UNA_VEZ`). Antes de llegar hay que partir la carga en varias llamadas,
cada una en su `blockConcurrencyWhile`, con la marca puesta entre ellas. Qué hacer mientras tanto:
[restaurar-la-central.md](guias/restaurar-la-central.md#si-no-cabe-en-30-s-central-restaurar).

### CENTRAL-AUTH · `tenantAuth` lee la central en tres viajes

`tenantAuth` (`middleware/tenant.ts`) lee de la base central el dispositivo con su clave pública
(`server/middleware/auth.ts`) y el veto de la licencia (`lib/licenciaEnUso.ts`: la licencia y el rol
del equipo). Cada cosa tiene su caché de un minuto por isolate, pero con las dos frías son tres viajes
seguidos al objeto `BaseCentral` en la misma petición, y la central atiende de una en una lo de todos
los negocios ([worker.md](arquitectura/worker.md#un-solo-hilo)). Las lecturas no dependen unas de
otras, así que podrían ir en un solo viaje. Hoy no aprieta: el estudio que llevó a
[0009](decisiones/0009-la-base-central-en-su-durable-object.md) lo situaba hacia los 1.000
negocios. Antes de decidir, medirlo con el generador de carga
([pruebas-de-carga.md](guias/pruebas-de-carga.md)).

### SOCKET-DISPERSION · El reintento del socket, casi sin dispersión

Cuando se corta el socket, la Main (`src-tauri/src/replicacion.rs`) y la Handy
(`src-tauri/src/socket_handy.rs`) vuelven a intentarlo a los 3 s, doblando la espera hasta 30 s, con
menos de un segundo al azar. Un despliegue reinicia los objetos y corta los sockets de todos a la vez,
y una caída de la nube también: al volver, todos los equipos de todos los negocios reconectan casi al
mismo tiempo, y cada reconexión pide su ticket y lo canjea en la base central (dos lotes y varias
lecturas), justo cuando la central arranca. Con muchos negocios eso pasa de lo que atiende un solo
objeto, y se vería como 503 `hub_overloaded` y más reintentos. Opciones, sin decidir: más dispersión en el primer reintento,
respetar el `Retry-After` del 503, o sacar el ticket del socket de la central (firmado, o en el
`TenantHub`). Es un cambio en Rust, y como CENTRAL-AUTH no aprieta hasta los 1.000 negocios o así.

### CLAVES-SIN-CORREO · Las claves de un cobro que no llegaron a salir

El correo con las claves de una compra sale después de la operación de la central
(`emitirCobro`), y sólo si la emisión es de esa entrega del webhook
([worker.md](arquitectura/worker.md#las-operaciones)). Si la primera llamada entra pero su respuesta se
pierde, el reintento también falla y Stripe vuelve a entregar el evento, la entrega nueva encuentra la
sesión ya cumplida con otras licencias y no manda nada: el comprador no recibe sus claves. Lo mismo si
el worker se corta entre la operación y el correo. Las licencias se quedan con `key_email_sent_at_ms`
a `NULL`, que es lo que `pnpm license:list` enseña como pendiente y `pnpm license:resend` reenvía
([licencias.md](arquitectura/licencias.md#comprar)).

Lo que ya está en el código (E7b definitivo-2): la entrega que encuentra la sesión cumplida con
licencias sin `key_email_sent_at_ms`, cobradas hace más de cinco minutos (`CORREO_DE_CLAVES_MAX_MS`:
una más reciente puede ser de otra entrega que está mandando el correo), lo avisa en Sentry
(`stripe.correo_de_claves`, `stripe.routes.ts::avisarSiFaltaElCorreoDeClaves`), con las licencias y
la orden que las reenvía. No las reenvía: dos entregas a la vez mandarían dos correos. Lo decide el
responsable (G7): que se reenvíen solas, o dejarlo a mano tras el aviso, como ahora.

### TRASLADO-REINTENTO · Un traslado de licencia que falla a medias

Activar en otro equipo con su código (`/v1/license/activate`, `licensing.routes.ts`) gasta el código
del correo (`consumeDeviceOtp`) antes de dar de alta el equipo y de mover la licencia
(`reassignMainDevice`, `licenseStore.ts`). Lo que ya está en el código (E7a-1): la licencia y su traza
(`license_device_swaps`) se mueven en un solo lote, y si ese viaje no vuelve, la traza dice si ha
entrado, y entonces la ruta sigue con los avisos (`test/licenciaTraslado.test.ts`). Lo que queda:

- Un fallo después de gastar el código (la central, el alta del equipo) obliga a pedir otro.
- Si el 200 se pierde camino del equipo, o el lote entra y la central no contesta a la lectura de su
  traza (`licenciaTraslado.test.ts`, «si tampoco se puede mirar la traza…»), el reintento de ese
  equipo ya no es un traslado: la licencia ya está en él, y contesta `cambioDeEquipo: false`. No salen
  los avisos (al titular y al `TenantHub`), y la Main no sabe que su base es de antes del traslado,
  que es lo que decide `cambioDeEquipo`.

Arreglo posible: que gastar el código y mover la licencia sean una sola operación de la central, o
reconocer el reintento: con el código de este equipo ya gastado y una traza reciente hacia él,
contestar `cambioDeEquipo: true` y avisar otra vez.

### CORREO-CONFIRMAR · El código del correo de recuperación se gasta sin cambiarlo

- `/v1/login/correo-recuperacion/confirmar` (`correoRecuperacion.ts::confirmarCambioCorreo`) gasta el
  código (`comprobarCodigo`, que acaba en `consumeEmailCode`) y, después, hace tres viajes sueltos a
  la central: lee el correo de antes para avisarle (`correoDeRecuperacion`), cambia el correo
  (`setTenantRecoveryEmail`) y lo vuelve a leer para contestar (`estado`). Si falla la lectura de antes o el
  cambio, el código está gastado y el correo sigue siendo el de antes: hay que pedir otro. Si falla la
  relectura, el correo ya ha cambiado pero la respuesta es un 503 (`onError`), y el reintento contesta
  «Este código no es válido» (`invalid_code`: un código gastado no vuelve a valer,
  `codigosPorCorreo.ts::comprobarCodigo`).
- Al pedirlo (`/solicitar`), si la reserva del envío entra en la central pero su respuesta no vuelve,
  la petición falla sin mandar el correo, y la siguiente choca con la espera entre códigos que ha puesto
  esa reserva (`REENVIO_MIN_MS`, cinco minutos): «Acabamos de enviarte un código» (`codigosPorCorreo.ts::porQueNoSeEnvia`) sin que haya
  salido ninguno.

Lo que ya está en el código (E7a-2): recuperar el PIN lee a quién avisar antes de gastar el código
(`recuperarPin.ts::verificarCodigoPin`). Arreglo posible: leer aquí también el correo de antes antes
de gastar el código, gastarlo y cambiar el correo en un solo lote, que la respuesta salga de lo que
ya se sabe (el correo nuevo) y no de una relectura, y que la espera sólo cuente desde un envío que ha
salido.

### EMPAREJAR-TOKEN · Recoger el token de una Handy son tres escrituras sueltas

`/v1/pair/fetch-token` (`pairing.handy.ts`) gasta el reto (`device_challenges`), gasta el código
(`pair_requests`) y da de alta la Handy (`devices`) en tres sentencias seguidas, no en un lote. Si
falla el alta, el reto y el código ya están gastados y hay que emparejar otra vez; si se pierde la
respuesta, queda un dispositivo dado de alta que no tiene su token. Arreglo posible: las tres en un
lote todo o nada, con la condición de cada una dentro de su sentencia, como ya van.

### EMPAREJAR-ESPERA · La Handy deja de esperar la aprobación al primer 503 o 429

Mientras espera a que la Main la apruebe, la Handy pregunta por su token cada 1,5 s
(`emparejamiento.ts::emparejarHandy`, `/v1/pair/fetch-token`), y sólo sigue esperando con
`not_approved`. Cualquier otro fallo termina la espera, también lo que no es definitivo: un 503 de la
central o del worker que no atienden, o un 429 del filtro por IP (`LIMITADOR_SESION`). La pantalla
enseña el error y vuelve a la vinculación (`useEmparejamientoHandy.ts::iniciar`), y quien empareja
tiene que volver a vincular a mano (el mismo código vale mientras no caduque). Arreglo posible: seguir
esperando ante lo que no es terminal, hasta el límite de siempre, y que `pair_rejected` y
`pair_code_expired`, que hoy llegan como `External`, tengan su código propio, para terminar sólo con
ellos.

### CUPO-SATURADA · El cupo diario de correo no se aplica con la central saturada

El correo de un pedido sale aunque la central no conteste (`email.routes.ts::reservarCupo`,
`sin_base`): una caída nuestra no impide mandar un pedido. Pero una central saturada
(`hub_overloaded`) también es `sin_base`, y la puede saturar quien tenga un dispositivo dado de alta:
mientras dure, sus pedidos salen sin contar en el cupo. Lo fija `test/correoTopeDiario.test.ts` («con
la central saturada, también…»). Lo decide el responsable: contestar 503 con la central saturada
(el pedido se repite después), o dejarlo así.

### RESERVA-CORREOS · Los correos de una reserva web que se pierden con la central saturada

El correo de confirmación de una reserva web (con el enlace de cancelar) y el de «has cancelado»
salen de la petición del visitante (`publico.routes.ts`, `POST /reservas` y `POST /cancelar`), y
antes reservan su sitio en `email_sends`, en la base central (`correos.ts::reservar`). Si la central
no atiende (saturada, o sin contestar), el correo no sale (`fallido`: sin la base no se sabe si ya
salió) y nadie lo repite: la reserva queda hecha, o cancelada, sin que el cliente reciba el correo ni,
en el alta, el enlace para cancelarla, que sólo viaja en él. El alta lo dice en su respuesta
(`correo_enviado: false`). Arreglo posible: apuntar el correo pendiente en la `AgendaWeb`, para que lo
reintente su alarma como ya hace con el de «no se pudo registrar», y guardar para ello el enlace, o
el token cifrado.

### AVISO-CADUCIDAD · Un aviso de caducidad que no sale nunca

El cron de avisos de caducidad (`avisosDeCaducidad.ts`) pone una marca por licencia y peldaño
(`marcarAvisoEnviado`) antes de mandar el correo, y la suelta si no sale (`olvidarAvisoEnviado`). Lo
que ya está en el código (E7a-7): una licencia que falla no corta a las demás, salvo la central
saturada, que corta el ciclo (las que faltan, fallidas, se avisan al día siguiente). Lo que queda: si la
central falla al soltar la marca, o después de ponerla (la marca entra y su respuesta no vuelve), la
marca se queda, y el ciclo de otro día no la gana (`INSERT OR IGNORE`) y cuenta esa licencia como ya
avisada: ese peldaño no sale nunca. Eso se lee en el código
(`avisosDeCaducidad.ts::avisarDeCaducidades`) y no lo prueba ningún test: el de «al soltar la marca de
un aviso que no ha salido…» (`test/avisoDeCaducidad.test.ts`) sólo fija que ese fallo no corta a las
demás, sin correr otro ciclo, y el de la marca que entra sin respuesta no existe. Arreglo posible: una
marca «enviando» con caducidad, que el ciclo de otro día pueda retomar.

---

## Datos

### DB-14 · Retención y archivado

Nada purga `Comandas`, `Detalle_Comanda`, `Pagos`, `Movimientos_Stock` ni `Notificaciones` (las
notificaciones se borran de una en una). `purga_sync` limpia el andamiaje de replicación. Las siete
copias diarias son completas y engordan con todo. Lo de la base central, en
[CENTRAL-RETENCION](#central-retencion--nada-purga-webhook_events-ni-admin_audit).

Reglas fijadas:

- `Registros_Facturacion` y `Serie_Facturacion` **no se purgan nunca** (art. 7 RRSIF; borrar una serie
  devolvería su contador a 1).
- Una comanda no se archiva sin comprobar que ningún registro de facturación la necesita para
  reimprimir el papel (`Registros_Facturacion.ID_Pago` es `ON DELETE SET NULL`). El importe y el
  desglose ya viven dentro del registro.

Decidido, a falta de medir cuánto genera un bar al año:

- Lo que no vale nada se purga sin archivar: notificaciones cerradas y estado de cocina antiguo.
- Lo antiguo que hay que conservar va a R2, en un bucket **privado** propio: un SQLite comprimido por
  negocio y ejercicio, legible sin nuestro código. En la base quedan los resúmenes de estadísticas.
- KV no sirve (valores pequeños, no consultable) y D1 no aporta (es otra base SQL con su propio tope).
- Coste: R2 a 0,015 $/GB-mes (0,01 $ en acceso poco frecuente), salida gratis
  ([tarifa](https://developers.cloudflare.com/r2/pricing/)).
- Lo legal manda (LEGAL-01): plazos mínimos, bloqueo y supresión de lo personal, borrar el fichero del
  ejercicio al vencer.

⚠️ El ID `DB-14` también aparece en el código para otra cosa: la reconciliación de valores derivados
(`use_cases/reconciliacion.rs`, `jobs/registro.rs::reconciliacion`).

### CENTRAL-RETENCION · Nada purga `webhook_events` ni `admin_audit`

La purga diaria de la base central (`server/purga.ts`) borra lo que crece desde fuera y ya no sirve
(los fallos, códigos y retos de emparejamiento, los eventos de los códigos de cambio de equipo) y las
trazas de correo a los 90 días. Dos tablas crecen sin que nada las borre, y van enteras en cada copia
diaria:

- `webhook_events`: cada evento de Stripe con su cuerpo entero (`payload_json`), que lleva el nombre,
  el correo, el teléfono y la dirección de quien compra. Hace falta para no aplicar dos veces un
  evento y para investigar un cobro: la consulta de AUD-45 la cruza con la auditoría
  ([licencias.md](arquitectura/licencias.md#reparar-lo-que-revocó-una-consulta-del-banco)).
- `admin_audit`: la auditoría de la administración y de los cobros, con hasta dónde se abrió el log de
  cada negocio devuelto (`negocio_log_reservado`), que la siguiente devolución de ese negocio usa para
  no repetir números ([worker.md](arquitectura/worker.md#las-copias-de-la-base-de-cada-negocio-do-03)).

Falta decidir cuánto se guarda cada una y qué parte (quizá sólo caduca el cuerpo de los eventos), con
el marco de [LEGAL-01](#legal-01--rgpd), y sin perder lo que usan la consulta de AUD-45 y
`negocio_log_reservado`.

### COPIAS-RETENCION · Las copias de un negocio que ya no copia no se borran nunca

Las copias diarias de cada negocio (`tpv-copias-negocios`) sólo se podan al subir una nueva
(`tenantHub.copia.ts::subirCopia` → `podarCopias`), y eso lo hace la alarma del propio objeto. Un
negocio que ya no hace copias deja las suyas para siempre, con los datos personales de sus clientes y
de su personal:

- **Retirado** (`/v1/admin/pruebas/retirar`, `/v1/admin/negocios-huerfanos`): la retirada vacía su
  `TenantHub` y con él su alarma, pero no toca el bucket de las copias, y nada en el código las borra.
- **Con el objeto perdido**: aquí quedarse es lo que se quiere, porque son las copias con las que se
  restaura ([worker.md](arquitectura/worker.md#las-copias-de-la-base-de-cada-negocio-do-03)).

El bucket no tiene ninguna regla de ciclo de vida por antigüedad (sólo la que aborta las subidas por
partes sin terminar a los 7 días), y una sin más borraría también las del objeto perdido. Lo decide
el responsable: que la retirada borre las copias (`podarCopias` con cero, en `tenantHub.copia.ts`),
una regla por antigüedad larga en Cloudflare, que habría que crear (de un plazo que no alcance a las
de un negocio vivo pero sí, pasado ese plazo, a las de un objeto perdido), o las dos, con el marco de
[LEGAL-01](#legal-01--rgpd).

---

## Arquitectura

### ARCH-01 · Doble implementación Main/worker

Cada escritura existe en Rust (`tpv-infra-sqlite`, para la Main) y en TypeScript
(`domains/*/*.commands.ts`, para la Handy), con dos sistemas de tipos (Specta y zod) y dos
validaciones. Tienen que producir lo mismo para que la replicación converja. La red que hay: los dos
arneses de contrato ([tests/contract/README.md](../tests/contract/README.md)) y
`scripts/check-contract-coverage.mjs`, que lista en CI lo que se quede sin caso.

Opciones, de menos a más ambiciosas:

1. Tests de contrato. **Hecho**, en escritura y lectura.
2. El texto SQL en una fuente compartida (ficheros `.sql` o JSON con *placeholders*, leídos con
   `include_str!` e `import`). Elimina la divergencia más frecuente; la orquestación seguiría doble.
3. Un solo cerebro en WASM: los *command builders* compilados a WebAssembly e importados en el worker.
   Es un refactor sólo del worker, desplegable con clientes en producción y con el arnés como red.
4. La Handy delega siempre en una Main viva: decisión de producto, cambia su historia offline.
5. Codegen desde una especificación: el generador pasa a ser su propia carga.

Decisión: refactor gradual después del lanzamiento, por (2) y luego (3) si la duplicación sigue
doliendo.
