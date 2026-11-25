# Restaurar la base central

La base central (licencias, negocios, dispositivos, cobros de Stripe, emparejamientos…) es el SQLite
de su objeto `BaseCentral` ([0009](../decisiones/0009-la-base-central-en-su-durable-object.md)). Por
ella pasan todos los negocios: mientras no atiende, las Handy no trabajan y ninguna Main puede abrir
su socket, activar, emparejar ni renovar su token (sigue cobrando y, con el socket ya abierto,
replicando). Hay dos formas de volver atrás:

| | Qué cubre | Cuánto atrás | Cómo |
|---|---|---|---|
| **Volver a un instante** (de Cloudflare) | Una central con datos malos (un borrado por error, un fallo del programa que escribió mal), o que una vuelta ha dejado sin atender, y el objeto vivo | Cualquier instante de los últimos 30 días | `pnpm central:volver` |
| **Restaurar una copia de R2** | El objeto perdido o vacío: sin aprovisionar | Las copias que guarde el bucket | `pnpm central:aprovisionar -- --copia` |

Las órdenes `pnpm central:*` son del CLI de administración (`scripts/tpv-license.mjs`), desde la
raíz del repo, con `ADMIN_API_TOKEN` en el entorno o en el `.env`; `TPV_API_BASE` lo apunta a otro
worker (a `wrangler dev`, por ejemplo). **Lo que cambia la central pide `--si`**: sin él, la orden
dice qué haría y no hace nada. Las de `wrangler`, para R2, van desde `apps/cloud-worker-licensing/`.

Lo que hace cada cosa por dentro:
[worker.md](../arquitectura/worker.md#las-copias-de-la-base-central-restaurarla-y-volver-a-un-instante).

## Antes de nada: cómo está

```bash
pnpm central:estado
```

Dice si está aprovisionada, si tiene algo a medias (una restauración que no terminó, una vuelta
preparándose, o preparada y sin aplicar), su avería si la tiene (una migración que ha cambiado o que
no entra), sus migraciones, lo que ocupa y las filas de cada tabla. Sólo lee, y contesta también con
la central sin aprovisionar. Si la central no atiende, el porqué está aquí; y en Axiom, cada petición
que no ha atendido deja un `central_no_disponible` con su `motivo`.

## Las copias

```bash
pnpm central:copias    # las que hay en R2, de la más reciente a la más vieja
pnpm central:copiar    # una ahora, con la hora en la clave: no pisa la del día
```

- Están en el bucket privado `tpv-copias-control`, en `base-central/`: la del día, que hace el cron a
  las 7:00 UTC (`<AAAA-MM-DD>.sql.gz`), las de a mano (`a-mano-<hora>.sql.gz`) y la que deja cada
  vuelta a un instante (`antes-de-volver-<hora>.sql.gz`). Si la central no atendía y no se podía
  copiar, la vuelta deja sólo su marcador (`antes-de-volver-<hora>.marcador`), que no es una copia.
- `central:copias` dice de cada una sus bytes, sus filas, sus tablas y la última migración con la que
  se hizo: se puede restaurar si este worker sabe poner esas migraciones. De las de antes de volver
  dice además el `marcador` (cómo estaba la central: volver a él deshace aquella vuelta) y `pedida`
  (cuándo se le pidió aquella vuelta a la plataforma; sin hora, no consta que se pidiera).
- Cuánto se guardan lo dice la regla de ciclo de vida del bucket. Desde
  `apps/cloud-worker-licensing/`:

  ```bash
  pnpm exec wrangler r2 bucket lifecycle list tpv-copias-control
  ```

- **Antes de tocar nada, una copia**: `pnpm central:copiar`.

### Abrir una copia en local

Desde `apps/cloud-worker-licensing/`:

```bash
pnpm exec wrangler r2 object get tpv-copias-control/base-central/<nombre>.sql.gz --file central.sql.gz --remote
gunzip -c central.sql.gz | sqlite3 central.db
```

Es una base SQLite como otra cualquiera, con el esquema de la central y sus filas. Para ver qué cambió
entre dos momentos, se abren dos copias y se comparan tabla a tabla.

⚠️ Lleva los datos de los clientes (correos, nombres, direcciones) y las DEK de los negocios, cifradas:
bórrala del equipo al terminar.

## Restaurar desde una copia

Sólo cuando el objeto está **sin aprovisionar** («Aprovisionada NO» en `central:estado`): se ha
perdido o vaciado, o es nuevo. Una central viva con datos malos no se restaura:
[vuelve a un instante](#volver-a-un-instante).

```bash
pnpm central:copias
pnpm central:aprovisionar -- --copia base-central/<nombre>.sql.gz --si
```

- Vacía el objeto, carga la copia entera de una vez, sin atender nada mientras tanto, y le aplica
  las migraciones que le falten. Contesta las filas y las tablas que han entrado y las migraciones.
- **Si la copia no vale** (no existe, está cortada, es de una versión que este worker no sabe poner,
  tiene una línea que no es una fila o una de más de 17 MiB, deja una clave foránea rota…), contesta
  `central_copia_inservible` con el motivo, que no lleva nada de la copia, y el objeto se queda como
  estaba, sin aprovisionar: prueba con otra.
- **Si se corta a mitad** (el objeto se reinicia), se queda con la marca de la restauración a medias y
  no atiende (`central_restauracion_a_medias`). Repite la orden: la siguiente restauración lo vacía y
  empieza de nuevo.
- **Con una vuelta a un instante en curso no se restaura** (`central_vuelta_en_curso`): restaurar
  empieza vaciando el objeto, y la central atendería con una vuelta pedida a la plataforma. Primero se
  aplica o se deja acabar ([abajo](#volver-a-un-instante)).
- Lo que se escribió después de la copia se pierde ([abajo](#lo-que-se-pierde-al-volver-atrás)).

**La central nunca atiende a medio restaurar.** Mientras se restaura, o con una restauración sin
terminar, lo que la toca contesta 503 `hub_unavailable`, que los TPV tratan como la nube sin
contestar. Una central a medio cargar contestaría `license_not_found` a licencias que sí existen, y
cada Main lo tomaría por un rechazo de la suya.

### El esquema vacío

```bash
pnpm central:aprovisionar -- --si
```

Para una central que empieza de cero: un `wrangler dev` nuevo, otro entorno. **Nunca para una
central perdida**: una central vacía no tiene ninguna licencia, y todo TPV que pregunte por la suya
recibe `license_not_found`. Para eso está la copia.

### Si no cabe en 30 s (CENTRAL-RESTAURAR)

La restauración va en una sola llamada al objeto, y el objeto se reinicia si pasa de 30 s: se queda a
medias, y cada intento vuelve a cortarse. Lo que manda son las filas, no lo que ocupa la copia, y el
cron avisa a Sentry (`cron.backup`) en cuanto la copia del día pasa de 150.000, que se restauran con
holgura. **Ese aviso es la señal para partir la carga en varias llamadas antes de necesitarla**
([pendientes.md](../pendientes.md#central-restaurar--la-central-se-restaura-en-una-sola-llamada)):
cuando hace falta restaurar, ya es tarde. Las filas de cada tabla las dice `pnpm central:estado`.

Si se llega sin haberlo hecho, la copia no se puede restaurar tal cual, y el CLI no tiene atajo.
Mientras el objeto esté vivo, volver a un instante no carga filas, y no depende de ese límite.

## Volver a un instante

```bash
pnpm central:volver -- --instante 2026-11-20T10:30:00+01:00 --si
```

- **`--instante`**: una fecha ISO de los últimos 30 días. Cloudflare vuelve a un punto cercano a ese
  instante, no al milisegundo: elige uno con margen antes del daño. O **`--marcador <m>`**, el de una
  vuelta anterior, para deshacerla, copiado tal cual (cifras y letras de la `a` a la `f`, en grupos
  separados por guiones): lo que no tiene esa forma se rechaza sin llegar a la central.
- **Lo que pasa**: la central se cierra (`central_vuelta_en_curso`), deja en R2 una copia de cómo está
  (`antes-de-volver-<hora>.sql.gz`) con el marcador que la deshace, pide la vuelta a la plataforma,
  apunta en R2 que la ha pedido (`antes-de-volver-<hora>.pedida`), se reinicia y vuelve. La orden
  espera a que conteste y dice cómo ha quedado. Mientras dura, lo que toca la central contesta 503.
- **También con la central sin atender** (a medio restaurar, con una migración que falla o alterada, o
  sin esquema), que es como la puede dejar una vuelta: deshacerla, o volver a otro instante, es la
  salida. Así no se copia (la copia de una central así parecería buena y le faltarían filas): queda
  sólo su marcador (`antes-de-volver-<hora>.marcador`), y la copia de antes sale como «ninguna».
- **Una sola a la vez**: si dos se preparan a la vez, sólo sigue una, y la otra contesta
  `central_vuelta_a_la_vez` sin pedir nada a la plataforma.
- **La respuesta trae la copia de antes y la orden que la deshace**:

  ```bash
  pnpm central:volver -- --marcador <deshacer> --si
  ```

  Deshacer es otra vuelta, con su propia copia de antes y su propio marcador. El CLI escribe esa
  orden también cuando la vuelta no ha salido entera. El marcador queda en R2 antes de pedir la vuelta
  (`pnpm central:copias`, columna `marcador`); si aun así se pierde, se deshace volviendo con
  `--instante` a justo antes de la vuelta.

Si no sale a la primera:

- **`central_vuelta_sin_aplicar`**: la vuelta está preparada pero la central no se ha reiniciado, y
  sigue cerrada. **Se aplica con su `deshacer`**, el de esa respuesta o el que da `pnpm central:estado`:

  ```bash
  pnpm central:volver -- --reiniciar <deshacer> --si
  ```

  Sólo reinicia la central si esa vuelta sigue preparada: si ya se ha aplicado, o no llegó a pedirse,
  contesta `central_sin_vuelta_preparada` y no hace nada, así que se puede repetir. **No repitas la
  orden de la vuelta**: si la central se ha reiniciado entretanto, ya ha vuelto, y volvería otra vez
  llevándose lo escrito desde entonces.
- **`central_vuelta_sin_comprobar`**: se ha reiniciado y todavía no contesta. Mira cómo está con
  `pnpm central:estado`.
- **«La central ha vuelto, pero no atiende»** (503, con su código: `central_restauracion_a_medias`,
  `central_migracion_fallida` o `_alterada`, o `central_sin_aprovisionar`): lo que había en ese
  instante no atiende con este worker. Trae el marcador que la deshace y la copia de antes. Se sale
  deshaciendo la vuelta o volviendo a otro instante; a medio restaurar o sin esquema, también
  restaurando una copia. **Sin esquema, nunca el esquema vacío**: atendería sin ninguna licencia.
- **`central_vuelta_rechazada`**: la plataforma no ha aceptado la vuelta (el motivo dice qué ha
  contestado: un marcador que no es de este objeto, uno caducado…). No se ha pedido, la central sigue
  como estaba, y lo que se haya subido a R2 para ella (sin hora en `pedida`) no es de ninguna vuelta:
  no hay nada que deshacer.
- **`central_vuelta_a_la_vez`**: otra vuelta se estaba preparando a la vez, o, al aplicarla, la que
  está en curso es otra. No se ha reiniciado nada: mira cuál es con `pnpm central:estado` antes de
  repetir nada.
- **Sin respuesta** (la red, o la llamada al objeto que no vuelve): no se sabe si la vuelta ha llegado
  a pedirse, y el CLI dice cómo saberlo con `pnpm central:copias`. Sin ninguna `antes-de-volver` de
  justo después de la orden, no se pidió y no hay nada que deshacer. Con hora en `pedida`, se pidió:
  si `pnpm central:estado` no tiene ninguna vuelta en curso, se ha aplicado, y se deshace volviendo a
  su marcador; si la tiene preparada, da la orden que la aplica. Sin hora, no consta que se pidiera
  (casi siempre, no se pidió). No repitas la vuelta sin mirarlo.
- **`central_instante_fuera_de_plazo`**: el instante es del futuro o de hace más de 30 días.
- **`central_vuelta_no_disponible`**: ese despliegue no vuelve a instantes. En local (`wrangler dev`)
  no existe.

## Lo que se pierde al volver atrás

Volver a un instante o restaurar una copia se lleva todo lo que se escribió en la central después:
licencias emitidas, activadas, canjeadas, anuladas o con meses cambiados, cobros de Stripe, equipos
emparejados o dados de baja, interruptores, versiones publicadas, claves y dominios de la reserva web
y la auditoría de la administración. Nada de eso se rehace solo.

- **Un TPV cuya licencia ya no está** recibe `license_not_found` sin firmar. No borra su licencia:
  deja de replicar, sigue vendiendo con la gracia sin conexión y su motivo (`rejection_unverified`),
  avisa a sus administradores y, al acabarse la gracia, se bloquea
  ([licencias.md](../arquitectura/licencias.md#el-gate)). Hay que rehacerle lo perdido antes.
- **Qué hay que rehacer** sale de comparar la copia de antes (`antes-de-volver-<hora>`, o la última
  que haya) con la central de ahora (`pnpm central:copiar`), abiertas en local.

## Una base que no sale de una copia

Lo que restaura una copia carga también una base que viene de otro sitio, escrita en el formato de la
copia ([worker.md](../arquitectura/worker.md#la-copia-diaria)):

- En la cabecera, entre los comentarios del principio, la línea de las migraciones con las que se
  hizo, en orden y separadas por comas: `-- Migraciones: 0001_inicial.sql`. Tienen que ser las de
  este worker o un principio de ellas.
- Una fila por línea, exactamente `INSERT INTO "<tabla>" ("<columna>", …) VALUES (<valor>, …);`: la
  tabla y las columnas entre comillas dobles, separadas por una coma y un espacio, y nada detrás del
  `;`. La tabla, de la central; las columnas, de esa tabla y sin repetir, y un valor por columna,
  escrito como lo escribe la copia (`volcadoSql.ts::literalEnUnaLinea`): `NULL`, un número (`-3`,
  `12.5`, `1e+21`), un texto entre comillas simples con la comilla doblada (`'Ana O''Neil'`), uno con
  saltos de línea como `('a'||char(10)||'b')`, unos bytes en hexadecimal (`X'00ff'`) o un texto en
  hexadecimal (`CAST(X'…' AS TEXT)`). De la copia no se ejecuta nada: el cargador lee cada fila y
  escribe él la sentencia. Una línea que empieza por `INSERT INTO "` y no se lee así hace inservible
  la copia (`copia_no_valida`, con su número, el carácter y un código: `tabla_ajena`,
  `columna_desconocida`, `valor_no_literal`…).
- Ninguna línea de más de 17 MiB (`CARACTERES_POR_LINEA`): la de la fila más grande que admite un
  objeto, de 8 MB, ocupa 16 MiB y poco. Una más larga hace inservible la copia (`copia_no_valida: la
  línea N es demasiado larga`).
- Las líneas que no empiezan por `INSERT INTO "` no se cargan: el esquema lo ponen las migraciones.
  Tampoco un `INSERT` sin comillas en la tabla, como los de `sqlite3 .dump`, que además no llevan las
  columnas: hay que convertirlo.
- Al final, la línea del fin, con las filas que trae: `-- Fin de la copia: <N> filas en <T> tablas`.
  Sin ella, o con otro número, está cortada.

Se comprime, se sube a `base-central/` y se aprovisiona desde ahí, en un objeto sin aprovisionar. El
`<nombre>` es de hasta 100 caracteres de `A-Z`, `a-z`, `0-9`, punto, guion y guion bajo, sin dos puntos
seguidos ni un punto al final (`traspaso-turso-2026-11-25`, por ejemplo): con otro, `central:copias`
la enseña, pero no se restaura.

```bash
gzip -k base.sql
# desde apps/cloud-worker-licensing/
pnpm exec wrangler r2 object put tpv-copias-control/base-central/<nombre>.sql.gz --file base.sql.gz --remote
# desde la raíz
pnpm central:aprovisionar -- --copia base-central/<nombre>.sql.gz --si
```

## Después

- `pnpm central:estado`: aprovisionada, sin avería ni nada a medias, con las filas que esperabas.
- `/health` en 200 (`https://tpv-api.altarialights.workers.dev/health`).
- En Axiom, `central_administrada` deja el rastro de lo que se ha hecho (la acción, el resultado, la
  copia, el marcador para deshacer), y deja de salir `central_no_disponible`.

## Qué significa cada respuesta

Lo que no sale bien contesta su código, una frase con qué pasa y, aparte, el motivo técnico si lo hay
(«Motivo: …»). Los códigos que son «la central no puede atender» los enseña precedidos de «La nube no
ha podido atender ahora»: si la orden cambiaba algo, no se sabe si ha entrado, y se mira con
`pnpm central:estado` antes de repetirla.

| Código | Qué pasa | Qué hacer |
|---|---|---|
| `central_sin_aprovisionar` | La central no tiene esquema | Restaurarla desde una copia; el esquema vacío, sólo si empieza de cero |
| `central_ya_aprovisionada` | Ya tiene esquema, y no se ha tocado: sólo se aprovisiona un objeto vacío | Con datos malos, volver a un instante |
| `central_restauracion_a_medias` | Una restauración no terminó, y no atiende | Volver a restaurar desde una copia (si la dejó así una vuelta, también se sale deshaciéndola) |
| `central_copia_inservible` | Esa copia no se puede restaurar; la central sigue sin aprovisionar | Otra copia (el motivo dice qué le pasa a ésta) |
| `central_copia_fallida` | La copia no ha llegado a R2 (al volver, sin ella o sin su marcador no se pide la vuelta) | El motivo dice por qué (R2, el techo de 32 MiB); repetir |
| `central_vuelta_en_curso`, `central_vuelta_sin_aplicar` | Hay una vuelta en curso: preparándose, o preparada y sin aplicar. No atiende hasta que se aplique | Preparada: `pnpm central:volver -- --reiniciar <deshacer> --si` (la orden entera la da `pnpm central:estado`), nunca la orden de la vuelta otra vez. Preparándose: esperar |
| `central_vuelta_sin_comprobar` | Se ha reiniciado y todavía no contesta | `pnpm central:estado` |
| `central_vuelta_a_la_vez` | Otra vuelta se prepara a la vez, o la que está en curso no es la de ese marcador: ésta no ha pedido ni reiniciado nada | `pnpm central:estado` antes de repetir nada |
| `central_sin_vuelta_preparada` | Con `--reiniciar`: ya no hay ninguna vuelta preparada con ese marcador (se ha aplicado o no llegó a pedirse), y no se ha reiniciado nada | `pnpm central:estado` |
| `central_vuelta_rechazada` | La plataforma no ha aceptado la vuelta: no se ha pedido, y la central sigue como estaba | Nada que deshacer; el motivo dice qué ha contestado |
| `central_instante_fuera_de_plazo` | El instante no es de los últimos 30 días | Otro instante |
| `central_vuelta_no_disponible` | Ese despliegue no vuelve a instantes (en local no existe) | — |
| `central_migracion_alterada` | Una migración ya aplicada ha cambiado, y no atiende | Desplegar la migración tal como se aplicó (su hash es el de su texto, comentarios incluidos) |
| `central_migracion_fallida` | Una migración no ha podido aplicarse, y no atiende | El motivo (en `central:estado` y en Sentry, `central.migracion`) dice cuál; se arregla con un despliegue |
