# Veri\*factu: lo que queda abierto

El plan de [PLAN_VERIFACTU.md](PLAN_VERIFACTU.md) está implementado y probado. Lo que queda son
**decisiones y datos que no dependen del código**, y este fichero existe para que no se pierda
ninguna: se resuelven de una en una y se tacha aquí.

Estado: ⬜ sin empezar · 🟡 en curso · ✅ resuelto

| # | Qué | Estado | Bloquea |
|---|---|---|---|
| 1 | [Identidad del productor del software](#1-identidad-del-productor-del-software) | 🟡 **aplazado a propósito** | Producción; **ya no rompe nada mientras tanto** |
| 2 | [Texto de la declaración responsable](#2-texto-de-la-declaración-responsable) | ⬜ | Producción |
| 3 | [Serie de las rectificativas](#3-serie-de-las-rectificativas) | ✅ | — |
| 4 | [`FechaOperacion`](#4-fechaoperacion) | ✅ | — |
| 5 | [Qué hace la AEAT con un eslabón anterior que no tiene](#5-qué-hace-la-aeat-con-un-eslabón-anterior-que-no-tiene) | ⬜ | Nada; sale de la prueba |
| 6 | [La prueba contra la AEAT en preproducción](#6-la-prueba-contra-la-aeat-en-preproducción) | 🟡 **pasos 1-3 hechos** | Falta el envío real (paso 4) |
| 7 | [El estado del certificado](#7-el-estado-del-certificado) | ✅ | — |
| 8 | [La comprobación previa del art. 7.i)](#8-la-comprobación-previa-del-art-7i) | ✅ | — |
| 9 | [Modo «facturar en pruebas / formación»](#9-modo-facturar-en-pruebas--formación) | ✅ | — |

---

## 1. Identidad del productor del software

**Dónde vive:** `apps/tpv-main/src-tauri/src/lib.rs`, las cuatro constantes `PRODUCTOR_*`.

Van en el bloque `SistemaInformatico` de **cada** registro de facturación (art. 13 de la Orden
HAC/1177/2024). Describen a quien ha hecho el TPV, no al bar que lo usa.

Es **dato declarado**: la AEAT no lo contrasta contra ningún registro de actividad económica, así que
el epígrafe del productor es irrelevante para que un envío se acepte. Lo que sí valida es el
**formato** (el NIF tiene que tener nueve caracteres) y las **longitudes máximas**.

| Constante | Valor actual | Máx. | Falta |
|---|---|---|---|
| `PRODUCTOR_NOMBRE_RAZON` | `Altaria Lights` | 120 | Confirmar que es la razón social y no el nombre comercial |
| `PRODUCTOR_NIF` | **vacío** | 9 | **El NIF definitivo** |
| `PRODUCTOR_NOMBRE_SISTEMA` | `TPV Altaria` | 30 | Confirmar |
| `PRODUCTOR_ID_SISTEMA` | `01` | **2** | Confirmar |

**Decisión (2026-09-09): se aplaza a propósito.** Todavía no se sabe si el productor será un
autónomo o una sociedad, y la obligación no arranca hasta el 1 de enero. El programa se puede
comercializar y validar antes.

### Lo que se hizo para que aplazarlo sea seguro

Aplazarlo tenía una trampa que había que desactivar primero, porque era **silenciosa y definitiva**:

`Sistema_Json` se congela en la fila al emitir y **no se recompone al remitir** (correcto: el
registro de ayer tiene que seguir diciendo con qué versión del TPV se generó). Así que un registro
emitido con `PRODUCTOR_NIF` vacío lleva `"NIF":""` para siempre, la AEAT valida ese campo por formato
—nueve caracteres— y lo rechazaría. Rellenar la constante en una versión posterior **no toca las
filas ya escritas**: un bar que empezara a usar el TPV antes de que exista la empresa se quedaría con
un tramo de facturación imposible de presentar, y no se enteraría hasta el día de la inspección.

Tres piezas, y hacen falta las tres:

1. **El job se niega a remitir** sin identidad del productor (`productor_configurado`, que comprueba
   el NIF con su dígito de control: una errata es tan irremitible como un vacío). Los registros
   quedan `PENDIENTE`, que es un estado del que se sale; «rechazado por formato» no lo es.
2. **El panel y el aviso dicen de quién es la culpa.** `motivo_no_remite` pasa a
   `sin_datos_del_productor` y el texto cambia entero: *«esto es un problema del programa, no tuyo;
   las facturas están guardadas y se enviarán solas al actualizar»*. Mandar a un bar a revisar su
   router por un fallo nuestro le hace perder una tarde y le enseña a ignorar el único aviso que no
   puede ignorar.
3. **Al arrancar con la constante puesta, se corrigen solos** (`reparar_sistema_informatico`). Es la
   única escritura que toca una tabla append-only, y es legítima porque cumple las tres condiciones:
   `SistemaInformatico` **no entra en la cadena de huella** (son emisor, número, fecha, tipo, cuota,
   importe, huella anterior y fecha-hora), no toca ningún dato de la factura, y sólo alcanza a
   registros que la AEAT no tiene.

O sea que hoy se puede vender, emitir y encadenar; lo único que no se puede es remitir, y eso se
desbloquea solo el día que se rellene la constante.

Mientras `PRODUCTOR_NIF` esté vacío, el panel de la declaración responsable **dice que está
incompleta** en vez de enseñarla a medias.

---

## 2. Texto de la declaración responsable

**Dónde vive:** `apps/tpv-main/src-tauri/src/commands/verifactu.rs`, `TEXTO_DECLARACION`.

El texto actual es un **borrador** que recoge lo que el art. 13 RRSIF exige declarar (registro de
alta por factura, encadenamiento SHA-256, conservación sin modificación, modalidad VERI\*FACTU, QR y
leyenda, imposibilidad de llevar contabilidades paralelas). Lo que falta es revisarlo con la empresa
constituida y, si procede, con un asesor: **es una declaración con consecuencias** y la firma el
productor, no el programa.

---

## 3. Serie de las rectificativas ✅

**Resuelto (2026-09-09), y no era una decisión: era un incumplimiento.**

Estaba anotado aquí como «algunos asesores prefieren una serie propia». Al leer el reglamento resultó
no ser una preferencia:

> *Art. 6.1.a) RD 1619/2012:* «será obligatoria, **en todo caso**, la expedición en series
> específicas de las facturas siguientes: […] **2.º Las rectificativas.**»

Las rectificativas (`R1`–`R5`) pasan a su propia serie, `R2027/000001`, con su propio contador. El
código y un test decían lo contrario y lo justificaban con «serían dos contadores que mantener»: es
cierto, y da igual — no es un argumento contra un «en todo caso».

**La `F3` se queda en la serie ordinaria**, y eso también sale del reglamento:

> *Art. 15.6:* «las facturas que se expidan en sustitución o canje de facturas simplificadas
> expedidas con anterioridad **no tendrán la condición de rectificativas**.»

Mandar la `F3` a la serie `R` sería declarar como rectificación algo que la norma dice expresamente
que no lo es.

---

## 4. `FechaOperacion` ✅

**Resuelto (2026-09-09). Tampoco era una preferencia.**

Estaba anotado como «conviene que un asesor lo confirme». El reglamento lo dice sin necesidad de
asesor, y con la misma redacción para los dos tipos de factura:

> *Art. 6.1.i)* (factura completa) **y** *art. 7.1.c)* (simplificada), RD 1619/2012: «La fecha en que
> se hayan efectuado las operaciones que se documentan […] **siempre que se trate de una fecha
> distinta a la de expedición de la factura**.»

Que el art. 7 lo repita es lo que decide el caso: el 99 % de las facturas de un bar son
simplificadas, así que la obligación alcanza a los tickets, no sólo a las facturas con NIF.

La regla tiene **dos mitades** y las dos están implementadas: se informa si la fecha difiere, y **no**
se informa si coincide (la AEAT ya interpreta la ausencia como «igual a la de expedición» — lo dicen
sus propios códigos de error, que repiten *«FechaExpedicionFactura si no se informa
FechaOperacion»*). El filtro vive en `emitir_alta`, no en cada llamante, para que no dependa de que
todos se acuerden.

Los tres casos en que no coinciden, y de dónde sale la fecha en cada uno:

| Caso | Fecha de operación |
|---|---|
| Una comanda que **cruza la medianoche** | La de apertura de la comanda |
| Una **rectificativa** (`R5`) de una venta de otro día | La de la factura original |
| Una **`F3`** que canja un ticket anterior | La del ticket sustituido |

El segundo y el tercero son mucho más frecuentes que el primero: una devolución o un canje casi
nunca son del mismo día. El primero es el que se ve venir y el que menos pasa.

`FechaOperacion` **no entra en la cadena de huella**, así que añadirlo no invalida ninguna huella ya
calculada. Hay un test que lo comprueba sobre la cadena real, no sobre una lista de campos.

---

## 5. Qué hace la AEAT con un eslabón anterior que no tiene

Si se remite un registro cuyo `Encadenamiento/RegistroAnterior` declara una huella que la AEAT nunca
ha recibido, ¿qué devuelve?

**Casi resuelto sin enviar nada (2026-09-09)**, leyendo el catálogo oficial de errores
(`crates/tpv-infra-aeat/esquemas/errores.properties`):

- **No existe ningún código** para «el registro anterior no existe en la AEAT».
- **Sí existe el `2007`** —*«No debe informarse como primer registro, existen facturas emitidas con el
  obligado emisión y el sistema informático actual»*— y está en la banda **admisible (2000–2999)**:
  aceptado con errores, no rechazado. O sea que la AEAT **sí sabe** si tienes registros previos, y el
  caso contrario al de esta pregunta lo trata como admisible.
- Los errores del encadenamiento son de **formato** (`1180` «Error en el bloque de Encadenamiento»,
  `1269` «El bloque Registro Anterior no está informado correctamente» → rechazo) o de **contenido de
  la huella** (`2000`, `2002`, `2003`, `2008` → admisibles).

Lo que se deduce: la AEAT comprueba que la huella del registro **actual** esté bien calculada con los
datos suministrados —incluida la huella anterior que se declare—, no que ese eslabón exista en su
base. Con lo cual **partir de cero antes de producción es limpio**, y equivocarse al revés (declarar
primer registro teniendo ya facturas) es un `2007` admisible, no un muro.

Queda como «muy probable» hasta el primer envío real, que es lo único que lo convierte en certeza.

---

## 6. La prueba contra la AEAT en preproducción

Los cuatro escalones están en [PRUEBAS_AEAT.md](PRUEBAS_AEAT.md). Los dos primeros ya pasan y no
tocan ni el certificado ni internet.

**Averiguado el 2026-09-09**, en palabras de la propia AEAT ([preportal.aeat.es](https://preportal.aeat.es/)):

> «Este portal tiene por finalidad facilitar las pruebas de presentación y consulta de declaraciones
> tributarias a los usuarios externos de la Agencia Tributaria, **de forma totalmente libre, con la
> única condición de autenticarse mediante un certificado electrónico**.»
>
> «Las declaraciones presentadas a través de este Portal se guardan en una Base de Datos del entorno
> de pruebas de la AEAT, **sin que en ningún caso tengan trascendencia tributaria**.»
>
> «este entorno solo se debe utilizar para realizar este tipo de **pruebas puntuales** y en ningún
> caso para realizar pruebas masivas […] Si se detectan usos que se consideren abusivos se podrán
> adoptar medidas para bloquear el acceso.»

Tres consecuencias:

1. **No hay alta ni registro previo.** Este documento decía antes que sí; era falso, y no venía de
   ninguna fuente. Basta el certificado.
2. **No es ficticio: es sin efectos.** Lo que se manda se guarda de verdad en la base de pruebas, con
   el certificado y el NIF reales. Lo que no tiene es trascendencia tributaria. La mitad que **sí es
   completamente real** es la nuestra: los registros que emita el TPV ocupan su `Orden`, gastan número
   y entran en la cadena de huellas locales, con o sin efectos al otro lado. De ahí la regla de partir
   de cero antes de producción.
3. ⚠️ **«Pruebas puntuales, no masivas.»** Dejar un TPV apuntando a preproducción y remitiendo cada
   60 s indefinidamente va justo contra eso. Las pruebas se hacen y el entorno se devuelve a
   producción; no es un sitio donde vivir.

### Estado: pasos 1, 2 y 3 hechos (2026-09-09)

- **Paso 1** (aritmética) y **paso 2** (XML contra los XSD): pasan, y no tocan ni certificado ni red.
- **Paso 3** (*handshake*): ✅ **hecho contra preproducción con un certificado real.** El TLS mutuo
  funciona, no pidió PIN, el endpoint es el correcto y nuestro parser leyó la respuesta SOAP. Con el
  NIF del obligado de verdad la cabecera pasó entera —ni 4104 «no identificado en el censo» ni 4112
  «el titular del certificado debe ser Obligado Emisión…»—, así que la autorización también está
  cubierta. Detalle en [PRUEBAS_AEAT.md](PRUEBAS_AEAT.md) §3.2.

  Esto es lo que valida **la decisión arquitectónica de más riesgo del proyecto**: usar WinHTTP en
  lugar de `rustls-cng`. Ya no es un razonamiento sobre CSP legacy y NCrypt, es una conexión
  establecida contra el servidor real.
- **Paso 4** (envío real): pendiente. Es el único que emite un registro.

Sigue haciendo falta decidir **con qué NIF se prueba**: el certificado tiene que ser titular o apoderado del
NIF que vaya como obligado, o el envío se queda en un problema de autorización en vez de probar el TPV.

---

## 7. El estado del certificado ✅

**Resuelto (2026-09-09).**

`EstadoFiscal` declaraba `certificado_ok` y `dias_para_caducar_certificado` con un comentario que
decía que los rellenaría «la capa que conoce el almacén de certificados». Esa capa no existía, así
que eran dos campos muertos. El síntoma no era un fallo sino un **silencio**: el panel no podía decir
«no hay certificado» ni «caduca en 12 días».

Los rellena ahora `verifactu_estado`, que vive en el shell y es quien sabe leer el almacén de
Windows. `motivo_no_remite` gana cuatro causas —`sin_certificado`, `certificado_no_encontrado`,
`certificado_caducado`, `certificado_pide_pin`— **sin pisar** las que pone la capa de datos: «faltan
tus datos fiscales» impide hasta cobrar, así que ir antes con el certificado sería mandar al usuario
al tercer problema de la lista.

Lo que de verdad añade esto es un **aviso que llega a tiempo**. El del atraso mide horas de cola, o
sea que llega tarde por definición: cuando salta, ya se ha dejado de remitir. El del certificado
avisa **a 30 días** (aviso) y **a 7** (error), que es cuando renovar todavía es un trámite de
gestoría y no una urgencia. Y hay un caso que nadie ve venir y que ahora se dice solo: el certificado
que **estaba y ya no**, porque se renovó —la huella cambia— o porque se entró con otro usuario de
Windows.

Con el certificado ausente o caducado el job **ni lo intenta**: el handshake fallaría seguro y sería
una conexión TLS por minuto para nada. Con el que pide PIN sí lo intenta, porque ahí puede haber
alguien delante y negarlo garantizaría el fallo donde había una posibilidad.

---

## 8. La comprobación previa del art. 7.i) ✅

**Resuelto el 2026-09-09.** Encontrado el mismo día leyendo el
[FAQ de desarrolladores de la AEAT](https://sede.agenciatributaria.gob.es/static_files/AEAT_Desarrolladores/EEDD/IVA/VERI-FACTU/FAQs-Desarrolladores.pdf)
(apartado 15), que cita el art. 7.i) de la Orden HAC/1177/2024:

> «Salvo cuando se trate del primer registro de facturación, cada vez que el sistema informático vaya
> a generar un nuevo registro de facturación, de alta o de anulación, antes deberá comprobar que se
> cumplen los siguientes requisitos:
> **1.º** El último registro de facturación generado está correctamente encadenado.
> **2.º** La fecha y hora de generación del último registro de facturación generado **no es superior
> en más de un minuto** a la fecha y hora actuales que se utilizarán para fechar el registro de
> facturación a generar.»

**No hacemos ninguna de las dos.** Emitimos leyendo el último eslabón (`ultimo_eslabon`) y encadenando,
pero sin verificar que ese eslabón esté a su vez bien encadenado con el suyo, ni comparar relojes.

### Qué alcance tiene realmente

Honestamente: **es ambiguo si obliga a un SIF «SOLO VERI\*FACTU» como el nuestro.** El art. 7 de la
Orden está escrito en general, pero las dos veces que el FAQ concreta esta comprobación la acota a la
modalidad **NO** VERI\*FACTU —porque lo que hay que hacer al fallar es *anotar un evento*, y el
registro de eventos solo es obligatorio ahí (NOTA 1 del mismo apartado, que de paso **confirma** que
nuestro `TipoUsoPosibleSoloVerifactu = "S"` nos exime del registro de eventos)—.

### Por qué conviene hacerla igual

El punto 2.º tiene un argumento que no depende de cómo se lea la norma: **detecta el reloj que va
hacia atrás** (corrección NTP, cambio manual, un equipo con la pila de la BIOS gastada). Si eso pasa:

- generamos registros con `FechaHoraHusoGenRegistro` decreciente, que es lo que un sistema manipulado
  produciría, y
- la AEAT los marca con el error **2004** (*«debe ser la fecha actual del sistema de la AEAT»*),
  admisible pero acumulable.

Y el FAQ deja clara una cosa sobre qué hacer cuando la comprobación falla, que sí cumplimos y hay que
seguir cumpliendo:

> «será preciso generar el siguiente RF, ya que **la facturación por este motivo NUNCA debe
> interrumpirse**.»

O sea: detectarlo y avisar, nunca dejar de facturar.

### Cómo quedó

- La aritmética vive en `tpv_domain::verifactu::comprobar_registro_previo`, pura y con sus once tests
  de borde. Devuelve **qué** ha encontrado, no si se puede facturar.
- Se ejecuta en `estado_de_la_cadena`, que lee las **dos** últimas filas en la misma consulta que ya
  leía el eslabón anterior: cero viajes de más en el camino del cobro. La FAQ ya avisaba de que el
  coste no debe notarse.
- Cubre los **dos** caminos, alta y anulación, porque el art. 7.i) dice «de alta o de anulación».
- Al detectar algo se anota en `_Verifactu_Anomalias` (tabla local, por `raw()`, no se replica) y se
  registra como `error` en el log. **Nunca impide emitir ni cobrar**, y la anotación es best-effort:
  que falle el diagnóstico no puede tumbar la venta.
- Sale en el panel **lo primero de la pantalla** y en una notificación al Administrador. Se pueden
  marcar como vistas; las filas se conservan, porque lo que registran siguió pasando.

### Lo que esto NO es

No es el **registro de eventos** del RRSIF, y conviene no confundirlos. Ese sólo es obligatorio para
los SIF que pueden actuar en modalidad NO VERI\*FACTU, y la NOTA 1 del apartado 15 del FAQ lo dice:

> «El productor de un SIF que solo puede actuar exclusivamente en modo VERI\*FACTU ("SOLO
> VERI\*FACTU"), **no está obligado a implementar en él un registro de eventos**, pero puede hacerlo
> voluntariamente, si así lo desea.»

Nuestro `TipoUsoPosibleSoloVerifactu = "S"` nos deja en ese lado. Lo que se ha hecho es la parte útil:
que una anomalía no se quede en un log que nadie abre.

---

## 9. Modo «facturar en pruebas / formación» ✅

**Resuelto el 2026-09-09.** Salía del FAQ (apartado 11, págs. 22-23). No era un incumplimiento: es
una funcionalidad que la AEAT **recomienda expresamente**.

El problema que resuelve es real y llega el día que el bar estrene el TPV o forme a un camarero:

> «si se desea poder probar el SIF, deberá ser con el certificado electrónico cualificado válido y
> admitido instalado […] Desde ese momento, el usuario puede ya expedir facturas con él, que **siempre
> serán "reales"** (con su QR tributario, y cuyos RF de alta son remitidos a la AEAT) pero, en este
> caso, al ser expedidas con la intención de hacer pruebas […] **deberá procederse a la inmediata
> posterior anulación de ellas** (para que no cuenten como facturas reales).»

Y sugiere la solución:

> «el SIF podría ofrecer una funcionalidad de "facturar en pruebas (o formación)" ya preparada para que
> haga todo esto automáticamente: dejar al usuario expedir facturas "reales" […] pero "para
> pruebas/formación" (que deberá poder distinguir, por ejemplo, con numeración en **una serie especial
> de tipo PRU 25 XXXX**), describirlas visible y claramente como "de pruebas" y asegurarse de que
> **siempre serán anuladas** (con remisión de RF de anulación a la AEAT) una vez terminadas.»

Sin esto, la alternativa para el usuario es acordarse de anular a mano cada factura de prueba — y el
día que se le olvide una, queda una venta ficticia contada como real y sin forma de quitarla salvo
otro registro de anulación.

### Cómo quedó

Un interruptor en **Configuración → Fiscal → «Probar o enseñar el TPV»**, y una regla que lo sostiene
todo: **apagarlo ES la anulación**, no un paso aparte que se pueda saltar.

- Mientras está encendido, cada factura va a la serie **`PRU<año>`** y su descripción lleva delante
  `PRUEBAS/FORMACION - `. Las dos cosas las pide el FAQ literalmente.
- La serie de formación **manda sobre el tipo**: una rectificativa emitida durante unas pruebas
  también es una factura de pruebas, y lo que las agrupa no es qué documentan sino que hay que
  anularlas todas.
- **No gastan número de la serie real.** El camino del cobro reserva el número *antes* de saber en
  qué modo está el negocio, así que en formación ese número se descarta; usarlo dejaría un hueco en
  el libro de ventas que no corresponde a ninguna factura.
- **Cerrar el modo anula todas las que queden vivas**, en orden de emisión y **en una transacción**:
  si algo falla a mitad no queda ni el interruptor cambiado ni media tanda anulada. Las anulaciones
  se encolan para remitir, porque anular sin remitir deja la factura de prueba viva en la AEAT — que
  es justo el problema que esto resuelve.
- **Una tanda sin cerrar se sigue viendo con el modo apagado.** El panel cuenta las facturas de
  prueba vivas aunque el interruptor esté en «off», así que el ciclo no puede quedarse a medias en
  silencio.

Ocho tests, y el que justifica la funcionalidad entera es `cerrar_el_modo_ANULA_todas_las_facturas_de_prueba`.
Los otros dos que importan: que las pruebas **no se lleven por delante una venta real** anterior, y
que cerrar dos veces no vuelva a anular.
