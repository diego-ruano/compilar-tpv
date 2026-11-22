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
| [SUBIDA-TECHO](#subida-techo--el-techo-total-de-la-subida-completa) | 🔵 | El techo de 60 millones de filas de la subida completa, sin medir con bares reales | Medir en producción |
| [SEC-SESION](#sec-sesion--sesión-personal-verificable-en-el-worker-y-la-autoría-ri-28-aud) | 🟡 | El Worker autentica al dispositivo, sin sesión personal verificable; con RI-28-AUD (autoría de apertura/líneas y tareas ajenas) | Aplazado; se hacen juntos más adelante |
| [FABLE-E](#fable-e--sin-nonce-en-el-device-proof) | 🔵 | Sin nonce anti-repetición en el device-proof | Aplazado |
| [LOGIN-04](#login-04--el-hash-del-pin-se-puede-romper-offline) | 🔵 | El hash del PIN se puede romper offline | Aplazado |
| [LIC-02](#lic-02--sin-certificate-pinning) | 🔵 | Sin *certificate pinning* del host de la API | Aplazado |
| [RELOJ-01](#reloj-01--la-hora-del-negocio-es-la-del-equipo) | 🔵 | La hora del negocio es la del equipo | Aplazado |
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

1. Un `env.staging` en `wrangler.json` con su `name` y sus `vars` (`ENVIRONMENT: "staging"`, `TURSO_*`,
   `EMAIL_*`). Su `TenantHub` sería otro namespace.
2. Todos los secretos repetidos con `--env staging`.
3. **Otra base de control en Turso**: compartirla sería escribir sobre datos de clientes. Las bases
   de los negocios van con su `TenantHub`, que ya es otro.
4. Otro bucket de R2. La URL de las imágenes de la Handy sale de `CLOUD_API_BASE` (`handy_url_imagenes`, punto 6), y el `img-src` de la CSP la repite.
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

---

## Detectado al revisar la documentación

Contrastando la documentación con el código salieron cosas que no son de documentación. Ninguna se ha
tocado; están aquí para decidir.

- **`Clientes.NIF`, `Razon_Social` y `Direccion_Fiscal` existen en el esquema pero nada los lee ni los
  escribe**: el formulario de factura completa siempre empieza vacío.
