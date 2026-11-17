import { Circle, Group, Rect, Text } from "react-konva";

import type { AspectoMesa, MesaPlano } from "./tipos";

/** Una mesa del plano: su forma, sus dos líneas de texto y, si es pulsable, el gesto. */
export default function NodoMesa({
    mesa,
    aspecto,
    onPulsar,
    dejarDesplazar = false,
}: {
    mesa: MesaPlano;
    aspecto: AspectoMesa;
    onPulsar?: (mesa: MesaPlano) => void;
    /** Que un dedo sobre la mesa desplace la página (ver `Lienzo`). */
    dejarDesplazar?: boolean;
}) {
    const tactil = dejarDesplazar ? { preventDefault: false } : {};
    const pulsar = aspecto.pulsable && onPulsar ? () => onPulsar(mesa) : undefined;
    const r = mesa.radius ?? 45;
    // MES-INC-04: cada texto en una sola línea, cortado con «…» si no cabe. Con su ancho, Konva
    // parte un nombre largo en varias líneas, y en una mesa pequeña bajaban encima de la segunda.
    const unaLinea = { wrap: "none", ellipsis: true } as const;

    return (
        <Group x={mesa.x} y={mesa.y} onClick={pulsar} onTap={pulsar}>
            {mesa.shape === "circle" ? (
                <>
                    <Circle
                        x={r}
                        y={r}
                        radius={r}
                        fill={aspecto.relleno}
                        stroke={aspecto.borde}
                        strokeWidth={aspecto.grosorBorde}
                        shadowBlur={10}
                        shadowOpacity={0.12}
                        {...tactil}
                    />
                    <Text
                        text={aspecto.etiqueta}
                        x={0}
                        y={r - 22}
                        width={r * 2}
                        align="center"
                        fontSize={13}
                        fill={aspecto.texto}
                        {...unaLinea}
                        {...tactil}
                    />
                    <Text
                        text={aspecto.subetiqueta}
                        x={0}
                        y={r + 2}
                        width={r * 2}
                        align="center"
                        fontSize={11}
                        fill={aspecto.subtexto}
                        {...unaLinea}
                        {...tactil}
                    />
                </>
            ) : (
                <>
                    <Rect
                        width={mesa.width}
                        height={mesa.height}
                        cornerRadius={mesa.shape === "rounded" ? 14 : 2}
                        fill={aspecto.relleno}
                        stroke={aspecto.borde}
                        strokeWidth={aspecto.grosorBorde}
                        shadowBlur={10}
                        shadowOpacity={0.12}
                        {...tactil}
                    />
                    <Text text={aspecto.etiqueta} x={10} y={10} width={Math.max(mesa.width - 20, 0)} fontSize={13} fill={aspecto.texto} {...unaLinea} {...tactil} />
                    <Text text={aspecto.subetiqueta} x={10} y={30} width={Math.max(mesa.width - 20, 0)} fontSize={11} fill={aspecto.subtexto} {...unaLinea} {...tactil} />
                </>
            )}
        </Group>
    );
}
