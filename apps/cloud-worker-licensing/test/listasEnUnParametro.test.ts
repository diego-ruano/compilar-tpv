// test/listasEnUnParametro.test.ts
//
// DO-01 · Una lista de tamaño variable va en UN parámetro: `IN (SELECT value FROM json_each(?))`.
//
// El SQLite del Durable Object admite 100 parámetros por sentencia (`sondaSqliteDo.test.ts`). Con un
// `?` por elemento, «Ver tickets» de un día con más de 100 tickets, el cobro de barra de un ticket de
// más de 99 líneas, un plano con más de 100 zonas o una zona de más de 98 mesas y una tarea con más de
// 99 asignados se rechazaban en la nube. Lo que replican y lo que leen esos caminos lo fijan los casos
// de contrato de 120 elementos (`*_120_*` en `tests/contract/`), que corren contra el SQLite del DO.
// Aquí:
//
//   · la comprobación de que existen los asignados de una tarea (`trabajadoresExisten`), que no tiene
//     caso de contrato porque la hace la ruta antes de construir el comando;
//   · que ningún fuente del worker vuelve a componer una lista de parámetros, uno por elemento.

import type { Client } from "@libsql/client/web";
import { describe, expect, it } from "vitest";

import { clienteSobre } from "./helpers/clienteSql";
import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enElHub } from "./helpers/hub";
import { trabajadoresExisten } from "../src/domains/tareas/tareas.queries";

const N = 150;
const id = (i: number) => `trab-${String(i).padStart(3, "0")}`;

describe("los asignados de una tarea", () => {
	it(`comprueba ${N} trabajadores en una sola sentencia`, async () => {
		await enElHub("listas-un-parametro-trabajadores", async (hub: any) => {
			const sql = hub.state.storage.sql;
			crearEsquemaTenant(sql);
			sql.exec("INSERT INTO Roles (ID_Rol, Nombre_Rol) VALUES ('rol-1', 'RolListas');");
			for (let i = 1; i <= N; i++) {
				sql.exec(
					"INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre) VALUES (?1, 'rol-1', ?2, 'h', 'U');",
					`user-${i}`,
					`u${i}@x.com`,
				);
				sql.exec("INSERT INTO Trabajadores (ID_Trabajador, ID_Usuario) VALUES (?1, ?2);", id(i), `user-${i}`);
			}
			const db = clienteSobre(sql) as unknown as Client;
			const todos = Array.from({ length: N }, (_, i) => id(i + 1));

			expect(await trabajadoresExisten(db, todos)).toBe(true);
			// Repetidos y con espacios cuentan una vez, como en la Main.
			expect(await trabajadoresExisten(db, [...todos, ` ${id(1)} `])).toBe(true);
			expect(await trabajadoresExisten(db, [...todos, "no-existe"])).toBe(false);
		});
	});
});

describe("ningún fuente pone un parámetro por elemento", () => {
	// Todo el fuente del worker, como texto (dentro del pool de workers no hay `node:fs`).
	const fuentes = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true });

	// Las formas de componer `?, ?, ?` o `?1, ?2, ?3` a partir de una lista.
	const PATRONES = [
		/\.map\(\s*\(\s*_\w*\s*,\s*\w+\s*\)\s*=>\s*`\?\$\{/, // .map((_, i) => `?${i + 1}`)
		/\.map\(\s*\(\s*\w*\s*\)\s*=>\s*["'`]\?["'`]\s*\)/, // .map(() => "?")
		/\.fill\(\s*["'`]\?["'`]\s*\)/, // Array(n).fill("?")
		/["'`]\?\s*,?\s*["'`]\s*\.repeat\(/, // "?,".repeat(n)
	];
	const caza = (texto: string) => PATRONES.some((p) => p.test(texto));
	/** Cuántas veces aparece en `texto` alguna de esas formas. */
	const cuantas = (texto: string) =>
		PATRONES.reduce((n, p) => n + (texto.match(new RegExp(p.source, "g"))?.length ?? 0), 0);

	// Lo que tiene esa forma y no es una lista, contado por fuente: si aparece otra, salta igual.
	// - El cursor de una página de claves del contraste (`verificar.ts::paginaDeClaves`) es UNA clave
	//   primaria, `(cols) > (?1, ?2…)`: un `?` por columna de la clave (dos o tres como mucho), no
	//   uno por elemento de una lista que crece con el negocio.
	const QUE_NO_SON_LISTAS: Record<string, number> = { "../src/domains/sync/verificar.ts": 1 };

	it("lee el fuente de verdad", () => {
		expect(Object.keys(fuentes).length).toBeGreaterThan(100);
		expect(Object.values(fuentes).join("\n")).toContain("json_each(?");
	});

	it("reconoce las formas de una lista con un parámetro por elemento", () => {
		expect(caza("const p = ids.map((_, i) => `?${i + 1}`).join(',');")).toBe(true);
		expect(caza("const p = ids.map((_x, n) => `?${n + 3}`).join(',');")).toBe(true);
		expect(caza('const p = ids.map(() => "?").join(",");')).toBe(true);
		expect(caza('const p = new Array(ids.length).fill("?").join(",");')).toBe(true);
		expect(caza('const p = "?,".repeat(ids.length).slice(0, -1);')).toBe(true);
		expect(caza("WHERE ID IN (SELECT value FROM json_each(?1))")).toBe(false);
	});

	it("ninguna sentencia del worker compone esa lista", () => {
		const culpables = Object.entries(fuentes)
			.filter(([ruta, texto]) => cuantas(texto as string) > (QUE_NO_SON_LISTAS[ruta] ?? 0))
			.map(([ruta]) => ruta);
		expect(culpables).toEqual([]);
		// Y lo que se da por bueno sigue ahí: si se va, sobra la excepción.
		for (const [ruta, n] of Object.entries(QUE_NO_SON_LISTAS)) expect(cuantas(fuentes[ruta] as string), ruta).toBe(n);
	});
});
