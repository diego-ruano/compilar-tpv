# Probar Veri\*factu contra la AEAT

Cómo comprobar, de menos a más compromiso, que lo que el TPV manda a Hacienda es correcto y que
Hacienda lo acepta. Son **cuatro escalones** y están ordenados a propósito: cada uno se puede hacer
sin haber hecho el siguiente, y los dos primeros no tocan ni el certificado ni internet.

> **Nada de esto se ejecuta solo.** Los cuatro pasos se lanzan a mano, y los dos últimos usan un
> certificado digital real. La aplicación, en su funcionamiento normal, sólo hace el paso 4 y sólo
> contra el entorno que diga `Business_Settings.Verifactu_Entorno`.

---

## Resumen

| # | Qué comprueba | Necesita | Riesgo |
|---|---|---|---|
| 1 | Que la **aritmética** (huella, QR, NIF, desglose) es la oficial | nada | ninguno |
| 2 | Que el **XML** valida contra los XSD oficiales | Python + `xmlschema` | ninguno |
| 3 | Que el **certificado** sirve para el TLS mutuo con la AEAT | certificado instalado + internet | ninguno: la sonda va **sin facturas** |
| 4 | Que la AEAT **acepta un registro de verdad** | alta en preproducción | emite una factura **en preproducción** |

---

## Paso 1 · La aritmética, sin red

```bash
cargo nextest run -p tpv-domain verifactu
cargo nextest run -p tpv-domain ticket
```

Dentro van los **tres vectores oficiales** que publica la AEAT en su documentación de la huella
(alta, alta con encadenamiento y anulación): la cadena exacta y el SHA-256 esperado. Si esos tres
pasan, la huella que este TPV calcula es la que la AEAT espera, y no hace falta una conexión para
saberlo.

También se comprueban ahí la URL del QR, el dígito de control del NIF/NIE/CIF, el formateo de
importes (`fmt_importe`, que es la función que decide qué texto se hashea) y el desglose de IVA con
su regla de «base + cuota tienen que dar el total».

---

## Paso 2 · El XML contra los esquemas oficiales

```bash
pnpm verifactu:validar-xml
```

Genera **12 muestras** que cubren los casos que importan —alta simplificada, alta con destinatario,
varios tipos de IVA, exenta, rectificativa por sustitución, anulación, subsanación, macrodato…— y las
valida contra los XSD que vienen en `crates/tpv-infra-aeat/esquemas/` (descargados de la sede
electrónica, sin tocar).

Requisito la primera vez:

```bash
pip install xmlschema
```

**Las 12 tienen que pasar.** El script está probado en negativo a propósito: si se le rompe un campo
a mano, falla. Un «todas correctas» con un validador que no valida nada es peor que no tener paso 2.

Para ver el XML que se generaría sin validarlo:

```bash
cargo run -q -p tpv-infra-aeat --example muestras_xml
```

---

## Paso 3 · El certificado y el *handshake*

Esto es lo primero que toca un certificado real, y aun así **no emite ninguna factura**.

### 3.1 Ver qué hay instalado

```bash
pnpm verifactu:certificados
```

Enumera los certificados de los almacenes personales de Windows que **tienen clave privada**, y de
cada uno dice:

- la **huella** (SHA-1), que es lo único que la aplicación guarda del elegido;
- el **almacén**: `CurrentUser` o `LocalMachine`;
- si se puede usar **sin diálogos** (*uso silencioso*);
- si es de **sello de entidad** (decide el endpoint, `www10` en vez de `www1`).

No saca nada más, y no hace falta que saque nada más.

Dos cosas que esto resuelve antes de perder una tarde:

- **El almacén personal es por usuario de Windows.** Si lo instaló la gestoría con su sesión, el TPV
  corriendo como otro usuario no lo ve. Hay que instalarlo en la sesión desde la que se usa el TPV.
- **Un `.cer` o un `.crt` no valen.** Sólo llevan la parte pública. Hace falta el `.p12` / `.pfx`, o
  el certificado ya instalado con su clave.

> ⚠️ **Si un certificado sale con «uso silencioso: no», no sirve para esto.** Pedirá una contraseña o
> un PIN en cada envío, y nadie va a estar ahí para escribirlo a las tres de la mañana: el diálogo se
> queda esperando hasta que el envío agota su timeout, el job lo anota como un intento fallido y lo
> vuelve a intentar en el ciclo siguiente, indefinidamente. No se pierde ninguna factura —siguen
> `PENDIENTE`— pero **no se remite ninguna**, y el único síntoma es que la cola crece. Si es un
> `.p12`, se arregla volviéndolo a importar **sin** marcar «habilitar la protección segura de claves
> privadas»; si es un PIN de tarjeta o del DNIe, no tiene arreglo: hay que usar otro certificado.

### 3.2 El *handshake*

```bash
pnpm verifactu:probar-aeat -- <huella> pruebas
```

La huella es la del paso 3.1 (sin espacios ni dos puntos; da igual la capitalización). El segundo
argumento es el entorno y **por defecto es `pruebas`**: para ir a producción hay que escribir
`produccion` entero, porque `prewww1` y `www1` se distinguen en tres caracteres.

Lo que hace: abre una conexión HTTPS **con el certificado como credencial de cliente** y manda un
sobre SOAP **sin ningún registro dentro**.

**La señal de éxito es un error de esquema.** Suena raro y es lo correcto: lo que se está probando es
que Windows puede firmar con esa clave sin pedir nada y que la AEAT acepta al titular de la conexión.
Si el servidor contesta «te falta el cuerpo del mensaje», la conexión se estableció y nos leyó, que es
todo lo que este paso quería saber.

Lo mismo se puede hacer desde dentro de la aplicación: **Configuración → Fiscal → Certificado
electrónico → Probar**.

#### Si falla, por orden de probabilidad

| Síntoma | Qué es |
|---|---|
| Salió un diálogo de PIN o contraseña | Ese certificado no sirve para el envío automático (ver 3.1) |
| Error de TLS / cadena no válida | Un proxy o un antivirus con inspección TLS en medio |
| Certificado caducado o revocado | Renovarlo; la huella cambia, hay que volver a elegirlo |
| **`4112`** | El titular del certificado **no está autorizado** sobre ese NIF |

Sobre el `4112`: la forma más simple de esquivarlo es que el **obligado tributario sea el mismo NIF
del certificado**. Entonces el titular eres tú y no hace falta ningún apoderamiento. Si el
certificado es de un representante o de la gestoría, hace falta el apoderamiento correspondiente en
la sede electrónica (trámite «Apoderamiento» → suministro de registros de facturación).

---

## Paso 4 · Un envío de verdad, en preproducción

Este es el único paso que **emite una factura**. En preproducción, que es un entorno separado del de
verdad, pero una factura.

### 4.1 Antes de empezar: darse de alta en preproducción

La AEAT exige registrarse para usar el entorno de pruebas:

1. Entrar en el **portal de preproducción** con el certificado:
   <https://prewww1.aeat.es/> (sede de pruebas).
2. Buscar el apartado de **Veri\*factu / Sistemas informáticos de facturación** y seguir el alta de
   pruebas. La AEAT pide asociar el NIF con el que se va a probar.
3. Comprobar que el NIF que se va a usar como **obligado** está habilitado ahí.

> El alta en preproducción es un trámite de la AEAT y puede cambiar de sitio en su web. Si no
> aparece, el punto de entrada estable es la **sede electrónica → Todas las gestiones → Impuestos y
> tasas → Veri\*factu**, y desde ahí el enlace a preproducción.

### 4.2 Configurar el TPV para pruebas

En la aplicación:

1. **Configuración → Fiscal → Datos fiscales del negocio**: rellenar **Razón social** y **NIF / CIF**.
   Tiene que ser el NIF dado de alta en 4.1, y el NIF se valida con su dígito de control: si no es
   válido, no se puede cobrar (y eso es a propósito).
2. **Configuración → Fiscal → Certificado electrónico → Buscar**, elegir el certificado y pulsar
   **Usar este**. Sólo se guarda su huella.
3. **Configuración → Fiscal → Entorno de la AEAT → Pruebas**, y confirmar el aviso. Mientras esté en
   pruebas, los tickets llevan un QR que apunta al portal de pruebas y **no son facturas reales**; el
   panel de «Envío a la AEAT» lo repite en amarillo para que no se pueda olvidar.

Cuando el entorno es `pruebas`, el panel de «Envío a la AEAT» lo dice en amarillo. Si no lo dice, el
equipo está apuntando a **producción**: pararse ahí.

### 4.3 Cobrar

Una venta normal. Cualquiera:

- Venta rápida → un producto → Cobrar → Efectivo o Tarjeta.

Con eso, dentro de la transacción del cobro, se emite el registro de facturación y se encola. El
**ticket sale con el QR tributario arriba** y con la leyenda `VERI*FACTU`.

### 4.4 Mirar qué pasó

**Configuración → Fiscal → Envío a la AEAT** enseña los cuatro contadores: pendientes, aceptadas, con
avisos, rechazadas. Se actualiza solo.

Los tiempos que hay que esperar, y por qué no es un fallo que no salga al instante:

- El job de remisión corre **cada 60 s** y tiene **1 minuto de retardo inicial** tras arrancar.
- La AEAT impone un **control de flujo** (art. 16.2 de la Orden): el siguiente envío no sale hasta que
  pasan los segundos que ella misma dijo (`TiempoEsperaEnvio`, 60 s al principio) o hasta acumular
  1000 registros. Lo primero que ocurra.

O sea: entre cobrar y ver «aceptada» pueden pasar **dos o tres minutos**, y eso es funcionamiento
normal. El panel no marca nada en rojo hasta la hora, y la escalera de avisos no dice nada hasta las
seis horas.

#### Cómo leer el resultado

| Contador | Qué significa |
|---|---|
| **Aceptadas** | La AEAT lo tiene. Guarda su CSV |
| **Con avisos** | Lo tiene, **pero hay algo que corregir** (códigos 2000–2999). Cuenta como presentado; hay que subsanarlo |
| **Rechazadas** | No lo tiene. Hay que corregir y reenviar |
| **Pendientes** | Todavía no ha salido (control de flujo, sin red, sin certificado) |

Si sale «No se puede remitir», el panel dice el motivo: faltan datos fiscales, no hay certificado
elegido, o el certificado elegido ya no está en el almacén.

### 4.5 Comprobarlo del otro lado

Lo que dice el TPV es una cara de la moneda. La otra:

1. En el **portal de preproducción**, consultar los registros de facturación recibidos para ese NIF.
   Tienen que estar ahí, con el mismo `Num_Serie_Factura` y la misma fecha.
2. **Escanear el QR del ticket** con el móvil. Lleva al cotejo de la AEAT (en pruebas, al de pruebas)
   y debería reconocer la factura. Es la prueba de que la URL del QR se compone bien, que es un sitio
   fácil de equivocarse y el único que el cliente final ve.

### 4.6 Exportar y verificar la cadena

**Configuración → Fiscal → Exportar los registros de facturación**, el rango de hoy. Sale un `.zip`
con cuatro ficheros; el que importa es `cadena.txt`. Con él se puede recalcular cada huella a mano:

```bash
# La línea N de cadena.txt tiene que dar la huella N de registros.csv
python -c "import hashlib,sys; print(hashlib.sha256(sys.argv[1].encode()).hexdigest().upper())" "<la cadena>"
```

Si coincide, la cadena de huellas es íntegra **y se puede demostrar sin nuestro código**, que es
exactamente para lo que existe ese fichero.

---

## Lo que NO hay que hacer

- **No apuntar a producción para «probar».** Un registro de facturación enviado a producción es un
  registro real de ese NIF y **no se borra**: como mucho se anula con **otro** registro, que también
  queda. Las pruebas van a preproducción.
- **No cambiar el NIF del obligado con registros ya emitidos.** Sería empezar otra cadena de
  facturación. La pantalla lo advierte cuando ya hay registros.
- **No restaurar una copia local antigua después de haber remitido.** Se perdería un tramo de cadena
  que la AEAT ya tiene. Para volver de una avería, la vía es recuperar de la nube (§9 de CLAUDE.md).

---

## Volver a producción: hay que partir de cero

Esto es lo menos obvio de todo el documento y lo más fácil de hacer mal.

Los registros que se emitan ensayando en preproducción **son registros de este equipo**: ocupan su
`Orden`, gastan número de la serie y entran en la **cadena de huellas**. Pero la AEAT de producción no
los tiene. Si se cambia el entorno a `produccion` y se sigue cobrando, el primer registro real
declararía como eslabón anterior una huella que Hacienda nunca ha visto — y eso ya no es un problema
de configuración, es una cadena que no cuadra desde el primer día.

La forma limpia es que el primer registro de producción sea **el primero**, con
`PrimerRegistro = 'S'`, que es lo que el propio código pone cuando no hay ninguno antes. O sea:
borrar el estado fiscal de las pruebas.

Mientras no haya clientes en producción, eso se hace como cualquier otro reinicio de esquema
(CLAUDE.md §3): **resetear la `data.db`** del equipo y el tenant Turso de desarrollo. No hay —ni debe
haber— un botón de «borrar los registros de facturación»: esa tabla es append-only por norma (art. 7
RRSIF), y un comando capaz de vaciarla es justo lo que un sistema VERI\*FACTU no puede tener.

> ⚠️ **Pendiente de confirmar contra la AEAT en el paso 4**: qué devuelve exactamente cuando el
> eslabón anterior declarado no existe en sus registros (un rechazo, o un «aceptado con errores» de la
> banda 2000–2999). No cambia la recomendación —partir de cero es correcto en los dos casos— pero sí
> cuánto margen hay si alguien se lo salta. **No lo inventes: sale del primer envío de prueba.**

La pantalla avisa de esto: si ya hay registros emitidos, el botón de pasar a producción lo dice en
rojo con el número delante.

---

## Qué falta antes de producción

La lista viva, con el detalle de cada punto, está en
[VERIFACTU_PENDIENTES.md](VERIFACTU_PENDIENTES.md). En corto, lo que **no** depende de código y hay
que tener resuelto antes del primer envío real:

- [ ] El **alta / declaración responsable** del productor del software con sus datos definitivos
      (NIF y razón social). Hoy la pantalla dice que está incompleta, a propósito.
- [ ] El **`IdSistemaInformatico`**: el código de **2 caracteres** que el productor asigna a este
      sistema. Va en cada registro.
- [ ] El **certificado del bar** instalado en la sesión de Windows desde la que se usa el TPV, con uso
      silencioso, y con el obligado = titular del certificado (o el apoderamiento hecho).
- [ ] El entorno puesto en **produccion** y verificado en el panel.
