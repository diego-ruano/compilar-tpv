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
                    <Text text={aspecto.etiqueta} x={10} y={10} fontSize={13} fill={aspecto.texto} {...tactil} />
                    <Text text={aspecto.subetiqueta} x={10} y={30} fontSize={11} fill={aspecto.subtexto} {...tactil} />
                </>
            )}
        </Group>
    );
}
