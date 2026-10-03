# Probar Veri\*factu contra la AEAT

Cómo comprobar, de menos a más compromiso, que lo que el TPV manda a Hacienda es correcto y que
Hacienda lo acepta. Son **cuatro escalones**: cada uno se puede hacer sin el siguiente, y los dos
primeros no tocan ni el certificado ni internet. Al final están los bancos de prueba que fijaron el
comportamiento real de la AEAT.

> **Nada de esto se ejecuta solo.** Todo se lanza a mano, y lo que pasa del paso 2 usa un
> certificado digital real. La aplicación, en su funcionamiento normal, sólo remite, y sólo contra el
> entorno de `Business_Settings.Verifactu_Entorno`.
>
> Este fichero se queda en `docs/PRUEBAS_AEAT.md` porque la pantalla Configuración → Fiscal lo cita
> por esa ruta. Cómo funciona el sistema: [arquitectura/verifactu.md](arquitectura/verifactu.md).

| # | Qué comprueba | Necesita | Riesgo |
|---|---|---|---|
| 1 | Que la **aritmética** (huella, QR, NIF, desglose) es la oficial | nada | ninguno |
| 2 | Que el **XML** valida contra los XSD oficiales | Python + `xmlschema` | ninguno |
| 3 | Que el **certificado** sirve para el TLS mutuo con la AEAT | certificado instalado + internet | ninguno: la sonda va **sin facturas** |
| 4 | Que la AEAT **acepta un registro de verdad** | certificado | ninguno en Hacienda (preproducción no tiene trascendencia tributaria); en el TPV **sí** gasta número y cadena |

---

## Paso 1 · La aritmética, sin red

```bash
cargo nextest run -p tpv-domain verifactu
cargo nextest run -p tpv-domain ticket
```

Incluye los **tres vectores oficiales** de la huella (primer alta, alta encadenada y anulación
encadenada) y el vector oficial del QR con un `&` en el número de serie. Además: el dígito de control
del NIF/NIE/CIF, `fmt_importe` y el desglose de IVA con su regla de que base más cuota dan el total.

## Paso 2 · El XML contra los esquemas oficiales

```bash
pip install xmlschema          # la primera vez
pnpm verifactu:validar-xml
```

Genera **12 muestras** (alta simplificada, con destinatario, varios tipos de IVA, al 0 %, `F3`,
anulación, subsanación, operación de otro día…) y las valida contra los XSD de
`crates/tpv-infra-aeat/esquemas/`, descargados de la sede sin tocar. Las 12 tienen que pasar; el
script está probado en negativo (si se rompe un campo a mano, falla).

Para ver el XML sin validarlo: `cargo run -q -p tpv-infra-aeat --example muestras_xml`.

Las muestras **no se pueden enviar** por el cliente web de la AEAT: el obligado es un NIF ficticio y
las fechas son de 2027 (la AEAT exige una `FechaHoraHusoGenRegistro` actual —error 2004— y una fecha
de operación no futura —error 1173—).

## Paso 3 · El certificado y el *handshake*

### Ver qué hay instalado

```bash
pnpm verifactu:certificados
```

Lista los certificados **con clave privada** de `CurrentUser\My` y `LocalMachine\My`, con su huella
(SHA-1, lo único que la aplicación guarda), el almacén, si se puede usar **sin diálogos** y si es de
sello de entidad (decide el endpoint).

- El almacén personal es **por usuario de Windows**: hay que instalar el certificado en la sesión
  desde la que se usa el TPV.
- Un `.cer` o un `.crt` no valen: sólo llevan la parte pública.
- ⚠️ **Un certificado con «uso silencioso: no» no sirve para remitir solo.** Pide contraseña o PIN en
  cada envío; el envío espera hasta agotar su timeout, el job lo anota como intento fallido y repite
  en el ciclo siguiente. No se pierde ninguna factura, pero no se remite ninguna. Si es un `.p12`, se
  arregla reimportándolo **sin** «habilitar la protección segura de claves privadas»; si es el PIN de
  una tarjeta o del DNIe, hace falta otro certificado.

### La sonda

```bash
pnpm verifactu:probar-aeat -- <huella>                              # sólo el transporte
pnpm verifactu:probar-aeat -- <huella> pruebas <NIF> "Razon Social" # transporte y autorización
```

El entorno por defecto es `pruebas`; para producción hay que escribir `produccion` entero. Manda un
sobre SOAP **sin registros** con el certificado como credencial de cliente. Lo mismo hace
**Configuración → Fiscal → Certificado electrónico → Probar**, con los datos del obligado si están.

**La señal de éxito es un error**:

| Respuesta | Qué demuestra |
|---|---|
| `4116` (NIF de relleno con formato incorrecto) | El TLS mutuo funcionó y el servidor nos leyó |
| `4102` («falta informar RegistroFactura») con el obligado real | Además, la cabecera pasó: el NIF está censado (si no, `4104`) y el titular del certificado está autorizado sobre él (si no, `4112`) |

La AEAT valida la cabecera antes que el cuerpo, por eso llegar al `4102` cubre la autorización.

| Si falla | Qué es |
|---|---|
| Sale un diálogo de PIN o contraseña | El certificado no sirve para el envío automático |
| Error de TLS o de cadena | Un proxy o antivirus con inspección TLS en medio |
| Certificado caducado o revocado | Renovarlo; la huella cambia y hay que volver a elegirlo |
| `4112` | El titular no está autorizado sobre ese NIF. Lo más simple: que el obligado sea el mismo NIF del certificado; si no, el apoderamiento en la sede («suministro de registros de facturación») |

## Paso 4 · Un envío de verdad, en preproducción

### El entorno de preproducción

<https://preportal.aeat.es/>: se usa **sin alta ni registro**, sólo autenticándose con certificado.
Lo enviado se guarda en una base de pruebas «sin que en ningún caso tenga trascendencia
tributaria», y la AEAT pide **pruebas puntuales**, no masivas, con bloqueo ante usos abusivos.

⚠️ Lo que sí es real es la parte del TPV: los registros emitidos ocupan su `Orden`, gastan número y
entran en la cadena local. Por eso hay que **partir de cero** antes de producción (abajo), y por eso
no se deja un TPV en `pruebas` remitiendo cada minuto durante semanas.

En el portal, VERI\*FACTU tiene un cliente de servicio web (el endpoint nuestro es
`/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP`; `RequerimientoSOAP` y `ValRegistroNoVF` son de
la modalidad no verificable), la aplicación gratuita de la AEAT y la **consulta de registros
recibidos**.

### Con el arnés (sin tocar el TPV instalado)

```bash
pnpm verifactu:ciclo -- <huella> <NIF> "Razon Social"
```

Usa una base **dedicada** (`target/verifactu-pruebas/`), emite dos altas por el camino de verdad, las
remite, las anula y remite las anulaciones. Volver a empezar es borrar esa carpeta (también hace
falta cuando cambia `0001_inicial.sql`: la base vieja ya no abre).

Cada respuesta de la AEAT queda en bruto en `target/verifactu-pruebas/respuestas/`. De ahí salen
las de `crates/tpv-infra-aeat/testdata/`, que prueban el parser contra lo que contesta de verdad la
AEAT; al copiar una nueva, **anonimízala** (NIF, nombre del titular y CSV).

### Desde la aplicación

1. **Configuración → Fiscal → Datos fiscales del negocio**: razón social y NIF. Lo más simple es el
   NIF del titular del certificado. Se valida con su dígito de control.
2. **Modo prueba desactivado**: con él activado los cobros no emiten registro.
3. **Certificado electrónico → Buscar**, elegir y **Usar este**.
4. **Entorno de la AEAT → Pruebas**. Mientras lo esté, el panel de «Envío a la AEAT» lo dice en
   amarillo y el ticket lleva un QR al portal de pruebas. Si no lo dice, el equipo apunta a
   **producción**.
5. Cobrar una venta cualquiera. El ticket sale con el **QR tributario arriba** y la leyenda
   `VERI*FACTU`.
6. **Envío a la AEAT** enseña pendientes, aceptadas, con avisos y rechazadas. Entre cobrar y ver
   «aceptada» pasan dos o tres minutos: el job corre cada 60 s, arranca al minuto y la AEAT impone su
   control de flujo (60 s al principio, o 1000 registros).

> ⚠️ Mientras `PRODUCTOR_NIF` esté vacío, la aplicación **no remite** (motivo
> `sin_datos_del_productor`). El arnés `verifactu:ciclo` sí remite, porque inyecta su propio bloque
> del productor.

| Contador | Qué significa |
|---|---|
| Aceptadas | La AEAT lo tiene y se guarda su CSV |
| Con avisos | Lo tiene, pero hay que subsanarlo (2000–2999) |
| Rechazadas | No lo tiene. Se corrige y se pulsa «Volver a mandarlas corregidas» |
| Pendientes | Aún no ha salido (control de flujo, sin red, sin certificado) |

### Comprobarlo del otro lado

1. En el portal de preproducción, la consulta de registros recibidos para ese NIF: mismo número y
   fecha.
2. Escanear el QR del ticket: lleva al cotejo (de pruebas) y debe reconocer la factura.
3. **Exportar los registros de facturación** del día: con `cadena.txt` cada huella se recalcula sin
   nuestro código:

```bash
python -c "import hashlib,sys; print(hashlib.sha256(sys.argv[1].encode()).hexdigest().upper())" "<la cadena>"
```

---

## Lo que contesta la AEAT de verdad

Resultados contra preproducción que el diseño da por buenos. Si se cambia algo de lo que dependen,
hay que volver a pasar el banco correspondiente.

### Banco adversario

```bash
pnpm verifactu:errores -- <huella> <NIF> "Razon Social"
```

Emite registros válidos, manipula su fila y compara el código que devuelve la AEAT con el esperado.

| Caso | Código de la AEAT |
|---|---|
| Huella incorrecta | 2000 |
| `ImporteTotal` que no cuadra con el desglose | 2005 |
| Fecha de generación de hace tres días | 2004 |
| `F2` con destinatario | 1190 |
| `F1` sin destinatario | 1189 |
| `F2` por encima de 3.000 € | 1150 |
| Registro sano | aceptado |
| **Reenviar lo mismo** | **3000**, que `clasificar` trata como aceptado |
| **`CuotaTotal` que no cuadra** | **aceptado, sin código** |
| Caracteres `< > " =` en `DescripcionOperacion` (escapados) | aceptado, sin código |

- El **3000** es la idempotencia de todo el sistema: reenviar tras un corte, una restauración o un
  reintento converge.
- **Una `CuotaTotal` descuadrada no la detecta la AEAT.** La única red es la aritmética del dominio
  (la cuota es lo que falta hasta el total) y sus tablas de golden.
- `sanear_texto` quita esos caracteres aunque la AEAT los acepte escapados en ese campo: el error
  1287 lleva el nombre del campo como parámetro y puede aplicar a otros.

Dos cosas sobre el orden de validación de la AEAT: los errores de formato (`1xxx`) van antes que los
de contenido (`2xxx`), y dentro de éstos la huella (2000) va primero, así que manipular un campo que
entra en la huella sin recalcularla sólo enseña el 2000. Y la numeración tiene que ser única entre
tandas, o el 3000 tapa el error que se quería ver (el banco salta el contador a un número alto).
Cuando falla la huella, la AEAT devuelve la cadena que usó y el hash que le salió.

### Cadenas que no cuadran

```bash
pnpm verifactu:experimento -- <huella> <NIF> "Razon Social"
```

| Experimento | Resultado |
|---|---|
| A — remitir un registro cuyo eslabón anterior la AEAT nunca recibió | **Aceptado, sin error.** La AEAT comprueba que la huella actual cuadre con los datos enviados, no que el anterior exista en su base |
| B — `PrimerRegistro='S'` con un NIF para el que ya hay registros | **Aceptado con errores, 2007.** Admisible: cuenta como presentado |

El 2007 depende de **(obligado + sistema informático)** y preproducción y producción son bases
separadas: si sólo se ha probado en preproducción, el primer registro de producción es genuinamente
el primero.

### Límites

```bash
pnpm verifactu:limites -- <huella> <NIF> "Razon Social"
```

- **Un lote de 1000 registros** (unos 2 MB de XML) sube por WinHTTP en unos 3 s y la respuesta se
  parsea entera. El único aviso que dio fue un 2007 en el primero, por pruebas anteriores con ese NIF.
- **La subsanación de un rechazo**: se provoca un rechazo (`F1` sin destinatario, 1189), se emite la
  subsanación (mismo `Num_Serie_Factura`, `Subsanacion=S`, `RechazoPrevio=X`, su propio eslabón) y la
  AEAT la acepta. Volver a subsanar no emite nada: ya tiene una por delante.

---

## Volver a producción: hay que partir de cero

Los registros emitidos ensayando en preproducción son registros de este equipo, y la AEAT de
producción no los tiene. Seguir cobrando tras cambiar el entorno haría que el primer registro real
declarase como anterior una huella que Hacienda nunca vio: se aceptaría (experimento A), pero la
cadena no empezaría donde debe.

Lo limpio es que el primer registro de producción sea el primero (`PrimerRegistro='S'`, que el código
pone solo cuando no hay ninguno). Mientras no haya clientes en producción se hace como cualquier
reinicio de esquema: **resetear la `data.db`** del equipo y el tenant Turso de desarrollo
([arquitectura/esquema.md](arquitectura/esquema.md)). No hay ni debe haber un botón para borrar los
registros: la tabla es *append-only* por norma. Al pasar a producción con registros ya emitidos, la
pantalla lo advierte en rojo con el número delante.

## Lo que no hay que hacer

- **Apuntar a producción para «probar».** Un registro enviado a producción es real y no se borra:
  como mucho se anula con otro registro, que también queda.
- **Cambiar el NIF del obligado con registros ya emitidos.** Empieza otra cadena. La pantalla lo
  avisa, pero no lo impide.
- **Dejar el TPV en preproducción de fondo.** La AEAT pide pruebas puntuales y el job remite cada
  minuto.
- **Restaurar una copia local antigua después de haber remitido.** Se pierde un tramo de cadena que la
  AEAT ya tiene. Para volver de una avería, la nube ([arquitectura/recuperacion.md](arquitectura/recuperacion.md)).

## Antes del primer envío real

Además de lo que lista [pendientes.md](pendientes.md#verifactu) (identidad del productor, declaración
responsable, quitar el modo prueba):

- [ ] El certificado del bar instalado en la sesión de Windows del TPV, con uso silencioso, y el
      obligado igual al titular (o el apoderamiento hecho).
- [ ] Los registros de las pruebas borrados (arriba).
- [ ] El entorno en **produccion**, comprobado en el panel.
