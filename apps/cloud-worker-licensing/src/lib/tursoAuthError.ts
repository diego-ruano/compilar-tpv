// src/lib/tursoAuthError.ts
//
// Turso no entrega aquí un código propio estable que podamos mapear al catálogo del TPV. Esta es
// la única frontera que reconoce las variantes de texto observadas para un rechazo HTTP 401.
//
// ⚠️ **Se compara la redacción COMPLETA, no la cifra suelta** (ARQ-07). Un `includes("401")` a
// secas casa con cualquier mensaje que lleve ese trozo dentro --el texto de una sentencia, un
// importe en céntimos, un identificador--, y aquí eso no es un falso positivo inocuo: en la cola
// del DO (`tenantHub.cola.ts`) esta pregunta se hace ANTES que `esRechazoPermanente`, y dar `true`
// saca al error del aislamiento por operación y se lleva el lote entero a la rotación de
// credenciales. Es el modo de fallo de REV-04, que es justo lo que esta redacción larga evita.
// Las dos copias que había (REST y DO) se unificaron en la ESTRICTA por ese motivo; `unauthorized`
// es la red que cubre lo que el REST veía de más.

/** ¿El fallo pide renovar el token de la base del tenant? (ARQ-07) */
export function isTursoAuthError(error: unknown): boolean {
	const mensaje = String((error as any)?.message ?? error ?? "").toLowerCase();

	return (
		mensaje.includes("server returned http status 401") ||
		mensaje.includes("http status 401") ||
		mensaje.includes("unauthorized")
	);
}
