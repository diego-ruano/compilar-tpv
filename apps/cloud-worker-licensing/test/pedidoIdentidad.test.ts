import { describe, expect, it } from "vitest";
import { enElHub } from "./helpers/hub";
import { clienteLocal } from "../src/durableObjects/tenantHub.sqlite";
import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { leerIdentidadPedido, type IdentidadPedido } from "../src/domains/email/pedidoIdentidad";
import { buildHtml, buildText } from "../src/domains/email/email.routes";

describe("RI-60 · identidad comercial del pedido", () => {
	it("autoriza el proveedor y exige contacto, sin dirección ni teléfono", async () => {
		await enElHub("ri60-identidad", async (hub: any) => {
			const sql = hub.state.storage.sql;
			crearEsquemaTenant(sql);
			const db = clienteLocal(hub.state.storage);
			sql.exec("INSERT INTO Proveedores (ID_Proveedor, Nombre_Empresa, Email) VALUES ('p', 'Proveedor real', 'p@proveedor.es')");
			await expect(leerIdentidadPedido(db, "otro@proveedor.es")).rejects.toMatchObject({ code: "email_destino_no_autorizado" });
			await expect(leerIdentidadPedido(db, "p@proveedor.es")).rejects.toMatchObject({ code: "email_contacto_incompleto" });
			sql.exec("UPDATE Business_Settings SET Business_Name='Bar La Plaza'");
			sql.exec("UPDATE Contact_Settings SET Contact_Email='pedidos@bar.es'");
			expect(await leerIdentidadPedido(db, " P@PROVEEDOR.ES ")).toEqual({ nombre: "Bar La Plaza", correo: "pedidos@bar.es", direccion: "", telefono: "", proveedor: "Proveedor real" });
			sql.exec("UPDATE Business_Settings SET Business_Name=?", "Bar\r\nBcc: otro@bar.es");
			await expect(leerIdentidadPedido(db, "p@proveedor.es")).rejects.toMatchObject({ code: "email_contacto_incompleto" });
		});
	});
	it("identifica también pedidos sólo con notas y escapa HTML", () => {
		const negocio: IdentidadPedido = { nombre: "Bar <Plaza>", correo: "pedidos@bar.es", proveedor: "Proveedor", direccion: "", telefono: "" };
		expect(buildText(negocio, "Lo habitual", [])).toContain("Correo: pedidos@bar.es");
		const html = buildHtml(negocio, "<script>hola</script>", []);
		expect(html).toContain("Bar &lt;Plaza&gt;");
		expect(html).not.toContain("<script>");
		expect(html).not.toContain("<table");
	});
});
