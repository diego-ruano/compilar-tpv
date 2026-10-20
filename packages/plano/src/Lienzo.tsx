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
    dejarDesplazar = false,
}: {
    salon: SalonPlano;
    tamano: { width: number; height: number };
    vista: Vista;
    /** Konva necesita colores literales. */
    fondo: string;
    bordeSalon: string;
    aspecto: (mesa: MesaPlano) => AspectoMesa;
    onPulsarMesa?: (mesa: MesaPlano) => void;
    /**
     * Que un dedo sobre el plano desplace la página. Konva cancela el toque en sus figuras
     * (`preventDefault`), y en el widget de reservas web, metido en la web de un restaurante, con el
     * dedo en el plano no se podía bajar ni subir: ni el widget ni la página. Pulsar una mesa sigue
     * funcionando. La sala de la Main lo deja como siempre.
     */
    dejarDesplazar?: boolean;
}) {
    if (!tamano.width || !tamano.height) return null;
    const tactil = dejarDesplazar ? { preventDefault: false } : {};
    return (
        <Stage width={tamano.width} height={tamano.height} style={{ background: fondo }}>
            <Layer>
                <Rect x={0} y={0} width={tamano.width} height={tamano.height} fill={fondo} {...tactil} />
                <Group x={vista.x} y={vista.y} scaleX={vista.scale} scaleY={vista.scale}>
                    <Line points={salon.room.points} closed stroke={bordeSalon} strokeWidth={2} lineJoin="round" {...tactil} />
                    {salon.tables.map((t) => (
                        <NodoMesa key={t.id} mesa={t} aspecto={aspecto(t)} onPulsar={onPulsarMesa} dejarDesplazar={dejarDesplazar} />
                    ))}
                </Group>
            </Layer>
        </Stage>
    );
}
