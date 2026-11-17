// test/tareaSinAsignados.test.ts
//
// TAR-INC-02: reasignar una tarea a nadie se aceptaba, y una tarea sin asignados no sale en ninguna
// lista de quien la hace. Ahora se rechaza como al crearla, con el mismo texto que la Main
// (`set_asignaciones` en `tpv-application/src/use_cases/tareas.rs`).

import { describe, expect, it } from "vitest";

import { setAsignacionesTareaSchema } from "../src/domains/tareas/tareas.schemas";

describe("reasignar una tarea exige al menos un trabajador", () => {
	it.each([[[]], [["  ", ""]], [undefined]])("%j se rechaza", (ids) => {
		const r = setAsignacionesTareaSchema.safeParse(ids === undefined ? {} : { ids_trabajadores: ids });
		expect(r.success).toBe(false);
		expect(r.error?.issues[0]?.message).toBe("Asigna la tarea a alguien.");
	});

	it("con alguien, pasa normalizada", () => {
		const r = setAsignacionesTareaSchema.safeParse({ ids_trabajadores: [" b ", "a", "a"] });
		expect(r.success).toBe(true);
		expect(r.data?.ids_trabajadores).toEqual(["a", "b"]);
	});
});
