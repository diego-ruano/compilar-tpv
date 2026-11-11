# Decisiones de arquitectura (ADR)

Un registro por decisión que cruza varias partes del sistema y que alguien podría querer deshacer sin
saber por qué se tomó. Las decisiones propias de un subsistema (Veri\*factu, caja, licencias…) viven en su
documento de [arquitectura](../arquitectura/).

| # | Decisión |
|---|---|
| [0001](0001-monorepo-y-arquitectura-hexagonal.md) | Monorepo híbrido y arquitectura hexagonal en Rust |
| [0002](0002-local-first-y-handy-sin-base-local.md) | La Main es Local-First; la Handy no tiene base local |
| [0003](0003-replicacion-por-sentencias-con-escritor-unico.md) | Replicación por sentencias SQL con un escritor único |
| [0004](0004-la-hora-la-pone-quien-escribe.md) | La hora la pone quien escribe |
| [0005](0005-dinero-en-centimos.md) | El dinero es un entero de céntimos |
| [0006](0006-un-solo-worker.md) | Un solo worker para toda la nube |
| [0007](0007-la-reserva-web-no-escribe-en-la-base-del-negocio.md) | La reserva web no escribe en la base del negocio |
| [0008](0008-la-base-del-negocio-en-su-durable-object.md) | La base de cada negocio vive en su Durable Object |

## Cómo se escribe uno

Fichero `NNNN-titulo-corto.md`, con:

- **Estado**: vigente, o sustituida por `NNNN`.
- **Contexto**: el problema y las fuerzas en juego, tal como son hoy.
- **Decisión**: qué se hace.
- **Consecuencias**: lo que se gana, lo que cuesta y las reglas que impone.

Una decisión vigente no se reescribe: si cambia, se escribe otra que la sustituye y la anterior pasa a
«sustituida». Lo que cuenta cómo se llegó a un arreglo concreto va en el mensaje del commit.
