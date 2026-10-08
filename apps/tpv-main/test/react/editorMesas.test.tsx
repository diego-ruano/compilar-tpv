/** @vitest-environment jsdom */
import { useEffect, useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { TableNode, type ContextoEditor } from "../../src/features/mesas/editor/NodosEditor";

const observacion = vi.hoisted(() => ({ montajes: 0 }));
vi.mock("react-konva", () => ({
    Group: ({ children, onPointerDown, onDragStart }: { children: React.ReactNode; onPointerDown?: (e: unknown) => void; onDragStart?: (e: unknown) => void }) => {
        useEffect(() => { observacion.montajes++; }, []);
        return <div data-testid="mesa" onPointerDown={onPointerDown} onMouseDown={() => onDragStart?.({ cancelBubble: false })}>{children}</div>;
    },
    Circle: () => null, Rect: () => null, Line: () => null, Text: () => null,
}));

it("conserva el nodo al abrir el historial de un arrastre y borra mediante pointerdown", () => {
    const borrar = vi.fn();
    const table = { id: "mesa", name: "1", x: 50, y: 50, width: 80, height: 80, seats: 4, shape: "rect" as const };
    const contexto: ContextoEditor = {
        activeRoom: { type: "poly", points: [0, 0, 400, 0, 400, 400, 0, 400] }, activeSalonId: "zona",
        roomPointsDraftRef: { current: {} }, deleteTableArmed: false, deleteTableById: borrar,
        isDraggingSomethingRef: { current: false }, isPanningRef: { current: false }, pushHistory: () => {},
        salonsRef: { current: [] }, lastValidTableWorldRef: { current: {} }, screenToWorld: p => p,
        worldToScreen: p => p, updateTablePos: () => {}, setDirty: () => {}, dark: false,
        roomStrokeLineRef: { current: null }, lastValidVertexWorldRef: { current: {} }, PADDING: 12,
        WORLD_W: 4000, WORLD_H: 4000, wouldKeepAllTablesInside: () => true, syncRoomLines: () => {}, commitRoomPoints: () => {},
    };
    function Editor() {
        const [historial, setHistorial] = useState(0);
        const [borrando, setBorrando] = useState(false);
        return <><span>{historial}</span><button onClick={() => setBorrando(true)}>Borrar</button>
            <TableNode table={table} contexto={{ ...contexto, deleteTableArmed: borrando, pushHistory: () => setHistorial(h => h + 1) }} /></>;
    }
    render(<Editor />);
    const nodo = screen.getByTestId("mesa");
    fireEvent.mouseDown(nodo);
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByTestId("mesa")).toBe(nodo);
    expect(observacion.montajes).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Borrar" }));
    fireEvent.pointerDown(nodo, { pointerType: "touch" });
    expect(borrar).toHaveBeenCalledWith("mesa");
});
