# 0006 · Un solo worker para toda la nube

**Estado:** vigente. La base de cada tenant ya no está en Turso: ver [0008](0008-la-base-del-negocio-en-su-durable-object.md).

## Contexto

La nube tiene que servir los datos de la Handy, coordinar la replicación (Durable Object), emparejar
dispositivos, emitir y validar licencias, cobrar por Stripe y publicar actualizaciones. Repartirlo en
varios workers obligaría a que se llamaran entre sí por HTTP, a duplicar la resolución de credenciales de
cada tenant y a mantener la autenticación de los dispositivos en dos sitios.

## Decisión

Un único Cloudflare Worker, `tpv-api` (carpeta `apps/cloud-worker-licensing/`), con un enrutador Hono y un
subenrutador por dominio, el Durable Object `TenantHub`, una base central (control-plane) y una base Turso
por tenant ([worker.md](../arquitectura/worker.md)). El cliente Rust apunta a él con una sola constante,
`CLOUD_API_BASE`.

## Consecuencias

- Un despliegue y un juego de secretos. La autenticación (`tenantAuth`), la comprobación de licencia y la
  resolución de credenciales de Turso son una sola pieza para todo.
- Un fallo del worker afecta a todo a la vez: por eso hay vigilancia externa de `/health`
  ([observabilidad.md](../arquitectura/observabilidad.md)).
- No hay entorno de staging ([INFRA-01](../pendientes.md#infra-01--entorno-de-staging)).
