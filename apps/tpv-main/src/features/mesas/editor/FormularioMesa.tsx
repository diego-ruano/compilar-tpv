import { useState } from "react";
import { Modal, Chip, IconButton } from "./ControlesEditor";
import type { Table, TableShape, TableSize } from "./geometria";

function sizeToDims(shape: TableShape, size: TableSize) {
    const rect = {
        S: { w: 90, h: 60 },
        M: { w: 120, h: 70 },
        L: { w: 160, h: 90 },
    }[size];

    if (shape === "circle") {
        const radius = { S: 38, M: 45, L: 58 }[size];
        return { width: radius * 2, height: radius * 2, radius };
    }

    return {
        width: rect.w,
        height: rect.h,
        radius: undefined as number | undefined,
    };
}

export default function FormularioMesa({ numeroMesa, onCerrar, onCrear }: {
    numeroMesa: number; onCerrar: () => void; onCrear: (mesa: Table, colocacion: "auto" | "click") => void;
}) {
    const [tableForm, setTableForm] = useState({ name: `Mesa ${numeroMesa}`, seats: 4,
        shape: "rounded" as TableShape, size: "M" as TableSize, placement: "auto" as "auto" | "click" });
    return (
            <Modal
                open
                title="Añadir mesa"
                onClose={onCerrar}
            >
                <div className="grid grid-cols-2 gap-3">
                    <div className="col-span-2">
                        <div className="text-xs font-semibold text-fg-muted mb-1">
                            Nombre / Nº mesa
                        </div>
                        <input
                            value={tableForm.name}
                            onChange={(e) =>
                                setTableForm((p) => ({ ...p, name: e.target.value }))
                            }
                            className="h-10 w-full rounded-xl border border-border bg-surface px-3 text-sm text-fg outline-none focus:border-accent"
                            placeholder="Ej: M12"
                        />
                    </div>

                    <div>
                        <div className="text-xs font-semibold text-fg-muted mb-1">
                            Comensales
                        </div>
                        <input
                            type="number"
                            value={tableForm.seats}
                            onChange={(e) =>
                                setTableForm((p) => ({
                                    ...p,
                                    seats: Number(e.target.value),
                                }))
                            }
                            className="h-10 w-full rounded-xl border border-border bg-surface px-3 text-sm text-fg outline-none focus:border-accent"
                            min={1}
                        />
                    </div>

                    <div>
                        <div className="text-xs font-semibold text-fg-muted mb-1">
                            Forma
                        </div>
                        <select
                            value={tableForm.shape}
                            onChange={(e) =>
                                setTableForm((p) => ({
                                    ...p,
                                    shape: e.target.value as TableShape,
                                }))
                            }
                            className="h-10 w-full rounded-xl border border-border bg-surface px-3 text-sm text-fg outline-none focus:border-accent"
                        >
                            <option value="rounded">Rect redondeada</option>
                            <option value="rect">Recta</option>
                            <option value="circle">Circular</option>
                        </select>
                    </div>

                    <div className="col-span-2">
                        <div className="text-xs font-semibold text-fg-muted mb-1">
                            Tamaño
                        </div>
                        <div className="flex gap-2">
                            <Chip
                                active={tableForm.size === "S"}
                                onClick={() =>
                                    setTableForm((p) => ({ ...p, size: "S" }))
                                }
                            >
                                S
                            </Chip>
                            <Chip
                                active={tableForm.size === "M"}
                                onClick={() =>
                                    setTableForm((p) => ({ ...p, size: "M" }))
                                }
                            >
                                M
                            </Chip>
                            <Chip
                                active={tableForm.size === "L"}
                                onClick={() =>
                                    setTableForm((p) => ({ ...p, size: "L" }))
                                }
                            >
                                L
                            </Chip>
                        </div>

                        <div className="mt-2 text-xs text-fg-muted">
                            {(() => {
                                const d = sizeToDims(
                                    tableForm.shape,
                                    tableForm.size,
                                );
                                return tableForm.shape === "circle"
                                    ? `Radio aprox: ${Math.round(d.radius ?? 0)} px`
                                    : `Dimensiones: ${d.width}×${d.height} px`;
                            })()}
                        </div>
                    </div>

                    <div className="col-span-2">
                        <div className="text-xs font-semibold text-fg-muted mb-1">
                            Colocación
                        </div>
                        <div className="flex gap-2">
                            <Chip
                                active={tableForm.placement === "auto"}
                                onClick={() =>
                                    setTableForm((p) => ({
                                        ...p,
                                        placement: "auto",
                                    }))
                                }
                            >
                                Automática
                            </Chip>
                            <Chip
                                active={tableForm.placement === "click"}
                                onClick={() =>
                                    setTableForm((p) => ({
                                        ...p,
                                        placement: "click",
                                    }))
                                }
                            >
                                Elegir con click
                            </Chip>
                        </div>
                    </div>

                    <div className="col-span-2 pt-2 flex items-center justify-end gap-2 border-t border-border mt-1">
                        <IconButton
                            icon="✕"
                            variant="danger"
                            onClick={onCerrar}
                        >
                            Cancelar
                        </IconButton>

                        <IconButton
                            icon="✅"
                            variant="primary"
                            onClick={() => {
                                const dims = sizeToDims(
                                    tableForm.shape,
                                    tableForm.size,
                                );

                                const t: Table = {
                                    id: crypto.randomUUID(),
                                    name:
                                        tableForm.name.trim() ||
                                        `Mesa ${numeroMesa}`,
                                    x: 0,
                                    y: 0,
                                    width: dims.width,
                                    height: dims.height,
                                    radius: dims.radius,
                                    seats: Math.max(
                                        1,
                                        Math.trunc(Number(tableForm.seats)) || 4,
                                    ),
                                    shape: tableForm.shape,
                                };

                                onCrear(t, tableForm.placement);
                                onCerrar();
                            }}
                        >
                            Crear mesa
                        </IconButton>
                    </div>
                </div>
            </Modal>
    );
}
