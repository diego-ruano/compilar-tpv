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
};

/** Una línea ya agrupada, como se imprime. */
export type LineaAgrupada = {
	nombre: string;
	precio: number;
	qty: number;
	ivaPercent: number | null;
};

/** Un tramo del desglose del pie: base y cuota de un tipo de IVA. */
export type TramoIva = { tipo: number; base: number; iva: number };

/** Redondeo a céntimos. Lo que se compara es lo que se imprime, no el flotante. */
export function aCentimos(n: number): number {
	return Math.round(n * 100) / 100;
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
		const key = `${it.nombre}__${precio}__${iva ?? "neg"}`;
		const cur = map.get(key);
		if (!cur) map.set(key, { nombre: it.nombre, precio, qty: unidades, ivaPercent: iva });
		else cur.qty += unidades;
	}
	return Array.from(map.values());
}

/** Total del ticket: lo que se cobra. */
export function totalDe(lineas: LineaAgrupada[]): number {
	return lineas.reduce((acc, g) => acc + g.qty * g.precio, 0);
}

/**
 * Reparto por tipo de IVA. Espejo de `desglose_iva` en `printing.rs`.
 *
 * Los precios llevan el IVA incluido (es lo que se le enseña al cliente en hostelería), así que la
 * base se saca dividiendo. Se calcula **por línea y luego se suma por tipo**: con dos tipos
 * distintos, aplicar uno solo al total da un desglose que no cuadra con lo cobrado.
 *
 * ⚠️ **La cuota no se redondea: se despeja.** Redondear base y cuota por separado hace que a veces
 * suban las dos y el papel diga `0,38 + 0,02 = 0,39` (0,39 € al 4 % es el primer caso). Un ticket
 * cuya base más su IVA no dan el total es un documento contable mal emitido.
 */
export function desgloseIva(lineas: LineaAgrupada[], ivaNegocio: number | null): TramoIva[] {
	const porTipo = new Map<number, number>();
	for (const g of lineas) {
		const tipo = g.ivaPercent ?? ivaNegocio ?? 0;
		porTipo.set(tipo, (porTipo.get(tipo) ?? 0) + g.qty * g.precio);
	}
	return Array.from(porTipo.entries())
		.sort((a, b) => a[0] - b[0])
		.map(([tipo, bruto]) => {
			const totalTramo = aCentimos(bruto);
			const divisor = 1 + tipo / 100;
			const base = divisor === 0 ? totalTramo : aCentimos(totalTramo / divisor);
			return { tipo, base, iva: aCentimos(totalTramo - base) };
		});
}
