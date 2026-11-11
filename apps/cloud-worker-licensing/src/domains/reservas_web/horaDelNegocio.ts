// src/domains/reservas_web/horaDelNegocio.ts
//
// Reservas desde la web: qué hora es en el negocio. En las rutas de siempre «ahora» lo dice el
// dispositivo que pregunta (`X-Client-Now`, REV-03); aquí pregunta un navegador cualquiera, cuya
// hora no vale para nada. Manda la zona que la Main deja en `Business_Settings.Zona_Horaria`
// (job `zona_horaria`), con el reloj del worker.

import type { Client } from "@libsql/client/web";

const ZONA_POR_DEFECTO = "Europe/Madrid";

/** La zona si el runtime la conoce; si no, la de por defecto. */
function zonaValida(zona: unknown): string {
	if (typeof zona !== "string" || !zona) return ZONA_POR_DEFECTO;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: zona });
		return zona;
	} catch {
		return ZONA_POR_DEFECTO;
	}
}

/** El instante `ms` en la hora de pared de `zona`, como `YYYY-MM-DD HH:MM:SS`. */
export function horaLocalEn(zona: string, ms: number): string {
	const partes = new Intl.DateTimeFormat("en-CA", {
		timeZone: zonaValida(zona),
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	}).formatToParts(new Date(ms));
	const p = (tipo: string) => partes.find((x) => x.type === tipo)?.value ?? "00";
	return `${p("year")}-${p("month")}-${p("day")} ${p("hour")}:${p("minute")}:${p("second")}`;
}

/** «Ahora» en el negocio, leyendo su zona de la base. */
export async function horaDelNegocio(db: Client, ahoraMs = Date.now()): Promise<string> {
	const rs = await db.execute("SELECT Zona_Horaria AS zona FROM Business_Settings WHERE ID = 1;");
	const fila: any = rs.rows?.[0];
	return horaLocalEn(zonaValida(fila?.zona ?? fila?.[0]), ahoraMs);
}
