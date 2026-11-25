// scripts/tpv-license.test.mjs
//
// Lo que enseña el CLI de administración (`tpv-license.mjs`) cuando una vuelta de la base central a
// un instante no sale entera: con qué se deshace, la copia de antes y, si eso se pierde, a qué
// instante se vuelve; si quedó sin aplicar, la orden que la aplica (`--reiniciar`), que no vuelve dos
// veces; en TODAS las ramas de error, antes de terminar. También cuando no hay una respuesta que leer
// (la red, un cuerpo que no es JSON): entonces no se sabe si la vuelta se pidió, y dice cómo saberlo
// (`central:copias`, con su `pedida`) sin proponer otra vuelta.
//
// El worker es de mentira, pero lo que contesta es lo que contesta la aplicación entera, con
// `completarErrores` y el `onError`: `tpv-license.respuestas.json`, que escribe y vigila
// `apps/cloud-worker-licensing/test/centralVueltaEnElCli.test.ts`. Lo único inventado es lo que no
// sale de la aplicación: el 502 en HTML de delante y la conexión que se corta.
//
// El CLI corre copiado a una carpeta propia: busca su `.env` en la carpeta de encima de la suya, y
// ahí no hay ninguno. Del entorno sólo recibe lo que el sistema necesita para arrancar node, el token
// y la dirección del worker de mentira.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const RESPUESTAS = JSON.parse(readFileSync(new URL("./tpv-license.respuestas.json", import.meta.url), "utf8"));
const TOKEN = "token-de-pruebas";
const INSTANTE = "2026-11-25T01:30:00.000Z";

let raiz;
let cli;

before(() => {
	raiz = mkdtempSync(join(tmpdir(), "tpv-license-"));
	mkdirSync(join(raiz, "scripts"));
	cli = join(raiz, "scripts", "tpv-license.mjs");
	copyFileSync(fileURLToPath(new URL("./tpv-license.mjs", import.meta.url)), cli);
	assert.equal(existsSync(join(raiz, ".env")), false);
});

after(() => rmSync(raiz, { recursive: true, force: true }));

/** Lo que el sistema necesita para arrancar node, y nada más del entorno de quien corre el test. */
const DEL_SISTEMA = Object.fromEntries(
	Object.entries(process.env).filter(([clave]) => /^(path|systemroot|windir|temp|tmp)$/i.test(clave)),
);

/** Contesta con `status` y `cuerpo` en JSON, como el worker. */
const enJson = ({ status, cuerpo }) => (_peticion, res) => {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(cuerpo));
};

/**
 * Un worker de mentira que contesta con `contestar(peticion, res)` mientras corre `fn(base, peticiones)`.
 * Apunta cada petición que le llega, con su hora.
 */
async function conElWorker(contestar, fn) {
	const peticiones = [];
	const servidor = createServer((peticion, res) => {
		let cuerpo = "";
		peticion.on("data", (trozo) => (cuerpo += trozo));
		peticion.on("end", () => {
			peticiones.push({
				metodo: peticion.method,
				ruta: peticion.url,
				autorizacion: peticion.headers.authorization,
				cuerpo,
				llegadaMs: Date.now(),
			});
			contestar(peticion, res);
		});
	});
	await new Promise((listo) => servidor.listen(0, "127.0.0.1", listo));
	try {
		return await fn(`http://127.0.0.1:${servidor.address().port}`, peticiones);
	} finally {
		servidor.closeAllConnections();
		await new Promise((cerrado) => servidor.close(cerrado));
	}
}

/** El CLI contra `base`: su código de salida y todo lo que ha escrito. */
function cliContra(base, ...argumentos) {
	return new Promise((terminar) => {
		execFile(
			process.execPath,
			[cli, ...argumentos],
			{ env: { ...DEL_SISTEMA, ADMIN_API_TOKEN: TOKEN, TPV_API_BASE: base }, encoding: "utf8" },
			(error, stdout, stderr) => terminar({ codigo: error ? error.code : 0, salida: `${stdout}${stderr}` }),
		);
	});
}

/** Pide la vuelta a `INSTANTE` a un worker que contesta con `contestar`. */
async function volverCon(contestar) {
	const antesMs = Date.now();
	return conElWorker(contestar, async (base, peticiones) => {
		const r = await cliContra(base, "central-volver", "--instante", INSTANTE, "--si");
		// Le ha llegado lo que se pedía, con el token del test.
		assert.deepEqual(
			peticiones.map((p) => [p.metodo, p.ruta, p.autorizacion, p.cuerpo]),
			[["POST", "/v1/admin/central/volver", `Bearer ${TOKEN}`, JSON.stringify({ instanteMs: Date.parse(INSTANTE) })]],
		);
		return { ...r, antesMs, llegadaMs: peticiones[0].llegadaMs };
	});
}

/** La orden que deshace con el marcador `m`. */
const conElMarcador = (m) => `pnpm central:volver -- --marcador ${m} --si`;

/** La orden que aplica la vuelta preparada que se deshace con `m`. */
const aplicando = (m) => `pnpm central:volver -- --reiniciar ${m} --si`;

/** Aplica la vuelta preparada que se deshace con `deshacer`, contra un worker que contesta con `contestar`. */
async function aplicarCon(contestar, deshacer) {
	return conElWorker(contestar, async (base, peticiones) => {
		const r = await cliContra(base, "central-volver", "--reiniciar", deshacer, "--si");
		assert.deepEqual(
			peticiones.map((p) => [p.metodo, p.ruta, p.cuerpo]),
			[["POST", "/v1/admin/central/volver", JSON.stringify({ reiniciar: deshacer })]],
		);
		return r;
	});
}

/** Que dice a qué instante volver si se pierde el marcador, y que es el de justo antes de pedir la vuelta. */
function diceElInstanteDeAntes(r) {
	const instante = /pnpm central:volver -- --instante (\S+) --si/.exec(r.salida)?.[1];
	assert.ok(instante, `no dice a qué instante volver:\n${r.salida}`);
	const ms = Date.parse(instante);
	assert.ok(ms >= r.antesMs && ms <= r.llegadaMs, `${instante} no es de justo antes de la vuelta`);
}

test("la vuelta que ha vuelto sin atender (503 external por completarErrores) dice con qué se deshace, la copia de antes y el instante de antes", async () => {
	const respuesta = RESPUESTAS["vuelta-que-no-atiende"];
	assert.equal(respuesta.cuerpo.code, "external");
	const r = await volverCon(enJson(respuesta));
	assert.equal(r.codigo, 1);
	const { error, message, detalle, deshacer, copiaDeAntes } = respuesta.cuerpo;
	assert.ok(r.salida.includes(`✖ 503: ${error} — ${message}`), r.salida);
	assert.ok(r.salida.includes(`Motivo: ${detalle}`), r.salida);
	assert.ok(r.salida.includes(`Para deshacerla: ${conElMarcador(deshacer)}`), r.salida);
	assert.ok(r.salida.includes(`Copia de cómo estaba antes: ${copiaDeAntes}`), r.salida);
	diceElInstanteDeAntes(r);
	// Ha pasado lo que dice la respuesta: no es «no se sabe si ha entrado».
	assert.doesNotMatch(r.salida, /no se sabe si ha entrado/i);
});

test("la vuelta preparada que no se ha aplicado (503 internal) da la orden que la aplica, con qué se deshace, la copia de antes y el instante de antes", async () => {
	const respuesta = RESPUESTAS["vuelta-sin-aplicar"];
	const r = await volverCon(enJson(respuesta));
	assert.equal(r.codigo, 1);
	assert.ok(r.salida.includes(`✖ 503: central_vuelta_sin_aplicar — ${respuesta.cuerpo.message}`), r.salida);
	assert.ok(r.salida.includes(`Para aplicarla: ${aplicando(respuesta.cuerpo.deshacer)}`), r.salida);
	assert.ok(r.salida.includes(`Para anularla, o deshacerla una vez aplicada: ${conElMarcador(respuesta.cuerpo.deshacer)}`), r.salida);
	assert.ok(r.salida.includes(`Copia de cómo estaba antes: ${respuesta.cuerpo.copiaDeAntes}`), r.salida);
	assert.doesNotMatch(r.salida, /Repite la misma orden/i);
	diceElInstanteDeAntes(r);
});

for (const [que, contestar] of [
	["la llamada al objeto no vuelve (el 500 del onError)", enJson(RESPUESTAS["vuelta-sin-respuesta"])],
	[
		"lo de delante contesta un 502 que no es JSON",
		(_p, res) => {
			res.writeHead(502, { "content-type": "text/html" });
			res.end("<html><body>502 Bad Gateway</body></html>");
		},
	],
	["la conexión se corta sin respuesta", (peticion) => peticion.socket.destroy()],
]) {
	test(`si ${que}, no se sabe si la vuelta se pidió: dice cómo saberlo en R2, y no propone otra vuelta`, async () => {
		const r = await volverCon(contestar);
		assert.equal(r.codigo, 1);
		assert.match(r.salida, /No se sabe si la vuelta ha llegado a pedirse\. Míralo con pnpm central:copias/);
		assert.ok(r.salida.includes("· Si no la hay, no se ha pedido: no hay nada que deshacer."), r.salida);
		assert.ok(r.salida.includes("· Si la hay con hora en «pedida», se ha pedido."), r.salida);
		assert.ok(r.salida.includes("No repitas la vuelta sin mirarlo"), r.salida);
		// Sin nada en R2 no se ha pedido: volver a justo antes sería una vuelta de más.
		assert.doesNotMatch(r.salida, /--instante|Para deshacerla:/);
	});
}

test("aplicar la vuelta preparada (--reiniciar) dice que ha vuelto y con qué se deshace", async () => {
	const respuesta = RESPUESTAS["aplicar-la-preparada"];
	const r = await aplicarCon(enJson(respuesta), respuesta.cuerpo.deshacer);
	assert.equal(r.codigo, 0, r.salida);
	assert.ok(r.salida.includes(`✔ La vuelta preparada se ha aplicado: la central ha vuelto al marcador ${respuesta.cuerpo.destino}.`), r.salida);
	assert.ok(r.salida.includes(`Copia de cómo estaba antes: ${respuesta.cuerpo.copiaDeAntes}`), r.salida);
	assert.ok(r.salida.includes(conElMarcador(respuesta.cuerpo.deshacer)), r.salida);
});

test("aplicarla otra vez, ya aplicada, dice que no hay ninguna preparada, y nada más", async () => {
	const respuesta = RESPUESTAS["aplicar-ya-aplicada"];
	const r = await aplicarCon(enJson(respuesta), RESPUESTAS["aplicar-la-preparada"].cuerpo.deshacer);
	assert.equal(r.codigo, 1);
	assert.ok(r.salida.includes(`✖ 409: central_sin_vuelta_preparada — ${respuesta.cuerpo.message}`), r.salida);
	assert.doesNotMatch(r.salida, /No se sabe|Para aplicarla|--instante/);
});

test("si aplicarla no contesta, dice que basta con repetir esa misma orden", async () => {
	const r = await aplicarCon((peticion) => peticion.socket.destroy(), RESPUESTAS["aplicar-la-preparada"].cuerpo.deshacer);
	assert.equal(r.codigo, 1);
	assert.match(r.salida, /No se sabe si la central se ha reiniciado: mira cómo está con pnpm central:estado\./);
	assert.match(r.salida, /repite esta misma orden: si ya se ha aplicado, no hace nada\./);
	assert.doesNotMatch(r.salida, /--instante/);
});

test("central:copias enseña el marcador de la copia de antes y cuándo se pidió la vuelta", async () => {
	const respuesta = RESPUESTAS["copias-tras-la-vuelta"];
	const [copia] = respuesta.cuerpo.copias;
	await conElWorker(enJson(respuesta), async (base) => {
		const r = await cliContra(base, "central-copias");
		assert.equal(r.codigo, 0, r.salida);
		assert.ok(r.salida.includes(copia.marcador), r.salida);
		assert.ok(r.salida.includes(copia.pedida), r.salida);
		assert.ok(r.salida.includes("pedida: cuándo se le pidió aquella vuelta a la plataforma."), r.salida);
	});
});

for (const [nombre, aviso] of [
	["vuelta-sin-copia-de-antes", "✖ 500: central_copia_fallida — La copia no ha llegado a R2, y no se ha hecho nada."],
	["token-rechazado", "✖ Token rechazado. ¿ADMIN_API_TOKEN es el correcto?"],
	["sin-token-en-el-worker", "✖ El worker no tiene ADMIN_API_TOKEN configurado"],
]) {
	test(`${nombre}: la vuelta no se ha pedido, y no dice nada de deshacerla`, async () => {
		const r = await volverCon(enJson(RESPUESTAS[nombre]));
		assert.equal(r.codigo, 1);
		assert.ok(r.salida.includes(aviso), r.salida);
		assert.doesNotMatch(r.salida, /deshacer|--instante|No se sabe/i);
	});
}

test("la vuelta hecha dice con qué se deshace, la copia de antes y el instante de antes", async () => {
	const respuesta = RESPUESTAS["vuelta-hecha"];
	const r = await volverCon(enJson(respuesta));
	assert.equal(r.codigo, 0, r.salida);
	assert.ok(r.salida.includes(`✔ La central ha vuelto a ${INSTANTE}.`), r.salida);
	assert.ok(r.salida.includes(`Copia de cómo estaba antes: ${respuesta.cuerpo.copiaDeAntes}`), r.salida);
	assert.ok(r.salida.includes(conElMarcador(respuesta.cuerpo.deshacer)), r.salida);
	diceElInstanteDeAntes(r);
});

test("con la vuelta preparada y sin aplicar, central:estado da la orden exacta que la aplica (no la de la vuelta) y la que la deshace", async () => {
	const respuesta = RESPUESTAS["estado-con-la-vuelta-sin-aplicar"];
	const { preparada } = respuesta.cuerpo.enCurso.vuelta;
	await conElWorker(enJson(respuesta), async (base, peticiones) => {
		const r = await cliContra(base, "central-estado");
		assert.equal(r.codigo, 0, r.salida);
		assert.deepEqual(peticiones.map((p) => [p.metodo, p.ruta]), [["GET", "/v1/admin/central/estado"]]);
		assert.ok(r.salida.includes(`Se aplica con: ${aplicando(preparada.deshacer)}`), r.salida);
		assert.ok(r.salida.includes(`Para anularla, o deshacerla una vez aplicada: ${conElMarcador(preparada.deshacer)}`), r.salida);
		assert.doesNotMatch(r.salida, /misma orden: pnpm central:volver -- --instante/);
	});
});

/** Restaura desde una copia a un worker que contesta con `contestar`. */
function restaurarCon(contestar) {
	return conElWorker(contestar, async (base, peticiones) => {
		const r = await cliContra(base, "central-aprovisionar", "--copia", "base-central/2026-11-24.sql.gz", "--si");
		assert.deepEqual(
			peticiones.map((p) => [p.metodo, p.ruta, p.cuerpo]),
			[["POST", "/v1/admin/central/aprovisionar", JSON.stringify({ claveDeCopia: "base-central/2026-11-24.sql.gz" })]],
		);
		return r;
	});
}

test("una restauración que no contesta (el 500 del onError) dice que no se sabe cómo ha quedado, y cómo mirarlo", async () => {
	const r = await restaurarCon(enJson(RESPUESTAS["restaurar-sin-respuesta"]));
	assert.equal(r.codigo, 1);
	assert.ok(r.salida.includes("✖ 500: internal_error"), r.salida);
	assert.match(r.salida, /No se sabe cómo ha quedado la central: mírala con pnpm central:estado\. Si dice A MEDIAS/);
});

test("una restauración con una copia que no sirve dice por qué, y nada más", async () => {
	const respuesta = RESPUESTAS["restaurar-sin-copia"];
	const r = await restaurarCon(enJson(respuesta));
	assert.equal(r.codigo, 1);
	assert.ok(r.salida.includes(`✖ 422: central_copia_inservible — ${respuesta.cuerpo.message}`), r.salida);
	assert.ok(r.salida.includes(`Motivo: ${respuesta.cuerpo.detalle}`), r.salida);
	assert.doesNotMatch(r.salida, /No se sabe/);
});

test("otra orden con la central sin atender (503 external sin nada que deshacer) sigue diciendo que no se sabe si ha entrado", async () => {
	const respuesta = RESPUESTAS["copiar-a-medias"];
	await conElWorker(enJson(respuesta), async (base, peticiones) => {
		const r = await cliContra(base, "central-copiar");
		assert.equal(r.codigo, 1);
		assert.deepEqual(peticiones.map((p) => [p.metodo, p.ruta]), [["POST", "/v1/admin/central/copiar-ahora"]]);
		assert.ok(r.salida.includes(`La nube no ha podido atender ahora (${respuesta.cuerpo.error} — ${respuesta.cuerpo.message}).`), r.salida);
		assert.ok(r.salida.includes("compruébalo con pnpm central:estado antes de repetirlo."), r.salida);
		assert.ok(r.salida.includes(`Motivo: ${respuesta.cuerpo.detalle}`), r.salida);
		assert.doesNotMatch(r.salida, /deshacer|--instante/i);
	});
});
