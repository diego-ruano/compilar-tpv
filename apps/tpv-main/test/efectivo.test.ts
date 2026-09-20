// apps/tpv-main/test/efectivo.test.ts
//
// Las cuentas del efectivo: el cambio que la pantalla de cobro dice que hay que devolver y el arqueo
// que el cierre de caja enseña antes de confirmar.
//
// Por qué no basta con los tests de Rust: el arqueo que se GUARDA lo calcula Rust, pero lo que la
// persona ve —y con lo que decide si escribe un motivo o vuelve a contar— lo calcula la pantalla. Si
// los dos lados redondean distinto, el cierre enseña «Cuadra» y se guarda con un céntimo de
// descuadre, o pide un motivo que el backend no pide.
//
// Las tablas marcadas «igual que Rust» repiten los casos de `crates/tpv-domain/src/cierre_caja.rs`.
// Si allí cambia el criterio, falla su test; si cambia aquí, falla éste.
//
// ⚠️ Desde ARQ-01 el dinero son CÉNTIMOS ENTEROS, así que la mitad de lo que este fichero
// comprobaba —que sumar no arrastre la cola de la coma flotante, que un cierre cuadrado no enseñe
// «-0,00 €»— ya no puede fallar por construcción. Se conservan igualmente: lo que afirman es el
// RESULTADO, no la técnica con la que se consigue, y son los casos que de verdad mordieron. El
// redondeo en sí se prueba contra la tabla compartida en `test/dinero.test.ts`.
//
// Los barridos no son aleatorios de verdad: usan un generador con semilla fija, para que un fallo
// se pueda reproducir.

import type { Dinero } from "@tpv/contracts";
import { describe, expect, it } from "vitest";

import { CERO, deCentimos, eur, sumar } from "../src/shared/lib/dinero";
import {
    calcularArqueo,
    cambioDelCobro,
    DENOMS_COBRO,
    exigeMotivo,
    leerImporte,
    sumaImportes,
    totalRecuento,
    validarCierre,
    type Denominacion,
    type Recuento,
} from "../src/shared/lib/efectivo";

/** Céntimos, para que los supuestos se lean como se escriben. */
const c = deCentimos;

/** El mismo formateador que usan las dos pantallas de cobro. */
const pantalla = (d: Dinero) => eur(d);

/** Cuenta `centimos` con las monedas y billetes dados, de mayor a menor, como lo haría el camarero. */
function pagarExacto(centimos: number, denoms: readonly Denominacion[] = DENOMS_COBRO): Recuento {
    const recuento: Recuento = {};
    let resto = centimos;
    for (const d of [...denoms].sort((a, b) => b.value - a.value)) {
        const unidades = Math.floor(resto / d.value);
        if (unidades > 0) {
            recuento[d.label] = unidades;
            resto -= unidades * d.value;
        }
    }
    if (resto !== 0) throw new Error(`${centimos} céntimos no se pueden pagar exactos con estas monedas`);
    return recuento;
}

/** Generador determinista (LCG): el mismo barrido en cada ejecución. */
function generador(semilla: number) {
    let s = semilla >>> 0;
    return (hasta: number) => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return Math.floor((s / 2 ** 32) * hasta);
    };
}

/** Parte `centimos` en `n` líneas de precio que suman exactamente eso. */
function enLineas(centimos: number, n: number, azar: (hasta: number) => number): Dinero[] {
    const lineas: Dinero[] = [];
    let resto = centimos;
    for (let i = 0; i < n - 1; i++) {
        const trozo = azar(resto + 1);
        lineas.push(c(trozo));
        resto -= trozo;
    }
    lineas.push(c(resto));
    return lineas;
}

describe("sumaImportes", () => {
    it("la suma de líneas no arrastra el error de coma flotante", () => {
        expect(sumaImportes([c(110), c(220)])).toBe(330);
        expect(sumaImportes(Array<Dinero>(10).fill(c(10)))).toBe(100);
        expect(sumaImportes([c(7), c(7), c(7)])).toBe(21);
    });

    it("una línea sin precio legible no suma, y no convierte el total en NaN", () => {
        expect(sumaImportes([c(200), Number.NaN as never, c(150)])).toBe(350);
        expect(sumaImportes([])).toBe(0);
    });

    it("barrido: cualquier ticket de hasta 30 líneas suma exactamente sus céntimos", () => {
        const azar = generador(20260915);
        for (let i = 0; i < 5000; i++) {
            const n = 1 + azar(30);
            const lineasEnCentimos = Array.from({ length: n }, () => azar(10_000));
            const exacto = lineasEnCentimos.reduce((a, b) => a + b, 0);
            const suma = sumaImportes(lineasEnCentimos.map(c));
            if (suma !== exacto) throw new Error(`${lineasEnCentimos.join("+")} → ${suma}, no ${exacto}`);
        }
    });
});

describe("DENOMS_COBRO", () => {
    it("cada etiqueta dice lo que vale", () => {
        // Un `{ label: "0,20€", value: 2 }` cobraría de menos sin que nadie lo viera en pantalla.
        for (const d of DENOMS_COBRO) {
            const euros = Number(d.label.replace("€", "").replace(",", "."));
            expect(Math.round(euros * 100), d.label).toBe(d.value);
        }
    });

    it("no repite ninguna, y va de mayor a menor como se pinta", () => {
        const valores = DENOMS_COBRO.map((d) => d.value);
        expect(new Set(DENOMS_COBRO.map((d) => d.label)).size).toBe(DENOMS_COBRO.length);
        expect(valores).toEqual([...valores].sort((a, b) => b - a));
    });
});

describe("totalRecuento (igual que `total_recuento` de Rust)", () => {
    it("suma valor por unidades", () => {
        expect(totalRecuento(DENOMS_COBRO, { "50€": 2, "20€": 3, "0,50€": 4 })).toBe(16_200);
    });

    it("ignora lo que no es dinero: unidades a cero o negativas y valores no positivos", () => {
        const denoms: Denominacion[] = [
            { label: "20", value: c(2000) },
            { label: "10", value: c(1000) },
            { label: "cero", value: CERO },
            { label: "5", value: c(500) },
        ];
        expect(totalRecuento(denoms, { "20": 0, "10": -3, cero: 99, "5": 2 })).toBe(1000);
    });

    it("la calderilla no arrastra error de coma flotante", () => {
        // 70 monedas de un céntimo: en coma flotante sumaban 0,7000000000000001.
        expect(totalRecuento([{ label: "1c", value: c(1) }], { "1c": 70 })).toBe(70);
    });

    it("una unidad ilegible no convierte el total en NaN", () => {
        expect(totalRecuento(DENOMS_COBRO, { "5€": Number.NaN, "10€": 1 })).toBe(1000);
    });

    it("una etiqueta que no está en las denominaciones no suma", () => {
        // El contador del cierre escribe "0.50€" y el del cobro "0,50€". Mezclar un recuento de una
        // pantalla con las denominaciones de la otra tiene que dar cero, no un número a medias.
        expect(totalRecuento(DENOMS_COBRO, { "0.50€": 3 })).toBe(0);
        expect(totalRecuento(DENOMS_COBRO, {})).toBe(0);
    });

    it("barrido: todo importe múltiplo de 5 céntimos, pagado exacto, da exactamente ese importe", () => {
        for (let cent = 0; cent <= 100_000; cent += 5) {
            const total = totalRecuento(DENOMS_COBRO, pagarExacto(cent));
            if (total !== cent) throw new Error(`${cent} céntimos contados dan ${total}`);
        }
    });
});

describe("cambioDelCobro", () => {
    it("pagar justo 1,10 + 2,20 no enseña «Cambio -0,00 €»", () => {
        // El fallo que había: 1,1 + 2,2 = 3,3000000000000003, y la resta redondeada daba -0.
        const aCobrar = sumar(c(110), c(220));
        const entregado = totalRecuento(DENOMS_COBRO, { "2€": 1, "1€": 1, "0,20€": 1, "0,10€": 1 });

        const cambio = cambioDelCobro(entregado, aCobrar);

        expect(Object.is(cambio, 0)).toBe(true);
        expect(pantalla(cambio)).toBe(pantalla(CERO));
    });

    it("lo que falta sale en negativo y exacto", () => {
        expect(cambioDelCobro(c(1000), c(1240))).toBe(-240);
        expect(cambioDelCobro(c(345), c(347))).toBe(-2);
    });

    it("pagar lo justo no puede decir que falta nada", () => {
        expect(cambioDelCobro(c(30), sumar(c(10), c(20)))).toBe(0);
        expect(cambioDelCobro(c(2000), sumar(c(10), c(20)))).toBe(1970);
    });

    it("barrido: de 0,05 a 1.000 € repartidos en líneas, pagar justo, de más o de menos da el cambio exacto", () => {
        const azar = generador(1107);
        for (let cent = 5; cent <= 100_000; cent += 5) {
            const aCobrar = sumaImportes(enLineas(cent, 1 + azar(6), azar));

            const justo = cambioDelCobro(totalRecuento(DENOMS_COBRO, pagarExacto(cent)), aCobrar);
            if (!Object.is(justo, 0)) throw new Error(`${cent} céntimos pagados justos dan ${justo}`);

            const deMas = cambioDelCobro(totalRecuento(DENOMS_COBRO, pagarExacto(cent + 5)), aCobrar);
            if (deMas !== 5) throw new Error(`${cent} céntimos con 5 de más dan ${deMas}`);

            const deMenos = cambioDelCobro(totalRecuento(DENOMS_COBRO, pagarExacto(cent - 5)), aCobrar);
            if (deMenos !== -5) throw new Error(`${cent} céntimos con 5 de menos dan ${deMenos}`);
        }
    });
});

describe("calcularArqueo (igual que `calcular` de Rust)", () => {
    it.each([
        // fondo, ventas, gastos, contado, dejado → esperado, descuadre, retirado (todo en céntimos)
        { caso: "cuadra", e: [15_000, 32_045, 0, 47_045, 15_000], s: [47_045, 0, 32_045] },
        {
            caso: "los gastos pagados con caja restan",
            e: [15_000, 32_045, 1_800, 45_245, 15_000],
            s: [45_245, 0, 30_245],
        },
        { caso: "falta dinero", e: [10_000, 20_000, 0, 28_000, 10_000], s: [30_000, -2_000, 18_000] },
        { caso: "sobra dinero", e: [10_000, 20_000, 0, 30_550, 10_000], s: [30_000, 550, 20_550] },
        { caso: "se deja todo lo contado", e: [10_000, 20_000, 0, 30_000, 30_000], s: [30_000, 0, 0] },
    ])("$caso", ({ e: [fondoInicial, ventasEfectivo, gastosCaja, contado, dejado], s }) => {
        const a = calcularArqueo({
            fondoInicial: c(fondoInicial),
            ventasEfectivo: c(ventasEfectivo),
            gastosCaja: c(gastosCaja),
            contado: c(contado),
            dejado: c(dejado),
        });
        expect([a.esperado, a.descuadre, a.retirado]).toEqual(s);
    });

    it("lo que se deja es el fondo del periodo siguiente", () => {
        const hoy = calcularArqueo({
            fondoInicial: c(10_000),
            ventasEfectivo: c(50_000),
            gastosCaja: CERO,
            contado: c(60_000),
            dejado: c(12_000),
        });
        expect(hoy.retirado).toBe(48_000);

        const manana = calcularArqueo({
            fondoInicial: hoy.dejado,
            ventasEfectivo: c(30_000),
            gastosCaja: CERO,
            contado: c(42_000),
            dejado: c(10_000),
        });
        expect(manana.fondoInicial).toBe(12_000);
        expect(manana.esperado).toBe(42_000);
        expect(manana.descuadre).toBe(0);
    });

    it("el descuadre sale en céntimos, no con la cola de la resta", () => {
        // 305,01 − 300 daba 5,009999999999991 en coma flotante.
        const a = calcularArqueo({
            fondoInicial: CERO,
            ventasEfectivo: c(30_000),
            gastosCaja: CERO,
            contado: c(30_501),
            dejado: CERO,
        });
        expect(a.descuadre).toBe(501);
    });

    it("una caja que cuadra no enseña «-0,00 €» en ninguna cifra", () => {
        const a = calcularArqueo({
            fondoInicial: c(10),
            ventasEfectivo: c(20),
            gastosCaja: CERO,
            contado: c(30),
            dejado: c(30),
        });
        for (const [campo, v] of Object.entries(a)) {
            expect(pantalla(v as Dinero), campo).not.toMatch(/^-/);
        }
        expect(Object.is(a.descuadre, 0)).toBe(true);
    });

    it("barrido: contar en billetes y monedas justo lo esperado siempre cuadra", () => {
        const denoms: Denominacion[] = [
            ...DENOMS_COBRO,
            { label: "0,02€", value: c(2) },
            { label: "0,01€", value: c(1) },
        ];
        const azar = generador(606);
        for (let i = 0; i < 5000; i++) {
            const fondo = azar(50_000);
            const ventas = azar(500_000);
            const gastos = azar(fondo + ventas + 1);
            const esperadoEnCentimos = fondo + ventas - gastos;
            const dejadoEnCentimos = azar(esperadoEnCentimos + 1);

            const a = calcularArqueo({
                fondoInicial: c(fondo),
                ventasEfectivo: c(ventas),
                gastosCaja: c(gastos),
                contado: totalRecuento(denoms, pagarExacto(esperadoEnCentimos, denoms)),
                dejado: totalRecuento(denoms, pagarExacto(dejadoEnCentimos, denoms)),
            });

            const esperaba = `fondo ${fondo}, ventas ${ventas}, gastos ${gastos}, dejado ${dejadoEnCentimos}`;
            if (a.esperado !== esperadoEnCentimos) throw new Error(`${esperaba}: esperado ${a.esperado}`);
            if (!Object.is(a.descuadre, 0)) throw new Error(`${esperaba}: descuadre ${a.descuadre}`);
            if (a.retirado !== esperadoEnCentimos - dejadoEnCentimos) {
                throw new Error(`${esperaba}: retirado ${a.retirado}`);
            }
        }
    });
});

describe("exigeMotivo (igual que `exige_motivo` de Rust)", () => {
    it.each([
        [-499, 500, false],
        [500, 500, false], // justo en el umbral no salta
        [-500, 500, false],
        [-501, 500, true],
        [501, 500, true],
        [4_000, 500, true], // sobrar es tan raro como que falte
        [1, 0, true], // con umbral cero, cualquier descuadre
        [0, 0, false],
        [1, -100, true], // un umbral negativo se lee como cero
        [0, -100, false],
    ])("descuadre %s con umbral %s → %s", (descuadre, umbral, esperado) => {
        expect(exigeMotivo(c(descuadre), c(umbral))).toBe(esperado);
    });
});

describe("validarCierre (igual que `validar` de Rust)", () => {
    const UMBRAL = c(500);
    const arqueo = (fondo: number, ventas: number, contado: number, dejado: number) =>
        calcularArqueo({
            fondoInicial: c(fondo),
            ventasEfectivo: c(ventas),
            gastosCaja: CERO,
            contado: c(contado),
            dejado: c(dejado),
        });

    const grande = arqueo(10_000, 20_000, 25_000, 10_000);
    const cuadrado = arqueo(15_000, 10_000, 25_000, 15_000);

    it("un descuadre grande sin motivo no se puede guardar", () => {
        expect(validarCierre(grande, null, UMBRAL)).toBe("falta_motivo");
        expect(validarCierre(grande, undefined, UMBRAL)).toBe("falta_motivo");
        expect(validarCierre(grande, "se pagó un pedido en efectivo", UMBRAL)).toBeNull();
    });

    it("un motivo en blanco no cuenta como motivo", () => {
        for (const blanco of ["", "   ", "\n\t "]) {
            expect(validarCierre(grande, blanco, UMBRAL), JSON.stringify(blanco)).toBe("falta_motivo");
        }
    });

    it("un cierre cuadrado no necesita motivo", () => {
        expect(validarCierre(cuadrado, null, UMBRAL)).toBeNull();
        expect(validarCierre(cuadrado, "", UMBRAL)).toBeNull();
    });

    it("no se puede dejar más de lo contado, aunque haya motivo", () => {
        expect(validarCierre(arqueo(10_000, 5_000, 15_000, 20_000), "lo que sea", UMBRAL)).toBe(
            "deja_mas_de_lo_contado",
        );
    });

    it("dejar más de lo contado se dice antes que la falta de motivo, como en Rust", () => {
        expect(validarCierre(arqueo(10_000, 20_000, 15_000, 20_000), null, UMBRAL)).toBe(
            "deja_mas_de_lo_contado",
        );
    });

    it("dejar exactamente lo contado sí se puede", () => {
        expect(validarCierre(arqueo(10_000, 20_000, 30_000, 30_000), null, UMBRAL)).toBeNull();
    });
});

describe("leerImporte: el fondo que se escribe en el primer cierre", () => {
    // Antes se leía con `Number(texto.replace(",", "."))` y lo ilegible valía 0 sin avisar. Ese
    // fondo encabeza la cadena de cierres, así que un error ahí se arrastra a todos los siguientes.

    it.each([
        ["", 0],
        ["   ", 0],
        ["0", 0],
        ["150", 15_000],
        ["0150", 15_000],
        [" 150 ", 15_000],
        ["150,50", 15_050],
        ["150,5", 15_050],
        ["0,05", 5],
        ["150.50", 15_050],
        ["150.5", 15_050],
        // Un punto con tres cifras detrás agrupa miles, como se escribe en España.
        ["1.500", 150_000],
        ["12.000", 1_200_000],
        ["150.555", 15_055_500],
        // Antes, estos tres valían 0.
        ["1.234,56", 123_456],
        ["150 €", 15_000],
        ["1 500", 150_000],
        ["1.234.567,89", 123_456_789],
        ["1,234.56", 123_456],
        ["1 500,50", 150_050],
        ["150€", 15_000],
        ["€150", 15_000],
        ["€ 150", 15_000],
        ["1.500,00 €", 150_000],
    ])("«%s» → %s céntimos", (texto, esperado) => {
        expect(leerImporte(texto)).toBe(esperado);
    });

    it.each([
        // Dos lecturas posibles: no se adivina.
        ["1,500"],
        ["0.500"],
        // Más de dos decimales.
        ["150,555"],
        ["1.5000"],
        // Separadores que no agrupan de tres en tres, o repetidos donde va el decimal.
        ["1..5"],
        ["1.2,5"],
        ["12.34,5"],
        ["1,2,3"],
        ["1,234,56"],
        ["150 50"],
        // Media cifra.
        ["150,"],
        ["150."],
        [",50"],
        [".50"],
        // Lo que no es un importe de un cajón.
        ["-50"],
        ["+50"],
        ["abc"],
        ["150€50"],
        ["1e3"],
        ["99999999999999999"],
    ])("«%s» no se entiende, y no vale cero", (texto) => {
        expect(leerImporte(texto)).toBeNull();
    });

    it("barrido: cualquier importe escrito como lo pinta la pantalla, o a mano, se lee exacto", () => {
        for (let cent = 0; cent <= 2_000_000; cent += 137) {
            const [euros, decimales] = [Math.floor(cent / 100), String(cent % 100).padStart(2, "0")];
            for (const escrito of [
                pantalla(c(cent)),
                `${euros},${decimales}`,
                `${euros}.${decimales}`,
                `${euros}`,
            ]) {
                const esperado = escrito === `${euros}` ? euros * 100 : cent;
                const leido = leerImporte(escrito);
                if (leido !== esperado) throw new Error(`«${escrito}» se lee ${leido}, no ${esperado}`);
            }
        }
    });
});
