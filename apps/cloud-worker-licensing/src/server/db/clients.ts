import { createClient, type Client } from "@libsql/client/web";

export type DbConfig = {
	url: string;
	authToken: string;
};

/** Un cliente de la base central (Turso). La base de cada negocio es el SQLite de su TenantHub. */
export function createDbClient(cfg: DbConfig): Client {
	return createClient({ url: cfg.url, authToken: cfg.authToken });
}
