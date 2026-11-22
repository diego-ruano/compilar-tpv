// src/domains/facturas/facturas.routes.ts
//
// El PDF de cada factura completa, guardado en el bucket `IMAGES` bajo
// `{tenant}/facturas/{ID_Registro}.pdf` (`claveDeFactura.ts`). Se monta en `/v1/facturas` (`app.ts`).
//
// Lo compone la Main una vez, después del cobro o de la emisión, y lo sube aquí: es la copia
// «congelada» que vuelve a bajar un equipo restaurado, para que la factura que se enseña sea la que
// se emitió y no otra compuesta de nuevo. Las facturas sólo se ven en la Main.
//
// Rutas, las dos firmadas (JWT + device-proof) y sólo para la Main vigente:
//   - PUT  /:id        → sube el PDF del registro `id`. No sobrescribe: si ya está, contesta como
//                        hecho sin tocarlo (una factura subida no cambia).
//   - POST /descargar  → lo baja, con el id en el cuerpo.
//
// **Ninguna ruta borra una factura**: se conservan por ley. Lo único que vacía la carpeta es retirar
// un negocio de pruebas (`domains/admin/pruebas.ts`), que se lleva todo lo suyo.
//
// No tocan la base del negocio, así que no van al `TenantHub` (sin `alHub`), y por eso el veto es
// `soloLaMainVigente`, que mira además la licencia sin caché: el equipo al que se le acaba de
// trasladar no sube ni baja nada (`test/mainDesplazadaRest.test.ts`).
//
// El tope del cuerpo va delante de `tenantAuth`, que lee el cuerpo entero para comprobar la firma.

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import * as z from "zod";

import type { Env } from "../../env";
import { soloLaMainVigente, tenantAuth, type TenantVars } from "../../middleware/tenant";
import { cuerpoConIdentificador } from "../../lib/validacion";
import { claveDeFactura, ID_DE_FACTURA, idDeFactura, pareceUnPdf } from "./claveDeFactura";

type Ctx = { Bindings: Env; Variables: TenantVars };

export const facturasRoutes = new Hono<Ctx>();

/**
 * Lo más grande que se admite de un PDF de factura. La Main lo compone con las fuentes estándar del
 * PDF (no las incrusta) y, como mucho, el logo ya reducido a 1024 px: una factura de una página se
 * queda en decenas de KB. El mismo techo que una imagen, con holgura para una de muchas líneas.
 */
export const MAX_BYTES_FACTURA = 5 * 1024 * 1024;

/** El cuerpo de `/descargar` es `{ "id_registro": "<uuid>" }`: 1 KB sobra. */
const TOPE_DE_LA_DESCARGA = 1024;

/** Ninguna respuesta con una factura se guarda en una caché: es un documento del negocio. */
const SIN_CACHE = "no-store";

// ───────────────── SUBIDA ─────────────────

facturasRoutes.put(
	"/:id",
	bodyLimit({
		maxSize: MAX_BYTES_FACTURA,
		onError: (c) => c.json({ ok: false, error: "factura_demasiado_grande" }, 413),
	}),
	tenantAuth,
	soloLaMainVigente("forbidden_not_tpv", 403),
	async (c) => {
		const id = idDeFactura(c.req.param("id"));
		if (!id) return c.json({ ok: false, error: "factura_id_no_valido" }, 400);

		// Los bytes ya los ha leído `tenantAuth` para la firma (Hono los guarda): no se vuelve a leer.
		const bytes = new Uint8Array(await c.req.arrayBuffer());
		if (!pareceUnPdf(bytes)) return c.json({ ok: false, error: "factura_no_es_pdf" }, 400);

		// El negocio SIEMPRE sale del token, nunca del camino.
		const clave = claveDeFactura(c.get("tenantId"), id);

		// Una factura subida no cambia. Lo normal es que no esté (la Main sólo sube lo que no consta
		// como subido), así que se pregunta antes de escribir; y la escritura es condicional por si
		// otra subida del mismo registro se cuela entre medias: R2 no la hace si ya hay un objeto.
		if (await c.env.IMAGES.head(clave)) return c.json({ ok: true, ya_estaba: true });
		const guardada = await c.env.IMAGES.put(clave, bytes, {
			onlyIf: new Headers({ "If-None-Match": "*" }),
			httpMetadata: { contentType: "application/pdf" },
			customMetadata: { dispositivo: c.get("deviceId") },
		});
		return c.json({ ok: true, ya_estaba: guardada === null });
	},
);

// ───────────────── DESCARGA ─────────────────
//
// Un POST firmado con el id en el cuerpo, como `/v1/images/download`: el negocio sale del token, y
// en el camino no viaja nada de la factura.

facturasRoutes.post(
	"/descargar",
	bodyLimit({
		maxSize: TOPE_DE_LA_DESCARGA,
		onError: (c) => c.json({ ok: false, error: "payload_too_large" }, 413),
	}),
	tenantAuth,
	soloLaMainVigente("forbidden_not_tpv", 403),
	cuerpoConIdentificador(
		z.object({
			id_registro: z
				.string({ message: "factura_id_no_valido" })
				.regex(ID_DE_FACTURA, { message: "factura_id_no_valido" }),
		}),
	),
	async (c) => {
		const id = idDeFactura(c.req.valid("json").id_registro);
		if (!id) return c.json({ ok: false, error: "factura_id_no_valido" }, 400);

		const obj = await c.env.IMAGES.get(claveDeFactura(c.get("tenantId"), id));
		if (!obj) {
			// No está en la nube: aún no se ha subido, o es de antes de que se subieran. La Main la
			// compone entonces ella.
			return c.json({ ok: false, error: "not_found" }, 404, { "Cache-Control": SIN_CACHE });
		}

		const headers = new Headers();
		headers.set("Content-Type", "application/pdf");
		headers.set("Cache-Control", SIN_CACHE);
		headers.set("X-Content-Type-Options", "nosniff");
		if (obj.httpEtag) headers.set("ETag", obj.httpEtag);
		return new Response(obj.body, { headers });
	},
);
