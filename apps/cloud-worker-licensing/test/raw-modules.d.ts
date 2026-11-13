// Permite `import fuente from "…/algo.ts?raw"` en los tests como módulo de texto.
//
// El sufijo `?raw` lo resuelve Vite (que es quien transforma los tests) devolviendo el fichero como
// string. TypeScript no sabe nada de ese sufijo, así que sin esta declaración el typecheck falla con
// TS2307 aunque el test funcione — que es justo lo que pasaba con `anularSoloMain.test.ts`.
//
// Vive en `test/` y no en `src/` a propósito: leer el propio fuente es una técnica de test (dentro
// del pool de workers no hay `node:fs`), no algo que deba poder hacer el código de producción.
//
// Mismo patrón que `src/sql-modules.d.ts` para los `*.sql`.
declare module "*?raw" {
	const content: string;
	export default content;
}

// Lo mismo para una carpeta entera: `import.meta.glob("../src/**/*.ts", { query: "?raw", … })`
// también lo resuelve Vite. Sólo se declara la forma que usan los tests (textos, ya cargados).
interface ImportMeta {
	glob(
		patron: string,
		opciones: { query: "?raw"; import: "default"; eager: true },
	): Record<string, string>;
	// Y los módulos de verdad, ya cargados, con lo que exportan (`sinDatosPersonalesEnLaQuery.node`
	// saca de los `*.schemas.ts` las claves que acepta cada `consulta(schema)`).
	glob(patron: string, opciones: { eager: true }): Record<string, Record<string, unknown>>;
}
