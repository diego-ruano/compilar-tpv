// test/reservasWebCorreos.test.ts
//
// Los correos al cliente de una reserva web (docs/estudios/reservas-web.md §4.8,
// `domains/reservas_web/correos.ts`):
//   · lo que dicen: sólo datos estructurados, la mesa como en el widget, el enlace sólo en la
//     confirmación, y nada del negocio sin escapar;
//   · cuánto: el tope por negocio y el de cada destinatario, contando sólo lo entregado y sólo lo
//     suyo, sin tocar el de los pedidos;
//   · que el mismo correo no sale dos veces, y que uno que falló se puede volver a intentar.

import { describe, expect, it, vi } from "vitest";

import { clienteSobre } from "./helpers/clienteSql";
import { enElHub } from "./helpers/hub";
import { prepararPlanoDeControl } from "./helpers/planoDeControl";

let baseCentral: any = null;

vi.mock("../src/server/db", async (original) => ({
	...(await (original as any)()),
	getDb: () => baseCentral,
}));

const {
	enviarCorreoReservaWeb,
	fechaLarga,
	plantilla,
	TOPE_DIARIO_DESTINATARIO,
	TOPE_DIARIO_NEGOCIO,
} = await import("../src/domains/reservas_web/correos");
const { pasaDelTope } = await import("../src/domains/email/email.routes");

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

async function conBase<T>(nombre: string, fn: (sql: any) => Promise<T>): Promise<T> {
	return enElHub(`correos-rw-${nombre}`, async (hub: any) => {
		const sql = hub.state.storage.sql;
		prepararPlanoDeControl(sql);
		sql.exec(`DELETE FROM email_sends;`);
		baseCentral = clienteSobre(sql, hub.state.storage);
		try {
			return await fn(sql);
		} finally {
			baseCentral = null;
		}
	});
}

const ENV = (extra: Record<string, unknown>) => ({ EMAIL_RESERVAS_FROM_ADDRESS: "reservas@altaria.test", ...extra }) as any;

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
		const r = await conBase("sale", async (sql) => {
			const r = await enviarCorreoReservaWeb(ENV({ EMAIL: falso.EMAIL }), correo());
			const fila = sql.exec(`SELECT * FROM email_sends;`).toArray()[0] as any;
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
		const r = await conBase("dos-veces", async () => [
			await enviarCorreoReservaWeb(ENV({ EMAIL: falso.EMAIL }), correo()),
			await enviarCorreoReservaWeb(ENV({ EMAIL: falso.EMAIL }), correo()),
		]);
		expect(r).toEqual(["enviado", "ya_enviado"]);
		expect(falso.enviados).toHaveLength(1);
	});

	it("dos envíos a la vez del mismo correo: sale uno", async () => {
		const enviados: any[] = [];
		const lento = {
			EMAIL: {
				send: async (m: any) => {
					await new Promise((r) => setTimeout(r, 5));
					enviados.push(m);
				},
			},
		};
		const r = await conBase("a-la-vez", async () =>
			Promise.all([enviarCorreoReservaWeb(ENV(lento), correo()), enviarCorreoReservaWeb(ENV(lento), correo())]),
		);
		// El segundo lo ve saliendo: en curso, no «ya enviado» (aún no se sabe si saldrá).
		expect(r.sort()).toEqual(["en_curso", "enviado"]);
		expect(enviados).toHaveLength(1);
	});

	it("uno que salió no se vuelve a enviar, ni lo deja reenviable un fallo después", async () => {
		const r = await conBase("ya-salio", async (sql) => {
			sql.exec(
				`INSERT INTO email_sends (id, tenant_id, device_id, to_email, ok, sent_at_ms, tipo)
				 VALUES ('rw:confirmacion:r1', 't1', 'web', 'ana@correo.es', 1, ?, 'reserva_web');`,
				Date.now(),
			);
			const r = await enviarCorreoReservaWeb(ENV(correoFalso(true)), correo());
			return { r, fila: sql.exec(`SELECT ok, error_code FROM email_sends;`).toArray()[0] };
		});
		expect(r).toEqual({ r: "ya_enviado", fila: { ok: 1, error_code: null } });
	});

	it("uno que se quedó a medias hace unos minutos se retoma; uno que está saliendo ahora está en curso", async () => {
		const falso = correoFalso();
		const r = await conBase("a-medias", async (sql) => {
			const apuntar = (id: string, hace: number) =>
				sql.exec(
					`INSERT INTO email_sends (id, tenant_id, device_id, to_email, ok, error_code, sent_at_ms, tipo)
					 VALUES (?, 't1', 'web', 'ana@correo.es', 0, 'enviando', ?, 'reserva_web');`,
					id,
					Date.now() - hace,
				);
			apuntar("rw:confirmacion:viejo", 10 * 60_000);
			apuntar("rw:confirmacion:ahora", 1000);
			return [
				await enviarCorreoReservaWeb(ENV({ EMAIL: falso.EMAIL }), correo({ id: "rw:confirmacion:viejo" })),
				await enviarCorreoReservaWeb(ENV({ EMAIL: falso.EMAIL }), correo({ id: "rw:confirmacion:ahora" })),
			];
		});
		// En curso no es «ya enviado»: quien lo manda lo repite, por si el otro no llega a terminarlo.
		expect(r).toEqual(["enviado", "en_curso"]);
		expect(falso.enviados).toHaveLength(1);
	});

	it("si apuntar que salió falla una vez, se insiste: no se queda «enviando» y no se puede repetir", async () => {
		const falso = correoFalso();
		const r = await conBase("terminar-insiste", async (sql) => {
			const real = baseCentral;
			let fallos = 1;
			baseCentral = {
				execute: async (q: any) => {
					if (String(q.sql).trimStart().startsWith("UPDATE email_sends") && fallos-- > 0) throw new Error("turso a ratos");
					return real.execute(q);
				},
			};
			const r = await enviarCorreoReservaWeb(ENV({ EMAIL: falso.EMAIL }), correo());
			return { r, fila: sql.exec(`SELECT ok, error_code FROM email_sends;`).toArray()[0] };
		});
		expect(r).toEqual({ r: "enviado", fila: { ok: 1, error_code: null } });
		expect(falso.enviados).toHaveLength(1);
	});

	it("sin la base central no se sabe si salió: no se envía, y es un fallo que se puede repetir", async () => {
		const falso = correoFalso();
		const r = await conBase("sin-base", async () => {
			baseCentral = { execute: async () => { throw new Error("turso caído"); } };
			return enviarCorreoReservaWeb(ENV({ EMAIL: falso.EMAIL }), correo());
		});
		expect(r).toBe("fallido");
		expect(falso.enviados).toHaveLength(0);
	});

	it("uno que falló queda apuntado sin gastar cupo, y se puede volver a intentar", async () => {
		const bueno = correoFalso();
		const r = await conBase("reintento", async (sql) => {
			const primero = await enviarCorreoReservaWeb(ENV(correoFalso(true)), correo());
			const fallo = sql.exec(`SELECT ok, error_code FROM email_sends;`).toArray()[0];
			const segundo = await enviarCorreoReservaWeb(ENV({ EMAIL: bueno.EMAIL }), correo());
			const filas = sql.exec(`SELECT ok, error_code FROM email_sends;`).toArray();
			return { primero, fallo, segundo, filas };
		});
		expect(r.primero).toBe("fallido");
		expect(r.fallo).toMatchObject({ ok: 0, error_code: "E_RATE_LIMIT_EXCEEDED" });
		expect(r.segundo).toBe("enviado");
		expect(r.filas).toEqual([{ ok: 1, error_code: null }]);
	});

	it("sin remitente configurado no sale", async () => {
		const falso = correoFalso();
		const r = await conBase("sin-remitente", async () =>
			enviarCorreoReservaWeb({ EMAIL: falso.EMAIL } as any, correo()),
		);
		expect(r).toBe("fallido");
		expect(falso.enviados).toHaveLength(0);
	});
});

describe("los topes", () => {
	function apuntar(sql: any, n: number, extra: Record<string, unknown> = {}) {
		const f = { tenant_id: "t1", to_email: "otro@correo.es", ok: 1, tipo: "reserva_web", sent_at_ms: Date.now(), ...extra } as any;
		for (let i = 0; i < n; i++) {
			sql.exec(
				`INSERT INTO email_sends (id, tenant_id, device_id, to_email, ok, sent_at_ms, tipo) VALUES (?, ?, 'web', ?, ?, ?, ?);`,
				crypto.randomUUID(),
				f.tenant_id,
				f.to_email,
				f.ok,
				f.sent_at_ms,
				f.tipo,
			);
		}
	}

	it("el del negocio corta lo de ese negocio", async () => {
		const falso = correoFalso();
		const r = await conBase("tope-negocio", async (sql) => {
			apuntar(sql, TOPE_DIARIO_NEGOCIO);
			return [
				await enviarCorreoReservaWeb(ENV({ EMAIL: falso.EMAIL }), correo()),
				await enviarCorreoReservaWeb(ENV({ EMAIL: falso.EMAIL }), correo({ tenantId: "t2", id: "rw:confirmacion:r2" })),
			];
		});
		expect(r).toEqual(["tope", "enviado"]);
	});

	it("el del destinatario corta, aunque sean de negocios distintos", async () => {
		const falso = correoFalso();
		const r = await conBase("tope-destinatario", async (sql) => {
			apuntar(sql, TOPE_DIARIO_DESTINATARIO, { tenant_id: "otro-bar", to_email: "ana@correo.es" });
			return enviarCorreoReservaWeb(ENV({ EMAIL: falso.EMAIL }), correo());
		});
		expect(r).toBe("tope");
		expect(falso.enviados).toHaveLength(0);
	});

	it("muchos envíos a la vez no pasan del tope: cuenta también lo que está saliendo", async () => {
		const enviados: any[] = [];
		const lento = { EMAIL: { send: async (m: any) => { await new Promise((r) => setTimeout(r, 5)); enviados.push(m); } } };
		const r = await conBase("tope-a-la-vez", async (sql) => {
			apuntar(sql, TOPE_DIARIO_DESTINATARIO - 1, { to_email: "ana@correo.es" });
			return Promise.all(
				Array.from({ length: 12 }, (_, i) => enviarCorreoReservaWeb(ENV(lento), correo({ id: `rw:confirmacion:x${i}` }))),
			);
		});
		expect(r.filter((x) => x === "enviado")).toHaveLength(1);
		expect(r.filter((x) => x === "tope")).toHaveLength(11);
		expect(enviados).toHaveLength(1);
	});

	it("un reintento a otra dirección cuenta para la dirección a la que sale", async () => {
		const bueno = correoFalso();
		const r = await conBase("reintento-otra", async (sql) => {
			await enviarCorreoReservaWeb(ENV(correoFalso(true)), correo({ para: "vieja@correo.es" }));
			await enviarCorreoReservaWeb(ENV({ EMAIL: bueno.EMAIL }), correo({ para: "nueva@correo.es" }));
			return sql.exec(`SELECT to_email, ok FROM email_sends;`).toArray();
		});
		expect(r).toEqual([{ to_email: "nueva@correo.es", ok: 1 }]);
		expect(bueno.enviados.map((m) => m.to)).toEqual(["nueva@correo.es"]);
	});

	it("no cuentan los que no salieron, los de ayer ni los pedidos", async () => {
		const falso = correoFalso();
		const r = await conBase("tope-no-cuentan", async (sql) => {
			apuntar(sql, TOPE_DIARIO_DESTINATARIO, { to_email: "ana@correo.es", ok: 0 });
			apuntar(sql, TOPE_DIARIO_DESTINATARIO, { to_email: "ana@correo.es", sent_at_ms: Date.now() - 25 * 3_600_000 });
			apuntar(sql, TOPE_DIARIO_DESTINATARIO, { to_email: "ana@correo.es", tipo: "pedido" });
			return enviarCorreoReservaWeb(ENV({ EMAIL: falso.EMAIL }), correo());
		});
		expect(r).toBe("enviado");
	});

	it("los correos de las reservas web no gastan el cupo de los pedidos", async () => {
		const { TOPE_DIARIO } = await import("../src/domains/email/email.routes");
		const r = await conBase("cupo-pedidos", async (sql) => {
			apuntar(sql, TOPE_DIARIO);
			return pasaDelTope(baseCentral, "t1");
		});
		expect(r).toBe(false);
	});
});
