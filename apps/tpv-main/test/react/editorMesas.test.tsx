/** @vitest-environment jsdom */
import { useEffect, useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TableNode, type ContextoEditor } from "../../src/features/mesas/editor/NodosEditor";

afterEach(cleanup);

const observacion = vi.hoisted(() => ({ montajes: 0 }));
vi.mock("react-konva", () => ({
    Group: ({ children, onPointerDown, onDragStart, draggable }: { children: React.ReactNode; onPointerDown?: (e: unknown) => void; onDragStart?: (e: unknown) => void; draggable?: boolean }) => {
        useEffect(() => { observacion.montajes++; }, []);
        return <div data-testid="mesa" data-arrastrable={String(draggable)} onPointerDown={onPointerDown} onMouseDown={() => onDragStart?.({ cancelBubble: false })}>{children}</div>;
    },
    // Una mesa rectangular sólo dibuja un círculo: la marca de reservable desde la web.
    Circle: () => <i data-testid="marca-web" />, Rect: () => null, Line: () => null, Text: () => null,
}));

const table = { id: "mesa", name: "1", x: 50, y: 50, width: 80, height: 80, seats: 4, shape: "rect" as const };

function contextoBase(): ContextoEditor {
    return {
        activeRoom: { type: "poly", points: [0, 0, 400, 0, 400, 400, 0, 400] }, activeSalonId: "zona",
        roomPointsDraftRef: { current: {} }, deleteTableArmed: false, deleteTableById: vi.fn(),
        webTableArmed: false, abrirReservaWeb: vi.fn(), esReservableWeb: () => false,
        isDraggingSomethingRef: { current: false }, isPanningRef: { current: false }, pushHistory: () => {},
        salonsRef: { current: [] }, lastValidTableWorldRef: { current: {} }, screenToWorld: p => p,
        worldToScreen: p => p, updateTablePos: () => {}, setDirty: () => {}, dark: false,
        roomStrokeLineRef: { current: null }, lastValidVertexWorldRef: { current: {} }, PADDING: 12,
        WORLD_W: 4000, WORLD_H: 4000, wouldKeepAllTablesInside: () => true, syncRoomLines: () => {}, commitRoomPoints: () => {},
    };
}

it("conserva el nodo al abrir el historial de un arrastre y borra mediante pointerdown", () => {
    const borrar = vi.fn();
    const contexto: ContextoEditor = { ...contextoBase(), deleteTableById: borrar };
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

// Reservas desde la web: en su modo, pulsar una mesa abre su configuración; no la borra ni la arrastra.
it("en el modo de reserva web pulsar una mesa abre su configuración", () => {
    const contexto: ContextoEditor = { ...contextoBase(), webTableArmed: true };
    render(<TableNode table={table} contexto={contexto} />);
    const nodo = screen.getByTestId("mesa");
    expect(nodo.dataset.arrastrable).toBe("false");

    fireEvent.pointerDown(nodo);

    expect(contexto.abrirReservaWeb).toHaveBeenCalledWith(table);
    expect(contexto.deleteTableById).not.toHaveBeenCalled();
});

it("sólo las mesas reservables desde la web llevan su marca", () => {
    const { unmount } = render(<TableNode table={table} contexto={contextoBase()} />);
    expect(screen.queryByTestId("marca-web")).toBeNull();
    unmount();

    render(<TableNode table={table} contexto={{ ...contextoBase(), esReservableWeb: () => true }} />);
    expect(screen.getByTestId("marca-web")).toBeInTheDocument();
});
