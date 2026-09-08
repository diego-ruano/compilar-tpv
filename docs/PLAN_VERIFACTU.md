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

Acordadas con el responsable el 2026-09-07 y el 2026-09-08.

| Decisión | Elección | Consecuencia de diseño |
|---|---|---|
| **Modalidad** | **VERI\*FACTU**, siempre, sin interruptor | No hay firma XAdES por registro ni registro de eventos. A cambio, **todo RF generado hay que remitirlo** |
| **Quién remite** | **La propia Main**, con el certificado del local instalado en el equipo | No custodiamos certificados de terceros. Precio: un bug en el XML se arregla **publicando una versión**, no redesplegando un worker (§6.6) |
| **Para qué el certificado** | **Sólo para autenticar la conexión (TLS mutuo).** En VERI\*FACTU **no se firma la factura** | La integridad la da la cadena de huellas, que es un SHA-256 pelado. La firma XAdES es de la otra modalidad (§6.2) |
| **Dónde vive el certificado** | **En el almacén de Windows**, y sólo ahí. Desde el primer día, pruebas incluidas | No parseamos formatos ni guardamos claves: sólo la huella del elegido. A cambio, es **sólo Windows** y hay que hacer un spike antes que nada (§6.2.1) |
| **Qué certificado vale** | **El que tenga el bar.** La interfaz no menciona el sello ni recomienda ninguno | El tipo sólo decide el endpoint (§6.1), y eso es una cuenta interna. Único filtro: que tenga clave privada (§6.2) |
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

⚠️ **Y una regla que es gratis ahora y cara después:** la palanca de emergencia `connectivity: "off"`
de `device_config.json` (SYNC-17, §9 de CLAUDE.md) apaga el WebSocket de sincronización. **No puede
apagar la remisión a la AEAT.** Son dos cosas distintas que comparten una palabra: una es una
comodidad de producto —«este cliente no quiere nube»— y la otra es una obligación tributaria. Si
compartieran interruptor, el atajo para una red patológica convertiría en silencio un TPV conforme en
uno que no lo es, y no se notaría: la aplicación se vería perfectamente sana.

Hoy **no hay ningún acoplamiento**: en Rust ese flag sólo lo tocan `get_connection_mode` y
`set_connection_mode` (`lib.rs`), quien actúa sobre él es `useMainSocket` en el frontend, y el gating
del runner de jobs sólo conoce `Siempre` y `MainOperativa`. O sea que cumplir esta regla consiste en
**no añadir nada**. Por eso se escribe aquí: la forma de romperla es que a alguien le parezca
razonable, dentro de seis meses, «respetar el modo de conexión» en el job nuevo.

**La remisión tiene su propia puerta**, y sólo la cierran dos cosas: no haber certificado, o estar en
modo pruebas.

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

### 2.2 El límite de los 3.000 € (decidido: 2026-09-08)

Una simplificada sólo vale hasta **400 € (IVA incluido)** con carácter general, pero la hostelería
está en la lista del art. 4.2 del RD 1619/2012 (*«servicios de hostelería y restauración prestados
por restaurantes, bares, cafeterías… así como el suministro de bebidas o comidas para consumir en el
acto»*), que sube el límite a **3.000 €**.

Por encima de esa cifra **no cabe una `F2`**: hay que emitir factura completa con destinatario.

**Cómo se comporta el TPV.** Al pulsar cobrar, si el importe supera el límite, sale una modal:
*«Al continuar se emitirá una factura completa en lugar de un ticket. Hará falta el NIF y el nombre
del cliente. ¿Continuar?»* → **Sí** abre el formulario de datos fiscales y emite `F1`; **No** vuelve
al cobro sin hacer nada. El detalle de esa pantalla está en §9.

**El límite se mira sobre el importe DEL COBRO, no sobre el total de la comanda.** No es un matiz
menor y juega a favor: como un cobro es una factura (§2.1), una comanda de 4.000 € que pagan dos
empresas a 2.000 € cada una son **dos simplificadas correctas**, y eso ya funciona hoy con el cobro
fraccionado.

⚠️ **Y por eso mismo no hay botón de «dividir el cobro».** Partir el pago de **un mismo** cliente
para bajar de 3.000 € es fraccionamiento artificial de una operación, que no es legal. Que el reparto
entre clientes distintos funcione es una consecuencia del modelo, no un atajo que ofrezcamos: ofrecer
el botón sería invitar a usarlo mal.

El umbral va en `Business_Settings` (`Limite_Simplif`) y no incrustado: es un número que la norma
puede mover.

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

### 2.5 La cena que acaba a la una y media: `FechaOperacion` NO se informa (decidido: 2026-09-08)

`FechaExpedicionFactura` es la fecha en que se expide la factura, o sea la del cobro. El XSD tiene
además un `FechaOperacion` **opcional**, para cuando la operación ocurrió otro día — y una cena de
23:30 a 01:30 abre comanda el día 4 y cobra el día 5.

**No se informa**, por dos razones:

1. **En hostelería la operación termina cuando el cliente paga y se va.** Abrir la comanda no es la
   operación: es su comienzo. Así que la fecha de la operación *es* la del cobro y el campo sobra.
2. Si se informara y cayera en **otro trimestre**, el devengo quedaría en un período y la factura en
   el siguiente. Eso es un descuadre que alguien tiene que explicar, a cambio de nada.

Es una decisión **reversible a coste cero**: el campo es opcional y añadirlo después no toca ni la
cadena ni el esquema. Si algún día el producto permite dejar una cuenta abierta y saldarla días más
tarde, hay que volver aquí. Y como es una cuestión de devengo, entra en la lista del asesor (§15).

### 2.6 Productos exentos de IVA (decidido: 2026-09-08)

**Poner 0 % en el IVA del producto NO sirve, porque no dice lo mismo.** En el esquema,
`CalificacionOperacion` y `OperacionExenta` están en un `<choice>`: o una o la otra, nunca las dos.

| | Cómo se expresa | Qué declara |
|---|---|---|
| **Tipo 0 %** | `CalificacionOperacion = S1`, `TipoImpositivo = 0`, `CuotaRepercutida = 0` | «Sujeta y **no** exenta, gravada al 0 %». Es un tipo real: fue lo que se aplicó al pan y la leche en 2023-24 |
| **Exenta** | `OperacionExenta = E1…E6`, y **prohibido** informar `TipoImpositivo`, `CuotaRepercutida`, `TipoRecargoEquivalencia` ni `CuotaRecargoEquivalencia` | «Esto no lleva IVA por ley» |

Son dos afirmaciones legales distintas, y el documento de validaciones lo hace explícito: *«Si el
campo OperacionExenta está cumplimentado no se pueden informar ninguno de estos campos:
TipoImpositivo, CuotaRepercutida…»*.

**Qué se añade.** Una marca en el producto, que se **congela en la línea de venta** igual que el
nombre, el precio y el tipo (§3.1 de `Detalle_Comanda`):

```sql
-- En Productos y, congelado, en Detalle_Comanda:
Exento          INTEGER NOT NULL DEFAULT 0,   -- 0 = sujeta y no exenta
Causa_Exencion  TEXT                          -- 'E1'..'E6'; NULL si no exento
```

⚠️ **Un booleano solo no basta para el XML**, y por eso van dos columnas: `OperacionExenta` exige
**cuál** exención, no un «sí». La interfaz enseña una casilla «Exento de IVA» y, al marcarla, un
desplegable de causa que **viene con `E1` puesto** (art. 20 LIVA, operaciones interiores), que es la
única realista en hostelería. Quien no sepa qué es eso, deja lo que hay.

Consecuencias en cascada, todas pequeñas pero ninguna opcional:

- El **desglose** deja de tener una sola forma: las líneas exentas se agrupan **por causa**, aparte
  de las sujetas, y no llevan tipo ni cuota (§4.2).
- El **ticket y la previa** necesitan una línea de «Exento» en el pie de IVA, con su base y sin cuota.
- `IVA_Percent` de un producto exento se ignora; la interfaz lo deshabilita al marcar la casilla.

**Nota sobre la lotería, que es el caso que uno se imagina:** la AEAT dice que la lotería a valor
facial es exenta **y no se factura**, y que si aparece en el mismo ticket va *«como si se pagara un
suplido»*, de modo que **sus importes NO entran en el registro** — alteran el «total a pagar», no el
«total factura». O sea que no es un producto exento, es otra cosa distinta, y queda **fuera de
alcance** (§16): la mayoría de los bares la venden por el terminal de Loterías, que es otra máquina.
Lo que esta marca cubre es cualquier otra exención que aparezca; lo que impide es que alguien intente
representarla con un 0 %.

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

  -- Subsanacion (6.5.1): una correccion es OTRA fila, nunca un UPDATE
  Subsanacion           TEXT,               -- 'S' o NULL
  Subsana_ID_Registro   TEXT,               -- a que registro rechazado repara

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

Lo que sí cambia en esa función es que **el desglose deja de tener una sola forma** (§2.6): las
líneas sujetas se agrupan por tipo impositivo y llevan `CalificacionOperacion` + tipo + cuota; las
exentas se agrupan **por causa de exención** y no llevan ni tipo ni cuota. Son dos clases de tramo en
la misma lista.

Y hay un margen que conviene conocer antes de pelearse con el redondeo: la AEAT comprueba que
`ImporteTotal` y `CuotaTotal` cuadren con la suma del desglose **con una tolerancia de ±10,00 €**
(§6.5.2). O sea que el céntimo de redondeo nunca va a disparar ese error — si salta, no es un
redondeo, es que el cálculo está roto.

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

| Entorno | Tipo de certificado | URL |
|---|---|---|
| Producción | Persona física / representante | `https://www1.agenciatributaria.gob.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP` |
| Producción | **Sello** (@firma tipo 4 u 8) | `https://www10.agenciatributaria.gob.es/…/VerifactuSOAP` |
| Pruebas | Persona física / representante | `https://prewww1.aeat.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP` |
| Pruebas | **Sello** | `https://prewww10.aeat.es/…/VerifactuSOAP` |

⚠️ **El endpoint depende del TIPO DE CERTIFICADO, no de quién envía.** Esto estaba mal en la primera
versión de este plan, que daba por hecho que `www10` era «la puerta de la opción de que remitiera el
worker». No lo es: el WSDL tiene un puerto `SistemaVerifactuSello` separado porque los certificados
de sello (tipos 4 y 8 en @firma) entran por otra subsede. Consecuencia práctica: **la URL se calcula
a partir del certificado elegido**, no es una constante.

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

**Decisión (2026-09-08): (B), y desde el primer día, también para las pruebas.** No es sólo por los
certificados no exportables:

- **No parseamos ningún formato.** Una vez el certificado está instalado en Windows, **da igual de
  qué fichero vino**: `.p12`, `.pfx`, un DNIe, una tarjeta criptográfica o un token USB salen todos
  por CNG igual. Con (A) cada formato raro es un caso nuestro; con (B) es problema de quien lo
  instaló, que además es quien sabe hacerlo.
- **No custodiamos nada.** No hay contraseña que pedir ni clave que guardar, así que el certificado
  **ni siquiera toca el `secret_store`**: lo único que guardamos es la **huella digital
  (*thumbprint*)** del certificado elegido, que no es un secreto. Un secreto menos que proteger es
  un secreto menos que filtrar.
- **El soporte se explica en una frase:** *«instálalo como lo instalarías para Autofirma»*. Eso una
  gestoría ya lo sabe hacer.

(C) se descarta: tiene los inconvenientes de (A) más una pila TLS extra. (A) se conserva **sólo como
plan de contingencia** si el spike de §6.2.1 sale mal.

#### Qué certificado vale: el que tenga

Sirven los tres tipos que la AEAT admite por servicio web —**persona física**, **representante** y
**sello de entidad** (tipos 4 y 8 en @firma)—, y **la aplicación no opina sobre cuál**. Se listan los
del almacén, el usuario elige, y el tipo sólo decide **a qué endpoint se envía** (§6.1), que es una
cuenta interna que el usuario no ve.

**Decisión (2026-09-08): en la interfaz no se menciona el sello.** Es de pago, sólo se emite a
personas jurídicas —un autónomo no puede tenerlo— y recomendarlo convierte una pantalla de dos clics
en una conversación fiscal. Quien lo tenga, lo elige de la lista como cualquier otro; quien no, usa
el suyo. Lo único que el código necesita saber es de qué tipo es, para el endpoint.

**El único filtro es técnico:** en la lista sólo aparecen los certificados **con clave privada**. Un
`.cer` o un `.crt` sólo llevan la parte pública, así que no pueden autenticar nada; si alguien
instala uno de esos creyendo que ya está, simplemente no saldrá en la lista.

#### 6.2.1 Lo que hay que aceptar a cambio

1. ⚠️ **El spike va PRIMERO, antes de una línea de XML.** `tls_backend_preconfigured` está documentado
   por reqwest como una opción avanzada y *«algo frágil»*, acoplada a la versión de rustls que lleve
   por dentro. La primera tarea del tramo 5 es un programa mínimo que abra una conexión a
   `prewww1.aeat.es` con un certificado del almacén y reciba **cualquier cosa** de vuelta. Si eso no
   sale en un día, todavía queda (A) y queda calendario. Si se descubre en diciembre con el XML ya
   escrito, no.
2. **Es sólo Windows.** Va tras `#[cfg(windows)]`, y el puerto `AeatClient` tiene que tener una
   implementación que no compile CNG en Android — el `libtpv_lib.so` del Handy sigue teniendo que
   construirse, y la Handy no remite porque no cobra.
3. **Los tests automáticos no pueden usarlo.** El certificado real está en un almacén de una máquina
   concreta. `AeatClient` es un puerto con un doble para los tests; el cliente de verdad se ejercita
   a mano contra preproducción, como el resto de lo que sale a internet.
4. **Un certificado renovado cambia de huella.** Se renuevan cada año o cada dos, y el que
   guardamos deja de existir. La pantalla tiene que decir *«el certificado que elegiste ya no está,
   elige otro»* — y hasta que alguien lo haga, la cola crece y la escalera de §1.2.1 hace su trabajo.
   Lo que no puede es dejar de remitir en silencio.
5. **El almacén es por usuario de Windows.** Si la gestoría entra con su sesión e instala ahí el
   certificado, el TPV corriendo como otro usuario **no lo ve**. Hay que buscar en `CurrentUser` y
   en `LocalMachine`, y decir en cuál se encontró: es una llamada de soporte garantizada.

#### 6.2.2 «Contraseña» son tres cosas distintas, y sólo una es un problema

Es la confusión natural al hablar de esto, y conviene tenerla desenredada por escrito:

| | Qué es | Cuándo la pide | ¿Nos afecta? |
|---|---|---|---|
| 1 | Contraseña del fichero `.p12`/`.pfx` | **Sólo al importarlo** a Windows | **No.** Una vez en el almacén no vuelve a pedirla nunca |
| 2 | *«Protección alta»* de clave privada — una casilla del asistente de importación | En **cada uso** | Sí, pero **se arregla**: reimportar sin marcarla |
| 3 | PIN de una tarjeta, DNIe o token USB | En **cada firma**, o sea cada handshake | Sí, y **no tiene arreglo**: es del hardware |

(1) es el caso benigno y es el que parece grave. (3) mata un job desatendido. (2) es el traicionero:
**es una casilla que alguien marcó sin querer**, se comporta igual que un PIN y tiene arreglo en dos
minutos si sabes que es eso.

**Qué hacemos:**

- **Detectar:** abrir la clave con `NCRYPT_SILENT_FLAG`. Si falla por necesitar interfaz, ese
  certificado no sirve para remitir solo. ⚠️ No es infalible — Microsoft documenta que con lectores
  con *pinpad* y drivers propios el flag se ignora y el diálogo sale igual.
- **Y por eso, un botón «probar ahora»** en la pantalla de selección que hace un handshake real
  contra preproducción. Si hay un diálogo de PIN escondido, sale **ahí, con el usuario delante**, y
  no a las tres de la mañana.
- **Lo que NO hacemos: guardar el PIN.** CNG permite pasarlo por programa
  (`NCRYPT_PIN_PROPERTY`) en algunos KSP, pero eso reintroduce justo el secreto que nos ahorramos al
  no usar `.p12`, depende del driver de cada tarjeta, y convierte «tengo el TPV» en «tengo el DNIe
  operativo del dueño».

**Y avisar de la caducidad**, que es el mismo problema visto antes de que ocurra: aviso a 30 días por
el sistema de notificaciones que ya existe.

### 6.3 El job — y nada más que el job

Conviene decir lo que **no** hace falta, porque la palabra «independiente» de §1.2.1 puede sugerir
más de lo que es. La remisión **no necesita infraestructura nueva**:

- **No usa el WebSocket.** Ese canal es para replicar a nuestra nube. Con la AEAT se habla por
  peticiones HTTPS normales (SOAP sobre HTTP, §6.1), y punto.
- **No es un runner nuevo.** Es un `Job` más en el catálogo que ya existe, con su vencimiento por
  reloj de pared, su jitter, su backoff y su registro en `_Jobs_State`, como los demás.
- **No es un hilo suelto ni un `setInterval`.** Eso ya está prohibido por §10 de CLAUDE.md y aquí no
  hay motivo para la excepción.

«Independiente» significa exactamente una cosa: **que su gating no cuelgue del interruptor de la
sincronización**. Que, como se vio arriba, se consigue no escribiendo nada.

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
| `AceptadoConErrores` | **Está en la AEAT**, pero **hay que subsanarlo** (§6.5.2) | `ACEPTADO_CON_ERRORES`. No se reenvía igual — se corrige y se manda una **subsanación** (§6.5.1). Sale en el panel como pendiente de arreglar |
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

### 6.5.1 Qué se hace con un registro rechazado: la subsanación

La tabla de arriba dice cuándo un registro queda `RECHAZADO`, pero no qué se hace con él, y no es
«volver a mandar lo mismo»: si la AEAT lo rechazó por el contenido, reenviarlo idéntico lo rechazará
igual. La norma tiene un instrumento propio, el **registro de alta de subsanación**:

- Se genera un **RF de alta nuevo** con los datos ya corregidos, marcado `Subsanacion = "S"` y
  `RechazoPrevio = "X"` (que significa: *«el anterior fue rechazado, este lo repara»*).
- **Conserva el mismo `IDFactura`** — misma serie, mismo número, misma fecha. No es una factura
  nueva, es el mismo hecho bien contado.
- Y **entra en la cadena como cualquier otro registro**, con su `Orden`, su huella y su eslabón
  anterior. La cadena no se reescribe nunca.

Consecuencia en el modelo (§3.1): `Registros_Facturacion` es append-only, así que una subsanación es
**otra fila**, no un `UPDATE` de la rechazada. Hacen falta dos columnas más para poder contarlo:
`Subsanacion` y `Subsana_ID_Registro` (a cuál repara).

⚠️ **Y una regla de producto:** subsanar **no puede ser automático**. Si el TPV corrige y reenvía
solo, un error sistemático nuestro se convierte en dos registros malos por venta en vez de uno. La
subsanación la dispara una persona desde el panel, después de mirar qué dijo la AEAT. Lo que sí es
automático es el reintento de los fallos de **transporte**, que son otra cosa.

**Y un límite que la norma pone:** *«sólo podrá llevarse a cabo una subsanación cuando no se trate de
una causa que exija la emisión de una factura rectificativa»*. Si el importe estaba mal porque se
cobró de más, no se subsana: se rectifica (§7). La subsanación es para el registro mal contado, no
para la venta mal hecha.

### 6.5.2 Los «errores admisibles»: la lista es corta y hay que conocerla entera

`AceptadoConErrores` no significa «avisos que puedes ignorar». El documento de validaciones dice que
esos registros *«serán aceptados y registrados por los sistemas de la AEAT, pero **deberán ser
subsanados**»*. La lista completa en la versión actual —y merece leerse porque **tres de las seis nos
tocan directamente**— es:

| Error admisible | Nos toca | Qué significa para nosotros |
|---|---|---|
| **La huella no coincide con la calculada por la AEAT** | 🔴 **Sí** | Un bug en §4. Aceptan el registro y lo dejan marcado. Es el fallo silencioso del que hablaba §6.5 |
| **`ImporteTotal` no cuadra** con la suma del desglose (base + cuota + recargo), fuera del margen | 🔴 **Sí** | Un bug en el redondeo de §4.2. **El margen es de ±10,00 €**, así que un céntimo de redondeo no lo dispara: si salta, está roto de verdad |
| **`CuotaTotal` no cuadra** con la suma de cuotas, fuera del margen | 🔴 **Sí** | Lo mismo |
| **`PrimerRegistro = "S"` y ya existen registros** para ese SIF y NIF | 🟠 **Sí, tras una recuperación** | Es exactamente el escenario de §8.1. Otra razón para reconciliar contra la AEAT antes de seguir la cadena |
| NIF del destinatario correcto pero **no censado** en la AEAT | 🟡 Sólo con `F1`/`F3` | El cliente dictó un NIF que no existe. Hay que poder corregirlo desde el panel |
| `ClaveRegimen` sin informar con `Impuesto = IPSI` | ⚪ No | Ceuta y Melilla, fuera de alcance |

Dos de la lista **están exceptuadas de subsanar**: la de IPSI y la de una `FechaHoraHusoGenRegistro`
posterior al reloj de la AEAT (que admite margen). Esa segunda conviene tenerla presente: **el reloj
del equipo del bar puede ir adelantado**, y eso genera un error admisible sin que nadie haya hecho
nada mal. No hay que corregirlo, pero sí hay que **no asustarse** al verlo en el panel.

Y una tercera vía que la norma contempla y que no viene de un rechazo: *«dato incorrecto detectado
posteriormente por el obligado»* sobre un registro **aceptado sin errores**. También se arregla con
una subsanación. O sea que el botón del panel tiene que poder dispararse sobre cualquier registro, no
sólo sobre los que vinieron marcados.

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

- **En el momento del cobro**: o porque el cliente dice «con NIF», o porque el importe pasa de
  3.000 € y entonces no hay alternativa (§2.2). Se emite **`F1`** en vez de `F2`.
- **Después**: el cliente vuelve con el ticket. Se emite **`F3` en sustitución** de la simplificada,
  referenciándola en `FacturasSustituidas`. **No se rectifica nada** — canjear una simplificada por
  una completa no es rectificar (art. 15.6 ROF).

### 9.1 Cómo se comporta el cobro

1. Al pulsar cobrar, si el importe supera `Limite_Simplif`, salta una modal: *«Al continuar se
   emitirá una factura completa en lugar de un ticket. Hará falta el NIF y el nombre del cliente.
   ¿Continuar?»* — **Sí** / **No**. Si el cliente pide factura voluntariamente, se llega al mismo
   sitio por un botón «Factura con NIF», sin modal de aviso.
2. **Sí** → formulario de datos fiscales.
3. Se cobra y se emite `F1`. El resto (cadena, QR, envío) es idéntico.

### 9.2 Qué datos hacen falta, y son más de los que parecen

El **registro** sólo necesita `NombreRazon` + `NIF` del destinatario. Pero la **factura en papel** es
un documento con su propio contenido obligatorio (art. 6 ROF), y ahí hace falta también el
**domicilio** del destinatario — y el del emisor, que ya lo tenemos en `Business_Settings`.

El formulario pide, entonces:

| Campo | ¿Obligatorio? | Dónde acaba |
|---|---|---|
| NIF | Sí | Registro **y** papel |
| Nombre o razón social | Sí | Registro **y** papel |
| Domicilio fiscal | Sí para el papel | Sólo el papel |

Con validación de formato del NIF en el momento — un NIF mal dictado **no** se rechaza al enviar,
vuelve como *«error admisible: NIF no censado»* (§6.5.2), o sea horas después y sin el cliente
delante. Comprobar el dígito de control ahí mismo evita casi todos esos casos.

**Se ofrece elegir un cliente de `Clientes`** y, tras escribir los datos a mano, guardarlos en su
ficha: la comida de empresa que se repite cada mes no debería dictar el NIF doce veces. Eso exige
añadir a `Clientes` los campos fiscales, que hoy no tiene.

### 9.3 El papel

Una factura completa **cabe en el rollo térmico** y es legal ahí: el ROF no impone formato. Sale más
larga porque lleva los datos de las dos partes. Lo que cambia respecto al ticket es la cabecera —
emisor completo y destinatario— y que la palabra «Factura» sustituye a lo que hoy no dice nada. El QR
y la leyenda van igual, al principio.

### 9.4 El canje posterior (`F3`)

La pantalla de Cuentas gana la acción **«emitir factura de este ticket»**, que es donde la va a
buscar quien la necesite. Pide los mismos datos de §9.2, emite una `F3` que referencia la
simplificada en `FacturasSustituidas`, y **la simplificada original se queda como está**: no se anula
ni se rectifica.

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
12. **Exentos** (§2.6): una línea exenta produce `OperacionExenta` y **ni `TipoImpositivo` ni
    `CuotaRepercutida`**; un producto al 0 % produce `S1` con tipo y cuota a cero. Son dos goldens
    distintos y el test existe para que nadie los unifique «simplificando».
13. **El límite de la simplificada** (§2.2): se mira sobre el importe **del cobro**, no de la
    comanda. Dos cobros de 2.000 € sobre una comanda de 4.000 € siguen siendo dos `F2`.

**Fuera de los tests automáticos:** el envío real contra preproducción. Necesita certificado y sale a
internet, así que va como comprobación manual antes de release, junto al E2E (`RELEASING.md` §0-bis).
El E2E de la venta sí puede comprobar que **el registro se crea y el QR sale en el papel**, que es lo
que cruza React → IPC → Rust → SQLite.

---

## 14. Orden de implementación

Cada tramo deja el repo compilando y aporta algo comprobable.

| # | Tramo | Qué entrega |
|---|---|---|
| **1** | **Esquema y datos fiscales** | Tablas de §3, campos de `Business_Settings`, **`Exento` + `Causa_Exencion` en `Productos` y `Detalle_Comanda`** (§2.6), campos fiscales en `Clientes` (§9.2), formulario de primer arranque, sección Fiscal. Los cinco sitios de un cambio de esquema (CLAUDE.md) |
| **2** | **La cadena, sin AEAT** | `tpv-domain/verifactu.rs` con los tres vectores oficiales en verde, y el desglose con sus dos clases de tramo (§4.2). Nada conectado todavía |
| **3** | **Emisión en el cobro** | El registro se crea en la transacción; el número fiscal sustituye a `Ticket_Contador`; el cobro devuelve el bloque fiscal |
| **4** | **QR y papel** | Rasterizado, colocación al principio, leyenda, previa espejo. **Aquí ya se emiten facturas conformes**, sólo que sin remitir |
| **5** | **El envío** | **Spike de `rustls-cng` primero** (§6.2.1), luego crate `tpv-infra-aeat`, selección del certificado, job, control de flujo, clasificación (§6.5), **subsanación desde el panel** (§6.5.1), **escalera de avisos** (§1.2.1). Preproducción |
| **6** | **Anulación y rectificativas** | Partir el botón (§7), `R5`, impacto en el arqueo |
| **7** | **Factura completa** | `F1` en el cobro con su modal y su formulario, `F3` en sustitución desde Cuentas, y el corte de los 3.000 € (§2.2, §9) |
| **8** | **Cierre** | Exportación (§10), declaración responsable (§11.2), reconciliación tras recuperación (§8.1), retención (DB-14) |

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
| 1 | **Conseguir el certificado electrónico** e instalarlo en el almacén de Windows | **YA** — tiene plazo administrativo ajeno | El tramo 5 entero |
| 2b | **Spike de `rustls-cng`**: handshake contra `prewww1.aeat.es` con un certificado del almacén | En cuanto haya certificado, **antes de escribir XML** | Confirma o tumba la decisión de §6.2 |
| 3 | **Redactar la declaración responsable** (§11.2) | Antes de lanzar, no de desarrollar | El lanzamiento |
| 4 | **NIF y razón social definitivos del productor** (§11.1) | Cuando la empresa esté constituida | El lanzamiento |
| 5 | **`IdSistemaInformatico`**: elegir el código de dos caracteres | Tramo 5 | Nada |
| 6 | **Serie única vs. serie propia para rectificativas** (§7.4) | Tramo 6 | Nada |
| 7 | **Confirmar con un asesor**: la modalidad, el tratamiento de devoluciones y la decisión de no informar `FechaOperacion` (§2.5), que es una cuestión de devengo | Antes de lanzar | El lanzamiento |
| 8 | **Un solo TPV por negocio.** La cadena asume una única Main; dos cajas serían dos cadenas y dos series | Cuando alguien lo pida | Nada hoy |

**Cerradas el 2026-09-08:** el comportamiento por encima de 3.000 € (§2.2), los productos exentos
(§2.6), `FechaOperacion` (§2.5) y **Canarias, Ceuta y Melilla, que quedan fuera de alcance** (§16).

---

## 16. Fuera de alcance (a propósito)

- **TicketBAI** (País Vasco y Navarra). Otro sistema, otra firma, otro XML.
- **Canarias, Ceuta y Melilla** (decidido: 2026-09-08). Allí no se repercute IVA sino **IGIC** o
  **IPSI**, que son otros valores del campo `Impuesto` (`03` y `02`), con sus propias claves de
  régimen, sus tipos y sus exenciones (`E7` y `E8` sólo existen para IGIC). Entrarían sin rehacer
  nada —el desglose ya es una lista de tramos—, pero hoy no hay motivo.
- **La lotería** (§2.6). No es un producto exento sino un **suplido**: sus importes no entran en el
  registro y cambian el «total a pagar» sin cambiar el «total factura». Además casi todos los bares
  la venden por el terminal de Loterías, que es otra máquina.
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
- **Validaciones y errores**, v1.2.2 — tipología de validaciones, catálogo de **errores admisibles**,
  tratamiento de la subsanación y márgenes de cuadre de importes.
  <https://www.agenciatributaria.es/static_files/AEAT_Desarrolladores/EEDD/IVA/VERI-FACTU/Validaciones_Errores_Veri-Factu.pdf>
- **FAQ de empresas de desarrollo**, 04/12/2025 — anulación vs. rectificativa, arquitecturas
  TPV + backoffice, devoluciones, F3, lotería.
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
