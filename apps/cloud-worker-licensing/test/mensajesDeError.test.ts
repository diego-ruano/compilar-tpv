// test/mensajesDeError.test.ts
//
// Lo que ve la persona cuando el worker contesta con un error.
//
// El cliente pinta `message`. Mientras una respuesta no lo llevaba, pintaba el identificador de
// máquina tal cual: quien vinculaba una Handy con un código mal escrito leía
// `pair_code_not_found`. Aquí se fija que:
//
//   · toda respuesta de error sale con un `code` del catálogo y, si su identificador tiene frase,
//     con `message` — también las que no pasan por ningún helper y las que produce `onError`;
//   · lo que una ruta ya trae no se pisa;
//   · ningún identificador del fuente se queda sin clasificar, que es lo que evita que el
//     próximo que alguien escriba vuelva a salir en crudo.

import { describe, expect, it } from "vitest";
import { Hono } from "hono";

import {
	MENSAJES,
	SIN_MENSAJE_PROPIO,
	claveDeError,
	completarCuerpoDeError,
} from "../src/lib/errorCodes";
import { completarErrores } from "../src/middleware/completarErrores";
import { cuerpoConIdentificador } from "../src/lib/validacion";
import { claimSchema } from "../src/domains/pairing/pairing.schemas";

describe("completar el cuerpo de un error", () => {
	it("añade el código del catálogo y la frase del identificador", () => {
		const cuerpo = completarCuerpoDeError({ ok: false, error: "pair_code_not_found" }, 404);
		expect(cuerpo).toEqual({
			ok: false,
			error: "pair_code_not_found",
			code: "not_found",
			message: MENSAJES.pair_code_not_found,
		});
	});

	it("respeta el mensaje que ya trae la respuesta, que suele ser más preciso", () => {
		const cuerpo = completarCuerpoDeError(
			{ ok: false, code: "validation", error: "invalid_code", message: "El código son 6 cifras." },
			400,
		);
		expect(cuerpo.message).toBe("El código son 6 cifras.");
	});

	it("un mensaje en blanco no cuenta como mensaje", () => {
		const cuerpo = completarCuerpoDeError({ error: "email_duplicado", message: "  " }, 409);
		expect(cuerpo.message).toBe(MENSAJES.email_duplicado);
	});

	it("respeta el código si ya es del catálogo, y cambia el que no lo es", () => {
		expect(completarCuerpoDeError({ code: "main_offline", error: "x" }, 500).code).toBe("main_offline");
		// Un código que no es del catálogo (el de un binding de Cloudflare, p. ej.) haría que el
		// cliente no pudiera clasificar nada: se sustituye por el que corresponde.
		expect(completarCuerpoDeError({ code: "E_SENDER_NOT_VERIFIED", error: "boom" }, 500).code).toBe(
			"internal",
		);
	});

	it("lo que va detrás de los dos puntos no impide encontrar la frase", () => {
		expect(claveDeError(" Too_Many_Attempts:3 ")).toBe("too_many_attempts");
		expect(completarCuerpoDeError({ error: "too_many_attempts:3" }, 429).message).toBe(
			MENSAJES.too_many_attempts,
		);
	});

	it("un identificador interno lleva código pero no frase: el cliente pone la genérica", () => {
		const cuerpo = completarCuerpoDeError({ ok: false, error: "missing_op_id" }, 400);
		expect(cuerpo.code).toBe("validation");
		expect(cuerpo).not.toHaveProperty("message");
	});

	it("sin nada que añadir devuelve el mismo objeto, para no reescribir la respuesta", () => {
		const cuerpo = { ok: false, code: "conflict", error: "missing_op_id" };
		expect(completarCuerpoDeError(cuerpo, 409)).toBe(cuerpo);
	});

	it("un identificador que coincide con algo del prototipo no rompe nada", () => {
		for (const error of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
			const cuerpo = completarCuerpoDeError({ error }, 500);
			expect(cuerpo.code, error).toBe("internal");
			expect(cuerpo, error).not.toHaveProperty("message");
		}
	});
});

describe("ningún identificador del worker se queda sin clasificar", () => {
	// Todo el fuente, como texto (dentro del pool de workers no hay `node:fs`).
	const fuentes = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true });

	// Las formas en que el worker escribe un identificador de error.
	const FORMAS = [
		/\berror:\s*"([^"]+)"/g,
		/HubError\(\s*"([^"]+)"/g,
		/(?:unauthorized|forbidden|serverError)\(\s*[\w.]+,\s*"([^"]+)"/g,
		/badRequest\(\s*\w+,\s*"([^"]+)"/g,
		/fallo\(\s*\d+,\s*"([^"]+)"/g,
		/new Error\("([^"]+)"\)/g,
		// ARQ-03: los del emparejamiento viven ahora en su schema zod (`message:`) y en el veto de
		// rol, que es un middleware con el identificador como argumento — ya no en un `if` del handler.
		/\bmessage:\s*"([^"]+)"/g,
		/textoObligatorio\(\s*"([^"]+)"/g,
		// AUD-02: en las rutas de la Main que se quedan en el Worker, `soloLaMainVigente`.
		/soloLaMain(?:Vigente)?\(\s*"([^"]+)"/g,
		// La agenda de reservas web (`agendaWeb.motor.ts`): sus rechazos cruzan el RPC como resultado.
		/rechazo\(\s*"([^"]+)"/g,
		// DO-PERDIDA: una copia que no se puede restaurar (`tenantHub.restaurar.ts`); la ruta lo devuelve
		// como `error`.
		/CopiaInservible\(\s*"([^"]+)"/g,
		// Una subclase de `HubError` que fija su identificador y su estado en el constructor.
		/super\(\s*"([^"]+)",\s*\d{3}\b/g,
	];
	// Un identificador de máquina; las frases («Lote no encontrado») ya se leen bien tal cual.
	const IDENTIFICADOR = /^[A-Za-z][A-Za-z0-9_]*$/;

	function identificadores(): Map<string, string[]> {
		const vistos = new Map<string, string[]>();
		for (const [ruta, texto] of Object.entries(fuentes)) {
			if (ruta.endsWith("/lib/errorCodes.ts")) continue;
			for (const forma of FORMAS) {
				for (const m of texto.matchAll(forma)) {
					if (!IDENTIFICADOR.test(m[1])) continue;
					vistos.set(m[1], [...(vistos.get(m[1]) ?? []), ruta]);
				}
			}
		}
		return vistos;
	}

	it("lee el fuente de verdad", () => {
		expect(Object.keys(fuentes).length).toBeGreaterThan(50);
		expect(identificadores().size).toBeGreaterThan(100);
	});

	it("cada uno tiene frase o está declarado como sin frase propia", () => {
		const sinClasificar = [...identificadores()]
			.filter(([id]) => !(id in MENSAJES) && !SIN_MENSAJE_PROPIO.has(id))
			.map(([id, rutas]) => `${id} (${[...new Set(rutas)].join(", ")})`);
		expect(sinClasificar, "añádelos a MENSAJES o a SIN_MENSAJE_PROPIO en lib/errorCodes.ts").toEqual([]);
	});

	it("ninguno está en las dos listas", () => {
		expect([...SIN_MENSAJE_PROPIO].filter((id) => id in MENSAJES)).toEqual([]);
	});

	it("las listas no guardan identificadores que ya no emite nadie", () => {
		const vistos = identificadores();
		const sobran = [...Object.keys(MENSAJES), ...SIN_MENSAJE_PROPIO].filter((id) => !vistos.has(id));
		expect(sobran, "identificadores en las listas que ya no emite nadie").toEqual([]);
	});

	it("una frase es una frase: ni vacía ni otro identificador", () => {
		for (const [id, frase] of Object.entries(MENSAJES)) {
			expect(frase.trim().length, id).toBeGreaterThan(15);
			expect(frase, id).not.toMatch(/\b[a-z]+_[a-z0-9_]+\b/);
		}
	});
});

describe("en la frontera HTTP", () => {
	it("el worker lo aplica a todo: el middleware va antes que cualquier ruta", async () => {
		const fuente: string = (await import("../src/app.ts?raw")).default;
		const middleware = fuente.indexOf('app.use("*", completarErrores)');
		expect(middleware, "app.ts no registra completarErrores").toBeGreaterThan(-1);
		for (const primeraRuta of ["app.options(", "app.get(", "app.route(", "app.onError("]) {
			expect(fuente.indexOf(primeraRuta), `app.ts no usa ${primeraRuta}`).toBeGreaterThan(-1);
			expect(middleware, primeraRuta).toBeLessThan(fuente.indexOf(primeraRuta));
		}
	});

	it("un rechazo del validador, sin code ni message, sale completo", async () => {
		// El schema del claim de verdad: rechaza el formato antes de que el handler llegue a
		// existir, y lo hace con el identificador (no con un `validation_error` a secas), que es
		// lo que permite que la Handy enseñe una frase que se entiende.
		const app = new Hono();
		app.use("*", completarErrores);
		app.post("/claim", cuerpoConIdentificador(claimSchema), () => {
			throw new Error("el claim no debería llegar al handler con un código mal formado");
		});

		const res = await app.request("/claim", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ pairCode: "12" }),
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({
			ok: false,
			error: "invalid_pair_code",
			code: "validation",
			message: MENSAJES.invalid_pair_code,
		});
	});

	it("un error lanzado que traduce onError también sale completo, con sus cabeceras", async () => {
		// Misma disposición que `index.ts`: el middleware delante y un `onError` que responde.
		const app = new Hono();
		app.use("*", completarErrores);
		app.get("/boom", () => {
			throw Object.assign(new Error("idempotency_operation_processing"), { status: 409 });
		});
		app.onError((err, c) => {
			c.header("x-prueba", "sigue");
			return c.json({ error: err.message }, (err as any).status);
		});

		const res = await app.request("/boom");
		expect(res.status).toBe(409);
		expect(res.headers.get("x-prueba")).toBe("sigue");
		expect(await res.json()).toEqual({
			error: "idempotency_operation_processing",
			code: "conflict",
			message: MENSAJES.idempotency_operation_processing,
		});
	});

	it("no toca lo que no es un error en JSON", async () => {
		const app = new Hono();
		app.use("*", completarErrores);
		app.get("/ok", (c) => c.json({ ok: true, error: "pair_code_not_found" }));
		app.get("/texto", (c) => c.text("pair_code_not_found", 404));

		expect(await (await app.request("/ok")).json()).toEqual({ ok: true, error: "pair_code_not_found" });
		expect(await (await app.request("/texto")).text()).toBe("pair_code_not_found");
	});
});
