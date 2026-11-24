// test/plazoDeLaBaseCentral.test.ts
//
// El plazo de una petición a la base central (`fetchConPlazo`, `server/db/clients.ts`).
//
// El `TenantHub` pregunta a la base central quién es la Main delante de una escritura o dentro del
// turno del log (AUD-02, `mainEnCentral`). Una petición que no vuelve lo retendría sin límite, así
// que esa lectura lleva plazo: vencido, se aborta y sale como un fallo de transporte más. Que el DO
// la pide con plazo lo fija `mainDesplazadaSocket.test.ts`; aquí, lo que hace el plazo.

import { describe, it, expect } from "vitest";
import { createClient } from "@libsql/client/web";

import { createDbClient, fetchConPlazo } from "../src/server/db/clients";

describe("el plazo de una petición a la base central", () => {
	/** Un `fetch` que no vuelve nunca, salvo que lo aborten. */
	const colgado = (_p: Request, init?: RequestInit) =>
		new Promise<Response>((_, rechazar) =>
			init?.signal?.addEventListener("abort", () => rechazar(init.signal!.reason)),
		);

	it("una petición que no vuelve se corta al vencer el plazo", async () => {
		const f = fetchConPlazo(30, colgado);
		const inicio = Date.now();
		await expect(f(new Request("https://base-central.invalid/v2/pipeline", { method: "POST" }))).rejects.toThrow(
			"timeout",
		);
		expect(Date.now() - inicio).toBeLessThan(2_000);
	});

	it("el plazo cubre también un cuerpo que se cuelga después de las cabeceras", async () => {
		const cabecerasYNada = (_p: Request, init?: RequestInit) => {
			const cuerpo = new ReadableStream<Uint8Array>({
				start(c) {
					c.enqueue(new TextEncoder().encode('{"a":'));
					init?.signal?.addEventListener("abort", () => c.error(init.signal!.reason));
				},
			});
			return Promise.resolve(new Response(cuerpo));
		};
		const f = fetchConPlazo(30, cabecerasYNada);
		const r = await f(new Request("https://base-central.invalid/"));
		await expect(r.text()).rejects.toThrow("timeout");
	});

	it("lo que vuelve a tiempo pasa tal cual, y la señal de quien llama sigue valiendo", async () => {
		const f = fetchConPlazo(1_000, async () => new Response("ok"));
		expect(await (await f(new Request("https://base-central.invalid/"))).text()).toBe("ok");

		const propia = new AbortController();
		const g = fetchConPlazo(60_000, colgado);
		const pendiente = g(new Request("https://base-central.invalid/"), { signal: propia.signal });
		propia.abort(new Error("cancelada"));
		await expect(pendiente).rejects.toThrow("cancelada");
	});

	it("el cliente de libsql lo usa: una petición colgada sale como error, no se queda esperando", async () => {
		const db = createClient({
			url: "https://base-central.invalid",
			authToken: "x",
			fetch: fetchConPlazo(30, colgado),
		});
		const inicio = Date.now();
		await expect(db.execute("SELECT 1;")).rejects.toThrow();
		expect(Date.now() - inicio).toBeLessThan(2_000);
		db.close();
	});

	it("createDbClient lo pone cuando se le pide plazo", async () => {
		const fetchDeVerdad = globalThis.fetch;
		(globalThis as any).fetch = colgado;
		try {
			const db = createDbClient({ url: "https://base-central.invalid", authToken: "x", plazoMs: 30 });
			const inicio = Date.now();
			await expect(db.execute("SELECT 1;")).rejects.toThrow();
			expect(Date.now() - inicio).toBeLessThan(2_000);
		} finally {
			(globalThis as any).fetch = fetchDeVerdad;
		}
	});
});
