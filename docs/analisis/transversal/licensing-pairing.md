# T3 — Licensing + Pairing

> **Ámbito.** Activación y validación de licencia del TPV, identidad criptográfica del dispositivo
> (ed25519 en el keyring del SO), gate de arranque con **grace offline**, y emparejamiento de
> dispositivos **Handy** (token + revoke).
> **Capas:** `crates/tpv-infra-licensing/src/{lib.rs,device.rs}`,
> `apps/tpv-main/src-tauri/src/commands/{licensing,pairing}.rs`,
> `apps/cloud-worker-licensing/src/{domains/licensing,routes/pairing.ts}`.

## Valoración de seguridad

**Aciertos (buena higiene criptográfica):**
- **Secretos en el keyring del SO** (device-id, clave privada ed25519, token del Handy) — **no** en la
  BD. Es el patrón correcto y contrasta con el SMTP en claro (DB-04/CONF-01).
- **ed25519** para firmar las peticiones del dispositivo (`ts\nMETHOD\npath\nsha256(token)`), lo que
  autentica el dispositivo ante el servidor.
- **Grace offline** (48 h) con **tolerancia a rollback de reloj** (2 min) — diseño razonable.

**Riesgo principal:** la validez de la licencia se confía a **TLS**, sin firma del servidor
verificada contra una **clave pública pineada** en la app.

## Resumen de hallazgos

| ID | Sev | Título | Ubicación |
|----|-----|--------|-----------|
| LIC-01 | 🟡 | La respuesta de licencia **no se verifica criptográficamente** (solo TLS) → bypass local con proxy + CA propia | `lib.rs:217`, `call_status` |
| LIC-02 | 🟡 | Sin **certificate pinning** del host de la API → facilita el MITM que habilita LIC-01. **En pairing** el impacto es bajo (handshake ed25519 + JWT firmado): solo confidencialidad del token, no bypass. | `http_client` |
| LIC-03 | ✅ | Anti-replay del device-proof en REST. **Pairing: VERIFICADO / no explotable** (todos los caminos firmados validan `ts` a 2 min; `fetch-token` además usa nonce de un solo uso). Queda por confirmar `/v1/license/*`. | `device.rs:81`, worker |
| LIC-04 | 🔵 | Amenaza inherente: el gate corre en cliente; documentar el modelo (bypass local siempre posible) | `lib.rs:236` |
| LIC-05 | 🔵 | **Buenas prácticas de secretos** (keyring) → mover aquí el SMTP (DB-04/CONF-01) | `device.rs` |
| LIC-06 | 🔵 | `LICENSE_API_BASE` y `TPV_SERVER_BASE` son **dos constantes al mismo host** (legacy de la fusión) | `lib.rs:37-38` |

---

## Detalle de hallazgos

### LIC-01 🟡 La licencia no se verifica con firma pineada — CONFIRMADO
- **Ubicación:** `call_status` (`lib.rs:192-221`) firma la **petición** (device-proof) y confía en la
  **respuesta** `StatusOk` (status/expires_at) validando solo su JSON sobre HTTPS. No hay una **firma
  del servidor** sobre el estado de licencia que el cliente verifique contra una **clave pública
  embebida/pineada**.
- **Fallo:** un usuario que controla su máquina (proxy local + CA propia, o redirección DNS del host)
  puede presentar un servidor falso que responda `allowed=true` → **saltarse el licensing**. La única
  barrera es la validación de certificado TLS del dominio.
- **Impacto:** el control de licencia es evadible por un atacante local motivado.
- **Arreglo:** que el servidor **firme** el estado de licencia (ed25519) y el cliente lo verifique
  contra una **clave pública pineada** en el binario. Así, ni un MITM con cert válido puede forjar un
  "allowed". (Sigue siendo software en cliente, pero eleva mucho la barrera.)

### LIC-02 🟡 Sin certificate pinning
- **Ubicación:** el cliente HTTP (`http_client`, `lib.rs:95-100`; y el client inline de
  `tpv_server_post_json`, `lib.rs:543-546`) usa la validación TLS por defecto de `reqwest`.
- **Fallo:** sin **pinning**, cualquier CA de confianza del sistema (incluida una añadida por el
  usuario) valida el host → habilita el escenario de LIC-01.
- **Impacto en pairing (bajo):** el handshake de pairing ya es criptográficamente sólido extremo a
  extremo — la petición del dispositivo va firmada con **ed25519** (clave privada en keyring, no
  forjable por un MITM) y el token del Handy es un **JWT HS256 firmado por el servidor**
  (`pairFetchToken.ts:318`, no fabricable sin `LICENSE_JWT_SECRET`). Por tanto, para pairing el
  pinning **no cierra un bypass**; solo mitigaría la *confidencialidad* (robo del token en tránsito),
  y ese escenario exige que el atacante ya controle el trust store del dispositivo (donde también
  podría leer el keyring). Es defensa en profundidad, no bloqueante.
- **Arreglo:** pinnear el certificado/clave pública del host de la API (o depender de la firma de
  LIC-01, que es más robusta que el pinning de transporte).

### LIC-03 ✅ Anti-replay del device-proof — VERIFICADO (pairing no explotable)
- **Ubicación:** `sign_device_proof` (`device.rs:81-86`) incluye `ts` en el mensaje firmado.
- **Verificación (pairing):** revisado el worker, **todos los caminos REST de pairing que llevan
  firma validan la frescura del `ts` con ventana de 2 min**:
  - `create` / `pending` / `approve` (Main/TPV) → `buildTenantContext` →
    `verifyDeviceProofOrThrow` (`auth.ts:96-98`, `MAX_SKEW_MS = 2min`).
  - `fetch-token` (Handy anónimo) → valida `ts` a 2 min (`pairFetchToken.ts:188-193`) **y además**
    consume un **nonce de un solo uso** con expiración (`device_challenges`, marcado `used_at_ms`),
    protección anti-replay más fuerte que la sola ventana temporal.
  - `claim` (Handy anónimo) → no lleva firma que reproducir (solo registra la pubkey); protegido por
    throttle por IP + aprobación manual del Main.
- **Conclusión:** para **pairing no hay bug**: el replay está cerrado. Queda pendiente solo confirmar
  el mismo control en el camino **`/v1/license/*`** (licensing, fuera de este ciclo).

### LIC-04 🔵 Modelo de amenaza del gate en cliente
- El gate (`gate_inner`) decide `allowed` en el cliente. Cualquier check de licencia en software de
  cliente es, en última instancia, evadible por quien controla el binario/proceso.
- **Arreglo:** documentar el modelo y decidir cuánta inversión anti-tamper es proporcional al valor.
  LIC-01 (firma pineada) es el mejor retorno.

### LIC-05 🔵 Extender el uso del keyring
- El licensing hace lo correcto guardando secretos en el keyring. **Recomendación:** mover el
  **secreto SMTP** (hoy en la BD, DB-04/CONF-01) al keyring por el mismo mecanismo.

### LIC-06 🔵 Constantes duplicadas
- `LICENSE_API_BASE` y `TPV_SERVER_BASE` apuntan al **mismo host** (legacy de cuando eran dos
  workers). **Arreglo:** unificar en una sola constante.

---

## Notas positivas (mantener)

- Firma de peticiones por dispositivo (ed25519) + secretos en keyring: **patrón correcto**.
- Manejo de errores del gate por familia de código HTTP (4xx invalida, 5xx/offline → grace) es claro.
- La auditoría previa de fidelidad ya corrigió el bug de propagación de códigos del worker
  (`AppError::Raw` para `not_approved`), según CLAUDE.md.

---

## Workflow de corrección (T3)

1. **LIC-01 (firma pineada).** Server firma el estado de licencia; cliente verifica con clave pública
   embebida. Mayor retorno de seguridad.
2. **LIC-03 (anti-replay).** ✅ Verificado para pairing (todos los caminos firmados validan `ts` a
   2 min; `fetch-token` con nonce de un solo uso). Pendiente solo confirmar `/v1/license/*`.
3. **LIC-02 (pinning).** Opcional si se implementa LIC-01.
4. **LIC-05 (secretos).** Migrar el SMTP al keyring (coordinar con [configuracion.md](../dominios/configuracion.md)).
5. **LIC-04/06 (documentación y limpieza).** Documentar el modelo de amenaza; unificar constantes.

**Invariante clave:** la decisión de licencia debe ser **verificable criptográficamente** por el
cliente (no solo confiada a TLS); los secretos siguen viviendo en el **keyring**, nunca en la BD.
