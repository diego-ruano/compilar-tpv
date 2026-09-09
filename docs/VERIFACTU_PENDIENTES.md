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
| 4 | [`FechaOperacion`: hoy no se informa](#4-fechaoperacion-hoy-no-se-informa) | ⬜ | Nada; es una confirmación |
| 5 | [Qué hace la AEAT con un eslabón anterior que no tiene](#5-qué-hace-la-aeat-con-un-eslabón-anterior-que-no-tiene) | ⬜ | Nada; sale de la prueba |
| 6 | [La prueba contra la AEAT en preproducción](#6-la-prueba-contra-la-aeat-en-preproducción) | ⬜ | Pasar a producción con confianza |
| 7 | [`certificado_ok` no lo rellena nadie](#7-certificado_ok-no-lo-rellena-nadie) | ⬜ | Nada hoy; el panel no puede decir «no hay certificado» |

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

## 4. `FechaOperacion`: hoy no se informa

El registro puede llevar `FechaOperacion` además de `FechaExpedicionFactura`, y **hoy no se informa**
porque en un bar la operación y la expedición son el mismo instante: se consume y se cobra.

Donde dejaría de ser verdad: un catering o un evento que se factura días después, o una cuenta que se
abre un día y se cobra al siguiente (una comanda de madrugada cobrada por la mañana). Conviene que un
asesor lo confirme antes de producción.

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

## 7. `certificado_ok` no lo rellena nadie

`EstadoFiscal` declara `certificado_ok` y `dias_para_caducar_certificado`, y el comentario dice que
«los rellena la capa que conoce el almacén de certificados». **Esa capa no existe**: se dejan en
`false` / `None` y nadie los sobrescribe después, así que son dos campos muertos.

Hoy no rompe nada —la pantalla no los lee, y el panel de certificados enseña la lista y el botón de
probar— pero significa que `motivo_no_remite` no puede decir nunca «no hay certificado elegido» ni
«el certificado caduca en 12 días», que es justo el aviso que llega tarde si no se da con tiempo.

Lo natural es rellenarlos en `verifactu_estado` (el comando ya está en el shell, que es quien sabe
leer el almacén de Windows) en vez de en `estado_fiscal` de infra-sqlite, que no puede saberlo.
