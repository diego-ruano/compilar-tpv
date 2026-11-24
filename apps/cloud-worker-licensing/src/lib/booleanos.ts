// src/lib/booleanos.ts
//
// Un booleano guardado en una base SQLite, que no tiene ese tipo: lo guarda como 0 o 1 (y, si
// alguien lo escribió como texto, como 'true' o '1').

/** El booleano de un valor guardado como 0/1 (o como su texto). Lo que no se entiende, `fallback`. */
export function toBool01(v: any, fallback = false): boolean {
	if (typeof v === "boolean") return v;
	if (typeof v === "number") return v !== 0;
	if (typeof v === "string") {
		const s = v.trim().toLowerCase();
		if (s === "true" || s === "1") return true;
		if (s === "false" || s === "0") return false;
	}
	return fallback;
}
