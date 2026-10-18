import { Group, Layer, Line, Rect, Stage } from "react-konva";

import NodoMesa from "./NodoMesa";
import type { AspectoMesa, MesaPlano, SalonPlano, Vista } from "./tipos";

/**
 * El lienzo de un salón: el fondo, el contorno de la sala y sus mesas, encajado según `vista`. Sólo
 * dibuja: qué color lleva cada mesa y si se puede pulsar lo dice `aspecto`, porque eso depende de
 * quién mira (la sala de la Main, el widget de reservas web).
 */
export default function Lienzo({
    salon,
    tamano,
    vista,
    fondo,
    bordeSalon,
    aspecto,
    onPulsarMesa,
}: {
    salon: SalonPlano;
    tamano: { width: number; height: number };
    vista: Vista;
    /** Konva necesita colores literales. */
    fondo: string;
    bordeSalon: string;
    aspecto: (mesa: MesaPlano) => AspectoMesa;
    onPulsarMesa?: (mesa: MesaPlano) => void;
}) {
    if (!tamano.width || !tamano.height) return null;
    return (
        <Stage width={tamano.width} height={tamano.height} style={{ background: fondo }}>
            <Layer>
                <Rect x={0} y={0} width={tamano.width} height={tamano.height} fill={fondo} />
                <Group x={vista.x} y={vista.y} scaleX={vista.scale} scaleY={vista.scale}>
                    <Line points={salon.room.points} closed stroke={bordeSalon} strokeWidth={2} lineJoin="round" />
                    {salon.tables.map((t) => (
                        <NodoMesa key={t.id} mesa={t} aspecto={aspecto(t)} onPulsar={onPulsarMesa} />
                    ))}
                </Group>
            </Layer>
        </Stage>
    );
}
