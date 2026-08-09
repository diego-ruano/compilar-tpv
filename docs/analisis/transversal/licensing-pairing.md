# T3 — Licensing + Pairing

> **Ámbito.** Activación y validación de licencia del TPV, identidad criptográfica del dispositivo
> (ed25519 en el keyring del SO / Android Keystore), gate de arranque con **grace offline**, y
> emparejamiento de dispositivos **Handy** (token + revoke).
> **Capas:** `crates/tpv-infra-licensing/src/{lib.rs,device.rs,secret_store.rs}`,
> `apps/tpv-main/src-tauri/src/commands/{licensing,pairing}.rs`,
> `apps/cloud-worker-licensing/src/domains/{licensing,stripe,admin}`, `routes/pairing.ts`.
> El diseño completo del sistema propio de licencias está en
> [PLAN_LICENCIAS_PROPIAS.md](../../PLAN_LICENCIAS_PROPIAS.md).

## Valoración de seguridad

**Aciertos (buena higiene criptográfica):**
- **Secretos fuera de la BD**: device-id, clave privada ed25519 y token del Handy viven en el
  keyring del SO (escritorio) o en Android Keystore cifrados con AES-GCM (Handy).
- **ed25519** para firmar las peticiones del dispositivo (`ts\nMETHOD\npath\nsha256(token)`).
- **Estado de licencia firmado por el servidor** y verificado contra una **clave pública pineada en
  el binario** (`LICENSE_SIGNING_PUBLIC_KEY_B64`): un proxy local con CA propia ya no puede
  falsificar `allowed=true`.
- **Grace offline** (72 h) con tolerancia a rollback de reloj.

## Hallazgos abiertos

| ID | Sev | Título | Ubicación |
|----|-----|--------|-----------|
| LIC-02 | 🔵 | Sin **certificate pinning** del host de la API | `http_client` |
| LIC-04 | 🔵 | Documentar el **modelo de amenaza** del gate (corre en cliente) | `lib.rs` |

### LIC-02 🔵 Sin certificate pinning
Ya no habilita ningún bypass: con LIC-01 resuelto, un MITM no puede falsificar el estado de
licencia (está firmado y la clave va pineada), y en pairing el impacto se limita a la
confidencialidad del token (el handshake es ed25519 y el JWT va firmado). La firma pineada es más
robusta que el pinning de transporte, así que esto queda como extra opcional.

### LIC-04 🔵 Modelo de amenaza del gate
El gate de licencia corre en el cliente, así que un bypass local siempre es posible en última
instancia (parchear el binario). Lo que falta es **documentarlo** explícitamente para no dar por
supuesta una garantía que no existe. Tarea de documentación, no de código.
