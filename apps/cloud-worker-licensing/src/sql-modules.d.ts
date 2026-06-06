// Permite `import sql from "*.sql"` como módulo de texto.
// En runtime lo resuelve la regla `{ type: "Text", globs: ["**/*.sql"] }`
// de wrangler.json (esbuild lo inyecta como string).
declare module "*.sql" {
	const content: string;
	export default content;
}
