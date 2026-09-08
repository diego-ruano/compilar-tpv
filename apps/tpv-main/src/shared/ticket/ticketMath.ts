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

/** Una línea tal y como llega del POS (una por pulsación) o de un cobro ya hecho. */
export type LineaEntrada = {
	nombre: string;
	precio: number;
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
	precio: number;
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
	| { clase: "sujeta"; tipo: number; base: number; iva: number }
	| { clase: "exenta"; causa: string; base: number };

/** Causa por defecto de una línea marcada exenta sin elegir cuál. Gemelo del dominio. */
export const CAUSA_EXENCION_POR_DEFECTO = "E1";

/** Redondeo a céntimos. Lo que se compara es lo que se imprime, no el flotante. */
export function aCentimos(n: number): number {
	return Math.round(n * 100) / 100;
}

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
export function eur(n: number): string {
	const c = aCentimos(n);
	return `${(c === 0 ? 0 : c).toFixed(2).replace(".", ",")} €`;
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
		const precio = entera ? it.precio : it.precio * (it.cantidad ?? 1);
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
export function totalDe(lineas: LineaAgrupada[]): number {
	return lineas.reduce((acc, g) => acc + g.qty * g.precio, 0);
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
	const porTipo = new Map<number, number>();
	const porCausa = new Map<string, number>();
	for (const g of lineas) {
		const importe = g.qty * g.precio;
		if (g.exento) {
			const causa = g.causaExencion || CAUSA_EXENCION_POR_DEFECTO;
			porCausa.set(causa, (porCausa.get(causa) ?? 0) + importe);
		} else {
			const tipo = g.ivaPercent ?? ivaNegocio ?? 0;
			porTipo.set(tipo, (porTipo.get(tipo) ?? 0) + importe);
		}
	}

	const sujetas: TramoIva[] = Array.from(porTipo.entries())
		.sort((a, b) => a[0] - b[0])
		.map(([tipo, bruto]) => {
			const totalTramo = aCentimos(bruto);
			const divisor = 1 + tipo / 100;
			const base = divisor === 0 ? totalTramo : aCentimos(totalTramo / divisor);
			return { clase: "sujeta" as const, tipo, base, iva: aCentimos(totalTramo - base) };
		});

	const exentas: TramoIva[] = Array.from(porCausa.entries())
		.sort((a, b) => a[0].localeCompare(b[0]))
		.map(([causa, bruto]) => ({ clase: "exenta" as const, causa, base: aCentimos(bruto) }));

	return [...sujetas, ...exentas];
}

/** Suma de las bases del desglose. */
export function baseTotal(tramos: TramoIva[]): number {
	return aCentimos(tramos.reduce((acc, t) => acc + t.base, 0));
}

/** Suma de las cuotas. Un tramo exento aporta cero — y en el XML ese cero no se informa. */
export function cuotaTotal(tramos: TramoIva[]): number {
	return aCentimos(tramos.reduce((acc, t) => acc + (t.clase === "sujeta" ? t.iva : 0), 0));
}
