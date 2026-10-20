// El paso 2: el plano del restaurante, el mismo de la sala de la Main (`@tpv/plano`), con las mesas
// libres y adecuadas resaltadas en el acento y el resto en gris y sin pulsar. Debajo, las mismas
// mesas libres en botones: lo que el lienzo no hace accesible, y lo que sirve en un móvil pequeño.

import { useMemo, useState } from "react";
import {
	Lienzo,
	fitTransform,
	tamanoDelContenido,
	useElementSize,
	type AspectoMesa,
	type MesaPlano,
	type OpcionesEncaje,
	type SalonPlano,
} from "@tpv/plano";
import { nombreDeMesa } from "@tpv/plano/nombre";

import type { MesaPublica, PlanoPublico } from "./api";

// Konva necesita colores literales: los del tema claro de @tpv/estilos.
const COLOR = {
	fondo: "#ffffff",
	sala: "rgba(15,23,42,0.35)",
	libre: "#016ffc",
	elegida: "#0fb968",
	apagada: "rgba(148,163,184,0.25)",
	bordeApagada: "rgba(148,163,184,0.6)",
	textoClaro: "#ffffff",
	textoApagado: "#8a93a2",
};

/**
 * El plano del widget se encaja a las mesas, no al contorno del salón, y con más zoom que la sala de
 * la Main: con el salón entero y un tope de 1,15 en un hueco pequeño, las mesas salían diminutas.
 */
const ENCAJE: OpcionesEncaje = { soloMesas: true, escalaMaxima: 2.5 };
const MARGEN = 16;
const ALTO_MIN = 280;
const ALTO_MAX = 640;

/**
 * Lo alto que tiene que ser el lienzo para que las mesas, encajadas a lo ancho, quepan: la forma del
 * conjunto de mesas, entre un mínimo y un máximo. Se calcula del ancho y no de la ventana: la altura
 * del iframe la decide su contenido, y un alto en `vh` crecería con él.
 */
export function altoDelPlano(salon: SalonPlano, ancho: number): number {
	const { ancho: w, alto: h } = tamanoDelContenido(salon, ENCAJE.soloMesas);
	const alto = 0.9 * Math.max(1, ancho - MARGEN * 2) * (h / w) + MARGEN * 2;
	return Math.round(Math.min(Math.max(alto, ALTO_MIN), ALTO_MAX));
}

/** De lo que devuelve `/plano` a lo que dibuja el lienzo. Unos puntos rotos dejan la sala sin contorno. */
function salonesDelPlano(plano: PlanoPublico): SalonPlano[] {
	return plano.salones.map((s) => {
		let puntos: number[] = [];
		try {
			const crudo = JSON.parse(s.puntos);
			if (Array.isArray(crudo) && crudo.every((p) => typeof p === "number" && Number.isFinite(p))) puntos = crudo;
			// Algunos planos guardan pares `[[x, y], …]`.
			else if (Array.isArray(crudo) && crudo.every((p) => Array.isArray(p) && p.length === 2)) puntos = crudo.flat();
		} catch {
			// Sin contorno.
		}
		return {
			id: s.id,
			name: s.nombre,
			room: { points: puntos },
			tables: plano.mesas
				.filter((m) => m.id_salon === s.id)
				.map((m) => ({
					id: m.id,
					name: m.numero,
					x: m.x,
					y: m.y,
					width: m.ancho,
					height: m.alto,
					radius: m.radio,
					seats: m.capacidad,
					shape: m.forma,
				})),
		};
	});
}

export default function PlanoWidget({
	plano,
	libres,
	elegida,
	onElegir,
}: {
	plano: PlanoPublico;
	/** Los ids de las mesas libres y adecuadas. */
	libres: string[];
	elegida: string | null;
	onElegir: (mesa: MesaPublica) => void;
}) {
	const salones = useMemo(() => salonesDelPlano(plano), [plano]);
	const libre = useMemo(() => new Set(libres), [libres]);
	// Se empieza por el primer salón que tenga alguna mesa libre.
	const [salonId, setSalonId] = useState(
		() => salones.find((s) => s.tables.some((t) => libre.has(t.id)))?.id ?? salones[0]?.id ?? "",
	);
	const salon = salones.find((s) => s.id === salonId) ?? salones[0] ?? null;
	const { ref, size } = useElementSize<HTMLDivElement>();
	const alto = salon ? altoDelPlano(salon, size.width) : ALTO_MIN;
	const vista = useMemo(
		() => (salon ? fitTransform(salon, size.width, alto, MARGEN, ENCAJE) : { x: 0, y: 0, scale: 1 }),
		[salon, size.width, alto],
	);
	const porId = useMemo(() => new Map(plano.mesas.map((m) => [m.id, m])), [plano]);

	const aspecto = (t: MesaPlano): AspectoMesa => {
		const esElegida = t.id === elegida;
		const esLibre = libre.has(t.id);
		return {
			relleno: esElegida ? COLOR.elegida : esLibre ? COLOR.libre : COLOR.apagada,
			borde: esElegida ? COLOR.elegida : esLibre ? COLOR.libre : COLOR.bordeApagada,
			grosorBorde: esElegida ? 4 : 1,
			texto: esLibre || esElegida ? COLOR.textoClaro : COLOR.textoApagado,
			subtexto: esLibre || esElegida ? COLOR.textoClaro : COLOR.textoApagado,
			// En el dibujo, el nombre tal cual, como en la sala de la Main.
			etiqueta: t.name,
			subetiqueta: `${t.seats} plazas`,
			pulsable: esLibre,
		};
	};

	// Las del salón que se ve, como el plano: dos salones pueden tener una «Mesa 5» cada uno.
	const libresDelSalon = plano.mesas.filter((m) => libre.has(m.id) && m.id_salon === salon?.id);
	const otrosConSitio = salones.filter((s) => s.id !== salon?.id && s.tables.some((t) => libre.has(t.id)));

	return (
		<div>
			{salones.length > 1 ? (
				<div role="tablist" aria-label="Salones" className="mb-3 flex flex-wrap gap-2">
					{salones.map((s) => (
						<button
							key={s.id}
							type="button"
							role="tab"
							aria-selected={s.id === salon?.id}
							onClick={() => setSalonId(s.id)}
							className={`cursor-pointer rounded-xl px-3 py-1.5 text-sm font-bold ${
								s.id === salon?.id ? "bg-accent text-accent-fg" : "border border-border bg-surface-2 text-fg"
							}`}
						>
							{s.name}
						</button>
					))}
				</div>
			) : null}

			<div ref={ref} style={{ height: alto }} className="w-full overflow-hidden rounded-2xl border border-border bg-white" aria-hidden>
				{salon ? (
					<Lienzo
						salon={salon}
						tamano={{ width: size.width, height: alto }}
						vista={vista}
						fondo={COLOR.fondo}
						bordeSalon={COLOR.sala}
						aspecto={aspecto}
						onPulsarMesa={(t) => {
							const m = porId.get(t.id);
							if (m) onElegir(m);
						}}
					/>
				) : null}
			</div>

			<div className="mt-3">
				<div className="mb-2 text-sm text-fg-muted">
					{salones.length > 1 && salon ? `Mesas libres en ${salon.name}:` : "Mesas libres:"}
					{libresDelSalon.length === 0 && otrosConSitio.length ? ` ninguna; hay en ${otrosConSitio.map((s) => s.name).join(", ")}.` : ""}
				</div>
				<div className="flex flex-wrap gap-2">
					{libresDelSalon.map((m) => (
						<button
							key={m.id}
							type="button"
							aria-pressed={m.id === elegida}
							onClick={() => onElegir(m)}
							className={`cursor-pointer rounded-xl px-3 py-2 text-sm font-bold ${
								m.id === elegida ? "bg-success text-success-fg" : "bg-accent-soft text-accent hover:bg-accent hover:text-accent-fg"
							}`}
						>
							{nombreDeMesa(m.numero)} · {m.capacidad} plazas
						</button>
					))}
				</div>
			</div>
		</div>
	);
}
