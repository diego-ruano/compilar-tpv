// test/agendaFila.test.ts
//
// La fila de la agenda de reservas web (`agendaWeb.fila.ts`): retirar el negocio no se cuela entre
// lo que una llamada lee y lo que apunta después. Con la agenda de verdad, en
// `agendaWeb.test.ts` («retirar el negocio espera al alta que estaba a medias»).

import { describe, expect, it } from "vitest";

import { Fila } from "../src/durableObjects/agendaWeb.fila";

/** Una llamada que no acaba hasta que se le dice. */
function llamada<T>(valor: T) {
	let soltar!: () => void;
	let fallar!: (e: unknown) => void;
	const espera = new Promise<void>((ok, ko) => {
		soltar = ok;
		fallar = ko;
	});
	return { llamar: () => espera.then(() => valor), soltar, fallar };
}

const unMomento = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe("la fila de la agenda", () => {
	it("sin nada a medias, la retirada borra en el acto y las llamadas pasan sin esperar", async () => {
		const fila = new Fila();
		expect(await fila.atender(async () => "hecho")).toBe("hecho");

		let borrados = 0;
		await fila.retirar(async () => void borrados++);
		expect(borrados).toBe(1);
		expect(await fila.atender(async () => "otra")).toBe("otra");
	});

	it("la retirada espera a lo que está a medias, acabe bien o mal", async () => {
		const fila = new Fila();
		const orden: string[] = [];
		const buena = llamada("alta");
		const mala = llamada("nunca");

		const a = fila.atender(buena.llamar).then((v) => void orden.push(v));
		const b = fila.atender(mala.llamar).catch((e) => void orden.push(String(e.message)));
		const retirando = fila.retirar(async () => void orden.push("borrado"));

		await unMomento();
		expect(orden).toEqual([]);

		buena.soltar();
		await unMomento();
		// Queda una a medias: todavía no se borra.
		expect(orden).toEqual(["alta"]);

		mala.fallar(new Error("la base no contesta"));
		await Promise.all([a, b, retirando]);
		expect(orden).toEqual(["alta", "la base no contesta", "borrado"]);
	});

	it("lo que llega mientras se retira espera a que acabe, y después se atiende", async () => {
		const fila = new Fila();
		const orden: string[] = [];
		const aMedias = llamada("a medias");
		const borrado = llamada("borrado");

		const a = fila.atender(aMedias.llamar).then((v) => void orden.push(v));
		const retirando = fila.retirar(() => borrado.llamar().then((v) => void orden.push(v)));
		let empezada = false;
		const despues = fila
			.atender(async () => {
				empezada = true;
				return "después";
			})
			.then((v) => void orden.push(v));

		aMedias.soltar();
		await a;
		await unMomento();
		// Ya no hay nada a medias y se está borrando: lo que llegó después sigue sin empezar.
		expect(empezada).toBe(false);

		borrado.soltar();
		await Promise.all([retirando, despues]);
		expect(orden).toEqual(["a medias", "borrado", "después"]);
	});

	it("dos retiradas a la vez van una detrás de otra", async () => {
		const fila = new Fila();
		const orden: string[] = [];
		const primera = llamada("primera");

		const r1 = fila.retirar(() => primera.llamar().then((v) => void orden.push(v)));
		const r2 = fila.retirar(async () => void orden.push("segunda"));
		await unMomento();
		expect(orden).toEqual([]);

		primera.soltar();
		await Promise.all([r1, r2]);
		expect(orden).toEqual(["primera", "segunda"]);
	});

	it("si lo que está a medias no acaba a tiempo, la retirada falla sin borrar y la fila sigue sirviendo", async () => {
		const fila = new Fila(30);
		const colgada = llamada("colgada");
		const a = fila.atender(colgada.llamar);

		let borrados = 0;
		await expect(fila.retirar(async () => void borrados++)).rejects.toThrow("agenda_ocupada");
		expect(borrados).toBe(0);

		// Lo siguiente se atiende, y con la llamada ya acabada el siguiente intento borra.
		expect(await fila.atender(async () => "sigue")).toBe("sigue");
		colgada.soltar();
		expect(await a).toBe("colgada");
		await fila.retirar(async () => void borrados++);
		expect(borrados).toBe(1);
	});

	it("una retirada que falla no deja la fila cerrada", async () => {
		const fila = new Fila();
		await expect(
			fila.retirar(async () => {
				throw new Error("el almacenamiento no contesta");
			}),
		).rejects.toThrow("el almacenamiento no contesta");
		expect(await fila.atender(async () => "sigue")).toBe("sigue");
	});
});
