// components/mesasComponents/TableNode.tsx
import React, { useMemo } from "react";
import { Group, Text, Rect, Circle } from "react-konva";
import type { MesaMeta, Table } from "./types";
import { parseMesaId } from "./ParseMesaId";

type MesaMetaMap = Record<number, MesaMeta> & Record<string, MesaMeta>;

function asNumber(v: any) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

export default function TableNode({
    table,
    mesaMetaById,
    onOpenMesa,
}: {
    table: Table;
    mesaMetaById: MesaMetaMap;
    onOpenMesa: (mesaId: number, mesaNombre: string) => void;
}) {
    const idMesa = parseMesaId(table.id);

    const meta: MesaMeta | undefined = idMesa
        ? mesaMetaById[idMesa] ??
        mesaMetaById[String(idMesa)] ??
        mesaMetaById[`db-mesa-${idMesa}`]
        : undefined;

    const reserva = meta?.reserva ?? null;
    const isReservaActiva = reserva?.estado === "ACTIVA";
    const isReservaProxima = reserva?.estado === "PROXIMA";

    // ✅ PENDIENTE REAL
    // - si viene meta.estado => manda
    // - fallback por compat si te llega meta antigua con contadores
    const isPendiente = useMemo(() => {
        if (!meta) return false;

        if (meta.estado === "PENDIENTE") return true;

        // fallback por si por compatibilidad llega meta antigua
        const m: any = meta as any;
        const pendientesPago =
            asNumber(m.pendientesPago) ||
            asNumber(m.pendientes_pago) ||
            asNumber(m.Pendientes_Pago);

        const totalPendiente =
            asNumber(m.totalPendiente) ||
            asNumber(m.total_pendiente) ||
            asNumber(m.Total_Pendiente);

        const pendientesCocina =
            asNumber(m.pendientesCocina) ||
            asNumber(m.pendientes_cocina) ||
            asNumber(m.Pendientes_Cocina);

        return pendientesPago > 0 || totalPendiente > 0 || pendientesCocina > 0;
    }, [meta]);

    // ===== Colores =====
    // Prioridad:
    // - pendiente -> naranja
    // - reserva activa -> azul
    // - reserva próxima -> borde azul
    // - libre -> oscuro
    const fill = isPendiente
        ? "rgba(245,158,11,0.92)"
        : isReservaActiva
            ? "rgba(37,99,235,0.92)"
            : "rgba(15,23,42,0.92)";

    const stroke = isPendiente
        ? "rgba(245,158,11,0.92)"
        : isReservaProxima
            ? "rgba(37,99,235,0.95)"
            : "rgba(148,163,184,0.95)";

    const strokeWidth = isPendiente ? 3 : isReservaProxima ? 4 : 1;

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
                        fill="#e5e7eb"
                    />
                    <Text
                        text={bottomLabel}
                        x={0}
                        y={(table.radius ?? 45) + 2}
                        width={(table.radius ?? 45) * 2}
                        align="center"
                        fontSize={11}
                        fill="#cbd5e1"
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
                        fill="#e5e7eb"
                    />
                    <Text
                        text={bottomLabel}
                        x={10}
                        y={30}
                        fontSize={11}
                        fill="#cbd5e1"
                    />
                </>
            )}
        </Group>
    );
}
