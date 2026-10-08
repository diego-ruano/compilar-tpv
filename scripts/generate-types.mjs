// RI-87: Specta es el único generador. Separamos tipos compartidos de transporte Tauri,
// para que el Worker y el E2E puedan importar contratos sin cargar una webview.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ts = createRequire(join(raiz, "apps/tpv-main/package.json"))("typescript");
const temporal = mkdtempSync(join(tmpdir(), "tpv-contratos-"));
const comprobar = process.argv.includes("--check");
const cabecera = "// Generado por pnpm generate-types desde Rust y tauri-specta. No editar.\n\n";

function limpiarTemporal() {
    const destino = realpathSync(temporal);
    if (dirname(destino) !== realpathSync(tmpdir()) || !basename(destino).startsWith("tpv-contratos-")) {
        throw new Error("Directorio temporal fuera de la carpeta de generación");
    }
    rmSync(temporal, { recursive: true, force: true });
}

try {
    const fichero = join(temporal, "bindings.ts");
    execFileSync("cargo", ["run", "--quiet", "--locked", "-p", "tpv", "--", "--export-bindings", fichero], { cwd: raiz, stdio: "inherit" });
    const contenido = readFileSync(fichero, "utf8").replace(/\r\n/g, "\n");
    const fuente = ts.createSourceFile(fichero, contenido, ts.ScriptTarget.Latest, true);
    const tipos = fuente.statements.filter(ts.isTypeAliasDeclaration);
    const nombresTipos = tipos.map(t => t.name.text);
    // Una marca unique symbol sólo es compatible consigo misma. Specta puede expandirla
    // en el retorno de un comando: reutilizamos la definición nombrada del mismo export.
    const dinero = tipos.find(t => t.name.text === "Dinero");
    const declaracion = fuente.statements.find(s => ts.isVariableStatement(s)
        && s.declarationList.declarations.some(d => d.name.getText(fuente) === "commands"));
    if (!declaracion || !tipos.length || !dinero) throw new Error("Salida de Specta sin comandos o tipos requeridos");
    const objeto = declaracion.declarationList.declarations[0].initializer;
    const nombres = [];
    const argumentos = [];
    for (const propiedad of objeto.properties) {
        const nombre = propiedad.name.getText(fuente);
        const funcion = propiedad.initializer;
        const llamada = funcion.body;
        if (!ts.isCallExpression(llamada) || !ts.isStringLiteral(llamada.arguments[0])) {
            throw new Error(`Firma de Specta desconocida para ${nombre}`);
        }
        const ipc = llamada.arguments[0].text;
        nombres.push(`    ${JSON.stringify(ipc)}: ${JSON.stringify(nombre)},`);
        const campos = llamada.arguments[1]?.properties ?? [];
        const tiposCampos = campos.map(c => {
            const clave = c.name.getText(fuente);
            const valor = ts.isShorthandPropertyAssignment(c) ? c.name.text : c.initializer.getText(fuente);
            const indice = funcion.parameters.findIndex(p => p.name.getText(fuente) === valor);
            if (indice < 0) throw new Error(`Argumento de Specta desconocido: ${ipc}.${clave}`);
            return `${clave}: Parameters<Comandos[${JSON.stringify(nombre)}]>[${indice}]`;
        });
        argumentos.push(`    ${JSON.stringify(ipc)}: { ${tiposCampos.join("; ")} };`);
    }
    const archivos = new Map([
        ["packages/contracts/src/generated/bindings.ts", cabecera + tipos.map(t => t.getFullText(fuente).trim()).join("\n\n") + "\n"],
        ["packages/client/src/generated/commands.ts", cabecera
            + 'import { invocar as __TAURI_INVOKE } from "../transporte";\n'
            + `import type { ${nombresTipos.join(", ")} } from "@tpv/contracts";\n\n`
            + declaracion.getText(fuente).replaceAll(dinero.type.getText(fuente), "Dinero") + "\n"],
        ["packages/client/src/generated/metadata.ts", cabecera
            + 'type Comandos = typeof import("./commands").commands;\n\n'
            + `export const nombresComandos = {\n${nombres.join("\n")}\n} as const;\n\n`
            + `export type NombreComando = keyof typeof nombresComandos;\n`
            + `type Argumentos = {\n${argumentos.join("\n")}\n};\n`
            + `export type ArgsComando<N extends NombreComando> = Argumentos[N];\n`
            + `export type RetornoComando<N extends NombreComando> = Awaited<ReturnType<Comandos[(typeof nombresComandos)[N]]>>;\n`],
    ]);
    for (const [nombre, generado] of archivos) {
        const nuevo = generado.replace(/[\t ]+$/gm, "");
        const destino = join(raiz, nombre);
        if (comprobar) {
            if (readFileSync(destino, "utf8").replace(/\r\n/g, "\n") !== nuevo) {
                throw new Error(`${nombre} no está actualizado; ejecuta pnpm generate-types`);
            }
        } else {
            mkdirSync(dirname(destino), { recursive: true });
            writeFileSync(destino, nuevo);
        }
    }
    console.log(`${nombres.length} comandos y ${tipos.length} tipos: ${comprobar ? "actualizados" : "generados"}.`);
} finally {
    // Es exclusivamente el directorio temporal creado en esta ejecución.
    limpiarTemporal();
}
