/** @vitest-environment jsdom */
import { fireEvent, render, screen, cleanup, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import FormularioGasto from "../../src/features/cuentas/FormularioGasto";
import type { SalidaDto } from "@tpv/contracts";
import { deCentimos } from "../../src/shared/lib/dinero";
const actualizar = vi.hoisted(() => vi.fn());
vi.mock("../../src/features/cuentas/cuentasQueries", () => ({ useCreateGasto: () => ({ mutateAsync: vi.fn() }), useUpdateGasto: () => ({ mutateAsync: actualizar }) }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
it("editar sin tocar el importe conserva los céntimos y bloquea un segundo envío", async () => {
    let responder!: () => void;
    actualizar.mockImplementation(() => new Promise(resolve => { responder = () => resolve(true); }));
    const cerrar = vi.fn();
    const gasto = { id: "gasto", fecha_hora: "2026-10-09", concepto: "Agua", tipo_gasto: "Agua", importe: deCentimos(1250), proveedor_id: null, pagado_con_caja: false } as SalidaDto;
    render(<FormularioGasto gasto={gasto} fechaInicial="2026-10-09" proveedores={[]} errorProveedores={null} onCerrar={cerrar} onGuardado={() => {}}
        conAvisoDeCierre={async (_, hacer) => hacer(null)} />);
    const guardar = await screen.findByRole("button", { name: "Guardar cambios" });
    fireEvent.click(guardar); fireEvent.click(guardar);
    await waitFor(() => expect(actualizar).toHaveBeenCalledTimes(1));
    expect(actualizar.mock.calls[0][0].args.importe).toBe(1250);
    expect(cerrar).not.toHaveBeenCalled();
    responder();
    await waitFor(() => expect(cerrar).toHaveBeenCalledTimes(1));
});
