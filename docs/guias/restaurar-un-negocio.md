# Restaurar la base de un negocio en la nube

La base de cada negocio vive en el SQLite de su `TenantHub`
([0008](../decisiones/0008-la-base-del-negocio-en-su-durable-object.md)). Hay dos formas de volver
atrás, y las dos son de administración (`ADMIN_API_TOKEN`, con el CLI de `scripts/tpv-license.mjs`):

| | Qué cubre | Cuánto atrás | Cómo |
|---|---|---|---|
| **Vuelta a un instante** (PITR de Cloudflare) | Una base estropeada (un borrado por error, un fallo del programa que escribió mal) con el objeto vivo | Cualquier instante de los últimos 30 días | `pnpm negocio:instante` |
| **Copia diaria en R2** | El objeto perdido: otro espacio de nombres, un `borrarTodo`, el proveedor | Las 30 últimas madrugadas | `pnpm negocio:restaurar-copia` |

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
    Main lo viera. La Main sigue con su base, se pone al día, sube lo que tenga pendiente y después
    **sube su base entera** ([la subida completa](#la-subida-completa-de-la-main-do-subida)).
- **`--motivo`**: queda en `admin_audit` con todo lo demás.

Lo que pasa: se echa a la Main y a las Handy (reconectan solas), la base se cierra
(`tenant_db_restaurando`, que la Main trata como pasajero), el objeto se reinicia y vuelve, y el log de
la réplica se abre por encima de todo lo que la nube había numerado. La respuesta trae el
**marcador para deshacerlo**:

```bash
pnpm negocio:instante -- --tenant <tenantId> --marcador <deshacer> --modo <el mismo> --motivo "deshacer …"
```

Si contesta `vuelta_sin_aplicar`, el objeto no se ha reiniciado todavía y su base sigue cerrada:
repite la misma orden. Lo mismo con `log_sin_reservar`: la base central no ha contestado al apuntar
desde dónde se abre el log, y sin eso no se abre. Si contesta `vuelta_no_disponible`, ese despliegue no tiene vuelta a un
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
esquema y los ponen las migraciones. Hasta dónde había numerado el log sí va, en los metadatos del
objeto (`seq`), para abrir por encima el de una base devuelta.

## Un negocio que ha perdido su base (DO-PERDIDA)

Un negocio que ya nació (alguna licencia suya se activó) y cuyo objeto está vacío recibe
`tenant_db_perdida` en cada petición, y ni la activación ni la Main le crean una base vacía en su
lugar: puede que su base esté en otro objeto (el despliegue apunta a otro espacio de nombres o a otra
jurisdicción), y entonces lo que hay que arreglar es el despliegue. `negocio:estado` dice si nació y
si su objeto tiene base. Si de verdad se ha perdido, hay dos salidas, y las dos sólo funcionan con un
negocio nacido y su objeto vacío (con base contestan `tenant_db_already_provisioned`: una base no se
pisa).

**Devolverle su copia**, la más reciente o la de un día:

```bash
pnpm negocio:restaurar-copia -- --tenant <tenantId> [--dia AAAA-MM-DD] --modo main --motivo "…"
```

Mientras se carga, la base no atiende (`tenant_db_restaurando`, como en la vuelta a un instante). Si
la copia no vale, el objeto se queda vacío y contesta por qué: `copia_cortada` (le falta el final),
`copia_de_otra_version` (es de un esquema que este worker no sabe poner: un worker anterior a la
copia) o `copia_no_valida` (una línea que no es una fila, una de más de 17 MiB o una clave foránea
rota). El CLI enseña además el motivo, que queda también en Axiom (`copia_no_restaurada`): de una
línea, su número, el carácter y un código (`columna_desconocida`, `tabla_ajena`,
`valor_no_literal`…), o que es demasiado larga. Prueba con la de otro día. Si es una columna o una
tabla que el esquema de hoy no tiene (`columna_desconocida`, `tabla_ajena`) en una copia de antes de
una migración que la quitó o le cambió el nombre, fallarán igual todas las de antes de esa
migración: este worker no las sabe cargar. Y una copia hecha por un worker que aún no escribía en
hexadecimal los textos con más de 40 saltos de línea (`SALTOS_CON_CHAR`) los lleva todos con
`char(10)`, 14 caracteres por salto: si una fila tiene más de 1,27 millones (o es de 8 MB y tiene
más de unos 726.000), es demasiado larga y no se puede restaurar. Las que hace este worker llevan ese
texto en hexadecimal.

**Crearle una base vacía**, con su administrador inicial, como la del alta:

```bash
pnpm negocio:base-vacia -- --tenant <tenantId> --modo main --motivo "…"
```

En las dos, el log de la réplica se abre por encima de lo que la Main pueda haber visto, como tras una
vuelta a un instante. El objeto vacío ya no sabe hasta dónde numeró, así que la ruta lo saca de lo que
sobrevive: el `inicio` de los logs que se le abrieron antes (en `admin_audit`) y el `seq` de sus
copias de R2; la respuesta lo trae como `seqConocido`. Por eso las dos necesitan que contesten la base
central y R2. Desde dónde se abre el log nuevo queda apuntado antes de tocar el objeto
(`negocio_log_reservado`): si la orden contesta 500 después, el log puede estar abierto aunque falte
su rastro, y la siguiente orden lo tiene en cuenta igual. `--modo` dice quién manda después:

- **`main`**: la Main sigue con su base, se pone al día, sube lo que tenga pendiente y después sube su
  base entera ([la subida completa](#la-subida-completa-de-la-main-do-subida)).
- **`nube`**: cada Main aparta su base en `backups/antes-de-la-nube-*` y se trae la nube. Con una copia,
  pierde lo que hizo después de esa madrugada; con una base vacía, todo.

Si una de las dos se corta a mitad (el objeto se reinicia), la base se queda cerrada: repite la misma
orden, que vacía lo que quedó y empieza otra vez.

## La subida completa de la Main (DO-SUBIDA)

Con `--modo main` (una vuelta a un instante, una copia o una base vacía), la nube apunta una petición
de subida completa y se la dice a la Main en su saludo. La Main sube entonces su base entera, por
pasos y sin tocar su outbox: primero lo que está abierto arriba y lo imprescindible para trabajar
(la carta, las mesas, el personal, las comandas abiertas), que es lo único que esperan las Handy;
después lo que falta de los maestros arriba se borra, luego los últimos 30 días y al final el
histórico entero. Con una copia o un instante sólo viaja lo que arriba falta o es distinto. La Main
sigue cobrando con normalidad todo el rato. Su pantalla de Conectividad tiene el progreso
(«Subiendo los datos a la nube»), pero no está en el menú: lo que se ve desde fuera es
`pnpm negocio:estado`.

**Antes de lanzarlo**, mira que la Main tenga una versión con la subida completa: una anterior no
la hace, y la nube se queda como antes (lo que falta lo repara el contraste por tandas). La petición
caduca si la Main no la empieza en 14 días; una vez empezada no caduca, aunque la Main pase días
apagada o la subida esté pausada.

**Cómo va**: `pnpm negocio:estado` enseña `Subida` con su estado (`esperando`, `terminada`,
`caducada`, `agotada` o `huerfana`), la Main que la tiene, las páginas y las filas escritas. Cuando
la Main la entrega, pasa a `terminada`; la Main la da por buena cuando una pasada de su contraste
sale limpia.

- **`agotada`**: la Main ha escrito más de lo que cabe en su techo total (diez veces lo que dijo que
  iba a subir, y como mucho 60 millones de filas escritas contando índices y triggers). Con una base
  vacía y años de histórico de un bar con mucho movimiento es lo esperado (unos dos años de mil
  comandas diarias ya llegan); si no, mira por qué antes de seguir. Para reabrirla:

  ```bash
  pnpm negocio:subida -- --tenant <tenantId> --reabrir --motivo "…"
  ```

  Vuelve a esperar sin dueño, con su plazo y su presupuesto a cero; la primera Main que salude se la
  queda (la que esté conectada se desconecta un momento y la toma al volver a saludar) y, si es la misma, sigue por donde iba sin repetir lo que ya subió. Si en 14 días su Main no manda ningún paso,
  caduca como una recién pedida, aunque antes de reabrirla ya estuviera empezada. Vale también para
  una `caducada` o una `huerfana`.
- **`huerfana`**: ha saludado como Main otro equipo (un traslado de licencia a mitad). **No traslades
  la licencia mientras dura la subida**: la base del equipo nuevo no es la que había que subir.
  Reábrela sólo si el equipo nuevo tiene los datos buenos.
- **Pausarla**: el interruptor remoto `subida_nube` sólo para sus pasos; el cobro, el outbox y las
  Handy siguen igual, y al encenderlo sigue donde iba.
