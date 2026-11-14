// La tanda: un negocio de pruebas montado como el primer día de un bar —licencia, la Main con su
// socket y sus datos, una Handy emparejada— y después el plan de peticiones variadas de servicio.
//
// Las operaciones de la Main llevan el SQL que sube la Main real por su outbox
// (`crates/tpv-infra-sqlite`), con la hora ya convertida en literal como hace `rewrite_now_literals`.
// Las de la Handy son las rutas REST que usa `crates/tpv-infra-http`.

import { performance } from "node:perf_hooks";
import { setTimeout as dormir } from "node:timers/promises";

import { Equipo, Socket, pedirAdmin } from "./cliente.mjs";
import { fechaLocal, hashPin, horaConHuso, horaLocal, mensajeRecogida, nuevaIdentidad, nuevoId, sha256Hex } from "./firma.mjs";
import { Cancelado, FrenoDeSeguridad } from "./registro.mjs";

/** El administrador que siembra el TenantHub al aprovisionar (`tenantHub.alta.ts`). */
const ADMIN = "00000000-0000-7000-8000-000000000501";
/**
 * El PIN que el administrador elige en la Main el primer día. El de la siembra es público y la nube
 * no deja entrar con él (`Requiere_Setup = 1`) hasta que sube éste por el outbox (AUD-24).
 */
const PIN_ADMIN = "4826";
const ROL_CAMARERO = "00000000-0000-7000-8000-000000000002";
const GLUTEN = "00000000-0000-7000-8000-000000000201";
const LACTEOS = "00000000-0000-7000-8000-000000000207";
const NIF = "B12345674";
const RAZON_SOCIAL = "Bar de Carga SL";
/** Un `.test` no existe: lo que se mande ahí no llega a nadie. La licencia se emite sin `sendKey`. */
const CORREO_DE_CARGA = "carga@altarialights.test";

/** Los cambios que pide la Main por página de `/v1/sync/changes` (`replicacion.rs::CAMBIOS_POR_PAGINA`). */
const CAMBIOS_POR_PAGINA = 1000;

const SQL_TOTAL_COMANDA =
  "UPDATE Comandas SET Total_Comanda = (SELECT IFNULL(SUM(CAST(ROUND(COALESCE(Cantidad,1) * COALESCE(Precio_Unitario,0)) AS INTEGER)), 0) FROM Detalle_Comanda WHERE ID_Comanda = ?1) WHERE ID_Comanda = ?1;";

class Saltado extends Error {}

const s = (sql, args = []) => ({ sql, args });
/** Una operación de la Main: una transacción suya, como la escribe `write_op` en `_Sync_Outbox`. */
const op = sentencias => ({ opId: nuevoId(), commandName: "main_op", sentencias });

function exigir(r, que) {
  if (!r.ok) throw new Error(`${que}: ${r.status} ${r.error ?? ""}`.trim());
  return r.datos;
}

function necesita(valor, que) {
  if (valor == null) throw new Saltado(`falta ${que}`);
  return valor;
}

/** Cada paso de la preparación empieza por aquí: con Ctrl+C no se da ninguno más. */
function anunciar(ctx, etapa, texto) {
  if (ctx.cancelado) throw new Cancelado();
  ctx.registro.etapa = etapa;
  console.log(`  · ${texto}`);
}

/* ===== Preparación ===== */

/**
 * Deja un negocio de pruebas listo: licencia emitida y activada (la base del negocio se crea aquí), la
 * Main conectada con sus datos y una Handy emparejada con el camarero dentro.
 */
export async function prepararNegocio(ctx) {
  const { registro } = ctx;
  registro.fase = "preparacion";
  ctx.ventanas.preparacion = { desde: new Date().toISOString() };

  anunciar(ctx, "licencia", "Licencia de pruebas");
  const licencia = exigir(
    await pedirAdmin(ctx.admin, "POST", "/v1/admin/licenses", { termMonths: 12, email: CORREO_DE_CARGA, name: `Carga ${ctx.tanda}`, pruebas: true }),
    "No se pudo emitir la licencia de pruebas",
  );
  ctx.estado.licenseId = licencia.licenseId;
  ctx.estado.claveCorta = licencia.keyShort;
  ctx.guardarEstado();

  const main = new Equipo({ nombre: "main", rol: "main", base: ctx.base, identidad: nuevaIdentidad(), registro });
  ctx.main = main;
  anunciar(ctx, "activar", "Activar la licencia en la Main (crea la base del negocio en su TenantHub)");
  // Antes de activar: el worker crea la fila de `devices` antes que la base, así que si la activación
  // falla a medias, este id lleva al negocio (y a la base de su TenantHub) que la retirada no ve.
  ctx.estado.mainDeviceId = main.identidad.deviceId;
  ctx.estado.activacion = "en curso";
  ctx.guardarEstado();
  // Sin reintentos: si falla después de crear la base, repetir estrenaría otra (AUD-09).
  const activacion = exigir(
    await main.pedir("POST", "/v1/license/activate", {
      cuerpo: {
        activationKey: licencia.key,
        deviceId: main.identidad.deviceId,
        devicePubKey: main.identidad.clavePublica,
        tenantInfo: { displayName: `Carga ${ctx.tanda}` },
      },
      firmada: false,
      firmaSinToken: true,
      horaCliente: false,
      tipo: "alta",
      timeoutMs: 120_000,
    }),
    "La activación falló",
  );
  main.token = activacion.token;
  main.tenantId = activacion.tenantId;
  ctx.estado.tenantId = activacion.tenantId;
  ctx.estado.activacion = "hecha";
  ctx.guardarEstado();

  anunciar(ctx, "socket-main", "Conectar la Main al TenantHub");
  ctx.socketMain = new Socket(main);
  await ctx.socketMain.abrir();

  anunciar(ctx, "catch-up", "Catch-up de la Main al conectar");
  exigir(await main.pedir("POST", "/v1/sync/changes", { cuerpo: { since: 0, limit: CAMBIOS_POR_PAGINA }, tipo: "main-rest" }), "El catch-up de la Main falló");

  // Lo que la Main sube al conectar, con las Handy congeladas hasta que termina: su outbox entero, por
  // lotes, como `subir_pendientes` (aquí cabe en uno).
  const semilla = semillaDelNegocio(ctx);
  anunciar(ctx, "semilla", `Semilla de la Main: ${semilla.length} operaciones por apply_lote`);
  const aplicadas = await ctx.socketMain.subir(semilla);
  const seqs = [...aplicadas.values()].map(a => a.seq);
  console.log(`    ${aplicadas.size} aplicadas en ${ctx.socketMain.lotes} lote(s), Seq ${Math.min(...seqs)}–${Math.max(...seqs)}`);
  anunciar(ctx, "recovery-ready", "La Main está al día y suelta a las Handy (recovery_ready)");
  await ctx.socketMain.listo();

  await emparejarHandy(ctx);

  anunciar(ctx, "login-camarero", "El camarero entra en la Handy");
  const usuarios = exigir(await ctx.handy.pedir("GET", "/v1/login/users", { tipo: "lectura" }), "La Handy no pudo leer los usuarios");
  if (!usuarios.some?.(u => u.id_usuario === ctx.ids.usuarioCamarero)) {
    throw new Error("La Handy no ve al camarero que acaba de crear la Main: la semilla no llegó a la base del negocio.");
  }
  exigir(
    await ctx.handy.pedir("POST", "/v1/login/login", { cuerpo: { id_usuario: ctx.ids.usuarioCamarero, pin: "" }, tipo: "login" }),
    "El camarero no pudo entrar",
  );

  ctx.seqAlEmpezarLaCarga = ctx.socketMain.maxSeq;
  ctx.ventanas.preparacion.hasta = new Date().toISOString();
  ctx.guardarEstado();
}

async function emparejarHandy(ctx) {
  const { main, registro } = ctx;
  const handy = new Equipo({ nombre: "handy", rol: "handy", base: ctx.base, identidad: nuevaIdentidad(), registro });
  // El reloj es el mismo equipo: si la Main ya aprendió el desfase, la Handy lo hereda. Su primera
  // petición con hora (`fetch-token`) no va firmada y no se repetiría.
  handy.desfaseMs = main.desfaseMs;
  ctx.handy = handy;

  anunciar(ctx, "emparejar", "Emparejar una Handy");
  const codigo = exigir(await main.pedir("POST", "/v1/pair/create", { cuerpo: {}, tipo: "emparejamiento" }), "La Main no pudo crear el código");
  const reclamo = exigir(
    await handy.pedir("POST", "/v1/pair/claim", {
      cuerpo: {
        pairCode: codigo.pairCode,
        pairSecret: codigo.pairSecret,
        deviceId: handy.identidad.deviceId,
        devicePubKey: handy.identidad.clavePublica,
        deviceName: "carga-handy-1",
      },
      firmada: false,
      tipo: "emparejamiento",
    }),
    "La Handy no pudo reclamar el código",
  );
  exigir(await main.pedir("POST", "/v1/pair/approve", { cuerpo: { pairCode: codigo.pairCode }, tipo: "emparejamiento" }), "La Main no pudo aprobar");
  const ts = handy.ahoraMs();
  const recogida = exigir(
    await handy.pedir("POST", "/v1/pair/fetch-token", {
      cuerpo: {
        pairCode: codigo.pairCode,
        deviceId: handy.identidad.deviceId,
        nonceB64: reclamo.nonceB64,
        ts,
        sigB64: handy.identidad.firmar(mensajeRecogida(ts, codigo.pairCode, reclamo.nonceB64, handy.identidad.deviceId)),
      },
      firmada: false,
      tipo: "emparejamiento",
    }),
    "La Handy no pudo recoger su token",
  );
  if (recogida.tenantId !== main.tenantId) throw new Error("La Handy quedó emparejada con otro negocio.");
  handy.token = recogida.token;
  handy.tenantId = recogida.tenantId;
  ctx.estado.handyDeviceId = handy.identidad.deviceId;
  ctx.guardarEstado();

  anunciar(ctx, "socket-handy", "Conectar la Handy al TenantHub");
  // Lo que subió la Main antes: su `change` no le llega a la Handy, que lo leerá de la base.
  ctx.opsAntesDeLaHandy = new Set(ctx.socketMain.confirmadas.keys());
  ctx.socketHandy = new Socket(handy);
  await ctx.socketHandy.abrir();
}

/**
 * Lo que da de alta una Main el primer día, en el orden de sus dependencias: datos del negocio,
 * carta, plano, un camarero sin PIN y un cliente. El SQL es el de `crates/tpv-infra-sqlite`.
 */
function semillaDelNegocio(ctx) {
  const ahora = horaLocal();
  const ids = ctx.ids;
  ids.categorias = { bebidas: nuevoId(), cocina: nuevoId() };
  ids.zona = nuevoId();
  // La Main trabaja siempre en la 2 (la cobra en cada vuelta); la Handy abre una mesa nueva por vuelta.
  ids.mesas = Array.from({ length: Math.max(4, (ctx.vueltas ?? 1) + 2) }, () => nuevoId());
  ids.usuarioCamarero = nuevoId();
  ids.trabajador = nuevoId();
  ids.clienteSemilla = nuevoId();
  const productos = [
    { clave: "cana", nombre: "Caña", categoria: ids.categorias.bebidas, precio: 250 },
    { clave: "refresco", nombre: "Refresco", categoria: ids.categorias.bebidas, precio: 280, stock: 48 },
    { clave: "bocadillo", nombre: "Bocadillo de jamón", categoria: ids.categorias.cocina, precio: 550, alergenos: [GLUTEN] },
    { clave: "croquetas", nombre: "Croquetas (6 u.)", categoria: ids.categorias.cocina, precio: 750, alergenos: [GLUTEN, LACTEOS] },
  ].map(p => ({ ...p, id: nuevoId() }));
  ctx.productos = Object.fromEntries(productos.map(p => [p.clave, p]));

  // `inventario.rs`: la categoría y el producto se guardan con upsert.
  const categoria = (id, nombre, pasaCocina) =>
    op([
      s(
        "INSERT INTO Categorias_Producto (ID_Categoria, Nombre, Nombre_Imagen, Ruta_Imagen, Vendible, Pasa_Cocina) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(ID_Categoria) DO UPDATE SET Nombre = excluded.Nombre, Nombre_Imagen = excluded.Nombre_Imagen, Ruta_Imagen = excluded.Ruta_Imagen, Vendible = excluded.Vendible, Pasa_Cocina = excluded.Pasa_Cocina;",
        [id, nombre, "", "", 1, pasaCocina],
      ),
    ]);
  const producto = p => {
    const sentencias = [
      s(
        "INSERT INTO Productos (ID_Producto, ID_Categoria, ID_Proveedor, Nombre, Precio_Venta, Stock_Minimo, Unidad_Medida, Nombre_Imagen, Ruta_Imagen, Cantidad_Pedido_Esperada, Stock_Suelto, IVA_Percent) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12) ON CONFLICT(ID_Producto) DO UPDATE SET ID_Categoria = excluded.ID_Categoria, ID_Proveedor = excluded.ID_Proveedor, Nombre = excluded.Nombre, Precio_Venta = excluded.Precio_Venta, Stock_Minimo = excluded.Stock_Minimo, Unidad_Medida = excluded.Unidad_Medida, Nombre_Imagen = COALESCE(excluded.Nombre_Imagen, Productos.Nombre_Imagen), Ruta_Imagen = COALESCE(excluded.Ruta_Imagen, Productos.Ruta_Imagen), Cantidad_Pedido_Esperada = excluded.Cantidad_Pedido_Esperada, IVA_Percent = excluded.IVA_Percent;",
        [p.id, p.categoria, null, p.nombre, p.precio, null, null, null, null, null, p.stock ?? null, null],
      ),
    ];
    if (p.stock != null) {
      sentencias.push(
        s(
          `INSERT INTO Movimientos_Stock (ID_Movimiento, ID_Producto, Tipo, Delta, Stock_Resultante, Motivo, ID_Usuario, Fecha) VALUES (?1, ?2, 'ALTA', ?3, ?3, 'Alta del producto', ?4, '${ahora}');`,
          [nuevoId(), p.id, p.stock, ADMIN],
        ),
      );
    }
    sentencias.push(s("DELETE FROM Producto_Alergenos WHERE ID_Producto=?1;", [p.id]));
    for (const a of p.alergenos ?? []) {
      sentencias.push(s("INSERT OR IGNORE INTO Producto_Alergenos (ID_Producto, ID_Alergeno) VALUES (?1, ?2);", [p.id, a]));
    }
    return op(sentencias);
  };
  // `mesas.rs`, sin las sentencias de «quitar lo que no viene», que en una base vacía no tocan nada.
  // `Numero_Mesa` es TEXT: un número viajaría como REAL y se guardaría «1.0».
  const plano = op([
    s(
      `INSERT INTO Zonas (ID_Zona, Nombre_Zona, Room_Points, Updated_At) VALUES (?1, ?2, ?3, '${ahora}') ON CONFLICT(Nombre_Zona) WHERE Archivada_En IS NULL DO UPDATE SET Room_Points = excluded.Room_Points, Updated_At = excluded.Updated_At;`,
      [ids.zona, "Sala", "[0.0,0.0,800.0,0.0,800.0,600.0,0.0,600.0]"],
    ),
    ...ids.mesas.map((mesa, i) =>
      s(
        `INSERT INTO Mesas (ID_Mesa, ID_Zona, Numero_Mesa, Capacidad, Ubicacion_X, Ubicacion_Y, Shape, Width, Height, Radius, Updated_At) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, '${ahora}') ON CONFLICT(ID_Zona, Numero_Mesa) WHERE Archivada_En IS NULL DO UPDATE SET Capacidad = excluded.Capacidad, Ubicacion_X = excluded.Ubicacion_X, Ubicacion_Y = excluded.Ubicacion_Y, Shape = excluded.Shape, Width = excluded.Width, Height = excluded.Height, Radius = excluded.Radius, Updated_At = excluded.Updated_At;`,
        [mesa, ids.zona, String(i + 1), 4, 40 + 160 * i, 40, "rounded", 120, 70, null],
      ),
    ),
  ]);
  // `trabajadores.rs`: usuario y trabajador en la misma transacción. Sin PIN, como el camarero que
  // entra con un toque; conserva un PIN al azar (permisos.md).
  const camarero = op([
    s(
      "INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre, Apellido, Estado, Sin_PIN) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8);",
      [ids.usuarioCamarero, ROL_CAMARERO, "camarero@carga.test", hashPin("839201"), "Luis", "Camarero", "Activo", 1],
    ),
    s(
      "INSERT INTO Trabajadores (ID_Trabajador, ID_Usuario, DNI, Telefono, Puesto, IBAN, Numero_Seguridad_Social, Fecha_Inicio_Contrato, Fecha_Fin_Contrato) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9);",
      [ids.trabajador, ids.usuarioCamarero, null, null, "Camarero", null, null, fechaLocal(), null],
    ),
  ]);
  const cliente = op([
    s(
      `INSERT INTO Clientes (ID_Cliente, Nombre, Telefono, Email, Notas, Created_At) VALUES (?1, ?2, ?3, ?4, ?5, '${ahora}') ON CONFLICT(ID_Cliente) DO UPDATE SET Nombre = excluded.Nombre, Telefono = excluded.Telefono, Email = excluded.Email, Notas = excluded.Notas;`,
      [ids.clienteSemilla, "Laura Gómez", "600111222", "laura@carga.test", null],
    ),
  ]);

  return [
    // `login.rs::exec_apply_initial_setup`: lo primero que hace el administrador en la Main.
    {
      plantilla: "apply_lote · PIN del administrador",
      op: op([s("UPDATE Usuarios SET Password_Hash = ?2, Requiere_Setup = 0 WHERE ID_Usuario = ?1;", [ADMIN, hashPin(PIN_ADMIN)])]),
    },
    {
      plantilla: "apply_lote · datos del negocio",
      op: op([
        s(
          `UPDATE Business_Settings SET Business_Name = ?, Direccion = ?, Telefono = ?, CIF = ?, IVA_Percent = ?, Razon_Social = ?, Updated_At = '${ahora}' WHERE ID = 1;`,
          ["Bar de Carga", "Calle Prueba 1", "910000000", NIF, 10, RAZON_SOCIAL],
        ),
      ]),
    },
    { plantilla: "apply_lote · categoría", op: categoria(ids.categorias.bebidas, "Bebidas", 0) },
    { plantilla: "apply_lote · categoría", op: categoria(ids.categorias.cocina, "Cocina", 1) },
    ...productos.map(p => ({ plantilla: "apply_lote · producto", op: producto(p) })),
    { plantilla: "apply_lote · plano", op: plano },
    { plantilla: "apply_lote · camarero", op: camarero },
    { plantilla: "apply_lote · cliente", op: cliente },
  ];
}

/* ===== Operaciones de la Main durante la carga ===== */

/** Abrir una mesa (`mesas.rs`): el INSERT sólo entra si la mesa no tiene ya una comanda abierta. */
function opAbrirMesa(ctx) {
  ctx.ids.comandaMain = nuevoId();
  return op([
    s(
      `INSERT INTO Comandas (ID_Comanda, ID_Mesa, ID_Trabajador, ID_Reserva, Fecha_Hora_Apertura, Total_Comanda, Estado) SELECT ?1, ?2, ?3, ?4, '${horaLocal()}', 0, 'Abierta' WHERE NOT EXISTS (SELECT 1 FROM Comandas WHERE ID_Mesa = ?2 AND Estado = 'Abierta');`,
      [ctx.ids.comandaMain, ctx.ids.mesas[1], null, null],
    ),
  ]);
}

/** Un toque de producto (`mesas.rs`): la línea y el total re-derivado en SQL. */
function opLinea(ctx) {
  const p = ctx.productos.croquetas;
  ctx.ids.lineaMain = nuevoId();
  return op([
    s(
      "INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Nombre_Producto, Cantidad, Precio_Unitario, Estado_Cocina, IVA_Percent) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8);",
      [ctx.ids.lineaMain, necesita(ctx.ids.comandaMain, "la comanda de la Main"), p.id, p.nombre, 1, p.precio, "PENDIENTE", null],
    ),
    s(SQL_TOTAL_COMANDA, [ctx.ids.comandaMain]),
  ]);
}

/**
 * El cobro total en efectivo de la comanda de la Main, como `cobrar_detalles` en `mesas.rs`: número de
 * serie, pago, movimiento de caja, líneas cobradas, registro de facturación y cierre de la comanda.
 * Las croquetas no llevan stock, así que no hay consumo. El registro lleva su huella, aunque la nube
 * no la compruebe.
 */
function opCobro(ctx) {
  const comanda = necesita(ctx.ids.comandaMain, "la comanda de la Main");
  const linea = necesita(ctx.ids.lineaMain, "la línea de la Main");
  const ahora = new Date();
  const hora = horaLocal(ahora);
  const total = ctx.productos.croquetas.precio;
  const base = Math.round(total / 1.1); // IVA del negocio, 10 % (`ticket.rs`)
  const cuota = total - base;
  const euros = c => (c / 100).toFixed(2);
  const serie = String(ahora.getFullYear());
  ctx.cobros = (ctx.cobros ?? 0) + 1;
  const numero = ctx.cobros;
  const numSerie = `${serie}/${String(numero).padStart(6, "0")}`;
  const fecha = horaLocal(ahora).slice(0, 10).split("-").reverse().join("-");
  const huso = horaConHuso(ahora);
  const idPago = nuevoId();
  const cadena = `IDEmisorFactura=${NIF}&NumSerieFactura=${numSerie}&FechaExpedicionFactura=${fecha}&TipoFactura=F2&CuotaTotal=${euros(cuota)}&ImporteTotal=${euros(total)}&Huella=&FechaHoraHusoGenRegistro=${huso}`;
  const desglose = JSON.stringify([
    { BaseImponibleOimporteNoSujeto: euros(base), CalificacionOperacion: "S1", ClaveRegimen: "01", CuotaRepercutida: euros(cuota), TipoImpositivo: "10" },
  ]);
  const sistema = JSON.stringify({ IdSistemaInformatico: "01", NombreSistemaInformatico: "TPV", NombreRazon: RAZON_SOCIAL, NIF, Version: "0.0.0-carga" });
  const qr = `https://www2.agenciatributaria.gob.es/wlpl/TIKE-CONT/ValidarQR?nif=${NIF}&numserie=${encodeURIComponent(numSerie)}&fecha=${fecha}&importe=${euros(total)}`;
  ctx.ids.pagoMain = idPago;
  return op([
    s("INSERT OR IGNORE INTO Serie_Facturacion (Serie, Ultimo) VALUES (?1, 0);", [serie]),
    s("UPDATE Serie_Facturacion SET Ultimo = Ultimo + 1 WHERE Serie = ?1;", [serie]),
    s(
      `INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo, ID_Usuario_Cobrador, ID_Trabajador_Cobrador, Numero_Ticket) VALUES (?1, ?2, '${hora}', ?3, ?4, ?5, ?6, ?7, ?8);`,
      [idPago, comanda, "Efectivo", total, "TOTAL", ADMIN, null, numSerie],
    ),
    s(
      `INSERT INTO Movimientos_Caja (ID_Movimiento, Fecha_Hora, Tipo, ID_Pago, ID_Gasto, ID_Usuario, ID_Trabajador, Importe, Metodo_Pago, Motivo) SELECT ?1, '${hora}', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9 WHERE NOT EXISTS (SELECT 1 FROM Movimientos_Caja mc WHERE mc.Tipo = ?2 AND (?3 IS NOT NULL OR ?4 IS NOT NULL) AND ((?3 IS NOT NULL AND mc.ID_Pago = ?3) OR (?4 IS NOT NULL AND mc.ID_Gasto = ?4)));`,
      [nuevoId(), "COBRO", idPago, null, ADMIN, null, total, "Efectivo", null],
    ),
    s(
      "INSERT OR IGNORE INTO Pago_Detalles (ID_Pago, ID_Detalle) SELECT ?1, dc.ID_Detalle FROM Detalle_Comanda dc WHERE dc.ID_Comanda = ?2 AND dc.ID_Detalle IN (?3) AND NOT EXISTS (SELECT 1 FROM v_lineas_cobradas pd WHERE pd.ID_Detalle = dc.ID_Detalle);",
      [idPago, comanda, linea],
    ),
    s(
      "INSERT INTO Registros_Facturacion (ID_Registro, Orden, Tipo, NIF_Emisor, Num_Serie_Factura, Fecha_Expedicion, Fecha_Operacion, Serie, Numero, Nombre_Razon_Emisor, Tipo_Factura, Tipo_Rectificativa, Descripcion_Operacion, Importe_Total, Cuota_Total, Desglose_Json, Destinatario_Json, Referencias_Json, Macrodato, Primer_Registro, Ant_NIF, Ant_Num_Serie, Ant_Fecha, Ant_Huella, Cadena_Huella, Huella, Tipo_Huella, Fecha_Hora_Huso, Sistema_Json, QR_Url, Incidencia, ID_Pago) VALUES (?1, ?2, 'ALTA', ?3, ?4, ?5, ?31, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30);",
      [
        nuevoId(), numero, NIF, numSerie, fecha, serie, numero, RAZON_SOCIAL, "F2", null, "Servicios de hosteleria y restauracion",
        euros(total), euros(cuota), desglose, null, null, null, "S", null, null, null, null,
        cadena, sha256Hex(cadena).toUpperCase(), "01", huso, sistema, qr, "N", idPago, null,
      ],
    ),
    s(
      `UPDATE Comandas SET Estado = 'Pagada', Total_Comanda = (SELECT IFNULL(SUM(CAST(ROUND(COALESCE(Cantidad,1) * COALESCE(Precio_Unitario,0)) AS INTEGER)), 0) FROM Detalle_Comanda WHERE ID_Comanda = ?1), Fecha_Hora_Cierre = '${hora}' WHERE ID_Comanda = ?1;`,
      [comanda],
    ),
  ]);
}

/* ===== El plan ===== */

const ruta = (r, ctx) => (typeof r === "function" ? r(ctx) : r);

/** Una pantalla de la Handy que se abre: GET al worker, que la lee en el TenantHub del negocio. */
const lectura = (id, plantilla, r = plantilla) => ({
  id,
  tipo: "lectura",
  plantilla,
  ejecutar: ctx => ctx.handy.pedir("GET", ruta(r, ctx), { tipo: "lectura", plantilla }),
});

/**
 * Una lectura cuyo filtro va en el cuerpo de un POST, sin clave de idempotencia (AUD-27,
 * `client.rs::post_lectura`): lo que se busca o las fechas no viajan en la URL.
 */
const lecturaPorPost = (id, plantilla, cuerpo) => ({
  id,
  tipo: "lectura",
  plantilla,
  ejecutar: ctx => ctx.handy.pedir("POST", plantilla, { cuerpo: cuerpo(ctx), tipo: "lectura", plantilla }),
});

/**
 * Lo que tarda un cambio en verse en el otro equipo: desde que el primero lo manda hasta que el
 * socket del segundo recibe el `change`. La espera se apunta antes de mandar. Con `opId` (lo que sube
 * la Main), el `change` de esa operación; sin él (una escritura de la Handy, cuyo `opId` pone el
 * worker), con los pasos en serie, el primer `change` que llega es el de este paso.
 */
function esperarPropagacion(socket, opId = null) {
  return socket ? socket.esperar(m => m.type === "change" && (opId === null || m.opId === opId), 5000) : null;
}

async function anotarPropagacion(ctx, espera, t0, actor, plantilla) {
  if (!espera) return;
  let ms = null;
  let error = null;
  try {
    const m = await espera;
    ms = Math.round(m.__t - t0);
  } catch (e) {
    error = e.message;
  }
  ctx.registro.anotar({ http: false, actor, tipo: "propagacion", metodo: "WS", ruta: plantilla, status: error ? 0 : 200, ok: !error, error, ms: ms ?? 0, enviados: 0, recibidos: 0, inicio: new Date().toISOString() });
}

/** Una escritura de la Handy: pasa por el TenantHub y necesita la Main conectada. */
const escritura = (id, metodo, plantilla, { r = plantilla, cuerpo, despues }) => ({
  id,
  tipo: "escritura",
  plantilla,
  ejecutar: async ctx => {
    const datos = cuerpo(ctx);
    const destino = ruta(r, ctx);
    const espera = esperarPropagacion(ctx.socketMain);
    const t0 = performance.now();
    const resultado = await ctx.handy.pedir(metodo, destino, { cuerpo: datos, escritura: true, tipo: "escritura", plantilla });
    if (resultado.ok && despues) despues(ctx, resultado.datos);
    if (resultado.ok) await anotarPropagacion(ctx, espera, t0, "handy→main", plantilla);
    return resultado;
  },
});

/**
 * Lo que tarda la red hasta Cloudflare y vuelta, sin base de por medio: un `OPTIONS` que el worker
 * contesta en el acto (el preflight de CORS). Es la referencia de cada tanda: el centro que atiende lo
 * decide la ruta del proveedor y cambia de una tanda a otra, y lo que una ruta tarda de más sobre esto
 * es servidor.
 */
const red = id => ({
  id,
  tipo: "red",
  plantilla: "OPTIONS (sin base)",
  ejecutar: ctx => ctx.handy.pedir("OPTIONS", "/v1/mesas/layout", { firmada: false, horaCliente: false, tipo: "red", plantilla: "OPTIONS (sin base)" }),
});

/**
 * Una operación de la Main por su socket: con una venta pendiente, su lote lleva una
 * (`subir_pendientes`).
 */
const deLaMain = (id, plantilla, construir) => ({
  id,
  tipo: "main-ws",
  plantilla,
  ejecutar: async ctx => {
    const operacion = construir(ctx);
    const espera = esperarPropagacion(ctx.socketHandy, operacion.opId);
    const t0 = performance.now();
    const resueltas = await ctx.socketMain.subir([{ op: operacion, plantilla }]);
    await anotarPropagacion(ctx, espera, t0, "main→handy", plantilla);
    return resueltas;
  },
});

/** La mesa de la Handy en la vuelta en curso: la 1 en la primera, y luego la 3, la 4… */
const mesaHandy = ctx => (ctx.vuelta ? ctx.ids.mesas[ctx.vuelta + 1] : ctx.ids.mesas[0]);

const hoy = () => fechaLocal();
function mesActual() {
  const d = new Date();
  const ultimo = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  const mes = hoy().slice(0, 8);
  return { desde: `${mes}01`, hasta: `${mes}${String(ultimo).padStart(2, "0")}` };
}

/**
 * 30 peticiones de un servicio corriente, en este orden para que lo que cada una necesita exista: 14
 * pantallas de la Handy, 10 escrituras suyas, un login con PIN y 5 cosas de la Main (abrir mesa,
 * añadir línea y cobrar por el socket, cada una en su `apply_lote`; un catch-up y los interruptores
 * por REST). La Handy trabaja en la mesa 1 y la Main en la 2, para que no se pisen.
 */
export function planDeCarga() {
  return [
    red("N01"),
    lectura("R01", "/v1/login/users"),
    lectura("R02", "/v1/mesas/layout"),
    // `{ mesas, proximo_cambio_s }`: la pantalla relee cuando cambia una reserva, no cada minuto.
    lectura("R03", "/v1/mesas/meta"),
    // La Handy abre la mesa en un viaje (`mesas.rs::abrir_o_retomar_comanda`): la comanda abierta,
    // creada si no hay, y sus líneas. El trabajador es el usuario de la sesión, como en la app.
    escritura("W01", "POST", "/v1/mesas/comandas/abrir-o-retomar", {
      cuerpo: ctx => ({ id_mesa: mesaHandy(ctx), id_trabajador: ctx.ids.usuarioCamarero, id_reserva: null }),
      despues: (ctx, d) => (ctx.ids.comandaHandy = d?.comanda?.id_comanda),
    }),
    lectura("R04", "/v1/mesas/categorias"),
    lectura("R05", "/v1/mesas/productos/:idCategoria", ctx => `/v1/mesas/productos/${ctx.ids.categorias.cocina}`),
    escritura("W02", "POST", "/v1/mesas/lineas", {
      cuerpo: ctx => ({ id_comanda: necesita(ctx.ids.comandaHandy, "la comanda de la Handy"), id_producto: ctx.productos.bocadillo.id, cantidad: 1, id_trabajador: ctx.ids.trabajador }),
      despues: (ctx, d) => {
        const lineas = (d?.lineas ?? []).filter(l => l.ID_Producto === ctx.productos.bocadillo.id).map(l => l.ID_Detalle).sort();
        ctx.ids.lineaCocina = lineas.at(-1);
      },
    }),
    escritura("W03", "POST", "/v1/mesas/lineas", {
      cuerpo: ctx => ({ id_comanda: necesita(ctx.ids.comandaHandy, "la comanda de la Handy"), id_producto: ctx.productos.cana.id, cantidad: 1, id_trabajador: ctx.ids.trabajador }),
    }),
    deLaMain("M01", "apply_lote · abrir mesa", opAbrirMesa),
    escritura("W04", "POST", "/v1/mesas/lineas", {
      cuerpo: ctx => ({ id_comanda: necesita(ctx.ids.comandaHandy, "la comanda de la Handy"), id_producto: ctx.productos.cana.id, cantidad: 1, id_trabajador: ctx.ids.trabajador }),
    }),
    lectura("R06", "/v1/mesas/comandas/:id/lineas", ctx => `/v1/mesas/comandas/${necesita(ctx.ids.comandaHandy, "la comanda de la Handy")}/lineas`),
    escritura("W05", "POST", "/v1/mesas/lineas/remove-one-pending", {
      cuerpo: ctx => ({ id_comanda: necesita(ctx.ids.comandaHandy, "la comanda de la Handy"), id_producto: ctx.productos.cana.id }),
    }),
    deLaMain("M02", "apply_lote · añadir línea", opLinea),
    escritura("W06", "PUT", "/v1/mesas/lineas/:id/nota", {
      r: ctx => `/v1/mesas/lineas/${necesita(ctx.ids.lineaCocina, "la línea de cocina")}/nota`,
      cuerpo: () => ({ nota: "Sin tomate" }),
    }),
    red("N02"),
    lectura("R07", "/v1/mesas/kitchen/today-pending"),
    escritura("W07", "PUT", "/v1/mesas/kitchen/line-state", {
      cuerpo: ctx => ({ id_detalle: necesita(ctx.ids.lineaCocina, "la línea de cocina"), id_usuario_cocinero: ctx.ids.usuarioCamarero, estado: "PREPARADO" }),
    }),
    lectura("R08", "/v1/clientes/overview", "/v1/clientes/overview?ranking=gasto"),
    escritura("W08", "POST", "/v1/clientes", {
      cuerpo: ctx => ({ id_cliente: nuevoId(), nombre: "Cliente de carga", email: `cliente-${ctx.tanda}-${ctx.vuelta ?? 0}@carga.test`, telefono: "600000001", notas: null }),
      despues: (ctx, d) => (ctx.ids.clienteNuevo = d?.id_cliente),
    }),
    lectura("R09", "/v1/inventario/resumen", "/v1/inventario/resumen?limit=12"),
    escritura("W09", "PUT", "/v1/clientes/:id", {
      r: ctx => `/v1/clientes/${necesita(ctx.ids.clienteNuevo, "el cliente nuevo")}`,
      cuerpo: ctx => ({ nombre: "Cliente de carga (editado)", email: `cliente-${ctx.tanda}-${ctx.vuelta ?? 0}@carga.test`, telefono: "600000002", notas: "Prefiere terraza" }),
    }),
    deLaMain("M03", "apply_lote · cobrar", opCobro),
    lecturaPorPost("R10", "/v1/cuentas/resumen", () => ({ del: hoy(), al: hoy(), q: null })),
    lectura("R11", "/v1/reservas/mes", () => {
      const { desde, hasta } = mesActual();
      return `/v1/reservas/mes?desde=${desde}&hasta=${hasta}`;
    }),
    // Entrada en la primera vuelta y salida en la segunda: una segunda entrada el mismo día sin turno
    // partido se rechaza con un 409 (AUD-47).
    escritura("W10", "POST", "/v1/login/punch", {
      cuerpo: ctx => {
        const v = ctx.vuelta ?? 0;
        if (v > 1) throw new Saltado("sólo se ficha en las dos primeras vueltas");
        return { id_usuario: ctx.ids.usuarioCamarero, pin: "", tipo: v ? "salida" : "entrada" };
      },
    }),
    red("N03"),
    lectura("R12", "/v1/tareas/mias", ctx => `/v1/tareas/mias?trabajador=${ctx.ids.trabajador}`),
    {
      id: "M04",
      tipo: "main-rest",
      plantilla: "/v1/sync/changes",
      // La Main que vuelve de un corte pide lo que se perdió: aquí, todo lo de la carga.
      ejecutar: ctx =>
        ctx.main.pedir("POST", "/v1/sync/changes", { cuerpo: { since: ctx.seqAlEmpezarLaCarga ?? 0, limit: CAMBIOS_POR_PAGINA }, tipo: "main-rest" }),
    },
    lectura("R13", "/v1/notificaciones/count", ctx => `/v1/notificaciones/count?usuario=${ctx.ids.usuarioCamarero}`),
    {
      id: "L01",
      tipo: "login",
      plantilla: "/v1/login/login",
      // El único login con PIN: el PBKDF2 de 100 000 iteraciones es la CPU más cara del worker.
      ejecutar: ctx => ctx.handy.pedir("POST", "/v1/login/login", { cuerpo: { id_usuario: ADMIN, pin: PIN_ADMIN }, tipo: "login" }),
    },
    {
      id: "M05",
      tipo: "main-rest",
      plantilla: "/v1/interruptores",
      ejecutar: ctx => ctx.main.pedir("POST", "/v1/interruptores", { cuerpo: { version: "0.0.0-carga" }, tipo: "main-rest" }),
    },
    lectura("R14", "/v1/stats/mesas", "/v1/stats/mesas?range=hoy"),
  ];
}

/**
 * Lanza el plan a `ritmo` peticiones por segundo, en serie: cada paso arranca en su hueco y, si el
 * anterior se alarga, en cuanto termina. Una petición que depende de otra que falló se salta.
 */
export async function ejecutarPlan(ctx, { ritmo, vueltas = 1 }) {
  const { registro } = ctx;
  const plan = planDeCarga();
  const pasos = Array.from({ length: vueltas }, (_, v) => plan.map(p => ({ ...p, vuelta: v }))).flat();
  const intervalo = 1000 / ritmo;
  registro.fase = "carga";
  ctx.ventanas.carga = { desde: new Date().toISOString() };
  const t0 = performance.now();
  for (const [i, paso] of pasos.entries()) {
    if (ctx.cancelado) {
      registro.avisar(`Cancelado: no se lanzan los ${pasos.length - i} pasos que faltan.`);
      break;
    }
    if (ctx.socketMain?.cierre) throw new FrenoDeSeguridad("El socket de la Main se ha cerrado: sin ella, las escrituras de la Handy fallarían todas.");
    const espera = t0 + i * intervalo - performance.now();
    if (espera > 0) await dormir(espera);
    ctx.vuelta = paso.vuelta;
    registro.etapa = `${paso.id}#${paso.vuelta}`;
    const antes = registro.entradas.length;
    try {
      await paso.ejecutar(ctx);
    } catch (e) {
      if (!(e instanceof Saltado)) throw e;
      registro.anotar({ http: false, actor: "-", tipo: paso.tipo, metodo: "-", ruta: paso.plantilla, status: null, ok: false, error: `saltado: ${e.message}`, ms: 0, inicio: new Date().toISOString() });
    }
    const nuevas = registro.entradas.slice(antes);
    // Lo de la Main se enseña por su operación; el lote en que viajó, al lado.
    const e = nuevas.find(x => x.tipo !== "main-lote" && x.tipo !== "propagacion") ?? nuevas[0] ?? registro.entradas.at(-1);
    const lotes = nuevas.filter(x => x.tipo === "main-lote");
    const prop = nuevas.find(x => x.tipo === "propagacion");
    const marca = e.ok ? "✓" : "✗";
    const st = e.tiempos ? ` [${Object.entries(e.tiempos).filter(([k]) => k !== "colo" && k !== "total").map(([k, v]) => `${k} ${v.ms}/${v.n}`).join(" ")}]` : "";
    const lote = lotes.length ? ` · ${lotes.length} lote${lotes.length > 1 ? "s" : ""}, Seq ${e.seq ?? "-"}` : "";
    console.log(`  ${marca} [${String(i + 1).padStart(3)}/${pasos.length}] ${paso.id} ${e.metodo} ${e.ruta} → ${e.status ?? "-"} · ${e.ms} ms${st}${lote}${prop ? ` · llega en ${prop.ms} ms` : ""}${e.ok ? "" : ` · ${e.error}`}`);
  }
  ctx.ventanas.carga.hasta = new Date().toISOString();
}

/* ===== Comprobación de la subida ===== */

/**
 * Al acabar la carga, lo que la Main subió por `apply_lote`, contrastado con la nube: cada operación
 * que dio por confirmada está UNA vez en el log, con el `Seq` de su acuse; ninguna se quedó sin
 * aplicar; a la Handy le llegó su `change` una vez (las que subieron con ella conectada) y a la Main
 * ninguno de los suyos. Lee el log entero por `/v1/sync/changes` desde 0, como un catch-up.
 *
 * Deja el resultado en `ctx.estado.subida` y devuelve si todo cuadra.
 */
export async function comprobarSubida(ctx) {
  const { registro, socketMain, socketHandy } = ctx;
  registro.etapa = "comprobar-subida";
  const enElLog = new Map();
  let since = 0;
  for (let pagina = 0; pagina < 50; pagina++) {
    const d = exigir(
      await ctx.main.pedir("POST", "/v1/sync/changes", { cuerpo: { since, limit: CAMBIOS_POR_PAGINA }, tipo: "comprobacion", plantilla: "/v1/sync/changes (comprobación)" }),
      "No se pudo leer el log de la nube",
    );
    const items = Array.isArray(d?.items) ? d.items : [];
    for (const it of items) enElLog.set(it.opId, [...(enElLog.get(it.opId) ?? []), Number(it.seq)]);
    if (!items.length || !(d.nextSince > since)) break;
    since = d.nextSince;
  }

  const subidas = registro.entradas.filter(e => e.tipo === "main-ws" && e.opId);
  const confirmadas = [...(socketMain?.confirmadas ?? new Map())];
  const sinConfirmar = [...new Set(subidas.map(e => e.opId))].filter(id => !socketMain?.confirmadas.has(id));
  const fuera = [];
  const repetidas = [];
  const otroSeq = [];
  for (const [opId, { seq }] of confirmadas) {
    const seqs = enElLog.get(opId) ?? [];
    if (!seqs.length) fuera.push(opId);
    else if (seqs.length > 1) repetidas.push(opId);
    else if (seqs[0] !== seq) otroSeq.push(opId);
  }
  const conHandy = confirmadas.filter(([opId]) => !ctx.opsAntesDeLaHandy?.has(opId)).map(([opId]) => opId);
  const handyFaltan = conHandy.filter(opId => !socketHandy?.cambios.get(opId));
  const handyRepetidos = conHandy.filter(opId => (socketHandy?.cambios.get(opId) ?? 0) > 1);
  const ecoALaMain = confirmadas.filter(([opId]) => socketMain.cambios.has(opId)).map(([opId]) => opId);
  const lotes = registro.entradas.filter(e => e.tipo === "main-lote");

  const subida = {
    lotes: lotes.length,
    operaciones: confirmadas.length,
    reenviadas: subidas.filter(e => e.ok && e.lotes > 1).length,
    yaEstaban: lotes.reduce((n, l) => n + (l.yaEstaban ?? 0), 0),
    noIntentadas: lotes.reduce((n, l) => n + (l.noIntentadas ?? 0), 0),
    rechazadas: lotes.reduce((n, l) => n + (l.rechazadas ?? 0), 0),
    sinConfirmar: sinConfirmar.length,
    enElLog: { cambios: [...enElLog.values()].reduce((n, l) => n + l.length, 0), fuera: fuera.length, repetidas: repetidas.length, otroSeq: otroSeq.length },
    handy: { esperados: conHandy.length, faltan: handyFaltan.length, repetidos: handyRepetidos.length },
    ecoALaMain: ecoALaMain.length,
  };
  subida.cuadra = !sinConfirmar.length && !fuera.length && !repetidas.length && !otroSeq.length && !handyFaltan.length && !handyRepetidos.length && !ecoALaMain.length && !subida.rechazadas;
  ctx.estado.subida = subida;
  if (!subida.cuadra) {
    const detalle = [
      sinConfirmar.length && `${sinConfirmar.length} sin confirmar`,
      fuera.length && `${fuera.length} confirmadas que no están en el log (${fuera.slice(0, 3).join(", ")})`,
      repetidas.length && `${repetidas.length} repetidas en el log (${repetidas.slice(0, 3).join(", ")})`,
      otroSeq.length && `${otroSeq.length} con otro Seq que el del acuse`,
      handyFaltan.length && `${handyFaltan.length} cuyo change no llegó a la Handy`,
      handyRepetidos.length && `${handyRepetidos.length} cuyo change llegó repetido a la Handy`,
      ecoALaMain.length && `${ecoALaMain.length} cuyo change volvió a la Main`,
      subida.rechazadas && `${subida.rechazadas} rechazadas`,
    ].filter(Boolean);
    registro.avisar(`La subida de la Main no cuadra con la nube: ${detalle.join("; ")}.`);
  }
  return subida.cuadra;
}

/** Cierra primero la Handy y luego la Main, como cuando se cierra el local. */
export async function cerrarSockets(ctx) {
  for (const socket of [ctx.socketHandy, ctx.socketMain]) {
    try {
      await socket?.cerrar();
    } catch {
      // Cerrar es lo último: un socket que ya no está no impide limpiar lo demás.
    }
  }
}
