# Medir el Worker antes de decidir Placement

RI-44: Placement permanece desactivado. La base central conserva su ubicación; este procedimiento
no requiere crear staging ni modificar datos de clientes.

1. **Sin instrumentación nueva:** usar Workers Metrics/Analytics y Workers Logs, ya habilitados.
   Comparar tiempo de CPU, duración, errores y versión desplegada. La CPU mide ejecución; la
   duración incluye esperas de red. Los tiempos de Axiom de `apply_error` no representan las
   operaciones correctas y Sentry mantiene el tracing desactivado.
2. **Diagnóstico por ruta:** si el agregado no basta, añadir muestreo de operaciones correctas a
   Axiom con ruta de plantilla, resultado, versión, duración y tiempos de consulta. No guardar
   URLs completas, cuerpos ni correos. Diferenciar cachés frías y calientes. Registrar los envíos
   con `waitUntil` para que no retrasen la respuesta.
3. **Prueba de un piloto:** medir varios días de uso normal en un negocio autorizado, incluyendo
   reconexiones y páginas de catch-up pequeñas y grandes. Comparar p50 y p95 por ruta; comprobar
   también la apertura de WebSockets y las imágenes, no sólo las rutas que consultan la base.
4. **Comparación controlada:** sólo tras tener esa referencia, probar Placement en un despliegue
   separado con un negocio de prueba o en una ventana acordada. Conservar versión, carga y
   consultas comparables; volver a la configuración anterior si perjudica rutas relevantes.

Cambiar de HTTP interno a RPC elimina construcción de peticiones, serialización manual y HMAC,
pero no elimina el viaje al Durable Object ni las consultas a la base central de Turso. Una prueba local permite
comparar ese coste de transporte; no estima los milisegundos de una petición real en producción.

Referencias: [métricas de Workers](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/)
y [Placement](https://developers.cloudflare.com/workers/configuration/placement/).
