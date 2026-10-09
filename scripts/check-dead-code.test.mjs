import assert from "node:assert/strict";
import test from "node:test";
import { readKnip, readMachete } from "./check-dead-code.mjs";

const completed = (status, stdout = "", stderr = "") => ({ status, stdout, stderr });

test("Knip distingue un informe vacío, candidatos y un fallo de configuración", () => {
	assert.equal(readKnip(completed(0, '{"issues":[]}')).state, "ok");
	const candidate = { file: "src/a.ts", exports: [{ name: "antiguo", line: 4 }], types: [] };
	const report = readKnip(completed(0, JSON.stringify({ issues: [candidate] })));
	assert.equal(report.state, "findings");
	assert.deepEqual(report.findings, [{ file: "src/a.ts", category: "exports", name: "antiguo", line: 4 }]);
	// El reporter agrupa las declaraciones duplicadas en arrays anidados.
	const duplicate = { file: "src/a.ts", duplicates: [[{ name: "default", line: 4 }, { name: "nombre", line: 4 }]] };
	assert.deepEqual(readKnip(completed(0, JSON.stringify({ issues: [duplicate] }))).findings.map((item) => item.name), ["default", "nombre"]);
	assert.equal(readKnip(completed(1, '{"issues":[]}', "ERROR cargando configuración")).state, "error");
	assert.equal(readKnip(completed(0, "JSON incompleto")).state, "error");
});

test("cargo-machete distingue su salida 1 informativa de un error de ejecución", () => {
	assert.equal(readMachete(completed(0)).state, "ok");
	assert.equal(readMachete(completed(1, "crate: dependencia sin uso")).state, "findings");
	assert.equal(readMachete(completed(2, "", "no se pudo leer Cargo.toml")).state, "error");
	assert.equal(readMachete({ status: null, error: new Error("ENOENT") }).state, "error");
	assert.equal(readMachete({ status: null, signal: "SIGTERM" }).state, "error");
});
