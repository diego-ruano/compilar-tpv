/** @vitest-environment jsdom */
// CFG-INC-02: si sólo fallaba la lectura del correo de contacto, «Guardar» en Ticket (el IVA o el
// mensaje final) no hacía nada y no decía nada: `guardarNegocio` salía en silencio con cualquier
// lectura fallida. Ahora cada lectura fallida bloquea sólo su ajuste, y sólo si está entre los
// cambios; lo que se queda sin guardar se dice.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
    business: vi.fn(), patchBusiness: vi.fn(), ticket: vi.fn(), patchTicket: vi.fn(), contact: vi.fn(), patchContact: vi.fn(),
    dialogo: vi.fn(async (..._a: unknown[]) => {}),
}));
vi.mock("../../src/features/configuracion/api/configApis", () => ({
    configGetBusinessSettings: h.business, configPatchBusinessSettings: h.patchBusiness,
    configGetTicketSettings: h.ticket, configPatchTicketSettings: h.patchTicket,
    configGetContactSettings: h.contact, configPatchContactSettings: h.patchContact,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ message: h.dialogo }));
vi.mock("../../src/shared/toast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock("../../src/shared/lib/imageUrl", () => ({ resolveImageUrl: async () => "", triggerImageUploadDrain: () => {} }));

const { useBusinessSettings } = await import("../../src/shared/stores/useBusinessSettings");
const { useTicketSettings } = await import("../../src/shared/stores/useTicketSettings");
const { useContactSettings } = await import("../../src/shared/stores/useContactSettings");
const { default: Configuracion } = await import("../../src/app/pages/Configuracion");

const fallo = { code: "external", message: "No se ha podido conectar con el servidor." };
const negocio = {
    business_name: "Bar La Plaza", logo_data_url: null, direccion: "C/ Mayor 1", telefono: "600", cif: "B12345674",
    mensaje_footer: "Gracias", iva_percent: 10, razon_social: "Plaza SL",
};

beforeEach(async () => {
    vi.resetAllMocks();
    useBusinessSettings.getState().limpiarContexto();
    useTicketSettings.getState().limpiarContexto();
    useContactSettings.getState().limpiarContexto();
    h.business.mockResolvedValue(negocio);
    h.patchBusiness.mockResolvedValue(undefined);
    h.ticket.mockResolvedValue({});
    await useBusinessSettings.getState().init();
    await useTicketSettings.getState().init();
});
afterEach(cleanup);

function abrir(seccion: "TICKET" | "NEGOCIO") {
    render(
        <MemoryRouter initialEntries={[{ pathname: "/Configuracion", state: { seccion } }]}>
            <Configuracion />
        </MemoryRouter>,
    );
}

it("con el correo sin leer, el IVA se guarda desde Ticket", async () => {
    h.contact.mockRejectedValue(fallo);
    await useContactSettings.getState().init();
    abrir("TICKET");

    fireEvent.change(await screen.findByPlaceholderText("10"), { target: { value: "21" } });
    const guardar = screen.getByRole("button", { name: "Guardar" });
    expect(guardar).toBeEnabled();
    fireEvent.click(guardar);

    await waitFor(() => expect(h.patchBusiness).toHaveBeenCalledWith(expect.objectContaining({ iva_percent: 21 })));
    await waitFor(() => expect(h.dialogo).toHaveBeenCalledWith("Guardado"));
    expect(h.patchContact).not.toHaveBeenCalled();
});

it("con el correo cambiado y luego sin poder releerlo, se guarda el IVA y se dice que el correo no", async () => {
    h.contact.mockResolvedValueOnce({ contact_email: "bar@ejemplo.es" }).mockRejectedValue(fallo);
    await useContactSettings.getState().init();
    abrir("NEGOCIO");
    fireEvent.change(await screen.findByDisplayValue("bar@ejemplo.es"), { target: { value: "otro@ejemplo.es" } });
    // La relectura del correo falla (otra pantalla, la vuelta a la ventana…).
    await useContactSettings.getState().init();
    expect(useContactSettings.getState().error).not.toBeNull();

    // El menú de la izquierda (el selector de estrecho repite las secciones).
    fireEvent.click(screen.getAllByRole("button", { name: /^Ticket/ })[0]);
    fireEvent.change(await screen.findByPlaceholderText("10"), { target: { value: "21" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));

    await waitFor(() => expect(h.patchBusiness).toHaveBeenCalledWith(expect.objectContaining({ iva_percent: 21 })));
    await waitFor(() => expect(h.dialogo).toHaveBeenCalledTimes(1));
    const [texto, opciones] = h.dialogo.mock.calls[0] as [string, unknown];
    expect(texto).toContain("No se ha guardado el correo de contacto");
    expect(texto).toContain("No se ha podido conectar con el servidor.");
    expect(texto).toContain("Lo demás se ha guardado.");
    expect(opciones).toEqual({ kind: "error" });
    expect(h.patchContact).not.toHaveBeenCalled();
});

it("en Negocio, el correo sin leer no impide guardar lo demás", async () => {
    h.contact.mockRejectedValue(fallo);
    await useContactSettings.getState().init();
    abrir("NEGOCIO");

    fireEvent.change(await screen.findByDisplayValue("C/ Mayor 1"), { target: { value: "C/ Real 3" } });
    const guardar = screen.getByRole("button", { name: "Guardar cambios" });
    expect(guardar).toBeEnabled();
    fireEvent.click(guardar);

    await waitFor(() => expect(h.patchBusiness).toHaveBeenCalledWith(expect.objectContaining({ direccion: "C/ Real 3" })));
    expect(h.dialogo).not.toHaveBeenCalled();
});
