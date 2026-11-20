# Restaurar la base de un negocio en la nube

La base de cada negocio vive en el SQLite de su `TenantHub`
([0008](../decisiones/0008-la-base-del-negocio-en-su-durable-object.md)). Hay dos formas de volver
atrás, y las dos son de administración (`ADMIN_API_TOKEN`, con el CLI de `scripts/tpv-license.mjs`):

| | Qué cubre | Cuánto atrás | Cómo |
|---|---|---|---|
| **Vuelta a un instante** (PITR de Cloudflare) | Una base estropeada (un borrado por error, un fallo del programa que escribió mal) con el objeto vivo | Cualquier instante de los últimos 30 días | `pnpm negocio:instante` |
| **Copia diaria en R2** | El objeto perdido: otro espacio de nombres, un `borrarTodo`, el proveedor | Las 30 últimas madrugadas | Por ahora, sólo bajarla y mirarla (abajo) |

Lo que hacen por dentro: [worker.md](../arquitectura/worker.md#las-copias-de-la-base-de-cada-negocio-do-03).
Lo que pasa después en la Main: [recuperacion.md](../arquitectura/recuperacion.md#cuando-la-nube-vuelve-atrás-do-03).

## Antes de nada: cómo está

```bash
pnpm negocio:estado -- --tenant <tenantId>
```

Dice si el negocio ha nacido (alguna licencia suya se activó), si su objeto tiene base, si hay una
vuelta preparada sin aplicar, el `Seq` más alto que sabe, cuántas sesiones tiene abiertas, cuándo
toca la próxima copia y las copias que hay en R2. El `tenantId` sale de
`pnpm piloto:lista -- --todos`.

## Volver a un instante

```bash
pnpm negocio:instante -- --tenant <tenantId> --instante 2026-11-20T10:30:00+01:00 --modo nube --motivo "…"
```

- **`--instante`**: una fecha ISO de los últimos 30 días. Cloudflare vuelve a un punto cercano a ese
  instante, no al milisegundo: elige uno con margen antes del daño.
- **`--modo`**, obligatorio, porque la nube vuelve atrás y la Main no:
  - **`nube`**: la nube del instante es la buena. Es el caso de un fallo que también llegó a la Main
    (lo replicó ella misma). Cada Main del negocio verá al conectar que a su base le falta un tramo
    de la nube (SYNC-32), parará y sólo ofrecerá «Recuperar el estado actual de la nube». Lo que
    hizo después del instante se queda en su equipo, en `backups/antes-de-la-nube-*`, **cobros
    incluidos**: no vuelven a la nube solos.
  - **`main`**: la Main es la buena. Es el caso de una nube que se estropeó o se perdió sin que la
    Main lo viera. La Main sigue con su base, se pone al día y sube lo que tenga pendiente; lo que la
    nube perdió y la Main ya había subido lo repara el contraste de la Main en su siguiente momento
    tranquilo (como mucho unas 20 horas, [VERIF-02](../arquitectura/jobs-e-interruptores.md#cuándo-se-contrasta-con-la-nube-verif-02)).
    Hasta entonces las Handy ven la nube del instante.
- **`--motivo`**: queda en `admin_audit` con todo lo demás.

Lo que pasa: se echa a la Main y a las Handy (reconectan solas), la base se cierra
(`tenant_db_restaurando`, que la Main trata como pasajero), el objeto se reinicia y vuelve, y el log de
la réplica se abre por encima de todo lo que la nube había numerado. La respuesta trae el
**marcador para deshacerlo**:

```bash
pnpm negocio:instante -- --tenant <tenantId> --marcador <deshacer> --modo <el mismo> --motivo "deshacer …"
```

Si contesta `vuelta_sin_aplicar`, el objeto no se ha reiniciado todavía y su base sigue cerrada:
repite la misma orden. Si contesta `vuelta_no_disponible`, ese despliegue no tiene vuelta a un
instante (en local, `wrangler dev`, no existe).

## Las copias diarias

Cada `TenantHub` con base se copia a sí mismo una vez al día, de madrugada, al bucket privado
`tpv-copias-negocios`: `negocios/<tenantId>/<AAAA-MM-DD>.sql.gz`, con las 30 últimas. Para hacer la
de hoy ya (antes de tocar nada, por ejemplo):

```bash
pnpm negocio:copiar -- --tenant <tenantId>
```

Una copia es un volcado SQL comprimido de las tablas del negocio. Para mirarla:

```bash
pnpm exec wrangler r2 object get tpv-copias-negocios/negocios/<tenantId>/<día>.sql.gz --file copia.sql.gz --remote
gunzip -c copia.sql.gz | sqlite3 copia.db
```

⚠️ Lleva datos personales (clientes, personal, reservas): bórrala del equipo al terminar.

No trae el log de la réplica, ni el sello del negocio, ni el resumen de las estadísticas, ni los
intentos de PIN: sólo lo que es del negocio. Tampoco las vistas ni los disparadores, que son del
esquema y los ponen las migraciones.

