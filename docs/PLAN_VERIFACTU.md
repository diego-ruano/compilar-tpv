# Veri*factu — diseño e implementación

> **Estado: PLANIFICADO** (2026-09-07, revisado el 2026-09-08). Cierra **FISCAL-01** y **FISCAL-02**
> del [backlog](analisis/BACKLOG.md). Lo que sigue es el **diseño** —el modelo, las decisiones y sus
> porqués—, escrito con el reglamento y las especificaciones técnicas de la AEAT delante (§17).
>
> **Fecha límite: 1 de enero de 2027** (contribuyentes de IS). El 1 de julio de 2027 para el resto.
> No hay bares en producción todavía, así que **el esquema se edita en `0001_inicial.sql`** y se
> resetean las bases de desarrollo (CLAUDE.md, `packages/database`): esta es la última ventana en la
> que un cambio estructural es barato, y este es exactamente el cambio para el que sirve.
>
> **Ámbito:** todo el camino de la venta (`mesas`, `venta_rapida`, `cuentas`), impresión,
> configuración, un adaptador nuevo contra la AEAT y un job. Toca el esquema y la recuperación.

---

## 0. Decisiones tomadas

Acordadas con el responsable el 2026-09-07.

| Decisión | Elección | Consecuencia de diseño |
|---|---|---|
| **Modalidad** | **VERI\*FACTU**, siempre, sin interruptor | No hay firma XAdES por registro ni registro de eventos. A cambio, **todo RF generado hay que remitirlo** |
| **Quién remite** | **La propia Main**, con el certificado del local instalado en el equipo | No custodiamos certificados de terceros. Precio: un bug en el XML se arregla **publicando una versión**, no redesplegando un worker (§6.6) |
| **Para qué el certificado** | **Sólo para autenticar la conexión (TLS mutuo).** En VERI\*FACTU **no se firma la factura** | La integridad la da la cadena de huellas, que es un SHA-256 pelado. La firma XAdES es de la otra modalidad (§6.2) |
| **Qué es una factura** | **Un cobro = una factura simplificada (F2)** | Tres pagos de 20 € sobre una mesa son **tres** facturas, cada una con su número, su QR y su registro |
| **Numeración** | Serie por ejercicio: `2027/000001` | El contador se reinicia cada año. Nunca retrocede (§3.3) |
| **Sin conexión** | **Se sigue vendiendo.** El RF se genera, se encadena, se imprime con QR y se remite después | El reglamento lo contempla; lo que no se puede es *no* remitir nunca (§1.2) |
| **Retraso tolerado** | **Horas, no días.** Escalera de avisos que se vuelve imposible de ignorar (§1.2.1) | Un corte de tarde es normal; cuatro días acumulando no lo es, y el software tiene que decirlo |
| **Fallo de envío** | **Nunca bloquea la aplicación.** Se clasifica, se avisa y se reintenta | Un bug nuestro no puede cerrar un bar (§6.5) |
| **Tabla** | **Propia y append-only**, no `Movimientos_Caja` | Esa tabla lleva gastos, que no son facturas, y es «para investigar, no para calcular» |
| **Importes** | Se guarda **el texto exacto que se hasheó** | La huella se calcula sobre una cadena; recomputarla desde un `REAL` la rompe en silencio (§4.2) |
| **Exportación** | ZIP desde Configuración | Art. 8 RRSIF: el SIF tiene que poder volcar sus registros |
| **País Vasco / Navarra** | **Fuera de alcance** | Allí rige TicketBAI, que es otro sistema. No se diseña para ser genérico |

**El principio que ordena todo lo demás:** el registro de facturación es el **hecho fiscal**; el
papel es una copia suya y el envío a la AEAT es una consecuencia diferida. De ahí salen las tres
reglas que no se negocian: el registro se crea **en la misma transacción que el cobro**, **no se
modifica jamás**, y **nada de lo que rodea al envío puede impedir cobrar**.

---

## 1. Tres cosas que corrigen lo que creíamos antes de leer la norma

### 1.1 La anulación existe — pero no es lo que hoy llamamos «anular un cobro»

Existen dos instrumentos distintos y el TPV necesita **los dos**:

- **RF de anulación** (art. 11.1 RRSIF): *«cuando se haya emitido erróneamente una factura»*. La
  AEAT es explícita en su FAQ de desarrolladores: estos casos deben ser **«MUY POCO FRECUENTES»**, y
  son los de una factura que **no responde a una operación real** — una venta de prueba, una
  formación, un ticket emitido por un servicio que no se prestó. Anular **no borra nada**: tanto el
  registro erróneo como el de anulación se conservan y **se remiten**.
- **Factura rectificativa** (RF de alta con clave `R1`-`R5`): cuando la operación **sí existió** pero
  hay que modificar su importe — una devolución, un cobro de más, un error de cantidad. La AEAT lo
  dice sin matices: *«todas las facturas emitidas, en la medida en que respondan a operaciones
  realmente efectuadas (como es el caso habitual) no pueden anularse»*.

Hoy `cuentas_anular_pago` sirve para las dos cosas: *«me he equivocado de mesa»* y *«le devuelvo el
dinero al cliente»*. **Hay que partirlo en dos acciones distintas** (§7), y la que más se va a usar
—la devolución— es la rectificativa, no la anulación.

Para una devolución sobre una simplificada, el camino que marca la FAQ es una **`R5` con
`TipoRectificativa = I`** (por diferencias) e importe **negativo**, referenciando la simplificada
original en `IDFacturaRectificada`.

### 1.2 Sin conexión se sigue vendiendo, y el Local-First sobrevive entero

El art. 16.1 RRSIF exige remitir *«de forma continuada, segura, correcta, íntegra, automática,
consecutiva, instantánea y fehaciente»*. Lo que **no** hay es un plazo en horas ni una prohibición de
facturar sin red: el sistema almacena los registros, mantiene la cadena intacta y **reintenta hasta
recibir confirmación**, marcando `RemisionVoluntaria/Incidencia = "S"` en los afectados.

O sea que toda la arquitectura Local-First (§9 de CLAUDE.md) se queda tal cual. Lo que se añade es
una cola de envío con estado visible. **No hay que hacer obligatorio el internet.**

Lo que sí es incompatible con la norma —y conviene tenerlo escrito— es lo contrario: **una factura
expedida sin su RF generado**, o un RF generado que nunca se remite. La FAQ de la AEAT sobre
arquitecturas TPV + backoffice lo llama *«facturas huérfanas»* y es la única forma de romper esto de
verdad.

#### 1.2.1 Pero «se puede vender sin red» no es «se puede estar cuatro días sin remitir»

Que no haya un plazo en horas no significa que valga cualquier cosa. El art. 16.1 pide remitir *«de
forma continuada… automática… instantánea»*, y un equipo al que le ponen internet cada tres días para
soltar el atraso **no es un sistema VERI\*FACTU**, por mucho que acabe enviando todo. El corte de una
tarde es el caso que la norma contempla; el modo de funcionamiento habitual no.

El software no puede impedirlo —bloquear la caja es peor—, pero sí puede hacerlo **imposible de
ignorar**. La escalera se mide por la **antigüedad del registro pendiente más viejo**, no por el
tiempo sin conexión: estar desconectado sin nada que enviar no es un problema.

| Antigüedad del pendiente más viejo | Qué hace el TPV |
|---|---|
| < 1 h | Nada. Es el funcionamiento normal, incluso con fibra |
| ≥ 1 h | Indicador visible en la barra + estado en Configuración → Conectividad |
| ≥ 6 h | Notificación persistente (NOTIF-01), dirigida al rol administrador |
| ≥ 24 h | **Aviso modal al iniciar sesión**, con reconocimiento explícito. No se cierra solo |
| ≥ 72 h | Aviso modal **en cada cobro** + telemetría, para que el proveedor pueda llamar al cliente |

**Nunca bloquea el cobro, en ningún escalón.** La obligación es del bar, no nuestra; nuestro trabajo
es que no pueda decir que no lo sabía, y dejar rastro de que se le avisó.

⚠️ **Y una consecuencia que hay que ver ahora, no al implementarla:** la palanca de emergencia
`connectivity: "off"` de `device_config.json` (SYNC-17, §9 de CLAUDE.md) apaga el WebSocket de
sincronización. **No puede apagar la remisión a la AEAT.** Son dos cosas distintas y comparten una
palabra: una es una comodidad de producto —«este cliente no quiere nube»— y la otra es una obligación
tributaria. Si comparten interruptor, el atajo para una red patológica convierte en silencio un TPV
conforme en uno que no lo es. **La remisión tiene su propia puerta**, y sólo la cierran dos cosas: no
haber certificado, o estar en modo pruebas.

### 1.3 No se envía factura a factura: hay un control de flujo obligatorio

Art. 16.2 de la Orden HAC/1177/2024. La AEAT devuelve en cada respuesta un
`<TiempoEsperaEnvio>` en segundos (**valor inicial 60**), y el siguiente envío no puede salir hasta
que hayan pasado esos segundos **o** hasta acumular **1000 registros** (máximo por envío), lo que
ocurra primero.

Esto tiene una consecuencia de diseño que hay que ver antes de escribir nada: **el envío es un job
periódico por lotes, no una llamada HTTP dentro del cobro**. Encaja exactamente en el runner de
tareas de fondo (§10 de CLAUDE.md), y hace todavía más evidente que cobrar y remitir son dos cosas
separadas en el tiempo.

---

## 2. Qué es una factura en este TPV

### 2.1 Un cobro, una factura

Cada fila **activa** de `Pagos` es una **factura simplificada (`F2`)** con su propio número. Una
comanda pagada en tres veces produce tres facturas. Es lo que ya hace el TPV con `Numero_Ticket`, así
que no cambia la operativa: cambia lo que ese número significa.

### 2.2 El límite de los 3.000 € — ⏳ PENDIENTE DE DECISIÓN

Una simplificada sólo vale hasta **400 € (IVA incluido)** con carácter general, pero la hostelería
está en la lista del art. 4.2 del RD 1619/2012 (*«servicios de hostelería y restauración prestados
por restaurantes, bares, cafeterías… así como el suministro de bebidas o comidas para consumir en el
acto»*), que sube el límite a **3.000 €**.

Por encima de esa cifra **no cabe una `F2`**: hay que emitir factura completa con destinatario. Lo
que está sin decidir es **qué hace la pantalla** cuando alguien va a cobrar 3.200 €:

| Opción | Qué pasa | A favor / en contra |
|---|---|---|
| **a** | El cobro **se detiene** y pide los datos fiscales antes de continuar | Correcto siempre. Pero es la única puerta dura en el camino del dinero |
| **b** | Se avisa y se ofrece **emitir `F1`**, con «continuar igual» deshabilitado | Igual de correcto, menos brusco |
| **c** | Sólo se avisa y se deja pasar | **No conforme.** Anotada para descartarla por escrito |

**Estado (2026-09-08):** aplazada a propósito. En un bar es un caso rarísimo, así que no puede
condicionar el diseño de los tramos 1-5; en un catering o una comunión es normal. Se decide antes del
**tramo 7** (factura completa), que es donde se implementa.

Sea cual sea la elección, el umbral va en `Business_Settings` (`Limite_Simplif`) y no incrustado: es
un número que la norma puede mover.

### 2.3 Los tipos de factura que necesitamos

| Clave | Cuándo | Fase |
|---|---|---|
| `F2` | El ticket normal de barra o mesa | 1 |
| `F1` | El cliente pide factura **con su NIF** en el momento del cobro | 4 |
| `F3` | El cliente vuelve después con el ticket y pide factura: se emite **en sustitución** de la simplificada | 4 |
| `R5` | Devolución o corrección sobre una simplificada | 3 |
| `R1` | Corrección sobre una `F1` | 3 |

`F3` es la respuesta correcta al *«¿me lo puedes hacer con IVA?»* del día siguiente: **no se
rectifica** la simplificada por el mero hecho de canjearla (art. 15.6 ROF), se emite una `F3` que la
sustituye y que sí lleva destinatario.

### 2.4 Lo que NO es una factura

La **precuenta** (`numero_ticket: None`) no genera registro, no lleva QR y sigue marcada como «no es
un ticket de venta». El **arqueo** es un documento interno. Las **aperturas de cajón** no son nada
fiscal. Nada de esto cambia.

---

## 3. Modelo de datos

### 3.1 `Registros_Facturacion` — append-only

Es el corazón. **Se inserta y nunca se toca**: sin `UPDATE`, sin `DELETE`, sin excepciones.

```sql
CREATE TABLE IF NOT EXISTS Registros_Facturacion (
  ID_Registro           TEXT PRIMARY KEY,   -- UUID generado ANTES del INSERT (IDs deterministas)
  Orden                 INTEGER NOT NULL,   -- posicion en la cadena, monotona y global
  Tipo                  TEXT NOT NULL,      -- 'ALTA' | 'ANULACION'

  -- Identificacion de la factura (IDFactura del XML)
  NIF_Emisor            TEXT NOT NULL,
  Num_Serie_Factura     TEXT NOT NULL,      -- '2027/000001'
  Fecha_Expedicion      TEXT NOT NULL,      -- 'DD-MM-AAAA', tal cual va al XML y al QR
  Serie                 TEXT NOT NULL,      -- '2027'
  Numero                INTEGER NOT NULL,

  -- Contenido (solo en ALTA)
  Nombre_Razon_Emisor   TEXT NOT NULL,
  Tipo_Factura          TEXT,               -- F1|F2|F3|R1..R5
  Tipo_Rectificativa    TEXT,               -- S|I
  Descripcion_Operacion TEXT,
  Importe_Total         TEXT,               -- TEXTO exacto, con 2 decimales
  Cuota_Total           TEXT,
  Desglose_Json         TEXT,               -- [{clave_regimen, calificacion, tipo, base, cuota}]
  Destinatario_Json     TEXT,               -- NULL en simplificada
  Referencias_Json      TEXT,               -- facturas rectificadas / sustituidas

  -- Encadenamiento
  Primer_Registro       TEXT,               -- 'S' o NULL
  Ant_NIF               TEXT,
  Ant_Num_Serie         TEXT,
  Ant_Fecha             TEXT,
  Ant_Huella            TEXT,

  -- Huella
  Cadena_Huella         TEXT NOT NULL,      -- la cadena EXACTA sobre la que se aplico SHA-256
  Huella                TEXT NOT NULL,      -- 64 hex mayusculas
  Fecha_Hora_Huso       TEXT NOT NULL,      -- '2027-01-15T21:34:56+01:00'

  -- Contexto congelado
  Sistema_Json          TEXT NOT NULL,      -- el bloque SistemaInformatico tal como iba
  QR_Url                TEXT NOT NULL,      -- la URL exacta impresa en el papel
  Incidencia            TEXT NOT NULL DEFAULT 'N',

  -- Origen en el negocio (informativo; la fuente de verdad del dinero sigue siendo Pagos)
  ID_Pago               TEXT,

  UNIQUE (Orden),
  UNIQUE (NIF_Emisor, Num_Serie_Factura, Fecha_Expedicion),
  CHECK (Tipo IN ('ALTA','ANULACION')),
  FOREIGN KEY (ID_Pago) REFERENCES Pagos(ID_Pago) ON DELETE SET NULL
);
```

Tres decisiones que parecen detalles y no lo son:

- **`Orden` explícito, no `rowid`.** El último eslabón de la cadena es `MAX(Orden)`. Con `rowid` la
  cadena dependería del orden en que una restauración reinserta las filas, que no está garantizado.
- **`Cadena_Huella` se guarda.** Es redundante —se puede recomputar— y precisamente por eso vale:
  si algún día el formateo cambia, el fichero enseña qué se hasheó de verdad. Es además lo que hace
  auditable la exportación sin tener que confiar en el código que la lee.
- **`ON DELETE SET NULL` en `ID_Pago`.** Un registro fiscal no puede desaparecer porque desaparezca
  aquello a lo que apunta. Misma regla que `Movimientos_Caja`.

### 3.2 Tablas de control local (prefijo `_`, no se replican)

Se crean en `infra-sqlite/src/db.rs` junto a `_Jobs_State` y `_Backfill_Historico`, y **sus
escrituras van por `WriteGuard::raw()`**: por `execute()` cada intento de envío se replicaría a la
nube.

```sql
CREATE TABLE IF NOT EXISTS _Verifactu_Envios (
  ID_Registro       TEXT PRIMARY KEY,
  Estado            TEXT NOT NULL,      -- PENDIENTE|ACEPTADO|ACEPTADO_CON_ERRORES|RECHAZADO
  Intentos          INTEGER NOT NULL DEFAULT 0,
  Ultimo_Intento_Ms INTEGER,
  Codigo_Error      TEXT,
  Descripcion_Error TEXT,
  CSV               TEXT
);

CREATE TABLE IF NOT EXISTS _Verifactu_Flujo (
  ID               INTEGER PRIMARY KEY CHECK (ID = 1),
  Espera_Segundos  INTEGER NOT NULL DEFAULT 60,
  Ultimo_Envio_Ms  INTEGER
);
```

El estado del envío **no se replica a propósito**: es local al equipo y, tras una restauración, la
verdad no está en la nube sino en la AEAT, a la que se le puede preguntar (§6.7).

### 3.3 `Serie_Facturacion` — el contador, y por qué no puede retroceder

```sql
CREATE TABLE IF NOT EXISTS Serie_Facturacion (
  Serie  TEXT PRIMARY KEY,     -- '2027'
  Ultimo INTEGER NOT NULL DEFAULT 0
);
```

Se reserva igual que hoy `Ticket_Contador`: `INSERT OR IGNORE` de la serie del año y luego
`UPDATE … SET Ultimo = Ultimo + 1`, **relativo**, para que la sentencia que sale al outbox converja
sola. Sigue siendo un contador propio y no un `SELECT MAX`, por la razón que ya estaba escrita en
`mesas.rs`.

**Lo que sí es nuevo:** antes de usar el número se comprueba contra
`MAX(Numero) FROM Registros_Facturacion WHERE Serie = ?` y, si el contador va por detrás, **salta
hacia adelante**. Esto existe por un caso concreto: restaurar una copia local de hace tres días
devolvería el contador a un número ya emitido, y la AEAT rechazaría el registro por **duplicado**
(`IDFactura` = emisor + número + fecha). Un hueco en la numeración es explicable; un número repetido
es un registro que no entra. **Se falla hacia el hueco.**

`Ticket_Contador` se retira: `Pagos.Numero_Ticket` pasa a guardar el `Num_Serie_Factura` fiscal. Un
solo número para el papel, el cobro y el registro — dos numeraciones paralelas serían dos cosas que
pueden divergir.

### 3.4 Datos fiscales del negocio

`Business_Settings` gana lo que hoy no tiene y el registro exige:

```sql
Razon_Social       TEXT NOT NULL DEFAULT '',   -- NombreRazon del obligado. NO es Business_Name
Descripcion_Op     TEXT NOT NULL DEFAULT 'Servicios de hosteleria y restauracion',
Limite_Simplif     REAL NOT NULL DEFAULT 3000,
Verifactu_Entorno  TEXT NOT NULL DEFAULT 'produccion'   -- 'produccion' | 'pruebas'
```

- **`Razon_Social` no es `Business_Name`.** «Bar La Plaza» es el rótulo; «Francisco García SL» es
  quien factura. El ticket enseña los dos y el XML sólo el segundo.
- **`CIF` pasa a ser obligatorio y validado** (formato NIF/NIE/CIF español). Hoy dice «Opcional» en
  la pantalla y es texto libre.
- **`Descripcion_Op` es un texto fijo configurable**, no un resumen de las líneas: es un campo
  obligatorio de hasta 500 caracteres y los nombres de producto los escribe el usuario. Un campo
  obligatorio que puede llegar vacío o con basura es un rechazo garantizado.
- **`Verifactu_Entorno` cambia la URL del QR y el endpoint a la vez.** Un ticket emitido en modo
  pruebas lleva un QR que apunta a `prewww2.aeat.es`: la pantalla tiene que gritarlo.

### 3.5 El NIF es el ancla, y se pide al arrancar

El `IDFactura` de todos los registros lleva el NIF del obligado. Si cambia, la cadena cambia de
dueño. Por eso:

- Los datos fiscales se piden en un **formulario de primer arranque** (junto al PIN del admin), no
  escondidos en Configuración.
- **Sin NIF y razón social no se puede cobrar.** Es la única puerta que este plan añade al camino de
  la venta, y va antes de la primera venta, no a mitad de servicio.
- Una vez existe el primer registro, el NIF pasa a **solo lectura** en Configuración. Cambiarlo es
  empezar otra cadena y no es algo que se haga desde un formulario.

---

## 4. La cadena (huella o *hash*)

### 4.1 El algoritmo, literal

`SHA-256` sobre una cadena UTF-8 con la forma `nombre1=valor1&nombre2=valor2&…`, en el orden exacto
del diseño de registro. Salida en **hexadecimal, mayúsculas, 64 caracteres**.

**Registro de alta:**

```
IDEmisorFactura=…&NumSerieFactura=…&FechaExpedicionFactura=…&TipoFactura=…
&CuotaTotal=…&ImporteTotal=…&Huella=…&FechaHoraHusoGenRegistro=…
```

**Registro de anulación:**

```
IDEmisorFacturaAnulada=…&NumSerieFacturaAnulada=…&FechaExpedicionFacturaAnulada=…
&Huella=…&FechaHoraHusoGenRegistro=…
```

Reglas del documento de la AEAT (v0.1.2):

- Los valores van **sin espacios al principio ni al final**.
- Si el campo no existe o va vacío, se pone **el nombre y el `=`, sin nada detrás**:
  `…&Huella=&FechaHoraHusoGenRegistro=…`. Es el caso del primer registro de la cadena.
- El primer registro lleva `PrimerRegistro = "S"`, **no lleva** bloque `RegistroAnterior`, y
  **aun así calcula y guarda su propia huella**.
- La huella del registro anterior es la que va en `Encadenamiento/RegistroAnterior/Huella`.

**Los tres vectores oficiales van como test golden** (§13). Son el mejor regalo que hace la AEAT:
si el formateo se desvía un carácter, fallan.

### 4.2 Los importes son texto, y ese es el punto delicado

`ImporteTotal` y `CuotaTotal` entran en la cadena hasheada. Hoy el dinero en el TPV es `REAL`
(`Total_Comanda`, `Importe_Total`), y `REAL → texto` no es una operación única: `123.1`, `123.10` y
`123.100000000000001` son tres cadenas distintas.

La AEAT admite indistintamente una o dos posiciones decimales (los ceros a la derecha no importan
para la huella), pero **eso no nos salva**: lo que nos rompería es recomputar la cadena más tarde y
obtener otra. Por eso:

1. El importe se formatea **una sola vez**, a dos decimales, con la función del dominio.
2. Esa cadena se guarda en `Importe_Total` / `Cuota_Total` / `Desglose_Json`.
3. La cadena hasheada se guarda entera en `Cadena_Huella`.
4. **Nadie recomputa nada al leer.** El XML, el QR y la exportación se construyen desde el texto
   guardado.

El desglose ya está resuelto en `printing.rs::desglose_iva`, con la regla que importa: se redondea la
base y **la cuota es lo que falta** para el total. Esa función se **sube a `tpv-domain`** para que el
papel, la previa y el registro fiscal salgan del mismo sitio — hoy el papel y la previa ya son
espejos con goldens duplicados (§11 de CLAUDE.md), y el registro pasa a ser el tercer espejo.

### 4.3 `FechaHoraHusoGenRegistro` lleva huso, y la BD hoy no

El campo es un `dateTime` con desplazamiento: `2027-01-15T21:34:56+01:00`. La BD escribe
`datetime('now','localtime')`, sin huso, y el outbox congela ese literal antes de replicar.

Se calcula **en Rust** (`chrono::Local`) y se inserta como literal, igual que los UUID. No es una
excepción a la regla del outbox: es la misma regla.

### 4.4 El registro se crea dentro de la transacción del cobro

En `infra-sqlite/src/mesas.rs` y `venta_rapida.rs`, entre el `INSERT INTO Pagos` y el `COMMIT`:

1. Reservar número de serie (con la guardia de §3.3).
2. Leer el último eslabón: `SELECT … ORDER BY Orden DESC LIMIT 1`.
3. Construir el registro, calcular la huella, construir la URL del QR.
4. `INSERT INTO Registros_Facturacion`.
5. `INSERT INTO _Verifactu_Envios (…, 'PENDIENTE')` por `raw()`.

Si el cobro hace `ROLLBACK`, no queda registro ni se gasta número. Si la **impresión** falla después,
el registro ya existe y es correcto: la factura está expedida y el papel se reimprime. Es el orden
que exige el art. 9 (*«de forma simultánea o inmediatamente anterior a la expedición»*) y el único
que no puede dejar huérfanos.

El comando de cobro pasa a **devolver el bloque fiscal** (número, QR, huella) para que el frontend lo
meta en el payload de impresión. Hoy `buildTicketPayload` monta el ticket desde los stores de Zustand;
a partir de ahora esos datos **no se pueden inventar en el cliente**.

---

## 5. El QR y el papel

### 5.1 La URL

```
https://www2.agenciatributaria.gob.es/wlpl/TIKE-CONT/ValidarQR
  ?nif=<NIF>&numserie=<Num_Serie_Factura>&fecha=<DD-MM-AAAA>&importe=<N.DD>
```

Pruebas: `https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR?…`

Los valores van **URL-encoded en UTF-8** — el ejemplo de la propia AEAT usa un número de serie con
`&` dentro, que sin codificar parte la URL —, y sólo pueden contener ASCII imprimible (32–126).

### 5.2 El código

- ISO/IEC 18004:2015, **nivel de corrección M**.
- Tamaño **entre 30×30 y 40×40 mm**.
- Zona de silencio: **mínimo 2 mm** por los cuatro lados, recomendado 6.

Se rasteriza con la crate `qrcode` y se imprime por el camino que **ya existe** para el logo
(`rasterizar_logo` → `GS v 0`), que es más portable que el `GS ( k` nativo de QR: no todas las
impresoras lo llevan. La escala de módulo se elige para caer dentro de la banda de 30–40 mm al DPI
configurado. En papel de 58 mm (≈48 mm imprimibles) entra a 30 mm; en 80 mm sobra sitio.

### 5.3 Dónde va — y la regla nuestra que deroga (decidido: 2026-09-08)

El QR va **al principio de la factura**, antes de cualquier contenido. Encima lleva el texto
**«QR tributario:»** y debajo **«VERI\*FACTU»** (o «Factura verificable en la sede electrónica de la
AEAT»), con letra igual o mayor que el resto.

Esto choca de frente con la regla de §11 de CLAUDE.md: *«El logo cierra el ticket, centrado»* y la
cabecera son los datos del negocio. **Gana el QR**, y no por jerarquía de normas sino porque la razón
que puso el logo abajo —que lo primero que se lea sea de quién es el ticket y cuánto se ha pagado—
sigue cumpliéndose: el QR no es contenido que compita, es una etiqueta.

El orden nuevo queda: **QR tributario → leyenda → datos del negocio → líneas → totales → desglose de
IVA → mensaje → logo → corte.** Al implementarlo hay que **actualizar esa regla en CLAUDE.md §11**,
no dejarla contradiciendo al código.

La **vista previa** (`TicketPaper.tsx`) sigue siendo un espejo y hay que moverla igual.

### 5.4 Reimpresión y anulados

Una reimpresión saca **el mismo número, el mismo QR y la misma huella**, marcada COPIA. No genera
registro. Un cobro con RF de anulación sale además marcado, como hoy.

---

## 6. El envío a la AEAT

### 6.1 El transporte

- **SOAP 1.1**, `document/literal`, UTF-8, sobre HTTPS con **certificado de cliente**.
- Operación `RegFactuSistemaFacturacion`, hasta **1000 registros** por envío.
- Endpoints (`SistemaFacturacion.wsdl`):

| Entorno | URL |
|---|---|
| Producción (certificado) | `https://www1.agenciatributaria.gob.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP` |
| Pruebas (certificado) | `https://prewww1.aeat.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP` |

(Existen los gemelos `www10` / `prewww10` para certificado de **sello electrónico**. No los usamos:
son la puerta de la opción «lo envía el worker», que se descartó.)

No hay crate de SOAP decente en Rust y tampoco hace falta: el sobre es fijo y el cuerpo se construye
con `quick-xml`. Lo que sí hay que hacer bien es el **escapado** y la validación contra los XSD.

### 6.2 El certificado — para qué se usa exactamente

**Lo primero, porque es el malentendido natural: en VERI\*FACTU no se firman las facturas.** La firma
electrónica del registro (XAdES) es un requisito de la modalidad **NO** VERI\*FACTU, que descartamos
en §0. Aquí lo que garantiza la integridad es la **cadena de huellas** (§4), y ninguna huella lleva
criptografía de clave pública: es un SHA-256 pelado.

El certificado sirve para **una cosa sola**: autenticar la conexión con el servicio web de la AEAT.
`Certificado: las aplicaciones que envían información a los servicios web deberán autenticarse con
certificado electrónico cualificado reconocido`, dice la descripción del servicio. Es **TLS mutuo**,
no una firma de documento. Puede ser el del obligado, el de un apoderado o el de un colaborador
social, y vive en el equipo del bar.

Dicho eso, la pregunta de fondo sigue siendo buena y la respuesta es que **sí, se puede hacer lo que
hace Autofirma**. El handshake TLS también necesita una firma con la clave privada, y esa firma la
puede hacer Windows sin que la clave salga nunca del almacén. Tres caminos:

| | Cómo | La clave privada | Sirve con clave **no exportable** |
|---|---|---|---|
| **A** | Fichero `.p12`/`.pfx` + contraseña, guardado cifrado en `secret_store` | **En memoria** del proceso | ❌ No |
| **B** | Almacén de Windows vía **CNG**, con [`rustls-cng`](https://github.com/rustls/rustls-cng) | **Nunca sale del almacén.** Windows hace la firma del handshake | ✅ Sí — es el mecanismo de Autofirma |
| **C** | `native-tls` (schannel) con un `.p12` | En memoria, importada a un almacén temporal | ❌ No, y mete una segunda pila TLS |

**(C) se descarta**: tiene los inconvenientes de (A) más una pila TLS extra.

**(B) es el destino.** `rustls-cng` está bajo la organización `rustls` (v0.7.1, agosto de 2026,
~66.000 descargas): expone la clave del almacén como un `SigningKey` de rustls, así que se construye
un `ClientConfig` con un resolver de certificado de cliente propio y se le pasa a `reqwest` por
`tls_backend_preconfigured`. Importa porque es lo que el cliente va a tener de verdad: un certificado
que le instaló su gestoría, a menudo marcado como no exportable, y al que nadie le va a sacar un
`.p12`.

⚠️ **Dos avisos sobre (B), que es por lo que no se empieza por ahí.** `tls_backend_preconfigured` está
documentado por reqwest como una opción avanzada y *«algo frágil»*, acoplada a la versión de rustls
que lleve reqwest por dentro; y es un camino **sólo Windows**, así que el `#[cfg]` correspondiente
tiene que existir desde el principio.

**Plan: (A) primero, (B) antes de lanzar.** (A) desbloquea el tramo 5 y las pruebas contra
preproducción en un rato, y (B) es un cambio detrás del mismo puerto (`AeatClient`), no una reescritura.
La selección va en la pantalla: «elegir del almacén de Windows» o «cargar un fichero .p12». La
decisión de cuál usa cada cliente es suya, no nuestra.

**Y en los dos casos: avisar de la caducidad.** Un certificado caducado deja de remitir en silencio,
que es la peor forma de fallar. Aviso a 30 días por el sistema de notificaciones que ya existe.

### 6.3 El job

En `jobs/registro.rs`, siguiendo el patrón del §10 de CLAUDE.md — un `async fn` y una entrada en el
catálogo, nada más:

```
Job "verifactu_remitir"  ·  cada 60 s  ·  requiere MainOperativa
```

El cuerpo:

1. ¿Hay certificado y datos fiscales? Si no → `Err` con un código propio (sale en el panel).
2. Control de flujo: ¿han pasado `Espera_Segundos` desde `Ultimo_Envio_Ms`, **o** hay ≥1000
   pendientes? Si no, `Ok(())` sin hacer nada.
3. Tomar hasta 1000 `PENDIENTE` **por `Orden` ascendente**. El orden importa: la cadena se valida
   contra el registro anterior.
4. Construir el XML y enviarlo.
5. Guardar el `TiempoEsperaEnvio` de la respuesta y procesar cada línea.

El cuerpo es idempotente: un envío repetido de un registro ya aceptado vuelve como **duplicado**, que
se trata como aceptado (§6.5). Es la misma propiedad que ya exige el motor de jobs.

### 6.4 `Incidencia = "S"`

La cabecera lleva `RemisionVoluntaria/Incidencia`. Se marca `"S"` cuando el envío **no pudo ser
inmediato**: se acumuló cola por falta de red, o se acaba de restaurar el equipo. Es la forma que da
la norma de decir «esto llega tarde y sé por qué», y usarla es mejor que no usarla.

### 6.5 Clasificar las respuestas — la parte que decide si esto molesta o no

`EstadoEnvio` puede ser `Correcto` / `ParcialmenteCorrecto` / `Incorrecto`, y **cada línea** trae su
`EstadoRegistro`. La clasificación es lo que evita que un fallo nuestro se convierta en un bar
parado:

| Qué llega | Qué es | Qué hace el TPV |
|---|---|---|
| `Correcto` | Aceptado | `ACEPTADO`, guarda el CSV. Fin |
| `AceptadoConErrores` | **Está en la AEAT**, con avisos | `ACEPTADO_CON_ERRORES`. **No se reintenta.** Se registra el aviso y se enseña en el panel |
| `Incorrecto` + duplicado | Ya lo teníamos allí | Se trata como **aceptado** (idempotencia). Se lee `RegistroDuplicado` para saber en qué estado quedó |
| `Incorrecto` + otro código | El registro **no** está en la AEAT | `RECHAZADO`. Reintento con backoff; a los 5 fallos con el mismo código, notificación y telemetría |
| Fallo de red / timeout / `Fault` de servidor | Ni idea | Reintento silencioso. Es el caso normal de un bar sin fibra |
| Sin certificado / caducado | Configuración | Notificación destacada. **No es un error del job**, es una tarea del dueño |

**Ninguna de esas filas bloquea la aplicación.** El peor caso —un bug nuestro que hace que la AEAT
rechace todo— se traduce en una cola creciente, un panel en rojo y una notificación; nunca en una
caja que no cobra. Es exactamente la decisión del punto 11 del responsable, y es también la razón de
que el envío no viva dentro de la transacción del cobro.

Una huella mal calculada **no** se rechaza: la AEAT marca el registro como *«Aceptado con errores»*.
O sea que un bug en §4 no se ve como un fallo ruidoso — se ve como una columna en el panel. Hay que
mirarla.

### 6.6 El precio de que envíe la Main

Se decidió que remita el TPV para no custodiar certificados de terceros, y es defendible. La
contrapartida hay que tenerla escrita: **un fallo en el XML o un cambio en el servicio de la AEAT se
arregla publicando una versión y esperando a que los equipos se actualicen.** El updater ya existe,
pero no es instantáneo.

Mitigación barata y que conviene hacer desde el principio: los pocos valores que pueden cambiar sin
cambiar el código —endpoints, `IDVersion`, la URL base del QR— salen de una **configuración remota
servida por el worker** y cacheada en local, con los valores actuales como defecto. No es la opción
del apoderamiento por la puerta de atrás: los certificados y los registros siguen sin salir del
equipo.

### 6.7 Consulta y reconciliación

El WSDL trae también `ConsultaFactuSistemaFacturacion`. Sirve para lo único que no se puede resolver
mirando en local: **qué tiene la AEAT** después de una restauración. Se usa en dos sitios:

- Al terminar una recuperación (§8.1), para saber desde dónde seguir.
- En un botón de diagnóstico del panel, para cotejar un rango.

---

## 7. Anulaciones y rectificativas

### 7.1 Partir el botón actual

`cuentas_anular_pago` pasa a ser **dos** acciones:

| Acción | Cuándo | Qué genera |
|---|---|---|
| **Anular por error** | La venta no existió: ticket de prueba, mesa equivocada, cobro que nunca debió emitirse | **RF de anulación**. Sigue reabriendo la comanda y devolviendo las líneas, como hoy |
| **Devolver / rectificar** | La venta existió y hay que devolver dinero o corregir el importe | **RF de alta `R5`**, `TipoRectificativa = I`, importe **negativo**, referenciando la simplificada original |

La pantalla tiene que **explicar la diferencia en una frase**, no ofrecer dos botones parecidos. El
motivo obligatorio (CUENTA-07) se mantiene en las dos.

### 7.2 Lo que no cambia

Todo el modelo de CUENTA-07 sigue siendo correcto y es lo que hace esto barato: los pagos no se
borran, hay `Estado`, `Anulado_En`, `Anulado_Por` y `Motivo_Anulacion`, y quién anula sale de la
sesión (SEC-01). Lo que se añade encima es el registro fiscal.

### 7.3 Lo que sí cambia en el arqueo

Un `R5` mueve dinero: es una devolución real. Hoy el arqueo cuenta *cobros activos en efectivo*. Una
devolución en efectivo tiene que **restar** del esperado, y salir en `Movimientos_Caja` con un `Tipo`
nuevo (el `CHECK` estaba preparado para esto). Un RF de anulación, en cambio, se comporta como la
anulación de hoy.

### 7.4 Y una consecuencia incómoda de la numeración

Una rectificativa **gasta número de la misma serie**. `R5` y `F2` comparten `2027/…`. Se puede usar
una serie separada (`R-2027/…`), y es más legible en un listado, pero son dos contadores que mantener.
**Recomendación: una sola serie**, y el tipo de factura como columna. Menos que sincronizar.

---

## 8. Lo que choca con lo que ya hay

### 8.1 Recuperación (§9 de CLAUDE.md)

Es la parte más delicada del plan, porque `bootstrap_restaurar` **reemplaza tablas** y aquí hay una
cadena.

- `Registros_Facturacion` se replica a la nube por el outbox, como el resto del esquema. Es lo que
  permite que una Main que perdió su `data.db` recupere su cadena. **Ninguna ruta del worker puede
  escribirla**: la nube es copia, no fuente.
- Tras restaurar, el estado de envío (`_Verifactu_Envios`) **no vuelve** — es local. Se reconstruye
  preguntando a la AEAT con `ConsultaFactuSistemaFacturacion` (§6.7), que es la única fuente que sabe
  la verdad.
- Lo que se haya perdido (registros que nunca llegaron a la nube) **puede haberse remitido igual**,
  porque el envío a la AEAT y la replicación a la nube son dos caminos independientes. La
  reconciliación lo descubre.
- El contador salta hacia adelante (§3.3) y el primer registro nuevo lleva `Incidencia = "S"`.
- **Restaurar una copia local antigua es más peligroso que antes** y la pantalla tiene que decirlo:
  no se pierde sólo una venta, se pierde un tramo de cadena que la AEAT ya tiene.

El **cerrojo de escrituras de negocio** durante la recuperación (`Db::bloquear_escrituras_de_negocio`)
cubre esto sin tocar nada: un registro fiscal es una escritura de negocio, así que no se puede emitir
una factura mientras el equipo está recuperando. Que es lo correcto — tampoco se puede vender.

### 8.2 Retención (DB-14)

Ya estaba anotado en el backlog y ahora es una regla: **`Registros_Facturacion` no se purga nunca**
(conservación mínima: el plazo de prescripción, 4 años; en la práctica, no borrarlos). Lo que se
archive algún día será `Detalle_Comanda` y compañía, nunca esto.

### 8.3 La Handy

No cobra (`soloLaMainCobra`), así que no genera registros. **Y no debe poder hacerlo**: hay que
comprobar que ninguna ruta del worker escribe en las tablas nuevas, con el mismo criterio con que
`soloLaMainEscribeCaja` veta las escrituras de caja. Puede **ver** los tickets, como hoy.

### 8.4 El comprobador de comandos Tauri

`scripts/check-comandos-tauri.mjs` cubre los nombres nuevos solo. Nada que hacer, pero conviene
recordarlo al añadir `verifactu_*`.

---

## 9. Factura completa (FISCAL-02)

Dos caminos, y los dos hacen falta:

- **En el momento del cobro**: el cliente dice «con NIF». Se pide NIF, razón social y domicilio, y se
  emite **`F1`** en vez de `F2`. Es también el camino **obligatorio** por encima de 3.000 € (§2.2).
- **Después**: el cliente vuelve con el ticket. Se emite **`F3` en sustitución** de la simplificada,
  referenciándola en `FacturasSustituidas`. No se rectifica nada.

Los datos fiscales del cliente van en `Clientes` (que ya existe, con su ficha), para que un cliente
habitual no los dicte cada vez. Y la pantalla de Cuentas gana la acción «emitir factura de este
ticket», que es donde la va a buscar quien la necesite.

---

## 10. Exportación de registros

Art. 8 RRSIF: el sistema tiene que poder volcar sus registros. Desde **Configuración → Fiscal**, con
un rango de fechas, se genera un ZIP:

| Fichero | Qué lleva |
|---|---|
| `registros.xml` | Los registros en el formato del diseño oficial, tal como se remitieron |
| `registros.csv` | Lo mismo, legible en una hoja de cálculo |
| `cadena.txt` | `Num_Serie_Factura`, `Cadena_Huella` y `Huella` de cada uno — con esto un tercero puede **verificar la cadena entera** sin nuestro código |
| `manifiesto.json` | NIF, razón social, rango, número de registros, versión del SIF, fecha de generación |

Se reutiliza el patrón de `commands/recovery.rs::recovery_export_backup` (diálogo de fichero,
escritura fuera de AppData). Y como todo lo de esa familia, tiene que tolerar que la base esté en
mal estado: exportar es de las cosas que se piden justo cuando algo va mal.

---

## 11. Declaración responsable y datos del sistema

### 11.1 El bloque `SistemaInformatico`

Va **en cada registro** y describe a quién ha hecho el software:

| Campo | Valor | Máx |
|---|---|---|
| `NombreRazon` | Razón social del productor | 120 |
| `NIF` | NIF del productor | — |
| `NombreSistemaInformatico` | p. ej. `TPV Altaria` | **30** |
| `IdSistemaInformatico` | Identificador que asigna el productor | **2** |
| `Version` | La de `tauri.conf.json` | 50 |
| `NumeroInstalacion` | El `tenant_id` del equipo | 100 |
| `TipoUsoPosibleSoloVerifactu` | **`S`** | — |
| `TipoUsoPosibleMultiOT` | **`N`** | — |
| `IndicadorMultiplesOT` | **`N`** | — |

Las tres últimas son consecuencia directa de las decisiones de §0: un solo modo, y cada instalación
factura para un único obligado.

⚠️ `IdSistemaInformatico` son **dos caracteres**. No es el nombre; es un código corto del productor.

### 11.2 La declaración responsable

Art. 13 RRSIF: la DR del productor debe ser **visible en el propio sistema informático en cada una de
sus versiones**, además de para el cliente y el comercializador. O sea que no basta con tenerla en un
PDF: hay una **pantalla** en Configuración → Fiscal que la muestra, con la versión y los datos del
productor.

**Pendiente y bloqueante para lanzar** (no para desarrollar): redactar la DR. Necesita el NIF y la
razón social definitivos del productor, así que va cuando la empresa esté constituida.

### 11.3 Con qué NIF y qué certificado se puede probar

Se preguntó si hace falta un autónomo dado de alta en los epígrafes de informática. **No.** Lo que la
AEAT comprueba en el servicio web es otra cosa:

- **Que el remitente esté autorizado sobre el `ObligadoEmision`.** La FAQ lo enumera: se autentica a
  la persona remitente *«como el titular, su representante, su apoderado y, en los supuestos
  correspondientes, su representante por colaboración social»*. La forma de esquivar el problema
  entero es la más simple: **poner como obligado el mismo NIF del certificado**. Entonces eres el
  titular y no hace falta ninguna autorización.
- **Que los NIF existan** en la base de datos centralizada de la AEAT. Tienen que ser reales; no
  tienen que dedicarse a nada en concreto.
- El NIF del **productor**, dentro del bloque `SistemaInformatico`, es **dato declarado**. La AEAT no
  lo contrasta contra ningún registro de actividad económica, así que el epígrafe es irrelevante para
  que un envío se acepte.

O sea que para el tramo 5 sirve el NIF y el certificado de un autónomo cualquiera, usado a la vez
como obligado y como productor. Lo que sí hay que cambiar antes de lanzar son los datos del productor
por los definitivos, junto con la declaración responsable.

⚠️ **Sólo contra el [entorno de pruebas](https://preportal.aeat.es).** Un registro enviado a
producción es un registro de facturación real de ese NIF, y **no se «borra»**: como mucho se anula
con otro registro. Los endpoints de §6.1 se distinguen en tres caracteres (`prewww1` / `www1`), que
es exactamente el tipo de error que se comete a las dos de la mañana — de ahí que `Verifactu_Entorno`
(§3.4) sea una decisión explícita y visible, y no una variable de entorno.

---

## 12. Capas (patrón hexagonal del repo)

| Pieza | Dónde | Qué |
|---|---|---|
| Aritmética y formato | `crates/tpv-domain/src/verifactu.rs` | Huella, formateo de importes, desglose, URL del QR, validación del NIF. **Puro, sin BD ni reloj: aquí están los tests** |
| Desglose de IVA | `crates/tpv-domain/src/ticket.rs` (movido desde `printing.rs`) | Un único cálculo para papel, previa y registro |
| Puertos | `crates/tpv-application/src/ports/verifactu.rs` | `RegistrosRepository`, `AeatClient` |
| Casos de uso | `crates/tpv-application/src/use_cases/verifactu.rs` | Emitir, remitir el lote, clasificar respuestas, reconciliar, exportar |
| Persistencia | `crates/tpv-infra-sqlite/src/verifactu.rs` | Las tablas de §3, el contador, el cursor de pendientes |
| Emisión en el cobro | `infra-sqlite/src/{mesas,venta_rapida,cuentas}.rs` | Llamada dentro de la transacción existente |
| Adaptador AEAT | `crates/tpv-infra-aeat/` (**crate nueva**) | SOAP, XML, mTLS, certificado. Aislada porque trae su propia pila TLS |
| Job | `apps/tpv-main/src-tauri/src/jobs/registro.rs` | `verifactu_remitir` |
| Comandos | `apps/tpv-main/src-tauri/src/commands/verifactu.rs` | Panel, certificado, exportación, factura completa |
| QR en el papel | `apps/tpv-main/src-tauri/src/printing.rs` | Rasterizado por el camino del logo |
| Previa | `apps/tpv-main/src/shared/ticket/TicketPaper.tsx` | Espejo, como siempre |
| Pantallas | `features/configuracion/sections/Fiscal.tsx` (nueva) | Datos fiscales, certificado, estado de envío, DR, exportación |

---

## 13. Tests

Lo que hace este plan verificable sin una impresora ni Hacienda delante:

1. **Los tres vectores oficiales de la huella** (documento v0.1.2 §6): primer alta, alta encadenada y
   anulación encadenada. Son goldens exactos, con su cadena de entrada y su hash de salida. Si el
   formateo se desvía un carácter, fallan.
2. **El vector oficial del QR**: el ejemplo con `numserie=12345678&G33`, que sin URL-encoding parte
   la URL.
3. **Golden del XML** de un alta y una anulación, y **validación contra los XSD** descargados.
4. **Espejo previa/papel/registro**: el desglose de IVA, en tres sitios, con tabla golden duplicada a
   propósito — como ya se hace con `ticketMath.ts`.
5. **Cadena**: primer registro con `Huella=` vacía; el segundo referencia al primero; una
   restauración no rompe el orden.
6. **Numeración**: no retrocede tras restaurar una copia antigua; un hueco es aceptable, un número
   repetido no; el cambio de año abre serie nueva.
7. **Control de flujo**: función pura, como `proxima_espera` del runner de jobs.
8. **Clasificación de respuestas**: cada fila de la tabla de §6.5, con su respuesta XML de ejemplo.
9. **Transaccionalidad**: un cobro que hace rollback no deja registro ni gasta número.
10. **La Handy no puede escribir** en las tablas nuevas (test del worker).
11. **La escalera de avisos** (§1.2.1): función pura de `antigüedad → escalón`, y el test que importa
    de verdad — **`connectivity: "off"` no apaga la remisión**. Es un fallo que en producción no se
    vería nunca (el TPV parecería sano y la AEAT no recibiría nada), así que tiene que verse aquí.

**Fuera de los tests automáticos:** el envío real contra preproducción. Necesita certificado y sale a
internet, así que va como comprobación manual antes de release, junto al E2E (`RELEASING.md` §0-bis).
El E2E de la venta sí puede comprobar que **el registro se crea y el QR sale en el papel**, que es lo
que cruza React → IPC → Rust → SQLite.

---

## 14. Orden de implementación

Cada tramo deja el repo compilando y aporta algo comprobable.

| # | Tramo | Qué entrega |
|---|---|---|
| **1** | **Esquema y datos fiscales** | Tablas de §3, campos de `Business_Settings`, formulario de primer arranque, sección Fiscal. Los cinco sitios de un cambio de esquema (CLAUDE.md) |
| **2** | **La cadena, sin AEAT** | `tpv-domain/verifactu.rs` con los tres vectores oficiales en verde. Nada conectado todavía |
| **3** | **Emisión en el cobro** | El registro se crea en la transacción; el número fiscal sustituye a `Ticket_Contador`; el cobro devuelve el bloque fiscal |
| **4** | **QR y papel** | Rasterizado, colocación al principio, leyenda, previa espejo. **Aquí ya se emiten facturas conformes**, sólo que sin remitir |
| **5** | **El envío** | Crate `tpv-infra-aeat`, certificado por `.p12` (§6.2 A), job, control de flujo, clasificación, panel, **escalera de avisos** (§1.2.1). Preproducción |
| **6** | **Anulación y rectificativas** | Partir el botón (§7), `R5`, impacto en el arqueo |
| **7** | **Factura completa** | `F1` en el cobro y `F3` en sustitución (§9). Aquí se decide el límite de 3.000 € (§2.2) |
| **8** | **Cierre** | Exportación (§10), certificado del almacén de Windows (§6.2 B), declaración responsable (§11.2), reconciliación tras recuperación (§8.1), retención (DB-14) |

**El orden no es negociable en los tramos 2-4**: la cadena antes que la emisión, y la emisión antes
que el envío. Escribir el cliente SOAP primero es la forma más rápida de acabar depurando dos cosas a
la vez.

**Lo que hay que arrancar YA, en paralelo, porque no depende de nosotros:** conseguir el certificado
electrónico. Sin él el tramo 5 no se puede ni ensayar, y es lo único del plan con plazo
administrativo ajeno.

---

## 15. Lo que queda abierto

Cosas que **no** están decididas y cuándo hay que decidirlas. Que estén aquí es lo que las distingue
de un olvido.

| # | Qué | Cuándo | Bloquea |
|---|---|---|---|
| 1 | **Qué hace la pantalla por encima de 3.000 €** (§2.2) | Antes del tramo 7 | Nada antes |
| 2 | **Conseguir el certificado electrónico** | **YA** — tiene plazo administrativo ajeno | El tramo 5 entero |
| 3 | **Redactar la declaración responsable** (§11.2) | Antes de lanzar, no de desarrollar | El lanzamiento |
| 4 | **NIF y razón social definitivos del productor** (§11.1) | Cuando la empresa esté constituida | El lanzamiento |
| 5 | **`IdSistemaInformatico`**: elegir el código de dos caracteres | Tramo 5 | Nada |
| 6 | **Serie única vs. serie propia para rectificativas** (§7.4) | Tramo 6 | Nada |
| 7 | **Confirmar con un asesor** la modalidad y el tratamiento de devoluciones | Antes de lanzar | El lanzamiento |

---

## 16. Fuera de alcance (a propósito)

- **TicketBAI** (País Vasco y Navarra). Otro sistema, otra firma, otro XML.
- **Modalidad NO VERI\*FACTU**: firma XAdES por registro y registro de eventos. Se descartó en §0.
- **Facturación electrónica B2B** (Crea y Crece / la futura obligación de factura electrónica entre
  empresas). Es una norma **distinta** de esta, con su propio calendario. No se mezcla.
- **Que el worker remita** por cuenta de los clientes (la opción del apoderamiento). Se valoró y se
  descartó por no asumir responsabilidad legal sobre certificados de terceros. Queda anotada porque
  si algún día hay muchos clientes, es la que hace que un fallo se arregle en minutos y no en una
  release.
- **Multi-obligado por instalación**: `TipoUsoPosibleMultiOT = N`.

---

## 17. Fuentes

Todo lo técnico de este documento sale de aquí, no de memoria:

- **RD 1007/2023**, reglamento de requisitos de los SIF — arts. 9 (RF de alta), 11 (anulación),
  13 (declaración responsable), 15-16 (VERI\*FACTU).
  <https://www.boe.es/buscar/act.php?id=BOE-A-2023-24840>
- **Orden HAC/1177/2024** — especificaciones técnicas; art. 16.2 (control de flujo), arts. 20-21 (QR).
  <https://www.boe.es/diario_boe/txt.php?id=BOE-A-2024-22138>
- **RD 1619/2012** (ROF) — art. 4.2, límite de 3.000 € de la simplificada en hostelería.
  <https://www.boe.es/buscar/act.php?id=BOE-A-2012-14696>
- **Especificaciones de la huella**, v0.1.2 (27/08/2024) — algoritmo y los tres vectores de prueba.
  <https://www.agenciatributaria.es/static_files/AEAT_Desarrolladores/EEDD/IVA/VERI-FACTU/Veri-Factu_especificaciones_huella_hash_registros.pdf>
- **Especificaciones del QR**, v0.5.0 (10/12/2025) — URL, tamaños, ubicación y leyendas.
  <https://www.agenciatributaria.es/static_files/AEAT_Desarrolladores/EEDD/IVA/VERI-FACTU/DetalleEspecificacTecnCodigoQRfactura.pdf>
- **Descripción del servicio web**, v1.0.3 — SOAP, control de flujo, respuestas y errores.
  <https://www.agenciatributaria.es/static_files/AEAT_Desarrolladores/EEDD/IVA/VERI-FACTU/Veri-Factu_Descripcion_SWeb.pdf>
- **FAQ de empresas de desarrollo**, 04/12/2025 — anulación vs. rectificativa, arquitecturas
  TPV + backoffice, devoluciones, F3.
  <https://www.agenciatributaria.es/static_files/AEAT_Desarrolladores/EEDD/IVA/VERI-FACTU/FAQs-Desarrolladores.pdf>
- **WSDL y esquemas** — `SistemaFacturacion.wsdl`, `SuministroLR.xsd`, `SuministroInformacion.xsd`,
  `RespuestaSuministro.xsd`.
  <https://prewww2.aeat.es/static_files/common/internet/dep/aplicaciones/es/aeat/tikeV1.0/cont/ws/SistemaFacturacion.wsdl>
- **Portal de pruebas externas**: <https://preportal.aeat.es>

Y una fuente técnica que no es de la AEAT pero decide el §6.2:

- **`rustls-cng`** — puente entre las claves no exportables del almacén de Windows (CNG) y rustls.
  v0.7.1, bajo la organización `rustls`. <https://github.com/rustls/rustls-cng>

> **Aviso.** Esto es un documento de ingeniería escrito leyendo la norma y las especificaciones, no
> asesoramiento fiscal. Las decisiones con consecuencia tributaria —modalidad, declaración
> responsable, tratamiento de devoluciones— conviene contrastarlas con un asesor antes de lanzar.
