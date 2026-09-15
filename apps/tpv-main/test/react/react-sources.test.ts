import { describe, expect, it } from "vitest";

const reactSources = import.meta.glob("../../src/**/*.tsx", {
	query: "?raw",
	import: "default",
	eager: true,
}) as Record<string, string>;

describe("integridad de los archivos React", () => {
	it("incluye en la batería todos los TSX del frontend", () => {
		expect(Object.keys(reactSources)).toHaveLength(120);
	});

	it.each(Object.entries(reactSources))("%s contiene código React completo", (path, source) => {
		expect(source.trim(), `${path} está vacío`).not.toBe("");
		expect(source, `${path} no contiene JSX ni crea un elemento React`).toMatch(
			/<[A-Za-z][^>]*>|jsx(?:DEV)?\s*\(|createElement\s*\(/,
		);
	});
});
