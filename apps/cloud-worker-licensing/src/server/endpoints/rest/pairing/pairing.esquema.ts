// src/server/endpoints/rest/pairing/pairing.esquema.ts
//
// Las tablas del emparejamiento en el control-plane.
//
// Hasta ahora no estaban declaradas en ningún sitio del repo: se crearon a mano en Turso, y la del
// throttle la creaba el propio handler del claim en cada petición. Se declaran aquí con las columnas
// que usan los endpoints, y se crean si faltan, igual que `ensureLicensingSchema` hace con las de
// licencias. En una base que ya las tenga, `CREATE TABLE IF NOT EXISTS` no cambia nada.
//
// Lo que sigue sin declarar es `devices`: la usan también la autenticación y la revocación, y
// moverla es otro trabajo.

import type { Client } from "@libsql/client/web";

import { exec } from "../../../db";

const PREPARADAS = new WeakSet<Client>();

export async function ensurePairingSchema(db: Client): Promise<void> {
	if (PREPARADAS.has(db)) return;

	// `status`: pending → approved → used, o bien rejected (lo rechaza la Main) o expired.
	await exec(
		db,
		`CREATE TABLE IF NOT EXISTS pair_requests (
			pair_code                 TEXT PRIMARY KEY,
			secret_hash               TEXT,
			tenant_id                 TEXT,
			created_by_device_id      TEXT,
			status                    TEXT,
			created_at_ms             INTEGER,
			expires_at_ms             INTEGER,
			used_at_ms                INTEGER,
			approved_at_ms            INTEGER,
			claimed_at_ms             INTEGER,
			claimed_by_device_id      TEXT,
			claimed_device_pubkey_b64 TEXT,
			claimed_device_name       TEXT,
			attempts                  INTEGER NOT NULL DEFAULT 0,
			last_attempt_at_ms        INTEGER
		);`,
	);
	await exec(db, `CREATE INDEX IF NOT EXISTS ix_pair_requests_tenant ON pair_requests (tenant_id);`);

	// El reto que firma la Handy en cada consulta. Vive lo mismo que el código.
	await exec(
		db,
		`CREATE TABLE IF NOT EXISTS device_challenges (
			device_id     TEXT,
			nonce_b64     TEXT,
			expires_at_ms INTEGER,
			created_at_ms INTEGER,
			used_at_ms    INTEGER
		);`,
	);
	await exec(
		db,
		`CREATE INDEX IF NOT EXISTS ix_device_challenges_device ON device_challenges (device_id, nonce_b64);`,
	);

	// Los fallos de vinculación por IP (ver `pairing.intentos.ts`).
	await exec(
		db,
		`CREATE TABLE IF NOT EXISTS pair_claim_fallos (
			ip                 TEXT PRIMARY KEY,
			fallos             INTEGER NOT NULL,
			ultimo_fallo_ms    INTEGER NOT NULL,
			bloqueado_hasta_ms INTEGER NOT NULL DEFAULT 0
		);`,
	);

	PREPARADAS.add(db);
}
