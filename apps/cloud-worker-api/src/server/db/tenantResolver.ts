// src/server/db/getTenantDbInfo.ts
import type { Client } from "@libsql/client/web";
import { aesGcmDecryptFromB64 } from "../utils/crypto";

export type TenantDbInfo = {
	tenantId: string;
	tursoUrl: string;
	tursoAuthToken: string;
};

export async function getTenantDbInfo(
	dbCentral: Client,
	licenseStoreKeyB64: string,
	tenantId: string
): Promise<TenantDbInfo | null> {
	const r = await dbCentral.execute({
		sql: `
      SELECT tenant_id, turso_url, turso_auth_token_enc
      FROM tenant_databases
      WHERE tenant_id = ?
      LIMIT 1
    `,
		args: [tenantId],
	});

	const row = r.rows?.[0] as any | undefined;
	if (!row) return null;

	const tursoUrl = String(row.turso_url || "").trim();
	const enc = String(row.turso_auth_token_enc || "").trim();
	if (!tursoUrl || !enc) return null;

	const tursoAuthToken = await aesGcmDecryptFromB64(String(licenseStoreKeyB64 || ""), enc);

	return { tenantId, tursoUrl, tursoAuthToken };
}