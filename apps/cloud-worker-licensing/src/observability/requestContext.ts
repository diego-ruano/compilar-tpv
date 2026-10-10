import * as Sentry from "@sentry/cloudflare";
import type { Context } from "hono";
import type { EventoSentry } from "./scrub";

// RI-24 (worker): lista positiva por operación. Añadir un campo requiere decidir qué aporta al diagnóstico.
// Los nombres, notas, códigos libres e identificadores de personas nunca salen del worker.
const POLITICAS: Record<string, readonly string[]> = {
	"POST /v1/inventario/productos": ["precio_venta", "stock_minimo", "cantidad_pedido_esperada", "stock_suelto", "iva_percent", "conservar_precio"],
	"POST /v1/inventario/categorias": ["vendible", "pasa_cocina"],
	"POST /v1/inventario/lotes": ["stock_disponible", "coste_unitario"],
	"PUT /v1/inventario/lotes/:id": ["coste_unitario"],
	"PATCH /v1/inventario/lotes/:id": ["stock_visto", "stock_nuevo"],
	"PATCH /v1/inventario/productos/:id/stock-suelto": ["stock_visto", "stock_nuevo"],
	"POST /v1/cuentas/gastos": ["importe", "pagado_con_caja"],
	"PUT /v1/cuentas/gastos/:id": ["importe", "pagado_con_caja"],
	"PUT /v1/cuentas/pagos/:id": ["importe", "metodo"],
	"POST /v1/cuentas/pagos/:id/anular": ["clase"],
	"POST /v1/reservas": ["comensales"],
};
const ENUMS: Record<string, readonly string[]> = { metodo: ["Efectivo", "Tarjeta"], clase: ["ERROR", "DEVOLUCION"] };

export function seleccionarCuerpo(operacion: string, datos: unknown): Record<string, unknown> {
	const salida: Record<string, unknown> = {};
	if (!datos || typeof datos !== "object" || Array.isArray(datos)) return salida;
	for (const campo of POLITICAS[operacion] ?? []) {
		const valor = (datos as Record<string, unknown>)[campo];
		if (valor === null || typeof valor === "boolean" || (typeof valor === "number" && Number.isFinite(valor))) salida[campo] = valor;
		else if (typeof valor === "string" && ENUMS[campo]?.includes(valor)) salida[campo] = valor;
	}
	if (operacion === "POST /v1/email/enviar-pedido") {
		const d = datos as Record<string, unknown>;
		if (Array.isArray(d.lineas)) salida.numero_lineas = d.lineas.length;
		if (typeof d.notas === "string") salida.longitud_notas = d.notas.length;
	}
	return salida;
}

/** Se llama después de autenticar y validar: nunca clona ni lee otra vez el cuerpo HTTP. */
export function registrarCuerpoValidado(c: Context<any, any>, datos: unknown): void {
	const operacion = `${c.req.method} ${c.req.routePath}`;
	Sentry.getIsolationScope().setContext("request_input", seleccionarCuerpo(operacion, datos));
}

const VERSION = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/;
const VARIANTES = new Set(["windows-modern", "win7", "android"]);
export function registrarPeticion(c: Context<any, any>): void {
	const scope = Sentry.getIsolationScope();
	scope.setTag("operation", `${c.req.method} ${c.req.routePath}`);
	const version = c.req.header("X-TPV-Version");
	const variante = c.req.header("X-TPV-Variant");
	if (version && VERSION.test(version) && version.length < 80) scope.setTag("client_version", version);
	if (variante && VARIANTES.has(variante)) scope.setTag("client_variant", variante);
}

/** Defensa final, también para capturas automáticas del SDK y métodos del Durable Object. */
export function limitarPeticion<E extends EventoSentry>(evento: E): E {
	const event = evento as E & { user?: unknown; extra?: unknown; contexts?: Record<string, any>; request?: Record<string, any> };
	delete event.user;
	delete event.extra;
	if (event.request) {
		const r = event.request;
		delete r.data;
		delete r.cookies;
		delete r.query_string;
		delete r.env;
		delete r.headers;
		if (r.url) {
			const url = new URL(r.url);
			url.search = "";
			url.hash = "";
			url.username = "";
			url.password = "";
			r.url = url.toString();
		}
	}
	// La consola puede contener argumentos de negocio libres que una regex no reconoce.
	if (event.breadcrumbs) event.breadcrumbs = event.breadcrumbs.filter((b: any) => b.category !== "console").map((b: any) => {
		if (b.data?.url) {
			const url = new URL(b.data.url);
			url.search = "";
			url.username = "";
			url.password = "";
			b.data = { url: url.toString(), method: b.data.method, status_code: b.data.status_code };
		}
		return b;
	});
	for (const key of Object.keys(event.contexts ?? {})) {
		if (!["runtime", "trace", "cloudflare", "request_input"].includes(key)) delete event.contexts![key];
	}
	return evento;
}
