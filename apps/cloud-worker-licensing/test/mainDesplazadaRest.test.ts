// test/mainDesplazadaRest.test.ts
//
// AUD-02 · La Main que deja de serlo deja de entrar también por REST.
//
// El Worker comprueba la licencia en `tenantAuth` (`lib/licenciaEnUso.ts`) y guarda la respuesta un
// minuto por isolate: durante ese minuto, el equipo al que se le ha trasladado o anulado la licencia
// seguía entrando en las rutas. Las rutas de negocio se ejecutan dentro del TenantHub, que sabe
// quién es la Main (`_Main_Vigente`) y se pone al día en el acto con el aviso del cambio
// (`releerMain`): ahí se le para (`MotorTenantHub.vetoDeMain`).
//
// Por la `app` entera y el RPC de verdad (`ejecutarRuta`), con la caché del Worker dando todavía por
// bueno al equipo anterior:
//
//   · la Main desplazada recibe `device_replaced`, el mismo identificador que da el Worker, en
//     cualquier ruta y no sólo en las que son de la Main, y la ruta no se ejecuta;
//   · con la licencia anulada, `license_revoked`;
//   · la Main de verdad pasa sin que el hub pregunte nada a la base central, también si la tabla no
//     se ha leído nunca;
//   · si la tabla está atrasada (el aviso del traslado se perdió), el hub pregunta a la base central
//     antes de rechazar, y la Main nueva entra;
//   · si la base central no contesta a esa pregunta, 503 `main_sin_comprobar`: ni entra ni se le
//     dice que ha sido sustituida;
//   · una Handy no pasa por esta comprobación;
//   · las pocas rutas de la Main que se ejecutan en el Worker (emparejar, dispositivos, reservas de
//     la web, el PDF de las facturas) miran la licencia sin la caché (`soloLaMainVigente`), y ningún router con rutas de la
//     Main fuera del hub se queda sin hacerlo.
//
// El Worker y el hub preguntan a la misma base central de verdad, la del negocio
// (`helpers/negocioFirmado.ts`): las preguntas del hub se cuentan en lo que ésta ha recibido, y una
// central que no contesta se provoca en su stub.

import { env as entorno } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { enElHub } from "./helpers/hub";
import { HANDY, MAIN, conNegocioFirmado, pedirFirmado, peticionFirmada, viajes, type Negocio } from "./helpers/negocioFirmado";
import type { SentenciaEnlazada } from "../src/durableObjects/baseCentral.rpc";
import { mainVigente } from "../src/durableObjects/tenantHub.main";
import { app } from "../src/app";
import { firmarSesion } from "../src/lib/sesion";
import { olvidarLicenciasCacheadas } from "../src/lib/licenciaEnUso";

const env = entorno as any;
const deps = { firmarSesion, olvidarLicenciasCacheadas };

/** La pregunta del hub a la base central: quién es la Main de la licencia (`mainDeLaLicencia`). */
const PIDE_LA_MAIN = /SELECT main_device_id\s+FROM\s+licenses\s+WHERE\s+tenant_id=\?/;

const OTRA_MAIN = "la-main-nueva";
const USUARIO = "00000000-0000-7000-8000-000000000001";

type Hub = {
	/** Cuántas veces ha preguntado el hub a la base central quién es la Main. */
	lecturas: () => number;
	/** Hace que las preguntas del hub a la base central fallen, o que vuelvan a contestar. */
	centralCaida: (caida: boolean) => void;
	/** Lo que dice la tabla del hub. */
	tabla: () => Promise<{ leida: boolean; deviceId: string | null }>;
	/** El aviso de que la licencia ha cambiado, como lo manda la ruta que la cambia. */
	avisar: () => Promise<void>;
	/** La licencia pasa a otro equipo (o a ninguno: anulada), en la base central. */
	trasladarA: (deviceId: string | null) => Promise<void>;
};

/** El hub del negocio y lo que le pregunta a la base central del negocio. */
function hubDe(n: Negocio): Hub {
	let caida = false;
	n.interceptarLaCentral((metodo, [s], llamar) =>
		caida && metodo === "ejecutar" && PIDE_LA_MAIN.test((s as SentenciaEnlazada).sql)
			? Promise.reject(new Error("la base central no contesta"))
			: llamar(),
	);
	return {
		lecturas: () => n.central.filter((q) => PIDE_LA_MAIN.test(q)).length,
		centralCaida: (c) => void (caida = c),
		tabla: () => enElHub(n.tenantId, (hub: any) => mainVigente(hub.state.storage)),
		avisar: () => env.TenantHub.get(env.TenantHub.idFromName(n.tenantId)).releerMain(n.tenantId),
		trasladarA: async (deviceId) => {
			if (deviceId === null) {
				await n.enCentral(`UPDATE licenses SET status = 'revoked', updated_at_ms = ? WHERE tenant_id = ?;`, Date.now(), n.tenantId);
			} else {
				await n.enCentral(
					`UPDATE licenses SET main_device_id = ?, updated_at_ms = ? WHERE tenant_id = ?;`,
					deviceId,
					Date.now(),
					n.tenantId,
				);
			}
		},
	};
}

/** `/v1/sync/changes`: una ruta que sólo es de la Main. */
const cambios = (n: Negocio) => pedirFirmado(deps, app, n, "/v1/sync/changes", { cuerpo: { since: 0 } });

/** Una lectura que también hace una Handy. */
const permisos = async (n: Negocio, deviceId: string) =>
	app.request(await peticionFirmada(deps, n, deviceId, "GET", `/v1/trabajadores/permisos/${USUARIO}`), undefined, {
		...env,
		...n.entorno,
	});

describe("la Main desplazada no entra por REST aunque el Worker aún la dé por buena", () => {
	it("tras el traslado recibe device_replaced en cualquier ruta, decidido en el hub", async () => {
		await conNegocioFirmado(deps, "desplazada-traslado", async (n) => {
			const hub = hubDe(n);

			// Entra, y el Worker se queda con su «sí» un minuto.
			expect((await cambios(n)).status).toBe(200);

			await hub.trasladarA(OTRA_MAIN);
			await hub.avisar();
			expect(await hub.tabla()).toEqual({ leida: true, deviceId: OTRA_MAIN });

			const sync = await cambios(n);
			expect(sync.status).toBe(403);
			expect(await sync.json()).toMatchObject({ ok: false, code: "device_revoked", error: "device_replaced" });
			// Ha llegado al hub: el Worker la ha dejado pasar con lo que tenía guardado.
			expect(viajes(sync, "hub-ruta")).toBe(1);

			// Y no sólo en las rutas que son de la Main: tampoco lee el negocio.
			const lectura = await permisos(n, MAIN);
			expect(lectura.status).toBe(403);
			expect(await lectura.json()).toMatchObject({ error: "device_replaced" });
		});
	});

	it("con la licencia anulada recibe license_revoked", async () => {
		await conNegocioFirmado(deps, "desplazada-anulada", async (n) => {
			const hub = hubDe(n);
			expect((await cambios(n)).status).toBe(200);

			await hub.trasladarA(null);
			await hub.avisar();
			expect(await hub.tabla()).toEqual({ leida: true, deviceId: null });

			const res = await cambios(n);
			expect(res.status).toBe(403);
			expect(await res.json()).toMatchObject({ ok: false, code: "license_expired", error: "license_revoked" });
			expect(viajes(res, "hub-ruta")).toBe(1);
		});
	});
});

describe("la Main de verdad no paga nada", () => {
	it("pasa con la tabla sin leer y con la tabla al día, sin que el hub pregunte a la base central", async () => {
		await conNegocioFirmado(deps, "desplazada-normal", async (n) => {
			const hub = hubDe(n);

			// Nadie ha leído todavía quién es la Main: no hay nada que contradiga al Worker.
			expect(await hub.tabla()).toMatchObject({ leida: false });
			expect((await cambios(n)).status).toBe(200);

			await hub.avisar();
			const lecturas = hub.lecturas();
			expect(await hub.tabla()).toEqual({ leida: true, deviceId: MAIN });
			expect((await cambios(n)).status).toBe(200);
			expect((await permisos(n, MAIN)).status).toBe(200);
			expect(hub.lecturas()).toBe(lecturas);
		});
	});
});

describe("la tabla atrasada no deja fuera a la Main nueva", () => {
	it("si el aviso del traslado se perdió, el hub pregunta antes de rechazar y la deja entrar", async () => {
		await conNegocioFirmado(deps, "desplazada-atrasada", async (n) => {
			const hub = hubDe(n);
			// La tabla se quedó con el equipo anterior: la licencia ya es de `MAIN` y nadie avisó.
			await hub.trasladarA(OTRA_MAIN);
			await hub.avisar();
			await hub.trasladarA(MAIN);
			expect(await hub.tabla()).toEqual({ leida: true, deviceId: OTRA_MAIN });

			const antes = hub.lecturas();
			const res = await cambios(n);
			expect(res.status).toBe(200);
			expect(hub.lecturas()).toBe(antes + 1);
			expect(await hub.tabla()).toEqual({ leida: true, deviceId: MAIN });

			// Con la tabla ya al día, la siguiente no pregunta.
			expect((await cambios(n)).status).toBe(200);
			expect(hub.lecturas()).toBe(antes + 1);
		});
	});

	it("si la base central no contesta, ni entra ni se le dice que ha sido sustituida", async () => {
		await conNegocioFirmado(deps, "desplazada-sin-central", async (n) => {
			const hub = hubDe(n);
			await hub.trasladarA(OTRA_MAIN);
			await hub.avisar();
			await hub.trasladarA(MAIN);

			hub.centralCaida(true);
			const res = await cambios(n);
			expect(res.status).toBe(503);
			expect(await res.json()).toMatchObject({ ok: false, code: "external", error: "main_sin_comprobar" });
			// La tabla se queda como estaba.
			expect(await hub.tabla()).toEqual({ leida: true, deviceId: OTRA_MAIN });

			hub.centralCaida(false);
			expect((await cambios(n)).status).toBe(200);
		});
	});
});

describe("las rutas de la Main que se ejecutan en el Worker", () => {
	it("miran la licencia sin la caché del Worker, y la Main desplazada recibe device_replaced", async () => {
		await conNegocioFirmado(deps, "desplazada-en-el-worker", async (n) => {
			const hub = hubDe(n);
			const dispositivos = async () =>
				app.request(await peticionFirmada(deps, n, MAIN, "POST", "/v1/device/list"), undefined, { ...env, ...n.entorno });

			expect((await dispositivos()).status).toBe(200);
			// El Worker se queda con su «sí» de un minuto: una ruta del hub todavía llega hasta él.
			expect((await cambios(n)).status).toBe(200);

			// El traslado, sin avisar al hub: estas rutas no pasan por él.
			await hub.trasladarA(OTRA_MAIN);
			const res = await dispositivos();
			expect(res.status).toBe(403);
			expect(await res.json()).toMatchObject({ ok: false, code: "device_revoked", error: "device_replaced" });
		});
	});

	it("un router con rutas de la Main que no van al hub usa soloLaMainVigente", () => {
		// `soloLaMain` y los que salen de él (`soloLaMainCobra`…) sólo valen en un router que lo manda
		// todo al TenantHub, que es donde se comprueba que el equipo sigue siendo la Main.
		const fuentes = import.meta.glob("../src/domains/**/*.routes.ts", {
			query: "?raw",
			import: "default",
			eager: true,
		}) as Record<string, string>;
		const sinComentarios = (fuente: string) => fuente.replace(/^\s*(\/\/|\/?\*).*$/gm, "");
		const fueraDelHub = Object.entries(fuentes)
			.filter(([, fuente]) => /\bsoloLaMain(?!Vigente)\w*\b/.test(sinComentarios(fuente)))
			.filter(([, fuente]) => !/\.use\(\s*"\*",\s*tenantAuth,\s*alHub\b/.test(fuente))
			.map(([fichero]) => fichero);
		expect(fueraDelHub).toEqual([]);
		for (const fichero of [
			"pairing/pairing.routes.ts",
			"pairing/dispositivos.routes.ts",
			"reservas_web/main.routes.ts",
			"facturas/facturas.routes.ts",
		]) {
			expect(sinComentarios(fuentes[`../src/domains/${fichero}`]), fichero).toMatch(/soloLaMainVigente\(/);
		}
	});
});

describe("una Handy no pasa por la comprobación de la Main", () => {
	it("lee aunque la tabla nombre a otro equipo, y lo de la Main sigue vetado por su rol", async () => {
		await conNegocioFirmado(deps, "desplazada-handy", async (n) => {
			const hub = hubDe(n);
			await hub.avisar();
			const lecturas = hub.lecturas();

			const lectura = await permisos(n, HANDY);
			expect(lectura.status).toBe(200);
			expect(hub.lecturas()).toBe(lecturas);

			const sync = await app.request(
				await peticionFirmada(deps, n, HANDY, "POST", "/v1/sync/changes", { cuerpo: { since: 0 } }),
				undefined,
				{ ...env, ...n.entorno },
			);
			expect(sync.status).toBe(403);
			expect(await sync.json()).toMatchObject({ error: "forbidden_not_tpv" });
		});
	});
});
