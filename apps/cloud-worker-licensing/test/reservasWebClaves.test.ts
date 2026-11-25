// test/reservasWebClaves.test.ts
//
// Reservas desde la web (docs/estudios/reservas-web.md): la clave pública de cada negocio, contra
// una base central de verdad (`helpers/central.ts`), con el esquema de sus migraciones.

import { beforeEach, describe, expect, it } from "vitest";

import { centralDePrueba, filasDe, type CentralDePrueba } from "./helpers/central";
import {
	CLAVE_RE,
	claveDelNegocio,
	codigoParaLaWeb,
	generarClave,
	negocioDeLaClave,
	olvidarClavesCacheadas,
	origenDelWidget,
} from "../src/domains/reservas_web/claves";

beforeEach(() => olvidarClavesCacheadas());

/** Los negocios `t1` y `t2`, en una base central propia. */
async function conBaseCentral(prueba: (central: CentralDePrueba) => Promise<void>) {
	const central = await centralDePrueba();
	await filasDe(central, `INSERT INTO tenants (tenant_id) VALUES ('t1'), ('t2');`);
	await prueba(central);
}

describe("la clave pública de la reserva web", () => {
	it("es «rw_» y 128 bits aleatorios: no se repite ni se adivina", () => {
		const claves = new Set(Array.from({ length: 200 }, generarClave));
		expect(claves.size).toBe(200);
		for (const c of claves) expect(c).toMatch(CLAVE_RE);
	});

	it("un negocio tiene una sola clave activa aunque la pidan dos a la vez", async () => {
		await conBaseCentral(async (central) => {
			const { db } = central;
			const [a, b] = await Promise.all([claveDelNegocio(db, "t1", 1), claveDelNegocio(db, "t1", 2)]);
			expect(a).toBe(b);
			expect(await claveDelNegocio(db, "t1", 3)).toBe(a);
			expect(
				await filasDe(
					central,
					`SELECT COUNT(*) AS n FROM reserva_web_claves WHERE tenant_id = 't1' AND revoked_at_ms IS NULL;`,
				),
			).toEqual([{ n: 1 }]);
			expect(await claveDelNegocio(db, "t2", 4)).not.toBe(a);
		});
	});

	it("una clave revocada ya no lleva a ningún negocio, y una inventada tampoco", async () => {
		await conBaseCentral(async (central) => {
			const { db } = central;
			const clave = await claveDelNegocio(db, "t1", 1);
			expect(await negocioDeLaClave(db, clave)).toBe("t1");

			await filasDe(central, `UPDATE reserva_web_claves SET revoked_at_ms = 5 WHERE clave = ?;`, clave);
			olvidarClavesCacheadas();
			expect(await negocioDeLaClave(db, clave)).toBeNull();
			expect(await negocioDeLaClave(db, generarClave())).toBeNull();
			expect(await negocioDeLaClave(db, "t1")).toBeNull();
			// Tras revocarla, pedir la clave del negocio da otra nueva.
			const nueva = await claveDelNegocio(db, "t1", 6);
			expect(nueva).not.toBe(clave);
		});
	});

	it("la línea que se pega lleva la clave y el script del mismo origen", () => {
		const codigo = codigoParaLaWeb("https://tpv-api.ejemplo.dev", "rw_AAAAAAAAAAAAAAAAAAAAAA");
		expect(codigo).toContain('data-negocio="rw_AAAAAAAAAAAAAAAAAAAAAA"');
		expect(codigo).toContain('src="https://tpv-api.ejemplo.dev/reservas-web/v1/embed.js"');
	});

	it("el widget se sirve desde su dirección propia aunque la petición llegue por la de la API", () => {
		const desdeLaMain = "https://tpv-api.ejemplo.dev/v1/reservas-web/clave";
		expect(origenDelWidget({ RESERVAS_WEB_ORIGEN: "https://reservas.ejemplo.dev" }, desdeLaMain)).toBe("https://reservas.ejemplo.dev");
		expect(origenDelWidget({ RESERVAS_WEB_ORIGEN: " https://reservas.ejemplo.dev/ " }, desdeLaMain)).toBe("https://reservas.ejemplo.dev");
		// Sin dirección propia (`wrangler dev`), la de la petición.
		expect(origenDelWidget({ RESERVAS_WEB_ORIGEN: "" }, "http://localhost:8787/v1/reservas-web/clave")).toBe("http://localhost:8787");
		expect(origenDelWidget({}, desdeLaMain)).toBe("https://tpv-api.ejemplo.dev");
	});
});
