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
// Los barridos no son aleatorios de verdad: usan un generador con semilla fija, para que un fallo
// se pueda reproducir.

import { describe, expect, it } from "vitest";

import {
    aCentimos,
    calcularArqueo,
    cambioDelCobro,
    DENOMS_COBRO,
    exigeMotivo,
    sumaImportes,
    totalRecuento,
    validarCierre,
    type Denominacion,
    type Recuento,
} from "../src/shared/lib/efectivo";

/** El mismo formateador que usan las dos pantallas de cobro. */
const pantalla = (n: number) =>
    new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" }).format(n);

/** Cuenta `centimos` con las monedas y billetes dados, de mayor a menor, como lo haría el camarero. */
function pagarExacto(centimos: number, denoms: readonly Denominacion[] = DENOMS_COBRO): Recuento {
    const recuento: Recuento = {};
    let resto = centimos;
    for (const d of [...denoms].sort((a, b) => b.value - a.value)) {
        const valor = Math.round(d.value * 100);
        const unidades = Math.floor(resto / valor);
        if (unidades > 0) {
            recuento[d.label] = unidades;
            resto -= unidades * valor;
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

/** Parte `centimos` en `n` líneas de precio (en euros) que suman exactamente eso. */
function enLineas(centimos: number, n: number, azar: (hasta: number) => number): number[] {
    const lineas: number[] = [];
    let resto = centimos;
    for (let i = 0; i < n - 1; i++) {
        const c = azar(resto + 1);
        lineas.push(c / 100);
        resto -= c;
    }
    lineas.push(resto / 100);
    return lineas;
}

describe("aCentimos (igual que `a_centimos` de Rust)", () => {
    it.each([
        // La mitad se aleja del cero. `Math.round` la llevaría a +∞ y daría −0,12.
        [0.125, 0.13],
        [-0.125, -0.13],
        [0.005, 0.01],
        [-0.005, -0.01],
        // Manda la coma flotante, en los dos sentidos y en los dos lados: 1,005 se guarda como
        // 1,00499999… y baja; 2,675 se guarda como 2,67500000…0355 y sube.
        [1.005, 1],
        [2.675, 2.68],
        [0.1 + 0.2, 0.3],
        [-0.004, 0],
    ])("%s → %s", (entrada, esperado) => {
        expect(aCentimos(entrada)).toBe(esperado);
    });

    it("nunca devuelve -0, que la pantalla pintaría «-0,00 €»", () => {
        for (const v of [-0, -0.001, -0.004999, 1.1 + 2.2 - 3.3, 0.3 - (0.1 + 0.2)]) {
            const r = aCentimos(v);
            expect(Object.is(r, 0), `aCentimos(${v}) = ${Object.is(r, -0) ? "-0" : r}`).toBe(true);
            expect(pantalla(r)).toBe(pantalla(0));
        }
    });

    it("un importe que ya está en céntimos no cambia", () => {
        for (let c = -100_000; c <= 100_000; c++) {
            const v = c / 100;
            if (aCentimos(v) !== v) throw new Error(`aCentimos(${v}) = ${aCentimos(v)}`);
        }
    });

    it("lo que no es un número cuenta como cero", () => {
        expect(aCentimos(Number.NaN)).toBe(0);
        expect(aCentimos(Number.POSITIVE_INFINITY)).toBe(0);
        expect(aCentimos(Number.NEGATIVE_INFINITY)).toBe(0);
    });
});

describe("sumaImportes", () => {
    it("la suma de líneas no arrastra el error de coma flotante", () => {
        expect(sumaImportes([1.1, 2.2])).toBe(3.3);
        expect(sumaImportes(Array<number>(10).fill(0.1))).toBe(1);
        expect(sumaImportes([0.07, 0.07, 0.07])).toBe(0.21);
    });

    it("una línea sin precio legible no suma, y no convierte el total en NaN", () => {
        expect(sumaImportes([2, Number.NaN, 1.5])).toBe(3.5);
        expect(sumaImportes([])).toBe(0);
    });

    it("barrido: cualquier ticket de hasta 30 líneas suma exactamente sus céntimos", () => {
        const azar = generador(20260915);
        for (let i = 0; i < 5000; i++) {
            const n = 1 + azar(30);
            const lineasEnCentimos = Array.from({ length: n }, () => azar(10_000));
            const exacto = lineasEnCentimos.reduce((a, b) => a + b, 0) / 100;
            const suma = sumaImportes(lineasEnCentimos.map((c) => c / 100));
            if (suma !== exacto) throw new Error(`${lineasEnCentimos.join("+")} → ${suma}, no ${exacto}`);
        }
    });
});

describe("DENOMS_COBRO", () => {
    it("cada etiqueta dice lo que vale", () => {
        // Un `{ label: "0,20€", value: 0.02 }` cobraría de menos sin que nadie lo viera en pantalla.
        for (const d of DENOMS_COBRO) {
            expect(Number(d.label.replace("€", "").replace(",", ".")), d.label).toBe(d.value);
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
        expect(totalRecuento(DENOMS_COBRO, { "50€": 2, "20€": 3, "0,50€": 4 })).toBe(162);
    });

    it("ignora lo que no es dinero: unidades a cero o negativas y valores no positivos", () => {
        const denoms: Denominacion[] = [
            { label: "20", value: 20 },
            { label: "10", value: 10 },
            { label: "cero", value: 0 },
            { label: "5", value: 5 },
        ];
        expect(totalRecuento(denoms, { "20": 0, "10": -3, cero: 99, "5": 2 })).toBe(10);
    });

    it("la calderilla no arrastra error de coma flotante", () => {
        // 70 monedas de un céntimo: en coma flotante suman 0,7000000000000001.
        expect(totalRecuento([{ label: "1c", value: 0.01 }], { "1c": 70 })).toBe(0.7);
    });

    it("una unidad ilegible no convierte el total en NaN", () => {
        expect(totalRecuento(DENOMS_COBRO, { "5€": Number.NaN, "10€": 1 })).toBe(10);
    });

    it("una etiqueta que no está en las denominaciones no suma", () => {
        // El contador del cierre escribe "0.50€" y el del cobro "0,50€". Mezclar un recuento de una
        // pantalla con las denominaciones de la otra tiene que dar cero, no un número a medias.
        expect(totalRecuento(DENOMS_COBRO, { "0.50€": 3 })).toBe(0);
        expect(totalRecuento(DENOMS_COBRO, {})).toBe(0);
    });

    it("barrido: todo importe múltiplo de 5 céntimos, pagado exacto, da exactamente ese importe", () => {
        for (let c = 0; c <= 100_000; c += 5) {
            const total = totalRecuento(DENOMS_COBRO, pagarExacto(c));
            if (total !== c / 100) throw new Error(`${c} céntimos contados dan ${total}`);
        }
    });
});

describe("cambioDelCobro", () => {
    it("pagar justo 1,10 + 2,20 no enseña «Cambio -0,00 €»", () => {
        // El fallo que había: 1,1 + 2,2 = 3,3000000000000003, y la resta redondeada daba -0.
        const aCobrar = [1.1, 2.2].reduce((a, b) => a + b, 0);
        const entregado = totalRecuento(DENOMS_COBRO, { "2€": 1, "1€": 1, "0,20€": 1, "0,10€": 1 });

        const cambio = cambioDelCobro(entregado, aCobrar);

        expect(Object.is(cambio, 0)).toBe(true);
        expect(pantalla(cambio)).toBe(pantalla(0));
    });

    it("lo que falta sale en negativo y exacto", () => {
        expect(cambioDelCobro(10, 12.4)).toBe(-2.4);
        expect(cambioDelCobro(3.45, 3.47)).toBe(-0.02);
    });

    it("el total a cobrar se redondea antes de restar", () => {
        // 0,30000000000000004 son 0,30 €: pagarlos con 0,30 no puede decir que falta nada.
        expect(cambioDelCobro(0.3, 0.1 + 0.2)).toBe(0);
        expect(cambioDelCobro(20, 0.1 + 0.2)).toBe(19.7);
    });

    it("barrido: de 0,05 a 1.000 € repartidos en líneas, pagar justo, de más o de menos da el cambio exacto", () => {
        const azar = generador(1107);
        for (let c = 5; c <= 100_000; c += 5) {
            const aCobrar = enLineas(c, 1 + azar(6), azar).reduce((a, b) => a + b, 0);

            const justo = cambioDelCobro(totalRecuento(DENOMS_COBRO, pagarExacto(c)), aCobrar);
            if (!Object.is(justo, 0)) throw new Error(`${c} céntimos pagados justos dan ${justo}`);

            const deMas = cambioDelCobro(totalRecuento(DENOMS_COBRO, pagarExacto(c + 5)), aCobrar);
            if (deMas !== 0.05) throw new Error(`${c} céntimos con 5 de más dan ${deMas}`);

            const deMenos = cambioDelCobro(totalRecuento(DENOMS_COBRO, pagarExacto(c - 5)), aCobrar);
            if (deMenos !== -0.05) throw new Error(`${c} céntimos con 5 de menos dan ${deMenos}`);
        }
    });
});

describe("calcularArqueo (igual que `calcular` de Rust)", () => {
    it.each([
        // fondo, ventas, gastos, contado, dejado → esperado, descuadre, retirado
        { caso: "cuadra", e: [150, 320.45, 0, 470.45, 150], s: [470.45, 0, 320.45] },
        { caso: "los gastos pagados con caja restan", e: [150, 320.45, 18, 452.45, 150], s: [452.45, 0, 302.45] },
        { caso: "falta dinero", e: [100, 200, 0, 280, 100], s: [300, -20, 180] },
        { caso: "sobra dinero", e: [100, 200, 0, 305.5, 100], s: [300, 5.5, 205.5] },
        { caso: "se deja todo lo contado", e: [100, 200, 0, 300, 300], s: [300, 0, 0] },
    ])("$caso", ({ e: [fondoInicial, ventasEfectivo, gastosCaja, contado, dejado], s }) => {
        const a = calcularArqueo({ fondoInicial, ventasEfectivo, gastosCaja, contado, dejado });
        expect([a.esperado, a.descuadre, a.retirado]).toEqual(s);
    });

    it("lo que se deja es el fondo del periodo siguiente", () => {
        const hoy = calcularArqueo({ fondoInicial: 100, ventasEfectivo: 500, gastosCaja: 0, contado: 600, dejado: 120 });
        expect(hoy.retirado).toBe(480);

        const manana = calcularArqueo({
            fondoInicial: hoy.dejado,
            ventasEfectivo: 300,
            gastosCaja: 0,
            contado: 420,
            dejado: 100,
        });
        expect(manana.fondoInicial).toBe(120);
        expect(manana.esperado).toBe(420);
        expect(manana.descuadre).toBe(0);
    });

    it("el descuadre sale en céntimos, no con la cola de la resta", () => {
        // 305,01 − 300 = 5,009999999999991 en coma flotante.
        const a = calcularArqueo({ fondoInicial: 0, ventasEfectivo: 300, gastosCaja: 0, contado: 305.01, dejado: 0 });
        expect(a.descuadre).toBe(5.01);
    });

    it("una caja que cuadra no enseña «-0,00 €» en ninguna cifra", () => {
        const a = calcularArqueo({ fondoInicial: 0.1, ventasEfectivo: 0.2, gastosCaja: 0, contado: 0.3, dejado: 0.3 });
        for (const [campo, v] of Object.entries(a)) {
            expect(pantalla(v), campo).not.toMatch(/^-/);
        }
        expect(Object.is(a.descuadre, 0)).toBe(true);
    });

    it("barrido: contar en billetes y monedas justo lo esperado siempre cuadra", () => {
        const denoms: Denominacion[] = [
            ...DENOMS_COBRO,
            { label: "0,02€", value: 0.02 },
            { label: "0,01€", value: 0.01 },
        ];
        const azar = generador(606);
        for (let i = 0; i < 5000; i++) {
            const fondo = azar(50_000);
            const ventas = azar(500_000);
            const gastos = azar(fondo + ventas + 1);
            const esperadoEnCentimos = fondo + ventas - gastos;
            const dejadoEnCentimos = azar(esperadoEnCentimos + 1);

            const a = calcularArqueo({
                fondoInicial: fondo / 100,
                ventasEfectivo: ventas / 100,
                gastosCaja: gastos / 100,
                contado: totalRecuento(denoms, pagarExacto(esperadoEnCentimos, denoms)),
                dejado: totalRecuento(denoms, pagarExacto(dejadoEnCentimos, denoms)),
            });

            const esperaba = `fondo ${fondo}, ventas ${ventas}, gastos ${gastos}, dejado ${dejadoEnCentimos}`;
            if (a.esperado !== esperadoEnCentimos / 100) throw new Error(`${esperaba}: esperado ${a.esperado}`);
            if (!Object.is(a.descuadre, 0)) throw new Error(`${esperaba}: descuadre ${a.descuadre}`);
            if (a.retirado !== (esperadoEnCentimos - dejadoEnCentimos) / 100) {
                throw new Error(`${esperaba}: retirado ${a.retirado}`);
            }
        }
    });
});

describe("exigeMotivo (igual que `exige_motivo` de Rust)", () => {
    it.each([
        [-4.99, 5, false],
        [5, 5, false], // justo en el umbral no salta
        [-5, 5, false],
        [-5.01, 5, true],
        [5.01, 5, true],
        [40, 5, true], // sobrar es tan raro como que falte
        [0.01, 0, true], // con umbral cero, cualquier descuadre
        [0, 0, false],
        [0.01, -1, true], // un umbral negativo se lee como cero
        [0, -1, false],
    ])("descuadre %s con umbral %s → %s", (descuadre, umbral, esperado) => {
        expect(exigeMotivo(descuadre, umbral)).toBe(esperado);
    });

    it("decide sobre el descuadre ya redondeado, como Rust", () => {
        // Sin redondear, 305 − 299,996 = 5,004 pasaría del umbral; en céntimos son 5,00 y no pasa.
        const a = calcularArqueo({ fondoInicial: 0, ventasEfectivo: 299.996, gastosCaja: 0, contado: 305, dejado: 0 });
        expect(a.descuadre).toBe(5);
        expect(exigeMotivo(a.descuadre, 5)).toBe(false);
    });
});

describe("validarCierre (igual que `validar` de Rust)", () => {
    const grande = calcularArqueo({ fondoInicial: 100, ventasEfectivo: 200, gastosCaja: 0, contado: 250, dejado: 100 });
    const cuadrado = calcularArqueo({ fondoInicial: 150, ventasEfectivo: 100, gastosCaja: 0, contado: 250, dejado: 150 });

    it("un descuadre grande sin motivo no se puede guardar", () => {
        expect(validarCierre(grande, null, 5)).toBe("falta_motivo");
        expect(validarCierre(grande, undefined, 5)).toBe("falta_motivo");
        expect(validarCierre(grande, "se pagó un pedido en efectivo", 5)).toBeNull();
    });

    it("un motivo en blanco no cuenta como motivo", () => {
        for (const blanco of ["", "   ", "\n\t "]) {
            expect(validarCierre(grande, blanco, 5), JSON.stringify(blanco)).toBe("falta_motivo");
        }
    });

    it("un cierre cuadrado no necesita motivo", () => {
        expect(validarCierre(cuadrado, null, 5)).toBeNull();
        expect(validarCierre(cuadrado, "", 5)).toBeNull();
    });

    it("no se puede dejar más de lo contado, aunque haya motivo", () => {
        const a = calcularArqueo({ fondoInicial: 100, ventasEfectivo: 50, gastosCaja: 0, contado: 150, dejado: 200 });
        expect(validarCierre(a, "lo que sea", 5)).toBe("deja_mas_de_lo_contado");
    });

    it("dejar más de lo contado se dice antes que la falta de motivo, como en Rust", () => {
        const a = calcularArqueo({ fondoInicial: 100, ventasEfectivo: 200, gastosCaja: 0, contado: 150, dejado: 200 });
        expect(validarCierre(a, null, 5)).toBe("deja_mas_de_lo_contado");
    });

    it("dejar exactamente lo contado sí se puede", () => {
        const a = calcularArqueo({ fondoInicial: 100, ventasEfectivo: 200, gastosCaja: 0, contado: 300, dejado: 300 });
        expect(validarCierre(a, null, 5)).toBeNull();
    });
});
