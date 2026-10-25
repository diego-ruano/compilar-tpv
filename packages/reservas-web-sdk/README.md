# @altarialights/reservas-web-tpv

Las reservas por internet del TPV desde tu propia web: qué días y horas hay, qué mesas quedan,
reservar y cancelar. Es lo mismo que usa por dentro el widget de reservas, sin su diseño: el
formulario lo haces tú.

Si sólo quieres poner las reservas en una web sin programar nada, no necesitas esto: pega el código
que da el TPV en **Configuración → Reservas → Código para tu web**.

## Antes de empezar

1. **La clave del restaurante.** Es el `rw_…` del código para la web del TPV (`data-negocio="rw_…"`).
2. **El dominio de tu web, dado de alta para ese restaurante.** Sin eso, el navegador no deja a tu
   web hablar con el servidor de reservas ni mostrar la casilla de «no soy un robot». Pide que lo den
   de alta con su origen exacto: `https://www.turestaurante.es` y `https://turestaurante.es` son dos
   distintos. Para probar en local vale `http://localhost:<puerto>`.

## Instalar

```bash
pnpm add @altarialights/reservas-web-tpv
```

Sin compilación (un WordPress, un HTML suelto), se importa directamente del servidor de reservas:

```html
<script type="module">
  import { reservasWeb } from "https://tpv-api.altarialights.workers.dev/reservas-web/v1/sdk.js";
</script>
```

## Una reserva, de principio a fin

```ts
import { reservasWeb, esError } from "@altarialights/reservas-web-tpv";

const reservas = reservasWeb({ clave: "rw_…" });

// 1. El restaurante y su calendario.
const info = await reservas.negocio();
// info.dias_abiertos: los días que se pueden elegir. info.max_personas: el máximo por reserva.

// 2. Las horas de llegada de un día.
const tramos = await reservas.horas("2026-11-20"); // [{ desde: "19:40", hasta: "21:50" }]

// 3. ¿Hay sitio?
const { mesas, alternativas } = await reservas.disponibles({ dia: "2026-11-20", hora: "21:00", personas: 4 });
// Sin mesas, `alternativas` trae hasta cuatro horas cercanas que sí tienen.

// 4. La casilla de «no soy un robot». Pon el botón de reservar deshabilitado hasta que esté lista.
const casilla = reservas.verificar(document.querySelector("#robot")!, {
  alCambiar: (lista) => (botonReservar.disabled = !lista),
});

// 5. Reservar.
try {
  const r = await reservas.crearReserva(
    { dia: "2026-11-20", hora: "21:00", personas: 4, nombre, correo, telefono, nota },
    { verificacion: casilla },
  );
  // r.codigo: la referencia para el restaurante. r.mesa_nombre: la mesa que ha quedado.
  // r.correo_enviado: si le ha llegado el correo con el enlace para cancelar.
} catch (e) {
  if (esError(e, "sin_mesa_libre")) {
    // Ofrecer otra hora (vuelve a pedir `disponibles()`).
  }
  mostrarError(e.message); // Siempre en español y listo para enseñar.
}
```

### La mesa

- **Sin `mesa`** (o con `mesa: "auto"`), la elige el restaurante: la de menos plazas en la que
  quepan. Es lo normal en un formulario sin plano.
- **Con `mesa: "<id>"`**, una de las de `disponibles()`. Para dibujar el plano, `plano()` da los
  salones y las mesas con su posición y su tamaño.

## Lo que hace por ti `crearReserva()`

- **No duplica reservas.** Cada reserva lleva su clave de idempotencia, la misma en todos sus
  intentos. Si una respuesta se pierde y se vuelve a intentar, el servidor contesta la reserva que ya
  hizo en vez de hacer otra. Por eso **la respuesta trae siempre lo que ha quedado reservado**: enseña
  esos datos, no los del formulario.
- **Reintenta** sin conexión, con un fallo del servidor o con la verificación caducada: hasta tres
  veces, con la misma clave y un token nuevo de la casilla.
- **Gasta el token** de la casilla (vale para un intento) y pide otro solo.

Tras una reserva hecha, la siguiente lleva una clave nueva.

## Errores

Todo error es un `ErrorReservas`: se decide por `e.codigo` y se enseña `e.message`.

| `codigo` | Qué hacer |
|---|---|
| `sin_mesa_libre` | Con la mesa automática: no queda ninguna. Ofrecer otra hora u otro día |
| `mesa_no_disponible` | La mesa elegida se ha ocupado. Volver a pedir `disponibles()` |
| `hora_fuera_de_franja`, `dia_no_reservable` | Elegir otra hora u otro día |
| `validation_error` | Un dato no vale. `message` dice cuál |
| `limite_reservas_correo` | Ese correo ya tiene muchas reservas activas |
| `reserva_web_cerrada` | El restaurante tiene apagadas las reservas por internet. `e.cuerpo.negocio` trae el nombre y el teléfono |
| `reserva_web_no_disponible`, `tope_reservas_negocio` | Ahora no se puede reservar por internet: que llamen al restaurante |
| `reserva_web_demasiadas` | Demasiadas peticiones seguidas: esperar un minuto |
| `verificacion_pendiente` | La casilla no está resuelta |
| `verificacion_humana_fallida` | La casilla no ha dado por buena la comprobación: reiniciarla |
| `red` | Sin conexión. Volver a llamar a `crearReserva()` es seguro: no duplica |

## Cancelar

El correo de confirmación lleva un enlace que abre la página de cancelar del servidor de reservas, y
eso funciona para cualquier web. `consultarReserva(token)` y `cancelarReserva(token)` existen para
cuando el enlace pueda llevar a una página tuya: el token va en el enlace, tras `#t=`.

## Límites

- 10 reservas activas por correo y restaurante.
- Las reservas son desde mañana hasta los días que tenga configurados el restaurante (30 por defecto).
- Un límite de peticiones por conexión: un formulario normal no se acerca.
