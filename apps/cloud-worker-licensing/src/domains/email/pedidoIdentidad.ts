import type { Client } from "@libsql/client/web";
import { z } from "zod";
import { HubError } from "../../lib/errorHttp";

export type IdentidadPedido = {
	nombre: string;
	correo: string;
	direccion: string;
	telefono: string;
	proveedor: string;
};

/** RI-60: autorización y contacto salen de la misma foto de la base del negocio. */
export async function leerIdentidadPedido(db: Client, destino: string): Promise<IdentidadPedido> {
	const [proveedores, negocios] = await db.batch([
		{ sql: "SELECT Nombre_Empresa FROM Proveedores WHERE lower(trim(Email)) = lower(trim(?1)) ORDER BY ID_Proveedor LIMIT 1", args: [destino] },
		{ sql: `SELECT b.Business_Name, b.Direccion, b.Telefono, c.Contact_Email, c.Contact_Phone
			FROM Business_Settings b LEFT JOIN Contact_Settings c ON c.ID=1 WHERE b.ID=1`, args: [] },
	], "read");
	if (!proveedores.rows.length) throw new HubError("email_destino_no_autorizado", 403);
	const negocio = negocios.rows[0];
	const nombre = String(negocio?.Business_Name ?? "").trim();
	const correo = String(negocio?.Contact_Email ?? "").trim();
	if (!nombre || nombre.length > 200 || /[\r\n]/.test(nombre) ||
		!z.string().max(254).email().safeParse(correo).success) {
		throw new HubError("email_contacto_incompleto", 400);
	}
	return {
		nombre, correo,
		direccion: String(negocio?.Direccion ?? "").trim(),
		telefono: String(negocio?.Contact_Phone ?? "").trim() || String(negocio?.Telefono ?? "").trim(),
		proveedor: String(proveedores.rows[0].Nombre_Empresa ?? "").trim(),
	};
}
