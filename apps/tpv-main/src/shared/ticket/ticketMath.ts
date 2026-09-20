// src/shared/ticket/ticketMath.ts
//
// Las cuentas del ticket, sin React.
//
// La vista previa (`TicketPaper`) es un espejo del generador ESC/POS de Rust (`printing.rs`): tiene
// que enseñar exactamente los mismos números que va a escupir la impresora. Mientras esas cuentas
// vivían dentro de un `useMemo` del componente, comprobar que los dos lados coinciden pedía montar
// React en los tests, así que no se comprobaba.
//
// ⚠️ Todo lo de aquí tiene su gemelo en `printing.rs`. Si cambia una de las dos, cambian las dos:
// una vista previa que no coincide con el papel es peor que no tener vista previa, porque el
// usuario configura contra ella.

import type { Dinero } from "@tpv/contracts";
import { CERO, entre, por, redondear, restar, sumar, textoFiscal } from "../lib/dinero";

/** Una línea tal y como llega del POS (una por pulsación) o de un cobro ya hecho. */
export type LineaEntrada = {
	nombre: string;
	precio: Dinero;
	/** Tipo de IVA de la línea; `null`/ausente = el general del negocio. */
	ivaPercent?: number | null;
	/** Unidades de la línea. Ausente = 1. */
	cantidad?: number;
	/**
	 * FISCAL-01: la línea se vendió EXENTA de IVA. **No es lo mismo que un 0 %**, y por eso no se
	 * representa con `ivaPercent: 0`: son dos afirmaciones legales distintas y el registro de
	 * facturación las expresa en campos excluyentes (`CalificacionOperacion` vs `OperacionExenta`).
	 */
	exento?: boolean;
	/** `E1`..`E6`. Sólo se mira si `exento`. */
	causaExencion?: string | null;
};

/** Una línea ya agrupada, como se imprime. */
export type LineaAgrupada = {
	nombre: string;
	precio: Dinero;
	qty: number;
	ivaPercent: number | null;
	exento: boolean;
	causaExencion: string | null;
};

/**
 * Un tramo del desglose del pie. Gemelo de `TramoIva` en `tpv_domain::ticket`, y como allí son dos
 * clases y no una: el XSD del registro pone `CalificacionOperacion` y `OperacionExenta` en un
 * `<choice>`, así que un tramo exento **no tiene** tipo ni cuota — no los tiene a cero.
 */
export type TramoIva =
	| { clase: "sujeta"; tipo: number; base: Dinero; iva: Dinero }
	| { clase: "exenta"; causa: string; base: Dinero };

/** Causa por defecto de una línea marcada exenta sin elegir cuál. Gemelo del dominio. */
export const CAUSA_EXENCION_POR_DEFECTO = "E1";

// El redondeo vivía aquí, con un `Math.round` pelado, y NO era el de Rust: `Math.round` lleva la
// mitad hacia +∞ y `f64::round` la aleja del cero, así que -1,125 € daba -1,12 en esta vista previa
// y -1,13 en el papel. Ahora es el compartido (`shared/lib/dinero.ts`), fijado por la tabla de
// casos que leen las tres implementaciones.

/**
 * Importe en formato español: `1,70 €`. Gemelo de `fmt_eur` en `printing.rs`.
 *
 * A mano y no con `Intl.NumberFormat`, aunque duela: `Intl` mete el punto de los miles a partir de
 * cinco cifras (`12.345,67 €`) y usa un espacio duro antes del €, y el papel no hace ni lo uno ni
 * lo otro — en una columna de 32 caracteres, un punto de millar se confunde con el decimal. La
 * previa enseñaba un importe que la impresora no iba a escribir.
 *
 * El redondeo a céntimos va ANTES de formatear y con la misma operación que usa Rust, para que los
 * empates (1,125) caigan del mismo lado en los dos sitios.
 */
export function eur(d: Dinero): string {
	return `${textoFiscal(d).replace(".", ",")} €`;
}

/**
 * Recorta el nombre para que el importe quepa pegado al borde derecho. Gemelo de la parte
 * izquierda de `line_two` en `printing.rs`: mismo ancho disponible (`cols - importe - 1`) y mismo
 * criterio de conteo.
 *
 * Se corta por CARACTERES (`[...texto]`), no con `slice`: `slice` cuenta unidades UTF-16, así que
 * un emoji cuenta doble y, si el corte cae en medio, parte el par sustituto y pinta un rombo. Rust
 * cuenta caracteres, y el papel imprime un `?` por cada uno que no esté en su tabla.
 */
export function recortar(texto: string, importe: string, cols: number): string {
	const disponible = Math.max(0, cols - [...importe].length - 1);
	return [...texto].slice(0, disponible).join("");
}

/**
 * Agrupa las unidades idénticas en líneas con cantidad.
 *
 * El criterio es **nombre + precio + tipo de IVA**: dos unidades del mismo producto vendidas a
 * precios o tipos distintos son dos líneas, porque juntarlas obligaría a inventarse un precio
 * unitario que no es ninguno de los dos.
 *
 * Una cantidad fraccionada (un producto al peso) no cabe en un ticket que cuenta unidades enteras,
 * así que se pliega a una unidad por el importe de la línea: se pierde el detalle, no el dinero.
 */
export function agruparLineas(items: LineaEntrada[]): LineaAgrupada[] {
	const map = new Map<string, LineaAgrupada>();
	for (const it of items) {
		const iva = it.ivaPercent ?? null;
		const entera = Number.isInteger(it.cantidad);
		const unidades = entera ? (it.cantidad as number) : 1;
		// Céntimos por una cantidad fraccionaria vuelve a ser flotante: se redondea al
		// céntimo, igual que hace el SQL con su CAST(ROUND(...)).
		const precio = entera ? it.precio : redondear(it.precio * (it.cantidad ?? 1));
		const exento = it.exento === true;
		const causa = exento ? (it.causaExencion || CAUSA_EXENCION_POR_DEFECTO) : null;
		// La exención entra en la clave de agrupación: dos unidades del mismo producto, una exenta
		// y otra no, son dos líneas del ticket porque son dos tramos del desglose.
		const key = `${it.nombre}__${precio}__${iva ?? "neg"}__${causa ?? ""}`;
		const cur = map.get(key);
		if (!cur)
			map.set(key, { nombre: it.nombre, precio, qty: unidades, ivaPercent: iva, exento, causaExencion: causa });
		else cur.qty += unidades;
	}
	return Array.from(map.values());
}

/** Total del ticket: lo que se cobra. */
export function totalDe(lineas: LineaAgrupada[]): Dinero {
	return sumar(...lineas.map((g) => por(g.precio, g.qty)));
}

/**
 * Reparto por tipo de IVA. Espejo de `tpv_domain::ticket::desglose` (que es de donde salen también
 * el papel y el registro que se remite a la AEAT).
 *
 * Los precios llevan el IVA incluido (es lo que se le enseña al cliente en hostelería), así que la
 * base se saca dividiendo. Se calcula **por línea y luego se suma por tipo**: con dos tipos
 * distintos, aplicar uno solo al total da un desglose que no cuadra con lo cobrado.
 *
 * ⚠️ **La cuota no se redondea: se despeja.** Redondear base y cuota por separado hace que a veces
 * suban las dos y el papel diga `0,38 + 0,02 = 0,39` (0,39 € al 4 % es el primer caso). Un ticket
 * cuya base más su IVA no dan el total es un documento contable mal emitido — y en el registro es
 * además el error admisible 2005 de la AEAT.
 *
 * Las **exentas** se agrupan por causa, van después de las sujetas y no llevan ni tipo ni cuota.
 */
export function desgloseIva(lineas: LineaAgrupada[], ivaNegocio: number | null): TramoIva[] {
	const porTipo = new Map<number, Dinero>();
	const porCausa = new Map<string, Dinero>();
	for (const g of lineas) {
		const importe = por(g.precio, g.qty);
		if (g.exento) {
			const causa = g.causaExencion || CAUSA_EXENCION_POR_DEFECTO;
			porCausa.set(causa, sumar(porCausa.get(causa) ?? CERO, importe));
		} else {
			const tipo = g.ivaPercent ?? ivaNegocio ?? 0;
			porTipo.set(tipo, sumar(porTipo.get(tipo) ?? CERO, importe));
		}
	}

	const sujetas: TramoIva[] = Array.from(porTipo.entries())
		.sort((a, b) => a[0] - b[0])
		.map(([tipo, bruto]) => {
			const totalTramo = bruto;
			const divisor = 1 + tipo / 100;
			// La base se DIVIDE, no se multiplica por el recíproco: la de 0,91 € al 4 % sale 87
			// por ese camino y 88 dividiendo, que es lo que imprime el papel.
			const base = divisor === 0 ? totalTramo : entre(totalTramo, divisor);
			return { clase: "sujeta" as const, tipo, base, iva: restar(totalTramo, base) };
		});

	const exentas: TramoIva[] = Array.from(porCausa.entries())
		.sort((a, b) => a[0].localeCompare(b[0]))
		.map(([causa, bruto]) => ({ clase: "exenta" as const, causa, base: bruto }));

	return [...sujetas, ...exentas];
}

/** Suma de las bases del desglose. */
export function baseTotal(tramos: TramoIva[]): Dinero {
	return sumar(...tramos.map((t) => t.base));
}

/** Suma de las cuotas. Un tramo exento aporta cero — y en el XML ese cero no se informa. */
export function cuotaTotal(tramos: TramoIva[]): Dinero {
	return sumar(...tramos.map((t) => (t.clase === "sujeta" ? t.iva : CERO)));
}
