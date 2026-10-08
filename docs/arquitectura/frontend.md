# Frontend (React)

La interfaz de la Main y de la Handy es la misma aplicación React 19 + TypeScript + Vite
(`apps/tpv-main/src/`), dentro de Tauri. Cambia de dónde lee: la Main invoca comandos Tauri contra su
SQLite; la Handy pasa por los mismos comandos, que en ella van por HTTP al worker
(`crates/tpv-infra-http`).

```
src/
├── app/        main.tsx, App.tsx, AppBoot.tsx, Router.tsx, arranque/ (pantallas previas al router),
│               layouts/, layoutComponent/, pages/
├── features/   un directorio por dominio: mesasComponents, ventaRapida, cuentas, InventaryComponents,
│               ClientsComponents, reservas, proveedores, tareas, trabajadores, configuracion,
│               estadisticas, login, notificaciones
├── shared/     lib/ (dinero, efectivo, sockets, permisos, queryClient…), stores/ (Zustand), ticket/,
│               ui/, observability/, toast.tsx
└── Global.css
```

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
- **`void` marca un «fuego y olvido» a sabiendas.** Si lo que va detrás puede fallar de una forma que el
  usuario deba ver, se usa `conAviso(fn)` (`shared/lib/conAviso.ts`), que reporta a Sentry y lo dice en
  pantalla.

## Datos: TanStack Query y Zustand

Venta rápida y Mesas se importan desde el arranque, con sus componentes de servicio. Las demás
rutas de negocio usan `lazy` del router; configuración inicial y recuperación usan `React.lazy`
también cuando las presenta `App`. Login y la estructura de arranque permanecen disponibles.
Durante una navegación diferida se conserva la pantalla actual y se indica la carga.

- Un `QueryClient` (`shared/lib/queryClient.ts`): `staleTime` de 30 s y sin `refetchOnWindowFocus`,
  porque en la Main el dato sólo cambia por mutaciones de esta aplicación o por un `change` del socket.
- **Patrón**: cada feature expone sus hooks en `features/<x>/<x>Queries.ts`, con `useQuery` para lecturas
  (claves prefijadas por la feature, con rangos e ids dentro) y `useMutation` para escrituras, que
  invalidan su clave en `onSuccess`. Referencia: `features/ClientsComponents/clientesQueries.ts`.
- Lo usan clientes, inventario, cuentas, estadísticas, reservas, tareas, trabajadores, proveedores y
  pedidos, notificaciones, el emparejamiento (`configuracion/pairingQueries.ts`), el progreso del
  histórico (`shared/lib/backfillQueries.ts`) y, en mesas, sólo el catálogo de salones y la meta de
  mesas.
- **Fuera a propósito**: la parte transaccional del POS (comanda, cobro y cocina en mesas; toda la venta
  rápida, cuyo arranque mezcla el catálogo con el estado de la comanda), la configuración (se carga una
  vez en stores de Zustand: `useBusinessSettings`, `useTicketSettings`, `useContactSettings`) y el
  login.
- Otros stores (`shared/stores/`): `useAuth`, `useMode`, `useEstadoSync`, `useMainPresence`,
  `useEstadoFiscal`, `useSyncSignal`, `usePairCode`, `useTheme`, `useCorreoRecuperacionPendiente`.

## El dinero en pantalla

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
capacidades; Configuración → Permisos edita roles desde Main. El gate de verdad está en los comandos ([permisos.md](permisos.md)). La sesión se
cierra a los 10 minutos sin actividad (`useInactivityLogout`) y `AppBoot` hace `logout` al arrancar.

## CSP

`tauri.conf.json` (`app.security`) declara `csp` y `devCsp`:

| Directiva | Valor | Por qué |
|---|---|---|
| `script-src` | `'self'` | Sólo el bundle. La `devCsp` añade `'unsafe-inline'` para el preámbulo de react-refresh |
| `connect-src` | `'self' ipc: http://ipc.localhost wss://tpv-api.altarialights.workers.dev` | El IPC y el WebSocket. El REST lo hace Rust. La `devCsp` añade `ws:` para el HMR |
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

## Linters

`pnpm lint` (ESLint en todo el monorepo) analiza, no formatea. Las cuatro reglas y por qué están en
`eslint.config.mjs` y en [CLAUDE.md](../../CLAUDE.md#linters).
