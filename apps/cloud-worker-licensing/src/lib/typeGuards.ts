// src/lib/typeGuards.ts
//
// Drift-guard de tipos entre los validadores zod del worker y los DTOs que ts-rs
// genera desde Rust (ARCH-03).
//
// ## El problema que resuelve
//
// Los `*.schemas.ts` YA derivan sus tipos exportados de `@tpv/contracts`, así que al
// pasar `p.data` a un command builder TypeScript comprueba algo... pero sólo en UNA
// dirección: si en Rust se AÑADE un campo requerido, el zod deja de encajar y salta
// el compilador. Si en Rust se QUITA o se RENOMBRA un campo, el zod se queda validando
// un campo fantasma y **compila igual**. Ese es el agujero.
//
// ## Por qué no vale el atajo
//
// `satisfies z.ZodType<Contrato>` parece la solución evidente y NO lo es: en TypeScript
// un objeto con campos de más sigue siendo asignable a uno con menos, así que detecta lo
// que falta y no lo que sobra. Hay que comparar las claves en las dos direcciones.
//
// ## Uso (una línea por schema, sin coste en runtime)
//
// ```ts
// type _CreateTarea = Assert<
//   SameKeys<z.infer<typeof createTareaSchema>, CreateTareaInput>
// >;
// ```
//
// Si en Rust se renombra `fecha_limite`, el módulo deja de compilar con un mensaje que
// **nombra el campo**: `Type '{ sobran_en_zod: "fecha_limite" }' does not satisfy the
// constraint 'true'`.
//
// ## Qué se compara
//
// El segundo parámetro es el tipo LOCAL del `*.schemas.ts` (`CreateTareaInput`), no el
// del contrato en crudo, porque es el que ya descuenta lo que no viaja en el cuerpo
// (ids que van en la ruta, campos que fija el servidor). Como ese tipo se deriva del
// contrato con `Omit`/mapped types, un cambio en Rust lo arrastra igual.

/**
 * `true` si ambos tipos tienen exactamente las mismas claves; si no, un tipo objeto
 * que nombra las que sobran o faltan (y que por tanto no satisface `Assert`).
 */
export type SameKeys<Zod, Contrato> = [
	Exclude<keyof Zod, keyof Contrato>,
] extends [never]
	? [Exclude<keyof Contrato, keyof Zod>] extends [never]
		? true
		: { faltan_en_zod: Exclude<keyof Contrato, keyof Zod> }
	: { sobran_en_zod: Exclude<keyof Zod, keyof Contrato> };

/** Falla la compilación si `T` no es `true`. Puramente de tipos: no emite código. */
export type Assert<T extends true> = T;
