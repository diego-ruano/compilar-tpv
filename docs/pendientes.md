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
| [INFRA-01](#infra-01--entorno-de-staging) | 🟡 | No hay entorno de staging | Aplazado |
| [INFRA-02](#infra-02--instalador-sin-firmar) | 🟡 | El instalador no va firmado (Authenticode) | Aceptado a sabiendas |
| [INFRA-03](#infra-03--imágenes-por-r2dev) | 🟡 | Las imágenes de la Handy salen de `r2.dev` | Decidido: dominio propio, pero uno de Cloudflare cae con los bloqueos de LaLiga |
| [OPS-02](#ops-02--soporte-sin-canal-ni-diagnóstico) | 🟡 | «Contacta con soporte» sin canal ni diagnóstico exportable | Sin empezar |
| [RI-28-AUD](#ri-28-aud--ampliar-la-autoría-y-la-administración-de-tareas) | 🔵 | Autoría de apertura/líneas y finalización de tareas ajenas por administrador | Aplazado por decisión de producto |
| [SEC-SESION](#sec-sesion--sesión-personal-verificable-en-el-worker) | 🟡 | El Worker autentica al dispositivo, sin sesión personal verificable | Aplazado; autorización personal en Rust |
| [FABLE-E](#fable-e--sin-nonce-en-el-device-proof) | 🔵 | Sin nonce anti-repetición en el device-proof | Aplazado |
| [LOGIN-04](#login-04--el-hash-del-pin-se-puede-romper-offline) | 🔵 | El hash del PIN se puede romper offline | Aplazado |
| [LIC-02](#lic-02--sin-certificate-pinning) | 🔵 | Sin *certificate pinning* del host de la API | Aplazado |
| [RELOJ-01](#reloj-01--la-hora-del-negocio-es-la-del-equipo) | 🔵 | La hora del negocio es la del equipo | Aplazado |
| [SYNC-29](#sync-29--un-cambio-de-la-handy-pisa-en-la-main-una-escritura-suya-sin-subir) | 🟡 | Un cambio de la Handy pisa en la Main una escritura suya que aún no ha subido | Sin decidir |
| [SYNC-30](#sync-30--una-ruta-del-worker-decide-con-una-lectura-fuera-de-su-transacción) | 🔵 | Una ruta del worker decide con una lectura fuera de su transacción | Sin decidir |
| [SYNC-32](#sync-32--una-main-en-sesión-normal-con-la-base-anterior-a-lo-purgado-no-tiene-cómo-volver-a-la-nube) | 🔵 | Una Main en sesión normal con la base anterior a lo purgado no tiene cómo volver a la nube | Sin decidir |
| [INC-20261030-019](#inc-20261030-019--la-handy-windows-sólo-cambia-el-nombre-del-negocio-al-recibir-el-foco) | 🔵 | La Handy Windows sólo cambia el nombre del negocio al recibir el foco | Comprobar a mano |
| [Revisión de docs](#detectado-al-revisar-la-documentación) | — | Lo que salió al contrastar la documentación con el código | Sin decidir |

---

## Veri\*factu

### VF-VUELTA · Volver a poner Veri\*factu

Esta rama no remite a la AEAT. Veri\*factu entero —remisión, certificado, QR en el papel, avisos,
anomalías, exportación, declaración responsable y modo prueba— está en `con-verifactu` (Windows 10
y 11) y `con-verifactu-windows-7`, tal como estaba el 25-10-2026. La retirada es un solo commit de
`main` (`git log --oneline --grep "sin Veri"`): volver a ponerlo empieza por revertirlo sobre la
rama de trabajo y resolver lo que haya cambiado desde entonces.

Con él vuelve lo que estaba pendiente allí:

- **La identidad del productor**: `PRODUCTOR_NIF` está vacío y sin él no se remite. Falta saber si
  el productor será un autónomo o una sociedad, y confirmar `PRODUCTOR_NOMBRE_RAZON`,
  `PRODUCTOR_NOMBRE_SISTEMA` y `PRODUCTOR_ID_SISTEMA`.
- **El texto de la declaración responsable** (art. 13 RRSIF), que es un borrador.
- **Quitar el modo prueba**, que vuelve con la reversión.
- **Qué se hace con lo emitido en esta rama.** Esos registros tienen su huella y su QR, pero no fila
  en `_Verifactu_Envios`: tras revertir, `resembrar_cola_de_envio` los encolaría todos para remitir.
  Hay que decidir entonces si se remiten.

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

El cifrado de la PII del personal no la pone fuera de nuestro alcance: el texto cifrado está en Turso
y la DEK en el control-plane ([arquitectura/licencias.md](arquitectura/licencias.md)). Hay que
declararlo así.

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

### RI-28-AUD · Ampliar la autoría y la administración de tareas

Aplazado por decisión de producto. **No incluye las correcciones originales de RI-28**: las
atribuciones existentes y los movimientos manuales de stock deben obtener su autor de la sesión
Rust; un trabajador solo puede finalizar su propia asignación.

Pendiente:

- Registrar por separado el usuario que abrió una comanda y el que creó cada línea. El responsable
  de la comanda puede cambiar; su autor original debe permanecer inmutable. Esto requiere columnas,
  dominio/puertos, contratos, SQLite, HTTP, Worker y pruebas de replicación. No implica un historial
  completo de ediciones y borrados.
- Permitir al administrador finalizar una asignación de otro trabajador, registrando el actor real
  separado del destinatario. El administrador ya ve el listado global y las asignaciones; falta la
  acción en esa vista. Cada finalización afecta a una asignación, no a todos los destinatarios.
- Los trabajadores no pueden delegar ni actuar en nombre de otro. Comprobar autorización sobre el
  recurso y conservar quién realizó la acción también al replicar, reintentar y recuperar una copia.

### SEC-SESION · Sesión personal verificable en el Worker

Aplazado explícitamente. Los permisos personales y las atribuciones se comprueban en Rust, tanto
Main como Handy. El Worker sigue autenticando el dispositivo con JWT + device-proof: los IDs de
usuario que recibe desde un adaptador son atribuciones del cliente, **no prueba de una sesión
personal**. No dar por resuelta la autorización por trabajador del servidor.

Al retomarlo: emitir la sesión tras verificar el PIN con LOGIN-01; ligarla a tenant, dispositivo y
usuario; mantener la credencial en Rust; comprobar usuario activo, permisos y propiedad del recurso
en middleware/casos de uso; establecer caducidad y revocación al cerrar sesión o modificar permisos.
No confiar en el rol ni en el autor enviados en el cuerpo. Adaptar login, puertos/HTTP, Worker,
contratos y pruebas de suplantación y revocación. La Main debe conservar su funcionamiento offline,
y la sincronización de fondo y los flujos de arranque/recuperación no dependen de una sesión personal.

### FABLE-E · Sin nonce en el device-proof

La firma del dispositivo cubre método, ruta, token y cuerpo, pero no lleva nonce: dentro de la
ventana de ±2 minutos (`MAX_SKEW_MS` en `server/middleware/auth.ts`) una petición firmada se podría
reproducir tal cual. Aplazado: hay que haber capturado el tráfico (va por TLS) y las escrituras son
idempotentes por `Op_Id`. Cuando se retome hace falta un almacén de nonces compartido entre isolates
(KV es eventualmente consistente; un Durable Object o una tabla con TTL sí sirven) y un despliegue en
tres pasos: worker tolerante, clientes nuevos, worker estricto.

### LOGIN-04 · El hash del PIN se puede romper offline

PBKDF2-HMAC-SHA256, 100.000 iteraciones, sal de 16 bytes por usuario (`tpv-domain/src/login.rs`,
`PBKDF2_ITERS`). `Usuarios.Password_Hash` se replica a Turso porque el worker verifica el PIN de la
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

1. Un `env.staging` en `wrangler.json` con su `name` y sus `vars` (`ENVIRONMENT: "staging"`, `TURSO_*`,
   `EMAIL_*`). Su `TenantHub` sería otro namespace.
2. Todos los secretos repetidos con `--env staging`.
3. **Otra base de control y otras bases de tenant en Turso**: compartirlas sería escribir sobre datos
   de clientes.
4. Otro bucket de R2, y la URL de imágenes configurable (`CDN_IMAGES_BASE` en `imageUrl.ts` y la CSP).
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

### INFRA-03 · Imágenes por `r2.dev`

La Handy carga las imágenes de `pub-6814….r2.dev` (`CDN_IMAGES_BASE`, `shared/lib/imageUrl.ts`), que
Cloudflare documenta como no destinado a producción. **Decidido: subdominio propio.** Al hacerlo hay
que tocar `CDN_IMAGES_BASE`, `img-src` de `csp` **y** `devCsp` en `tauri.conf.json`, y la guía de
Android, que documenta ese host.

⚠️ Un subdominio de `altarialights.com` en Cloudflare sale por 188.114.96.5 y 188.114.97.5, que los
operadores españoles bloquean cuando hay fútbol: por eso la API y las reservas web siguen en
`workers.dev` (el porqué, junto a `CLOUD_API_BASE`). Con las imágenes pasaría lo mismo: la Handy se
quedaría sin ellas en hora de partido. Hace falta otra salida o volver a decidir.

### OPS-02 · Soporte sin canal ni diagnóstico

Conectividad dice «contacta con soporte» sin decir cuál
(`features/configuracion/sections/Conectividad.tsx`), y no hay ningún botón para sacar un paquete de
diagnóstico, que es lo que hace falta cuando el bar no tiene internet y la telemetría no ha salido.

---

## Datos

### DB-14 · Retención y archivado

Nada purga `Comandas`, `Detalle_Comanda`, `Pagos`, `Movimientos_Stock` ni `Notificaciones` (las
notificaciones se borran de una en una). `purga_sync` limpia el andamiaje de replicación y
`server/purga.ts` sólo `pair_claim_fallos` y `email_sends`. Las siete copias diarias son completas y
engordan con todo.

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

---

## Arquitectura

### ARCH-01 · Doble implementación Main/worker

Cada escritura existe en Rust (`tpv-infra-sqlite`, para la Main) y en TypeScript
(`domains/*/*.commands.ts`, para la Handy), con dos sistemas de tipos (ts-rs y zod) y dos
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

### RELOJ-01 · La hora del negocio es la del equipo

Las **firmas** usan la hora de la nube (`tpv-infra-licensing/src/reloj.rs`), pero ventas, fichajes,
caja, registros Veri\*factu y `x-client-now` usan el reloj del PC. Un desvío lento no importa; un salto
grande (pila de la placa agotada, cambio manual, zona horaria mal puesta) facturaría con otra fecha. No
se corrige sin más porque quitarle minutos de golpe a un PC adelantado fecharía una factura antes que la
anterior, que es lo que el art. 7.i) anota como anomalía. Si se retoma, la medida del desfase ya existe
(`reloj::ahora_ms()`); falta decidir a partir de cuánto se actúa y cómo, sin que la cadena retroceda.

### SYNC-29 · Un cambio de la Handy pisa en la Main una escritura suya sin subir

La Main aplica lo que llega de la nube (`tpv-infra-sqlite/src/sync.rs::apply_one`) aunque esa fila
tenga una escritura propia esperando en el outbox. Si una Handy edita la fila en los segundos que van
de que la Main la escribe a que la sube, la nube se queda con lo de la Main (llegó después) y la Main
con lo de la Handy (lo aplicó encima, y el eco de su propia escritura se descarta por idempotencia).
Las dos copias quedan distintas hasta que `verificar_nube` lo ve y repara con lo de la Main.

La bajada en orden (AUD-18) agranda la ventana: un cambio remoto que falla al aplicarse se reintenta
tras unos segundos (`espera_para_reintentar`), y lo que la Main escriba en esa fila mientras tanto
también lo pisa al entrar.

Le pasa a cualquier escritura de la Main, pero donde más se nota es en la reserva desde la web
(docs/estudios/reservas-web.md): la Main cancela una reserva porque lo pide el cliente, una Handy la
edita en ese momento con su estado de antes, y la Main se queda con la reserva viva mientras la nube
—y la agenda, que da la cancelación por hecha al verla en Turso— la tiene cancelada. La reparación
diaria la volvería a subir viva.

La ventana es de segundos y necesita una Handy editando esa misma fila. Opciones: que al aplicar un
cambio remoto se respete la escritura local pendiente de la misma fila (aplicar otra vez lo del
outbox encima, o saltarse la fila y reencolarla), o decidir que el orden de la nube manda y que la
Main se ajuste a él en vez de repararlo con lo suyo. Afecta al motor de réplica entero: sin decidir.

### SYNC-30 · Una ruta del worker decide con una lectura fuera de su transacción

La Main decide dentro de la transacción que escribe: lee la fila y escribe con el cerrojo del
escritor, y nadie se cuela en medio. Las rutas del worker no pueden: leen Turso con `tenantQuery`,
deciden y luego mandan el comando al `TenantHub`, que lo aplica en otro momento. Entre la lectura y
la escritura puede llegar otra (lo que sube la Main, otra Handy). El lote del `TenantHub`
(`tenantHub.lote.ts`) sólo sabe ejecutar escrituras y lecturas que se devuelven: no tiene un paso
que compruebe una condición y aborte el lote sin replicarse.

Ejemplos: cancelar una reserva desde la Handy (`POST /v1/reservas/:id/cancelar`) comprueba que está
`PROXIMA` y, si en esos milisegundos la Main la ha sentado, la cancela igual; marcar la llegada o la
salida desde la mesa (`PUT /v1/mesas/reservas/:id/estado`), el solape con otra reserva en modo
«prohibir», el último administrador, el turno repetido de un trabajador o una línea de un producto
que se acaba de archivar funcionan igual. La ventana es de milisegundos y se suma a SYNC-29 (la Main
puede tener la fila de otra forma sin subir), que es la más ancha de las dos.

Lo que no puede romperse ya lo para la base con un índice único, también entre dos dispositivos a la
vez: una comanda abierta por mesa, un cierre por periodo, nombres de zona, mesa y producto, correos
de cliente. Y no todo lo que leen las rutas antes de escribir decide algo: la mayoría resuelve
identificadores o copia datos del catálogo. Lo que decide es poco más de una decena de comprobaciones.

Arreglarlo es darle al lote un paso de guarda que se evalúe dentro del mismo lote atómico de Turso,
que no se replique y que devuelva un error de negocio si no se cumple; y pasar a él esas
comprobaciones.

### SYNC-32 · Una Main en sesión normal con la base anterior a lo purgado no tiene cómo volver a la nube

Si la nube ya ha purgado algo por encima del checkpoint de la Main (`purgadoHasta`, AUD-19) y la base
no está en recuperación, la sesión se detiene (`FinDeSesion::AnteriorAlLog`): no aplica, no sube y no
mueve el checkpoint, Conectividad dice `detenida` y la Main sigue vendiendo en local. Con la purga
actual sólo llega ahí una base cambiada por fuera de la aplicación (una imagen de disco restaurada,
una `data.db` copiada a mano), porque el suelo de la purga no pasa del checkpoint de una Main que
reporta.

Falta el camino para salir: la pantalla de recuperación sólo aparece en los estados de recuperación,
y reconstruir desde la nube con el outbox lleno lo niega la guardia (`bootstrap_restaurar`). Ese
outbox mezcla lo vendido desde el cambio de base con lo que la base vieja tenía pendiente, que el
equipo de entonces ya subió y que volvería a aplicarse si su `Applied_Operations` ha caducado. Hay
que decidir qué se hace con él (guardarlo aparte y descartarlo, como en el traslado; subir sólo lo
posterior al cambio de base, si se puede distinguir; o pasar por la recuperación aceptando que el
cobro se detenga mientras tanto) y cómo se le ofrece al personal. Mientras tanto, el mensaje manda
contactar con soporte (OPS-02). Sin decidir.

---

## Comprobar a mano

### INC-20261030-019 · La Handy Windows sólo cambia el nombre del negocio al recibir el foco

En las pruebas E2E del 30-10-2026, al cambiar el nombre del negocio en la Main, la Handy Android lo
cambió sola y la Handy Windows siguió con el anterior hasta que se le dio el foco. Probablemente no
es un fallo: durante la prueba su ventana estaba tapada por otra, y Windows deja de repintar una
ventana tapada. El código que recibe el aviso es el mismo en las dos Handy.

Lo que sí hay en el código y tapa el resultado: cada vez que la ventana de la Handy recibe el foco,
`reintentar` corta el WebSocket aunque esté bien y vuelve a conectar (`src-tauri/src/lib.rs`,
`on_window_event`), y al reconectar se relee todo. Por eso, al darle el foco, siempre cuadra.

**Cómo comprobarlo:**

1. Arranca la Main y la Handy Windows, con la Handy vinculada y con sesión iniciada en Mesas, para
   que se vea el nombre del negocio en la cabecera.
2. Coloca la ventana de la Handy Windows **a la vista y sin nada encima**: no minimizada, sin la VM
   ni ninguna otra ventana tapándola. Lo mejor es un segundo monitor, o la VM de la Main en una
   ventana pequeña al lado.
3. En la Main: Configuración → Negocio → campo «Nombre». Escribe un nombre de prueba y pulsa
   «Guardar cambios». Apunta la hora.
4. **Sin tocar la Handy Windows** (ni clic, ni teclado, ni pasar a su ventana), mira su cabecera
   durante unos 10 segundos.
5. Vuelve a poner el nombre original en la Main y guarda.

**Qué hacer con el resultado:**

- **Si el nombre cambió solo:** no es un fallo; borra esta entrada. Después se puede valorar que el
  foco sólo reconecte cuando la conexión esté caída (en Android, al volver de segundo plano, sigue
  haciendo falta), para no cortar un socket sano en cada clic.
- **Si no cambió hasta pulsar en la ventana:** la Handy Windows no está recibiendo los avisos en
  vivo. Busca en Axiom, a esa hora, el aviso `se interrumpió el socket de avisos` (`tpv::handy`) de
  ese equipo, y repite con otro cambio (p. ej. el precio de un producto, mirando la carta en la
  Handy) para ver si le pasa a todo o sólo a los ajustes del negocio. Con eso se investiga.

---

## Detectado al revisar la documentación

Contrastando la documentación con el código salieron cosas que no son de documentación. Ninguna se ha
tocado; están aquí para decidir.

- **`Clientes.NIF`, `Razon_Social` y `Direccion_Fiscal` existen en el esquema pero nada los lee ni los
  escribe**: el formulario de factura completa siempre empieza vacío.
- **`Registros_Facturacion.Sin_Registro_Previo`** se lee y viaja al XML, pero ningún camino la rellena.
- **La pantalla Fiscal dice que el NIF «no es algo que se haga desde esta pantalla»** cuando ya hay
  registros, pero el campo sigue siendo editable y se guarda.
- **`descartarAvisoDatosFiscales`** (`e2e/helpers/fiscal.ts`) no la llama ningún recorrido.
