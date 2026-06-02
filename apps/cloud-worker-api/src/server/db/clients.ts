import { createClient, type Client } from "@libsql/client/web";

export type DbConfig = { url: string; authToken: string };

export function createDbClient(cfg: DbConfig): Client {
	return createClient({
		url: cfg.url,
		authToken: cfg.authToken,
	});
}