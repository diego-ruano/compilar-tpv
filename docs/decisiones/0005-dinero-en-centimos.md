# 0005 · El dinero es un entero de céntimos

**Estado:** vigente. La base del negocio ya no está en Turso, sino en el SQLite de su Durable Object: ver
[0008](0008-la-base-del-negocio-en-su-durable-object.md).

## Contexto

Un `f64` no representa `0,10 €`. Sumar en coma flotante arrastra error, y redondear para taparlo depende
del lenguaje: Rust aleja la mitad del cero, JavaScript la lleva hacia +∞ y `ROUND()` de SQLite hace lo
suyo. El dinero se calcula en tres sitios (Rust, el worker y la pantalla) y en dos bases (la Main y
Turso), y todos tienen que dar el mismo céntimo.

## Decisión

- **El dinero es un entero de céntimos de la base a la pantalla.** Un tipo por lenguaje, ninguno un
  número suelto: `tpv_domain::dinero::Dinero` (`i64`), `apps/cloud-worker-licensing/src/lib/dinero.ts` y
  `apps/tpv-main/src/shared/lib/dinero.ts`. En TypeScript cruza **marcado**
  (`number & { readonly __centimos: unique symbol }`): un `number` crudo no se le asigna.
- **La aritmética común tiene una tabla de casos compartida**,
  [`crates/tpv-domain/src/dinero_casos.json`](../../crates/tpv-domain/src/dinero_casos.json), que leen los
  tests de las tres implementaciones. Cambiar un criterio es añadir un caso ahí.
- **La base lo impone**: cada columna de dinero lleva `CHECK (typeof(col) IN ('integer','null'))`
  ([esquema.md](../arquitectura/esquema.md)).
- **Por la API llegan céntimos enteros** (`zDinero` en el worker, `patch_dinero` en Rust): un `12.5` se
  rechaza.
- **Las cantidades y los tipos de IVA siguen siendo `REAL`** (0,5 kg, un 7,5 %).

## Consecuencias

- `SUM` en SQLite es exacto y asociativo: la Main y Turso dan el mismo número sin importar el orden.
- `Cantidad × precio` vuelve a ser flotante: antes de sumar, `SUM(CAST(ROUND(Cantidad * Precio_Unitario) AS
  INTEGER))`. Nunca `ROUND(x, 2)` sobre dinero (devuelve un `REAL`). Un decimal en una columna de dinero
  hace fallar la escritura.
- **Dividir no es multiplicar por el recíproco**: `Dinero::entre(d)` divide; `escala(1.0/d)` puede cambiar
  el céntimo.
- **La marca no caza los errores de unidad por sí sola**: lo que los cierra es que los formateadores
  reciban `Dinero`. En pantalla, un formateador por salida (`eur` y el del papel) y un único lector de lo
  que se teclea (`deTexto`, a través de `<CampoDinero>`) ([frontend.md](../arquitectura/frontend.md#el-dinero-en-pantalla)).
- Un `*Apis.ts` del frontend devuelve el DTO generado tal cual, sin redeclarar el dinero como `number`.
- Los registros fiscales guardan además los importes como **texto** formateado una vez, porque entran en
  una huella ([verifactu.md](../arquitectura/verifactu.md)).
