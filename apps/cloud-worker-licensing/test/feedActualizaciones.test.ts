// test/feedActualizaciones.test.ts
//
// REV-23 — el feed del updater servía la fila más recién INSERTADA, de cualquier arquitectura.
//
// Dos fallos en la misma consulta:
//   · `arch` llegaba en la ruta y no entraba en el WHERE: sólo servía para componer la clave de
//     `platforms`, así que un equipo aarch64 recibía el instalador x86_64 etiquetado como suyo.
//   · el orden era `created_at_ms DESC`, o sea por cuándo se insertó la fila. Casi siempre coincide
//     con «la versión más alta» y por eso no se notaba; deja de coincidir justo cuando duele,
//     porque `publish` era un `INSERT OR REPLACE` y retocar una versión vieja le ponía la fecha de
//     hoy (hoy es un upsert, RI-30, pero la fecha de una fila sigue sin decir qué versión es). El updater no la instalaría —no baja de versión— pero dejaría de ofrecer la buena, y un
//     equipo recién instalado se queda clavado sin que nada lo diga.

//
// Cada caso siembra sus versiones en su propia base central de verdad (`helpers/central.ts`), y la
// ruta llega a ella por `getDb(env)`.

import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";

import { centralDePrueba, filasDe } from "./helpers/central";
import { updatesRoutes, compararVersiones, olvidarLoQueLeeElFeed } from "../src/domains/updates/updates.routes";

type Release = {
	version: string;
	target?: string;
	arch?: string;
	activa?: boolean;
	creada?: number;
};

/** Siembra releases y pide el feed para `target/arch/current`. */
async function feed(
	releases: Release[],
	ruta: { target: string; arch: string; current: string },
): Promise<{ status: number; body: any }> {
	const central = await centralDePrueba();
	for (const r of releases) {
		await filasDe(
			central,
			`INSERT INTO app_releases (version, target, arch, channel, notes, pub_date, signature,
			   url, is_active, created_at_ms)
			 VALUES (?, ?, ?, 'stable', 'notas', '2026-01-01T00:00:00Z', ?, ?, ?, ?);`,
			r.version,
			r.target ?? "windows",
			r.arch ?? "x86_64",
			`sig-${r.version}`,
			`https://cdn.test/${r.version}.exe`,
			r.activa === false ? 0 : 1,
			r.creada ?? 0,
		);
	}

	const app = new Hono();
	app.route("/", updatesRoutes);
	const res = await app.request(`/${ruta.target}/${ruta.arch}/${ruta.current}`, {}, central.entorno);
	return { status: res.status, body: res.status === 204 ? null : await res.json() };
}

beforeEach(() => {
	// Cada caso siembra sus versiones: lo que el feed se guardó en el caso anterior no vale.
	olvidarLoQueLeeElFeed();
});

describe("REV-23 · qué versión sirve el feed", () => {
	it("la versión más ALTA, no la insertada más tarde", async () => {
		// Una fila de la 1.2.0 más reciente que la de la 1.10.0 (lo que hacía retocarla con el viejo
		// INSERT OR REPLACE).
		// Con el orden por fecha, ésa pasaba a ser «la última» y la 1.10.0 dejaba de ofrecerse.
		const { body } = await feed(
			[
				{ version: "1.10.0", creada: 100 },
				{ version: "1.2.0", creada: 999 },
			],
			{ target: "windows", arch: "x86_64", current: "1.0.0" },
		);

		expect(body.version).toBe("1.10.0");
		expect(body.platforms["windows-x86_64"].signature).toBe("sig-1.10.0");
	});

	it("una versión desactivada no se sirve, y vuelve la anterior", async () => {
		// El rollback instantáneo, que es el motivo de servir el feed nosotros.
		const { body } = await feed(
			[
				{ version: "1.3.0", activa: false },
				{ version: "1.2.0" },
			],
			{ target: "windows", arch: "x86_64", current: "1.0.0" },
		);

		expect(body.version).toBe("1.2.0");
	});

	it("cada arquitectura recibe la suya", async () => {
		const { body } = await feed(
			[
				{ version: "2.0.0", arch: "x86_64" },
				{ version: "1.9.0", arch: "aarch64" },
			],
			{ target: "windows", arch: "aarch64", current: "1.0.0" },
		);

		// Sin filtrar por arch se servía la 2.0.0 (x86_64) etiquetada como `windows-aarch64`.
		expect(body.version).toBe("1.9.0");
		expect(body.platforms["windows-aarch64"].url).toBe("https://cdn.test/1.9.0.exe");
	});

	it("sin release para esa arquitectura contesta 204, no la de otra", async () => {
		const { status } = await feed([{ version: "2.0.0", arch: "x86_64" }], {
			target: "windows",
			arch: "aarch64",
			current: "1.0.0",
		});

		expect(status).toBe(204);
	});

	it("sin ninguna release contesta 204", async () => {
		const { status } = await feed([], {
			target: "windows",
			arch: "x86_64",
			current: "1.0.0",
		});

		expect(status).toBe(204);
	});
});

describe("REV-23 · comparación de versiones", () => {
	it("compara por número y no por texto", () => {
		// El caso que rompe un ORDER BY alfabético: "1.10.0" < "1.9.0" como cadena.
		expect(compararVersiones("1.10.0", "1.9.0")).toBeGreaterThan(0);
		expect(compararVersiones("2.0.0", "1.99.99")).toBeGreaterThan(0);
		expect(compararVersiones("1.2.3", "1.2.3")).toBe(0);
	});

	it("una preliberación es anterior a su versión final", () => {
		expect(compararVersiones("1.2.0", "1.2.0-beta.1")).toBeGreaterThan(0);
		expect(compararVersiones("1.2.0-beta.2", "1.2.0-beta.1")).toBeGreaterThan(0);
	});

	it("una versión con menos tramos no gana por serlo", () => {
		expect(compararVersiones("1.2", "1.2.1")).toBeLessThan(0);
		expect(compararVersiones("1.2", "1.2.0")).toBe(0);
	});
});
