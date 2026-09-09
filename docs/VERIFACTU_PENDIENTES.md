# Veri\*factu: lo que queda abierto

El plan de [PLAN_VERIFACTU.md](PLAN_VERIFACTU.md) está implementado y probado. Lo que queda son
**decisiones y datos que no dependen del código**, y este fichero existe para que no se pierda
ninguna: se resuelven de una en una y se tacha aquí.

Estado: ⬜ sin empezar · 🟡 en curso · ✅ resuelto

| # | Qué | Estado | Bloquea |
|---|---|---|---|
| 1 | [Identidad del productor del software](#1-identidad-del-productor-del-software) | 🟡 | **Producción entera** |
| 2 | [Texto de la declaración responsable](#2-texto-de-la-declaración-responsable) | ⬜ | Producción |
| 3 | [Serie de las rectificativas: única o separada](#3-serie-de-las-rectificativas-única-o-separada) | ⬜ | Nada; cambiarlo después es migrar datos |
| 4 | [`FechaOperacion`: hoy no se informa](#4-fechaoperacion-hoy-no-se-informa) | ⬜ | Nada; es una confirmación |
| 5 | [Qué hace la AEAT con un eslabón anterior que no tiene](#5-qué-hace-la-aeat-con-un-eslabón-anterior-que-no-tiene) | ⬜ | Nada; sale de la prueba |
| 6 | [La prueba contra la AEAT en preproducción](#6-la-prueba-contra-la-aeat-en-preproducción) | ⬜ | Pasar a producción con confianza |

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

## 3. Serie de las rectificativas: única o separada

Hoy las rectificativas (`R1`–`R5`) y las sustitutivas (`F3`) **comparten serie** con las facturas
normales: `2027/000123`, un solo contador por ejercicio.

Es correcto y la norma no obliga a separarlas, pero algunos asesores prefieren una serie propia
(`R-2027/000001`) para que el libro se lea de un vistazo. La decisión importa **ahora y no después**:
cambiarla con registros ya emitidos es migrar datos de una tabla append-only, que es exactamente lo
que no se puede hacer.

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
