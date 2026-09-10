declare module "*.svg" {
	// `import X = require()` es la forma de TypeScript para traer un tipo dentro de un
	// `declare module`; no es un `require()` de CommonJS y no tiene equivalente con `import`.
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	import React = require("react");
	export const ReactComponent: React.FC<React.SVGProps<SVGSVGElement>>;
	const src: string;
	export default src;
}