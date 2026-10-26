# Revisión integral del proyecto (2026-09-27)

> **Qué es.** Un repaso de punta a punta del monorepo —esquema, crates de Rust, shell de Tauri,
> frontend, worker de Cloudflare, CI y documentación— agrupado por funcionalidad, buscando bugs,
> cuellos de rendimiento, riesgos de seguridad, código muerto, deuda de arquitectura y
> tecnologías que convenga cambiar o añadir. Se hizo en dos pasadas: la del 27/09 y una segunda
> el 28/09 sobre lo que la primera sólo había muestreado (ver
> [Alcance](#alcance-y-límites-de-esta-revisión)).
>
> **Qué no es.** No es una lista de sospechas: cada punto se ha comprobado leyendo el camino
> completo y, donde se dice, **midiendo o reproduciendo** (ver [Anexo A](#anexo-a--mediciones)).
> Los que dependen de algo que no se puede comprobar desde el repo (el comportamiento de Turso en
> producción, un dato que sólo tiene la AEAT) lo dicen expresamente y explican cómo verificarlo.
> Lo legal va con su fuente oficial o marcado como pendiente de verificar.
>
> **La revisión original fue de sólo lectura.** Este documento conserva los hallazgos pendientes;
> los arreglos posteriores quedan en sus commits. Está enlazado desde el
> [índice de documentación](../README.md).
>
> **Cómo usarlo.** Cada hallazgo lleva un ID `RI-NN` estable. Siguiendo la convención del
> [índice de documentación](../README.md), al corregir uno se deja el ID en un comentario junto
> al arreglo y se **borra de aquí**; lo que se decida no hacer, también se borra. Si un ID no aparece,
> está resuelto o descartado. Lo aplazado y lo ya registrado en [pendientes.md](../pendientes.md)
> (LEGAL-01, FABLE-B/E, INFRA-01, DB-14, LOGIN-04…) no se repite: se cita.
>
> Severidad: 🔴 bloqueante · 🟠 alta · 🟡 media · 🔵 baja/mejora.
> Tipo: `bug` · `rendimiento` · `seguridad` · `arquitectura` · `deuda` · `docs` · `tecnología`.

---

## Índice

- [Resumen ejecutivo](#resumen-ejecutivo)
- [Tabla de hallazgos](#tabla-de-hallazgos)
- [Orden sugerido](#orden-sugerido)
- Por grupos:
  20. [Plataformas: Android (Handy) y Windows 7](#20-plataformas-android-handy-y-windows-7)
- [Lo que está bien y conviene no tocar](#lo-que-está-bien-y-conviene-no-tocar)
- [Alcance y límites de esta revisión](#alcance-y-límites-de-esta-revisión)
- [Anexo A · Mediciones y reproducciones](#anexo-a--mediciones)

---

## Resumen ejecutivo

El proyecto está muy por encima de la media en lo que más cuesta: el razonamiento de cada decisión
está escrito junto al código, los caminos del dinero y de la factura están pensados para no parar
la caja, y hay redes (contrato Main↔worker, anti-drift de migraciones, tablas golden compartidas
entre lenguajes) que casi ningún producto de este tamaño tiene.

Lo que queda de esta revisión se concentra en las plataformas.

La rama de Windows 7 es anterior a ARQ-01 y su canal del feed no está desplegado (RI-74).

---

## Tabla de hallazgos

| ID | Sev | Tipo | Hallazgo |
|----|-----|------|----------|
| [RI-74](#ri-74) | 🟡 | deuda | Windows 7: la rama es anterior a ARQ-01 y su canal del feed no está desplegado |
| [RI-75](#ri-75) | 🔵 | deuda | Android: el `Context` sale de una API no pública |
| [RI-76](#ri-76) | 🔵 | deuda | Android: restos de la plantilla, márgenes seguros y release sin firmar |
| [RI-77](#ri-77) | 🔵 | bug | La Handy enseña pantallas que en ella no funcionan (pedidos, caja, ticket, licencia) |

---

## Orden sugerido

**Antes de publicar:** lanzar el E2E sobre la aplicación compilada. Las correcciones del
frontend tienen regresiones automatizadas; el recorrido completo y la comprobación táctil en el
TPV real siguen siendo validaciones de la release.


**Antes de repartir la Handy de Android:** RI-75 y RI-76 (firma, márgenes), y
RI-77 para que no enseñe lo que no puede hacer.

**Antes de compilar otra versión de Windows 7:** RI-74. Integrar `main` en la rama, y pasar la ruta
del canal a `main`.

**Después, sin prisa:** el resto.

---


## Lo que está bien y conviene no tocar

Para equilibrar: estas piezas se han revisado y no tienen nada que objetar, o sólo detalles.

- **El dinero en céntimos** (ARQ-01) en el backend, con tablas de casos compartidas entre tres
  lenguajes: bien pensado y bien protegido. Lo que falló fue la última milla (los formularios), no
  el diseño.
- **Determinismo temporal** (`rewrite_now_literals`, CFG-04): cubre las formas raras de `'now'`, y
  la sentencia que se ejecuta en local es la misma que sube.
- **El outbox atómico con la escritura de negocio** (SYNC-02) y el cerrojo de escrituras durante la
  recuperación.
- **La cola durable del DO, la cuarentena en los dos sentidos y la reparación por estado** (SYNC-18,
  20, 22-26): el razonamiento de «fallar hacia transitorio» y «reparar por estado, nunca
  reintentando la sentencia» es correcto, y evitar `INSERT OR REPLACE` por las cascadas, también
  (comprobado: sólo queda en tests y en tablas sin hijas).
- **El contraste diario excluye bien el andamiaje** (`esTablaDeNegocio` deja fuera `Intentos_Login`
  y las tablas de replicación).
- **Stripe**: verificación manual del HMAC con tolerancia y varias `v1`, relectura de la sesión en
  vez de fiarse del webhook, y *fail-closed* si el precio no trae plazo.
- **Sesiones del worker**: una sola implementación (`jose`), algoritmo pinado, secreto
  *fail-closed*, errores traducidos por `code` y no por texto.
- **El correo**: destinatario acotado a proveedores del tenant, tope diario que sólo cuenta lo
  entregado, HTML escapado.
- **La emisión fiscal dentro de la transacción del cobro**, la clasificación por rango de códigos
  de la AEAT, el control de flujo como función pura con tests, y el TLS de WinHTTP sin ningún
  `SECURITY_FLAG_IGNORE_*`.
- **La exportación fiscal** (art. 8): `cadena.txt` verificable sin nuestro código, CSV con BOM y
  `;` para Excel en español.
- **El runner de jobs**: vencimiento contra `Last_Ok_Ms`, jitter, backoff, pánicos aislados y
  política pura testeable.
- **El cifrado de la PII** (construcción tipo SIV bien razonada; RI-13, en `docs/pendientes.md`, es de
  normalización, no de criptografía) y el almacén de secretos de Android (clave AES-GCM no exportable en el Keystore).
- **La restauración** (una transacción, la guardia del outbox dentro, `defer_foreign_keys`,
  identificadores filtrados antes de interpolar) y el backfill reanudable por `rowid`.
- **El frontend limpia lo que abre**: todos los `listen()` de Tauri y los `setInterval` tienen su
  desuscripción, incluida la carrera de «el componente se desmontó antes de que `listen` resolviera».
- El filtro de `/ws` por ticket de un solo uso consumido con `DELETE … RETURNING`, y los mensajes del
  DO que comprueban el rol del `helloSigned`, nunca una cabecera del cliente.
- **El harness de contrato**: compara el efecto y no el texto SQL, las lecturas como multiconjunto,
  y el comprobador de cobertura convierte «no cubierto» en «decidido no cubrir». La validación de
  entrada, que no mira, la fija `validacion_casos.json`.
- **La variante de Windows 7** va bien encaminada en lo difícil: TLS por rustls, TLS 1.2 explícito
  en WinHTTP y canales del feed separados por ruta (RI-74 tiene el detalle). Lo pendiente es
  mantenerla al día, no rehacerla.

---

## Alcance y límites de esta revisión

**Leído de principio a fin**:

- *Esquema y persistencia*: `0001_inicial.sql`, `db.rs`, `connection.rs`, `migrations.rs`,
  `mapping.rs`, `util.rs`, `mesas.rs`, `caja_movimientos.rs`, las partes transaccionales de
  `venta_rapida.rs` y `sync.rs`, `verifactu.rs`, `verifactu_export.rs`, `cuentas.rs`,
  `cierre_caja.rs`, `recovery.rs`, `login.rs`, `auth.rs`, `notificaciones.rs`, `trabajadores.rs`,
  `inventario.rs`, `clientes.rs`, `reservas.rs`, `proveedores.rs`, `pedidos_proveedor.rs`,
  `tareas.rs`, `configuracion.rs`, `reconciliacion.rs`, `stock_alertas.rs`.
- *Dominio y casos de uso*: el dominio completo; los casos de uso de verifactu, sync, licencias,
  tareas, mesas, trabajadores, inventario y cierre de caja.
- *Shell*: `lib.rs` (setup, imágenes, impresión, updater), `jobs/`, impresión, y el mapa de gates de
  **todos** los `#[tauri::command]`; en detalle los de trabajadores, sync, licencias, cierre de caja
  y verifactu.
- *Resto de Rust*: la telemetría completa, el transporte y la lectura de respuestas de la AEAT, el
  cliente HTTP de la Handy, el cliente de licencias, el almacén de secretos (escritorio y Android).
- *Frontend*: `socketMain.ts`, el flujo del dinero en todos los formularios que envían importes, la
  gestión de `listen`/`setInterval`/`localStorage`, y los formularios de producto, lote, pedido,
  gasto y trabajador. En la segunda pasada, **enteros y línea a línea**, los ficheros grandes:
  `VentaRapida.tsx`, `TicketPanel.tsx`, `MesaComandaModal.tsx`, `Cuentas.tsx`, `EditTables.tsx`,
  `Login.tsx`, `Reservas.tsx`, `Proveedores.tsx`, `Trabajadores.tsx` y `Tareas.tsx` (este último
  sin nada que añadir), además de `NavBar.tsx` y la navegación de `Configuracion.tsx`.
- *Android*: el manifiesto, `build.gradle.kts`, `MainActivity.kt`, el almacén de secretos por JNI,
  la identidad del equipo, la CSP y el `viewport`, qué secciones ve la Handy, y
  `COMPILAR_ANDROID.md`.
- *Windows 7* (worktree `tpv-win7`): el diff completo de la rama frente a su punto de partida, las
  capacidades de Tauri que cambian (`.cargo/config.toml`, `vendor/ctor`, `tauri.windows7.conf.json`,
  el `cfg` del minidump, `vite.config.ts`, WinHTTP), `release-win7.yml`, `build-win7.ps1` y
  `COMPATIBILIDAD_WINDOWS_7.md`, cruzados con lo que ha cambiado en `main` desde entonces.
- *Paridad*: los dos harness de contrato (escritura y lectura), `cobertura.json` y el comprobador, y
  a mano la validación de entrada de todos los dominios en los dos lados.
- *Worker*: la entrada, el middleware de autenticación, `sesion.ts`, `tenantClient.ts`, el núcleo
  del DO y los controles de rol de sus mensajes, Stripe, actualizaciones, el catch-up, imágenes,
  correo, activación y cambio de equipo, y la administración.
- Toda la configuración de CI, build, Tauri y wrangler.

**Revisado por muestreo y búsquedas dirigidas** (patrones de rendimiento, seguridad, código muerto,
errores tragados, unidades del dinero, orden por id): el resto de páginas y componentes del
frontend, las consultas del worker de estadísticas, mesas y venta rápida (cuya paridad con Rust ya
vigila el harness de contrato), `sync_reparacion.rs`, el emparejamiento y los scripts.

**No revisado**: las suites de test en sí, salvo el harness de contrato (sólo su alcance en CI y los
casos que tocan cada hallazgo); los recorridos E2E, que se han mirado por encima; y el
contenido de los documentos de plan (`PLAN_*.md`), salvo donde el código los cita. Tampoco se ha
**ejecutado** la interfaz en Android ni en Windows 7: lo marcado «a verificar» en RI-74 y RI-76
hay que comprobarlo en el emulador o en la máquina virtual. Los nuevos contratos y el backend
compilan para Android; el editor de mesas queda pendiente de prueba en una pantalla táctil.

---

<a id="anexo-a--mediciones"></a>
## Anexo A · Mediciones

**Método.** Esquema real (`packages/database/migrations/0001_inicial.sql`) cargado en SQLite 3.49.1
(módulo `sqlite3` de Python 3.13.5) con `PRAGMA foreign_keys = ON`. Ningún script ni dato se ha
guardado en el repositorio.

**Reproducciones de la segunda pasada.** Las de SQL, sobre el mismo esquema y con `foreign_keys = ON`; las de RI-71 y RI-82, en Node:

| Hallazgo | Qué se hizo | Resultado |
|---|---|---|
| RI-71 | `Number("0199a3f2-7c1e-7d3a-9f00-1a2b3c4d5e6f") > 0` y `Number("")` en Node | `false` (el primero es `NaN`) y `0`: una línea guardada y una sin guardar dan lo mismo |
| RI-82 | `StandardFonts.Helvetica.encodeText()` de pdf-lib con «Año 2027 · 12,50 € · ¿Señor? ¡Olé! Nº 3ª» | Lo codifica sin error. Sólo fallan «→» y los emojis («WinAnsi cannot encode») |
