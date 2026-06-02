import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../../middleware/withTenant";
import { createDbClient } from "../../../../db/clients";
import { json, serverError, unauthorized } from "../../../../utils/response";
import {
	applyTenantHubTransaction,
	getDeviceIdFromContext,
	readWriteRequest,
	sqlRef,
	type TxStep,
} from "../../../../utils/tenantHubWrites";

type TrabajadorUpdateInput = {
	idTrabajador?: number;
	id_trabajador?: number;
	idUsuario?: number;
	id_usuario?: number;

	nombre?: string;
	apellido?: string | null;
	email?: string;
	estado?: string | null;

	idRol?: number;
	id_rol?: number;
	nombreRol?: string;
	nombre_rol?: string;
	rol?: string;

	telefono?: string | null;
	puesto?: string | null;
	dni?: string | null;
	iban?: string | null;

	numeroSeguridadSocial?: string | null;
	numero_seguridad_social?: string | null;

	fechaInicioContrato?: string | null;
	fecha_inicio_contrato?: string | null;

	fechaFinContrato?: string | null;
	fecha_fin_contrato?: string | null;

	passwordHash?: string | null;
	password_hash?: string | null;
	hashPassword?: string | null;
	hash_hash?: string | null;
	hash_password?: string | null;
	password?: string | null;

	requiereSetup?: boolean | number | string | null;
	requiere_setup?: boolean | number | string | null;
};

const COMMAND_NAME = "trabajadores.update";

function hasOwn(obj: any, key: string): boolean {
	return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

function hasAnyOwn(obj: any, keys: string[]): boolean {
	return keys.some((k) => hasOwn(obj, k));
}

function trimOrNull(v: unknown): string | null {
	const s = String(v ?? "").trim();
	return s ? s : null;
}

function trimOrEmpty(v: unknown): string {
	return String(v ?? "").trim();
}

function normalizeBoolToInt(value: unknown, fallback = false): number {
	if (typeof value === "boolean") return value ? 1 : 0;
	if (typeof value === "number") return value !== 0 ? 1 : 0;

	const s = String(value ?? "").trim().toLowerCase();
	if (!s) return fallback ? 1 : 0;

	if (["1", "true", "yes", "y", "si", "sí"].includes(s)) return 1;
	if (["0", "false", "no", "n"].includes(s)) return 0;

	return fallback ? 1 : 0;
}

function assertSql(errorLabel: string): string {
	return `json_extract('${errorLabel}', '$')`;
}

function buildUpdateSql(
	tableName: string,
	updates: Array<{ column: string; value: any }>,
	whereColumn: string,
	whereValue: any,
): { sql: string; args: any[] } | null {
	if (updates.length === 0) return null;

	const sets = updates.map((u, i) => `${u.column} = ?${i + 1}`).join(", ");

	const sql = `
		UPDATE ${tableName}
		SET ${sets}
		WHERE ${whereColumn} = ?${updates.length + 1};
	`;

	const args = updates.map((u) => u.value);
	args.push(whereValue);

	return { sql, args };
}

export async function handleTrabajadoresUpdate(
	req: Request,
	env: any,
	dbCentral: Client,
): Promise<Response> {
	try {
		const ctx: any = await buildTenantContext(
			req,
			env,
			dbCentral,
			createDbClient,
		);

		const tenantId = String(ctx?.claims?.tenantId || "").trim();
		if (!tenantId) {
			return unauthorized(req, "invalid_token_claims");
		}

		const { input: payload, opId } =
			await readWriteRequest<TrabajadorUpdateInput>(req, {});

		if (!opId) {
			return json({ ok: false, error: "missing_op_id" }, 400, req);
		}

		const idTrabajador = Number(
			payload?.idTrabajador ?? payload?.id_trabajador ?? 0,
		);

		const idUsuarioIn = Number(payload?.idUsuario ?? payload?.id_usuario ?? 0);

		if (!(idTrabajador > 0) && !(idUsuarioIn > 0)) {
			return json(false, 200, req);
		}

		const emailProvided = hasOwn(payload, "email");
		const nombreProvided = hasOwn(payload, "nombre");
		const apellidoProvided = hasOwn(payload, "apellido");
		const estadoProvided = hasOwn(payload, "estado");

		const roleProvided = hasAnyOwn(payload, [
			"idRol",
			"id_rol",
			"nombreRol",
			"nombre_rol",
			"rol",
		]);

		const requiereSetupProvided = hasAnyOwn(payload, [
			"requiereSetup",
			"requiere_setup",
		]);

		const telefonoProvided = hasOwn(payload, "telefono");
		const puestoProvided = hasOwn(payload, "puesto");
		const dniProvided = hasOwn(payload, "dni");
		const ibanProvided = hasOwn(payload, "iban");

		const numeroSsProvided = hasAnyOwn(payload, [
			"numeroSeguridadSocial",
			"numero_seguridad_social",
		]);

		const fechaInicioProvided = hasAnyOwn(payload, [
			"fechaInicioContrato",
			"fecha_inicio_contrato",
		]);

		const fechaFinProvided = hasAnyOwn(payload, [
			"fechaFinContrato",
			"fecha_fin_contrato",
		]);

		const hashProvided =
			hasOwn(payload, "passwordHash") ||
			hasOwn(payload, "password_hash") ||
			hasOwn(payload, "hashPassword") ||
			hasOwn(payload, "hash_password") ||
			hasOwn(payload, "password");

		const passwordHash =
			trimOrNull(payload?.passwordHash) ??
			trimOrNull(payload?.password_hash) ??
			trimOrNull(payload?.hashPassword) ??
			trimOrNull(payload?.hash_password) ??
			trimOrNull(payload?.password);

		if (hashProvided && !passwordHash) {
			return json({ ok: false, error: "password_hash_required" }, 400, req);
		}

		const email = trimOrEmpty(payload?.email);
		if (emailProvided && !email) {
			return json({ ok: false, error: "email_required" }, 400, req);
		}

		const nombre = trimOrEmpty(payload?.nombre);
		if (nombreProvided && !nombre) {
			return json({ ok: false, error: "nombre_required" }, 400, req);
		}

		const idRolInput = Number(payload?.idRol ?? payload?.id_rol ?? 0);
		const idRol =
			Number.isFinite(idRolInput) && idRolInput > 0 ? idRolInput : 0;

		const roleName =
			trimOrNull(payload?.nombreRol) ??
			trimOrNull(payload?.nombre_rol) ??
			trimOrNull(payload?.rol);

		const dni = trimOrNull(payload?.dni);
		const numeroSeguridadSocial = trimOrNull(
			payload?.numeroSeguridadSocial ?? payload?.numero_seguridad_social,
		);

		const steps: TxStep[] = [
			{
				kind: "value",
				saveAs: "target_id_trabajador",
				sql: `
					SELECT ID_Trabajador
					FROM Trabajadores
					WHERE (?1 > 0 AND ID_Trabajador = ?1)
					   OR (?2 > 0 AND ID_Usuario = ?2)
					ORDER BY CASE
						WHEN ?1 > 0 AND ID_Trabajador = ?1 THEN 0
						ELSE 1
					END
					LIMIT 1;
				`,
				args: [idTrabajador, idUsuarioIn],
			},
			{
				kind: "value",
				saveAs: "target_id_usuario",
				sql: `
					SELECT ID_Usuario
					FROM Trabajadores
					WHERE ID_Trabajador = ?1
					LIMIT 1;
				`,
				args: [sqlRef("target_id_trabajador")],
			},
			{
				kind: "value",
				saveAs: "assert_target_exists",
				sql: `
					SELECT CASE
						WHEN COALESCE(?1, 0) <= 0 OR COALESCE(?2, 0) <= 0
						THEN ${assertSql("trabajador_not_found")}
						ELSE 1
					END;
				`,
				args: [sqlRef("target_id_trabajador"), sqlRef("target_id_usuario")],
			},
		];

		if (emailProvided) {
			steps.push({
				kind: "value",
				saveAs: "assert_email_unique",
				sql: `
					SELECT CASE
						WHEN EXISTS (
							SELECT 1
							FROM Usuarios
							WHERE lower(Email) = lower(?1)
							  AND ID_Usuario <> ?2
							LIMIT 1
						)
						THEN ${assertSql("email_already_exists")}
						ELSE 1
					END;
				`,
				args: [email, sqlRef("target_id_usuario")],
			});
		}

		if (dniProvided && dni) {
			steps.push({
				kind: "value",
				saveAs: "assert_dni_unique",
				sql: `
					SELECT CASE
						WHEN EXISTS (
							SELECT 1
							FROM Trabajadores
							WHERE lower(DNI) = lower(?1)
							  AND ID_Trabajador <> ?2
							LIMIT 1
						)
						THEN ${assertSql("dni_already_exists")}
						ELSE 1
					END;
				`,
				args: [dni, sqlRef("target_id_trabajador")],
			});
		}

		if (numeroSsProvided && numeroSeguridadSocial) {
			steps.push({
				kind: "value",
				saveAs: "assert_numero_ss_unique",
				sql: `
					SELECT CASE
						WHEN EXISTS (
							SELECT 1
							FROM Trabajadores
							WHERE lower(Numero_Seguridad_Social) = lower(?1)
							  AND ID_Trabajador <> ?2
							LIMIT 1
						)
						THEN ${assertSql("numero_seguridad_social_already_exists")}
						ELSE 1
					END;
				`,
				args: [numeroSeguridadSocial, sqlRef("target_id_trabajador")],
			});
		}

		if (roleProvided) {
			steps.push(
				{
					kind: "value",
					saveAs: "id_rol_final",
					sql: `
						SELECT COALESCE(
							NULLIF(?1, 0),
							(
								SELECT ID_Rol
								FROM Roles
								WHERE ?2 IS NOT NULL
								  AND TRIM(?2) <> ''
								  AND lower(Nombre_Rol) = lower(?2)
								LIMIT 1
							)
						);
					`,
					args: [idRol, roleName],
				},
				{
					kind: "value",
					saveAs: "assert_role_found",
					sql: `
						SELECT CASE
							WHEN COALESCE(?1, 0) <= 0
							THEN ${assertSql("role_not_found")}
							ELSE 1
						END;
					`,
					args: [sqlRef("id_rol_final")],
				},
			);
		}

		const userUpdates: Array<{ column: string; value: any }> = [];

		if (nombreProvided) {
			userUpdates.push({ column: "Nombre", value: nombre });
		}

		if (apellidoProvided) {
			userUpdates.push({
				column: "Apellido",
				value: trimOrNull(payload?.apellido),
			});
		}

		if (emailProvided) {
			userUpdates.push({ column: "Email", value: email });
		}

		if (estadoProvided) {
			userUpdates.push({
				column: "Estado",
				value: trimOrNull(payload?.estado) || "Activo",
			});
		}

		if (roleProvided) {
			userUpdates.push({ column: "ID_Rol", value: sqlRef("id_rol_final") });
		}

		if (hashProvided) {
			userUpdates.push({ column: "Password_Hash", value: passwordHash });
		}

		if (requiereSetupProvided) {
			userUpdates.push({
				column: "Requiere_Setup",
				value: normalizeBoolToInt(
					payload?.requiereSetup ?? payload?.requiere_setup,
					false,
				),
			});
		}

		const trabajadorUpdates: Array<{ column: string; value: any }> = [];

		if (telefonoProvided) {
			trabajadorUpdates.push({
				column: "Telefono",
				value: trimOrNull(payload?.telefono),
			});
		}

		if (puestoProvided) {
			trabajadorUpdates.push({
				column: "Puesto",
				value: trimOrNull(payload?.puesto),
			});
		}

		if (dniProvided) {
			trabajadorUpdates.push({
				column: "DNI",
				value: dni,
			});
		}

		if (ibanProvided) {
			trabajadorUpdates.push({
				column: "IBAN",
				value: trimOrNull(payload?.iban),
			});
		}

		if (numeroSsProvided) {
			trabajadorUpdates.push({
				column: "Numero_Seguridad_Social",
				value: numeroSeguridadSocial,
			});
		}

		if (fechaInicioProvided) {
			trabajadorUpdates.push({
				column: "Fecha_Inicio_Contrato",
				value: trimOrNull(
					payload?.fechaInicioContrato ?? payload?.fecha_inicio_contrato,
				),
			});
		}

		if (fechaFinProvided) {
			trabajadorUpdates.push({
				column: "Fecha_Fin_Contrato",
				value: trimOrNull(
					payload?.fechaFinContrato ?? payload?.fecha_fin_contrato,
				),
			});
		}

		const userUpdateStmt = buildUpdateSql(
			"Usuarios",
			userUpdates,
			"ID_Usuario",
			sqlRef("target_id_usuario"),
		);

		const trabajadorUpdateStmt = buildUpdateSql(
			"Trabajadores",
			trabajadorUpdates,
			"ID_Trabajador",
			sqlRef("target_id_trabajador"),
		);

		if (userUpdateStmt) {
			steps.push({
				kind: "execute",
				sql: userUpdateStmt.sql,
				args: userUpdateStmt.args,
			});
		}

		if (trabajadorUpdateStmt) {
			steps.push({
				kind: "execute",
				sql: trabajadorUpdateStmt.sql,
				args: trabajadorUpdateStmt.args,
			});
		}

		steps.push({
			kind: "value",
			saveAs: "ok_value",
			sql: `SELECT 1;`,
			args: [],
		});

		await applyTenantHubTransaction<number>({
			env,
			tenantId,
			opId,
			commandName: COMMAND_NAME,
			deviceId: getDeviceIdFromContext(ctx),
			beginMode: "immediate",
			steps,
			resultKey: "ok_value",
		});

		return json(true, 200, req);
	} catch (e: any) {
		return serverError(req, "internal_error", {
			message: String(e?.message || e),
			name: e?.name,
			stack: e?.stack,
		});
	}
}