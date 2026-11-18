# Frontend (React)

La interfaz de la Main y de la Handy es la misma aplicación React 19 + TypeScript + Vite
(`apps/tpv-main/src/`), dentro de Tauri. Cambia de dónde lee: la Main invoca comandos Tauri contra su
SQLite; la Handy pasa por los mismos comandos, que en ella van por HTTP al worker
(`crates/tpv-infra-http`).

```
src/
├── app/        main.tsx, App.tsx, AppBoot.tsx, Router.tsx, arranque/ (pantallas previas al router),
│               layouts/, layoutComponent/, pages/
├── features/   un directorio por dominio: mesas, ventaRapida, cuentas, inventario,
│               clientes, reservas, proveedores, tareas, trabajadores, configuracion,
│               estadisticas, login, notificaciones
├── shared/     lib/ (dinero, efectivo, sockets, permisos, queryClient…), stores/ (Zustand), ticket/,
│               ui/, observability/, toast.tsx
└── Global.css   importa los tokens de color de `@tpv/estilos`
```

Dos paquetes los comparte con el widget de reservas web (`apps/reservas-web`, ver
[el plan](../estudios/reservas-web.md#7-el-widget)): **`@tpv/estilos`** (`packages/estilos/tokens.css`),
los colores claro y oscuro y su mapeo a utilidades de Tailwind, y **`@tpv/plano`** (`packages/plano`), el
lienzo de Konva de la sala con su encaje (`fitTransform`). El plano sólo dibuja: el color y los textos
de cada mesa los decide quien lo usa (en la sala, `features/mesas/aspectoMesa.ts`). Ninguno de los dos
lleva clases de Tailwind, que sólo escanea dentro de cada app.

## Hablar con el backend

- **Todo pasa por `commands`** de `@tpv/client`, generado con tauri-specta desde las firmas Rust.
  El transporte interno conserva `AppErrorDto` en los rechazos. Los WebSocket de Main y Handy viven
  en Rust; el frontend observa estados y avisos de cambios sin abrir conexiones ni interpretar SQL ([sincronizacion.md](sincronizacion.md)).
- **Los tipos vienen de `@tpv/contracts`**, generados por Specta desde los DTO de
  `crates/tpv-contracts` ([../decisiones/0001-monorepo-y-arquitectura-hexagonal.md](../decisiones/0001-monorepo-y-arquitectura-hexagonal.md)).
- **Un `*Apis.ts` no redeclara tipos ni «normaliza» lo que vuelve**: recibe el `Input` generado y devuelve
  el DTO tal cual, sin tipos propios con el dinero como `number`, sin `pick(row, […])` ni mappers a
  camelCase. Lo que cruza la frontera y no tiene DTO se crea en `tpv-contracts`.
- **El compilador comprueba nombre, argumentos y respuesta.** Los hooks llaman al comando generado;
  los helpers que quedan aportan orquestación, paginación o presentación. ESLint impide importar
  `invoke` en las pantallas. El lector IPC de E2E usa nombres y argumentos de `@tpv/client/metadata`.
  `pnpm generate-types:check` comprueba en CI las firmas exportadas por el ejecutable Tauri real.
- **Los patch de configuración son DTOs específicos.** Ausente significa conservar; el logo admite
  `null` para borrarlo. Se rechazan claves desconocidas y tipos incorrectos tanto en IPC como en la
  Handy. Los stores usan los nombres del DTO; los controles numéricos tienen valores de presentación
  definidos. Cuando serde diferencia lectura y escritura, se usan las variantes generadas
  `_Serialize` para respuestas y `_Deserialize` para entradas.
- **Los errores** se normalizan con `toAppError(e)` y se ramifica con `esError(e, "código")`, nunca por
  el texto. Lo que se enseña es `message`.
- **Registrar y avisar son dos trabajos.** Registrar es para nosotros y lo hace `invocar` con todo
  comando que falla ([observabilidad.md](observabilidad.md#los-fallos-de-comandos)): una pantalla no
  manda a Sentry el fallo de un comando ni lo escribe en consola, que en la versión instalada no ve
  nadie. Lo que falla en la propia pantalla (componer un PDF, un dato que no cuadra) va por
  `captureException`, que no cuenta dos veces lo que ya registró `invocar`. Avisar es para quien
  está delante y es de cada pantalla: el título dice qué ha fallado y el texto, por qué
  (`toast.error("No se pudo guardar el cliente", toAppError(e).message)`), nunca un genérico que
  esconda el motivo. Una carga que falla se avisa: una lista sin cargar no puede parecer vacía.
- **Un `catch` en una pantalla, sólo si hace algo distinto** con el error: dejar el modal abierto,
  ramificar por código, poner el error junto al campo. Si sólo hay que avisar, `conAviso(fn)`
  (`shared/lib/conAviso.ts`); fuera de un componente, `avisarDelFallo(titulo, e)`.
- **`void` marca un «fuego y olvido» a sabiendas.** Si lo que va detrás puede fallar de una forma que el
  usuario deba ver, se usa `conAviso(fn)`, que lo dice en pantalla.

## Datos: TanStack Query y Zustand

Venta rápida y Mesas se importan desde el arranque, con sus componentes de servicio. Las demás
rutas de negocio usan `lazy` del router; configuración inicial y recuperación usan `React.lazy`
también cuando las presenta `App`. Login y la estructura de arranque permanecen disponibles.
Durante una navegación diferida se conserva la pantalla actual y se indica la carga.

- Un `QueryClient` (`shared/lib/queryClient.ts`): `staleTime` de 30 s y sin `refetchOnWindowFocus`,
  porque en la Main el dato sólo cambia por mutaciones de esta aplicación o por lo que avisa Rust con
  `sync:cambio` (lo que llega de una Handy, las reservas web recogidas, un job que escribe). Ese
  evento trae las tablas tocadas y `shared/lib/syncStatements.ts` las traduce a las claves que
  invalidar: una tabla que se enseñe en otra pantalla lleva también su clave, aunque sea a través
  de otra tabla (`reservas` refresca el plano de `mesas`; el nombre de una mesa, Reservas, Clientes,
  Cuentas y las estadísticas; `pagos`, lo que queda por cobrar en el plano). La Handy hace lo mismo
  con `handy:cambio`. Fuera a sabiendas, sólo `comandas` → Cuentas: la mesa y el cliente de un cobro
  se fijan al cobrar, y no se relee Cuentas con cada línea que se añade a una comanda.
- **Toda tabla de negocio tiene su entrada en ese mapa**, aunque sea `[]` (lo fiscal, que no está en
  ninguna caché; los ajustes del ticket y de contacto, que van por sus stores). Una tabla sin entrada hace releerlo todo, y
  en una Handy cada consulta que se relee es un viaje al `TenantHub` del negocio: cada cobro escribe
  en `Movimientos_Caja` y en `Registros_Facturacion`. `test/syncStatements.test.ts` lee
  `packages/database/schema.snapshot.sql` y falla si a una tabla le falta la entrada o si queda la de
  una tabla que ya no existe.
- Lo que depende de la hora y no lo avisa nadie se relee solo: el plano de Mesas, con el plano a la
  vista, cuando la propia lectura dice que cambiará (`proximo_cambio_s` de `mesas_meta_all` y de
  `/v1/mesas/meta`, MESAS-02): la reserva de una mesa sale una hora antes, cambia sus minutos y se va
  al acabar su hueco. La regla la comparten la Main y el worker (`plano_reservas_casos.json`). Sin
  nada que vaya a cambiar solo, cada cuarto de hora como mucho (`RELECTURA_MAXIMA_META_MS`). En la
  Main es una lectura local; en la Handy, una petición al worker.
- **Una clave puede ser una parte de un área**: `mesas.meta` (`["mesas", "meta"]`) es el estado de
  cada mesa sin el dibujo del plano, que sólo lee zonas y mesas. Comandas, líneas, cobros, reservas,
  clientes, productos y los ajustes del negocio invalidan sólo esa parte; zonas y mesas, el plano
  entero (`claveDeConsulta`, y `test/syncStatements.test.ts` comprueba de qué tablas lee el layout).
- **Patrón**: cada feature expone sus hooks en `features/<x>/<x>Queries.ts`, con `useQuery` para lecturas
  (claves prefijadas por la feature, con rangos e ids dentro) y `useMutation` para escrituras, que
  invalidan su clave en `onSuccess`. Referencia: `features/clientes/clientesQueries.ts`.
- Lo usan clientes, inventario, cuentas (también el histórico de cierres de caja), estadísticas,
  reservas, tareas, trabajadores, proveedores y pedidos, notificaciones, el emparejamiento
  (`configuracion/pairingQueries.ts`), el progreso del histórico (`shared/lib/backfillQueries.ts`) y,
  en mesas, sólo el catálogo de salones y la meta de mesas.
- **Fuera a propósito**: la parte transaccional del POS (comanda, cobro y cocina en mesas; toda la venta
  rápida, cuyo arranque mezcla el catálogo con el estado de la comanda), la configuración (se carga una
  vez en stores de Zustand: `useBusinessSettings`, `useTicketSettings`, `useContactSettings`) y el
  login. Lo que no está en React Query escucha `useSyncSignal`, que lleva las comandas y las tablas
  del último cambio replicado: el login relee la lista de usuarios cuando cambian `usuarios`,
  `trabajadores` o `roles`, y el fichaje del seleccionado cuando cambian `fichajes` o
  `fichaje_dia` o un fichaje se rechaza, sin vaciar lo que hay en pantalla (TRA-INC-04). Cuando otro equipo cambia una tabla de ajustes se relee el store de esa tabla, no los tres
  (`shared/lib/recargarAjustes.ts`, en la Main y en la Handy).
- **Un formulario de ajustes con «Guardar» es un borrador sobre lo guardado** (Negocio con su
  correo, y el IVA y el mensaje del ticket; `features/configuracion/borrador.ts`, CFG-INC-01): recuerda
  su base, «sin guardar» es el borrador frente a esa base, lo que cambia otro equipo entra en los
  campos que no se han tocado y, si cambió uno tocado, se avisa junto a él. Al guardar se manda sólo
  lo que difiere de la base: el patch es parcial, y mandarlo todo devolvía a su valor de antes lo que
  otro equipo acababa de cambiar.
- **Unos ajustes que no se han podido leer no se enseñan con sus valores por defecto** (CFG-INC-02):
  el store guarda el `error` y deja `ready` en `false` hasta la primera lectura buena; si falla una
  relectura, se queda con lo último leído y el error. La pantalla dice qué no se ha leído y por qué,
  con «Reintentar», y no deja guardar encima. En la Handy, una respuesta del worker sin la zona
  horaria (un worker anterior a ella) se lee con la del esquema (`tpv-infra-http/src/configuracion.rs`).
- **Una relectura no sustituye lo que hay en pantalla**: nada de condicionar el contenido a
  `isFetching` ni de cambiarlo por un «Cargando…», que en una lectura de milisegundos se ve como un
  parpadeo. Sólo la primera carga (`isPending`) deja el hueco, sin texto; al releer, los datos de
  antes se quedan, como mucho atenuados, hasta que llegan los nuevos
  (`test/react/estadisticasSinCargando.test.tsx`).
- Otros stores (`shared/stores/`): `useAuth`, `useMode`, `useEstadoSync`, `useMainPresence`,
  `useEstadoFiscal`, `useSyncSignal`, `usePairCode`, `useTheme`.

Las escrituras de servicio muestran únicamente respuestas confirmadas. Una cola por comanda
ordena adiciones, retiradas y notas; los cobros tienen una guardia síncrona y feedback de espera.
Main confirma contra SQLite sin esperar a la réplica. Handy confirma contra el Worker.
Las lecturas tardías de una comanda anterior se descartan.

**«Cobrar todo» cobra todo lo que queda**, no lo que la pantalla veía al pulsar (SYN-INC-05). Mientras
se elige el método, la réplica puede traer una línea que otro equipo ha añadido: con «Cobrar todo»
pulsado y sin cobrar, cada recarga del ticket vuelve a seleccionar todo lo pendiente y avisa con el
total nuevo (`shared/lib/cobrarTodo.ts`, en la barra y en la mesa). Elegir una línea a mano, cancelar
o cambiar de ticket lo deja en un cobro normal. El cobro va con `todo: true`, y el backend lo rechaza
(`Conflict`, «Han añadido algo a la cuenta mientras cobrabas…») si a la comanda le queda algo en
`v_lineas_por_cobrar` fuera de la lista, con la escritura tomada y antes de apuntar nada
(`consultas::exigir_que_se_cobre_todo`). El fraccionado no cambia. Cobrar es sólo de la Main: el
worker no lee `todo`.

Abrir una mesa es un paso (`mesas_abrir_o_retomar`, `POST /v1/mesas/comandas/abrir-o-retomar`): la
comanda abierta, creada si no hay ninguna y con el trabajador de la sesión si le faltaba, y sus
líneas. En la Handy eran cuatro viajes seguidos con la mesa en blanco. Poner el trabajador a una
comanda que ya lo tiene, o que ya tiene líneas, no escribe nada en ningún lado: la sentencia no
cambiaría ninguna fila, pero se replicaría igual (su operación, su cambio en el log, el aviso a los
demás equipos y lo que releen).

La recuperación de venta rápida usa `_Cobros_Pendientes` en SQLite, escrita por `raw()` y ajena al
outbox. El backend fija el operador al preparar; cualquier operador con `servicio.vender` puede
resolver, corregir los datos de factura o descartar una preparación. La confirmación del pago
elimina la preparación en la misma transacción. El `ID_Pago` hace idempotente el reintento.
Descartar una preparación nunca anula un pago. Las colas antiguas de todos los usuarios se importan
sin cambiar el identificador ni perder el destinatario; cada copia se elimina únicamente tras el
acuse de SQLite. Sólo se importan las que son de esta base, porque su ticket está en ella con todas
las líneas que cobran: el navegador se queda aunque la licencia del equipo pase a otro negocio, y la
clave antigua no dice de cuál era. Las demás se apartan en el propio `localStorage` como desconocidas,
sin borrarlas (AUD-06, `cobrosLegados.ts`). Al no tener firma de backend, esas preparaciones antiguas quedan atribuidas a la
sesión que las importa. La recuperación exige una acción explícita, sin cobros automáticos al abrir.

## Componentes y estado de servicio

Las páginas coordinan secciones con estado propio: `FormularioGasto` concentra el borrador y las
mutaciones de gastos; `useVentaRapida` separa el control transaccional de su vista; el modal de
mesas comparte los elementos de comanda y `useCatalogoServicio`. Este último resuelve imágenes en
paralelo y descarta categorías y búsquedas abandonadas. No comparte la selección entre ventas.

El editor separa nodos Konva, controles y formulario de mesa. `useModoEditor` mantiene un solo
modo activo: editar, añadir vértice, borrar o colocar una mesa. Sus borradores no son escrituras
optimistas: sólo se persisten al guardar el plano. Los formularios conservan sus propios errores
y bloquean envíos repetidos mientras esperan confirmación.

## Los buscadores

Lo que se teclea en un buscador se compara **sin acentos ni mayúsculas**: «café» encuentra «CAFÉ
Solo» y «CAÑA», «Caña». Lo que busca en la base lo hace el SQL de la Main o del worker
([worker.md](worker.md#la-base-del-negocio-dentro-de-su-tenanthub)); una lista que ya tiene la
pantalla (Proveedores y sus productos, Clientes, los tickets de la barra) se filtra con
`shared/lib/busqueda.ts`: `textoABuscar(lo tecleado)` (`null` si no queda nada, y entonces no se
filtra) y `contiene(buscado, ...textos)`. Es la misma regla y la misma tabla
(`crates/tpv-domain/src/busqueda_casos.json`, que lee `test/busqueda.test.ts`), así que una lista
filtrada aquí y una buscada en la base encuentran lo mismo. Nunca `toLowerCase().includes`.

## Las fechas y el día del negocio

Las fechas de la base son la hora de pared del negocio, sin desfase (`YYYY-MM-DD HH:MM:SS`). La pantalla
no las pasa por `Date`, que las leería con la zona del dispositivo: su día es su texto (`diaDeFecha`) y
«hoy» es el del negocio, `hoyEnElNegocio(zona_horaria)` con la zona de `BusinessSettings`, que pone la
Main (`shared/lib/diaDelNegocio.ts`). Así una Handy con otra zona ve el mismo «Hoy» que la Main.

## El tamaño de la interfaz

La interfaz está pensada para 1280 píxeles de CSS de ancho. En una pantalla más estrecha (un
monitor 4:3 de 1024, un portátil con el escalado de Windows al 125 %) se veía como en un móvil
grande: la venta rápida enseñaba dos columnas. En vez de ajustar la maqueta a cada pantalla, el
escritorio usa **el zoom de la ventana** (`src-tauri/src/zoom.rs`):

- **Automático por defecto, según el monitor**: lo justo para que quepan los 1280, en pasos del 5 %
  y nunca por debajo del 70 % ni por encima del 100 %. Sale del monitor y no de la ventana: una
  ventana pequeña en un monitor grande se queda al 100 % y la maqueta responde a su tamaño. Se
  recalcula si la ventana pasa a otro monitor.
- **A mano en este equipo**: `−` y `+` en la barra de arriba (`ControlesZoom`), o Ctrl −/+, de 10 en
  10 entre el 50 % y el 200 %. Es un rango amplio a propósito: por encima del 150 %, una pantalla de
  1920 pasa a la maqueta de tablet. Se guarda en `device_config.json` (`zoom`) y se aplica desde Rust
  al abrir la ventana, antes de pintar nada. La lupa, o Ctrl 0, vuelve al automático; al pasar por
  encima dice el porcentaje. Los límites sólo los sabe `zoom.rs`: la barra apaga `−` y `+` con lo
  que devuelve (`puede_alejar`, `puede_acercar`).
- **La barra de título es una sola** (`Titlebar`), también en el login, que la pone encima de su
  fondo: una copia aparte se queda sin lo que se le añada.
- **Todo se escala por igual**, menú incluido: es el zoom del WebView, no un `zoom`/`transform` de
  CSS, que en el Chromium del WebView2 de Windows 7 descuadra el puntero en el canvas del plano.
- En Android no hay ventana que escalar: ni controles ni zoom.

## El dinero en pantalla

Los horarios se guardan con `horariosGuardarAsignacion`: uno o dos tramos forman un conjunto
con `ID_Grupo`. Editar y borrar afectan al conjunto, y copiar una semana genera un grupo nuevo.
La validación del dominio y las guardas SQL rechazan solapes del mismo trabajador, incluidos los
que cruzan medianoche; dos tramos pueden tocarse en su límite. La escritura y su outbox se confirman
en una sola transacción. Un error conserva el formulario para corregirlo.

En una semana presente o futura, una celda sin turno se rellena con el horario predeterminado; por
eso borrar un turno no dejaba el día libre. «Libre» (`horariosMarcarLibre`, `POST
/v1/trabajadores/horarios/libre`) sustituye lo que tuviera ese día por el día libre: una asignación
del turno LIBRE sin horas (`Libre` en la fila), que es una celda real y tapa la plantilla. Su «X» la
quita y el día vuelve a la plantilla; guardar un turno ese día también la quita. El turno LIBRE no se
ofrece en el editor, y cuenta 0 horas (no entra en la puntualidad del cuadrante).

El dinero es un entero de céntimos de la base a la pantalla
([../decisiones/0005-dinero-en-centimos.md](../decisiones/0005-dinero-en-centimos.md)). En el frontend:

- **`Dinero`** (`shared/lib/dinero.ts`) es `number & { readonly __centimos: unique symbol }`: un `number`
  crudo no se le asigna y la aritmética pierde la marca. `deCentimos` queda para constantes y para lo
  que llega sin tipo (`localStorage`, el *formatter* de una gráfica).
- **Un formateador por salida**: `eur` (pantalla, con separador de miles) y el del papel
  (`shared/ticket/ticketMath.ts`, sin él). Recibe `Dinero`, así que no se le puede pasar un importe en
  euros. Sin alias ni pasarlo como *prop*: quien pinta dinero importa `eur`.
- **Todo campo de dinero es un `<CampoDinero>` con `useImporte()`** (`shared/ui/CampoDinero.tsx`): hacia
  fuera sólo hay `Dinero | null` y si el texto se entiende (`legible`). El único lector es `deTexto`
  («1.500» son mil quinientos; lo ambiguo, como «1,500», tres decimales o un signo, se rechaza). Es un
  campo de texto con teclado decimal, no un `type="number"`.
- **El efectivo** (cambio de un cobro, arqueo antes de confirmar) está en `shared/lib/efectivo.ts`, espejo
  de `tpv-domain::cierre_caja` con las mismas tablas de test ([caja.md](caja.md)).

## Permisos en la interfaz

`usePermisos` consulta las concesiones efectivas de Rust. La NavBar, rutas y acciones reflejan esas
capacidades; Configuración → Permisos edita roles desde Main. No se releen por reloj, sino cuando
pueden haber cambiado: un cambio replicado de usuarios, roles o concesiones, una conexión nueva de la
Handy, al montar una pantalla que los usa y al volver a la aplicación. El gate de verdad está en los comandos ([permisos.md](permisos.md)).
Una relectura que falla no desmonta la aplicación: se sigue con los últimos permisos leídos y se
reintenta sola; un usuario desactivado con la sesión abierta vuelve al login, que dice por qué
([permisos.md](permisos.md#capacidades-por-rol-ri-70)). La sesión se
cierra a los 10 minutos sin actividad (`useInactivityLogout`) y `AppBoot` hace `logout` al arrancar.

## CSP

`tauri.conf.json` (`app.security`) declara `csp` y `devCsp`:

| Directiva | Valor | Por qué |
|---|---|---|
| `script-src` | `'self'` | Sólo el bundle. La `devCsp` añade `'unsafe-inline'` para el preámbulo de react-refresh |
| `connect-src` | `'self' ipc: http://ipc.localhost` | Sólo el IPC: el REST y el WebSocket los hace Rust. La `devCsp` añade `ws:` para el HMR |
| `img-src` | `'self' asset: …asset.localhost <bucket r2.dev> blob: data:` | `asset:` para las imágenes locales de la Main; el bucket para las de la Handy |
| `style-src` | `'self'` | Ver abajo |
| `object-src`, `frame-src` | `'none'` | Sin plugins ni iframes |

- **Un origen nuevo va en las dos**, `csp` y `devCsp`, o funcionará en desarrollo y fallará empaquetado.
  El `<script>` inline de `index.html` (anti-FOUC) funciona porque Tauri calcula su sha256 al empaquetar.
- **Prohibido inyectar `<style>` en tiempo de ejecución**: ni `<style>` renderizado por React, ni
  `document.createElement("style")`, ni librerías que se autoinyecten el CSS. Todo CSS pasa por el bundle.
  Una librería con estilos: si trae un `.css`, se importa; si se lo inyecta, se busca la opción para
  desactivarlo. ApexCharts: `injectStyleSheet: false` en `APEX_CHART_BASE`
  (`features/estadisticas/apexBase.ts`, que **toda gráfica nueva esparce en su `chart: {}`**) y sus dos
  hojas importadas al principio de `Global.css`.
- ⚠️ **En `pnpm tauri dev` de escritorio la CSP no se aplica** (la webview carga el servidor de Vite sin
  cabeceras), así que un `<style>` inline se ve bien en dev y roto en el `.exe`. En Android sí se aplica,
  y su Chromium es más estricto: el emulador es el mejor sitio para cazarlo.
- **Cómo verificarla**: en un build empaquetado, abrir el DevTools remoto
  (`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223` en escritorio, o
  `adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>` en Android) y escuchar
  `securitypolicyviolation`, que dice la directiva culpable. Receta completa en
  [compilar-android.md](../guias/compilar-android.md).

## Gráficas

Las gráficas son de ApexCharts y viven en `features/estadisticas/`. Toda gráfica esparce
`APEX_CHART_BASE` (`apexBase.ts`) en su `chart: {}`, y con importar ese fichero tiene dos cosas:

- **Sin `<style>` inyectado**: `injectStyleSheet: false` (ver [CSP](#csp)).
- **El texto del negocio no llega como HTML** (AUD-25). ApexCharts escribe con `innerHTML` el
  título del tooltip (la categoría), el nombre de la serie dentro del tooltip y el texto de la
  leyenda, y el nombre de un cliente, un producto, un proveedor, una mesa, una zona o un trabajador
  es lo que quiera quien lo escribe. `apexBase.ts` fija los tres formateadores en `window.Apex`, los
  valores por defecto que ApexCharts funde con las opciones de cada gráfica, y los tres pasan el
  texto por `escaparHtml`: un nombre con `&`, `<` o comillas se lee tal cual. Los ejes, las
  etiquetas de datos y el centro de una tarta son SVG y se pintan como texto.

Lo que una gráfica puede fijar en sus opciones:

| Opción | Regla |
|---|---|
| `tooltip.x.formatter`, `tooltip.y.title.formatter`, `legend.formatter` | Pisan el de la base, así que escapan ellas: devuelven un texto fijo o lo que sea pasado por `escaparHtml`. Con eje de fechas (`xaxis.type: "datetime"`) la gráfica trae su `tooltip.x.formatter`, porque el de la base no da formato a una fecha |
| `tooltip.y.formatter`, `yaxis.labels.formatter` | El valor también se escribe como HTML: sólo dan formato al número que reciben (`eur`, `Math.round`…) |
| `xaxis.labels.formatter`, el centro de una tarta, `dataLabels` | Libres: son SVG, y el título pasa después por el formateador de la base |
| `legend.customLegendItems` | Sin escapar antes: pasan por `legend.formatter` y saldrían escapadas dos veces |
| `tooltip`, `tooltip.x`, `tooltip.y`, `tooltip.y.title`, `legend` | Siempre un objeto. ApexCharts sólo funde objetos: una lista en `tooltip.y` (la admite, con un formateador por serie) o cualquier otro valor sustituye al formateador de la base |
| `xaxis.tooltip.formatter` (se salta el del título), `yaxis.tooltip`, `tooltip.custom`, `tooltip.z`, `legend.tooltipHoverFormatter`, `legend.markers.customHTML`, `customSVG` en una anotación, `chart.toolbar.tools`, `goals` en una serie | No se usan: ApexCharts los escribe tal cual |

La protección de fondo son dos cosas: el formateador de la base, que escapa lo que una gráfica no
toque, y `test/react/etiquetasApexEscapadas.test.tsx`, que monta las seis pantallas con nombres
hostiles. Encima, `test/graficasConBase.test.ts` lee con el analizador de TypeScript las opciones
de cada `<ReactApexChart options=…>` y falla si una gráfica se monta sin la base, se sale de esa
tabla o lleva algo que no sabe leer (una clave calculada, un objeto esparcido desde un fichero que
no revisa, unas opciones fabricadas con una llamada). Caza lo corriente, no todo: sigue un nombre
hasta su objeto sólo dentro del mismo fichero.

En una barra horizontal el eje de los valores es `xaxis`, no `yaxis`: si la barra es de dinero,
`xaxis.labels.formatter` le da formato con `eur`, o el eje enseña céntimos. El mismo test lo exige
a toda barra horizontal cuyo tooltip dé el valor en euros.

El resto de la interfaz lo pinta React como texto: no hay `dangerouslySetInnerHTML` ni
`innerHTML`. Detrás hay una segunda capa, la política de navegación de la ventana, que cancela la
salida del marco principal a otra web; qué cubre y qué no, en
[permisos.md](permisos.md#la-superficie-de-la-aplicación-de-escritorio).

## Linters

`pnpm lint` (ESLint en todo el monorepo) analiza, no formatea. Las cuatro reglas y por qué están en
`eslint.config.mjs` y en [CLAUDE.md](../../CLAUDE.md#linters).
