// test/oraculoCentral.test.ts
//
// El oráculo de equivalencia de la base central: lo que dejan hecho, con el código de hoy, las
// operaciones de la central que escriben en más de una sentencia o leen, deciden y escriben —el
// cobro de Stripe, su reversión (reembolso y disputa), el canje de una clave y la administración
// de una licencia (revocar, desrevocar, extender, acortar)—, contado por escenarios.
//
// Cada escenario se conduce SÓLO por la superficie pública del worker (peticiones HTTP a la app,
// con Stripe, el correo y los `TenantHub` sustituidos por dobles), y de él queda una foto: cada
// respuesta, cada efecto y lo que cambió en la central paso a paso, y la central entera al final.
// Las fotos están en `test/oraculo/central/` y se comparan enteras: cualquier diferencia en una
// respuesta, en un correo, en un aviso a un `TenantHub` o en una sola columna de la central hace
// fallar el escenario.
//
// Sirven para cambiar la implementación de la central sin cambiar lo que hace: con la central en
// otro sitio, se cambia `test/oraculo/montaje.ts` (dónde vive y cómo llegan a ella las rutas) y
// estos escenarios, sin tocarlos, tienen que dar las mismas fotos. Cómo se hacen comparables
// (marcadores para lo aleatorio, el reloj simulado): `test/oraculo/normalizar.ts` y
// `test/oraculo/escenario.ts`. Para regenerarlas, a sabiendas de que lo que hace la central cambia:
// `pnpm exec vitest run test/oraculoCentral.test.ts -u`.

import { describe, it } from "vitest";

import { oraculo } from "./oraculo/escenario";

describe("Stripe · un cobro se convierte en licencias", () => {
	it("una unidad: una licencia, su cobro y el correo con la clave", () =>
		oraculo("cobro-de-una-unidad", async (o) => {
			await o.comprar("cs_alta");
		}));

	it("tres unidades: tres licencias, cada una con su cobro, y un correo con las tres (RI-52)", () =>
		oraculo("cobro-de-tres-unidades", async (o) => {
			await o.comprar("cs_pack", { lineas: [{ meses: 12, unidades: 3 }] });
		}));

	it("varias líneas: cada unidad lleva la duración de la suya (RI-52)", () =>
		oraculo("cobro-de-varias-lineas", async (o) => {
			await o.comprar("cs_mixta", {
				lineas: [
					{ meses: 12, unidades: 2 },
					{ meses: 3, unidades: 1 },
				],
			});
		}));

	it("la misma sesión entregada dos veces: el mismo evento, y otro evento de la misma sesión (REV-01)", () =>
		oraculo("cobro-entregado-dos-veces", async (o) => {
			const { evento } = await o.comprar("cs_alta");
			await o.webhook(evento);
			await o.webhook(o.eventos.pagoDiferido("cs_alta"));
		}));

	it("una sesión sin pagar no emite nada hasta que Stripe la cobra", () =>
		oraculo("cobro-con-el-pago-pendiente", async (o) => {
			await o.comprar("cs_sepa", { pagada: false });
			o.pagar("cs_sepa");
			await o.webhook(o.eventos.pagoDiferido("cs_sepa"));
		}));

	it("sin `term_months` en un precio no se emite nada, tampoco al reintentar (fail-closed)", () =>
		oraculo("cobro-sin-duracion", async (o) => {
			const { evento } = await o.comprar("cs_sin_meses", { lineas: [{ meses: 12 }, { meses: null }] });
			await o.webhook(evento);
		}));

	it("si el correo falla, las licencias se emiten igual y quedan sin marcar como enviadas", () =>
		oraculo("cobro-con-el-correo-caido", async (o) => {
			o.caeElCorreo();
			await o.comprar("cs_alta", { lineas: [{ meses: 12, unidades: 2 }] });
		}));
});

describe("Stripe · un reembolso (LIC-07)", () => {
	it("total de un alta activada: la revoca, marca el cobro y avisa a su TenantHub", () =>
		oraculo("reembolso-total-de-un-alta", async (o) => {
			const bar = await o.equipo("equipo-del-bar");
			const { claves } = await o.comprar("cs_alta");
			await o.activar(claves[0], bar);
			await o.webhook(o.eventos.reembolso("cs_alta", "total"));
		}));

	it("total de una renovación canjeada: resta sus meses a la licencia que los recibió (REV-13)", () =>
		oraculo("reembolso-total-de-una-renovacion", async (o) => {
			const bar = await o.equipo("equipo-del-bar");
			const alta = await o.comprar("cs_base");
			await o.activar(alta.claves[0], bar);
			const renovacion = await o.comprar("cs_renovacion");
			await o.activar(renovacion.claves[0], bar);
			await o.webhook(o.eventos.reembolso("cs_renovacion", "total"));
		}));

	it("parcial: no toca ninguna licencia y deja dicho cuáles eran (RI-52)", () =>
		oraculo("reembolso-parcial", async (o) => {
			await o.comprar("cs_pack", { lineas: [{ meses: 12, unidades: 2 }] });
			await o.webhook(o.eventos.reembolso("cs_pack", "parcial"));
		}));

	it("entregado dos veces, y otro evento del mismo cargo: se revierte una sola vez", () =>
		oraculo("reembolso-entregado-dos-veces", async (o) => {
			const bar = await o.equipo("equipo-del-bar");
			const { claves } = await o.comprar("cs_alta");
			await o.activar(claves[0], bar);
			const reembolso = o.eventos.reembolso("cs_alta", "total");
			await o.webhook(reembolso);
			await o.webhook(reembolso);
			await o.webhook(o.eventos.reembolso("cs_alta", "total"));
		}));

	it("total de un pack con una clave canjeada: ésa resta sus meses, la otra se revoca (RI-52)", () =>
		oraculo("reembolso-de-un-pack-con-una-clave-canjeada", async (o) => {
			const bar = await o.equipo("equipo-del-bar");
			const alta = await o.comprar("cs_base");
			await o.activar(alta.claves[0], bar);
			const pack = await o.comprar("cs_pack", { lineas: [{ meses: 12, unidades: 2 }] });
			await o.activar(pack.claves[0], bar);
			await o.webhook(o.eventos.reembolso("cs_pack", "total"));
		}));

	it("de un cargo sin cobro registrado: por el cliente de Stripe, sólo si tiene una licencia", () =>
		oraculo("reembolso-de-un-cargo-sin-cobro-registrado", async (o) => {
			await o.webhook(o.eventos.reembolso("cs_desconocida", "total"));
			await o.comprar("cs_unica");
			await o.webhook(o.eventos.reembolso("cs_cargo_suelto", "total"));
			await o.comprar("cs_segunda");
			await o.webhook(o.eventos.reembolso("cs_otro_cargo_suelto", "total"));
		}));
});

describe("Stripe · una disputa (LIC-07, AUD-08, AUD-45)", () => {
	it("formal: revoca al abrirse, los fondos no la revierten otra vez, y ganarla la devuelve", () =>
		oraculo("disputa-formal-ganada", async (o) => {
			const bar = await o.equipo("equipo-del-bar");
			const { claves } = await o.comprar("cs_alta");
			await o.activar(claves[0], bar);
			await o.webhook(o.eventos.disputa("cs_alta", "created", "needs_response"));
			await o.webhook(o.eventos.disputa("cs_alta", "funds_withdrawn", "needs_response"));
			await o.webhook(o.eventos.disputa("cs_alta", "closed", "won"));
		}));

	it("formal y perdida: la licencia se queda revocada", () =>
		oraculo("disputa-formal-perdida", async (o) => {
			const bar = await o.equipo("equipo-del-bar");
			const { claves } = await o.comprar("cs_alta");
			await o.activar(claves[0], bar);
			await o.webhook(o.eventos.disputa("cs_alta", "created", "needs_response"));
			await o.webhook(o.eventos.disputa("cs_alta", "closed", "lost"));
		}));

	it("los fondos antes que la apertura: un solo efecto, llegue en el orden que llegue", () =>
		oraculo("disputa-con-los-fondos-antes-que-la-apertura", async (o) => {
			const bar = await o.equipo("equipo-del-bar");
			const { claves } = await o.comprar("cs_alta");
			await o.activar(claves[0], bar);
			await o.webhook(o.eventos.disputa("cs_alta", "funds_withdrawn", "needs_response"));
			await o.webhook(o.eventos.disputa("cs_alta", "created", "needs_response"));
		}));

	it("una consulta del banco no corta el servicio: sólo se audita (AUD-45)", () =>
		oraculo("consulta-del-banco", async (o) => {
			const bar = await o.equipo("equipo-del-bar");
			const { claves } = await o.comprar("cs_alta");
			await o.activar(claves[0], bar);
			await o.webhook(o.eventos.disputa("cs_alta", "created", "warning_needs_response"));
			await o.webhook(o.eventos.disputa("cs_alta", "created", "warning_under_review"));
			await o.webhook(o.eventos.disputa("cs_alta", "closed", "warning_closed"));
		}));

	it("una consulta que escala: revoca al salir los fondos, una vez, y vuelve si se gana (AUD-45)", () =>
		oraculo("consulta-del-banco-que-escala", async (o) => {
			const bar = await o.equipo("equipo-del-bar");
			const { claves } = await o.comprar("cs_alta");
			await o.activar(claves[0], bar);
			await o.webhook(o.eventos.disputa("cs_alta", "created", "warning_needs_response"));
			await o.webhook(o.eventos.disputa("cs_alta", "funds_withdrawn", "needs_response"));
			await o.webhook(o.eventos.disputa("cs_alta", "funds_withdrawn", "needs_response"));
			await o.webhook(o.eventos.disputa("cs_alta", "closed", "won"));
		}));

	it("una consulta que escala sin avisar de los fondos: la revierte el cierre perdido (AUD-45)", () =>
		oraculo("consulta-del-banco-perdida-sin-fondos", async (o) => {
			const bar = await o.equipo("equipo-del-bar");
			const { claves } = await o.comprar("cs_alta");
			await o.activar(claves[0], bar);
			await o.webhook(o.eventos.disputa("cs_alta", "created", "warning_needs_response"));
			await o.webhook(o.eventos.disputa("cs_alta", "closed", "lost"));
		}));

	it("revocada a mano y luego disputada: ganar la disputa no la resucita (AUD-08)", () =>
		oraculo("disputa-ganada-de-una-licencia-revocada-a-mano", async (o) => {
			const bar = await o.equipo("equipo-del-bar");
			const { claves } = await o.comprar("cs_alta");
			await o.activar(claves[0], bar);
			await o.admin(`/licenses/${await o.licenciaDeLaClave(claves[0])}/revoke`);
			await o.webhook(o.eventos.disputa("cs_alta", "created", "needs_response"));
			await o.webhook(o.eventos.disputa("cs_alta", "closed", "won"));
		}));

	it("revocada a mano con la disputa abierta: la revocación es del operador (AUD-08)", () =>
		oraculo("disputa-ganada-revocada-a-mano-con-ella-abierta", async (o) => {
			const bar = await o.equipo("equipo-del-bar");
			const { claves } = await o.comprar("cs_alta");
			await o.activar(claves[0], bar);
			await o.webhook(o.eventos.disputa("cs_alta", "created", "needs_response"));
			await o.admin(`/licenses/${await o.licenciaDeLaClave(claves[0])}/revoke`);
			await o.webhook(o.eventos.disputa("cs_alta", "closed", "won"));
		}));

	it("dos renovaciones del mismo cargo sobre la misma licencia: los meses se componen en orden", () =>
		oraculo("disputa-de-dos-renovaciones-sobre-la-misma-licencia", async (o) => {
			const bar = await o.equipo("equipo-del-bar");
			const alta = await o.comprar("cs_base");
			await o.activar(alta.claves[0], bar);
			const pack = await o.comprar("cs_pack", { lineas: [{ meses: 12, unidades: 2 }] });
			await o.activar(pack.claves[0], bar);
			await o.activar(pack.claves[1], bar);
			await o.webhook(o.eventos.disputa("cs_pack", "created", "needs_response"));
			await o.webhook(o.eventos.disputa("cs_pack", "closed", "won"));
			await o.webhook(o.eventos.reembolso("cs_pack", "total"));
		}));
});

describe("Canje de una clave sin estrenar (REV-13)", () => {
	it("sobre la licencia viva del equipo: suma sus meses, se gasta y su cobro se muda", () =>
		oraculo("canje-sobre-una-licencia-viva", async (o) => {
			const bar = await o.equipo("equipo-del-bar");
			const alta = await o.comprar("cs_base");
			await o.activar(alta.claves[0], bar);
			const renovacion = await o.comprar("cs_renovacion");
			await o.activar(renovacion.claves[0], bar);
		}));

	it("sobre una licencia caducada: vuelve a contar desde hoy", () =>
		oraculo("canje-sobre-una-licencia-caducada", async (o) => {
			const bar = await o.equipo("equipo-del-bar");
			const alta = await o.comprar("cs_base");
			await o.activar(alta.claves[0], bar);
			o.pasanDias(400);
			const renovacion = await o.comprar("cs_renovacion");
			await o.activar(renovacion.claves[0], bar);
		}));

	it("la misma clave dos veces: la segunda, 409 con «ya está sumado» (AUD-07)", () =>
		oraculo("canje-de-la-misma-clave-dos-veces", async (o) => {
			const bar = await o.equipo("equipo-del-bar");
			const alta = await o.comprar("cs_base");
			await o.activar(alta.claves[0], bar);
			const renovacion = await o.comprar("cs_renovacion");
			await o.activar(renovacion.claves[0], bar);
			await o.activar(renovacion.claves[0], bar);
		}));

	it("claves que no se canjean: la activada en otro equipo y la ya canjeada (AUD-07, RI-52)", () =>
		oraculo("canje-de-claves-que-no-se-canjean", async (o) => {
			const bar = await o.equipo("equipo-del-bar");
			const otroBar = await o.equipo("equipo-de-otro-bar");
			const sinLicencia = await o.equipo("equipo-sin-licencia");
			const mia = await o.comprar("cs_mia");
			await o.activar(mia.claves[0], bar);
			const ajena = await o.comprar("cs_ajena");
			await o.activar(ajena.claves[0], otroBar);
			await o.activar(ajena.claves[0], bar);
			await o.activar(ajena.claves[0], bar, { soloSumar: true });
			const renovacion = await o.comprar("cs_renovacion");
			await o.activar(renovacion.claves[0], bar);
			await o.activar(renovacion.claves[0], sinLicencia);
		}));

	it("desde Configuración (`soloSumar`): suma, y no estrena ni reactiva (RI-52)", () =>
		oraculo("canje-desde-configuracion", async (o) => {
			const bar = await o.equipo("equipo-del-bar");
			const sinLicencia = await o.equipo("equipo-sin-licencia");
			const alta = await o.comprar("cs_base");
			await o.activar(alta.claves[0], bar);
			const renovacion = await o.comprar("cs_renovacion");
			await o.activar(renovacion.claves[0], bar, { soloSumar: true });
			const otra = await o.comprar("cs_otra");
			await o.activar(otra.claves[0], sinLicencia, { soloSumar: true });
			await o.activar(alta.claves[0], bar, { soloSumar: true });
		}));
});

describe("Administración de una licencia", () => {
	it("revocar: avisa al TenantHub de la activada, una sola vez, y a ninguno de la que no lo está", () =>
		oraculo("admin-revocar", async (o) => {
			const bar = await o.equipo("equipo-del-bar");
			const activada = await o.emitirAMano("activada@ejemplo.test");
			await o.activar(activada.clave, bar);
			await o.admin(`/licenses/${activada.licenseId}/revoke`);
			await o.admin(`/licenses/${activada.licenseId}/revoke`);
			const sinActivar = await o.emitirAMano("sin-activar@ejemplo.test");
			await o.admin(`/licenses/${sinActivar.licenseId}/revoke`);
			await o.admin("/licenses/no-existe/revoke");
		}));

	it("desrevocar: vuelve a su estado, y se niega si no está revocada o no existe (AUD-07)", () =>
		oraculo("admin-desrevocar", async (o) => {
			const bar = await o.equipo("equipo-del-bar");
			const activada = await o.emitirAMano("activada@ejemplo.test");
			await o.activar(activada.clave, bar);
			await o.admin(`/licenses/${activada.licenseId}/revoke`);
			await o.admin(`/licenses/${activada.licenseId}/unrevoke`);
			await o.admin(`/licenses/${activada.licenseId}/unrevoke`);
			const sinActivar = await o.emitirAMano("sin-activar@ejemplo.test");
			await o.admin(`/licenses/${sinActivar.licenseId}/revoke`);
			await o.admin(`/licenses/${sinActivar.licenseId}/unrevoke`);
			const canjeada = await o.emitirAMano("canjeada@ejemplo.test");
			await o.activar(canjeada.clave, bar);
			await o.admin(`/licenses/${canjeada.licenseId}/revoke`);
			await o.admin(`/licenses/${canjeada.licenseId}/unrevoke`);
			await o.admin("/licenses/no-existe/unrevoke");
		}));

	it("desrevocar le quita al alta la marca de la disputa: un reembolso posterior la revoca (AUD-45)", () =>
		oraculo("admin-desrevocar-tras-una-disputa", async (o) => {
			const bar = await o.equipo("equipo-del-bar");
			const { claves } = await o.comprar("cs_alta");
			await o.activar(claves[0], bar);
			await o.webhook(o.eventos.disputa("cs_alta", "created", "needs_response"));
			await o.admin(`/licenses/${await o.licenciaDeLaClave(claves[0])}/unrevoke`);
			await o.webhook(o.eventos.reembolso("cs_alta", "total"));
		}));

	it("extender y acortar: sobre la caducidad, hasta dejarla caducada, y lo que se rechaza", () =>
		oraculo("admin-extender-y-acortar", async (o) => {
			const bar = await o.equipo("equipo-del-bar");
			const activada = await o.emitirAMano("activada@ejemplo.test");
			await o.activar(activada.clave, bar);
			await o.admin(`/licenses/${activada.licenseId}/extend`, { months: 12 });
			await o.admin(`/licenses/${activada.licenseId}/shorten`, { months: 3 });
			await o.admin(`/licenses/${activada.licenseId}/shorten`, { months: 24 });
			const sinActivar = await o.emitirAMano("sin-activar@ejemplo.test");
			await o.admin(`/licenses/${sinActivar.licenseId}/shorten`, { months: 1 });
			await o.admin(`/licenses/${sinActivar.licenseId}/extend`, { months: 1 });
			await o.admin("/licenses/no-existe/extend", { months: 1 });
			await o.admin("/licenses/no-existe/shorten", { months: 1 });
			await o.admin(`/licenses/${activada.licenseId}/extend`, { months: 5 });
			await o.admin(`/licenses/${activada.licenseId}/shorten`, { months: 0 });
		}));
});
