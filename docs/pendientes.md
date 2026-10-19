# Pendientes

Lo que está abierto y no depende de que alguien se acuerde. Cada punto dice qué falta, por qué
importa y qué se ha decidido. **Lo que se resuelve se borra de aquí**: la traza del arreglo queda en
el código (un comentario con su ID, `git grep -n "FABLE-B"`) y en el commit.

Severidad: 🔴 bloqueante · 🟠 alta · 🟡 media · 🔵 baja

| ID | Sev | Qué | Estado |
|---|---|---|---|
| [VF-PRODUCTOR](#identidad-del-productor) | 🔴 | Identidad del productor del software | Aplazado a propósito; bloquea la remisión |
| [VF-DECLARACION](#texto-de-la-declaración-responsable) | 🔴 | Texto definitivo de la declaración responsable | Borrador |
| [VF-MODO-PRUEBA](#quitar-el-modo-prueba) | 🔴 | Quitar el modo prueba antes del 1-1-2027 | Sin empezar |
| [LEGAL-01](#legal-01--rgpd) | 🟠 | Papeleo RGPD de encargado del tratamiento | Sin empezar |
| [LEGAL-02](#legal-02--reglamento-de-ciberresiliencia) | 🟠 | Reglamento de Ciberresiliencia | Sin empezar |
| [ARCH-01](#arch-01--doble-implementación-mainworker) | 🟠 | Doble implementación Main/worker | Refactor gradual tras el lanzamiento |
| [DB-14](#db-14--retención-y-archivado) | 🟡 | Sin retención ni archivado de datos de negocio | Decidido: archivo en R2, falta medir |
| [RI-13](#ri-13--la-pii-del-personal-se-cifra-sin-normalizar-ni-validar) | 🟡 | DNI, IBAN y nº de la Seguridad Social se cifran sin normalizar ni validar | Pendiente de decidir si estos campos se quedan |
| [INFRA-01](#infra-01--entorno-de-staging) | 🟡 | No hay entorno de staging | Aplazado |
| [INFRA-02](#infra-02--instalador-sin-firmar) | 🟡 | El instalador no va firmado (Authenticode) | Aceptado a sabiendas |
| [INFRA-03](#infra-03--imágenes-por-r2dev) | 🟡 | Las imágenes de la Handy salen de `r2.dev` | Decidido: dominio propio |
| [OPS-02](#ops-02--soporte-sin-canal-ni-diagnóstico) | 🟡 | «Contacta con soporte» sin canal ni diagnóstico exportable | Sin empezar |
| [RI-28-AUD](#ri-28-aud--ampliar-la-autoría-y-la-administración-de-tareas) | 🔵 | Autoría de apertura/líneas y finalización de tareas ajenas por administrador | Aplazado por decisión de producto |
| [SEC-SESION](#sec-sesion--sesión-personal-verificable-en-el-worker) | 🟡 | El Worker autentica al dispositivo, sin sesión personal verificable | Aplazado; autorización personal en Rust |
| [FABLE-E](#fable-e--sin-nonce-en-el-device-proof) | 🔵 | Sin nonce anti-repetición en el device-proof | Aplazado |
| [LOGIN-04](#login-04--el-hash-del-pin-se-puede-romper-offline) | 🔵 | El hash del PIN se puede romper offline | Aplazado |
| [LIC-02](#lic-02--sin-certificate-pinning) | 🔵 | Sin *certificate pinning* del host de la API | Aplazado |
| [RELOJ-01](#reloj-01--la-hora-del-negocio-es-la-del-equipo) | 🔵 | La hora del negocio es la del equipo | Aplazado |
| [SYNC-29](#sync-29--un-cambio-de-la-handy-pisa-en-la-main-una-escritura-suya-sin-subir) | 🟡 | Un cambio de la Handy pisa en la Main una escritura suya que aún no ha subido | Sin decidir |
| [MESAS-01](#mesas-01--el-plano-que-guarda-una-handy-no-pasa-la-validación-de-la-main) | 🔵 | El plano que guarda una Handy no pasa la validación de la Main | Sin empezar |
| [Revisión de docs](#detectado-al-revisar-la-documentación) | — | Lo que salió al contrastar la documentación con el código | Sin decidir |

---

## Veri\*factu

Lo técnico funciona contra la AEAT ([PRUEBAS_AEAT.md](PRUEBAS_AEAT.md)); lo que queda son datos y
decisiones.

### Identidad del productor

Las constantes `PRODUCTOR_*` de `apps/tpv-main/src-tauri/src/lib.rs` van en el bloque
`SistemaInformatico` de cada registro:

| Constante | Valor | Máx. | Falta |
|---|---|---|---|
| `PRODUCTOR_NOMBRE_RAZON` | `Altaria Lights` | 120 | Confirmar que es la razón social y no el nombre comercial |
| `PRODUCTOR_NIF` | **vacío** | 9 | El NIF definitivo |
| `PRODUCTOR_NOMBRE_SISTEMA` | `TPV Altaria` | 30 | Confirmar |
| `PRODUCTOR_ID_SISTEMA` | `01` | 2 | Confirmar |

Aplazado a propósito hasta saber si el productor será un autónomo o una sociedad. Mientras tanto se
vende, se emite y se encadena, pero **no se remite** (`productor_configurado`), y el día que la
versión traiga el NIF los registros emitidos sin él se corrigen solos antes del primer envío
(`asegurar_sistema_reparado`). Detalle en
[arquitectura/verifactu.md](arquitectura/verifactu.md#la-remisión).

Si algún día hay que probar en producción, un `IdSistemaInformatico` distinto para las pruebas hace
que el sistema definitivo empiece sin el aviso 2007.

### Texto de la declaración responsable

`TEXTO_DECLARACION` en `commands/verifactu.rs` es un borrador con lo que exige el art. 13 RRSIF. Hay
que revisarlo con la empresa constituida y, si procede, con un asesor: la firma el productor. Hasta
que `PRODUCTOR_NIF` exista, la pantalla dice que la declaración está incompleta.

### Quitar el modo prueba

Todo lo que hay que borrar lleva la etiqueta `MODO-PRUEBA` (`git grep -n MODO-PRUEBA`), más la columna
`Business_Settings.Modo_Prueba`, que para entonces irá en una migración nueva. **Antes del 1 de enero
de 2027**: un interruptor que deja de declarar ventas no puede existir en un TPV que se venda.

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

### RI-13 · La PII del personal se cifra sin normalizar ni validar

**Pendiente de decisión: si la ficha del trabajador sigue guardando DNI, IBAN y nº de la Seguridad
Social.** Puede que se quiten. Hasta saberlo no se toca nada; abajo están las dos salidas.

**Qué pasa.** Los tres campos se cifran en la Main antes de escribirlos (TRAB-03, `FieldCipher`), con
cifrado **determinista**: el mismo texto da siempre el mismo cifrado. Es lo que permite que
`Trabajadores.DNI` y `Trabajadores.Numero_Seguridad_Social` sigan siendo `UNIQUE` con el valor
cifrado. Pero el `UNIQUE` sólo ve un duplicado si el texto en claro es idéntico byte a byte, y lo
único que se normaliza antes de cifrar es el `trim` (`limpiar_opcional` en
`use_cases/trabajadores.rs`, alta y edición):

- `12345678Z`, `12345678z` y `12.345.678-Z` son tres cifrados distintos: el mismo DNI entra tres
  veces sin que el `UNIQUE` lo vea. Lo mismo un IBAN con y sin espacios.
- No se valida nada: ni la letra del DNI/NIE, ni el dígito de control del IBAN, ni la forma del nº de
  la Seguridad Social.
- Como el dato va cifrado, una errata no se encuentra después con una consulta: sale cuando falla
  una nómina.

El worker no entra: la Handy no escribe esos campos, porque no tiene la clave (los rechaza en
`trabajadores.schemas.ts` y no los toca en `trabajadores.commands.ts`).

**Si se quedan:**

1. **Normalizar antes de cifrar**, en el dominio, una función por campo, aplicada en el alta y en la
   edición:
   - DNI/NIE: mayúsculas, sin espacios, puntos ni guiones. Ojo: `normalizar_nif`
     (`tpv-domain/src/verifactu.rs`) quita espacios y guiones pero **no puntos**, así que
     `12.345.678-Z` seguiría saliendo distinto; o se amplía o se escribe una propia.
   - IBAN: mayúsculas, sin espacios.
   - Nº de la Seguridad Social: sólo dígitos.
2. **Validar como aviso, no como bloqueo**: el dato se guarda igual y la pantalla avisa junto al
   campo mientras se escribe.
   - DNI/NIE: `nif_valido` ya existe.
   - IBAN: el dígito de control mod 97 de ISO 13616.
   - Nº de la Seguridad Social: al menos la forma (12 dígitos). Su dígito de control no se implementa
     sin contrastarlo antes en una fuente oficial.
3. **Lo ya guardado**: sin clientes no hace falta tocarlo. Con clientes, el job `cifrado_pii` tendría
   que descifrar, normalizar y volver a cifrar, y decidir qué hacer si dos fichas pasan a chocar en
   el `UNIQUE`.
4. Tests: un `UNIQUE` que detecta `12345678Z` contra `12.345.678-z`, y la normalización como tabla de
   casos.

**Si se quitan**, hay que retirar los tres campos de todas las capas:

- Esquema: las tres columnas de `Trabajadores` en `0001_inicial.sql` (sin clientes se edita ahí, con
  su reset) y `schema.snapshot.sql`.
- DTOs (`tpv-contracts/src/trabajadores.rs`, `bindings.ts`), dominio, caso de uso y los dos
  adaptadores (`tpv-infra-sqlite`, `tpv-infra-http`), y el schema y los comandos del worker.
- Pantallas de alta y edición (`AddTrabajador.tsx`, `EditTrabajador.tsx`).
- El cifrado de campos entero, si no queda nada más que cifrar: `FieldCipher`, `field_crypto.rs`, el
  job `cifrado_pii`, la DEK que entrega el worker al activar y su custodia en el control-plane.
- Lo que los nombra en recuperación (`recovery.rs`, `RecuperarDatos.tsx`), en el filtro de datos
  personales de la telemetría (tres copias y `scrub_casos.json`) y en el caso de lectura de contrato
  `trabajadores/detalle`.
- LEGAL-01, que cuenta la PII del personal como dato que tratamos.

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

Le pasa a cualquier escritura de la Main, pero donde más se nota es en la reserva desde la web
(docs/estudios/reservas-web.md): la Main cancela una reserva porque lo pide el cliente, una Handy la
edita en ese momento con su estado de antes, y la Main se queda con la reserva viva mientras la nube
—y la agenda, que da la cancelación por hecha al verla en Turso— la tiene cancelada. La reparación
diaria la volvería a subir viva.

La ventana es de segundos y necesita una Handy editando esa misma fila. Opciones: que al aplicar un
cambio remoto se respete la escritura local pendiente de la misma fila (aplicar otra vez lo del
outbox encima, o saltarse la fila y reencolarla), o decidir que el orden de la nube manda y que la
Main se ajuste a él en vez de repararlo con lo suyo. Afecta al motor de réplica entero: sin decidir.

### MESAS-01 · El plano que guarda una Handy no pasa la validación de la Main

Al guardar el plano, la Main (`tpv-infra-sqlite/src/mesas.rs::save_layout`) rechaza un salón o una
mesa sin nombre y dos salones con el mismo nombre. El worker (`saveLayoutSchema` en
`domains/mesas/mesas.schemas.ts` y `saveLayout`), que es por donde guarda la Handy, recorta los
nombres pero no rechaza ninguna de las tres cosas. Una mesa sin nombre sale distinta en cada sitio:
«Venta» en Cuentas, y vacía en el ticket, la cocina, el widget y el aviso de una reserva web.

Falta lo que pide RI-78: sacar esas reglas a un `validar` de `tpv-domain`, añadir el dominio del plano
a `validacion_casos.json` con sus casos (nombre vacío, sólo espacios, salón repetido) y cablearlo en
`validacion_casos.rs` y `validacionCasos.test.ts`, para que el schema del worker rechace lo mismo.

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
- **Los comentarios de `0001_inicial.sql` citan documentos y secciones que ya no existen**
  (`docs/PLAN_VERIFACTU.md`, `docs/VERIFACTU_PENDIENTES.md`, `BACKLOG.md DB-14`, «CLAUDE.md 9») y uno de
  `inventario.queries.ts`, dentro de un texto SQL, cita una «migración 0004». No se han tocado: el hash
  de la migración incluye los comentarios y las bases que ya la aplicaron rechazarían el cambio.
  Las referencias vigentes y la errata de `_Sync_Applied_Ops` están aclaradas en
  [esquema.md](arquitectura/esquema.md#lo-que-hay-que-saber-de-los-comentarios-de-0001_inicialsql).
  Una migración nueva no evita comprobar los hashes anteriores; reescribirlos exigiría decidir
  expresamente qué hacer con las bases y copias existentes. El snapshot conserva su texto histórico.
