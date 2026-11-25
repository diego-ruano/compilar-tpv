// test/reservasWebCorreos.test.ts
//
// Los correos al cliente de una reserva web (docs/estudios/reservas-web.md §4.8,
// `domains/reservas_web/correos.ts`):
//   · lo que dicen: sólo datos estructurados, la mesa como en el widget, el enlace sólo en la
//     confirmación, y nada del negocio sin escapar;
//   · cuánto: el tope por negocio y el de cada destinatario, contando sólo lo entregado y sólo lo
//     suyo, sin tocar el de los pedidos;
//   · que el mismo correo no sale dos veces, y que uno que falló se puede volver a intentar;
//   · que lo que va a una cabecera (el asunto, el remitente, la dirección) sale en una línea (AUD-40).
//
// Cada caso que envía, contra su propia base central de verdad (`helpers/central.ts`), a la que
// llega como en producción, por el `env`.

import { describe, expect, it } from "vitest";

import { centralDePrueba, centralInterceptada, filasDe, type CentralDePrueba } from "./helpers/central";
import type { SentenciaEnlazada } from "../src/durableObjects/baseCentral.rpc";
import {
	enUnaLinea,
	enviarCorreoReservaWeb,
	fechaLarga,
	plantilla,
	TOPE_DIARIO_DESTINATARIO,
	TOPE_DIARIO_NEGOCIO,
} from "../src/domains/reservas_web/correos";
import { reservarCupo } from "../src/domains/email/email.routes";

const NEGOCIO = { nombre: "Bar Pepe", direccion: "Calle Mayor 1", telefono: "950 000 000", correo: "hola@barpepe.es" };
const RESERVA = { dia: "2026-10-23", hora: "21:00", personas: 4, mesa: "Mesa 5", codigo: "ABC123" };

function correo(extra: Record<string, unknown> = {}): any {
	return {
		tenantId: "t1",
		id: "rw:confirmacion:r1",
		tipo: "confirmacion",
		para: "Ana@Correo.es",
		negocio: NEGOCIO,
		reserva: RESERVA,
		enlace: "https://tpv-api.test/reservas-web/v1/w/rw_X/cancelar#t=TOKEN",
		dispositivo: "web",
		...extra,
	};
}

/** Un binding de correo que apunta lo que se le manda, o que falla si se le dice. */
function correoFalso(falla = false) {
	const enviados: any[] = [];
	return {
		enviados,
		EMAIL: {
			send: async (m: any) => {
				if (falla) throw Object.assign(new Error("caído"), { code: "E_RATE_LIMIT_EXCEEDED" });
				enviados.push(m);
			},
		},
	};
}

/** Una base central nueva para el caso. */
async function conBase<T>(fn: (central: CentralDePrueba) => Promise<T>): Promise<T> {
	return fn(await centralDePrueba());
}

/** El `env` con el que se envía: el remitente, la central `central` y lo que diga `extra`. */
const ENV = (central: Pick<CentralDePrueba, "entorno">, extra: Record<string, unknown>) =>
	({ EMAIL_RESERVAS_FROM_ADDRESS: "reservas@altaria.test", ...central.entorno, ...extra }) as any;

/**
 * Los `correos` enviados a la vez, en el peor cruce: ninguno termina de salir hasta que todos han
 * decidido, o porque están enviando o porque ya han contestado sin enviar. Así todos han pasado por
 * la central (el tope y la fila del correo) antes de que se apunte que salió el primero, vaya la
 * máquina lo rápida que vaya.
 */
async function aLaVez(central: CentralDePrueba, correos: any[]) {
	const enviados: any[] = [];
	let decididos = 0;
	let abrir!: () => void;
	const barrera = new Promise<void>((r) => (abrir = r));
	// El que envía decide al empezar a enviar y se queda en la barrera: hasta abrirla, cada uno cuenta una vez.
	const decidir = () => void (++decididos === correos.length && abrir());
	const EMAIL = {
		send: async (m: any) => {
			decidir();
			await barrera;
			enviados.push(m);
		},
	};
	const resultados = await Promise.all(
		correos.map((c) =>
			enviarCorreoReservaWeb(ENV(central, { EMAIL }), c).then((r) => {
				decidir();
				return r;
			}),
		),
	);
	return { resultados, enviados };
}

describe("lo que dice cada correo", () => {
	it("la confirmación lleva el resumen, el código y el enlace de cancelar", () => {
		const { asunto, html, texto } = plantilla(correo());
		expect(asunto).toBe("Reserva confirmada en Bar Pepe");
		for (const t of [html, texto]) {
			expect(t).toContain("viernes, 23 de octubre de 2026");
			expect(t).toContain("21:00");
			expect(t).toContain("4 personas");
			expect(t).toContain("ABC123");
			expect(t).toContain("https://tpv-api.test/reservas-web/v1/w/rw_X/cancelar#t=TOKEN");
			// La mesa, con el nombre que propone la Main: no «Mesa Mesa 5».
			expect(t).toContain("Mesa 5");
			expect(t).not.toContain("Mesa Mesa");
		}
	});

	it("una mesa con un número a secas lleva «Mesa» delante; una con nombre, no", () => {
		expect(plantilla(correo({ reserva: { ...RESERVA, mesa: "7" } })).texto).toContain("Mesa: Mesa 7");
		expect(plantilla(correo({ reserva: { ...RESERVA, mesa: "Terraza 2" } })).texto).toContain("Mesa: Terraza 2");
		expect(plantilla(correo({ reserva: { ...RESERVA, mesa: null } })).texto).not.toContain("Mesa:");
	});

	it("sólo la confirmación lleva enlace, y cada uno dice lo suyo", () => {
		const asuntos = {
			cancelacion: "Reserva cancelada en Bar Pepe",
			modificada: "Tu reserva en Bar Pepe ha cambiado",
			cancelada_restaurante: "Tu reserva en Bar Pepe se ha cancelado",
			no_registrada: "No hemos podido registrar tu reserva en Bar Pepe",
		};
		for (const [tipo, asunto] of Object.entries(asuntos)) {
			const p = plantilla(correo({ tipo, enlace: undefined }));
			expect(p.asunto).toBe(asunto);
			expect(p.html).not.toContain("Cancelar la reserva</a>");
		}
	});

	it("sin correo de contacto no invita a contestar: la respuesta llegaría a nuestro remitente", () => {
		const con = plantilla(correo({ tipo: "cancelada_restaurante", enlace: undefined })).texto;
		const sin = plantilla(correo({ tipo: "cancelada_restaurante", enlace: undefined, negocio: { ...NEGOCIO, correo: null } })).texto;
		expect(con).toContain("contesta a este correo");
		expect(sin).not.toContain("contesta a este correo");
		expect(sin).toContain("950 000 000");
	});

	it("lo del negocio va escapado en el HTML", () => {
		const { html } = plantilla(correo({ negocio: { ...NEGOCIO, nombre: "Bar <b>Pepe</b> & Co" } }));
		expect(html).not.toContain("<b>Pepe</b>");
		expect(html).toContain("Bar &lt;b&gt;Pepe&lt;/b&gt; &amp; Co");
	});

	it("la fecha, en palabras", () => {
		expect(fechaLarga("2026-11-01")).toBe("domingo, 1 de noviembre de 2026");
	});
});

describe("enviar", () => {
	it("sale con el nombre del negocio, el Reply-To del negocio y el destinatario en minúsculas, y queda apuntado", async () => {
		const falso = correoFalso();
		const r = await conBase(async (central) => {
			const r = await enviarCorreoReservaWeb(ENV(central, { EMAIL: falso.EMAIL }), correo());
			const fila = (await filasDe(central, `SELECT * FROM email_sends;`))[0];
			return { r, fila };
		});
		expect(r.r).toBe("enviado");
		expect(falso.enviados).toHaveLength(1);
		expect(falso.enviados[0]).toMatchObject({
			from: { email: "reservas@altaria.test", name: "Bar Pepe" },
			to: "ana@correo.es",
			replyTo: "hola@barpepe.es",
			subject: "Reserva confirmada en Bar Pepe",
		});
		expect(r.fila).toMatchObject({ id: "rw:confirmacion:r1", tenant_id: "t1", device_id: "web", to_email: "ana@correo.es", ok: 1, tipo: "reserva_web" });
	});

	it("el mismo correo no sale dos veces", async () => {
		const falso = correoFalso();
		const r = await conBase(async (central) => [
			await enviarCorreoReservaWeb(ENV(central, { EMAIL: falso.EMAIL }), correo()),
			await enviarCorreoReservaWeb(ENV(central, { EMAIL: falso.EMAIL }), correo()),
		]);
		expect(r).toEqual(["enviado", "ya_enviado"]);
		expect(falso.enviados).toHaveLength(1);
	});

	it("dos envíos a la vez del mismo correo: sale uno", async () => {
		const { resultados, enviados } = await conBase((central) => aLaVez(central, [correo(), correo()]));
		// El segundo lo ve saliendo: en curso, no «ya enviado» (aún no se sabe si saldrá).
		expect(resultados.sort()).toEqual(["en_curso", "enviado"]);
		expect(enviados).toHaveLength(1);
	});

	it("uno que salió no se vuelve a enviar, ni lo deja reenviable un fallo después", async () => {
		const r = await conBase(async (central) => {
			await filasDe(
				central,
				`INSERT INTO email_sends (id, tenant_id, device_id, to_email, ok, sent_at_ms, tipo)
				 VALUES ('rw:confirmacion:r1', 't1', 'web', 'ana@correo.es', 1, ?, 'reserva_web');`,
				Date.now(),
			);
			const r = await enviarCorreoReservaWeb(ENV(central, correoFalso(true)), correo());
			return { r, fila: (await filasDe(central, `SELECT ok, error_code FROM email_sends;`))[0] };
		});
		expect(r).toEqual({ r: "ya_enviado", fila: { ok: 1, error_code: null } });
	});

	it("uno que se quedó a medias hace unos minutos se retoma; uno que está saliendo ahora está en curso", async () => {
		const falso = correoFalso();
		const r = await conBase(async (central) => {
			const apuntar = (id: string, hace: number) =>
				filasDe(
					central,
					`INSERT INTO email_sends (id, tenant_id, device_id, to_email, ok, error_code, sent_at_ms, tipo)
					 VALUES (?, 't1', 'web', 'ana@correo.es', 0, 'enviando', ?, 'reserva_web');`,
					id,
					Date.now() - hace,
				);
			await apuntar("rw:confirmacion:viejo", 10 * 60_000);
			await apuntar("rw:confirmacion:ahora", 1000);
			return [
				await enviarCorreoReservaWeb(ENV(central, { EMAIL: falso.EMAIL }), correo({ id: "rw:confirmacion:viejo" })),
				await enviarCorreoReservaWeb(ENV(central, { EMAIL: falso.EMAIL }), correo({ id: "rw:confirmacion:ahora" })),
			];
		});
		// En curso no es «ya enviado»: quien lo manda lo repite, por si el otro no llega a terminarlo.
		expect(r).toEqual(["enviado", "en_curso"]);
		expect(falso.enviados).toHaveLength(1);
	});

	it("si apuntar que salió falla una vez, se insiste: no se queda «enviando» y no se puede repetir", async () => {
		const falso = correoFalso();
		const r = await conBase(async (central) => {
			// El primer intento de apuntarlo se corta; los siguientes pasan.
			let intentos = 0;
			const aRatos = centralInterceptada(central, (metodo, [sentencia], llamar) =>
				metodo === "ejecutar" &&
				(sentencia as SentenciaEnlazada).sql.trimStart().startsWith("UPDATE email_sends") &&
				intentos++ === 0
					? Promise.reject(new Error("la base central no contesta"))
					: llamar(),
			);
			const r = await enviarCorreoReservaWeb(ENV(aRatos, { EMAIL: falso.EMAIL }), correo());
			return { r, intentos, fila: (await filasDe(central, `SELECT ok, error_code FROM email_sends;`))[0] };
		});
		// Dos intentos: el que se cortó y el que entró.
		expect(r).toEqual({ r: "enviado", intentos: 2, fila: { ok: 1, error_code: null } });
		expect(falso.enviados).toHaveLength(1);
	});

	it("sin la base central no se sabe si salió: no se envía, y es un fallo que se puede repetir", async () => {
		const falso = correoFalso();
		const r = await conBase(async (central) => {
			const caida = centralInterceptada(central, () => Promise.reject(new Error("la base central no contesta")));
			return enviarCorreoReservaWeb(ENV(caida, { EMAIL: falso.EMAIL }), correo());
		});
		expect(r).toBe("fallido");
		expect(falso.enviados).toHaveLength(0);
	});

	it("uno que falló queda apuntado sin gastar cupo, y se puede volver a intentar", async () => {
		const bueno = correoFalso();
		const r = await conBase(async (central) => {
			const primero = await enviarCorreoReservaWeb(ENV(central, correoFalso(true)), correo());
			const fallo = (await filasDe(central, `SELECT ok, error_code FROM email_sends;`))[0];
			const segundo = await enviarCorreoReservaWeb(ENV(central, { EMAIL: bueno.EMAIL }), correo());
			const filas = await filasDe(central, `SELECT ok, error_code FROM email_sends;`);
			return { primero, fallo, segundo, filas };
		});
		expect(r.primero).toBe("fallido");
		expect(r.fallo).toMatchObject({ ok: 0, error_code: "E_RATE_LIMIT_EXCEEDED" });
		expect(r.segundo).toBe("enviado");
		expect(r.filas).toEqual([{ ok: 1, error_code: null }]);
	});

	it("sin remitente configurado no sale", async () => {
		const falso = correoFalso();
		const r = await conBase(async (central) =>
			enviarCorreoReservaWeb({ ...central.entorno, EMAIL: falso.EMAIL } as any, correo()),
		);
		expect(r).toBe("fallido");
		expect(falso.enviados).toHaveLength(0);
	});
});

describe("los topes", () => {
	/** `n` envíos (al menos uno) en la central, en una sola sentencia: cientos, uno a uno, serían cientos de viajes. */
	async function apuntar(central: CentralDePrueba, n: number, extra: Record<string, unknown> = {}) {
		const f = { tenant_id: "t1", to_email: "otro@correo.es", ok: 1, error_code: null, tipo: "reserva_web", sent_at_ms: Date.now(), ...extra } as any;
		await filasDe(
			central,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
			 INSERT INTO email_sends (id, tenant_id, device_id, to_email, ok, error_code, sent_at_ms, tipo)
			 SELECT ? || '-' || i, ?, 'web', ?, ?, ?, ?, ? FROM n;`,
			n,
			crypto.randomUUID(),
			f.tenant_id,
			f.to_email,
			f.ok,
			f.error_code,
			f.sent_at_ms,
			f.tipo,
		);
	}

	it("el del negocio corta lo de ese negocio", async () => {
		const falso = correoFalso();
		const r = await conBase(async (central) => {
			await apuntar(central, TOPE_DIARIO_NEGOCIO);
			return [
				await enviarCorreoReservaWeb(ENV(central, { EMAIL: falso.EMAIL }), correo()),
				await enviarCorreoReservaWeb(ENV(central, { EMAIL: falso.EMAIL }), correo({ tenantId: "t2", id: "rw:confirmacion:r2" })),
			];
		});
		expect(r).toEqual(["tope", "enviado"]);
	});

	it("el del destinatario corta, aunque sean de negocios distintos", async () => {
		const falso = correoFalso();
		const r = await conBase(async (central) => {
			await apuntar(central, TOPE_DIARIO_DESTINATARIO, { tenant_id: "otro-bar", to_email: "ana@correo.es" });
			return enviarCorreoReservaWeb(ENV(central, { EMAIL: falso.EMAIL }), correo());
		});
		expect(r).toBe("tope");
		expect(falso.enviados).toHaveLength(0);
	});

	it("muchos envíos a la vez no pasan del tope: cuenta también lo que está saliendo", async () => {
		const { resultados, enviados } = await conBase(async (central) => {
			await apuntar(central, TOPE_DIARIO_DESTINATARIO - 1, { to_email: "ana@correo.es" });
			return aLaVez(central, Array.from({ length: 12 }, (_, i) => correo({ id: `rw:confirmacion:x${i}` })));
		});
		expect(resultados.filter((x) => x === "enviado")).toHaveLength(1);
		expect(resultados.filter((x) => x === "tope")).toHaveLength(11);
		expect(enviados).toHaveLength(1);
	});

	it("un reintento a otra dirección cuenta para la dirección a la que sale", async () => {
		const bueno = correoFalso();
		const r = await conBase(async (central) => {
			await enviarCorreoReservaWeb(ENV(central, correoFalso(true)), correo({ para: "vieja@correo.es" }));
			await enviarCorreoReservaWeb(ENV(central, { EMAIL: bueno.EMAIL }), correo({ para: "nueva@correo.es" }));
			return filasDe(central, `SELECT to_email, ok FROM email_sends;`);
		});
		expect(r).toEqual([{ to_email: "nueva@correo.es", ok: 1 }]);
		expect(bueno.enviados.map((m) => m.to)).toEqual(["nueva@correo.es"]);
	});

	it("no cuentan los que no salieron, los de ayer ni los pedidos", async () => {
		const falso = correoFalso();
		const r = await conBase(async (central) => {
			await apuntar(central, TOPE_DIARIO_DESTINATARIO, { to_email: "ana@correo.es", ok: 0 });
			await apuntar(central, TOPE_DIARIO_DESTINATARIO, { to_email: "ana@correo.es", sent_at_ms: Date.now() - 25 * 3_600_000 });
			await apuntar(central, TOPE_DIARIO_DESTINATARIO, { to_email: "ana@correo.es", tipo: "pedido" });
			return enviarCorreoReservaWeb(ENV(central, { EMAIL: falso.EMAIL }), correo());
		});
		expect(r).toBe("enviado");
	});

	it("los correos de las reservas web no gastan el cupo de los pedidos", async () => {
		const { TOPE_DIARIO } = await import("../src/domains/email/email.routes");
		const r = await conBase(async (central) => {
			await apuntar(central, TOPE_DIARIO);
			// AUD-41: tampoco los que están saliendo.
			await apuntar(central, TOPE_DIARIO, { ok: 0, error_code: "enviando" });
			const envio = { id: crypto.randomUUID(), tenantId: "t1", deviceId: "dev", toEmail: "prov@correo.es", proveedor: "Prov" };
			return reservarCupo(central.db, envio);
		});
		expect(r).toBe("reservado");
	});
});

// AUD-40 · Lo que va a una cabecera sale en una línea. El nombre del negocio llega de la base tal
// como lo subió la Main o lo puso una Handy, con lo que lleve dentro.
describe("las cabeceras, en una línea (AUD-40)", () => {
	const TIPOS = ["confirmacion", "cancelacion", "modificada", "cancelada_restaurante", "no_registrada"];
	const CON_SALTOS = "Bar Pepe\r\nBcc: x@prueba.test\r\nX-Prueba: 1";

	it("enUnaLinea: los caracteres de control y los separadores de línea pasan a un espacio", () => {
		expect(enUnaLinea("Bar Pepe\r\nBcc: x@prueba.test\r\nX-Prueba: 1\r\n")).toBe("Bar Pepe Bcc: x@prueba.test X-Prueba: 1");
		expect(enUnaLinea("Bar\rX-A: 1\nX-B: 2\u0000\u0085fin")).toBe("Bar X-A: 1 X-B: 2 fin");
		expect(enUnaLinea("Bar\u2028Pepe\u2029\tCasa")).toBe("Bar Pepe Casa");
		// Lo que no es de control se queda como está.
		expect(enUnaLinea("Mesón «El Puerto» & \"Cía\" <Café>")).toBe("Mesón «El Puerto» & \"Cía\" <Café>");
		expect(enUnaLinea("\r\n")).toBe("");
	});

	it("ningún asunto lleva un salto de línea", () => {
		for (const tipo of TIPOS) {
			const { asunto } = plantilla(correo({ tipo, enlace: undefined, negocio: { ...NEGOCIO, nombre: CON_SALTOS } }));
			expect(asunto, tipo).not.toMatch(/[\r\n]/);
			expect(asunto, tipo).toContain("Bar Pepe Bcc: x@prueba.test X-Prueba: 1");
		}
	});

	it("el nombre entra en el asunto con un tope, sin partir un carácter, y sin nombre dice «el restaurante»", () => {
		const largo = "😀".repeat(150);
		const { asunto } = plantilla(correo({ negocio: { ...NEGOCIO, nombre: largo } }));
		expect(asunto).toBe(`Reserva confirmada en ${"😀".repeat(100)}`);
		expect(plantilla(correo({ negocio: { ...NEGOCIO, nombre: "\r\n" } })).asunto).toBe("Reserva confirmada en el restaurante");
	});

	it("lo que sale al binding: asunto y remitente en una línea", async () => {
		const falso = correoFalso();
		const r = await conBase((central) =>
			enviarCorreoReservaWeb(ENV(central, { EMAIL: falso.EMAIL }), correo({ negocio: { ...NEGOCIO, nombre: `${CON_SALTOS}\u0000"<x>"` } })),
		);
		expect(r).toBe("enviado");
		const m = falso.enviados[0];
		expect(m.subject).toBe('Reserva confirmada en Bar Pepe Bcc: x@prueba.test X-Prueba: 1 "<x>"');
		expect(m.from.name).toBe("Bar Pepe Bcc: x@prueba.test X-Prueba: 1   x");
		for (const v of [m.subject, m.from.name, m.to, m.replyTo]) expect(v).not.toMatch(/[\p{Cc}]/u);
	});

	it("una dirección con un carácter de control no se envía ni gasta cupo", async () => {
		const falso = correoFalso();
		const r = await conBase(async (central) => ({
			r: await enviarCorreoReservaWeb(ENV(central, { EMAIL: falso.EMAIL }), correo({ para: "ana@correo.es\r\nbcc:otro@prueba.test" })),
			filas: (await filasDe(central, `SELECT COUNT(*) AS n FROM email_sends;`))[0].n,
		}));
		// Repetirlo no la arregla: `invalido`, que nadie apunta para repetir.
		expect(r).toEqual({ r: "invalido", filas: 0 });
		expect(falso.enviados).toHaveLength(0);
	});
});

// AUD-39 · El destinatario es una sola dirección. Una lista en `to` contaba como un solo envío y
// como otro destinatario para el tope (que va por la cadena literal): con «ana» en su tope, la lista
// que la incluía salía. Lo que llegue aquí (la dirección de un cliente que la Main subió por la
// réplica, sin pasar por ninguna validación) se mira otra vez con la misma regla.
describe("el destinatario, una sola dirección (AUD-39)", () => {
	const NO_SON_UNA = [
		"ana@correo.es,otra@correo.es",
		"ana@correo.es;otra@correo.es",
		"<ana@correo.es>,<otra@correo.es>",
		"pepe<ana@correo.es>",
		"ana@otra@correo.es",
		"ana@correo.es\totra@correo.es",
		"grupo:ana@correo.es;",
	];

	it("una lista o algo que no es una dirección no se envía ni gasta cupo", async () => {
		const falso = correoFalso();
		const r = await conBase(async (central) => {
			const resultados = [];
			for (const [i, para] of NO_SON_UNA.entries()) {
				resultados.push(await enviarCorreoReservaWeb(ENV(central, { EMAIL: falso.EMAIL }), correo({ id: `rw:confirmacion:l${i}`, para })));
			}
			return { resultados, filas: (await filasDe(central, `SELECT COUNT(*) AS n FROM email_sends;`))[0].n };
		});
		expect(r).toEqual({ resultados: NO_SON_UNA.map(() => "invalido"), filas: 0 });
		expect(falso.enviados).toHaveLength(0);
	});

	it("una dirección con + y subdominio, en mayúsculas, sí sale", async () => {
		const falso = correoFalso();
		const r = await conBase((central) =>
			enviarCorreoReservaWeb(ENV(central, { EMAIL: falso.EMAIL }), correo({ para: " Ana+Reservas@Sub.Correo.ES " })),
		);
		expect(r).toBe("enviado");
		expect(falso.enviados.map((m) => m.to)).toEqual(["ana+reservas@sub.correo.es"]);
	});
});

describe("un correo que va detrás de otro (RW-ALTAS)", () => {
	const cancelacion = () => correo({ id: "rw:cancelacion:r1", tipo: "cancelacion", enlace: undefined, trasElCorreo: "rw:confirmacion:r1" });
	const apuntarConfirmacion = (central: CentralDePrueba, ok: number, codigo: string | null, tenant = "t1") =>
		filasDe(
			central,
			`INSERT INTO email_sends (id, tenant_id, device_id, to_email, ok, error_code, sent_at_ms, tipo)
			 VALUES ('rw:confirmacion:r1', ?, 'web', 'ana@correo.es', ?, ?, ?, 'reserva_web');`,
			tenant,
			ok,
			codigo,
			Date.now() - 60_000,
		);

	it("si el anterior no salió, no sale ni gasta cupo", async () => {
		const falso = correoFalso();
		const r = await conBase(async (central) => {
			const sinNada = await enviarCorreoReservaWeb(ENV(central, { EMAIL: falso.EMAIL }), cancelacion());
			await apuntarConfirmacion(central, 0, "E_INTERNAL");
			const conFallo = await enviarCorreoReservaWeb(ENV(central, { EMAIL: falso.EMAIL }), cancelacion());
			return { sinNada, conFallo, filas: await filasDe(central, `SELECT id FROM email_sends;`) };
		});
		expect(r.sinNada).toBe("sin_previo");
		expect(r.conFallo).toBe("sin_previo");
		expect(r.filas).toEqual([{ id: "rw:confirmacion:r1" }]);
		expect(falso.enviados).toEqual([]);
	});

	it("el de otro negocio con el mismo id no cuenta como anterior", async () => {
		const falso = correoFalso();
		const r = await conBase(async (central) => {
			await apuntarConfirmacion(central, 1, null, "t2");
			return enviarCorreoReservaWeb(ENV(central, { EMAIL: falso.EMAIL }), cancelacion());
		});
		expect(r).toBe("sin_previo");
		expect(falso.enviados).toEqual([]);
	});

	it("si el anterior salió, o está saliendo, sale", async () => {
		for (const [nombre, ok, codigo] of [["salio", 1, null], ["saliendo", 0, "enviando"]] as const) {
			const falso = correoFalso();
			const r = await conBase(async (central) => {
				await apuntarConfirmacion(central, ok, codigo);
				return enviarCorreoReservaWeb(ENV(central, { EMAIL: falso.EMAIL }), cancelacion());
			});
			expect(r, nombre).toBe("enviado");
			expect(falso.enviados.map((m) => m.subject), nombre).toEqual(["Reserva cancelada en Bar Pepe"]);
		}
	});

	it("sin `trasElCorreo`, como hasta ahora", async () => {
		const falso = correoFalso();
		const r = await conBase(async (central) =>
			enviarCorreoReservaWeb(ENV(central, { EMAIL: falso.EMAIL }), correo({ id: "rw:cancelacion:r1", tipo: "cancelacion", enlace: undefined })),
		);
		expect(r).toBe("enviado");
	});
});
