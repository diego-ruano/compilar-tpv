// test/oraculo/escenario.ts
//
// El arnés del oráculo de la base central (`test/oraculoCentral.test.ts`).
//
// Un escenario es una historia contada SÓLO por la superficie pública del worker: peticiones HTTP a
// la app (`app.fetch`), con Stripe, el correo y los `TenantHub` sustituidos por dobles que apuntan
// lo que se les pide. De cada escenario queda, por orden:
//
//   · cada paso: la petición, la respuesta (estado y JSON), los correos que salieron, lo que se le
//     pidió a un `TenantHub` y lo que cambió en la central (filas nuevas, cambiadas y borradas);
//   · la foto final de TODAS las tablas de la central, cada una con sus filas en el orden en que se
//     insertaron.
//
// Todo pasa por `normalizar.ts` y se compara con su instantánea en `test/oraculo/central/`. La
// central la pone `montaje.ts`, que es lo único que cambia cuando cambie la central.
//
// El reloj es simulado (sólo `Date`): el escenario empieza a las 00:00 UTC de un día fijo y avanza
// un minuto exacto antes de cada petición, o los días que diga el escenario. Así la salida no
// depende del día en que se ejecute: sumar 12 meses da siempre la misma fecha.

import { expect, vi } from "vitest";

// El montaje va antes que la app: cambia cómo llegan las rutas a la central, y eso tiene que estar
// hecho cuando se carguen.
import { conLaCentral, type Central } from "./montaje";
import { normalizar } from "./normalizar";
import { activacionFirmada, clavePublica } from "../helpers/activar";
import { app } from "../../src/app";
import type { Env } from "../../src/env";

/** Las 00:00 UTC del 2 de marzo de 2026: un día que no se recorta al sumar o restar meses. */
const T0 = Date.UTC(2026, 2, 2);
const MINUTO = 60 * 1000;
const DIA = 24 * 60 * MINUTO;

const CLAVE_DE_ALMACEN = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const TOKEN_DE_ADMINISTRACION = "token-de-administracion-del-oraculo";
const SECRETO_DEL_WEBHOOK = "whsec_del_oraculo";
const CLIENTE_DE_STRIPE = "cus_oraculo";
/** Lo que cuesta cada licencia en la sesión simulada, en céntimos. Sólo cuenta para los reembolsos. */
const IMPORTE_POR_UNIDAD = 12_000;

/** Lo primero de cada foto: cómo leerla. El detalle, en `normalizar.ts`. */
const CABECERA =
	"Salida del oráculo de la central (test/oraculoCentral.test.ts): cada paso con su petición, su " +
	"respuesta, sus correos, lo que se pidió a un TenantHub y lo que cambió en la central; después, la " +
	"central entera. Lo aleatorio va con marcadores ‹…› numerados por orden de aparición (ids; cada " +
	"clave con su hash, su forma corta y su cifrado; las DEK; los tokens, abiertos). Los instantes, como " +
	"T0±Nd hh:mm: días desde el primero del escenario y hora UTC, con un reloj simulado que empieza a " +
	"las 00:00 y avanza un minuto antes de cada petición. Detalle: test/oraculo/normalizar.ts.";

type Respuesta = { status: number; cuerpo: any };

/** Un equipo: su identificador y la clave pública con la que firma (la privada, en `helpers/activar.ts`). */
type Equipo = { deviceId: string; devicePubKey: string };

/** Una línea de una compra: los meses de su precio (`null`: un precio sin `term_months`) y cuántas. */
type Linea = { meses: number | null; unidades?: number };

type Compra = {
	/** Por defecto, una licencia anual. */
	lineas?: Linea[];
	/** `false`: el checkout se completa con el pago pendiente (SEPA y otros diferidos). */
	pagada?: boolean;
};

type EventoDeStripe = {
	id: string;
	object: "event";
	type: string;
	data: { object: Record<string, unknown> };
};

type TipoDeDisputa = "created" | "funds_withdrawn" | "closed";

type Oraculo = {
	/** Un equipo nuevo del escenario (sus claves salen de su número de orden: siempre las mismas). */
	equipo: (nombre: string) => Promise<Equipo>;
	/**
	 * Alguien paga una sesión de checkout y Stripe entrega `checkout.session.completed`. Devuelve la
	 * respuesta, el evento (para volver a entregarlo) y las claves que llegaron por correo.
	 */
	comprar: (sesionId: string, compra?: Compra) => Promise<Respuesta & { evento: EventoDeStripe; claves: string[] }>;
	/** Stripe cobra por fin una sesión que se completó con el pago pendiente. No es una petición. */
	pagar: (sesionId: string) => void;
	/** Stripe entrega un evento, firmado como lo firma Stripe. */
	webhook: (evento: EventoDeStripe) => Promise<Respuesta>;
	/** Los eventos de Stripe sobre el cargo de una sesión (`pi_<sesión>`), cada uno con su propio id. */
	eventos: {
		pagoDiferido: (sesionId: string) => EventoDeStripe;
		reembolso: (sesionId: string, cuanto: "total" | "parcial") => EventoDeStripe;
		disputa: (sesionId: string, tipo: TipoDeDisputa, status: string) => EventoDeStripe;
	};
	/** `POST /v1/license/activate`, firmada por el equipo. */
	activar: (clave: string, equipo: Equipo, extra?: Record<string, unknown>) => Promise<Respuesta>;
	/** `POST /v1/admin/licenses`: una licencia anual emitida a mano, con su clave. */
	emitirAMano: (email: string) => Promise<{ licenseId: string; clave: string }>;
	/** `POST /v1/admin<ruta>` con el token de administración. */
	admin: (ruta: string, cuerpo?: unknown) => Promise<Respuesta>;
	/**
	 * El id de la licencia de una clave, buscado en `GET /v1/admin/licenses`. Es una lectura para
	 * poder pedir algo después a la administración: no es un paso del escenario.
	 */
	licenciaDeLaClave: (clave: string) => Promise<string>;
	/** El reloj salta `dias` días. */
	pasanDias: (dias: number) => void;
	/** A partir de ahora, el servicio de correo falla. */
	caeElCorreo: () => void;
};

type Correo = { para: string; asunto: string; texto: string; entregado?: false };
type LlamadaAlHub = { negocio: string; metodo: string; argumentos: unknown[] };
type Fila = Record<string, unknown>;
/** Una tabla: sus filas por `rowid`, en orden. */
type Tabla = Map<number, Fila>;
type Cambio = { nueva: Fila } | { borrada: Fila } | { cambiada: Fila; antes: Fila };

const COLUMNA_ROWID = "_rowid_del_oraculo";

/** Un valor de la central, comparable con `===`: un BLOB, como su contenido en hexadecimal. */
function comparable(valor: unknown): unknown {
	return valor instanceof ArrayBuffer ? `‹blob ${hex(valor)}›` : valor;
}

/** La central entera: cada tabla, con sus filas en el orden en que se insertaron. */
async function leerCentral(central: Central): Promise<Map<string, Tabla>> {
	const tablas = new Map<string, Tabla>();
	for (const tabla of [...central.tablas].sort()) {
		const { columnas, filas } = await central.leer(
			`SELECT rowid AS ${COLUMNA_ROWID}, * FROM "${tabla}" ORDER BY rowid;`,
		);
		const deDatos = columnas.filter((c) => c !== COLUMNA_ROWID);
		tablas.set(
			tabla,
			new Map(
				filas.map((f) => [Number(f[COLUMNA_ROWID]), Object.fromEntries(deDatos.map((c) => [c, comparable(f[c])]))]),
			),
		);
	}
	return tablas;
}

/**
 * Lo que cambió en la central entre dos lecturas, por tabla y en orden de `rowid`. Una fila cambiada
 * se enseña con su primera columna (la que la identifica en todas las tablas de la central) y las
 * columnas que cambian; `antes`, con lo que tenían.
 */
function cambiosEntre(antes: Map<string, Tabla>, despues: Map<string, Tabla>): Record<string, Cambio[]> {
	const cambios: Record<string, Cambio[]> = {};
	for (const [tabla, filas] of despues) {
		const previas = antes.get(tabla) ?? new Map<number, Fila>();
		const rowids = [...new Set([...previas.keys(), ...filas.keys()])].sort((a, b) => a - b);
		const lista: Cambio[] = [];
		for (const rowid of rowids) {
			const previa = previas.get(rowid);
			const actual = filas.get(rowid);
			if (!previa) lista.push({ nueva: actual! });
			else if (!actual) lista.push({ borrada: previa });
			else {
				const columnas = Object.keys(actual).filter((c) => previa[c] !== actual[c]);
				if (columnas.length === 0) continue;
				const [identificador] = Object.keys(actual);
				lista.push({
					cambiada: Object.fromEntries(
						[identificador, ...columnas.filter((c) => c !== identificador)].map((c) => [c, actual[c]]),
					),
					antes: Object.fromEntries(columnas.map((c) => [c, previa[c]])),
				});
			}
		}
		if (lista.length > 0) cambios[tabla] = lista;
	}
	return cambios;
}

function hex(bytes: ArrayBuffer): string {
	return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** La cabecera `stripe-signature` de un cuerpo, como la calcula Stripe: HMAC-SHA256 de `t.cuerpo`. */
async function firmaDeStripe(cuerpo: string): Promise<string> {
	const t = Math.floor(Date.now() / 1000);
	const clave = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(SECRETO_DEL_WEBHOOK),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return `t=${t},v1=${hex(await crypto.subtle.sign("HMAC", clave, new TextEncoder().encode(`${t}.${cuerpo}`)))}`;
}

/** Las claves de licencia que lleva un texto, en orden. */
function clavesEn(texto: string): string[] {
	return [...texto.matchAll(/TPV-[0-9A-Z]{5}(?:-[0-9A-Z]{5}){3}/g)].map((m) => m[0]);
}

/**
 * Corre el escenario `nombre` y compara su salida normalizada con `test/oraculo/central/<nombre>.json`
 * (`-u` la escribe).
 */
export async function oraculo(nombre: string, guion: (o: Oraculo) => Promise<void>): Promise<void> {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(T0);
	try {
		const conocidos = new Map<string, string>();
		const salida = await conLaCentral(nombre, (central) => contar(central, conocidos, guion));
		const normalizada = await normalizar(salida, { t0: T0, conocidos, claveDeAlmacen: CLAVE_DE_ALMACEN });
		const foto = { normalizacion: CABECERA, ...(normalizada as object) };
		// La ruta es relativa al fichero de tests, `test/oraculoCentral.test.ts`.
		await expect(`${JSON.stringify(foto, null, "\t")}\n`).toMatchFileSnapshot(`./oraculo/central/${nombre}.json`);
	} finally {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	}
}

/** Cuenta la historia del escenario sobre su central y devuelve la salida sin normalizar. */
async function contar(
	central: Central,
	conocidos: Map<string, string>,
	guion: (o: Oraculo) => Promise<void>,
): Promise<unknown> {
	const pasos: unknown[] = [];
	let numeroDePaso = 0;
	let estado = await leerCentral(central);
	/** A qué correo se mandó cada clave: el de su comprador (o el de quien la emitió a mano). */
	const destinatarioDe = new Map<string, string>();

	// ── Lo que se apunta durante una petición ──
	let correos: Correo[] = [];
	let llamadasAlHub: LlamadaAlHub[] = [];
	let enSegundoPlano: Promise<unknown>[] = [];

	// ── El correo ──
	let correoCaido = false;
	const correo = {
		async send(mensaje: { to: string; subject: string; text: string }) {
			correos.push({
				para: mensaje.to,
				asunto: mensaje.subject,
				texto: mensaje.text,
				...(correoCaido ? { entregado: false as const } : {}),
			});
			if (correoCaido) throw new Error("El servicio de correo no contesta.");
		},
	};

	// ── Los TenantHub: apuntan todo lo que se les pide; sólo saben si su negocio tiene base ──
	const conBase = new Set<string>();
	const atender = (negocio: string, metodo: string): unknown => {
		switch (metodo) {
			case "estaAprovisionado":
				return conBase.has(negocio);
			case "aprovisionar": {
				const reused = conBase.has(negocio);
				conBase.add(negocio);
				return { reused };
			}
			case "releerMain":
			case "revocarDispositivo":
				return undefined;
			default:
				throw new Error(`El TenantHub del oráculo no sabe atender «${metodo}».`);
		}
	};
	const tenantHub = {
		idFromName: (nombre: string) => ({ nombre }),
		get: ({ nombre }: { nombre: string }) =>
			new Proxy(
				{},
				{
					get: (_objeto, metodo) =>
						typeof metodo !== "string" || metodo === "then"
							? undefined
							: async (...argumentos: unknown[]) => {
									llamadasAlHub.push({ negocio: nombre, metodo, argumentos });
									return atender(nombre, metodo);
								},
				},
			),
	};

	// ── Stripe: las sesiones que relee el webhook ──
	const sesiones = new Map<string, Record<string, unknown>>();
	const unidadesDe = new Map<string, number>();
	const fetchDeLaSuite = globalThis.fetch;
	vi.stubGlobal("fetch", async (entrada: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(entrada instanceof Request ? entrada.url : String(entrada));
		const ruta = /^\/v1\/checkout\/sessions\/([^/]+)$/.exec(url.pathname);
		if (url.origin !== "https://api.stripe.com" || !ruta) return fetchDeLaSuite(entrada, init);
		const sesion = sesiones.get(decodeURIComponent(ruta[1]));
		return sesion
			? Response.json(sesion)
			: Response.json({ error: { type: "invalid_request_error", code: "resource_missing" } }, { status: 404 });
	});
	let eventosEmitidos = 0;
	const evento = (type: string, object: Record<string, unknown>): EventoDeStripe => ({
		id: `evt_${++eventosEmitidos}`,
		object: "event",
		type,
		data: { object },
	});
	const importeDe = (sesionId: string) => IMPORTE_POR_UNIDAD * (unidadesDe.get(sesionId) ?? 1);

	const env = {
		...central.entorno,
		LICENSE_STORE_KEY: CLAVE_DE_ALMACEN,
		LICENSE_JWT_SECRET: "secreto-de-sesion-del-oraculo-con-longitud-suficiente",
		ADMIN_API_TOKEN: TOKEN_DE_ADMINISTRACION,
		STRIPE_SECRET_KEY: "sk_test_del_oraculo",
		STRIPE_WEBHOOK_SECRET: SECRETO_DEL_WEBHOOK,
		EMAIL_FROM_ADDRESS: "licencias@correo.invalid",
		EMAIL_FROM_NAME: "TPV",
		EMAIL: correo,
		TenantHub: tenantHub,
		JURISDICCION_DO: "",
		UBICACION_DO: "",
	} as unknown as Env;
	const ctx = {
		waitUntil: (promesa: Promise<unknown>) => {
			enSegundoPlano.push(promesa);
		},
		passThroughOnException: () => {},
		props: {},
	} as unknown as ExecutionContext;

	/** Manda una petición a la app y espera también lo que deja en `waitUntil`. */
	async function enviar(metodo: string, ruta: string, init: { cabeceras?: Record<string, string>; cuerpo?: string }) {
		correos = [];
		llamadasAlHub = [];
		enSegundoPlano = [];
		const res = await app.fetch(
			new Request(`https://tpv-api.invalid${ruta}`, { method: metodo, headers: init.cabeceras, body: init.cuerpo }),
			env,
			ctx,
		);
		const texto = await res.text();
		let cuerpo: unknown;
		try {
			cuerpo = JSON.parse(texto);
		} catch {
			cuerpo = texto;
		}
		const fallos = (await Promise.allSettled(enSegundoPlano))
			.filter((r): r is PromiseRejectedResult => r.status === "rejected")
			.map((r) => String((r.reason as Error)?.message ?? r.reason));
		return { respuesta: { status: res.status, cuerpo } as Respuesta, fallos };
	}

	/** Un paso del escenario: el reloj avanza un minuto, se manda la petición y se apunta todo. */
	async function paso(
		metodo: string,
		ruta: string,
		preparar: () => Promise<{ cabeceras?: Record<string, string>; cuerpo?: string }>,
	): Promise<Respuesta & { correos: Correo[] }> {
		vi.setSystemTime(Date.now() + MINUTO);
		const init = await preparar();
		const { respuesta, fallos } = await enviar(metodo, ruta, init);
		const ahora = await leerCentral(central);
		const cambios = cambiosEntre(estado, ahora);
		estado = ahora;
		for (const c of correos) for (const clave of clavesEn(c.texto)) destinatarioDe.set(clave, c.para);
		pasos.push({
			paso: ++numeroDePaso,
			peticion: `${metodo} ${ruta}`,
			...(init.cuerpo === undefined ? {} : { cuerpo: JSON.parse(init.cuerpo) }),
			respuesta,
			...(correos.length > 0 ? { correos } : {}),
			...(llamadasAlHub.length > 0 ? { tenantHub: llamadasAlHub } : {}),
			...(fallos.length > 0 ? { fallosEnSegundoPlano: fallos } : {}),
			...(Object.keys(cambios).length > 0 ? { cambios } : {}),
		});
		return { ...respuesta, correos };
	}

	const deAdministracion = (cuerpo: unknown) => ({
		cabeceras: { authorization: `Bearer ${TOKEN_DE_ADMINISTRACION}`, "content-type": "application/json" },
		cuerpo: JSON.stringify(cuerpo),
	});

	const webhook = async (ev: EventoDeStripe) =>
		paso("POST", "/v1/stripe/webhook", async () => {
			const cuerpo = JSON.stringify(ev);
			return {
				cabeceras: { "stripe-signature": await firmaDeStripe(cuerpo), "content-type": "application/json" },
				cuerpo,
			};
		});

	let equipos = 0;
	const o: Oraculo = {
		async equipo(nombre) {
			const devicePubKey = await clavePublica(++equipos);
			conocidos.set(devicePubKey, `‹clave pública de ${nombre}›`);
			return { deviceId: nombre, devicePubKey };
		},

		async comprar(sesionId, { lineas = [{ meses: 12 }], pagada = true } = {}) {
			sesiones.set(sesionId, {
				id: sesionId,
				object: "checkout.session",
				payment_status: pagada ? "paid" : "unpaid",
				customer: CLIENTE_DE_STRIPE,
				payment_intent: `pi_${sesionId}`,
				customer_details: {
					email: `${sesionId.replace(/_/g, "-")}@ejemplo.test`,
					name: "Bar de pruebas",
					business_name: "Bar de Pruebas S.L.",
					phone: "+34 600 000 000",
					address: { line1: "Calle Mayor 1", city: "Madrid", postal_code: "28013", country: "ES" },
				},
				line_items: {
					object: "list",
					has_more: false,
					data: lineas.map(({ meses, unidades = 1 }) => ({
						quantity: unidades,
						price:
							meses === null
								? { id: "price_sin_duracion", metadata: {} }
								: { id: `price_${meses}_meses`, metadata: { term_months: String(meses) } },
					})),
				},
			});
			unidadesDe.set(
				sesionId,
				lineas.reduce((total, { unidades = 1 }) => total + unidades, 0),
			);
			// El evento lleva lo que el webhook lee de él; la sesión entera la relee de Stripe.
			const ev = evento("checkout.session.completed", {
				id: sesionId,
				object: "checkout.session",
				payment_status: pagada ? "paid" : "unpaid",
			});
			const r = await webhook(ev);
			return { ...r, evento: ev, claves: r.correos.flatMap((c) => clavesEn(c.texto)) };
		},

		pagar(sesionId) {
			const sesion = sesiones.get(sesionId);
			if (!sesion) throw new Error(`Stripe no tiene la sesión ${sesionId}.`);
			sesion.payment_status = "paid";
		},

		webhook,

		eventos: {
			pagoDiferido: (sesionId) =>
				evento("checkout.session.async_payment_succeeded", {
					id: sesionId,
					object: "checkout.session",
					payment_status: "paid",
				}),
			reembolso: (sesionId, cuanto) =>
				evento("charge.refunded", {
					id: `ch_${sesionId}`,
					object: "charge",
					payment_intent: `pi_${sesionId}`,
					customer: CLIENTE_DE_STRIPE,
					amount: importeDe(sesionId),
					amount_refunded: cuanto === "total" ? importeDe(sesionId) : IMPORTE_POR_UNIDAD / 2,
				}),
			// El objeto Dispute de Stripe lleva el cargo y el PaymentIntent, y no el cliente.
			disputa: (sesionId, tipo, status) =>
				evento(`charge.dispute.${tipo}`, {
					id: `du_${sesionId}`,
					object: "dispute",
					charge: `ch_${sesionId}`,
					payment_intent: `pi_${sesionId}`,
					amount: importeDe(sesionId),
					status,
				}),
		},

		async activar(clave, equipo, extra = {}) {
			return paso("POST", "/v1/license/activate", async () => {
				const peticion = await activacionFirmada({
					activationKey: clave,
					deviceId: equipo.deviceId,
					devicePubKey: equipo.devicePubKey,
					tenantInfo: { displayName: "Bar de pruebas", legalName: "Bar de Pruebas S.L.", country: "ES" },
					...extra,
				});
				return { cabeceras: peticion.headers, cuerpo: peticion.body };
			});
		},

		async emitirAMano(email) {
			const r = await paso("POST", "/v1/admin/licenses", async () =>
				deAdministracion({ termMonths: 12, email, name: "Bar a mano" }),
			);
			if (r.status !== 200) throw new Error(`La administración no ha emitido la licencia: ${r.status}.`);
			const clave = String(r.cuerpo.key);
			destinatarioDe.set(clave, email);
			return { licenseId: String(r.cuerpo.licenseId), clave };
		},

		admin: (ruta, cuerpo = {}) => paso("POST", `/v1/admin${ruta}`, async () => deAdministracion(cuerpo)),

		async licenciaDeLaClave(clave) {
			const { respuesta } = await enviar("GET", "/v1/admin/licenses?limit=200", {
				cabeceras: { authorization: `Bearer ${TOKEN_DE_ADMINISTRACION}` },
			});
			if (correos.length + llamadasAlHub.length > 0) throw new Error("Listar las licencias ha tenido efectos.");
			// La forma corta sólo lleva los cuatro últimos símbolos: con el correo del comprador,
			// dos claves del escenario que acaben igual no se confunden.
			const deEsaClave = (
				respuesta.cuerpo.licenses as { licenseId: string; keyShort: string; customerEmail: string }[]
			).filter((l) => l.keyShort === `TPV-…-${clave.slice(-4)}` && l.customerEmail === destinatarioDe.get(clave));
			if (deEsaClave.length !== 1) {
				throw new Error(`Hay ${deEsaClave.length} licencias cuya clave acaba como ésta: no se sabe cuál es.`);
			}
			return deEsaClave[0].licenseId;
		},

		pasanDias(dias) {
			vi.setSystemTime(Date.now() + dias * DIA);
			pasos.push({ reloj: `pasan ${dias} días` });
		},

		caeElCorreo() {
			correoCaido = true;
		},
	};

	await guion(o);
	return { pasos, central: fotoFinal(estado) };
}

/** La foto final: todas las tablas, en orden alfabético, con sus filas en orden de inserción. */
function fotoFinal(estado: Map<string, Tabla>): Record<string, Fila[]> {
	return Object.fromEntries([...estado].map(([tabla, filas]) => [tabla, [...filas.values()]]));
}
