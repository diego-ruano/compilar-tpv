// PROD-04: lo que firma el frontend (saludo del WebSocket, emparejamiento) lleva la hora de la nube
// que calcula Rust. Si Rust no la da, se firma con la del equipo, que es lo que se hacía antes.

import { describe, expect, it } from "vitest";

import { horaParaFirmar } from "../src/shared/lib/horaParaFirmar";

describe("horaParaFirmar", () => {
	it("usa la hora que da Rust", async () => {
		const nube = 1_790_363_966_000;
		await expect(horaParaFirmar(async () => nube)).resolves.toBe(nube);
	});

	it("pregunta por el comando que Rust registra", async () => {
		const pedidos: string[] = [];
		await horaParaFirmar(async (comando) => {
			pedidos.push(comando);
			return 1;
		});
		expect(pedidos).toEqual(["device_hora_para_firmar"]);
	});

	it("si Rust falla o contesta otra cosa, la del equipo", async () => {
		for (const respuesta of [null, undefined, "no", Number.NaN, 0, -5]) {
			const antes = Date.now();
			const ts = await horaParaFirmar(async () => respuesta);
			expect(ts).toBeGreaterThanOrEqual(antes);
			expect(ts).toBeLessThanOrEqual(Date.now());
		}
		const antes = Date.now();
		const ts = await horaParaFirmar(async () => {
			throw new Error("sin backend");
		});
		expect(ts).toBeGreaterThanOrEqual(antes);
	});
});
