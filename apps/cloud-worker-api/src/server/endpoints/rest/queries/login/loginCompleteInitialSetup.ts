import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../../middleware/withTenant";
import { createDbClient } from "../../../../db/clients";
import { json, unauthorized, serverError } from "../../../../utils/response";
import {
    applyTenantHubTransaction,
    buildCommandCloudPayload,
    getDeviceIdFromContext,
    readWriteRequest,
} from "../../../../utils/tenantHubWrites";

import {
    verifyPinPbkdf2,
    validateEmailBasic,
    PBKDF2_PREFIX,
    DEFAULT_ITERS,
} from "./pinKdf";

const COMMAND_NAME = "login.completeInitialSetup";
const COMMAND_ALIASES = [
    COMMAND_NAME,
    "login.complete_initial_setup",
    "login.completeSetup",
];

const ENC = new TextEncoder();

type CompleteInitialSetupInput = {
    op_id?: string;
    opId?: string;
    command_name?: string;
    commandName?: string;

    idUsuario?: number;
    id_usuario?: number;
    pinActual?: string;
    pin_actual?: string;
    pinNuevo?: string;
    pin_nuevo?: string;
    emailNuevo?: string;
    email_nuevo?: string;
};

function s(v: any): string {
    return String(v ?? "").trim();
}

function pickFirstString(...values: any[]): string {
    for (const value of values) {
        const out = s(value);
        if (out) return out;
    }

    return "";
}

function pickFirstNumber(...values: any[]): number {
    for (const value of values) {
        const n = Number(value);
        if (Number.isFinite(n)) return Math.trunc(n);
    }

    return 0;
}

function getHeaderOpId(req: Request): string {
    return s(req.headers.get("X-Idempotency-Key"));
}

function getHeaderCommandName(req: Request): string {
    return s(req.headers.get("X-Command-Name"));
}

function getRawBodyOpId(rawBody: any): string {
    return s(rawBody?.op_id ?? rawBody?.opId);
}

function getRawBodyCommandName(rawBody: any): string {
    return s(rawBody?.command_name ?? rawBody?.commandName);
}

function assertCommandNameAllowed(commandName: string): boolean {
    return COMMAND_ALIASES.includes(commandName);
}

function b64encode(u8: Uint8Array): string {
    let out = "";
    for (let i = 0; i < u8.length; i++) {
        out += String.fromCharCode(u8[i]);
    }
    return btoa(out);
}

function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
    const ab = new ArrayBuffer(u8.byteLength);
    new Uint8Array(ab).set(u8);
    return ab;
}

async function sha256Bytes(text: string): Promise<Uint8Array> {
    const digest = await crypto.subtle.digest(
        "SHA-256",
        toArrayBuffer(ENC.encode(text)),
    );

    return new Uint8Array(digest);
}

async function pbkdf2Derive(
    pin: string,
    salt: Uint8Array,
    iterations: number,
    dkLen: number,
): Promise<Uint8Array> {
    const key = await crypto.subtle.importKey(
        "raw",
        toArrayBuffer(ENC.encode(pin)),
        { name: "PBKDF2" },
        false,
        ["deriveBits"],
    );

    const bits = await crypto.subtle.deriveBits(
        {
            name: "PBKDF2",
            salt: toArrayBuffer(salt),
            iterations,
            hash: "SHA-256",
        },
        key,
        dkLen * 8,
    );

    return new Uint8Array(bits);
}

/**
 * Hash estable por opId para que un retry con el mismo opId reconstruya
 * exactamente el mismo payload idempotente.
 */
async function hashPinPbkdf2ForOp(input: {
    pin: string;
    tenantId: string;
    idUsuario: number;
    opId: string;
    iterations?: number;
}): Promise<string> {
    const pin = s(input.pin);

    if (pin.length < 4) {
        throw new Error("PIN demasiado corto");
    }

    const iterations = input.iterations ?? DEFAULT_ITERS;

    const seed = [
        COMMAND_NAME,
        input.tenantId,
        String(input.idUsuario),
        input.opId,
    ].join(":");

    const digest = await sha256Bytes(seed);
    const salt = digest.slice(0, 16);
    const dk = await pbkdf2Derive(pin, salt, iterations, 32);

    return `${PBKDF2_PREFIX}i=${iterations}$${b64encode(salt)}$${b64encode(dk)}`;
}

export async function handleLoginCompleteInitialSetup(
    req: Request,
    env: any,
    dbCentral: Client,
): Promise<Response> {
    try {
        const {
            rawBody,
            input: body,
            opId: bodyOpId,
        } = await readWriteRequest<CompleteInitialSetupInput>(req, {
            idUsuario: 0,
            id_usuario: 0,
            pinActual: "",
            pin_actual: "",
            pinNuevo: "",
            pin_nuevo: "",
            emailNuevo: "",
            email_nuevo: "",
        });

        const headerOpId = getHeaderOpId(req);
        const rawBodyOpId = getRawBodyOpId(rawBody);

        if (headerOpId && rawBodyOpId && headerOpId !== rawBodyOpId) {
            return json({ ok: false, error: "op_id_mismatch" }, 409, req);
        }

        const opId = pickFirstString(bodyOpId, headerOpId, rawBodyOpId);

        if (!opId) {
            return json({ ok: false, error: "missing_op_id" }, 400, req);
        }

        const headerCommandName = getHeaderCommandName(req);
        const rawBodyCommandName = getRawBodyCommandName(rawBody);

        if (headerCommandName && !assertCommandNameAllowed(headerCommandName)) {
            return json(
                {
                    ok: false,
                    error: "bad_command_name",
                    expected: COMMAND_NAME,
                    got: headerCommandName,
                },
                409,
                req,
            );
        }

        if (rawBodyCommandName && !assertCommandNameAllowed(rawBodyCommandName)) {
            return json(
                {
                    ok: false,
                    error: "bad_command_name",
                    expected: COMMAND_NAME,
                    got: rawBodyCommandName,
                },
                409,
                req,
            );
        }

        const ctx: any = await buildTenantContext(
            req,
            env,
            dbCentral,
            createDbClient,
        );

        const db: Client = (ctx.dbTenant ?? ctx.db) as Client;
        const tenantId = s(ctx?.claims?.tenantId);

        if (!tenantId) {
            return unauthorized(req, "invalid_token_claims");
        }

        if (!db) {
            throw new Error("tenant_db_missing");
        }

        const idUsuario = pickFirstNumber(body?.idUsuario, body?.id_usuario);
        const pinActual = pickFirstString(body?.pinActual, body?.pin_actual);
        const pinNuevo = pickFirstString(body?.pinNuevo, body?.pin_nuevo);
        const emailNuevo = pickFirstString(body?.emailNuevo, body?.email_nuevo);

        if (idUsuario <= 0) {
            return json({ ok: false, error: "ID_Usuario inválido" }, 200, req);
        }

        if (pinNuevo.length < 4) {
            return json(
                {
                    ok: false,
                    error: "El PIN nuevo debe tener al menos 4 dígitos",
                },
                200,
                req,
            );
        }

        if (!validateEmailBasic(emailNuevo)) {
            return json({ ok: false, error: "Email inválido" }, 200, req);
        }

        const r = await db.execute({
            sql: `
				SELECT
					Password_Hash AS password_hash,
					Requiere_Setup AS requiere_setup
				FROM Usuarios
				WHERE ID_Usuario = ?1
				  AND Estado = 'Activo'
				LIMIT 1;
			`,
            args: [idUsuario],
        });

        const row: any = r.rows?.[0];

        if (!row) {
            return json({ ok: false, error: "Usuario no encontrado" }, 200, req);
        }

        const storedHash = String(row.password_hash ?? "");
        const requiereSetup = Number(row.requiere_setup ?? 0) | 0;

        if (requiereSetup === 0) {
            return json({ ok: true, data: "OK", result: "OK" }, 200, req);
        }

        await verifyPinPbkdf2(pinActual, storedHash);

        const chk = await db.execute({
            sql: `
				SELECT COUNT(*) AS n
				FROM Usuarios
				WHERE Email = ?1
				  AND ID_Usuario <> ?2;
			`,
            args: [emailNuevo, idUsuario],
        });

        const n = Number((chk.rows?.[0] as any)?.n ?? 0) | 0;

        if (n > 0) {
            return json({ ok: false, error: "Ese email ya está en uso" }, 200, req);
        }

        const newHash = await hashPinPbkdf2ForOp({
            pin: pinNuevo,
            tenantId,
            idUsuario,
            opId,
        });

        const requestArgs = {
            id_usuario: idUsuario,
            pin_actual: pinActual,
            pin_nuevo: pinNuevo,
            email_nuevo: emailNuevo,
        };

        const cloudArgs = {
            id_usuario: idUsuario,
            email_nuevo: emailNuevo,
            password_hash: newHash,
        };

        await applyTenantHubTransaction<number>({
            env,
            tenantId,
            opId,
            commandName: COMMAND_NAME,
            deviceId: getDeviceIdFromContext(ctx),

            requestPayload: requestArgs,
            cloudPayload: buildCommandCloudPayload({
                opId,
                commandName: COMMAND_NAME,
                args: cloudArgs,
            }),

            beginMode: "immediate",
            steps: [
                {
                    kind: "execute",
                    saveAs: "affected",
                    sql: `
						UPDATE Usuarios
						SET
							Email = ?2,
							Password_Hash = ?3,
							Requiere_Setup = 0
						WHERE ID_Usuario = ?1
						  AND Requiere_Setup = 1;
					`,
                    args: [idUsuario, emailNuevo, newHash],
                },
                {
                    kind: "value",
                    saveAs: "ok_value",
                    sql: `SELECT 1;`,
                    args: [],
                },
            ],
            resultKey: "ok_value",
        });

        return json({ ok: true, data: "OK", result: "OK" }, 200, req);
    } catch (e: any) {
        return serverError(req, "internal_error", String(e?.message || e));
    }
}