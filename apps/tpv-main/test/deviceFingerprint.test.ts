// test/deviceFingerprint.test.ts
//
// La huella que el operador de la Main compara **a ojo** con la que muestra el Handy antes de
// aprobarlo. Es la red de seguridad de la ruta "solo código", donde no hay QR: si las dos huellas
// no coinciden, no se aprueba.
//
// De ahí lo que se prueba: que sea estable, que dos claves distintas no den la misma, y sobre todo
// la invariante que el propio módulo se molesta en explicar — se hashea sobre los BYTES, no sobre
// el texto base64, para que la huella salga igual aunque un lado codifique url-safe y el otro
// estándar. Si eso se rompe, las huellas dejan de coincidir y el emparejamiento se vuelve
// imposible sin que nadie entienda por qué.

import { describe, it, expect } from "vitest";

import { deviceFingerprint } from "../src/shared/lib/deviceFingerprint";

// 32 bytes (una pubkey ed25519 tiene ese tamaño) con caracteres que difieren entre las dos
// variantes de base64: el estándar usa `+` y `/`, la url-safe `-` y `_`.
const CLAVE_ESTANDAR = "+wIJEBceJSwzOkFIT1ZdZGtyeYCHjpWco6qxuL/GzdQ=";
const CLAVE_URL_SAFE = CLAVE_ESTANDAR.replace(/\+/g, "-").replace(/\//g, "_");

describe("deviceFingerprint", () => {
	it("tiene el formato que se lee en voz alta: XXXX-XXXX-XXXX", async () => {
		const huella = await deviceFingerprint(CLAVE_ESTANDAR);
		expect(huella).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
	});

	it("la misma clave da siempre la misma huella", async () => {
		expect(await deviceFingerprint(CLAVE_ESTANDAR)).toBe(
			await deviceFingerprint(CLAVE_ESTANDAR),
		);
	});

	it("url-safe y estándar dan la MISMA huella", async () => {
		// La invariante de la que depende que el operador pueda comparar: los dos lados codifican
		// el base64 a su manera, pero los bytes son los mismos.
		expect(await deviceFingerprint(CLAVE_URL_SAFE)).toBe(
			await deviceFingerprint(CLAVE_ESTANDAR),
		);
	});

	it("los espacios alrededor no cambian nada", async () => {
		// Se teclea a mano en la ruta de "solo código": un espacio pegado al pegar no puede
		// convertirlo en otro dispositivo.
		expect(await deviceFingerprint(`  ${CLAVE_ESTANDAR}  `)).toBe(
			await deviceFingerprint(CLAVE_ESTANDAR),
		);
	});

	it("dos claves distintas dan huellas distintas", async () => {
		const otra = "Aw4ZJC86RVBbZnF8h5KdqLO+ydTf6vUACxYhLDdCTVg=";
		expect(await deviceFingerprint(otra)).not.toBe(await deviceFingerprint(CLAVE_ESTANDAR));
	});

	it("una clave vacía o inválida devuelve cadena vacía, no una huella falsa", async () => {
		// Devolver "" es lo que hace que la UI enseñe un guion en vez de algo con pinta de huella
		// buena: aprobar comparando dos huellas inventadas sería peor que no comparar nada.
		expect(await deviceFingerprint("")).toBe("");
		expect(await deviceFingerprint("   ")).toBe("");
		expect(await deviceFingerprint("no-es-base64-válido-!!!")).toBe("");
	});
});
