// ESLint del monorepo (INFRA-04).
//
// ── El criterio, que es lo que hay que respetar al tocar esto ────────────────────────────────
//
// **Esto NO es un formateador y no debe convertirse en uno.** No hay reglas de estilo, ni de
// comillas, ni de punto y coma: el código ya está escrito y reescribirlo entero en un commit sólo
// serviría para enterrar el historial. Las reglas de aquí son de ANÁLISIS — cazan fallos que el
// compilador de TypeScript no puede ver — y son pocas a propósito.
//
// La razón es la misma por la que la lista de comandos gateados de SEC-01 es corta: un linter que
// grita se desactiva a la semana, y entonces no queda ni el linter ni la costumbre. Antes de añadir
// una regla, la pregunta no es «¿esto es mejor estilo?» sino «¿esta regla habría cazado un bug que
// hemos tenido?».
//
// ── Por qué estas cuatro─────────────────────────────────────────────────────────────────────
//
// - `react-hooks/rules-of-hooks`: un hook dentro de un `if` corrompe el estado del componente de
//   una forma que no se parece a su causa. No tiene falsos positivos.
// - `react-hooks/exhaustive-deps`: caza *stale closures* — un efecto que actúa sobre un valor
//   caducado. Es la regla que ya se estaba suprimiendo a mano en ~20 sitios del frontend cuando no
//   había ningún ESLint instalado que la aplicara. Va en `warn` porque a veces la dependencia se
//   omite a sabiendas; lo que importa es que cada omisión sea una decisión visible.
// - `@typescript-eslint/no-floating-promises`: una promesa rechazada sin `catch` es un fallo
//   SILENCIOSO, y este repo está lleno de `async` disparados sin esperar. Es exactamente la forma
//   del bug FIS-01 (pulsar «Confirmar cobro» y que no pase nada).
// - `@typescript-eslint/no-misused-promises`: el agujero que deja la anterior. Ella ve la promesa
//   que alguien suelta; no ve la que se ENTREGA a quien no la espera — `onClick={guardar}` con
//   `guardar` asíncrono, `setTimeout(async …)`—. React la tira, y si rechaza sólo se entera Sentry:
//   quien pulsó el botón ve que no pasa nada. Al encenderla había 119. Se arreglan con `conAviso`
//   (`shared/lib/conAviso.ts`), que reporta y lo dice en pantalla, o con `() => void x()` cuando `x`
//   no puede rechazar (navegar, un refetch de React Query) o ya captura por su cuenta.
//
// ── Alcance ──────────────────────────────────────────────────────────────────────────────────
//
// Sólo el código que se escribe a mano. Queda fuera lo generado (contratos y cliente de Specta,
// `worker-configuration.d.ts` lo produce wrangler) y todo lo compilado.

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
    {
        // Lo primero: lo que no se mira. Un `ignores` suelto (sin más claves) es global.
        ignores: [
            "**/node_modules/**",
            "**/dist/**",
            "**/target/**",
            "**/.turbo/**",
            "**/.wrangler/**",
            "apps/tpv-main/src-tauri/gen/**",
            // Generados: los contratos y el cliente salen de Specta; el Worker, de wrangler.
            // Avisar sobre ellos es avisar sobre un fichero que nadie va a editar.
            "packages/contracts/src/generated/**",
            "packages/client/src/generated/**",
            "apps/cloud-worker-licensing/src/server/worker-configuration.d.ts",
        ],
    },

    js.configs.recommended,

    // Las dos apps, con información de tipos: `no-floating-promises` necesita saber qué devuelve
    // cada llamada, y eso no se puede deducir del texto. Sólo ellas porque son las únicas con un
    // `tsconfig.json` de verdad — los `packages/` no tienen ninguno (ver el bloque de abajo).
    {
        files: ["apps/*/src/**/*.{ts,tsx}", "apps/*/e2e/**/*.ts", "apps/*/test/**/*.ts"],
        extends: [tseslint.configs.recommended],
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
        plugins: { "react-hooks": reactHooks },
        rules: {
            "react-hooks/rules-of-hooks": "error",
            "react-hooks/exhaustive-deps": "warn",
            "@typescript-eslint/no-floating-promises": "error",
            "@typescript-eslint/no-misused-promises": "error",

            // ── Lo que se apaga, y por qué ───────────────────────────────────────────────────
            //
            // `no-explicit-any`: el repo usa `any` a sabiendas en las fronteras sin tipar (lo que
            // llega del IPC antes de normalizarlo, los mensajes del WebSocket). Encenderlo son
            // cientos de avisos sobre decisiones ya tomadas, que es justo lo que hace que un
            // linter se acabe apagando entero.
            "@typescript-eslint/no-explicit-any": "off",
            // `no-unused-vars`: ya lo comprueba `tsc` con `noUnusedParameters`, y con mejor
            // criterio. Dos voces diciendo lo mismo sobran.
            "@typescript-eslint/no-unused-vars": "off",
            "no-unused-vars": "off",
            // `no-empty-function` / `no-empty`: hay `catch {}` deliberados y comentados (best
            // effort que no puede tumbar lo que envuelve). El comentario dice más que la regla.
            "no-empty": "off",
            // `no-useless-escape`: las expresiones regulares de `shared/observability/scrub.ts` son
            // el **espejo** de las de `crates/tpv-telemetry/src/scrub.rs`, carácter a carácter, y lo
            // que redactan es PII. Quitar un `\` que sobra las separa del original a cambio de nada,
            // y del lado JS no hay tabla de golden que avise si la separación fue a peor.
            "no-useless-escape": "off",
            // `no-useless-assignment`: `let x: T | null = null;` justo antes de un `try` que lo
            // rellena es un idioma legible y deliberado. La regla pide quitar el valor inicial; TS
            // ya garantiza que no se lee sin asignar, así que sólo se gana ruido.
            "no-useless-assignment": "off",
        },
    },

    // RI-87: el único transporte por nombre vive en @tpv/client, detrás de las firmas generadas.
    {
        files: ["apps/tpv-main/src/**/*.ts", "apps/tpv-main/src/**/*.tsx"],
        rules: {
            "no-restricted-imports": ["error", { paths: [
                { name: "@tauri-apps/api/core", importNames: ["invoke"], message: "Usa commands de @tpv/client: nombre, argumentos y respuesta proceden de Rust." },
                { name: "@tpv/client", importNames: ["invokeClient", "rawInvoke"], message: "Usa las funciones commands generadas." },
            ] }],
        },
    },

    // `packages/*` y los scripts de Node: SIN información de tipos.
    //
    // No es una preferencia: los tres `packages/` no tienen `tsconfig.json` (su tarea `lint` es un
    // `tsc --noEmit` que no encuentra proyecto), y los `.mjs` de `scripts/` no están en ninguno. Sin
    // proyecto no hay tipos, y sin tipos `no-floating-promises` no puede funcionar — así que aquí
    // sólo quedan las reglas que se deducen del texto. Si algún día esos paquetes ganan su
    // `tsconfig.json`, muévelos al bloque de arriba y ganarán la regla de las promesas.
    {
        files: ["packages/*/src/**/*.ts", "scripts/**/*.mjs", "*.config.mjs"],
        extends: [tseslint.configs.recommended],
        languageOptions: {
            globals: { process: "readonly", console: "readonly", Buffer: "readonly" },
        },
        rules: {
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-unused-vars": "off",
            "no-unused-vars": "off",
            "no-empty": "off",
            "no-useless-escape": "off",
            "no-useless-assignment": "off",
        },
    },
);
