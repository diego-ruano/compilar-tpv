# Tareas de fondo e interruptores remotos

## Tareas periódicas (runner de jobs)

Todo lo que la Main hace «cada X tiempo» por su cuenta vive en un único runner
(`apps/tpv-main/src-tauri/src/jobs/`), no en `spawn` sueltos ni en `setInterval` del frontend.

| Pieza | Archivo | Rol |
|---|---|---|
| Motor | `jobs/mod.rs` | Vencimiento, jitter, backoff, gating, panics, registro |
| **Catálogo** | `jobs/registro.rs` | **El único fichero que se toca para añadir un job** |
| Estado | `_Jobs_State` (`0001_inicial.sql` §16, escrito en `infra-sqlite/src/jobs.rs`) | `Last_Ok_Ms` por job |
| Diagnóstico | `commands/jobs.rs::jobs_status` | Panel en Configuración → Conectividad |

### Añadir un job

1. Escribir `async fn <nombre>(app: AppHandle) -> Result<(), String>` en `jobs/registro.rs`. Devolver
   `Err` **es** decir «ha fallado» (backoff y una fila en rojo en el panel): no se captura el error para
   devolver `Ok`. Lo que no es una avería (falta un dato que tiene que poner el dueño) devuelve `Ok` y
   lo anota.
2. Añadir su `Job` a `catalogo()` con `cada`, `retardo_inicial`, `requiere` e `interruptor`.

El cuerpo tiene que ser **idempotente**: el motor puede adelantarlo si quedó vencido o repetirlo tras
un fallo parcial.

### Qué garantiza el motor

- **Vencimiento en reloj de pared** contra `Last_Ok_Ms`: un job de 6 h se ejecuta igual en un equipo
  que se apaga cada noche.
- **Jitter** de hasta el 10 % del intervalo (máximo 5 min); **backoff** exponencial de 60 s a 30 min.
- **Gating** reevaluado en cada vencimiento: `Requiere::Siempre` o `Requiere::MainOperativa` (Main con
  datos sanos y sin reconciliación en curso). Un job con su interruptor apagado se trata como un
  `requiere` no cumplido: no corre, no entra en backoff, no sale en rojo y no toca `Last_Ok_Ms`.
- El cuerpo corre en su propia task: un panic es un fallo registrado, no un job muerto.
- La política (`proxima_espera`) es una función pura con tests.
- ⚠️ `_Jobs_State` se escribe por `raw()`: por `execute()` cada tick se replicaría.

### El catálogo

| Job | Cada | Primer intento | Requiere | Interruptor | Qué hace |
|---|---|---|---|---|---|
| `licencia` | 6 h | 2 min | MainOperativa | — | `gate` de la licencia y sus avisos; emite `license:changed` |
| `licencia_reloj` | 5 min | 5 min | Siempre | — | Cuenta el tiempo sin conexión de la gracia offline con el reloj monótono, sin red (RI-36) |
| `interruptores` | 5 min | 20 s | MainOperativa | — | Pregunta a la nube qué está apagado |
| `avisos` | 10 min | 60 s | MainOperativa | — | Tareas vencidas y reservas próximas |
| `fichajes_colgados` | 1 h | 30 s | MainOperativa | — | Cierra como incidencia, sin hora de salida, las jornadas abiertas que entraron hace más de 16 h. Hasta entonces son la jornada en curso, aunque sean de ayer: un turno de noche ficha la salida al día siguiente |
| `caja_sin_cerrar` | 1 h | 2 min | MainOperativa | — | Avisa si la caja lleva más de 20 h abierta ([caja.md](caja.md)) |
| `stock_negativo` | 10 min | 90 s | MainOperativa | — | Avisa de productos con stock total negativo |
| `zona_horaria` | 10 min | 30 s | MainOperativa | — | Deja en `Business_Settings.Zona_Horaria` la zona del reloj del equipo, deducida de sus desfases con UTC en enero y en julio (la necesita la reserva desde la web). Corto porque el primer intento sólo se adelanta la primera vez: así un cambio de zona llega pronto tras un reinicio. Sólo escribe si cambia |
| `avisos_reserva_web` | 60 s | 45 s | MainOperativa | — | Manda al worker los correos al cliente de las reservas web que el restaurante ha cambiado o cancelado (`_Reservas_Web_Avisos`, [reservas-web.md](../estudios/reservas-web.md#57-avisar-al-cliente-de-un-cambio)). Con la conectividad apagada no manda nada; se descarta el aviso de una reserva que ya ha pasado y el que lleva un día de intentos |
| `reservas_no_vino` | 5 min | 2 min | MainOperativa | — | Marca `NO_SHOW` las reservas a las que no ha llegado nadie cuando pasan los minutos de `Business_Settings.Reserva_No_Vino_Min` desde su hora (Configuración → Reservas); con 0, nunca. Por tandas de 200, y una sentencia por reserva, sin condición. Avisa a la pantalla con `sync:cambio` |
| `imagenes` | 15 min | 3 min | Siempre | — | Red de seguridad de la subida de imágenes a R2 (el camino normal es el evento) |
| `purga_sync` | 24 h | 5 min | MainOperativa | — | Poda `_Sync_Applied_Ops` (TTL 72 h) |
| `reconciliacion` | 24 h | 10 min | MainOperativa | — | Comprueba el stock por lote y el stock suelto de cada producto contra sus movimientos y consumos, y el gasto por cliente contra sus cobros, y avisa; se calla con el histórico a medias |
| `backup_local` | 24 h | 5 min | MainOperativa | — | Copia diaria y purga de restos ([recuperacion.md](recuperacion.md)) |
| `backfill_historico` | 5 min | 3 min | MainOperativa | `backfill_historico` | Fase 2 de la recuperación |
| `verificar_nube` | 24 h | 10 min | MainOperativa | (`reparacion_nube` dentro) | Contraste con la nube y reparación ([sincronizacion.md](sincronizacion.md#reparar-una-divergencia-sync-22-sync-24-sync-25)); no corre con el histórico a medias |
| `cifrado_pii` | 6 h | 60 s | MainOperativa | `cifrado_pii` | Cifra la PII del personal que siga en claro |
| `updater` (sólo escritorio) | 6 h | 30 s | Siempre | — | Comprueba el feed de actualizaciones y avisa |

### Qué no va aquí

- El ciclo de vida del WebSocket (latido, subida del outbox, reconexión): es una máquina de estados de
  la conexión y vive en `socketMain.ts`.
- El ciclo de vida de una pantalla (refresco de un panel abierto, cuentas atrás).
- La telemetría: tiene su hilo y su cola propios ([observabilidad.md](observabilidad.md)).

---

## Interruptores remotos de emergencia (PROD-06)

Si una tarea automática se pone a hacer daño en los equipos de los clientes, se apaga desde la nube con
una fila en la tabla `interruptores` de la base central, en unos minutos y sin publicar versión.

```bash
pnpm interruptor:apagar   -- --nombre reparacion_nube --horas 2 --motivo "…" [--tenant <id>] [--desde 1.4.0] [--hasta 1.4.2]
pnpm interruptor:encender -- --id <interruptorId>
pnpm interruptor:lista    -- [--historial]
```

| Pieza | Archivo | Rol |
|---|---|---|
| La lista cerrada | `crates/tpv-contracts/src/interruptores.rs` | `Interruptor`, exportado a TS; el worker lo espeja con drift-guard |
| En la base central | tabla `interruptores` | Una fila por apagado: global (`'*'`) o de un tenant, con rango de versiones opcional |
| Lectura en el worker | `apps/cloud-worker-licensing/src/lib/interruptores.ts` | Filtra, reduce y cachea 60 s por isolate |
| Administración | `domains/admin/admin.routes.ts` (`/v1/admin/interruptores`) + `scripts/tpv-license.mjs` | Apagar, encender, listar; todo queda en `admin_audit` |
| Lo que pregunta el TPV | `domains/interruptores/interruptores.routes.ts` (`POST /v1/interruptores`) | Por `tenantAuth`; el tenant sale del token |
| Decisión en el TPV | `tpv-application/src/use_cases/interruptores.rs` | Qué vale y cuánto (aquí están los tests) |
| Estado en el TPV | `src-tauri/src/interruptores.rs` + job `interruptores` | En memoria y en `AppData/interruptores.json` |
| Pantalla | `features/configuracion/sections/AvisoInterruptores.tsx` | «Pausado por soporte» en Conectividad |

| Interruptor | Dónde se mira | Qué deja de pasar |
|---|---|---|
| `reparacion_nube` | `verificar_nube` | Encolar reparaciones y borrados; se sigue comparando e informando |
| `volcado_atraso` | `socketMain.ts::subirLoPendiente` | El volcado a la cola del DO: se sube por el camino en vivo |
| `cola_do` | `tenantHub.cola.ts::drenarCola` (worker) | Drenar la cola de entrada; se vuelve a mirar cada 5 min |
| `backfill_historico` | motor de jobs | Bajar el histórico tras una recuperación |
| `cifrado_pii` | motor de jobs | Convertir la PII del personal a cifrado |
| `imagenes` | `lib.rs::drenar_imagenes` | Subir imágenes a R2 |
| `reservas_web` | `domains/reservas_web/puerta.ts` (worker) | Las rutas públicas de la reserva desde la web: el widget dice que ahora no se puede reservar online. Lo ya reservado sigue en la agenda |

### Reglas

- **Para entrar en la lista, las tres cosas a la vez**: es **automática**; puede dañar **a muchos a la
  vez o fuera del equipo** (escribe en la nube o cuesta dinero); y **pausarla no pierde
  nada** (lo pendiente espera en su cola). Quedan fuera lo que protege (copias, licencia), el outbox y
  el WebSocket en vivo (apagarlos congela todas las Handy; para un solo equipo está
  `connectivity: "off"`).
- ⚠️ **Nada del cobro, nunca**: ni cobrar, ni emitir el registro fiscal, ni imprimir, ni el cajón. Lo
  vigila `tests_exenciones_del_gate::ningun_interruptor_toca_el_camino_del_cobro`, que lee el fuente.
- **Si no se sabe, está encendido.** El worker devuelve lista vacía si la base central no contesta; el
  TPV olvida lo que dijo la nube a la **hora** sin poder confirmarlo (`VIGENCIA_CONSULTA_MS`), y un
  fichero roto o ausente es todo encendido.
- **Todo apagado caduca**: `expires_at_ms` es obligatorio, con un tope de 7 días.
  Encender adelanta la caducidad a ahora sin borrar la fila.
- **La tabla no lleva `CHECK` sobre el nombre**: lo valida el zod del worker, y un nombre que un binario
  viejo no conoce se salta al leer la respuesta.
- **Para añadir uno**: la variante en `Interruptor`, el nombre en `INTERRUPTORES` (`lib/interruptores.ts`,
  que no compila hasta coincidir), su etiqueta en `AvisoInterruptores.tsx` (tampoco compila sin ella) y
  el sitio donde se mira. Y que cumpla las tres condiciones.
- **Apagar tarda unos 5 minutos** en llegar a todos (el TPV pregunta cada 5 min y el worker cachea 60 s).
