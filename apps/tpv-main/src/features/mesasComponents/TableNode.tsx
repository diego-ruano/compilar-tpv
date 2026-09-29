// components/mesasComponents/TableNode.tsx
import React, { useMemo } from "react";
import { Group, Text, Rect, Circle } from "react-konva";
import type { MesaMetaOut } from "@tpv/contracts";
import type { Table } from "./types";
import { parseMesaId } from "./ParseMesaId";

type MesaMetaMap = Record<number, MesaMetaOut> & Record<string, MesaMetaOut>;

export default function TableNode({
    table,
    mesaMetaById,
    onOpenMesa,
    dark = false,
}: {
    table: Table;
    mesaMetaById: MesaMetaMap;
    onOpenMesa: (mesaId: string, mesaNombre: string) => void;
    dark?: boolean;
}) {
    const idMesa = parseMesaId(table.id);

    // `parseMesaId` devuelve el UUID puro, que es la clave con la que `mesasLoadMesaMeta`
    // indexa el mapa. Un único lookup directo.
    const meta: MesaMetaOut | undefined = idMesa ? mesaMetaById[idMesa] : undefined;

    const reserva = meta?.reserva ?? null;
    const isReservaActiva = reserva?.estado === "ACTIVA";
    const isReservaProxima = reserva?.estado === "PROXIMA";

    // Pendiente: lo dice el estado, y si no, que quede algo por cobrar o por preparar.
    const isPendiente = useMemo(() => {
        if (!meta) return false;
        if (meta.estado === "PENDIENTE") return true;
        return meta.pendientesPago > 0 || meta.totalPendiente > 0 || meta.pendientesCocina > 0;
    }, [meta]);

    // ===== Colores =====
    // Prioridad:
    // - pendiente -> naranja
    // - reserva activa -> azul
    // - reserva próxima -> borde azul
    // - libre -> oscuro
    // "libre": oscuro sobre lienzo claro; un slate medio sobre lienzo oscuro
    const libreFill = dark ? "rgba(71,85,105,0.95)" : "rgba(15,23,42,0.92)";

    const fill = isPendiente
        ? "rgba(245,158,11,0.92)"
        : isReservaActiva
            ? "rgba(37,99,235,0.92)"
            : libreFill;

    const stroke = isPendiente
        ? "rgba(245,158,11,0.92)"
        : isReservaProxima
            ? "rgba(37,99,235,0.95)"
            : "rgba(148,163,184,0.95)";

    const strokeWidth = isPendiente ? 3 : isReservaProxima ? 4 : 1;

    // ===== Colores de texto =====
    // Sobre amber (pendiente) el texto oscuro tiene más contraste; sobre slate/blue el claro.
    const textFill = isPendiente ? "#1c1917" : "#e5e7eb";
    const subTextFill = isPendiente ? "#44403c" : "#cbd5e1";

    // ===== Textos =====
    const topLabel =
        isReservaActiva && reserva?.clienteNombre
            ? `${table.name} · Reserva ${reserva.clienteNombre}`
            : table.name;

    const bottomLabel =
        isReservaProxima && reserva?.clienteNombre
            ? `Reserva ${reserva.clienteNombre} en ${Math.max(
                0,
                reserva.minutosPara,
            )} min`
            : `${table.seats} pax`;

    const handleClick = () => {
        if (!idMesa) return;
        onOpenMesa(idMesa, table.name);
    };

    return (
        <Group
            x={table.x}
            y={table.y}
            onClick={handleClick}
            onTap={handleClick}
        >
            {table.shape === "circle" ? (
                <>
                    <Circle
                        x={table.radius ?? 45}
                        y={table.radius ?? 45}
                        radius={table.radius ?? 45}
                        fill={fill}
                        stroke={stroke}
                        strokeWidth={strokeWidth}
                        shadowBlur={10}
                        shadowOpacity={0.12}
                    />
                    <Text
                        text={topLabel}
                        x={0}
                        y={(table.radius ?? 45) - 22}
                        width={(table.radius ?? 45) * 2}
                        align="center"
                        fontSize={13}
                        fill={textFill}
                    />
                    <Text
                        text={bottomLabel}
                        x={0}
                        y={(table.radius ?? 45) + 2}
                        width={(table.radius ?? 45) * 2}
                        align="center"
                        fontSize={11}
                        fill={subTextFill}
                    />
                </>
            ) : (
                <>
                    <Rect
                        width={table.width}
                        height={table.height}
                        cornerRadius={table.shape === "rounded" ? 14 : 2}
                        fill={fill}
                        stroke={stroke}
                        strokeWidth={strokeWidth}
                        shadowBlur={10}
                        shadowOpacity={0.12}
                    />
                    <Text
                        text={topLabel}
                        x={10}
                        y={10}
                        fontSize={13}
                        fill={textFill}
                    />
                    <Text
                        text={bottomLabel}
                        x={10}
                        y={30}
                        fontSize={11}
                        fill={subTextFill}
                    />
                </>
            )}
        </Group>
    );
}
