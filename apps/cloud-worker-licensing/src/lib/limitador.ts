// src/lib/limitador.ts
//
// Un binding de Rate Limiting de Cloudflare (`ratelimits` en `wrangler.json`), usado como filtro por
// IP delante de una ruta pública.
//
// Lo que es y lo que no, porque son propiedades del binding y no decisiones nuestras:
//   · Cuenta por centro de datos y es eventualmente consistente: recorta volumen, no es un control
//     exacto. Cada ruta que lo usa tiene detrás su propio tope exacto en la base.
//   · Si el binding no está o falla, deja pasar. Es lo contrario de fallar cerrado, y aquí es lo
//     correcto: detrás hay un control exacto, así que fallar abierto sólo devuelve la ruta a como
//     estaba antes del filtro, mientras que fallar cerrado la dejaría inservible por una línea de
//     configuración.

/** ¿Puede pasar `clave` (normalmente la IP)? `quien` sólo sirve para el log. */
export async function pasaElLimitador(
	limitador: RateLimit | undefined,
	clave: string,
	quien: string,
): Promise<boolean> {
	if (!limitador) return true;

	try {
		const { success } = await limitador.limit({ key: clave });
		return success;
	} catch (e: any) {
		console.error(`[${quien}] el limitador falló, se deja pasar:`, String(e?.message || e));
		return true;
	}
}
