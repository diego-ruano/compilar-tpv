# TPV Altaria Lights — contexto y preparación de pruebas E2E

Fecha: 29 de octubre de 2026. Zona de referencia: Europe/Madrid.
Última comprobación horaria de esta revisión: 23:34:38 CET (22:34:38 UTC).
Estado: preparación y preguntas previas. **Pruebas funcionales E2E ejecutadas: 0.** Matriz inicial: 117 familias de recorridos, todas pendientes; 29 preguntas de contexto.

## 1. Objetivo y límites de la campaña

Validar el producto como usuario de restaurante en una Main Windows 7 x64, una Handy Android y otra Handy Windows 11. Comprobar funciones visibles y condicionales, roles y capacidades, integridad de ventas/caja/stock y actualización entre los tres dispositivos. El código se consulta para determinar qué comportamiento esperar y cómo llegar a cada función; su lectura no acredita funcionamiento real.

La petición establece primero obtener contexto y formular preguntas, y después empezar las pruebas. Esta entrega corresponde a esa primera fase. No se declara cobertura completa ni aptitud para producción.

Restricciones aplicadas:

- Repositorio en modo lectura: sin cambios de código, sin comandos Git, sin instalar dependencias, compilar ni ejecutar las suites del proyecto.
- Sin inspeccionar `.env`, secretos, credenciales, correo personal, carpetas ajenas ni información personal del equipo.
- Datos de negocio exclusivamente sintéticos y reconocibles como pruebas. No introducir datos reales de clientes, trabajadores o proveedores.
- Prohibido enviar facturas por cualquier canal o destinatario, incluida Hacienda. Sólo se contempla emisión/consulta local de prueba cuando se haya acreditado la variante; no abrir enlaces tributarios ni activar certificados/remisión.
- Sin pagos Stripe, compras o reembolsos reales para fabricar casos de licencia.
- Los envíos de correo necesitan destinatarios de prueba controlados. Un dominio ficticio no acredita entrega de correo.
- Sin cambios del sistema Windows 11. Los cortes de red se practicarán en la VM/emulador, sin desconectar la red personal.
- Recuperación, corrupción simulada y restauraciones: únicamente en la VM dedicada y con un punto recuperable conocido.
- Informe guardado fuera del repositorio, en `outputs` del chat. La autorización de dejar un Markdown en la raíz del proyecto se ha entendido como opción, no como obligación.

## 2. Evidencias recogidas y estado de los entornos

Estas observaciones son de inventario, no casos funcionales aprobados.

| ID | Observación directa | Implicación |
|---|---|---|
| ENV-01 | VirtualBox está abierto. `VBoxManage list vms` y `list runningvms` devolvieron listas vacías. | No hay una Main registrada/en ejecución disponible en este momento. Falta crear la VM solicitada. |
| ENV-02 | En la carpeta autorizada existen instaladores Win7 y Win11 y `CD-instalador-Win7.viso`. | El VISO monta el EXE Win7; no es un instalador del sistema operativo. |
| ENV-03 | No se identificó ISO Win7 en la carpeta de instaladores ni entre los DVD registrados de VirtualBox. | Hace falta conocer la ruta del medio Windows 7 x64. No se buscó en carpetas personales. |
| ENV-04 | Emulador `Pixel_7:5554` conectado por ADB. Android 16/API 36, x86_64. Paquete `com.altarialights.tpv` instalado, versión 0.1.0/código 1000, con proceso en ejecución. | APK localizado; pantalla, modo Handy y vínculo todavía sin verificar. |
| ENV-05 | Ventana TPV asociada a `target\\debug\\tpv.exe` abierta en Windows 11. Metadatos 0.1.0. | No se ha verificado su pantalla ni su vínculo. Un ejecutable de desarrollo puede diferir de los instaladores. |
| ENV-06 | Opera tiene abierta una ventana del panel del Worker `tpv-api`. | El modo Live, filtros y disponibilidad de eventos todavía no se han comprobado. No se copiaron datos de la cuenta al informe. |
| ENV-07 | No se ha activado la licencia entregada. | Se conserva el primer arranque limpio. La clave completa no se reproduce en este informe. |

Configuración solicitada de la VM: Windows 7 de 64 bits, 2 CPU, 2 GB RAM y 10 GB de disco. No se aumentará silenciosamente. La instalación debe revelar si el espacio permite completar sistema, runtime y TPV.

### Identidad de artefactos

Carpeta: `C:\Users\diego\Desktop\Instaladores TPV`.

| Artefacto | Bytes | Versión PE | SHA-256 |
|---|---:|---|---|
| TPV-Altaria-Lights-Win7-setup.exe | 173677859 | 0.1.0 | `530F6C5285A14BE634523AE3E4C6BD14D50F2EFB11040E688FC706A04E175430` |
| TPV-Altaria-Lights-Win11-setup.exe | 19565980 | 0.1.0 | `C47B458A7A801BD70EF3DFAA34F9B3CB0F3CD8D3FE6D2DB68A7BDDF6128158F6` |
| target\\debug\\tpv.exe, proceso de Windows 11 | 62854656 | 0.1.0 | `A950920A88B0CD1A619D87DF8AE771EA3A4747B3E961096438AB7D99F92FA0CE` |

El APK instalado declara 0.1.0, primera instalación/actualización `2026-10-29 17:51:43` según Package Manager; no se ha establecido la zona de ese dato. No se extrajo el APK ni sus datos privados.

Compartir versión 0.1.0 no demuestra que los tres artefactos procedan de la misma revisión. Antes de cobrar debe trazarse cada binario a la compilación sin remisión AEAT. Los metadatos o una búsqueda de cadenas aislada no bastan.

### Incidente de interacción con VirtualBox — no es un defecto del TPV

Durante la inspección, el árbol de accesibilidad identificó «Máquinas» como elemento 17. El clic enviado a ese índice inició inesperadamente otra operación «Creating host-only network interface» en el panel de red. Se detuvieron los clics en ese panel. Antes de la acción ya había dos adaptadores; la consulta posterior de solo lectura seguía mostrando únicamente esos dos, sin interfaz adicional identificada.

Después, activar la ventana del TPV falló; se actualizó el inventario de ventanas y el único reintento devolvió `GetCursorPos failed: Acceso denegado. (0x80070005)`. No se continuó inyectando entradas. Se preguntó al usuario si hay un aviso de permisos de VirtualBox para que lo cancele manualmente. No se ha confirmado que apareciese tal aviso ni que la operación haya concluido. La hora exacta del clic no quedó capturada; no se inventa.

La habilidad de control de Windows, `C:\Users\diego\.codex\plugins\cache\openai-bundled\computer-use\26.1023.50603\skills\computer-use\SKILL.md`, remite a `docs\guidance.md`, que establece «Do not automate user authentication dialogs». Por eso cualquier aviso de autenticación/permisos del sistema requiere intervención manual. No es una petición para aceptar el cambio de red.

Antes de retomar control de ventanas: confirmar cierre del aviso/operación y volver a seleccionar ventanas actuales. Para VirtualBox se evitará reutilizar ese índice de accesibilidad. El estado de la operación queda pendiente de resolver.

## 3. Modelo de funcionamiento que se validará

### Main, Handy y nube

- Main: Tauri/React con backend Rust y SQLite local. Confirma ventas localmente y replica por WebSocket nativo. Con datos íntegros y licencia en gracia válida puede trabajar sin internet.
- Handy Android y Windows: mismo producto en modo Handy, sin base de negocio local en uso. Consultan y escriben por REST nativo al Worker; el WebSocket nativo avisa de cambios y vuelve a leer lo afectado.
- Nube: Worker Cloudflare `tpv-api`, Durable Object por negocio y Turso. La Handy no debe operar si no hay una Main confirmada o mientras esta vuelca atrasos.
- Cobrar, anular/devolver cobros y escribir caja/fiscal corresponden a Main, aunque una persona autorizada use una Handy. En Handy se validarán también consultas permitidas y negativas.

| Situación | Comportamiento esperado de Main | Comportamiento esperado de Handy |
|---|---|---|
| Los tres conectados | Escritura local y réplica; recibe cambios ajenos | Escrituras confirmadas por nube y refresco de pantallas abiertas |
| Main pierde internet | Sigue localmente, con outbox pendiente | Se bloquea al detectarse ausencia de Main, aunque Handy tenga internet |
| Una Handy pierde internet | Main y la otra Handy siguen | Sin cola de negocio offline; pierde operatividad al expirar gracia de presencia |
| Main cerrada/apagada | Sin servicio en ese equipo | Bloqueo por Main ausente, incluido acceso |
| Main reconecta con atraso | Subida/catch-up sin duplicar operaciones | Espera durante volcado; vuelve a leer al desbloquearse |
| Main restaurada desde copia sin internet | No puede volver a vender antes de reconciliar | No tiene Main operativa confirmada |

La documentación contempla una gracia de presencia Handy de 5 segundos y un volcado especial con más de 100 operaciones pendientes. No se confundirán esos plazos con una garantía acordada de latencia de pantalla.

### Integridad de negocio

- Dinero en céntimos enteros; cantidades de stock redondeadas a milésimas.
- No debe duplicarse un pago, una línea o un consumo al reintentar una respuesta incierta.
- El precio/IVA del catálogo nuevo no debe cambiar retrospectivamente una línea vendida.
- Totales, pendientes, consumos, devoluciones, gasto del cliente y caja deben cuadrar entre sí.
- Las operaciones confirmadas deben corresponder al estado persistido después de recargar o reiniciar.
- La política de conflictos no es universalmente «gana el último»: debe acordarse según operación. La convergencia y las restricciones de integridad sí son exigibles.

### Fiscalidad y comunicaciones externas

Las fuentes actuales describen una variante sin remisión AEAT. Cada cobro sí produce una factura y un registro encadenado local. La activación no exige NIF; el primer cobro exige configurar NIF válido y razón social del negocio ficticio. No se ha acreditado todavía que los instaladores correspondan exactamente a esta variante.

Se probarán facturas/correcciones locales únicamente después de resolver esa trazabilidad. La emisión local no se confundirá con enviar una factura por correo ni con remitir a Hacienda.

Efectos externos identificados para preparar destinatarios:

- Mandar pedido a proveedor envía correo antes de guardar/marcar el pedido como enviado.
- Reservas web y ciertos cambios/cancelaciones pueden generar correos, también mediante un job posterior.
- Recuperación PIN, cambio de correo, traslado y canje de licencia pueden enviar códigos, avisos o recibos.
- La actualización puede sustituir el binario bajo prueba; se deja para el final en un entorno dedicado.

## 4. Roles, capacidades y funciones que aparecen bajo condiciones

Hay cinco roles iniciales y 21 capacidades. Son dos ejes de autorización: la capacidad de la persona y el modo del dispositivo. El administrador no es editable desde el gestor. Un rol vacío no recupera concesiones por defecto.

| Rol inicial | Acceso esperado según fuentes |
|---|---|
| Administrador | Completo; configuración estructural, personal/PIN, fiscalidad, licencia y dispositivos |
| Encargado | Servicio, gestión operativa, inventario, estadísticas y cobros; inicialmente sin gastos ni cierre |
| Camarero | Venta, cocina, reservas, tareas propias, clientes y cobros/devoluciones |
| Cocinero | Cocina y tareas propias |
| Limpieza | Tareas propias |

| Grupo | Capacidades que necesitan caso concedido y retirado |
|---|---|
| Servicio | `servicio.vender`, `servicio.cocina`, `reservas.gestionar`, `tareas.propias` |
| Inventario | `catalogo.editar`, `catalogo.precios`, `catalogo.borrar`, `stock.recibir`, `stock.editar_lotes`, `stock.ajustar` |
| Gestión | `proveedores.gestionar`, `pedidos.gestionar`, `tareas.gestionar`, `horarios.gestionar`, `plano.gestionar`, `estadisticas.ver`, `clientes.gestionar`, `clientes.recalcular` |
| Caja | `cuentas.cobros`, `cuentas.gastos`, `caja.cerrar` |

Cada capacidad tendrá comprobación de menú/ruta/botón, efecto real de la acción, sesión ya abierta y cambio recibido en otros dispositivos. No bastará comprobar que desaparece un botón. Se probarán Main y ambas Handy donde aplique; en funciones exclusivas Main se verificará la negativa Handy.

Condiciones relevantes:

- Cocina sustituye el plano cuando hay cocina y no venta. Con ambas capacidades se muestra el plano.
- Todos los roles, incluido administrador, deben fichar antes de acceder. Tras salir definitivamente, el código permite entrar sin crear otra jornada. Jornada partida exige segunda entrada después del primer tramo.
- Las capacidades se revalidan en el backend al actuar; la UI refresca por cambios replicados y consulta periódica de 30 segundos. Se medirán ambos efectos por separado.
- Primer arranque obliga a elegir un PIN nuevo de 4–6 cifras; no requiere usar el PIN público del seed para entrar.
- Las acciones llegada/salida del cliente dependen del estado de la reserva y aparecen también desde la mesa.
- Devolución parcial, error de cobro, impacto en cierre ya cerrado, factura completa y recuperación de cobro aparecen sólo con estados previos concretos.
- Datos privados del personal y configuración tienen restricciones adicionales. Se usarán campos opcionales vacíos o fixtures sintéticos.
- El botón de dar de baja en la ficha de Trabajadores contiene un aviso «Por implementar» en el fuente revisado. La edición Activo/Inactivo es otro recorrido. Se verificará su presencia real y se acordará si la baja forma parte de la versión candidata.
- Clientes → Publicidad también contiene un aviso pendiente de implementar. No se tratará como un envío de publicidad operativo ni se contactará con terceros.

### Desglose de controles condicionales para evitar omisiones

Estas precisiones proceden del fuente; siguen pendientes de prueba real:

| Superficie | Controles/estados adicionales que se deben recorrer |
|---|---|
| Emparejamiento | Código manual y contenido QR pegado, válido/malformado; limpiar/volver/cancelar; huella, rechazo/caducidad/regeneración; conservar código Main al salir y volver. El formulario revisado no tiene lector de cámara propio. La instrucción Main «Configuración → Vincular… escanea» debe contrastarse con el flujo de arranque real. |
| Negocio | Borrador de identidad/contacto/logo, guardar y descartar conjuntamente; seleccionar logo no debe hacerlo efectivo antes de guardar; NIF mayúsculas/control; aviso de imposibilidad de cobrar desaparece tras guardado correcto. |
| Ticket | Ancho/DPI/columnas/escala/cuatro márgenes/visibilidad con autoguardado de 250 ms; IVA y mensaje con guardado explícito. Campo mensaje sólo si se activa su visibilidad. Salir rápido, volver/reiniciar, vacío/límites/error. «Visualizar» es precuenta de ejemplo sin venta. |
| Impresoras | Refrescar lista, selección y deselección al pulsar la misma; predeterminada/elegida; botones sin selección; prueba y cajón independientes; persistencia por dispositivo y presentación Android/Handy. |
| Correo de recuperación | Cambiar/enviar/confirmar seis cifras; incorrecto/caducado/reenvío y espera/cancelar; mismo correo; volver al de compra. Los destinos nuevo, anterior y compra deben ser de ensayo. |
| Reservas web | Interruptor revierte UI si falla; integración/ver código; días cerrados con fecha/motivo y quitar cierre; por mesa, activo/siete días/rango/horario, guardado separado del layout y cierre bloqueado mientras guarda. No usar «Copiar» durante preparación, porque modifica portapapeles del equipo personal. |
| Conectividad | Salud cada 5 s, jobs cada 30 s, cuarentenas de subida/bajada distintas, progreso histórico condicional y «Pausado por soporte» con motivo/vencimiento. No hay selector online/offline ni control para lanzar jobs. |
| Imágenes | JPEG/PNG/WebP, vacío/extensión/tamaño superior a 5 MB, seleccionar/arrastrar/cambiar/quitar, error y fallback. Diferenciar quitar selección nueva de borrar imagen previa. Cola: desplegar motivo, actualizar y reintentar apartada, continuar con las demás. Comprobar llegada a Handy sin salir/volver y con caché. |
| Impresión | Documentos de un mismo cobro separados: original/F1, F3, rectificativa y F3 de devolución cuando existan; precuenta todo/pendiente/selección; fiscal sin selección de líneas; cambiar comanda sin mezclar cobro anterior. |
| Horarios | Copiar semana anterior sobrescribe la visible; predeterminado requiere semana no vacía y se aplica a semanas sin asignaciones. Navegación anterior/actual/siguiente y presentación móvil. PDF por persona, semana visible, acentos/ñ y resumen si hay muchas asignaciones diarias. |
| Notificaciones | Lectura por usuario, navegación aun al desmontar pantalla, acción desconocida sólo marca leída; dos personas con mismo aviso, recuentos, marcar todas, restaurar y cancelar/confirmar borrado definitivo. |
| Teclado | Login dígitos/retroceso/Escape/Enter sin actuar detrás de recuperación; notas Ctrl+Enter y Escape según modal; flechas de ficha cliente sin interferir escritura; Tab/Shift+Tab/Escape en cada modal; hora 1230/9:30/incompleta/24:00; selección con Enter/Espacio. |
| Android | Tema también en barras nativas; ausencia de botones de ventana; menú cierra al navegar/fondo/cambio de ancho; teclado virtual y modales anidados. |
| Recuperación | Copia local, importar copia, nube e inicialización vacía como recorridos distintos; progreso/error/reintento/volver. Restauración no durante venta; la sección de copias indica reiniciar hacia recuperación. |

El texto de selección de imágenes menciona PNG/JPG aunque la aceptación incluye WebP: comprobarlo en UI como coherencia de ayuda. El modal fiscal menciona domicilio, pero la condición local de habilitación revisada exige nombre y NIF; falta acordar si debe ser obligatorio y contrastar la respuesta real.

## 5. Matriz inicial de recorridos

Todos los casos siguientes están **PENDIENTES**. Son familias de escenarios: al ejecutarlas se abrirán subcasos por dispositivo, variante, permiso y estado. Una familia con subcasos pendientes no se marcará aprobada. No se asigna un porcentaje global antes de cerrar el inventario y sus exclusiones.

M = Main Win7; A = Handy Android; W = Handy Windows 11; H = ambas Handy. «Permitidos» exige capacidad y dispositivo adecuados.

### Arranque, acceso y dispositivos

| ID | Recorrido y comprobaciones | Equipos |
|---|---|---|
| INI-01 | Crear VM con recursos solicitados; instalar sistema y EXE Win7; primer arranque sin herramientas de desarrollo | M |
| INI-02 | Activar licencia limpia una vez; identidad ficticia; reinicio y persistencia del negocio | M |
| INI-03 | Elegir PIN inicial; validaciones; repetición de setup denegada; conservar correo de compra sin envío de código | M/H negativa |
| INI-04 | Vincular dos Handy mediante código/QR, solicitar, comparar huella y aprobar; listado y notificaciones | M+A+W |
| INI-05 | Código incorrecto/caducado; rechazar solicitud; cancelar espera; cerrar/reabrir durante espera | M+A+W |
| INI-06 | Revocar y volver a vincular Handy de ensayo; eliminar caché de sesión anterior; identidad estable | M+A+W |
| AUT-01 | PIN válido/incorrecto, mostrar/ocultar, teclado/Enter y errores sin datos privados | M+A+W |
| AUT-02 | Fichaje previo para cada rol; entrada/salida; jornada partida y nocturna; login tras salida final | M+A+W |
| AUT-03 | Bloqueo escalado por PIN fallido con usuario ficticio reservado; espera y recuperación | M+A+W |
| AUT-04 | Logout, cambio de persona, recarga, reinicio e inactividad de 10 minutos; caché personal limpia | M+A+W |
| AUT-05 | Recuperar PIN admin por correo de ensayo; código incorrecto/caducado; no disponible para otro rol/Handy | M/H negativa |
| AUT-06 | Cambiar correo de recuperación y avisos al anterior/compra, únicamente con buzones de ensayo | M |
| PER-01 | Cinco roles iniciales: menú, rutas, botones y operaciones realmente permitidas/denegadas | M+A+W |
| PER-02 | Conceder/retirar individualmente las 21 capacidades; persistencia y efecto en sesiones abiertas | M+A+W |
| PER-03 | Producto editable sin permiso de precio; alta sin precio/stock; ajuste no eludible desde ficha | Permitidos |
| PER-04 | Cambiar rol y desactivar persona con sesión abierta; respuesta tardía de usuario anterior | M+A+W |
| PER-05 | Último administrador protegido; dos administradores con edición de permisos obsoleta | M+A+W |
| PER-06 | Gestor sólo Main/admin; administrador no editable; rol sin concesiones; acceso a ruta guardada | M/H negativas |

### Servicio, mesas, barra y cocina

| ID | Recorrido y comprobaciones | Equipos |
|---|---|---|
| POS-01 | Catálogo/categorías/búsqueda/ficha/imágenes/alérgenos; cambios de selección rápidos | M+A+W |
| POS-02 | Barra: añadir, quitar, cantidades y eliminar línea pendiente; confirmación y totales | M+A+W |
| POS-03 | Notas de línea, persistencia, edición fallida, reflejo en cocina y otras pantallas abiertas | M+A+W |
| POS-04 | Varios tickets independientes de barra; crear, abandonar, abrir existente y continuar | M+A+W |
| POS-05 | «Ver tickets»: hoy/recientes/sin cobrar/cobrados, búsqueda por producto/importe/hora, detalle y acciones condicionadas | M+A+W |
| POS-06 | Plano por salón, estados/colores, mesas libres/con pendiente/reserva activa/próxima | M+A+W |
| POS-07 | Abrir misma mesa desde tres dispositivos; una comanda abierta y coherencia del modal | M+A+W |
| POS-08 | Reservas desde mesa: llegada y salida del cliente; transición y precedencia de estado visual | M+A+W |
| POS-09 | Cocina con usuario apropiado; preparado/pendiente por línea y productos que no pasan por cocina | M+A+W |
| POS-10 | Cocina frente a cobro y edición ajena; lectura tardía de comanda anterior no reemplaza la actual | M+A+W |
| POS-11 | Cobro total y por líneas, parcial, efectivo/cambio insuficiente y tarjeta como registro de prueba | M/H negativas |
| POS-12 | Factura completa voluntaria/por umbral; cancelar modal no cobra; datos inválidos conservan formulario | M |
| POS-13 | Primer cobro sin datos fiscales de negocio: rechazo sin consumo ni número gastado | M |
| POS-14 | Doble clic/espera/resultado incierto; recuperar cobro pendiente, corregir destinatario, reintentar o descartar preparación | M |
| POS-15 | Precio/IVA de catálogo cambian con ticket previo abierto; histórico congelado y nuevas líneas actuales | M+A+W |
| PLA-01 | Crear/renombrar/borrar salones y mesas; tres formas, aforo/tamaño/posición/contorno/vértices | Permitidos |
| PLA-02 | Editor: zoom, deshacer, modos exclusivos, guardar y salir con cambios sin guardar | Permitidos |

### Inventario, reservas y gestión

| ID | Recorrido y comprobaciones | Equipos |
|---|---|---|
| INV-01 | Consultar catálogo, categorías, detalle, mínimos y próximos a caducar | M+A+W |
| INV-02 | Alta/edición/baja de categoría y producto; duplicados, obligatorios y referencias existentes | Permitidos |
| INV-03 | Precio/IVA/unidad/proveedor/mínimo/pedido esperado/cocina; validaciones monetarias | Permitidos |
| INV-04 | Imagen ficticia: seleccionar, guardar, sustituir y quitar; subida/reflejo Handy; error de formato | Permitidos |
| INV-05 | Alérgenos y sus cambios; presentación en servicio y detalle | Permitidos |
| INV-06 | Lote inicial/opcional; alta posterior con coste/cantidad/caducidad/notas; orden FEFO | Permitidos |
| INV-07 | Editar datos de lote sin sobreescribir stock; ajuste lote/suelto a milésimas y motivo | Permitidos |
| INV-08 | Ajuste basado en stock antiguo mientras otro dispositivo vende/ajusta; rechazo y recuperación del formulario | Permitidos |
| INV-09 | Stock suelto sin control, negativo y consumo al cobrar; devoluciones y anulaciones restituyen una vez | M+A+W |
| RES-01 | Calendario mensual/lista diaria; navegación, fecha local, conteos de vivas/cerradas | Permitidos |
| RES-02 | Alta/edición: cliente/contacto, comensales, hora/duración/zona/mesa/notas; selección en mapa | Permitidos |
| RES-03 | Coincidencia con cliente existente; vinculación sin duplicados; coherencia en su ficha | Permitidos |
| RES-04 | Solape reserva/reserva o comanda; modo avisar/prohibir; aforo y duración | Permitidos |
| RES-05 | Próxima, llegada/activa, finalizada, cancelada y no vino; botones según estado | Permitidos |
| RES-06 | Borrado manual frente a WEB; WEB no borrable; cerradas no editables | Permitidos |
| RES-07 | Configurar duración/solapes/no vino; cambio temporal automático y color del plano | Permitidos |
| WEB-01 | Widget/reserva web pública: disponibilidad, zonas/mesas/horarios, confirmación y entrega a Main | Web+M+H |
| WEB-02 | Main offline y vuelta; reserva en agenda no perdida; cambios/cancelación y correos de ensayo | Web+M+H |
| WEB-03 | Clave/dominio/configuración y cierre temporal de reservas; mensajes y límites | Entorno de ensayo |
| CLI-01 | Clientes: alta/edición/búsqueda/contacto/notas/duplicados; reservas y gasto acumulado | Permitidos |
| CLI-02 | Rankings y recalcular gasto tras cobros/devoluciones/anulaciones | Permitidos |
| CLI-03 | Acción Publicidad: presencia y aviso pendiente; definir criterio de la versión sin enviar comunicaciones | Permitidos |
| PRO-01 | Proveedor: alta/editar/baja/foto/contactos; vínculos con productos y alta desde vinculación | Permitidos |
| PED-01 | Pedido borrador: líneas, cantidad/precio/unidad/notas, correo, filtros/paginación y edición | Permitidos |
| PED-02 | Pedido vacío/datos insuficientes; enviar a buzón de ensayo, error de envío, reintento y estado final | Permitidos |
| PED-03 | Cancelar pedido; enviado/cancelado sólo consulta; conservación y coherencia con proveedor | Permitidos |
| TRA-01 | Personal ficticio: alta/edición/PIN/rol/estado/contrato; restricciones de datos privados por rol/modo | Admin permitido |
| TRA-02 | Botón dar de baja frente a edición Activo/Inactivo; comprobar aviso pendiente y criterio de versión | Admin permitido |
| HOR-01 | Horario propio/equipo; semana, áreas, turno simple/partido/nocturno y límites de día | M+A+W |
| HOR-02 | Alta/editar/borrar conjunto de tramos; solapes; copiar semana/predeterminada; PDF | Permitidos |
| TAR-01 | Tareas: crear/asignar varios/editar/vencimiento; finalizar sólo asignación propia | Permitidos |
| TAR-02 | Papelera, restaurar y vaciar; tarea completada hoy y avisos; autoría de sesión | Permitidos |
| NOT-01 | Badge, lectura individual/todas, enlace contextual, papelera/restaurar/borrado | M+A+W |
| EST-01 | Estadísticas: mesas/productos/reservas/proveedores/trabajadores/clientes × hoy/semana/mes/año | Permitidos |
| EST-02 | Cruce de estadísticas con operaciones conocidas y aviso de histórico incompleto | Permitidos |

### Caja, documentos, configuración y operación

| ID | Recorrido y comprobaciones | Equipos |
|---|---|---|
| CAJ-01 | Históricos: filtros/rangos/búsqueda/paginación/totales; anulados y devoluciones diferenciados | M/H consulta |
| CAJ-02 | Baja por ERROR: motivo, reapertura/líneas, stock, cliente y auditoría | M |
| CAJ-03 | Devolución total/parcial, repetida, cantidades decimales y último céntimo; límites restantes | M |
| CAJ-04 | ERROR después de devoluciones previas: deshacer sin restituir stock dos veces | M |
| CAJ-05 | Editar pago: efecto previsto sobre caja; permisos y conservación de la firma correcta | M |
| CAJ-06 | Gastos alta/edición/baja, origen efectivo/cajón, filtros y totales | M/H negativas |
| CAJ-07 | Cierre con denominaciones, cuatro pasos, contado exacto/descuadre/motivo, dejado/retirado y fondo siguiente | M |
| CAJ-08 | Cierre con comandas abiertas; doble confirmación; último cierre deshecho y anterior protegido | M |
| CAJ-09 | Cambiar pago/gasto de periodo cerrado: previsualización, motivo, foto original y rectificación auditada | M |
| DOC-01 | Ticket original/copia/anulado, efectivo/tarjeta; número/fecha/IVA estables | M |
| DOC-02 | Precuenta sin número fiscal, rectificativa, arqueo y PDF de día/rango | M |
| DOC-03 | F2/F1, canje F3 uno/varios tickets, corregir destinatario F1/F3, numeración y relaciones | M, sin AEAT |
| DOC-04 | Impresora ausente/sin papel/fallo o logo inválido; venta confirmada no se revierte | M |
| DOC-05 | Papel real, ancho/corte/legibilidad y cajón: original efectivo frente a copia/precuenta/arqueo | M+hardware |
| CFG-01 | Negocio ficticio, contacto/logo/identidad fiscal, país; validación, persistencia y réplica | Admin permitido |
| CFG-02 | Tema claro/oscuro; distribución de ajustes locales frente a compartidos | M+A+W |
| CFG-03 | Ticket: anchos 58/80/112 mm, DPI/columnas/márgenes/escala, opcionales/mensaje, prueba/cajón | M |
| CFG-04 | Reservas, dispositivos, permisos, correo de recuperación y opciones por dispositivo | Admin permitido |
| CFG-05 | Conectividad: nube, pendientes/apartadas, jobs, histórico e imágenes; reintentos sin borrar operaciones | M |
| REC-01 | Copia manual/lista/exportación; buena/mala por contenido y errores comprensibles | M dedicada |
| REC-02 | Restaurar copia en VM; reconciliación obligatoria, bloqueo de escrituras y reinicio durante progreso | M dedicada |
| REC-03 | Recuperación desde nube, maestros/comandas vivas primero, histórico después y reanudación | M dedicada |
| REC-04 | Restauración con outbox pendiente; rechazo protector, sin pérdida silenciosa | M dedicada |
| LIC-01 | Estado/licencia persistente, gracia offline, avisos y controles sin licencia Handy separada | M+A+W |
| LIC-02 | Canje, traslado, caducidad/revocación y reversión con claves/estados adicionales dedicados | Entorno de ensayo |
| UPD-01 | Consulta de versión/novedades y canal correcto Win7; instalación/reinicio conservando datos al final | VM dedicada |
| OPS-01 | Reinicios repetidos, servicio prolongado y jobs de avisos/stock/fichajes/copias; precisión de fechas | M+A+W |
| UX-01 | Teclado/Enter/escape/foco, scroll, modales, loading, doble clic y errores que conservan formularios | M+A+W |
| UX-02 | Pantalla pequeña Android, orientación/teclado/insets, táctil, suspensión/reanudación; gráficos/assets/CSP | A |
| UX-03 | Variar resolución/escalado sólo en VM; observar Windows 11 con su configuración actual; claro/oscuro de la app, textos cortados y navegación diferida | M+W |

### Tiempo real, simultaneidad y fallos de conexión

| ID | Escenario | Oráculo/evidencia |
|---|---|---|
| SYN-01 | Cada entidad compartida cambia desde cada escritor permitido | Comparar lista, detalle/modal abierto y valores en los otros dos sin recarga manual |
| SYN-02 | Misma comanda abierta en los tres: añadir/quitar/nota/cantidad | Convergencia de líneas, notas, total, cocina y pendiente; medir ambas rutas de cada escritor |
| SYN-03 | Dos Handy añaden al mismo tiempo y Main también modifica | Confirmaciones coherentes; no duplicación por eco ni pérdida silenciosa |
| SYN-04 | Cobrar mientras Handy edita; cocina mientras se cobra | Pago/estado/líneas atómicos y mensaje correcto para la acción incompatible |
| SYN-05 | Cortar sólo red de VM Main y vender localmente | Main conserva servicio; Handy bloquean por presencia; no editan nube desactualizada |
| SYN-06 | Reconexión tras varias ventas | Sin pagos/consumos/números duplicados, ni pérdidas; desaparece atraso tras confirmación |
| SYN-07 | Más de 100 operaciones pendientes | Espera durante volcado, progreso/motivo visibles y desbloqueo automático |
| SYN-08 | Android pierde red, pasa a segundo plano y vuelve | Reconecta y relee ticket/ajustes/consultas; sin datos antiguos de otra sesión |
| SYN-09 | Respuesta incierta y reintento de misma operación | Aplicación una vez; distinguir reintento de dos acciones deliberadas |
| SYN-10 | Reiniciar con operaciones persistidas y con operación incierta | Persistencia correcta, nueva conexión autenticada con identidad estable del dispositivo y nueva identificación personal; ninguna ejecución automática de cobros pendientes |
| SYN-11 | Main y Handy editan misma reserva casi simultáneamente | Registrar orden/respuestas; los tres convergen según política de conflicto acordada |
| SYN-12 | Main cancela reserva WEB mientras Handy guarda edición abierta | Sin divergencia persistente ni resurrección silenciosa; registrar correos de ensayo |
| SYN-13 | Llegada frente a cancelación; dos reservas solapadas en modo prohibir | Estado coherente; como máximo una reserva incompatible aceptada |
| SYN-14 | Dos administradores desactivan los restantes; dos altas/fichajes/comandas de la misma entidad | Al menos un admin utilizable; restricciones únicas, sin éxito falso o registros huérfanos |
| SYN-15 | Main archiva producto mientras Handy conserva catálogo viejo | Operación atómica, resultado coherente y mensaje accionable |
| SYN-16 | Cambiar concesiones con modales/sesiones abiertos | Denegación efectiva y actualización visual registradas con tiempos separados |
| SYN-17 | Recargar/reiniciar tras conflicto y volver a revisar después | Estado convergente persiste; registrar cambios posteriores de reparación |

No se controlará una carrera de milisegundos modificando código ni instrumentalizando la red personal. Un intento que no reproduzca una carrera no permite declararla inexistente.

## 6. Evidencia, clasificación y criterio de cierre

Estados de ejecución: PENDIENTE, EN CURSO, APROBADO, FALLIDO, BLOQUEADO o NO APLICA con motivo. «No aplica» requiere una decisión de alcance, no sustituye un caso que no se pudo probar.

Por subcaso se registrará:

1. ID, requisitos, variante/build/hash disponible, equipo escritor, persona ficticia y concesiones.
2. Estado inicial, datos sintéticos, pasos exactos y resultado esperado.
3. Hora de acción/confirmación/error en Europe/Madrid y UTC, con precisión real capturada.
4. Resultado en Main, Android y Windows; tiempo hasta verse en cada receptor y persistencia posterior.
5. Resultado real, error literal, estado de conexión y evidencia permitida.
6. Incidencia enlazada, reproducibilidad, alcance afectado y posible recuperación sin tocar código.

F12 sirve para Console, interfaz, IPC, recursos y CSP; el REST/WebSocket de negocio principal vive en Rust y no se deduce sólo de Network. Se usarán estados de la aplicación, observación en los tres equipos, logs propios del TPV y, cuando proceda, Logcat filtrado a TPVRust. No se recopilarán logs generales del PC, tokens ni cuerpos con datos personales.

Para Cloudflare: anotar timestamp exacto con zona, operación y error; correlacionar `op_id` y metadatos de dispositivo/versión cuando estén disponibles. No se considera prueba de éxito la ausencia de un error en el panel: no todos los apply correctos se registran allí.

Plantilla de incidencia:

| Campo | Contenido |
|---|---|
| ID / severidad | INC-xxxx / crítica, alta, media o baja con justificación |
| Entorno | Variante, hash/build, modo, versión, rol/capacidades |
| Hora | Local+zona y UTC; no inventar precisión |
| Pasos | Preparación y secuencia mínima reproducible |
| Esperado / real | Incluye resultado individual de los tres equipos |
| Impacto | Dinero, stock, permisos, bloqueo, pérdida/duplicación, UX |
| Evidencia | Captura/log permitido y correlación Worker si existe |
| Estado | Nuevo, confirmado, intermitente, pendiente de contexto o aceptado por decisión |

La conclusión de campaña exige que todos los subcasos acordados tengan evidencia y resolución de estado. No habrá «100 % aprobado» con hardware ausente, envíos no ensayados, estados de licencia no preparados o recorridos pendientes. La aptitud para producción se expresará aparte de la cobertura: puede haber cobertura ejecutada completa y defectos bloqueantes.

## 7. Contexto existente que debe contrastarse

No son defectos E2E descubiertos en esta sesión:

- `SYNC-29` y `SYNC-30` están documentados como pendientes de concurrencia. Motivaron SYN-11 a SYN-17; falta reproducirlos.
- La documentación de caja mantiene pasajes de roles fijos, mientras el código usa capacidades configurables.
- El índice de documentación presenta reservas web como sin implementar, pero existen UI, SDK, widget y rutas. Debe fijarse qué está desplegado.
- El estudio Win7 contiene afirmaciones de estado antiguas frente a instrucciones y artefactos posteriores. La compatibilidad real se probará con el EXE entregado.
- El README E2E conserva expectativas de QR/colas fiscales de otra variante. No es criterio de aceptación de esta candidata.
- El código señala pendiente una sesión personal verificable en Worker (`SEC-SESION`); el dispositivo se autentica allí y la autorización personal Handy se valida en Rust. La prueba funcional de roles no equivale a una auditoría de seguridad del Worker.
- El backlog indica ausencia de staging. No se presume aislamiento sólo porque la licencia sea nueva.

## 8. Preguntas de contexto para el usuario

Las preguntas 1–6 condicionan preparar la Main y empezar a generar operaciones. Las demás fijan el comportamiento de negocio y el alcance. Cuando exista una expectativa explícita del código se ha explicado arriba; interesa confirmar si coincide con el producto que se quiere publicar.

1. ¿Cuál es la ruta del medio Windows 7 SP1 x64, qué edición se usará y cómo se resolverá su activación? No hay una VM registrada actualmente.
2. ¿Qué revisión/release produjo cada EXE y el APK instalado? ¿Los tres son de la variante sin remisión AEAT? ¿Hay manifiesto de build para contrastar los hashes sin usar Git?
3. ¿Qué entorno usa el Worker abierto y a qué negocio aislado pertenecerá la licencia nueva? ¿El fuente y los artefactos quedarán estables durante la campaña?
4. ¿Las dos Handy contienen sólo datos ficticios? ¿Están vinculadas a otro negocio y qué estado debe conservarse al asociarlas al nuevo?
5. ¿Qué buzones controlados de ensayo recibieron o recibirán compra/recuperación, pedidos y reservas? ¿Quién introducirá los códigos cuando haga falta, sin acceder a correo personal?
6. ¿Hay un aviso de permisos de VirtualBox abierto por la operación inesperada de interfaz de red? Si aparece, cancelarlo manualmente y confirmar que se cerró; no se necesita aceptar cambios en el anfitrión.
7. ¿Los cinco roles y concesiones iniciales descritos son los deseados? En especial, ¿Camarero debe tener cocina y devoluciones de cobros, y Encargado carecer inicialmente de gastos/cierre?
8. ¿Cocina debe sustituir el plano sólo sin permiso de vender, o se espera poder abrir ambos recorridos con el mismo usuario?
9. ¿Es intencional exigir fichaje a todos los roles y permitir login después de la salida final sin abrir otra jornada? ¿Se usa jornada nocturna y partida habitualmente?
10. ¿Qué formato de restaurante debe simularse: número de salones/mesas, barra, cocina, productos por peso/unidad, IVA y horarios de servicio? Si no hay preferencia se usará un restaurante sintético pequeño y variado.
11. ¿Confirmamos que el stock se consume al cobrar, que el suelto puede quedar negativo y que toda devolución repone existencias? ¿Hay excepciones esperadas?
12. ¿Qué reglas de reservas se quieren publicar: duración, aforo, solape avisado/prohibido y minutos para no vino? ¿Cómo se priorizan reserva frente a comanda abierta?
13. ¿Qué URL/widget e integración de reservas web forman parte de esta salida? ¿Qué dominio y buzones de ensayo tienen habilitados?
14. ¿Qué latencia máxima define «al instante» para servicio, inventario y permisos? Propuesta inicial a discutir: medir objetivo de hasta 1 segundo en red estable y reportar cualquier demora; separar la actualización periódica de permisos.
15. Cuando dos equipos cambian la misma nota/cantidad/reserva, ¿debe prevalecer una edición, rechazarse la antigua o solicitar decisión? ¿Qué acción prevalece entre cancelar y marcar llegada?
16. ¿La falta de Main debe bloquear completamente las Handy, incluso con internet, tal como describen las fuentes? ¿Es definitivo que ninguna Handy cobre o escriba caja?
17. ¿Qué impresora ESC/POS, ancho de papel y cajón hay para la VM? ¿Están ya conectados al entorno de ensayo? Sin ellos quedará pendiente comprobar papel/corte/apertura física.
18. ¿«Tarjeta» es sólo un método contable dentro del TPV o existe integración con un terminal bancario? Las ventas se simularán sin operaciones bancarias reales.
19. ¿Qué juego de identidad fiscal sintética usa el proyecto para negocio y destinatarios? Si no existe, se usarán fixtures sintéticos de validación; no se necesita NIF de persona real.
20. ¿Qué reglas de factura completa, umbrales, agrupación de tickets, devoluciones parciales y corrección de destinatario son las previstas para esta candidata?
21. ¿Cómo se cierra caja en producción: una vez al día, por turno, cruzando medianoche, varios operadores? ¿Qué umbral de descuadre debe exigir motivo?
22. ¿Hay licencias y estados dedicados para canje/traslado/caducidad/revocación y buzón de compra de ensayo? Una única clave limpia no permite ensayar todos esos estados por sí sola.
23. ¿Qué versión/canal de actualización se ensayará al final en la VM Win7? Debe conservarse la identidad de la versión que se prueba antes de sustituirla.
24. ¿Qué volumen de producción debemos simular: dispositivos simultáneos, catálogo, mesas/comandas por hora, reservas diarias e histórico? No se necesitan datos reales, sólo magnitudes.
25. ¿Qué duración de servicio continuo y franjas horarias especiales forman parte de la aceptación: cierre nocturno, cambio de día y suspensión Android?
26. ¿Los botones «Dar de baja» y «Publicidad» pendientes entran en la funcionalidad exigida para esta salida? Para personal, ¿la baja mediante edición Activo/Inactivo es la operación prevista?
27. ¿Hay comportamientos conocidos o decisiones de producto adicionales que debamos considerar aceptados? Se registrarán por separado, sin darlos por pruebas superadas.
28. ¿Qué operaciones administrativas externas al TPV son parte del producto que se entrega ahora? La administración SaaS/Stripe y los interruptores globales no se modificarán para fabricar escenarios de usuario.
29. ¿El domicilio del destinatario debe ser obligatorio al pedir factura completa? El texto y la habilitación local del formulario no expresan el mismo requisito; falta contrastar el backend en ejecución.

Datos de ensayo propuestos: negocio `Restaurante Ensayo QA`, personas `QA Administrador`, `QA Encargado`, `QA Camarero`, `QA Cocina`, `QA Limpieza` y una persona reservada para bloqueos; categorías/productos de ensayo con importes/cantidades contrastables. Los PIN serán sintéticos y no se publicarán en evidencias de incidencias. Los campos privados opcionales se dejarán vacíos salvo caso específico con fixture sintético.

## 9. Orden previsto cuando se resuelva el contexto

1. Confirmar medio/versiones/aislamiento y cerrar el incidente de control de ventanas.
2. Preparar VM, identificar artefactos, instalar y activar; completar configuración inicial ficticia.
3. Vincular ambos Handy y crear el catálogo, personal, salón y clientes de ensayo.
4. Registrar concesiones iniciales y una prueba de servicio básica con evidencia en tres equipos.
5. Recorrer módulos y acciones condicionales; contrastar dinero/stock/caja/documentos.
6. Ejecutar capacidades positivas/negativas y cambios durante sesiones abiertas.
7. Probar simultaneidad, red y recuperación, guardando estados previos y resultados en tres equipos.
8. Ejecutar hardware, correos y estados de licencia con recursos de ensayo preparados.
9. Dejar restauraciones, revocaciones y actualización para el final, conservando evidencia de la candidata original.
10. Cerrar matriz e informe con cobertura real, incidencias reproducidas y limitaciones expresas.

## 10. Fuentes consultadas

Raíz de referencia: `C:\Users\diego\Desktop\tpv-completa`. Se han consultado documentación y fuentes relevantes; no se afirma haber leído cada archivo del monorepo.

- `C:\Users\diego\Desktop\tpv-completa\CLAUDE.md`, `README.md`, `docs\README.md`, `docs\pendientes.md` y revisión integral previa.
- `C:\Users\diego\Desktop\tpv-completa\docs\arquitectura\permisos.md`, `emparejamiento.md`, `licencias.md`, `sincronizacion.md`, `recuperacion.md`, `caja.md`, `tickets.md`, `verifactu.md`, `frontend.md`, `observabilidad.md` y `jobs-e-interruptores.md`.
- `C:\Users\diego\Desktop\tpv-completa\docs\guias\compilar-android.md`, `publicar-version.md` y estudio de compatibilidad Windows 7.
- `C:\Users\diego\Desktop\tpv-completa\apps\tpv-main\src\app\Router.tsx`, navegación, arranque, páginas de negocio, componentes/modales y módulos `features` correspondientes a la matriz.
- `C:\Users\diego\Desktop\tpv-completa\apps\tpv-main\src\shared\lib\usePermisos.ts`, `useInactivityLogout.ts`, `syncStatements.ts` y stores relacionados.
- `C:\Users\diego\Desktop\tpv-completa\crates\tpv-domain\src\permisos.rs`, `login.rs`, `verifactu.rs`, fixtures de validación y esquema inicial en `packages\database\migrations\0001_inicial.sql`.
- `C:\Users\diego\Desktop\tpv-completa\apps\tpv-main\src-tauri\src\commands`, transporte nativo, jobs y configuración Tauri; puertos/casos de uso relevantes de las crates.
- `C:\Users\diego\Desktop\tpv-completa\apps\cloud-worker-licensing\src` en rutas de emparejamiento/licencia/login, correo/reservas web y sincronización/validación; scripts de manifiesto de artefactos.
- `C:\Users\diego\Desktop\tpv-completa\apps\tpv-main\e2e\README.md` y `tests\contract\README.md` como contexto de arneses, sin ejecutarlos.

## 11. Registro de esta entrega

- Archivo de objetivo leído completo.
- Contexto dividido en tres revisiones paralelas de solo lectura: funciones, permisos y sincronización/caja/fiscal.
- Inventario técnico y hashes recogidos; no se han instalado, activado ni alterado los datos del TPV.
- Incidente de interacción del panel VirtualBox documentado y pendiente de cierre manual si hay aviso de permisos.
- Preguntas enviadas; pendiente de respuestas antes de iniciar la campaña funcional, conforme a la secuencia solicitada.
- Defectos nuevos del TPV reproducidos: ninguno. Cobertura E2E aprobada: ninguna todavía.
