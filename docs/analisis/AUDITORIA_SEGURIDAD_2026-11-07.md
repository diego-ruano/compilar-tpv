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
- **Resultado.** Ninguna se descartó y **todas están arregladas**: no queda ninguna abierta. El ID de
  cada una está en un comentario junto a su arreglo (`git grep -n "AUD-"`).
- **Los tests están guardados** en `C:\Users\diego\security-audit-skill\tpv-completa\run-1\investigacion\AUD-NN\tests\`,
  con la ruta que tendrían en el repositorio. Casi todos sirven de test de regresión al arreglar:
  hoy demuestran el fallo o fallan donde comprueban el arreglo.
- **Las líneas citadas son de `38a4c2db`.** `main` ha seguido avanzando desde entonces (la retirada de
  los negocios de pruebas del E2E y otros); en `licensing.helpers.ts`, las líneas a partir de la 445 se
  han movido unas seis.
- **Ninguna repite un riesgo ya aceptado** en [pendientes.md](../pendientes.md) (SEC-SESION, FABLE-E,
  LOGIN-04, LIC-02, INFRA-02, RI-28-AUD). Cuando una va más allá de uno de
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

No queda ninguna pista abierta.

## Tabla

Vacía: todas las pistas están arregladas.

## A · Licencias, identidad y aislamiento entre negocios

## B · Emparejamiento de Handys

## C · Dinero, caja y réplica

## D · El puesto local frente al personal

## E · Datos personales en registros y telemetría

## F · Disponibilidad y coste del servicio compartido

## G · Correo desde el dominio del operador

## H · Publicación y CI

## I · Respuestas de la API

## Lo que sólo puede comprobar el responsable

Lo que no se decide desde el repositorio ni con tests locales. Nada de esto pide tráfico de ataque contra
producción: son paneles, consultas de sólo lectura o pruebas en un entorno propio.

- **Cloudflare** (panel): los campos del job de Logpush, su retención y quién lo lee, y el ajuste
  `observability.redact_query_string` (los tres, en `observabilidad.md`).
- **Axiom**: que el worker desplegado tenga `AXIOM_TOKEN`, y la retención y el acceso de
  `tpv-device-logs` y `cloudflare-logpush` (`observabilidad.md`), y que lo que ya se ingirió con datos
  de clientes en los errores de la Handy se borre o caduque.

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
