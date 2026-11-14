// test/topeDeTelemetria.test.ts
//
// AUD-32 — el tope común de lo que el worker manda a telemetría (`src/observability/tope.ts`).
//
// Toda cadena que va a Axiom o a Sentry pasa por el filtro de datos personales, síncrona y antes de
// contestar, y muchas las elige quien llama. Cada sitio que emite un evento no tiene que acordarse
// de acotar las suyas: las tres salidas (`ingestToAxiom`, el `beforeSend` de Sentry y el aviso de la
// consola cuando Axiom rechaza un lote) filtran cada cadena con sus dos topes: lo que se filtra
// (64 Ki caracteres; más, se corta antes con la cola segura) y lo que sale (16 KiB de UTF-8, con la
// marca, cortado después de filtrar). Lo que se fija aquí es que el recorte nunca deja a la vista
// nada que, sin recortar, el filtro habría tapado.
//
// Sin red: `fetch` sustituido y Axiom en un dominio `.invalid`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import { ingestToAxiom } from "../src/observability/axiom";
import { scrub } from "../src/observability/scrub";
import { sentryOptions } from "../src/observability/sentry";
import { acotar, colaSegura, MARCA_DE_RECORTE, MAX_BYTES, MAX_FILTRADO } from "../src/observability/tope";
import { bytesUtf8 } from "../src/lib/texto";
import { enElHub } from "./helpers/hub";

const ENORME = 5 * 1024 * 1024;
const AXIOM = { AXIOM_TOKEN: "token-ficticio", AXIOM_DATASET_SYNC: "ds-ficticio", AXIOM_DOMAIN: "axiom.invalid" };
const b64url = (texto: string) => btoa(texto).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

/** Una cadena que ha salido recortada: con su marca, dentro del tope y sin sustitutos sueltos. */
function recortada(texto: unknown): string {
	expect(typeof texto).toBe("string");
	const t = texto as string;
	expect(t.endsWith(MARCA_DE_RECORTE), t.slice(-40)).toBe(true);
	expect(bytesUtf8(t)).toBeLessThanOrEqual(MAX_BYTES);
	expect(t.isWellFormed()).toBe(true);
	return t;
}

describe("AUD-32 · acotar: lo que sale", () => {
	it("lo que cabe sale filtrado y entero", () => {
		const cabe = "x".repeat(MAX_BYTES);
		expect(acotar(cabe, scrub)).toBe(cabe);
		expect(acotar("fallo de ana@example.com", scrub)).toBe("fallo de [email]");
		expect(acotar("", scrub)).toBe("");
	});

	it("el tope está en bytes de UTF-8, con la marca dentro, y no parte ningún carácter", () => {
		// 16.384 «€» son 49.152 bytes.
		const euros = recortada(acotar("€".repeat(16 * 1024), scrub));
		expect(euros).toBe("€".repeat((MAX_BYTES - bytesUtf8(MARCA_DE_RECORTE)) / 3) + MARCA_DE_RECORTE);
		// Un emoji son dos unidades de JavaScript: el corte no se queda con media.
		const emoji = recortada(acotar("a".repeat(MAX_BYTES - 15) + "😀".repeat(4), scrub));
		expect(emoji).toBe("a".repeat(MAX_BYTES - 15) + MARCA_DE_RECORTE);
		const justo = "a".repeat(MAX_BYTES - 4) + "😀";
		expect(bytesUtf8(justo)).toBe(MAX_BYTES);
		expect(acotar(justo, scrub)).toBe(justo);
		recortada(acotar(justo + "a", scrub));
	});

	it("un JWT largo se tapa entero aunque no quepa: se filtra antes de cortar", () => {
		// El caso de la revisión: un correo en la carga y relleno hasta pasar del tope.
		const carga = b64url(JSON.stringify({ sub: "1", email: "ana@example.com", relleno: "r".repeat(14_000) }));
		const jwt = `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${carga}.c2lnLW5hdHVyZV8wMA`;
		expect(bytesUtf8(jwt)).toBeGreaterThan(MAX_BYTES);
		expect(scrub(jwt)).toBe("[jwt]");
		expect(acotar(jwt, scrub)).toBe("[jwt]");
		expect(acotar(`fallo ${jwt} fin`, scrub)).toBe("fallo [jwt] fin");
	});

	it("un correo que cruza el tope se tapa entero", () => {
		const delante = "x ".repeat((MAX_BYTES - 20) / 2);
		const texto = `${delante}ana.garcia.lopez@ejemplo-de-correo.es ${"y más ".repeat(100)}`;
		expect(bytesUtf8(texto)).toBeGreaterThan(MAX_BYTES);
		const sale = recortada(acotar(texto, scrub));
		for (const trozo of ["ana", "garcia", "lopez", "ejemplo"]) expect(sale, trozo).not.toContain(trozo);
	});

	it("la marca no la toca el filtro", () => {
		expect(scrub("algo" + MARCA_DE_RECORTE)).toBe("algo" + MARCA_DE_RECORTE);
	});
});

describe("AUD-32 · acotar: lo que se filtra (la cola segura)", () => {
	it("lo que pasa del tope se corta antes de filtrar, en el último salto de línea, y sale con su marca", () => {
		const texto = "fallo de ana@example.com\n" + "x".repeat(MAX_FILTRADO);
		expect(acotar(texto, scrub)).toBe("fallo de [email]" + MARCA_DE_RECORTE);
		// Sin ninguno, no queda nada.
		expect(acotar("fallo de ana@example.com " + "x".repeat(MAX_FILTRADO), scrub)).toBe(MARCA_DE_RECORTE);
	});

	it("corta en el último blanco que no es un espacio, y lo quita", () => {
		const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0." + "f".repeat(300);
		expect(colaSegura("dato\n" + jwt, 100)).toBe("dato");
		expect(colaSegura("a@b.es\tana.garcia@example.com", 20)).toBe("a@b.es");
		expect(colaSegura("uno\u2028dos tres", 9)).toBe("uno");
		expect(colaSegura("sin saltos " + "z".repeat(500), 100)).toBe("");
	});

	it("un espacio no vale: un número escrito en varias palabras quedaría partido", () => {
		// Cortado en un espacio, un teléfono entero seguido de las cifras sueltas del siguiente parece
		// parte de un número mayor, y «612345678» quedaba a la vista.
		const cadena = "tel=612345678 911 222 333 fin";
		expect(scrub(cadena)).toBe("tel=[num] [num] fin");
		expect(scrub("tel=612345678 911")).toBe("tel=612345678 911");
		expect(colaSegura("línea uno\n" + cadena, 29)).toBe("línea uno");
		// Y una palabra puede llevar pegado el principio de un IBAN.
		const iban = 'password = "hola mundo"ES91 2100 0418 4502 0005 1332';
		expect(scrub(iban)).toBe("password=[redacted][iban]");
		expect(scrub('password = "hola mundo"ES91')).toBe("password=[redacted]ES91");
		expect(colaSegura("línea\n" + iban, 46)).toBe("línea");
	});

	it("no parte un emoji", () => {
		expect(colaSegura("hola\n😀😀", 7)).toBe("hola");
		expect(colaSegura("hola😀\n😀", 7)).toBe("hola😀");
	});

	it("con textos al azar cortados por todas partes, nada que el filtro tapaba queda a la vista", () => {
		const piezas = [
			"ana@example.com", "612 345 678", "612345678", "+34 611 222 333", "4111 1111 1111 1111",
			"ES91 2100 0418 4502 0005 1332", "GB29 NWBK 6016 1331 9268 19", "12.345.678-Z", "X 1234567 L",
			"28 12345678 40", "token=secreto", 'password = "hola mundo"', "Authorization: Bearer abcdef123",
			"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln", "fallo", "mesa", "12", "ok", "tel=", '"', "=",
			" ", " ", "  ", "\n", "\t", "\u2028", ".", ",",
		];
		// Lo que el filtro tapa de esas piezas. Si no está en el texto entero filtrado, tampoco puede
		// estar en lo que sale.
		const sensibles = [
			"example", "612", "345", "678", "611", "222", "333", "4111", "1111", "ES91", "2100", "0418", "4502",
			"0005", "1332", "GB29", "NWBK", "6016", "1331", "9268", "1234567", "12345678", "secreto", "hola",
			"mundo", "abcdef123", "eyJhbGci", "eyJzdWIi", "c2ln",
		];
		let semilla = 32;
		const azar = (n: number) => {
			semilla = (Math.imul(semilla, 1103515245) + 12345) & 0x7fffffff;
			return semilla % n;
		};
		let recortes = 0;
		let conAlgo = 0;
		for (let caso = 0; caso < 3000; caso++) {
			let texto = "";
			for (let i = 4 + azar(20); i > 0; i--) texto += piezas[azar(piezas.length)];
			const tapado = sensibles.filter((s) => !scrub(texto).includes(s));
			for (let filtrado = 1; filtrado < texto.length; filtrado += 1 + azar(7)) {
				recortes++;
				const sale = acotar(texto, scrub, { bytes: 4096, filtrado });
				if (sale !== MARCA_DE_RECORTE) conAlgo++;
				const visto = tapado.find((s) => sale.includes(s));
				if (visto) expect.fail(`«${visto}» en ${JSON.stringify(sale)}: ${JSON.stringify(texto)} cortado en ${filtrado}`);
			}
		}
		expect(recortes).toBeGreaterThan(20_000);
		// Y no es porque no quede nada: en buena parte de los cortes queda texto.
		expect(conAlgo).toBeGreaterThan(recortes / 4);
	}, 120_000);
});

describe("AUD-32 · las salidas a telemetría acotan cada cadena", () => {
	const enviar = vi.fn<typeof fetch>();
	const avisar = vi.fn();
	beforeEach(() => {
		enviar.mockReset().mockResolvedValue(new Response("{}", { status: 200 }));
		avisar.mockReset();
		vi.stubGlobal("fetch", enviar);
		vi.spyOn(console, "warn").mockImplementation(avisar);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("ingestToAxiom: una cadena de 5 MiB sale acotada, el resto igual y el original intacto", async () => {
		const clave = "k".repeat(ENORME);
		const eventos = [{
			event: "escritura_en_duda",
			op_id: clave,
			command_name: "add_linea",
			// Lo que va dentro de lo que cabe se sigue filtrando.
			error: "fallo de ana@example.com",
			anidado: { lista: ["x ".repeat(ENORME / 2), "corto"] },
		}];
		expect(await ingestToAxiom(AXIOM as unknown as Env, "ds-ficticio", eventos)).toBe(true);
		const [enviado] = JSON.parse(String(enviar.mock.calls[0][1]?.body));
		// Una sola palabra de 5 MiB: no queda nada de ella.
		expect(enviado.op_id).toBe(MARCA_DE_RECORTE);
		recortada(enviado.anidado.lista[0]);
		expect(enviado).toMatchObject({ event: "escritura_en_duda", command_name: "add_linea", error: "fallo de [email]" });
		expect(enviado.anidado.lista[1]).toBe("corto");
		// Lo que tiene quien llama no cambia: la clave de la operación sigue entera.
		expect(eventos[0].op_id).toBe(clave);
	});

	it("el aviso de la consola cuando Axiom rechaza un lote también", async () => {
		enviar.mockResolvedValueOnce(new Response("e ".repeat(ENORME / 2), { status: 502 }));
		expect(await ingestToAxiom(AXIOM as unknown as Env, "ds-ficticio", [{ message: "evento" }])).toBe(false);
		recortada(avisar.mock.calls[0][0]);
	});

	it("el beforeSend de Sentry: la URL, el mensaje y las cadenas de un evento", () => {
		const beforeSend = sentryOptions({} as Env).beforeSend;
		const largo = (letra: string) => `${letra} `.repeat(ENORME / 2);
		const evento = beforeSend({
			message: largo("m"),
			exception: { values: [{ value: largo("v") }] },
			breadcrumbs: [{ message: largo("b"), data: { detalle: largo("d") } }],
			tags: { fase: largo("t") },
			request: { url: "https://tpv-api.test/v1/clientes/" + "r".repeat(ENORME) },
		})!;
		recortada(evento.message);
		recortada(evento.exception!.values![0].value);
		recortada(evento.breadcrumbs![0].message);
		recortada((evento.breadcrumbs![0].data as any).detalle);
		recortada((evento.tags as any).fase);
		// La URL es una sola palabra: no queda nada de ella.
		expect(evento.request!.url).toBe(MARCA_DE_RECORTE);
	});

	it("un evento del TenantHub que nadie recortaba llega acotado", async () => {
		// `escritura_en_duda`, `escritura_no_confirmada` y `resultado_ilegible` llevan la clave y el
		// nombre de una operación tal cual: los de la Main, que llegan por el WebSocket sin tope.
		await enElHub("aud32-tope-del-hub", (hub: any) => {
			hub.env = { ...hub.env, ...AXIOM };
			hub.emitSyncEvent("escritura_en_duda", { op_id: "k".repeat(ENORME), command_name: "n ".repeat(ENORME / 2), error: "e" });
		});
		const [enviado] = JSON.parse(String(enviar.mock.calls.at(-1)![1]?.body));
		expect(enviado.event).toBe("escritura_en_duda");
		expect(enviado.op_id).toBe(MARCA_DE_RECORTE);
		recortada(enviado.command_name);
	});
});
