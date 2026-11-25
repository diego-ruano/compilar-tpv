# Medir el Worker antes de decidir Placement

RI-44: Placement permanece desactivado. Placement mueve dónde se ejecuta el Worker, no sus Durable
Objects: el `TenantHub` de cada negocio y la base central (`BaseCentral`) siguen donde nacieron, con
su pista de región de Europa occidental ([worker.md](../arquitectura/worker.md)). Lo único que podría
ganar es el viaje entre el Worker que atiende y esos objetos. Este procedimiento no requiere crear
staging ni modificar datos de clientes.

1. **Sin instrumentación nueva:** usar Workers Metrics/Analytics y Workers Logs, ya habilitados.
   Comparar tiempo de CPU, duración, errores y versión desplegada. La CPU mide ejecución; la
   duración incluye esperas de red. Los tiempos de Axiom de `apply_error` no representan las
   operaciones correctas y Sentry mantiene el tracing desactivado.
2. **Diagnóstico por ruta:** cada respuesta a un dispositivo autenticado lleva su desglose en
   `Server-Timing` (`observability/tiempos.ts`): lo que se fue en la base central (`central`) y en
   los viajes al `TenantHub` (`hub-ruta`, `hub-escribe`, `hub-lee`), con cuántos de cada; lo de dentro
   del `TenantHub`, con `en-hub-` delante; el total, y el centro de datos que atendió (`colo`). El
   generador de carga lo lee y lo resume ([pruebas-de-carga.md](pruebas-de-carga.md)). Si eso no
   basta, añadir muestreo de operaciones correctas a Axiom con ruta de plantilla, resultado, versión,
   duración y esos tramos. No guardar URLs completas, cuerpos ni correos. Diferenciar cachés frías y
   calientes. Registrar los envíos con `waitUntil` para que no retrasen la respuesta.
3. **Prueba de un piloto:** medir varios días de uso normal en un negocio autorizado, incluyendo
   reconexiones y páginas de catch-up pequeñas y grandes. Comparar p50 y p95 por ruta; comprobar
   también la apertura de WebSockets y las imágenes, no sólo las rutas que consultan la base.
4. **Comparación controlada:** sólo tras tener esa referencia, probar Placement en un despliegue
   separado con un negocio de prueba o en una ventana acordada. Conservar versión, carga y
   consultas comparables; volver a la configuración anterior si perjudica rutas relevantes.

Las llamadas del Worker a sus objetos ya van por RPC, y una ruta de negocio se ejecuta entera dentro
de su `TenantHub`, en un solo viaje (`lib/enElHub.ts`). Lo que queda es lo que tarda ese viaje y los
de la base central, y eso una prueba local no lo dice: no estima los milisegundos de una petición
real en producción.

Referencias: [métricas de Workers](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/)
y [Placement](https://developers.cloudflare.com/workers/configuration/placement/).
