# D10 — Configuración (negocio · ticket · email/SMTP · contacto)

> **Ámbito.** Ajustes singleton del negocio: datos de empresa + logo + IVA, formato del ticket, datos
> de contacto, y **configuración de correo** (modo managed vía worker/Resend o SMTP propio con
> `lettre`) usada para enviar pedidos a proveedores.
> **Capas:** `crates/tpv-infra-sqlite/src/configuracion.rs`, `email_config.rs` (repo),
> `apps/tpv-main/src-tauri/src/commands/{configuracion,email_config}.rs`,
> `use_cases/{configuracion,email_config}.rs`, `apps/cloud-worker-licensing/src/domains/{configuracion,email}/*`,
> FE `apps/tpv-main/src/features/configuracion/*` (22 ficheros, ~2582 líneas; se carga en stores Zustand).

## Resumen de hallazgos

| ID | Sev | Título | Ubicación | Estado |
|----|-----|--------|-----------|--------|
| CONF-01 | 🟠 | **Contraseña SMTP en claro**: en BD, devuelta al FE en el DTO, y replicable a la nube | `commands/email_config.rs:39`, DB-04 | ✅ Ya resuelto (DB-04) |
| CONF-02 | 🟡 | `Logo_DataUrl` **base64 inline** → se replica embebido en la sentencia por WS (payload grande) | `configuracion.rs:192` | ✅ Corregido (canal R2) |
| CONF-03 | 🟡 | Envío de email: subject sin sanear (header injection) + no transaccional con el estado del pedido | `commands/email_config.rs:136`, PROV-02 | ✅ Header injection: no aplica; atomicidad → PROV-02 |
| CONF-04 | 🟡 | Sin validación de `IVA_Percent`/settings → configuración inválida afecta a todos los tickets/precios | `configuracion.rs:232` | ✅ Corregido (validación de dominio) |
| CONF-05 | 🔵 | `get_ticket` no lee todas las columnas de `Ticket_Settings` (DPI, chars/línea, márgenes, font) | `configuracion.rs:145` | ✅ Corregido (columnas cableadas al ticket) |
| CONF-06 | 🔵 | Doble implementación Rust/worker (parity) | `configuracion.rs` ↔ `configuracion.commands.ts` | 🟡 Parity mantenida a mano (sin tests de contrato) |

---

## Detalle de hallazgos

### CONF-01 🟠 Contraseña SMTP en claro y expuesta — ✅ YA RESUELTO (DB-04)
- **Estado:** resuelto por la refactorización **DB-04** (commit `8ecd76d`). Se **eliminó el modo SMTP
  propio** y la tabla `Email_Settings`: ya no existe `Smtp_Password` en el esquema ni en ningún DTO.
  Todo el correo se envía **por el worker** (`/v1/email/enviar-pedido` → Cloudflare Email Service /
  Resend). El comando `email_config.rs` solo construye la petición y la firma; no guarda credenciales
  (ver la nota en `packages/database/migrations/0001_inicial.sql:596`). No queda ninguna contraseña
  en BD, ni en el DTO al FE, ni replicable a la nube.

### CONF-02 🟡 Logo como base64 inline — ✅ CORREGIDO (canal R2)
- **Ubicación:** `patch_business` escribe `Logo_DataUrl` en `Business_Settings`.
- **Fallo:** a diferencia de las imágenes de producto (canal R2), el logo viajaba **embebido** en la
  sentencia SQL replicada por WebSocket. Un logo de varios cientos de KB generaba una sentencia enorme.
- **Arreglo aplicado:** el logo ahora se sube por el **mismo canal R2 que las imágenes de producto**
  (`save_image` → disco local + cola `images_drain_pending` → PUT firmado `/v1/images`). En
  `Business_Settings.Logo_DataUrl` se guarda **solo la ruta relativa** `images/logo/{uuid}.jpg` (no el
  base64), así que la sentencia replicada es una ruta corta. La visualización (Negocio + `TicketPaper`)
  resuelve la ruta con `resolveImageUrl` (fichero local en Main / CDN en Handy). **Compatibilidad:**
  `resolveImageUrl` devuelve los `data:` heredados verbatim, así que los logos antiguos siguen viéndose.
  Cambios: `main.rs` (subcarpeta `logo` permitida + carpeta), worker `images.routes.ts` (regex),
  `Negocio.tsx` (subida), `TicketPaper.tsx` (resolución), `Configuracion.tsx` (limpieza del anterior).
  **Nota:** la columna conserva el nombre `Logo_DataUrl` por compatibilidad, aunque su contenido pasa a
  ser una referencia de imagen (no un data URL).

### CONF-03 🟡 Envío de email: sanitización y atomicidad — ✅ Header injection no aplica
- **Estado:** tras DB-04 ya no hay `enviar_smtp` (SMTP propio eliminado). El subject
  `Pedido a ${nombre_proveedor}` se construye en el worker (`email/email.routes.ts:61`) y se envía como
  **campo JSON a la API de Resend**, no concatenado en cabeceras SMTP crudas → **header injection no es
  posible** por esta vía. Además el `nombre_proveedor` está validado por zod (`min 1, max 200`).
- **Pendiente (fuera de D10):** la **atomicidad envío↔estado del pedido** es responsabilidad de
  **PROV-02** ([proveedores.md](proveedores.md)); no se toca aquí.

### CONF-04 🟡 Sin validación de configuración — ✅ CORREGIDO
- **Ubicación:** `patch_business` fijaba `IVA_Percent` sin validar rango.
- **Fallo:** un IVA inválido (negativo, >100, no numérico) afecta al cálculo de **todos** los tickets
  y precios.
- **Arreglo aplicado:** nueva regla de dominio `validate_iva_percent` (finito y en `[0, 100]`) en
  `tpv-domain/src/configuracion.rs`, invocada en el caso de uso `use_cases/configuracion::patch_business`
  **antes** de persistir: si el patch trae un `iva_percent` fuera de rango o no numérico, se rechaza con
  `AppError::Validation` y no se escribe nada.

### CONF-05 🔵 `get_ticket` incompleto — ✅ CORREGIDO (columnas cableadas)
- **Ubicación:** el SELECT solo leía hasta `Paper_Width_Mm`, omitiendo `Paper_Dpi`, `Chars_Per_Line`,
  márgenes y `Font_Scale`, que existían en el esquema pero **no se leían ni se usaban** en ningún sitio
  (columnas muertas: la impresión ESC/POS derivaba las columnas solo de `paper_width_mm`).
- **Decisión (acordada):** en lugar de retirarlas, se **cablean al ticket** para que la configuración
  guardada tenga efecto real.
- **Arreglo aplicado (end-to-end):**
  - **DTO** `TicketSettings` (+ `get_ticket` SELECT + `patch_ticket`) leen/escriben las 7 columnas, con
    clamps de dominio (`clamp_paper_dpi` 203/300, `clamp_chars_per_line` 20–80, `clamp_font_scale`
    0.5–2.0, `clamp_margin_mm` 0–25).
  - **Impresión** (`printing.rs`): el builder ESC/POS ahora respeta:
    - `chars_per_line` → columnas del cuerpo, **acotado por el ancho físico** (papel − márgenes izq/dcha
      vía DPI). *Decisión:* `chars_per_line` es autoritativo (el valor con sentido ESC/POS); su default
      42 puede diferir del 48 histórico de 80 mm, pero ahora es configurable.
    - `margin_left_mm` → margen físico `GS L`; `margin_top/bottom_mm` → avances por dots (`ESC J`).
    - `font_scale` ≥ 1.5 → cuerpo a **doble alto** (sin perder columnas).
    - `paper_dpi` → factor mm→dots de márgenes.
  - **FE:** store `useTicketSettings` (defaults), mappers `configApis.ts`, payload `printerApis.ts`, y
    controles en `sections/Ticket.tsx` (DPI, chars/línea, escala, 4 márgenes).
  - **Parity:** worker `configuracion.{queries,commands}.ts` actualizados (mismo SELECT y clamps).

### CONF-06 🔵 Doble implementación Rust/worker
- Parity risk. **Arreglo:** tests de contrato.

---

## Workflow de corrección (D10)

1. **CONF-01 (seguridad SMTP).** Verificar replicación; mover el secreto al keyring / cifrar / no
   exponerlo al FE. Coordinar con DB-04 y [proveedores.md](proveedores.md).
2. **CONF-04 (validación).** Validar IVA y settings numéricos.
3. **CONF-02 (logo).** Mover a canal R2 o limitar tamaño.
4. **CONF-03 (email).** Sanear subject; atomicidad envío↔estado (PROV-02).
5. **CONF-05/06 (limpieza y parity).** Alinear DTO de ticket; tests de contrato.

**Invariante clave:** los **secretos** (SMTP) no deben viajar a la nube ni al FE en claro; la
configuración que afecta a precios/tickets debe estar **validada**.
