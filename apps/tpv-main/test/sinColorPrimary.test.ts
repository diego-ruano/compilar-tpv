// M-020: el tema no define el color `primary` (el corporativo es `accent`, de @tpv/estilos), y
// Tailwind no genera nada para una utilidad de un color que no existe: `focus:border-primary` o
// `bg-primary/10` no pintaban nada, y los botones con `bg-primary` sólo se veían por un parche de
// Global.css que los repintaba con `--accent`. Las utilidades usan `accent` directamente.

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

// Con `fs` y no con `import.meta.glob`: en vitest un `.css?raw` llega vacío.
const SRC = resolve(__dirname, "../src");
const ficheros = readdirSync(SRC, { recursive: true, encoding: "utf8" }).filter((f) => /\.(tsx?|css)$/.test(f));

it("ninguna utilidad usa el color primary, que el tema no define", () => {
    const conPrimary = ficheros.flatMap((f) =>
        [...readFileSync(join(SRC, f), "utf8").matchAll(/\b[a-z]+-primary\b/g)].map((m) => `${f}: ${m[0]}`),
    );
    expect(conPrimary).toEqual([]);
});
