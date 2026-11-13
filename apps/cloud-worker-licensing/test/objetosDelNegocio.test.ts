// test/objetosDelNegocio.test.ts
//
// De dónde sale el Durable Object de un negocio (`lib/objetosDelNegocio.ts`).
//
// Los DO van sin jurisdicción y con una pista de región de Europa occidental: nacen ahí aunque el
// primero que los llame esté en otro sitio (el visitante de una web que reserva desde otro
// continente). Eso sólo vale si TODO el que pide el objeto de un negocio pide el mismo, de la misma
// forma: el mismo nombre da otro objeto en otra jurisdicción, y la pista sólo cuenta en la llamada
// que lo crea. Aquí se fija:
//
//   · lo que dice el despliegue (`wrangler.json`): ninguna jurisdicción y la pista `weur`;
//   · que las cuatro puertas (`hubDe`, `agendaDe`, la baja de un dispositivo y el aviso de cambio
//     de licencia) piden el objeto con esa jurisdicción y esa pista;
//   · y, leyendo el fuente, que nadie más le pide un objeto a un espacio de nombres por su cuenta.

import { describe, expect, it } from "vitest";

import wrangler from "../wrangler.json";
import { agendaDe } from "../src/durableObjects/agendaWeb";
import { avisarCambioDeLicencia, cerrarSocketsDelDispositivo, hubDe } from "../src/lib/hub";
import { colocacionDelDespliegue, objetoDelNegocio, objetoEn } from "../src/lib/objetosDelNegocio";

type Peticion = { jurisdiccion: string | null; nombre: string; opciones: unknown };

/** Un espacio de nombres de mentira que apunta cómo se le pide cada objeto. */
function espacio(pedidos: Peticion[], llamadas: string[] = [], jurisdiccion: string | null = null): any {
	return {
		jurisdiction: (j: string) => espacio(pedidos, llamadas, j),
		idFromName: (nombre: string) => ({ nombre }),
		get: (id: { nombre: string }, opciones?: unknown) => {
			pedidos.push({ jurisdiccion, nombre: id.nombre, opciones });
			return {
				revocarDispositivo: async (deviceId: string) => void llamadas.push(`revocar ${deviceId}`),
				releerMain: async (tenantId: string) => void llamadas.push(`releer ${tenantId}`),
			};
		},
	};
}

const DESPLIEGUE = wrangler.vars as Record<string, string>;

describe("lo que dice el despliegue", () => {
	it("ninguna jurisdicción, y la pista de Europa occidental", () => {
		// Cambiar la jurisdicción con negocios dados de alta es empezar de cero: el mismo nombre da
		// otro objeto. Si esto cambia, que sea a sabiendas.
		expect(DESPLIEGUE.JURISDICCION_DO).toBe("");
		expect(DESPLIEGUE.UBICACION_DO).toBe("weur");
		expect(colocacionDelDespliegue(DESPLIEGUE)).toEqual({ jurisdiccion: undefined, pista: "weur" });
	});
});

describe("cómo se pide un objeto", () => {
	it("sin jurisdicción ni pista, tal cual; con ellas, las dos", () => {
		const pedidos: Peticion[] = [];
		objetoEn(espacio(pedidos), "a", {});
		objetoEn(espacio(pedidos), "b", { pista: "weur" });
		objetoEn(espacio(pedidos), "c", { jurisdiccion: "eu" });
		objetoEn(espacio(pedidos), "d", { jurisdiccion: "eu", pista: "weur" });
		expect(pedidos).toEqual([
			{ jurisdiccion: null, nombre: "a", opciones: undefined },
			{ jurisdiccion: null, nombre: "b", opciones: { locationHint: "weur" } },
			{ jurisdiccion: "eu", nombre: "c", opciones: undefined },
			{ jurisdiccion: "eu", nombre: "d", opciones: { locationHint: "weur" } },
		]);
	});

	it("vacío es «sin»: como en local y en los tests", () => {
		const pedidos: Peticion[] = [];
		objetoDelNegocio({ JURISDICCION_DO: "", UBICACION_DO: "" }, espacio(pedidos), "negocio");
		objetoDelNegocio({}, espacio(pedidos), "negocio");
		expect(pedidos).toEqual([
			{ jurisdiccion: null, nombre: "negocio", opciones: undefined },
			{ jurisdiccion: null, nombre: "negocio", opciones: undefined },
		]);
	});
});

describe("las puertas piden el objeto como dice el despliegue", () => {
	const COMO_EL_DESPLIEGUE = { jurisdiccion: null, nombre: "negocio-1", opciones: { locationHint: "weur" } };

	it("el TenantHub y la AgendaWeb de un negocio", () => {
		const delHub: Peticion[] = [];
		const deLaAgenda: Peticion[] = [];
		const env = { ...DESPLIEGUE, TenantHub: espacio(delHub), AgendaWeb: espacio(deLaAgenda) } as any;
		hubDe(env, "negocio-1");
		agendaDe(env, "negocio-1");
		expect(delHub).toEqual([COMO_EL_DESPLIEGUE]);
		expect(deLaAgenda).toEqual([COMO_EL_DESPLIEGUE]);
	});

	it("la baja de un dispositivo y el aviso de cambio de licencia hablan con ese mismo TenantHub", async () => {
		const pedidos: Peticion[] = [];
		const llamadas: string[] = [];
		const env = { ...DESPLIEGUE, TenantHub: espacio(pedidos, llamadas) } as any;
		await cerrarSocketsDelDispositivo(env, "negocio-1", "handy-1");
		await avisarCambioDeLicencia(env, "negocio-1");
		expect(pedidos).toEqual([COMO_EL_DESPLIEGUE, COMO_EL_DESPLIEGUE]);
		expect(llamadas).toEqual(["revocar handy-1", "releer negocio-1"]);
	});

	it("con otra jurisdicción, todas van a ella", async () => {
		const pedidos: Peticion[] = [];
		const env = { JURISDICCION_DO: "eu", UBICACION_DO: "", TenantHub: espacio(pedidos), AgendaWeb: espacio(pedidos) } as any;
		hubDe(env, "negocio-1");
		agendaDe(env, "negocio-1");
		await cerrarSocketsDelDispositivo(env, "negocio-1", "handy-1");
		await avisarCambioDeLicencia(env, "negocio-1");
		expect(pedidos).toHaveLength(4);
		expect(pedidos.every((p) => p.jurisdiccion === "eu" && p.opciones === undefined)).toBe(true);
	});
});

describe("nadie pide un objeto por su cuenta", () => {
	const fuentes = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

	/** Lo que hace falta para sacar un objeto de un espacio de nombres sin pasar por el ayudante. */
	const POR_SU_CUENTA = /\.(idFromName|idFromString|newUniqueId|getByName|jurisdiction)\s*\(/;

	it("sólo `lib/objetosDelNegocio.ts` convierte un nombre en un objeto", () => {
		// Sin comentarios: la documentación nombra `idFromName(tenantId)` para explicarlo.
		const sinComentarios = (texto: string) => texto.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
		const culpables = Object.entries(fuentes)
			.filter(([fichero]) => !fichero.endsWith("/lib/objetosDelNegocio.ts") && !fichero.endsWith(".d.ts"))
			.filter(([, texto]) => POR_SU_CUENTA.test(sinComentarios(texto)))
			.map(([fichero]) => fichero.replace("../src/", ""));
		// Si el glob no encontrara nada, este test pasaría sin mirar nada.
		expect(Object.keys(fuentes).length).toBeGreaterThan(50);
		expect(culpables).toEqual([]);
	});
});
