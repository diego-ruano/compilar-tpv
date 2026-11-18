// apps/tpv-main/test/arranque.test.ts
//
// El arranque de la aplicación: qué pantalla se enseña, qué se le dice a quien la mira cuando la
// licencia no le deja trabajar, cuándo se da por bueno el formulario de activación y cómo se lee el
// código con el que se vincula un Handy.
//
// De la pantalla se prueban reglas de seguridad, no de maquetación: un Handy sin Main confirmada no
// trabaja, una Main no enseña la aplicación hasta que el gate deja pasar, y un aviso de caducidad
// nunca acompaña a una aplicación bloqueada. Son las que se pierden en silencio al retocar el JSX.

process.env.TZ = "Europe/Madrid";

import { describe, expect, it } from "vitest";
import type { LicenseGateResult_Serialize as LicenseGateResult, LicenseLocalState_Serialize as LicenseLocalState } from "@tpv/contracts";

import { activacionCompleta, estadoDelFormulario, FORMULARIO_VACIO } from "../src/app/arranque/activacion";
import { codigoParaVincular, leerCodigoDeVinculacion } from "../src/app/arranque/emparejamiento";
import { decidirArranque, type EntradaArranque } from "../src/app/arranque/pantallaDeArranque";
import { textoAvisoCaducidad, textoBloqueo, textoRechazoPrevio } from "../src/app/arranque/textosLicencia";
import { correoValido } from "../src/shared/lib/correo";

const gate = (allowed: boolean, reason: string, extra: Partial<LicenseGateResult> = {}): LicenseGateResult => ({
	allowed,
	reason,
	state: null,
	last_rejection: null,
	...extra,
});

const conCaducidad = (expires_at_ms: number) => ({ expires_at_ms }) as LicenseLocalState;

const entrada = (e: Partial<EntradaArranque>): EntradaArranque => ({
	modo: "tpv",
	licenciaCargando: false,
	gate: gate(true, "ok"),
	handyEmparejado: false,
	handyLeyendoVinculo: false,
	mainOnline: null,
	mainVolcando: false,
	rechazoHandy: null,
	handyYaTrabajo: false,
	...e,
});

describe("qué pantalla enseña el arranque", () => {
	it.each([
		["mientras se lee el modo", { modo: "loading" }, { tipo: "cargando" }],
		["mientras se lee la licencia", { licenciaCargando: true }, { tipo: "cargando" }],
		["un equipo sin modo elige modo", { modo: null }, { tipo: "elegir_modo" }],
		["un Handy sin emparejar vincula, aunque haya Main", { modo: "handy", mainOnline: true }, { tipo: "handy_vincular" }],
		// SYN-INC-08: un Handy vinculado que arranca sin red tarda en leer su vínculo; no se le pide vincular.
		["un Handy que aún lee su vínculo espera cargando", { modo: "handy", handyLeyendoVinculo: true }, { tipo: "cargando" }],
		[
			"un Handy que aún no sabe de la Main espera, conectando",
			{ modo: "handy", handyEmparejado: true, mainOnline: null },
			{ tipo: "handy_esperando_main", conectando: true, volcando: false, rechazo: null },
		],
		[
			"un Handy sin Main espera",
			{ modo: "handy", handyEmparejado: true, mainOnline: false },
			{ tipo: "handy_esperando_main", conectando: false, volcando: false, rechazo: null },
		],
		[
			"un Handy con la Main volcando su atraso espera (SYNC-18)",
			{ modo: "handy", handyEmparejado: true, mainOnline: true, mainVolcando: true },
			{ tipo: "handy_esperando_main", conectando: false, volcando: true, rechazo: null },
		],
		[
			"un Handy al que la nube ha revocado el acceso no está conectando: se le dice",
			{ modo: "handy", handyEmparejado: true, mainOnline: null, rechazoHandy: "dispositivo" as const },
			{ tipo: "handy_esperando_main", conectando: false, volcando: false, rechazo: "dispositivo" },
		],
		[
			"y con la licencia del negocio caída, tampoco",
			{ modo: "handy", handyEmparejado: true, mainOnline: null, rechazoHandy: "licencia" as const },
			{ tipo: "handy_esperando_main", conectando: false, volcando: false, rechazo: "licencia" },
		],
		["un Handy con Main trabaja", { modo: "handy", handyEmparejado: true, mainOnline: true }, { tipo: "handy_app", espera: null }],
		[
			// INC-20261030-014: lo que tenía abierto se conserva; la espera bloquea encima.
			"un Handy que ya trabajaba y se queda sin Main sigue con su aplicación, bloqueada",
			{ modo: "handy", handyEmparejado: true, mainOnline: false, handyYaTrabajo: true },
			{ tipo: "handy_app", espera: { conectando: false, volcando: false, rechazo: null } },
		],
		[
			"igual mientras la Main vuelca su atraso o se reconecta",
			{ modo: "handy", handyEmparejado: true, mainOnline: null, mainVolcando: true, handyYaTrabajo: true },
			{ tipo: "handy_app", espera: { conectando: true, volcando: true, rechazo: null } },
		],
		[
			"y si la nube lo rechaza, la espera encima dice por qué",
			{ modo: "handy", handyEmparejado: true, mainOnline: null, rechazoHandy: "dispositivo" as const, handyYaTrabajo: true },
			{ tipo: "handy_app", espera: { conectando: false, volcando: false, rechazo: "dispositivo" } },
		],
		[
			"sin emparejar no hay aplicación que conservar",
			{ modo: "handy", handyEmparejado: false, mainOnline: false, handyYaTrabajo: true },
			{ tipo: "handy_vincular" },
		],
		["una Main mientras se comprueba la licencia no enseña nada", { gate: null }, { tipo: "cargando" }],
		[
			"una Main sin licencia activa",
			{ gate: gate(false, "needs_activation") },
			{ tipo: "tpv_activar", rechazoPrevio: null },
		],
		[
			"una Main a la que se le anuló la licencia vuelve a activar sabiendo por qué",
			{ gate: gate(false, "needs_activation", { last_rejection: "revoked" }) },
			{ tipo: "tpv_activar", rechazoPrevio: "revoked" },
		],
		["una Main bloqueada", { gate: gate(false, "expired") }, { tipo: "tpv_bloqueada", motivo: "expired" }],
		["una Main con licencia trabaja", { gate: gate(true, "ok") }, { tipo: "tpv_app" }],
	] as [string, Partial<EntradaArranque>, object][])("%s", (_caso, e, esperada) => {
		expect(decidirArranque(entrada(e)).pantalla).toEqual(esperada);
	});

	it("la Main sólo está lista con el gate dejando pasar, y sólo entonces se quita la barra de arranque", () => {
		expect(decidirArranque(entrada({ gate: gate(true, "ok") }))).toMatchObject({ mainLista: true, conBarraDeArranque: false });
		expect(decidirArranque(entrada({ gate: gate(true, "offline_grace") }))).toMatchObject({ mainLista: true });
		for (const e of [{ gate: null }, { gate: gate(false, "expired") }, { gate: gate(false, "needs_activation") }, { modo: "handy" as const }]) {
			expect(decidirArranque(entrada(e)), JSON.stringify(e)).toMatchObject({ mainLista: false, conBarraDeArranque: true });
		}
	});

	it("un Handy sólo quita la barra de arranque cuando enseña su aplicación", () => {
		const handy = { modo: "handy" as const, handyEmparejado: true };
		expect(decidirArranque(entrada({ ...handy, mainOnline: true })).conBarraDeArranque).toBe(false);
		expect(decidirArranque(entrada({ ...handy, mainOnline: null })).conBarraDeArranque).toBe(true);
		expect(decidirArranque(entrada({ ...handy, mainOnline: true, mainVolcando: true })).conBarraDeArranque).toBe(true);
		// Con la espera encima de la aplicación también: tapa la barra propia, que mueve y cierra la ventana.
		expect(decidirArranque(entrada({ ...handy, mainOnline: false, handyYaTrabajo: true })).conBarraDeArranque).toBe(true);
	});

	it("el aviso de caducidad sólo acompaña a una Main que trabaja", () => {
		const warn = gate(true, "warn", { state: conCaducidad(123) });
		expect(decidirArranque(entrada({ gate: warn })).avisoCaducidad).toEqual({ motivo: "warn", expiresAtMs: 123 });
		expect(decidirArranque(entrada({ gate: gate(true, "expiry_grace") })).avisoCaducidad).toEqual({
			motivo: "expiry_grace",
			expiresAtMs: null,
		});
		expect(decidirArranque(entrada({ gate: gate(true, "ok") })).avisoCaducidad).toBeNull();
		expect(decidirArranque(entrada({ gate: gate(false, "warn") })).avisoCaducidad).toBeNull();
		expect(decidirArranque(entrada({ modo: "handy", gate: warn })).avisoCaducidad).toBeNull();
	});
});

describe("lo que se dice cuando la licencia bloquea", () => {
	it("cada motivo del servidor tiene su explicación, y ninguna es la genérica", () => {
		const genérica = textoBloqueo("un_motivo_que_no_existe").titulo;
		const titulos = [
			"expired",
			"revoked",
			"device_replaced",
			"bad_signature",
			"offline_expired",
			// RI-09: un «no» del servidor sin firma; no se manda a teclear la clave sino a soporte.
			"rejection_unverified",
			// REV-10: el reloj tiene su propio texto. Con el de «sin conexión» se mandaba a mirar
			// el router a alguien cuyo problema era la hora del equipo.
			"clock_skew_detected",
		].map((m) => textoBloqueo(m).titulo);
		expect(new Set(titulos).size).toBe(titulos.length);
		expect(titulos).not.toContain(genérica);
	});

	it("un reloj desfasado dice que es la hora, y cómo arreglarlo", () => {
		// Es el único motivo de esta lista que puede resolver quien está delante del TPV, así que
		// es el único que tiene sentido explicar con una instrucción.
		const t = textoBloqueo("clock_skew_detected");
		expect(t.titulo).toContain("hora");
		expect(t.cuerpo).toContain("hora automática");
		expect(t.cuerpo).not.toContain("conexión");
	});

	it("una anulación dice que basta con reintentar cuando se deshaga, sin perder datos", () => {
		expect(textoBloqueo("revoked").titulo).toBe("Licencia anulada");
		expect(textoBloqueo("revoked").cuerpo).toContain("sin perder ningún dato");
		expect(textoBloqueo("expired").titulo).toBe("Licencia caducada");
	});

	it("perder la conexión demasiado tiempo y un reloj atrasado se explican igual", () => {
		expect(textoBloqueo("clock_rollback_detected")).toEqual(textoBloqueo("offline_expired"));
	});

	it("un motivo nuevo, o un fallo al comprobar, no deja la pantalla muda", () => {
		for (const m of ["gate_error:internal", "algo_nuevo", ""]) {
			expect(textoBloqueo(m).titulo).toBe("Licencia bloqueada");
			expect(textoBloqueo(m).cuerpo.length).toBeGreaterThan(0);
		}
	});

	it("al volver a activar, se explica el rechazo anterior; en un equipo nuevo, nada", () => {
		expect(textoRechazoPrevio(null)).toBeNull();
		expect(textoRechazoPrevio("revoked")?.cuerpo).toContain("no se pierde ningún dato");
		expect(textoRechazoPrevio("device_replaced")?.titulo).toBe("Esta licencia se activó en otro equipo");
		expect(textoRechazoPrevio("un_motivo_nuevo")?.cuerpo).toContain("un_motivo_nuevo");
	});

	it("antes de activar otra licencia, se dice qué pasa con los datos de este ordenador", () => {
		// AUD-06: con la licencia anulada o trasladada, activar otra aparta lo que hay guardado y
		// el TPV sigue con los datos de esa (ninguno, si es nueva). Las dos pantallas por las que se
		// llega a teclear la clave lo avisan antes, y ninguna dice ya que activar no toca nada.
		const avisos = [
			textoBloqueo("revoked").cuerpo,
			textoBloqueo("device_replaced").cuerpo,
			textoRechazoPrevio("revoked")!.cuerpo,
			textoRechazoPrevio("device_replaced")!.cuerpo,
		];
		for (const cuerpo of avisos) {
			expect(cuerpo).toContain("se guardan aparte, sin borrarlos");
			expect(cuerpo).toContain("si es nueva, empieza de cero");
			expect(cuerpo).not.toContain("no toca lo que hay guardado");
		}
		// Lo que no tiene que ver con activar otra licencia no lo menciona.
		expect(textoBloqueo("expired").cuerpo).not.toContain("se guardan aparte");
	});
});

describe("el aviso de caducidad", () => {
	const hora = (dia: number, h: number, m = 0) => new Date(2026, 8, dia, h, m).getTime();

	it.each([
		["caduca a las 23:00 y son las 08:00", hora(15, 8), hora(15, 23), "Tu licencia caduca hoy."],
		["caduca a las 00:30 y son las 23:45", hora(15, 23, 45), hora(16, 0, 30), "Tu licencia caduca mañana."],
		["caduca pasado mañana a primera hora", hora(15, 23), hora(17, 1), "Tu licencia caduca en 2 días."],
	])("%s", (_caso, ahora, caducidad, esperado) => {
		expect(textoAvisoCaducidad({ motivo: "warn", expiresAtMs: caducidad }, ahora)).toBe(esperado);
	});

	it("sin fecha de caducidad, avisa sin inventarse un plazo", () => {
		expect(textoAvisoCaducidad({ motivo: "warn", expiresAtMs: null })).toBe("Tu licencia caduca pronto.");
	});

	it("caducada, no anuncia cuánto margen queda", () => {
		const texto = textoAvisoCaducidad({ motivo: "expiry_grace", expiresAtMs: hora(14, 12) }, hora(15, 8));
		expect(texto).not.toMatch(/\d/);
		expect(texto).not.toContain("día");
	});
});

describe("el formulario de activación", () => {
	const lleno = {
		licenseKey: "TPV-ABCDE-FGHJK-MNPQR-STVWX",
		legal_name: "Bar La Plaza S.L.",
		business_name: "Bar La Plaza",
		phone: "+34 600 000 000",
		country: "España",
	};
	const listo = { formulario: lleno, enCambioDeEquipo: false, codigoCambio: "" };

	it("con todo relleno, está listo", () => {
		expect(activacionCompleta(listo)).toBe(true);
	});

	it("le falta cualquier campo, o sólo tiene espacios, y no lo está", () => {
		expect(activacionCompleta({ ...listo, formulario: FORMULARIO_VACIO })).toBe(false);
		for (const campo of Object.keys(lleno) as (keyof typeof lleno)[]) {
			expect(activacionCompleta({ ...listo, formulario: { ...lleno, [campo]: "   " } }), campo).toBe(false);
		}
	});

	it("si la licencia está en otro equipo, pide el código completo de 6 cifras", () => {
		const cambio = { ...listo, enCambioDeEquipo: true };
		expect(activacionCompleta({ ...cambio, codigoCambio: "" })).toBe(false);
		expect(activacionCompleta({ ...cambio, codigoCambio: "12345" })).toBe(false);
		expect(activacionCompleta({ ...cambio, codigoCambio: "123456" })).toBe(true);
	});

	// LIC-INC-02: antes bastaba con que la clave no estuviera vacía, y se mandaba a la nube.
	it("una clave que no tiene la forma de una no está lista, y la etiqueta lo dice", () => {
		const mal = { ...listo, formulario: { ...lleno, licenseKey: "ABCD-EFGH-IJKL" } };
		expect(activacionCompleta(mal)).toBe(false);
		expect(estadoDelFormulario(mal)).toBe("Revisa la clave de licencia");
		expect(estadoDelFormulario(listo)).toBe("Datos completos");
		expect(estadoDelFormulario({ ...listo, formulario: FORMULARIO_VACIO })).toBe("Completa todos los campos");
		// Escrita como sea, si es una clave vale.
		expect(activacionCompleta({ ...listo, formulario: { ...lleno, licenseKey: "tpv abcde fghjk mnpqr stvwx" } })).toBe(true);
	});
});

describe("el correo de recuperación que se elige con el PIN inicial (LOGIN-08)", () => {
	it.each([
		["encargado@bar.es", true],
		["ENCARGADO@Bar-La-Plaza.com", true],
		["  espacios@bar.es  ", true],
		["sin-arroba.es", false],
		["dos@@bar.es", false],
		["con espacio@bar.es", false],
		["sin@dominio", false],
		["", false],
	])("correo «%s» → %s", (correo, esperado) => {
		expect(correoValido(correo)).toBe(esperado);
	});
});

describe("el código con el que se vincula un Handy", () => {
	it.each([
		["123456", { pairCode: "123456", pairSecret: "" }],
		[" 123456 ", { pairCode: "123456", pairSecret: "" }],
		["tpv://pair?code=123456&secret=s3cr3t", { pairCode: "123456", pairSecret: "s3cr3t" }],
		["TPV://PAIR?code=654321", { pairCode: "654321", pairSecret: "" }],
		["tpv://pair?secret=s3cr3t&code=000001", { pairCode: "000001", pairSecret: "s3cr3t" }],
	])("«%s» vale", (raw, esperado) => {
		expect(leerCodigoDeVinculacion(raw)).toEqual(esperado);
	});

	it.each([["12345"], ["1234567"], ["abcdef"], ["tpv://pair?code=12a456"], ["tpv://pair"], ["https://pair?code=123456"], [""]])(
		"«%s» no vale",
		(raw) => {
			expect(leerCodigoDeVinculacion(raw)).toBeNull();
		},
	);

	it("manda el QR; si lo pegado no vale, el código manual", () => {
		expect(codigoParaVincular("tpv://pair?code=111111&secret=s", "222222")).toEqual({ pairCode: "111111", pairSecret: "s" });
		expect(codigoParaVincular("basura", "222222")).toEqual({ pairCode: "222222", pairSecret: "" });
		expect(codigoParaVincular("", "222222")).toEqual({ pairCode: "222222", pairSecret: "" });
		expect(codigoParaVincular("basura", "")).toBeNull();
	});
});

describe("RI-09 · el rechazo sin verificar", () => {
	it("manda a soporte, no a volver a teclear la clave", () => {
		const t = textoBloqueo("rejection_unverified");
		expect(t.cuerpo).toContain("soporte");
		expect(t.cuerpo).toContain("no hace falta volver a teclear la clave");
	});
});
