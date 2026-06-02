// src/server/endpoints/rest/queries/login/loginHashPassword.ts
import type { Client } from "@libsql/client/web";

import { json, serverError } from "../../../../utils/response";
import { hashPinPbkdf2 } from "./pinKdf";

async function readJsonSafe(req: Request): Promise<any> {
    try {
        return await req.json();
    } catch {
        return {};
    }
}

export async function handleLoginHashPassword(
    req: Request,
    _env: any,
    _dbCentral: Client
): Promise<Response> {
    try {
        const body = await readJsonSafe(req);
        const pin = String(body?.pin ?? "").trim();
        if (!pin) return json({ ok: false, error: "pin_required" }, 200, req);

        const hash = await hashPinPbkdf2(pin);
        return json({ ok: true, hash }, 200, req);
    } catch (e: any) {
        return serverError(req, "internal_error", String(e?.message || e));
    }
}