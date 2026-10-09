// RI-22: candidatos a código muerto. Informa sin bloquear, como la cobertura de contratos.
// Knip recorre ficheros/exports/dependencias TS; cargo-machete sólo dependencias de Cargo.
// Un analizador que no arranca NO equivale a cero hallazgos: queda como error en el informe.
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function executionError(result) {
	if (result.error || result.signal || result.status === null) {
		return String(result.error?.message ?? result.signal ?? "sin código de salida");
	}
	return null;
}

export function readKnip(result) {
	const error = executionError(result);
	if (error || result.status !== 0) {
		return { state: "error", detail: error ?? `salida ${result.status}: ${result.stderr}`, findings: [] };
	}
	try {
		const report = JSON.parse(result.stdout);
		if (!Array.isArray(report.issues)) throw new Error("falta issues en el JSON de Knip");
		const findings = report.issues.flatMap(({ file, ...categories }) =>
			Object.entries(categories).flatMap(([category, items]) =>
				items.flat().map((item) => ({ file, category, ...item })),
			),
		);
		return { state: findings.length ? "findings" : "ok", findings, detail: result.stderr ?? "" };
	} catch (error) {
		return { state: "error", detail: `informe inválido: ${error.message}`, findings: [] };
	}
}

export function readMachete(result) {
	const error = executionError(result);
	if (error || ![0, 1].includes(result.status)) {
		return { state: "error", detail: error ?? `salida ${result.status}: ${result.stderr}`, findings: [] };
	}
	// 0 = sin candidatos, 1 = dependencias posiblemente sin uso, 2 = fallo de ejecución.
	return {
		state: result.status === 1 ? "findings" : "ok",
		findings: [],
		detail: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
	};
}

function escapeAnnotation(value) {
	return String(value).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

function run() {
	const args = process.argv.slice(2);
	if (args.some((arg) => !["--ts", "--rust"].includes(arg))) {
		throw new Error("Uso: node scripts/check-dead-code.mjs [--ts | --rust]");
	}
	const checks = [
		{
			name: "Knip", flag: "--ts", command: process.execPath,
			args: [resolve(root, "node_modules/knip/bin/knip.js"), "--config", "knip.jsonc", "--reporter", "json", "--no-exit-code"],
			read: readKnip,
		},
		{
			name: "cargo-machete", flag: "--rust", command: "cargo",
			args: ["machete", "--skip-target-dir", "."], read: readMachete,
		},
	];
	const summary = ["### Código muerto (RI-22, informativo)", "", "Son candidatos para revisar; el informe no elimina código ni bloquea CI.", ""];
	for (const check of checks.filter((check) => !args.length || args.includes(check.flag))) {
		const result = check.read(spawnSync(check.command, check.args, {
			cwd: root, encoding: "utf8", timeout: 180_000, maxBuffer: 16 * 1024 * 1024,
			env: { ...process.env, NO_COLOR: "1" },
		}));
		const verdict = result.state === "error" ? "ERROR: análisis no completado"
			: result.state === "ok" ? "sin candidatos"
				: check.name === "Knip" ? `${result.findings.length} candidatos` : "dependencias para revisar";
		console.log(`${check.name}: ${verdict}`);
		const lines = result.findings.map((item) => `${item.file}${item.line ? `:${item.line}` : ""} · ${item.category} · ${item.name}`);
		if (lines.length) console.log(lines.join("\n"));
		if (result.detail) console.log(result.detail);
		if (process.env.GITHUB_ACTIONS === "true" && result.state !== "ok") {
			console.log(`::warning title=${check.name}::${escapeAnnotation(verdict + ". Consulta el resumen del job.")}`);
		}
		summary.push(`#### ${check.name}: ${verdict}`, "", "```text", ...lines,
			// Ningún texto del analizador puede cerrar el bloque Markdown del resumen.
			result.detail.replaceAll("```", "'''"), "```", "");
	}
	if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary.join("\n") + "\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
