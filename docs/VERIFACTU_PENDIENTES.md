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
| 6 | [La prueba contra la AEAT en preproducción](#6-la-prueba-contra-la-aeat-en-preproducción) | ⬜ | Pasar a producción con confianza |
| 7 | [El estado del certificado](#7-el-estado-del-certificado) | ✅ | — |

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
ha recibido, **no sé con certeza qué devuelve**: un rechazo, o un «aceptado con errores» de la banda
2000–2999.

No cambia ninguna recomendación —partir de cero antes de producción es correcto en los dos casos, ver
[PRUEBAS_AEAT.md](PRUEBAS_AEAT.md)— pero sí cuánto margen hay si alguien se lo salta. **No se
inventa: sale del primer envío de prueba.**

---

## 6. La prueba contra la AEAT en preproducción

Los cuatro escalones están en [PRUEBAS_AEAT.md](PRUEBAS_AEAT.md). Los dos primeros ya pasan y no
tocan ni el certificado ni internet. Los dos últimos necesitan:

- el **alta en preproducción** de la AEAT con el NIF con el que se va a probar (trámite suyo);
- **autorización explícita para usar el certificado digital** en el *handshake*.

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
