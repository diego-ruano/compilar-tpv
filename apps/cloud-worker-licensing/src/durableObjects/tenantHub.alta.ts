// src/durableObjects/tenantHub.alta.ts
//
// Con qué nace la base de un negocio además de su esquema: su administrador inicial.
//
// Lo siembra el propio DO al aprovisionar (`MotorTenantHub.aprovisionar`), con su SQLite al lado:
// desde fuera del DO no hay ninguna puerta que acepte SQL.
//
// No pasa por el motor de escrituras, y es a propósito: la Main siembra el mismo administrador en
// su base, con el mismo id, así que no es un cambio que replicar. Lo que sí se replica es el PIN que
// se elige después en la Main, que sube por su outbox con `Requiere_Setup = 0` (AUD-24).

import { hashPin } from "../domains/login/login.crypto";

/**
 * UUID FIJO: debe coincidir con el admin que siembra la Main (`ADMIN_USUARIO_ID` en
 * `crates/tpv-infra-sqlite/src/util.rs`). Si difiere, la Handy referencia un admin que la Main no
 * tiene y los fichajes y las comandas revientan con FOREIGN KEY al sincronizar.
 */
const ADMIN_USUARIO_ID = "00000000-0000-7000-8000-000000000501";

/** El PIN de la siembra. Es público: con `Requiere_Setup = 1` la nube no deja entrar con él. */
const PIN_DE_LA_SIEMBRA = "1234";

function sinUsuarios(sql: SqlStorage): boolean {
	return Number((sql.exec("SELECT COUNT(*) AS n FROM Usuarios;").one() as { n: number }).n) === 0;
}

/**
 * Crea el administrador inicial si la base no tiene ningún usuario. Los roles ya los siembra el
 * esquema con sus UUIDv7 fijos.
 *
 * Mirar que no hay usuarios, buscar el rol e insertar van en una transacción. El hash se calcula
 * antes (es una espera, y son 100.000 vueltas de PBKDF2), así que dentro se vuelve a mirar: dos
 * altas a la vez del mismo negocio dejan un administrador, no dos intentos de crearlo.
 */
export async function sembrarAdminInicial(storage: DurableObjectStorage): Promise<void> {
	const sql = storage.sql;
	if (!sinUsuarios(sql)) return;

	const hash = await hashPin(PIN_DE_LA_SIEMBRA);

	storage.transactionSync(() => {
		if (!sinUsuarios(sql)) return;
		const rol = sql
			.exec("SELECT ID_Rol AS id FROM Roles WHERE Nombre_Rol = 'Administrador' LIMIT 1;")
			.toArray()[0] as { id?: string } | undefined;
		if (!rol?.id) throw new Error("initial_admin_role_missing");
		sql.exec(
			`INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre, Apellido, Estado, Requiere_Setup)
			 VALUES (?1, ?2, 'admin@local', ?3, 'Admin', 'TPV', 'Activo', 1);`,
			ADMIN_USUARIO_ID,
			rol.id,
			hash,
		);
	});
}
