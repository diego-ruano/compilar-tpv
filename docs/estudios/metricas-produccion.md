# Métricas a vigilar con restaurantes en producción

**Estado:** plan para el piloto; vivo (se rellena con lo que se vaya midiendo)

> Qué medir cuando haya un restaurante real usando el TPV, por qué importa cada cosa y qué hacer si
> se cruza un umbral. **Complementa** a [observabilidad.md](../arquitectura/observabilidad.md), que explica el montaje
> de Sentry y Axiom y las alertas de *incidencia*; esto es lo otro: **capacidad, coste y
> dimensionado**.
>
> ⚠️ **Los precios de este documento son indicativos y de septiembre de 2026.** Verifícalos en la
> fuente antes de tomar una decisión de dinero. Lo que no cambia tan rápido son las **dimensiones**
> por las que se factura, que es lo que hay que instrumentar.

---

## 0. Antes de nada: por qué este documento existe

Hay decisiones de arquitectura tomadas a ojo **por falta de un solo número**: nadie ha contado
cuántas filas al día genera un bar. La ventana de 30 días de la recuperación
([recuperacion.md](../arquitectura/recuperacion.md)), la retención
([DB-14](../pendientes.md#db-14--retención-y-archivado)) y el plan de Turso dependen de él.

La regla al leer esto: no se trata de montar un observatorio. Se trata de salir del piloto con una
docena de números que hoy no tenemos.

---

## 1. Con qué se mide

| Fuente | Qué da | Estado |
|---|---|---|
| **Panel Configuración → Conectividad** | `sync_health` (outbox, `last_seq`, cuarentena, fallando) y `jobs_status` | ✅ Ya existe |
| **Axiom** — `AXIOM_DATASET_SYNC` | `apply_error`, `main_online/offline`, `device_auth_rechazado`, `tenant_salud_sync`, `cola_*` | ✅ Ya existe |
| **Better Stack** | Sonda de `/health` y latidos del cron y de la copia de la base central | ✅ Ya existe |
| **Axiom** — `tpv-device-logs` | Logs del escritorio con scrubbing | ✅ Ya existe |
| **Sentry** (`tpv-desktop`, `tpv-api`) | Errores, crashes, crash-free rate | ✅ Ya existe |
| **Cloudflare** → Workers Analytics / GraphQL API | Peticiones, CPU, errores, subpeticiones | ✅ Disponible, sin usar |
| **Cloudflare** → Durable Objects Analytics | Peticiones, duración GB-s, filas SQLite | ✅ Disponible, sin usar |
| **Cloudflare** → R2 metrics | Almacenamiento, operaciones Clase A/B | ✅ Disponible, sin usar |
| **Turso** → panel de uso | Filas leídas/escritas, almacenamiento, bases activas | ✅ Disponible, sin usar |
| **SQL directo contra el tenant** | Filas por tabla, crecimiento diario | ⚠️ A mano (§2) |
| **Tamaño de `data.db` y de las copias** | Crecimiento en disco del equipo | ⚠️ No instrumentado |

**Lo único que hay que instrumentar de cero** es §2. Todo lo demás ya está o se consulta en un panel.

---

## 2. Crecimiento de datos — el bloque que desbloquea decisiones

**El más importante y el que nadie ha medido.** De aquí salen el afinado de la ventana de
recuperación (SYNC-19: hoy 30 días elegidos a ojo, y si el volumen resulta pequeño se puede subir —o
bajarlo todo de una vez y quitar la fase 2 entera), DB-14 (retención) y el dimensionado del plan de
Turso.

### 2.1 Fotografía semanal por tabla

Contra la BD del tenant, una vez por semana durante el piloto:

```sql
SELECT 'Comandas', COUNT(*) FROM Comandas
UNION ALL SELECT 'Detalle_Comanda', COUNT(*) FROM Detalle_Comanda
UNION ALL SELECT 'Pagos', COUNT(*) FROM Pagos
UNION ALL SELECT 'Pago_Detalles', COUNT(*) FROM Pago_Detalles
UNION ALL SELECT 'Lote_Consumos', COUNT(*) FROM Lote_Consumos
UNION ALL SELECT 'Suelto_Consumos', COUNT(*) FROM Suelto_Consumos
UNION ALL SELECT 'Movimientos_Stock', COUNT(*) FROM Movimientos_Stock
UNION ALL SELECT 'Sync_Changes', COUNT(*) FROM Sync_Changes
UNION ALL SELECT 'Applied_Operations', COUNT(*) FROM Applied_Operations
UNION ALL SELECT 'Notificaciones', COUNT(*) FROM Notificaciones
UNION ALL SELECT 'Fichajes', COUNT(*) FROM Fichajes
ORDER BY 2 DESC;
```

### 2.2 Filas por día, que es el número que hace falta

```sql
SELECT date(Fecha_Hora) AS dia, COUNT(*) AS pagos
FROM Pagos GROUP BY 1 ORDER BY 1 DESC LIMIT 30;

SELECT date(c.Fecha_Hora_Apertura) AS dia,
       COUNT(DISTINCT c.ID_Comanda) AS comandas,
       COUNT(d.ID_Detalle) AS lineas,
       ROUND(COUNT(d.ID_Detalle) * 1.0 / COUNT(DISTINCT c.ID_Comanda), 1) AS lineas_por_comanda
FROM Comandas c LEFT JOIN Detalle_Comanda d ON d.ID_Comanda = c.ID_Comanda
GROUP BY 1 ORDER BY 1 DESC LIMIT 30;
```

**Lo que hay que saber salir sabiendo:**

| Número | Para qué decide |
|---|---|
| Filas/día **totales** sumando todas las tablas de negocio | Cuánto histórico cabe en la ventana de recuperación → SYNC-19 |
| Líneas por comanda (media y P95) | Multiplicador para estimar cualquier volumen |
| Tickets/día en día flojo, día normal y fin de semana | El pico, que es lo que dimensiona |
| Crecimiento de `data.db` en MB/mes | Espacio en disco y tamaño de las 7 copias diarias |
| Filas de `Sync_Changes` en estado estacionario | Comprueba que la purga de 7 días funciona |

> **Ojo con la estacionalidad.** Un bar en agosto y el mismo bar en febrero no se parecen. Un mes de
> piloto da una foto, no una media anual: al extrapolar, usa el **pico**, no el promedio.

### 2.3 Tamaño real del volcado

Lo que decide si la fase 1 de la recuperación ([recuperacion.md](../arquitectura/recuperacion.md)) cabe holgada:

```bash
curl -X POST https://tpv-api.altarialights.workers.dev/v1/sync/bootstrap \
  -H "Authorization: Bearer <jwt>" ... | wc -c
```

Contra los **128 MB** de un isolate de Workers. Anota también cuánto tarda.

---

## 3. Cloudflare

### 3.1 Workers

| Métrica | Por qué | Umbral / acción |
|---|---|---|
| Peticiones/día por tenant | Base del coste y de la extrapolación a N clientes | — |
| **CPU time p99** | Hoy el límite es el **por defecto: 30 s**. `wrangler.json` no tiene bloque `limits` | Si algo se acerca a 30 s → subir `limits.cpu_ms` (máx. 300.000) |
| Tasa de error 5xx | Salud | >0,1 % sostenido → investigar |
| Subpeticiones por invocación | Tope 10.000 en plan de pago | Lejos hoy: el volcado lee sus tablas en un `batch` |

### 3.2 Durable Objects — **donde están las sorpresas de coste**

El TenantHub es SQLite-backed (`new_sqlite_classes`), así que factura por dimensiones que no son
obvias:

| Dimensión | Precio indicativo | Qué vigilar aquí |
|---|---|---|
| Peticiones | ~$0,15 / millón | Cada mensaje que **despierta** al DO |
| Duración | ~$12,50 / millón GB-s | **La métrica que valida SYNC-16** |
| **Filas escritas** | **~$1,00 / millón** | `_Cola_Entrada` (SYNC-18). Mil veces más caro que leer |
| Filas leídas | ~$0,001 / millón | Prácticamente gratis |
| Almacenamiento | ~$0,20 / GB-mes | La cola debería vaciarse; si crece, algo no drena |

Tres cosas concretas que comprobar:

1. **¿Hiberna de verdad?** Toda la complejidad de SYNC-16 (nada de estado en campos de instancia,
   attachments en los sockets, auto-response del latido) existe para no facturar duración mientras
   los sockets están ociosos. **Con un bar real y un TPV encendido 14 h al día, la métrica de
   duración lo dice.** Si se parece a "el DO ha estado despierto todo el servicio", la hibernación no
   está funcionando y hay que averiguar qué lo despierta.
2. **Asimetría escribir/leer.** Escribir cuesta 1.000× lo que leer. Cualquier índice nuevo en la
   SQLite del DO añade una fila escrita por cada inserción. Antes de añadir un índice ahí, mirar esto.
3. **Peticiones al DO por servicio.** Sale de dividir entre las operaciones del día; dice cuánto
   cuesta *de verdad* un bar al mes.

### 3.3 R2

| Métrica | Por qué |
|---|---|
| Almacenamiento (`tpv-images`, `tpv-releases`, `tpv-copias-control`) | Las imágenes crecen con el catálogo; las copias de la base central se borran a los 35 días |
| Operaciones Clase A (escrituras) | Subidas de imágenes |
| Operaciones Clase B (lecturas) | Cada imagen que carga una Handy |
| **Peticiones a `pub-*.r2.dev`** | [INFRA-03](../pendientes.md#infra-03--imágenes-por-r2dev): esas URLs están limitadas y no son para producción. Si el volumen sube, es el empujón para el dominio propio |

R2 **no cobra egreso**, que es justo lo que hace viable servir imágenes desde ahí.

---

## 4. Turso

**El recurso escaso no es el almacenamiento: son las filas escritas.**

| Métrica | Plan Free | Developer (~$5) | Scaler (~$25) |
|---|---|---|---|
| Filas escritas/mes | 10 M | 25 M | 100 M |
| Filas leídas/mes | 500 M | 2.500 M | 100.000 M |
| Almacenamiento | 5 GB | 9 GB | 24 GB |
| Bases activas/mes | 100 | 500 | 2.500 |

**Qué medir, y por qué es más de lo que parece:** una operación del TPV **no** es una fila escrita.
Es la fila de negocio, más su entrada en `Sync_Changes`, más la de `Applied_Operations`, más lo que
toquen los índices. **Calcula el multiplicador real** dividiendo las filas escritas que reporta Turso
entre las operaciones del outbox de ese periodo. Ese factor es el que permite responder *"¿cuántos
restaurantes caben en el plan X?"*.

Vigilar también:

- **Bases activas por mes**: con una base por tenant, este número *es* tu número de clientes. Marca
  el salto de plan antes que ninguna otra métrica.
- **Almacenamiento por tenant**: el input de DB-14.
- **Latencia p95 de consulta desde el worker**: la región es `aws-eu-central-1` (Frankfurt); si la Handy va lenta,
  aquí se ve si es la BD o el camino.

---

## 5. Sentry y Axiom

| Métrica | Umbral / acción |
|---|---|
| **Crash-free sessions** (`tpv-desktop`) | Es *la* métrica de calidad percibida. Cualquier caída es prioridad sobre features |
| Eventos/mes vs. cuota | Un bucle de errores puede agotar la cuota en horas. **Spike Protection activado** |
| Volumen de ingesta en Axiom (GB/mes) | Se factura por ahí. Si se dispara, revisar qué se está emitiendo por operación |
| Ratio `apply_error` / operaciones | Salud del sync. Debería ser ~0 |
| `device_auth_rechazado` agrupado por `motivo` | Rachas = un TPV que no puede trabajar contra la nube |
| Retención configurada en Axiom | No hay knob en código; se configura en su UI |

> Recordatorio de [observabilidad.md](../arquitectura/observabilidad.md): los apply con éxito **no** se emiten a
> propósito. Si alguien "arregla" eso para tener más visibilidad, el coste de Axiom se
> multiplica por el número de operaciones. No lo hagas sin medir antes.

---

## 6. Salud operativa del TPV

Esto no cuesta dinero, pero dice si el producto aguanta un servicio real.

| Métrica | Dónde | Qué significa un valor malo |
|---|---|---|
| **Profundidad del outbox** en hora punta | `sync_health` | Si crece durante el servicio y no baja, el drenado no sigue el ritmo |
| **Operaciones en cuarentena** | `sync_health` | Debería ser **0**. Cualquier valor >0 es un dato que no llegó a la nube |
| Operaciones "fallando" | `sync_health` | Reintentos en curso; si persiste, hay una divergencia Main↔worker |
| Jobs con fallo o vencidos | `jobs_status` | Un job muerto no avisa solo |
| Reconexiones de WS por servicio | Axiom (no hay evento propio: se deduce de `main_online`/`main_offline`) | Muchas = red del bar inestable → afecta a la Handy |
| Tiempo del volcado del atraso | Axiom: `cola_volcado_inicio` / `cola_volcado_fin` (por su `_time`; no llevan duración) | Cuánto tarda un TPV en ponerse al día tras un corte |
| **Fallos de impresión** | Logs | Un cobro que no imprime es una reclamación |
| Tiempo de arranque de la app | Logs | Un TPV que tarda en abrir molesta cada mañana |
| Copias diarias correctas y su tamaño | `recovery_list_backups` (Configuración → Licencia) y el job `backup_local` en `jobs_status` | Si fallan, el plan B no existe |

---

## 7. Negocio (para dimensionar, no para vender)

Tickets/día, líneas por ticket, hora punta (para saber si el pico es 3× o 10× la media), número de
dispositivos por local, y **horas al día con la app abierta** — que es lo que multiplica la duración
del DO y las reconexiones.

---

## 8. Calendario

**Día 1 (instalación)**
- Anotar el estado inicial: filas por tabla, tamaño de `data.db`, versión instalada.
- Confirmar que Sentry y Axiom reciben eventos de ese equipo.
- Comprobar que la primera copia diaria se crea.

**Semana 1 — a diario**
- `sync_health`: outbox, cuarentena, fallando.
- Errores nuevos en Sentry.
- Filas por tabla (§2.1) al final del día.

**Semana 1 — una vez**
- Tamaño y duración del bootstrap (§2.3).
- **Ensayo de recuperación real**: borrar `data.db` en un equipo de pruebas con datos del bar y
  cronometrar la vuelta. Es la única forma de saber si el plan de recuperación funciona *antes* de
  necesitarlo.

**Mes 1**
- Filas/día estabilizadas → cuántos días de histórico caben de golpe (**afina la ventana de SYNC-19**).
- Coste real en Cloudflare y Turso desglosado → extrapolación a 10 y 50 clientes.
- Multiplicador de filas escritas por operación (§4).
- ¿Hiberna el DO? (§3.2).
- Crecimiento de `data.db` en MB/mes (**decide DB-14**).

**Trimestre**
- Repetir con estacionalidad distinta.
- Revisar planes contratados contra el uso real.
- Recalcular si la ventana de recuperación sigue siendo la adecuada.

---

## 9. Dónde se apunta lo medido

Una tabla al final de este mismo fichero, con fecha. Sin eso, dentro de tres meses habrá que volver a
medirlo todo.

| Fecha | Métrica | Valor | Notas |
|---|---|---|---|
| | | | |

---

## 10. Decisiones que esperan a estos números

| Necesita | Para decidir |
|---|---|
| Filas/día totales | Afinar la ventana de la recuperación (SYNC-19, hoy 30 días en `bootstrap.ventana.ts`): subirla si sale barato, o bajarlo todo de una vez y quitar la fase 2 |
| Crecimiento de `data.db` | DB-14: si hace falta retención y con qué corte |
| Multiplicador de filas escritas | Plan de Turso y precio por cliente |
| Duración del DO | Si SYNC-16 cumple su función o hay que perseguir lo que lo despierta |
| Peticiones a `r2.dev` | Cuánta urgencia tiene INFRA-03 |
| Crash-free rate | Si el producto está listo para un segundo cliente |
