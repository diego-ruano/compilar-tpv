# Documentación

## Qué va en cada sitio

| Qué | Dónde |
|---|---|
| Por qué una línea de código es así | Un comentario junto a ella (con el ID del hallazgo si lo hay) y, si es una regla, un test que la vigile |
| Qué cambió y por qué | El mensaje del commit |
| Cómo funciona un subsistema y sus reglas | [arquitectura/](arquitectura/) |
| Una decisión que cruza varias partes | [decisiones/](decisiones/) (ADR) |
| Cómo hacer una operación | [guias/](guias/) |
| Un estudio o un plan sin ejecutar | [estudios/](estudios/) |
| Lo pendiente | [pendientes.md](pendientes.md), un solo fichero |
| Las reglas para trabajar en el código | [CLAUDE.md](../CLAUDE.md) |
| Qué es el proyecto y cómo arrancarlo | [README.md](../README.md) |
| Los arneses de contrato y los E2E | junto a su código: [tests/contract/](../tests/contract/README.md), [apps/tpv-main/e2e/](../apps/tpv-main/e2e/README.md) |

Tres reglas:

- **Se describe lo que hay.** Cómo se llegó, va en el commit; un plan que se ejecuta se convierte en
  documento de arquitectura y el plan desaparece.
- **Cada dato en un sitio.** Si algo se explica en un documento, los demás enlazan.
- **Lo que se puede comprobar con un script o un test no se escribe a mano** (recuentos, listas de
  comandos): se dice qué script lo dice.

## Arquitectura

- [sincronizacion.md](arquitectura/sincronizacion.md): outbox, WebSocket, `TenantHub`, los lotes de la Main,
  el contraste con la nube y la reparación.
- [recuperacion.md](arquitectura/recuperacion.md): volver de perder la base local; copias; traslado.
- [esquema.md](arquitectura/esquema.md): el esquema único y las migraciones.
- [verifactu.md](arquitectura/verifactu.md): el registro de facturación (esta rama no remite a la AEAT).
- [caja.md](arquitectura/caja.md): cobros, gastos, cierre de caja y anulación.
- [tickets.md](arquitectura/tickets.md): el ticket ESC/POS y su vista previa.
- [licencias.md](arquitectura/licencias.md): licencias, Stripe y administración.
- [emparejamiento.md](arquitectura/emparejamiento.md): vincular una Handy y su token.
- [permisos.md](arquitectura/permisos.md): sesión, gates, PIN y superficie de seguridad.
- [worker.md](arquitectura/worker.md): el worker `tpv-api`, la base de cada negocio (el SQLite de su
  `TenantHub`), la base central (Turso) y el cron.
- [jobs-e-interruptores.md](arquitectura/jobs-e-interruptores.md): tareas de fondo e interruptores remotos.
- [frontend.md](arquitectura/frontend.md): estructura, datos, dinero en pantalla y CSP.
- [observabilidad.md](arquitectura/observabilidad.md): Sentry, Axiom y vigilancia externa.

## Decisiones

[decisiones/README.md](decisiones/README.md).

## Guías

- [publicar-version.md](guias/publicar-version.md): sacar y retirar una versión; CI.
- [compilar-android.md](guias/compilar-android.md): el build de la Handy.
- [pruebas-de-carga.md](guias/pruebas-de-carga.md): el generador de carga, en local y contra la nube.
- [restaurar-un-negocio.md](guias/restaurar-un-negocio.md): la base de un negocio en la nube: sus copias y
  devolverla a un instante.

## Estudios

- [compatibilidad-windows-7.md](estudios/compatibilidad-windows-7.md)
- [metricas-produccion.md](estudios/metricas-produccion.md)
- [reservas-web.md](estudios/reservas-web.md): plan de las reservas desde la web (widget, agenda y
  entrega a la Main) y lo que queda de él.

## Análisis

- [Revisión integral del proyecto](analisis/REVISION_INTEGRAL_2026-09-27.md): hallazgos pendientes de la revisión; los resueltos se retiran.

## Datos

- [La estructura de la base central](../apps/cloud-worker-licensing/src/server/central/migraciones/): sus
  migraciones, que aplica su objeto `BaseCentral`; el esquema que dan está fotografiado en
  `apps/cloud-worker-licensing/src/server/central/esquema.snapshot.sql`.
