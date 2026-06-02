// src/server/index.ts
import { SignJWT, jwtVerify } from "jose";
import * as ed from "@noble/ed25519";
import type {
	ActivateRequest,
	ActivateResponse,
	ApiError,
	LemonWebhookPayload,
	LicenseStatus,
} from "../shared";

import { getDb, type TursoEnv } from "./db";
import {
	ensureExtraSchema,
	ensureTenantExistsMinimal,
	ensureDevice,
	upsertLicenseFromEventOrActivation,
	upsertLicenseInstance,
	getLicenseByHash,
	getDecryptedLicenseKey,
	upsertWebhookEvent,
	markWebhookProcessed,
	getDevicePubKeyB64,
	setDevicePubKeyB64IfEmptyOrThrow,
} from "./licenseStore";
import { sha256Hex } from "./crypto";

import { createClient, type Client } from "@libsql/client";

// ---------------- Env ----------------

export interface Env extends TursoEnv {
	LEMON_WEBHOOK_SECRET: string;
	LICENSE_JWT_SECRET: string;
	LICENSE_STORE_KEY: string; // base64 32 bytes (AES-GCM)

	// ✅ Turso Platform API (para crear DBs + tokens)
	TURSO_PLATFORM_TOKEN: string; // Bearer token (platform)
	TURSO_ORG_SLUG: string; // "altarialights" (slug de org o user)
}

// ---------------- Helpers ----------------

function json(data: any, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	});
}

function requireJson(req: Request) {
	const ct = req.headers.get("content-type") || "";
	if (!ct.toLowerCase().includes("application/json")) {
		return json({ ok: false, error: "Content-Type must be application/json" }, 415);
	}
	return null;
}

async function readJsonSafe<T>(req: Request, fallback: T): Promise<T> {
	try {
		return (await req.json()) as T;
	} catch {
		return fallback;
	}
}

function secretKey(str: string) {
	return new TextEncoder().encode(str);
}

function assertEnv(env: Env, names: (keyof Env)[]) {
	for (const n of names) {
		const v = (env as any)[n];
		if (!v || String(v).trim().length === 0) return `missing_env_${String(n)}`;
	}
	return null;
}

async function signToken(env: Env, claims: { tenantId: string; deviceId: string; licHash: string }) {
	return await new SignJWT(claims)
		.setProtectedHeader({ alg: "HS256", typ: "JWT" })
		.setIssuedAt()
		.setExpirationTime("30d")
		.sign(secretKey(env.LICENSE_JWT_SECRET));
}

async function verifyToken(env: Env, token: string) {
	const { payload } = await jwtVerify(token, secretKey(env.LICENSE_JWT_SECRET), {
		algorithms: ["HS256"],
	});

	const tenantId = String(payload.tenantId || "");
	const deviceId = String(payload.deviceId || "");
	const licHash = String(payload.licHash || "");

	if (!tenantId || !deviceId || !licHash) throw new Error("Invalid token claims");
	return { tenantId, deviceId, licHash };
}

function timingSafeEqualHex(a: string, b: string) {
	if (a.length !== b.length) return false;
	let out = 0;
	for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return out === 0;
}

async function verifyLemonSignature(req: Request, secret: string, rawBody: string) {
	const sig = (req.headers.get("X-Signature") || "").trim().toLowerCase();

	if (!secret || secret.trim().length === 0) {
		console.log("[LEMON] Missing LEMON_WEBHOOK_SECRET in env");
		return false;
	}
	if (!sig) return false;

	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"]
	);

	const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
	const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");

	return timingSafeEqualHex(hex, sig);
}

/** ✅ FIX: Turso suele devolver 0/1; Rust espera boolean en status */
function toBool01(v: any, fallback = false): boolean {
	if (typeof v === "boolean") return v;
	if (typeof v === "number") return v !== 0;
	if (typeof v === "string") {
		const s = v.trim().toLowerCase();
		if (s === "true" || s === "1") return true;
		if (s === "false" || s === "0") return false;
	}
	return fallback;
}

// ---------------- Base64 helpers ----------------

function b64ToBytes(b64: string): Uint8Array {
	const bin = atob(b64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return bytes;
}

function bytesToB64(bytes: Uint8Array): string {
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin);
}

// ---------------- AES-GCM (para turso_auth_token_enc) ----------------

async function aesGcmEncryptToB64(keyB64: string, plaintext: string): Promise<string> {
	const keyBytes = b64ToBytes(keyB64);
	const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt"]);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ct = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv },
		key,
		new TextEncoder().encode(plaintext)
	);
	const out = new Uint8Array(iv.length + ct.byteLength);
	out.set(iv, 0);
	out.set(new Uint8Array(ct), iv.length);
	return bytesToB64(out);
}

async function aesGcmDecryptFromB64(keyB64: string, payloadB64: string): Promise<string> {
	const raw = b64ToBytes(payloadB64);
	const iv = raw.slice(0, 12);
	const data = raw.slice(12);
	const keyBytes = b64ToBytes(keyB64);
	const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"]);
	const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
	return new TextDecoder().decode(pt);
}

// ---------------- Device Proof (anti-copia) ----------------

async function sha256HexStr(s: string): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
	return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function verifyDeviceProof(
	request: Request,
	dbi: ReturnType<typeof getDb>,
	claims: { tenantId: string; deviceId: string },
	target?: { method: string; path: string }
): Promise<{ ok: true } | { ok: false; error: string }> {
	const tsStr = (request.headers.get("X-Device-Ts") || "").trim();
	const sigB64Raw = (request.headers.get("X-Device-Sig") || "").trim();
	if (!tsStr || !sigB64Raw) return { ok: false, error: "missing_device_proof" };

	const sigB64 = sigB64Raw.replace(/^"+|"+$/g, "");

	if (!tsStr || !sigB64) return { ok: false, error: "missing_device_proof" };

	const ts = Number(tsStr);
	if (!Number.isFinite(ts)) return { ok: false, error: "bad_device_ts" };

	const now = Date.now();
	const MAX_SKEW_MS = 2 * 60 * 1000;
	if (Math.abs(now - ts) > MAX_SKEW_MS) return { ok: false, error: "device_ts_out_of_range" };

	const pubB64 = await getDevicePubKeyB64(dbi, claims.tenantId, claims.deviceId);
	if (!pubB64) return { ok: false, error: "device_pubkey_not_registered" };

	const auth = request.headers.get("authorization") || "";
	const m = auth.match(/^Bearer\s+(.+)$/i);
	if (!m) return { ok: false, error: "missing_token" };
	const token = m[1];

	const tokenHash = await sha256HexStr(token);

	const method = String(target?.method || request.method).toUpperCase();
	const path = String(target?.path || new URL(request.url).pathname);

	const msg = `${ts}\n${method}\n${path}\n${tokenHash}`;

	let pub: Uint8Array;
	let sig: Uint8Array;
	try {
		pub = b64ToBytes(pubB64);
		sig = b64ToBytes(sigB64);
	} catch {
		return { ok: false, error: "bad_b64" };
	}

	const ok = await ed.verifyAsync(sig, new TextEncoder().encode(msg), pub);
	if (!ok) return { ok: false, error: "bad_device_signature" };

	return { ok: true };
}

// ---------------- Lemon License API ----------------

async function lemonActivate(licenseKey: string, instanceName: string) {
	const body = new URLSearchParams();
	body.set("license_key", licenseKey);
	body.set("instance_name", instanceName);

	const r = await fetch("https://api.lemonsqueezy.com/v1/licenses/activate", {
		method: "POST",
		headers: {
			Accept: "application/json",
			"content-type": "application/x-www-form-urlencoded",
		},
		body,
	});

	const text = await r.text();
	let data: any = null;
	try {
		data = JSON.parse(text);
	} catch { }
	return { ok: r.ok, status: r.status, data, text };
}

async function lemonValidate(licenseKey: string, instanceId?: string | null) {
	const body = new URLSearchParams();
	body.set("license_key", licenseKey);
	if (instanceId) body.set("instance_id", instanceId);

	const r = await fetch("https://api.lemonsqueezy.com/v1/licenses/validate", {
		method: "POST",
		headers: {
			Accept: "application/json",
			"content-type": "application/x-www-form-urlencoded",
		},
		body,
	});

	const text = await r.text();
	let data: any = null;
	try {
		data = JSON.parse(text);
	} catch { }
	return { ok: r.ok, status: r.status, data, text };
}

// ---------------- Initial tenant admin bootstrap ----------------

const PBKDF2_PREFIX = "$pbkdf2-sha256$";
const PBKDF2_ITERS = 100_000;
const PBKDF2_SALT_LEN = 16;
const PBKDF2_DK_LEN = 32;

function randomBytes(len: number): Uint8Array {
	const out = new Uint8Array(len);
	crypto.getRandomValues(out);
	return out;
}

async function hashPinPbkdf2(pin: string): Promise<string> {
	const p = String(pin || "").trim();

	if (p.length < 4) {
		throw new Error("PIN demasiado corto");
	}

	const salt = randomBytes(PBKDF2_SALT_LEN);

	const keyMaterial = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(p),
		"PBKDF2",
		false,
		["deriveBits"]
	);

	const bits = await crypto.subtle.deriveBits(
		{
			name: "PBKDF2",
			salt,
			iterations: PBKDF2_ITERS,
			hash: "SHA-256",
		},
		keyMaterial,
		PBKDF2_DK_LEN * 8
	);

	const dk = new Uint8Array(bits);

	return `${PBKDF2_PREFIX}i=${PBKDF2_ITERS}$${bytesToB64(salt)}$${bytesToB64(dk)}`;
}

function rowNumber(row: any, key: string, fallback = 0): number {
	const n = Number(row?.[key] ?? row?.[0] ?? fallback);
	return Number.isFinite(n) ? n : fallback;
}

async function tenantQuerySingleNumber(
	client: Client,
	sql: string,
	args: any[] = []
): Promise<number> {
	const r = await client.execute({ sql, args });
	const row = r.rows?.[0] as any | undefined;
	if (!row) return 0;

	const firstKey = Object.keys(row)[0] || "";
	return rowNumber(row, firstKey, 0);
}

async function ensureTenantInitialAdmin(client: Client): Promise<void> {
	await client.execute({
		sql: `
			INSERT OR IGNORE INTO Roles (Nombre_Rol)
			VALUES ('Administrador');
		`,
		args: [],
	});

	const usersCount = await tenantQuerySingleNumber(
		client,
		`SELECT COUNT(*) AS count FROM Usuarios;`
	);

	if (usersCount > 0) {
		return;
	}

	const adminRoleId = await tenantQuerySingleNumber(
		client,
		`
			SELECT ID_Rol AS id
			FROM Roles
			WHERE Nombre_Rol = 'Administrador'
			LIMIT 1;
		`
	);

	if (adminRoleId <= 0) {
		throw new Error("initial_admin_role_missing");
	}

	const hash = await hashPinPbkdf2("1234");

	await client.execute({
		sql: `
			INSERT INTO Usuarios (
				ID_Rol,
				Email,
				Password_Hash,
				Nombre,
				Apellido,
				Estado,
				Requiere_Setup
			)
			VALUES (
				?,
				?,
				?,
				?,
				?,
				'Activo',
				1
			);
		`,
		args: [
			adminRoleId,
			"admin@local",
			hash,
			"Admin",
			"TPV",
		],
	});
}

async function ensureTenantInitialAdminByCredentials(
	tursoUrl: string,
	token: string
): Promise<void> {
	const client: Client = createClient({
		url: tursoUrl,
		authToken: token,
	});

	try {
		await ensureTenantInitialAdmin(client);
	} catch (e: any) {
		const msg = String(e?.message || e).toLowerCase();

		if (
			msg.includes("no such table") ||
			msg.includes("sqlite_error") ||
			msg.includes("schema")
		) {
			await applyTenantSchemaOnce(tursoUrl, token);
			return;
		}

		throw e;
	}
}

const TPV_SCHEMA_SQL = String.raw`
/* =========================================================
   TPV SCHEMA (Inventario con LOTES + FEFO)
   - Sin migraciones: pensado para borrar DB y recrear
   - Cambios clave:
     ✅ Productos = ficha (catálogo)
     ✅ Lotes_Producto = existencias por lote (caducidad/cantidad)
     ✅ Lote_Consumos = trazabilidad (qué lote se consumió en cada línea)
     ✅ Cuentas_Gastos.ID_Proveedor para gastos tipo "Proveedor"
     ✅ Applied_Operations para replay seguro por Op_Id
     ✅ Cloud_Changes + Sync_State para sync nube/local
========================================================= */

PRAGMA foreign_keys = ON;

/* =========================================================
   1. Seguridad y Usuarios
========================================================= */
CREATE TABLE IF NOT EXISTS Roles (
  ID_Rol INTEGER PRIMARY KEY AUTOINCREMENT,
  Nombre_Rol TEXT NOT NULL UNIQUE
);

INSERT OR IGNORE INTO Roles (Nombre_Rol) VALUES
  ('Administrador'),
  ('Camarero'),
  ('Cocinero'),
  ('Limpieza');

CREATE TABLE IF NOT EXISTS Usuarios (
  ID_Usuario INTEGER PRIMARY KEY AUTOINCREMENT,
  ID_Rol INTEGER NOT NULL,
  Email TEXT NOT NULL UNIQUE,
  Password_Hash TEXT NOT NULL,
  Nombre TEXT NOT NULL,
  Apellido TEXT,
  Estado TEXT DEFAULT 'Activo',
  Requiere_Setup INTEGER DEFAULT 0,
  FOREIGN KEY (ID_Rol) REFERENCES Roles(ID_Rol)
);

/* =========================================================
   2. Personal y Horarios
========================================================= */
CREATE TABLE IF NOT EXISTS Trabajadores (
  ID_Trabajador INTEGER PRIMARY KEY AUTOINCREMENT,
  ID_Usuario INTEGER UNIQUE NOT NULL,
  DNI TEXT UNIQUE,
  Telefono TEXT,
  Puesto TEXT,
  IBAN TEXT,
  Numero_Seguridad_Social TEXT UNIQUE,
  Fecha_Inicio_Contrato DATE,
  Fecha_Fin_Contrato DATE,
  FOREIGN KEY (ID_Usuario) REFERENCES Usuarios(ID_Usuario)
);

CREATE TABLE IF NOT EXISTS Turnos (
  ID_Turno INTEGER PRIMARY KEY AUTOINCREMENT,
  Nombre_Turno TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS Asignacion_Turnos (
  ID_Asignacion INTEGER PRIMARY KEY AUTOINCREMENT,
  ID_Trabajador INTEGER NOT NULL,
  Fecha DATE NOT NULL,
  ID_Turno INTEGER NOT NULL,
  Area TEXT NOT NULL,
  Hora_Inicio TIME,
  Hora_Fin TIME,
  Notas TEXT,
  FOREIGN KEY (ID_Trabajador) REFERENCES Trabajadores(ID_Trabajador),
  FOREIGN KEY (ID_Turno) REFERENCES Turnos(ID_Turno)
);

CREATE INDEX IF NOT EXISTS idx_asig_fecha ON Asignacion_Turnos(Fecha);
CREATE INDEX IF NOT EXISTS idx_asig_trab_fecha ON Asignacion_Turnos(ID_Trabajador, Fecha);

INSERT OR IGNORE INTO Turnos (Nombre_Turno) VALUES
  ('LIBRE'),
  ('PARTIDO'),
  ('MAÑANA'),
  ('TARDE'),
  ('NOCHE');

CREATE TABLE IF NOT EXISTS Horario_Predeterminado (
  ID_Default INTEGER PRIMARY KEY AUTOINCREMENT,
  ID_Trabajador INTEGER NOT NULL,
  Weekday INTEGER NOT NULL,
  Orden INTEGER NOT NULL DEFAULT 1,
  ID_Turno INTEGER NOT NULL,
  Area TEXT NOT NULL,
  Hora_Inicio TIME,
  Hora_Fin TIME,
  Notas TEXT,
  FOREIGN KEY (ID_Trabajador) REFERENCES Trabajadores(ID_Trabajador) ON DELETE CASCADE,
  FOREIGN KEY (ID_Turno) REFERENCES Turnos(ID_Turno),
  UNIQUE (ID_Trabajador, Weekday, Orden)
);

CREATE INDEX IF NOT EXISTS idx_hp_trab_weekday
ON Horario_Predeterminado(ID_Trabajador, Weekday);

/* =========================================================
   3. Inventario y Productos
========================================================= */
CREATE TABLE IF NOT EXISTS Categorias_Producto (
  ID_Categoria INTEGER PRIMARY KEY AUTOINCREMENT,
  Nombre TEXT NOT NULL UNIQUE,
  Nombre_Imagen TEXT,
  Ruta_Imagen TEXT,
  Vendible INTEGER NOT NULL DEFAULT 1,
  Pasa_Cocina INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS Proveedores (
  ID_Proveedor INTEGER PRIMARY KEY AUTOINCREMENT,
  Nombre_Empresa TEXT NOT NULL,
  Contacto TEXT,
  Telefono TEXT,
  Email TEXT UNIQUE,
  CIF TEXT UNIQUE,
  Informacion_adicional TEXT,
  Nombre_Imagen TEXT,
  Ruta_Imagen TEXT
);

CREATE TABLE IF NOT EXISTS Productos (
  ID_Producto INTEGER PRIMARY KEY AUTOINCREMENT,
  ID_Categoria INTEGER NOT NULL,
  ID_Proveedor INTEGER,
  Nombre TEXT NOT NULL UNIQUE,
  Precio_Venta REAL,
  Stock_Minimo REAL DEFAULT 0,
  Unidad_Medida TEXT,
  Nombre_Imagen TEXT,
  Ruta_Imagen TEXT,
  Cantidad_Pedido_Esperada REAL,
  FOREIGN KEY (ID_Categoria) REFERENCES Categorias_Producto(ID_Categoria),
  FOREIGN KEY (ID_Proveedor) REFERENCES Proveedores(ID_Proveedor)
);

CREATE TABLE IF NOT EXISTS Lotes_Producto (
  ID_Lote INTEGER PRIMARY KEY AUTOINCREMENT,
  ID_Producto INTEGER NOT NULL,
  Codigo_Lote TEXT NOT NULL,
  Fecha_Entrada DATETIME NOT NULL DEFAULT (datetime('now','localtime')),
  Caducidad DATE,
  Cantidad_Inicial REAL NOT NULL DEFAULT 0,
  Stock_Disponible REAL NOT NULL DEFAULT 0,
  Coste_Unitario REAL,
  ID_Proveedor INTEGER,
  Notas TEXT,
  FOREIGN KEY (ID_Producto) REFERENCES Productos(ID_Producto) ON DELETE CASCADE,
  FOREIGN KEY (ID_Proveedor) REFERENCES Proveedores(ID_Proveedor),
  UNIQUE (ID_Producto, Codigo_Lote),
  CHECK (Cantidad_Inicial >= 0),
  CHECK (Stock_Disponible >= 0)
);

CREATE INDEX IF NOT EXISTS idx_lotes_producto_cad
ON Lotes_Producto(ID_Producto, Caducidad);

CREATE INDEX IF NOT EXISTS idx_lotes_producto_stock
ON Lotes_Producto(ID_Producto, Stock_Disponible);

CREATE INDEX IF NOT EXISTS idx_lotes_producto_entrada
ON Lotes_Producto(ID_Producto, Fecha_Entrada);

/* =========================================================
   4. Alérgenos
========================================================= */
CREATE TABLE IF NOT EXISTS Alergenos (
  ID_Alergeno INTEGER PRIMARY KEY AUTOINCREMENT,
  Nombre TEXT NOT NULL UNIQUE,
  Nombre_Imagen TEXT,
  Ruta_Imagen TEXT
);

CREATE TABLE IF NOT EXISTS Producto_Alergenos (
  ID_Producto INTEGER NOT NULL,
  ID_Alergeno INTEGER NOT NULL,
  PRIMARY KEY (ID_Producto, ID_Alergeno),
  FOREIGN KEY (ID_Producto) REFERENCES Productos(ID_Producto) ON DELETE CASCADE,
  FOREIGN KEY (ID_Alergeno) REFERENCES Alergenos(ID_Alergeno) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_prod_alerg_prod
ON Producto_Alergenos(ID_Producto);

CREATE INDEX IF NOT EXISTS idx_prod_alerg_alerg
ON Producto_Alergenos(ID_Alergeno);

/* =========================================================
   5. Zonas / Mesas / Clientes / Reservas
========================================================= */
CREATE TABLE IF NOT EXISTS Zonas (
  ID_Zona INTEGER PRIMARY KEY AUTOINCREMENT,
  Nombre_Zona TEXT NOT NULL UNIQUE,
  Room_Points TEXT NOT NULL DEFAULT '[]',
  Updated_At DATETIME
);

CREATE TABLE IF NOT EXISTS Mesas (
  ID_Mesa INTEGER PRIMARY KEY AUTOINCREMENT,
  ID_Zona INTEGER NOT NULL,
  Numero_Mesa TEXT NOT NULL,
  Capacidad INTEGER NOT NULL,
  Ubicacion_X INTEGER NOT NULL,
  Ubicacion_Y INTEGER NOT NULL,
  Shape TEXT NOT NULL,
  Width INTEGER NOT NULL,
  Height INTEGER NOT NULL,
  Radius INTEGER,
  Updated_At DATETIME,
  Es_Sistema INTEGER NOT NULL DEFAULT 0,
  UNIQUE (ID_Zona, Numero_Mesa),
  FOREIGN KEY (ID_Zona) REFERENCES Zonas(ID_Zona) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS Clientes (
  ID_Cliente INTEGER PRIMARY KEY AUTOINCREMENT,
  Nombre TEXT NOT NULL,
  Telefono TEXT,
  Email TEXT,
  Notas TEXT,
  Total_Gastado REAL NOT NULL DEFAULT 0,
  Created_At TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS Reservas (
  ID_Reserva INTEGER PRIMARY KEY AUTOINCREMENT,
  ID_Cliente INTEGER NOT NULL,
  ID_Mesa INTEGER NOT NULL,
  Dia_YMD TEXT NOT NULL,
  Hora TEXT NOT NULL,
  Turno TEXT NOT NULL,
  Comensales INTEGER NOT NULL DEFAULT 1,
  Nota TEXT,
  Estado TEXT NOT NULL DEFAULT 'ACTIVA',
  Created_At TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (ID_Cliente) REFERENCES Clientes(ID_Cliente),
  FOREIGN KEY (ID_Mesa) REFERENCES Mesas(ID_Mesa)
);

CREATE INDEX IF NOT EXISTS idx_reservas_mesa_dia_hora
ON Reservas(ID_Mesa, Dia_YMD, Hora);

/* =========================================================
   6. Comandas / Detalles / Facturas / Cuentas
========================================================= */
CREATE TABLE IF NOT EXISTS Comandas (
  ID_Comanda INTEGER PRIMARY KEY AUTOINCREMENT,
  ID_Mesa INTEGER NOT NULL,
  ID_Reserva INTEGER NULL,
  ID_Trabajador INTEGER NULL,
  Fecha_Hora_Apertura TEXT NOT NULL,
  Fecha_Hora_Cierre TEXT NULL,
  Total_Comanda REAL NOT NULL DEFAULT 0,
  Estado TEXT NOT NULL DEFAULT 'Abierta',
  FOREIGN KEY (ID_Mesa) REFERENCES Mesas(ID_Mesa),
  FOREIGN KEY (ID_Reserva) REFERENCES Reservas(ID_Reserva),
  FOREIGN KEY (ID_Trabajador) REFERENCES Trabajadores(ID_Trabajador) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_comandas_mesa_estado
ON Comandas(ID_Mesa, Estado);

CREATE INDEX IF NOT EXISTS idx_comandas_reserva
ON Comandas(ID_Reserva);

CREATE INDEX IF NOT EXISTS idx_comandas_trab_apertura
ON Comandas(ID_Trabajador, Fecha_Hora_Apertura);

CREATE TABLE IF NOT EXISTS Detalle_Comanda (
  ID_Detalle INTEGER PRIMARY KEY AUTOINCREMENT,
  ID_Comanda INTEGER NOT NULL,
  ID_Producto INTEGER NOT NULL,
  Cantidad REAL NOT NULL,
  Precio_Unitario REAL NOT NULL,
  Notas TEXT,
  Estado_Cocina TEXT DEFAULT 'PENDIENTE',
  Fecha_Hora_Cocina DATETIME,
  ID_Usuario_Cocinero INTEGER,
  FOREIGN KEY (ID_Comanda) REFERENCES Comandas(ID_Comanda),
  FOREIGN KEY (ID_Producto) REFERENCES Productos(ID_Producto)
);

CREATE INDEX IF NOT EXISTS idx_dc_cocinero_fecha
ON Detalle_Comanda(ID_Usuario_Cocinero, Fecha_Hora_Cocina);

CREATE INDEX IF NOT EXISTS idx_dc_estado_fecha
ON Detalle_Comanda(Estado_Cocina, Fecha_Hora_Cocina);

CREATE TABLE IF NOT EXISTS Lote_Consumos (
  ID_Detalle INTEGER NOT NULL,
  ID_Lote INTEGER NOT NULL,
  Cantidad REAL NOT NULL,
  PRIMARY KEY (ID_Detalle, ID_Lote),
  FOREIGN KEY (ID_Detalle) REFERENCES Detalle_Comanda(ID_Detalle) ON DELETE CASCADE,
  FOREIGN KEY (ID_Lote) REFERENCES Lotes_Producto(ID_Lote),
  CHECK (Cantidad > 0)
);

CREATE INDEX IF NOT EXISTS idx_lote_consumos_lote
ON Lote_Consumos(ID_Lote);

CREATE TABLE IF NOT EXISTS Facturas (
  ID_Factura INTEGER PRIMARY KEY AUTOINCREMENT,
  ID_Comanda INTEGER UNIQUE NOT NULL,
  ID_Cliente INTEGER,
  Fecha_Emision DATETIME NOT NULL,
  Subtotal REAL NOT NULL,
  IVA REAL NOT NULL,
  Total_Pagado REAL NOT NULL,
  Metodo_Pago TEXT,
  FOREIGN KEY (ID_Comanda) REFERENCES Comandas(ID_Comanda),
  FOREIGN KEY (ID_Cliente) REFERENCES Clientes(ID_Cliente)
);

CREATE TABLE IF NOT EXISTS Cuentas_Gastos (
  ID_Gasto INTEGER PRIMARY KEY AUTOINCREMENT,
  Fecha DATE NOT NULL,
  Concepto TEXT NOT NULL,
  Importe REAL NOT NULL,
  Tipo_Gasto TEXT NOT NULL,
  ID_Proveedor INTEGER NULL,
  FOREIGN KEY (ID_Proveedor) REFERENCES Proveedores(ID_Proveedor) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_cuentas_gastos_fecha
ON Cuentas_Gastos(Fecha);

CREATE INDEX IF NOT EXISTS idx_cuentas_gastos_proveedor
ON Cuentas_Gastos(ID_Proveedor);

/* =========================================================
   7. Tareas
========================================================= */
CREATE TABLE IF NOT EXISTS Tareas (
  ID_Tarea INTEGER PRIMARY KEY AUTOINCREMENT,
  Titulo TEXT NOT NULL,
  Descripcion TEXT,
  Fecha_Creacion DATETIME NOT NULL DEFAULT (datetime('now','localtime')),
  Fecha_Limite DATE,
  Estado TEXT NOT NULL DEFAULT 'ABIERTA'
);

CREATE TABLE IF NOT EXISTS Tarea_Asignaciones (
  ID_Tarea INTEGER NOT NULL,
  ID_Trabajador INTEGER NOT NULL,
  Asignada_At DATETIME NOT NULL DEFAULT (datetime('now','localtime')),
  Estado TEXT NOT NULL DEFAULT 'PENDIENTE',
  Finalizada_At DATETIME,
  PRIMARY KEY (ID_Tarea, ID_Trabajador),
  FOREIGN KEY (ID_Tarea) REFERENCES Tareas(ID_Tarea) ON DELETE CASCADE,
  FOREIGN KEY (ID_Trabajador) REFERENCES Trabajadores(ID_Trabajador) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tarea_asig_trab
ON Tarea_Asignaciones(ID_Trabajador, Estado);

CREATE INDEX IF NOT EXISTS idx_tarea_asig_tarea
ON Tarea_Asignaciones(ID_Tarea);

/* =========================================================
   8. Fichajes
========================================================= */
CREATE TABLE IF NOT EXISTS Fichajes (
  ID_Fichaje INTEGER PRIMARY KEY AUTOINCREMENT,
  ID_Usuario INTEGER NOT NULL,
  Fecha DATE NOT NULL,
  Parte INTEGER NOT NULL DEFAULT 1,
  Hora_Entrada DATETIME,
  Hora_Salida DATETIME,
  Estado TEXT DEFAULT 'ABIERTO',
  Cerrado_Automatico INTEGER DEFAULT 0,
  Cierre_Motivo TEXT,
  Incidencia TEXT,
  UNIQUE(ID_Usuario, Fecha, Parte),
  FOREIGN KEY (ID_Usuario) REFERENCES Usuarios(ID_Usuario)
);

CREATE INDEX IF NOT EXISTS idx_fichajes_user_fecha
ON Fichajes(ID_Usuario, Fecha);

CREATE INDEX IF NOT EXISTS idx_fichajes_user_abierto
ON Fichajes(ID_Usuario, Estado);

CREATE TABLE IF NOT EXISTS Fichaje_Dia (
  ID_Usuario INTEGER NOT NULL,
  Fecha DATE NOT NULL,
  Turno_Partido INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ID_Usuario, Fecha),
  FOREIGN KEY (ID_Usuario) REFERENCES Usuarios(ID_Usuario)
);

/* =========================================================
   9. Pagos
========================================================= */
CREATE TABLE IF NOT EXISTS Pagos (
  ID_Pago INTEGER PRIMARY KEY AUTOINCREMENT,
  ID_Comanda INTEGER NOT NULL,
  Fecha_Hora DATETIME NOT NULL,
  Metodo_Pago TEXT NOT NULL,
  Importe_Total REAL NOT NULL,
  Tipo TEXT NOT NULL,
  ID_Usuario_Cobrador INTEGER,
  ID_Trabajador_Cobrador INTEGER,
  FOREIGN KEY (ID_Comanda) REFERENCES Comandas(ID_Comanda) ON DELETE CASCADE,
  FOREIGN KEY (ID_Usuario_Cobrador) REFERENCES Usuarios(ID_Usuario) ON DELETE SET NULL,
  FOREIGN KEY (ID_Trabajador_Cobrador) REFERENCES Trabajadores(ID_Trabajador) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_pagos_fecha
ON Pagos(Fecha_Hora);

CREATE INDEX IF NOT EXISTS idx_pagos_comanda_fecha
ON Pagos(ID_Comanda, Fecha_Hora);

CREATE INDEX IF NOT EXISTS idx_pagos_trab_cobrador_fecha
ON Pagos(ID_Trabajador_Cobrador, Fecha_Hora);

CREATE TABLE IF NOT EXISTS Pago_Detalles (
  ID_Pago INTEGER NOT NULL,
  ID_Detalle INTEGER NOT NULL,
  PRIMARY KEY (ID_Pago, ID_Detalle),
  FOREIGN KEY (ID_Pago) REFERENCES Pagos(ID_Pago),
  FOREIGN KEY (ID_Detalle) REFERENCES Detalle_Comanda(ID_Detalle)
);

/* =========================================================
   10. Idempotencia / Replay seguro
========================================================= */
CREATE TABLE IF NOT EXISTS Applied_Operations (
  ID_Applied_Operation INTEGER PRIMARY KEY AUTOINCREMENT,
  Op_Id TEXT NOT NULL,
  Command_Name TEXT NOT NULL,
  Request_Hash TEXT NOT NULL,
  Device_Id TEXT,
  Status TEXT NOT NULL DEFAULT 'PROCESSING',
  Result_Json TEXT,
  Error_Text TEXT,
  Created_At_Ms INTEGER NOT NULL,
  Applied_At_Ms INTEGER,
  Updated_At_Ms INTEGER NOT NULL,
  UNIQUE (Op_Id),
  CHECK (Status IN ('PROCESSING', 'APPLIED', 'FAILED'))
);

CREATE INDEX IF NOT EXISTS idx_applied_ops_status
ON Applied_Operations(Status);

CREATE INDEX IF NOT EXISTS idx_applied_ops_created_at
ON Applied_Operations(Created_At_Ms);

CREATE INDEX IF NOT EXISTS idx_applied_ops_command
ON Applied_Operations(Command_Name);

CREATE TABLE IF NOT EXISTS Outbox_Operations (
  ID_Outbox INTEGER PRIMARY KEY AUTOINCREMENT,
  Op_Id TEXT NOT NULL UNIQUE,
  Command_Name TEXT NOT NULL,
  Payload_Json TEXT NOT NULL,
  Status TEXT NOT NULL DEFAULT 'PENDING',
  Attempt_Count INTEGER NOT NULL DEFAULT 0,
  Last_Error TEXT,
  Created_At_Ms INTEGER NOT NULL,
  Updated_At_Ms INTEGER NOT NULL,
  Last_Attempt_At_Ms INTEGER,
  CHECK (Status IN ('PENDING', 'SYNCING', 'APPLIED', 'FAILED'))
);

CREATE INDEX IF NOT EXISTS idx_outbox_status
ON Outbox_Operations(Status);

CREATE INDEX IF NOT EXISTS idx_outbox_created
ON Outbox_Operations(Created_At_Ms);

/* =========================================================
   11. Sync cloud/local
========================================================= */
CREATE TABLE IF NOT EXISTS Schema_Meta (
  Key TEXT PRIMARY KEY,
  Value TEXT NOT NULL,
  Updated_At_Ms INTEGER NOT NULL
);

INSERT OR IGNORE INTO Schema_Meta (Key, Value, Updated_At_Ms)
VALUES ('schema_version', '1', 0);

CREATE TABLE IF NOT EXISTS Cloud_Changes (
  ID_Change INTEGER PRIMARY KEY AUTOINCREMENT,
  Op_Id TEXT NOT NULL,
  Command_Name TEXT NOT NULL,
  Command_Version INTEGER NOT NULL DEFAULT 1,
  Device_Id TEXT,
  Payload_Json TEXT NOT NULL,
  Result_Json TEXT,
  Created_At_Ms INTEGER NOT NULL,
  UNIQUE (Op_Id)
);

CREATE INDEX IF NOT EXISTS idx_cloud_changes_id
ON Cloud_Changes(ID_Change);

CREATE INDEX IF NOT EXISTS idx_cloud_changes_created
ON Cloud_Changes(Created_At_Ms);

CREATE INDEX IF NOT EXISTS idx_cloud_changes_command
ON Cloud_Changes(Command_Name);

CREATE TABLE IF NOT EXISTS Sync_State (
  Key TEXT PRIMARY KEY,
  Value TEXT NOT NULL,
  Updated_At_Ms INTEGER NOT NULL
);

INSERT OR IGNORE INTO Sync_State (Key, Value, Updated_At_Ms)
VALUES ('last_cloud_change_id', '0', 0);

CREATE TABLE IF NOT EXISTS Cloud_Applied_Changes (
  ID_Change INTEGER PRIMARY KEY,
  Op_Id TEXT NOT NULL,
  Command_Name TEXT NOT NULL,
  Device_Id TEXT,
  Applied_At_Ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cloud_applied_ops
ON Cloud_Applied_Changes(Op_Id, Command_Name);

CREATE TABLE IF NOT EXISTS Local_Applied_Operations (
  Op_Id TEXT NOT NULL,
  Command_Name TEXT NOT NULL,
  Source TEXT NOT NULL,
  Applied_At_Ms INTEGER NOT NULL,
  PRIMARY KEY (Op_Id, Command_Name),
  CHECK (Source IN ('afterRemoteOk', 'cloudSync', 'outbox'))
);

CREATE INDEX IF NOT EXISTS idx_local_applied_source
ON Local_Applied_Operations(Source, Applied_At_Ms);

/* =========================================================
   12. Configuración
========================================================= */
CREATE TABLE IF NOT EXISTS Business_Settings (
  ID INTEGER PRIMARY KEY CHECK (ID = 1),
  Business_Name TEXT NOT NULL DEFAULT 'TPV',
  Logo_DataUrl TEXT,
  Direccion TEXT DEFAULT '',
  Telefono TEXT DEFAULT '',
  CIF TEXT DEFAULT '',
  Mensaje_Footer TEXT DEFAULT '¡Gracias por su visita!',
  IVA_Percent REAL NOT NULL DEFAULT 10,
  Updated_At TEXT DEFAULT (datetime('now','localtime'))
);

INSERT OR IGNORE INTO Business_Settings (ID) VALUES (1);

CREATE TABLE IF NOT EXISTS Ticket_Settings (
  ID INTEGER PRIMARY KEY CHECK (ID = 1),
  Show_Logo INTEGER NOT NULL DEFAULT 1,
  Show_BusinessName INTEGER NOT NULL DEFAULT 1,
  Show_Address INTEGER NOT NULL DEFAULT 1,
  Show_Phone INTEGER NOT NULL DEFAULT 1,
  Show_CIF INTEGER NOT NULL DEFAULT 1,
  Show_DateTime INTEGER NOT NULL DEFAULT 1,
  Show_LineItems INTEGER NOT NULL DEFAULT 1,
  Show_BaseAndIVA INTEGER NOT NULL DEFAULT 1,
  Show_Total INTEGER NOT NULL DEFAULT 1,
  Show_FooterMessage INTEGER NOT NULL DEFAULT 1,
  Paper_Width_Mm INTEGER NOT NULL DEFAULT 80,
  Paper_Dpi INTEGER NOT NULL DEFAULT 203,
  Chars_Per_Line INTEGER NOT NULL DEFAULT 42,
  Margin_Top_Mm REAL NOT NULL DEFAULT 0,
  Margin_Bottom_Mm REAL NOT NULL DEFAULT 0,
  Margin_Left_Mm REAL NOT NULL DEFAULT 0,
  Margin_Right_Mm REAL NOT NULL DEFAULT 0,
  Font_Scale REAL NOT NULL DEFAULT 1.0,
  Updated_At TEXT DEFAULT (datetime('now','localtime')),
  CHECK (Paper_Width_Mm IN (58, 80, 112)),
  CHECK (Paper_Dpi IN (203, 300)),
  CHECK (Chars_Per_Line >= 20 AND Chars_Per_Line <= 80),
  CHECK (Font_Scale >= 0.5 AND Font_Scale <= 2.0)
);

INSERT OR IGNORE INTO Ticket_Settings (ID) VALUES (1);

/* =========================================================
   13. Vistas
========================================================= */
CREATE VIEW IF NOT EXISTS v_inventario_producto_stock AS
SELECT
  p.ID_Producto,
  COALESCE(SUM(l.Stock_Disponible), 0) AS Stock_Actual,
  (
    SELECT l2.Caducidad
    FROM Lotes_Producto l2
    WHERE l2.ID_Producto = p.ID_Producto
      AND COALESCE(l2.Stock_Disponible, 0) > 0
      AND l2.Caducidad IS NOT NULL
    ORDER BY date(l2.Caducidad) ASC, datetime(l2.Fecha_Entrada) ASC, l2.ID_Lote ASC
    LIMIT 1
  ) AS Caducidad_Proxima,
  (
    SELECT l3.Codigo_Lote
    FROM Lotes_Producto l3
    WHERE l3.ID_Producto = p.ID_Producto
      AND COALESCE(l3.Stock_Disponible, 0) > 0
    ORDER BY
      CASE WHEN l3.Caducidad IS NULL THEN 1 ELSE 0 END,
      date(l3.Caducidad) ASC,
      datetime(l3.Fecha_Entrada) ASC,
      l3.ID_Lote ASC
    LIMIT 1
  ) AS Lote_Proximo
FROM Productos p
LEFT JOIN Lotes_Producto l ON l.ID_Producto = p.ID_Producto
GROUP BY p.ID_Producto;

/* =========================================================
   14. Seeds
========================================================= */
INSERT OR IGNORE INTO Alergenos (Nombre, Nombre_Imagen, Ruta_Imagen) VALUES
  ('Gluten', 'gluten.png', '/alergenos/gluten.png'),
  ('Crustáceos', 'crustaceos.png', '/alergenos/crustaceos.png'),
  ('Huevos', 'huevos.png', '/alergenos/huevos.png'),
  ('Pescado', 'pescado.png', '/alergenos/pescado.png'),
  ('Cacahuetes', 'cacahuetes.png', '/alergenos/cacahuetes.png'),
  ('Soja', 'soja.png', '/alergenos/soja.png'),
  ('Lácteos', 'lacteos.png', '/alergenos/lacteos.png'),
  ('Frutos de cáscara', 'frutos_cascara.png', '/alergenos/frutos_cascara.png'),
  ('Apio', 'apio.png', '/alergenos/apio.png'),
  ('Mostaza', 'mostaza.png', '/alergenos/mostaza.png'),
  ('Sésamo', 'sesamo.png', '/alergenos/sesamo.png'),
  ('Sulfitos', 'sulfitos.png', '/alergenos/sulfitos.png'),
  ('Altramuces', 'altramuces.png', '/alergenos/altramuces.png'),
  ('Moluscos', 'moluscos.png', '/alergenos/moluscos.png');

INSERT OR IGNORE INTO Zonas (Nombre_Zona, Room_Points, Updated_At) VALUES
  ('Salon', '[]', datetime('now')),
  ('Terraza', '[]', datetime('now'));

INSERT OR IGNORE INTO Zonas (Nombre_Zona, Room_Points, Updated_At)
VALUES ('BARRA', '[]', datetime('now'));

INSERT OR IGNORE INTO Mesas (
  ID_Zona,
  Numero_Mesa,
  Capacidad,
  Ubicacion_X,
  Ubicacion_Y,
  Shape,
  Width,
  Height,
  Radius,
  Updated_At,
  Es_Sistema
) VALUES (
  (SELECT ID_Zona FROM Zonas WHERE Nombre_Zona = 'BARRA' LIMIT 1),
  'BARRA',
  0,
  0,
  0,
  'rect',
  1,
  1,
  NULL,
  datetime('now'),
  1
);
`;

// Splitter simple (evita partir dentro de comillas)
function splitSqlStatements(sql: string): string[] {
	const out: string[] = [];
	let cur = "";
	let inSingle = false;
	let inDouble = false;

	for (let i = 0; i < sql.length; i++) {
		const ch = sql[i];
		const prev = i > 0 ? sql[i - 1] : "";

		if (ch === "'" && !inDouble && prev !== "\\") inSingle = !inSingle;
		if (ch === `"` && !inSingle && prev !== "\\") inDouble = !inDouble;

		if (ch === ";" && !inSingle && !inDouble) {
			const stmt = cur.trim();
			if (stmt) out.push(stmt);
			cur = "";
			continue;
		}

		cur += ch;
	}

	const last = cur.trim();
	if (last) out.push(last);
	return out;
}

// Sanitiza nombre db: minúsculas, números y guiones; max 64
function makeDbNameFromTenant(tenantId: string): string {
	const base = `tpv-${tenantId}`.toLowerCase();
	const clean = base.replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");
	return clean.length <= 64 ? clean : clean.slice(0, 64);
}

async function tursoCreateDatabase(env: Env, dbName: string): Promise<{ name: string; hostname: string; url: string }> {
	const r = await fetch(`https://api.turso.tech/v1/organizations/${encodeURIComponent(env.TURSO_ORG_SLUG)}/databases`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${env.TURSO_PLATFORM_TOKEN}`,
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify({
			name: dbName,
			group: "default",
		}),
	});

	const text = await r.text();
	let data: any = null;
	try { data = JSON.parse(text); } catch { }

	if (!r.ok) {
		throw new Error(`turso_create_db_failed (${r.status}) ${text}`);
	}

	const hostname = String(data?.database?.Hostname || data?.database?.hostname || "");
	const name = String(data?.database?.Name || data?.database?.name || dbName);

	if (!hostname) throw new Error(`turso_create_db_failed_missing_hostname ${text}`);

	const url = `libsql://${hostname}`;
	return { name, hostname, url };
}

async function tursoCreateDbToken(env: Env, dbName: string): Promise<string> {
	const r = await fetch(
		`https://api.turso.tech/v1/organizations/${encodeURIComponent(env.TURSO_ORG_SLUG)}/databases/${encodeURIComponent(
			dbName
		)}/auth/tokens?expiration=7d`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${env.TURSO_PLATFORM_TOKEN}`,
				Accept: "application/json",
			},
		}
	);

	const text = await r.text();
	let data: any = null;
	try { data = JSON.parse(text); } catch { }

	if (!r.ok) throw new Error(`turso_create_db_token_failed (${r.status}) ${text}`);

	const jwt = String(data?.jwt || "");
	if (!jwt) throw new Error(`turso_create_db_token_failed_missing_jwt ${text}`);
	return jwt;
}

async function getTenantDbRow(dbi: ReturnType<typeof getDb>, tenantId: string) {
	const r = await dbi.execute({
		sql: `
			SELECT
				tenant_id,
				turso_db_name,
				turso_url,
				turso_auth_token_enc,
				created_at_ms,
				rotated_at_ms
			FROM tenant_databases
			WHERE tenant_id = ?
			LIMIT 1
		`,
		args: [tenantId],
	});
	return r.rows?.[0] as any | undefined;
}

async function upsertTenantDbRow(
	dbi: ReturnType<typeof getDb>,
	env: Env,
	tenantId: string,
	dbName: string,
	tursoUrl: string,
	tursoTokenPlain: string
) {
	const enc = await aesGcmEncryptToB64(env.LICENSE_STORE_KEY, tursoTokenPlain);
	await dbi.execute({
		sql: `INSERT INTO tenant_databases (tenant_id, turso_db_name, turso_url, turso_auth_token_enc, created_at_ms, rotated_at_ms)
		      VALUES (?, ?, ?, ?, unixepoch()*1000, NULL)
		      ON CONFLICT(tenant_id) DO UPDATE SET
		        turso_db_name = excluded.turso_db_name,
		        turso_url = excluded.turso_url,
		        turso_auth_token_enc = excluded.turso_auth_token_enc,
		        rotated_at_ms = unixepoch()*1000`,
		args: [tenantId, dbName, tursoUrl, enc],
	});
}

const TENANT_DB_ROTATE_INTERVAL_MS = 24 * 60 * 60 * 1000;

function toNumOrNull(v: any): number | null {
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

function getTenantTokenAgeBaseMs(row: any): number {
	return (
		toNumOrNull(row?.rotated_at_ms) ??
		toNumOrNull(row?.created_at_ms) ??
		0
	);
}

async function hmacSha256Hex(secret: string, raw: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"]
	);

	const mac = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(raw)
	);

	return [...new Uint8Array(mac)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

async function verifyInternalWorkerRequest(
	req: Request,
	env: Env,
	rawBody: string
): Promise<void> {
	const tsStr = (req.headers.get("x-internal-ts") || "").trim();
	const sigHex = (req.headers.get("x-internal-sig") || "").trim().toLowerCase();

	if (!tsStr || !sigHex) throw new Error("missing_internal_auth");

	const ts = Number(tsStr);
	if (!Number.isFinite(ts)) throw new Error("bad_internal_ts");

	const now = Date.now();
	const MAX_SKEW_MS = 60 * 1000;
	if (Math.abs(now - ts) > MAX_SKEW_MS) throw new Error("internal_ts_out_of_range");

	const payload = `${ts}\n${req.method.toUpperCase()}\n${new URL(req.url).pathname}\n${rawBody}`;
	const expected = await hmacSha256Hex(
		String(env.LICENSE_JWT_SECRET || ""),
		payload
	);

	if (!timingSafeEqualHex(expected, sigHex)) {
		throw new Error("bad_internal_signature");
	}
}

async function resolveTenantDbCredentials(
	dbi: ReturnType<typeof getDb>,
	env: Env,
	tenantId: string,
	forceRotate = false
): Promise<{
	dbName: string;
	tursoUrl: string;
	tursoAuthToken: string;
	rotated: boolean;
	rotatedAtMs: number;
}> {
	const row = await getTenantDbRow(dbi, tenantId);

	if (!row?.turso_db_name || !row?.turso_url || !row?.turso_auth_token_enc) {
		throw new Error("tenant_db_not_provisioned");
	}

	const dbName = String(row.turso_db_name);
	const tursoUrl = String(row.turso_url);
	const lastRotationBaseMs = getTenantTokenAgeBaseMs(row);
	const shouldRotate =
		forceRotate ||
		!lastRotationBaseMs ||
		Date.now() - lastRotationBaseMs >= TENANT_DB_ROTATE_INTERVAL_MS;

	if (shouldRotate) {
		const freshToken = await tursoCreateDbToken(env, dbName);

		await upsertTenantDbRow(
			dbi,
			env,
			tenantId,
			dbName,
			tursoUrl,
			freshToken
		);

		return {
			dbName,
			tursoUrl,
			tursoAuthToken: freshToken,
			rotated: true,
			rotatedAtMs: Date.now(),
		};
	}

	const token = await aesGcmDecryptFromB64(
		env.LICENSE_STORE_KEY,
		String(row.turso_auth_token_enc)
	);

	return {
		dbName,
		tursoUrl,
		tursoAuthToken: token,
		rotated: false,
		rotatedAtMs: lastRotationBaseMs,
	};
}

async function applyTenantSchemaOnce(tursoUrl: string, token: string): Promise<void> {
	const client: Client = createClient({
		url: tursoUrl,
		authToken: token,
	});

	const stmts = splitSqlStatements(TPV_SCHEMA_SQL)
		.map((s) => s.trim())
		.filter(Boolean);

	await client.batch(stmts, "write");

	await ensureTenantInitialAdmin(client);
}

async function provisionTenantDatabase(dbi: ReturnType<typeof getDb>, env: Env, tenantId: string) {
	const existing = await getTenantDbRow(dbi, tenantId);

	if (existing?.turso_url && existing?.turso_auth_token_enc && existing?.turso_db_name) {
		const resolved = await resolveTenantDbCredentials(dbi, env, tenantId, false);
		await applyTenantSchemaOnce(resolved.tursoUrl, resolved.tursoAuthToken);

		return {
			reused: true,
			dbName: resolved.dbName,
			url: resolved.tursoUrl,
		};
	}

	const dbName = makeDbNameFromTenant(tenantId);

	const created = await tursoCreateDatabase(env, dbName);
	const dbToken = await tursoCreateDbToken(env, created.name);

	await upsertTenantDbRow(dbi, env, tenantId, created.name, created.url, dbToken);

	await applyTenantSchemaOnce(created.url, dbToken);

	return { reused: false, dbName: created.name, url: created.url };
}

// ---------------- Worker ----------------

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		// DB init (lazy)
		let db: ReturnType<typeof getDb> | null = null;
		const get = () => {
			if (!db) db = getDb(env);
			return db!;
		};

		if (url.pathname === "/health") {
			return json({ ok: true, service: "tpv-licensing", ts: Date.now() });
		}

		if (url.pathname === "/internal/tenant-db/resolve" && request.method === "POST") {
			const miss = assertEnv(env, [
				"LICENSE_JWT_SECRET",
				"LICENSE_STORE_KEY",
				"TURSO_DATABASE_URL",
				"TURSO_AUTH_TOKEN",
				"TURSO_PLATFORM_TOKEN",
				"TURSO_ORG_SLUG",
			]);
			if (miss) return json({ ok: false, error: miss }, 500);

			const raw = await request.text();

			try {
				await verifyInternalWorkerRequest(request, env, raw);
			} catch (e: any) {
				return json({ ok: false, error: String(e?.message || e) }, 401);
			}

			let body: any = {};
			try {
				body = raw ? JSON.parse(raw) : {};
			} catch {
				return json({ ok: false, error: "invalid_json" }, 400);
			}

			const originalMethod = String(body?.originalMethod || "").toUpperCase();
			const originalPath = String(body?.originalPath || "");
			const forceRotate = !!body?.forceRotate;

			if (!originalMethod || !originalPath.startsWith("/")) {
				return json({ ok: false, error: "invalid_original_request" }, 400);
			}

			const h = request.headers.get("authorization") || "";
			const m = h.match(/^Bearer\s+(.+)$/i);
			if (!m) return json({ ok: false, error: "missing_token" }, 401);

			let claims: { tenantId: string; deviceId: string; licHash: string };
			try {
				claims = await verifyToken(env, m[1]);
			} catch {
				return json({ ok: false, error: "invalid_token" }, 401);
			}

			const dbi = get();
			await ensureExtraSchema(dbi);

			const proof = await verifyDeviceProof(
				request,
				dbi,
				{ tenantId: claims.tenantId, deviceId: claims.deviceId },
				{ method: originalMethod, path: originalPath }
			);

			if (!proof.ok) {
				return json({ ok: false, error: proof.error }, 401);
			}

			try {
				const resolved = await resolveTenantDbCredentials(
					dbi,
					env,
					claims.tenantId,
					forceRotate
				);

				await ensureTenantInitialAdminByCredentials(
					resolved.tursoUrl,
					resolved.tursoAuthToken
				);

				return json({
					ok: true,
					result: {
						token: m[1],
						claims,
						...resolved,
					},
				});
			} catch (e: any) {
				return json(
					{
						ok: false,
						error: "tenant_db_resolve_failed",
						details: String(e?.message || e),
					},
					500
				);
			}
		}

		if (url.pathname === "/internal/tenant-db/resolve-by-tenant" && request.method === "POST") {
			const miss = assertEnv(env, [
				"LICENSE_JWT_SECRET",
				"LICENSE_STORE_KEY",
				"TURSO_DATABASE_URL",
				"TURSO_AUTH_TOKEN",
				"TURSO_PLATFORM_TOKEN",
				"TURSO_ORG_SLUG",
			]);
			if (miss) return json({ ok: false, error: miss }, 500);

			const raw = await request.text();

			try {
				await verifyInternalWorkerRequest(request, env, raw);
			} catch (e: any) {
				return json({ ok: false, error: String(e?.message || e) }, 401);
			}

			let body: any = {};
			try {
				body = raw ? JSON.parse(raw) : {};
			} catch {
				return json({ ok: false, error: "invalid_json" }, 400);
			}

			const tenantId = String(body?.tenantId || "").trim();
			const forceRotate = !!body?.forceRotate;

			if (!tenantId) {
				return json({ ok: false, error: "missing_tenant_id" }, 400);
			}

			const dbi = get();
			await ensureExtraSchema(dbi);

			try {
				const resolved = await resolveTenantDbCredentials(
					dbi,
					env,
					tenantId,
					forceRotate
				);

				await ensureTenantInitialAdminByCredentials(
					resolved.tursoUrl,
					resolved.tursoAuthToken
				);

				return json({
					ok: true,
					result: {
						tenantId,
						...resolved,
					},
				});
			} catch (e: any) {
				return json(
					{
						ok: false,
						error: "tenant_db_resolve_failed",
						details: String(e?.message || e),
					},
					500
				);
			}
		}

		// 1) WEBHOOK Lemon
		if (url.pathname === "/v1/webhooks/lemon" && request.method === "POST") {
			const miss = assertEnv(env, ["LEMON_WEBHOOK_SECRET", "TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN", "LICENSE_STORE_KEY"]);
			if (miss) return json({ ok: false, error: miss }, 500);

			const raw = await request.text();

			console.log("[LEMON] webhook hit", {
				ts: Date.now(),
				sigPresent: Boolean((request.headers.get("X-Signature") || "").trim()),
				bytes: raw.length,
			});

			const validSig = await verifyLemonSignature(request, env.LEMON_WEBHOOK_SECRET, raw);
			if (!validSig) return json({ ok: false, error: "invalid_signature" }, 401);

			const sig = (request.headers.get("X-Signature") || "").trim().toLowerCase();
			const bodySha = await sha256Hex(raw);
			const eventUid = await sha256Hex(sig + ":" + bodySha);

			const dbi = get();
			await ensureExtraSchema(dbi);

			let payload: LemonWebhookPayload | null = null;
			try {
				payload = JSON.parse(raw);
			} catch {
				return json({ ok: false, error: "invalid_json" }, 400);
			}

			const eventName = String(payload?.meta?.event_name || "");
			const testMode = Boolean(payload?.meta?.test_mode);

			const resourceType = (payload as any)?.data?.type ? String((payload as any).data.type) : null;
			const resourceId = (payload as any)?.data?.id ? String((payload as any).data.id) : null;

			const idemp = await upsertWebhookEvent(dbi, {
				event_uid: eventUid,
				event_name: eventName || "unknown",
				resource_type: resourceType,
				resource_id: resourceId,
				sig_hex: sig || null,
				body_sha256: bodySha,
				payload_json: raw,
			});

			if (idemp.already) {
				return json({ ok: true, received: true, eventName, idempotent: true });
			}

			try {
				const attrs = payload?.data?.attributes || {};
				const licenseKey = String((attrs as any).key || "").trim();
				const status = String((attrs as any).status || "unknown").trim() as LicenseStatus;
				const expiresAt = (attrs as any).expires_at ? String((attrs as any).expires_at) : null;

				console.log("[LEMON] event", { eventName, hasKey: Boolean(licenseKey), status, expiresAt, testMode });

				if (licenseKey) {
					await upsertLicenseFromEventOrActivation({
						db: dbi,
						storeKeyB64: env.LICENSE_STORE_KEY,
						licenseKeyPlain: licenseKey,
						tenantId: null,
						status: (status || "active") as LicenseStatus,
						expiresAt,
						testMode,

						lemon_license_key_id: resourceId,
						lemon_created_at: (attrs as any).created_at ? String((attrs as any).created_at) : null,
						lemon_updated_at: (attrs as any).updated_at ? String((attrs as any).updated_at) : null,

						meta: { eventName, payload },
					});
				}

				await markWebhookProcessed(dbi, eventUid, true);
				return json({ ok: true, received: true, eventName });
			} catch (e: any) {
				await markWebhookProcessed(dbi, eventUid, false, String(e?.message || e));
				return json({ ok: false, error: "webhook_processing_failed" }, 500);
			}
		}

		// 2) ACTIVAR (TPV MAIN)
		if (url.pathname === "/v1/license/activate" && request.method === "POST") {
			const miss = assertEnv(env, [
				"LICENSE_JWT_SECRET",
				"LICENSE_STORE_KEY",
				"TURSO_DATABASE_URL",
				"TURSO_AUTH_TOKEN",
				"TURSO_PLATFORM_TOKEN",
				"TURSO_ORG_SLUG",
			]);
			if (miss) return json({ ok: false, error: miss }, 500);

			const err = requireJson(request);
			if (err) return err;

			const body = await readJsonSafe<ActivateRequest & { devicePubKey?: string }>(
				request,
				{
					activationKey: "",
					deviceId: "",
					instanceName: undefined,
				} as any
			);

			const activationKey = String((body as any).activationKey || "").trim();

			// ✅ deviceId: si viene, lo respetamos; si no, lo genera el Worker
			const reqDeviceId = String((body as any).deviceId || "").trim();
			const deviceId = reqDeviceId || crypto.randomUUID();

			// ✅ NUEVO: devicePubKey (obligatoria para anti-copia)
			const devicePubKey = String((body as any).devicePubKey || "").trim();
			if (!devicePubKey) {
				return json({ ok: false, error: "devicePubKey required" }, 400);
			}

			// ✅ instanceName: si no viene, lo generamos a partir del deviceId
			const reqInstanceName = String((body as any).instanceName || "").trim();
			const instanceName = reqInstanceName || `tpv-${deviceId.slice(0, 12)}`;

			if (!activationKey) {
				const out: ApiError = { ok: false, error: "activationKey required" };
				return json(out, 400);
			}

			const dbi = get();
			await ensureExtraSchema(dbi);

			// ✅ Idempotencia antes de tocar Lemon:
			const licHash = await sha256Hex(activationKey);
			const existing = await getLicenseByHash(dbi, licHash);

			let act: { ok: boolean; status: number; data: any; text: string } | null = null;

			if (!existing || !existing.tenant_id || existing.tenant_id === "PENDING") {
				act = await lemonActivate(activationKey, instanceName);
				if (!act.ok) {
					const out: ApiError = {
						ok: false,
						error: act.data?.error || "lemon_activate_failed",
						details: act.data || act.text,
					};
					return json(out, 400);
				}
			} else {
				act = {
					ok: true,
					status: 200,
					data: { license_key: { status: existing.status, expires_at: existing.expires_at }, meta: { reused: true } },
					text: "",
				};
			}

			const licenseKeyObj = act.data?.license_key;
			const instanceObj = act.data?.instance;

			const status = (licenseKeyObj?.status || "active") as LicenseStatus;
			const expiresAt = licenseKeyObj?.expires_at ? String(licenseKeyObj.expires_at) : null;
			const instanceId = instanceObj?.id ? String(instanceObj.id) : null;

			let tenantId =
				existing?.tenant_id && existing.tenant_id !== "PENDING"
					? existing.tenant_id
					: crypto.randomUUID();

			// Garantiza tenant y device
			await ensureTenantExistsMinimal(dbi, tenantId);

			// ✅ ensureDevice ahora también guarda pubkey si procede (y controla mismatch)
			await ensureDevice(dbi, tenantId, deviceId, "tpv", devicePubKey);

			// ✅ extra seguridad: si ya existía key distinta, esto lanza 409
			await setDevicePubKeyB64IfEmptyOrThrow(dbi, tenantId, deviceId, devicePubKey);

			const { license } = await upsertLicenseFromEventOrActivation({
				db: dbi,
				storeKeyB64: env.LICENSE_STORE_KEY,
				licenseKeyPlain: activationKey,
				tenantId,
				status,
				expiresAt,
				testMode: Boolean(act.data?.meta?.test_mode),

				lemon_license_key_id: licenseKeyObj?.id ? String(licenseKeyObj.id) : existing?.lemon_license_key_id ?? null,
				lemon_customer_id: licenseKeyObj?.customer_id ? String(licenseKeyObj.customer_id) : null,
				lemon_order_id: licenseKeyObj?.order_id ? String(licenseKeyObj.order_id) : null,
				lemon_order_item_id: licenseKeyObj?.order_item_id ? String(licenseKeyObj.order_item_id) : null,
				lemon_store_id: licenseKeyObj?.store_id ? String(licenseKeyObj.store_id) : null,
				lemon_product_id: licenseKeyObj?.product_id ? String(licenseKeyObj.product_id) : null,

				instances_count: typeof licenseKeyObj?.instances_count === "number" ? licenseKeyObj.instances_count : null,
				activation_limit: typeof licenseKeyObj?.activation_limit === "number" ? licenseKeyObj.activation_limit : null,

				user_name: licenseKeyObj?.user_name ? String(licenseKeyObj.user_name) : null,
				user_email: licenseKeyObj?.user_email ? String(licenseKeyObj.user_email) : null,

				lemon_created_at: licenseKeyObj?.created_at ? String(licenseKeyObj.created_at) : null,
				lemon_updated_at: licenseKeyObj?.updated_at ? String(licenseKeyObj.updated_at) : null,

				meta: act.data?.meta || null,
			});

			if (instanceId) {
				await upsertLicenseInstance(dbi, {
					instanceId,
					licenseId: license.license_id,
					tenantId,
					deviceId,
					instanceName: instanceName || null,
				});
			}

			// ✅ Provision tenant DB + aplicar schema + admin inicial
			try {
				await provisionTenantDatabase(dbi, env, tenantId);
			} catch (e: any) {
				return json(
					{
						ok: false,
						error: "tenant_db_provision_failed",
						details: String(e?.message || e),
					},
					500
				);
			}

			const token = await signToken(env, { tenantId, deviceId, licHash });

			const out: ActivateResponse & { deviceId: string } = {
				ok: true,
				tenantId,
				deviceId,
				token,
				status,
				expiresAt,
			};

			return json(out);
		}

		// 3) STATUS
		if (url.pathname === "/v1/license/status" && request.method === "GET") {
			const miss = assertEnv(env, ["LICENSE_JWT_SECRET", "TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"]);
			if (miss) return json({ ok: false, error: miss }, 500);

			const h = request.headers.get("authorization") || "";
			const m = h.match(/^Bearer\s+(.+)$/i);
			if (!m) return json({ ok: false, error: "missing_token" }, 401);

			let claims: { tenantId: string; deviceId: string; licHash: string };
			try {
				claims = await verifyToken(env, m[1]);
			} catch {
				return json({ ok: false, error: "invalid_token" }, 401);
			}

			const dbi = get();
			await ensureExtraSchema(dbi);

			const proof = await verifyDeviceProof(request, dbi, { tenantId: claims.tenantId, deviceId: claims.deviceId });
			if (!proof.ok) return json({ ok: false, error: proof.error }, 401);

			const lic = await getLicenseByHash(dbi, claims.licHash);
			if (!lic) return json({ ok: false, error: "not_found" }, 404);

			return json({
				ok: true,
				state: {
					tenant_id: lic.tenant_id,
					status: lic.status,
					expires_at: lic.expires_at,
					disabled: toBool01((lic as any).disabled, false),
					test_mode: toBool01((lic as any).test_mode, false),
					key_short: lic.key_short,
					updated_at_ms: lic.updated_at_ms,
					created_at_ms: lic.created_at_ms,
				},
				serverTime: Date.now(),
			});
		}

		// 4) VALIDATE (re-check con Lemon)
		if (url.pathname === "/v1/license/validate" && request.method === "POST") {
			const miss = assertEnv(env, [
				"LICENSE_JWT_SECRET",
				"LICENSE_STORE_KEY",
				"TURSO_DATABASE_URL",
				"TURSO_AUTH_TOKEN",
			]);
			if (miss) return json({ ok: false, error: miss }, 500);

			const h = request.headers.get("authorization") || "";
			const m = h.match(/^Bearer\s+(.+)$/i);
			if (!m) return json({ ok: false, error: "missing_token" }, 401);

			let claims: { tenantId: string; deviceId: string; licHash: string };
			try {
				claims = await verifyToken(env, m[1]);
			} catch {
				return json({ ok: false, error: "invalid_token" }, 401);
			}

			const dbi = get();
			await ensureExtraSchema(dbi);

			const proof = await verifyDeviceProof(request, dbi, { tenantId: claims.tenantId, deviceId: claims.deviceId });
			if (!proof.ok) return json({ ok: false, error: proof.error }, 401);

			const dec = await getDecryptedLicenseKey(dbi, env.LICENSE_STORE_KEY, claims.licHash);
			if (!dec) return json({ ok: false, error: "not_found" }, 404);

			const licenseKey = dec.licenseKey;

			const val = await lemonValidate(licenseKey, null);
			if (!val.ok) {
				return json({ ok: false, error: "lemon_validate_failed", details: val.data || val.text }, 400);
			}

			const status = (val.data?.license_key?.status || "active") as LicenseStatus;
			const expiresAt = val.data?.license_key?.expires_at ? String(val.data.license_key.expires_at) : null;

			await upsertLicenseFromEventOrActivation({
				db: dbi,
				storeKeyB64: env.LICENSE_STORE_KEY,
				licenseKeyPlain: licenseKey,
				tenantId: dec.lic.tenant_id,
				status,
				expiresAt,
				testMode: Boolean(val.data?.meta?.test_mode),
				instances_count:
					typeof val.data?.license_key?.instances_count === "number"
						? val.data.license_key.instances_count
						: null,
				activation_limit:
					typeof val.data?.license_key?.activation_limit === "number"
						? val.data.license_key.activation_limit
						: null,
				lemon_updated_at: val.data?.license_key?.updated_at ? String(val.data.license_key.updated_at) : null,
				meta: val.data?.meta || null,
			});

			return json({ ok: true, status, expiresAt, valid: val.data?.valid, meta: val.data?.meta });
		}

		return new Response("Not found", { status: 404 });
	},
};