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

/**
 * La clave con la que se frena a quien llama desde `ip` (AUD-11).
 *
 * En IPv4, la dirección tal cual. En IPv6, su /64: es lo que recibe una conexión (una casa, un
 * móvil, un servidor), y los 64 bits de abajo los elige el propio equipo, así que contar por
 * dirección le daba a cada uno 2^64 cuentas nuevas. Sólo ensancha la clave: quien comparte un /64
 * ya comparte red, como las Handy de un bar comparten su IPv4.
 *
 * Una IPv6 se escribe de muchas formas (ceros a la izquierda, `::`, mayúsculas, una IPv4 al
 * final); todas las del mismo /64 dan la misma clave, `2001:db8:0:1::/64`. Una IPv4 escrita como
 * IPv6 (`::ffff:198.51.100.7`) es esa IPv4. Lo que no se entiende se devuelve tal cual: frena a esa
 * cadena, que es lo que se hacía antes.
 */
export function claveDeFreno(ip: string): string {
	const texto = ip.trim().toLowerCase();
	if (!texto.includes(":")) return texto;

	const grupos = gruposIpv6(texto.replace(/^\[|\]$/g, "").split("%")[0]);
	if (!grupos) return texto;

	const esIpv4 = grupos.slice(0, 5).every((g) => g === 0) && grupos[5] === 0xffff;
	if (esIpv4) return [grupos[6] >> 8, grupos[6] & 0xff, grupos[7] >> 8, grupos[7] & 0xff].join(".");

	return `${grupos
		.slice(0, 4)
		.map((g) => g.toString(16))
		.join(":")}::/64`;
}

/**
 * La red amplia de una IPv6: su /48, `2001:db8:1::/48`. Es lo más que suele tener una sola persona
 * (un túnel gratuito da un /48 entero; una casa recibe un /56, 256 /64), así que un tope que cuente
 * sólo por /64 se esquiva cambiando de /64 dentro de la propia red (RW-ALTAS). `null` en una IPv4
 * (también la escrita como IPv6) o en lo que no se entiende: ahí no hay una red mayor que contar sin
 * juntar a desconocidos (un /24 de IPv4 es el CGNAT de un operador).
 */
export function redAmpliaIpv6(ip: string): string | null {
	const texto = ip.trim().toLowerCase();
	if (!texto.includes(":")) return null;
	const grupos = gruposIpv6(texto.replace(/^\[|\]$/g, "").split("%")[0]);
	if (!grupos) return null;
	const esIpv4 = grupos.slice(0, 5).every((g) => g === 0) && grupos[5] === 0xffff;
	if (esIpv4) return null;
	return `${grupos
		.slice(0, 3)
		.map((g) => g.toString(16))
		.join(":")}::/48`;
}

/** Los ocho grupos de 16 bits de una IPv6, o `null` si no lo es. */
function gruposIpv6(texto: string): number[] | null {
	const partes = texto.split("::");
	if (partes.length > 2) return null;

	const leer = (trozo: string): number[] | null => {
		if (trozo === "") return [];
		const salida: number[] = [];
		const piezas = trozo.split(":");
		for (let i = 0; i < piezas.length; i++) {
			const p = piezas[i];
			// Una IPv4 sólo puede ir al final, y ocupa dos grupos.
			if (i === piezas.length - 1 && p.includes(".")) {
				const o = p.split(".");
				if (o.length !== 4 || o.some((x) => !/^\d{1,3}$/.test(x) || Number(x) > 255)) return null;
				const [a, b, c, d] = o.map(Number);
				salida.push((a << 8) | b, (c << 8) | d);
			} else if (/^[0-9a-f]{1,4}$/.test(p)) {
				salida.push(parseInt(p, 16));
			} else {
				return null;
			}
		}
		return salida;
	};

	const cabeza = leer(partes[0]);
	const cola = partes.length === 2 ? leer(partes[1]) : [];
	if (!cabeza || !cola) return null;

	const faltan = 8 - cabeza.length - cola.length;
	if (partes.length === 1 ? faltan !== 0 : faltan < 1) return null;
	return [...cabeza, ...Array<number>(faltan).fill(0), ...cola];
}

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
