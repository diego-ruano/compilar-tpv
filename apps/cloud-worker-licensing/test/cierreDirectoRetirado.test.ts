// RI-22: una petición autenticada no puede marcar una comanda como pagada sin un cobro.
import { Hono } from "hono";
import { expect, it, vi } from "vitest";

vi.mock("../src/middleware/tenant", () => ({
	tenantAuth: async (_c: unknown, next: () => Promise<void>) => next(),
	soloLaMainCobra: async (_c: unknown, next: () => Promise<void>) => next(),
}));

vi.mock("../src/lib/rutas", async (importOriginal) => ({
	...await importOriginal<typeof import("../src/lib/rutas")>(),
	apply: vi.fn().mockResolvedValue({ ok: true }),
}));

import { mesasRoutes } from "../src/domains/mesas/mesas.routes";
import { apply } from "../src/lib/rutas";

// El router va suelto, con sus dobles: la ruta corre aquí, sin el viaje al TenantHub.
vi.mock("../src/lib/enElHub", () => import("./helpers/rutaSuelta"));

it("el cierre directo devuelve 404 y no aplica ninguna escritura", async () => {
	const app = new Hono().route("/v1/mesas", mesasRoutes);
	const respuesta = await app.request("/v1/mesas/comandas/cerrar", {
		method: "PUT",
		headers: { "Content-Type": "application/json", "X-Idempotency-Key": "cierre-1" },
		body: JSON.stringify({ id_comanda: "comanda-1", total: 600 }),
	});

	expect(respuesta.status).toBe(404);
	expect(apply).not.toHaveBeenCalled();
});
