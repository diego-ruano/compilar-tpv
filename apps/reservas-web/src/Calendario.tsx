// El calendario del paso 1: sólo se pueden pulsar los días abiertos del horizonte.

import { useState } from "react";

import { mesDe, mesSiguiente, nombreDelMes, semanasDelMes } from "./logica";

const CABECERA = ["L", "M", "X", "J", "V", "S", "D"];

export default function Calendario({
	abiertos,
	primerDia,
	ultimoDia,
	elegido,
	onElegir,
}: {
	abiertos: string[];
	primerDia: string;
	ultimoDia: string;
	elegido: string | null;
	onElegir: (dia: string) => void;
}) {
	const [mes, setMes] = useState(() => mesDe(elegido ?? abiertos[0] ?? primerDia));
	const primero = mesDe(primerDia);
	const ultimo = mesDe(ultimoDia);
	const antes = mes.anio * 12 + mes.mes > primero.anio * 12 + primero.mes;
	const despues = mes.anio * 12 + mes.mes < ultimo.anio * 12 + ultimo.mes;
	const abierto = new Set(abiertos);

	return (
		<div>
			<div className="mb-2 flex items-center justify-between">
				<button
					type="button"
					aria-label="Mes anterior"
					disabled={!antes}
					onClick={() => setMes(mesSiguiente(mes, -1))}
					className="size-9 cursor-pointer rounded-lg text-lg text-fg hover:bg-surface-2 disabled:invisible"
				>
					‹
				</button>
				<div className="text-sm font-bold capitalize">{nombreDelMes(mes)}</div>
				<button
					type="button"
					aria-label="Mes siguiente"
					disabled={!despues}
					onClick={() => setMes(mesSiguiente(mes, 1))}
					className="size-9 cursor-pointer rounded-lg text-lg text-fg hover:bg-surface-2 disabled:invisible"
				>
					›
				</button>
			</div>
			<div role="grid" aria-label={`Días de ${nombreDelMes(mes)}`} className="grid grid-cols-7 gap-1 text-center text-sm">
				{CABECERA.map((d) => (
					<div key={d} className="py-1 text-xs font-bold text-fg-subtle">
						{d}
					</div>
				))}
				{semanasDelMes(mes)
					.flat()
					.map((dia, i) =>
						dia === null ? (
							<div key={`h${i}`} />
						) : (
							<button
								key={dia}
								type="button"
								disabled={!abierto.has(dia)}
								aria-pressed={elegido === dia}
								aria-label={dia}
								onClick={() => onElegir(dia)}
								className={`h-10 cursor-pointer rounded-lg font-semibold transition disabled:cursor-default disabled:text-fg-subtle/60 ${
									elegido === dia
										? "bg-accent text-accent-fg"
										: abierto.has(dia)
											? "bg-accent-soft text-accent hover:bg-accent hover:text-accent-fg"
											: ""
								}`}
							>
								{Number(dia.slice(8, 10))}
							</button>
						),
					)}
			</div>
		</div>
	);
}
