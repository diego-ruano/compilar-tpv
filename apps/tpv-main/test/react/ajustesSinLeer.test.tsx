/** @vitest-environment jsdom */
// CFG-INC-02: si fallaba la lectura de los datos del negocio, el store ponía los valores por
// defecto con `ready: true` sin avisar: Negocio los enseñaba como si fueran los guardados y dejaba
// guardarlos encima de los buenos. Ahora el store guarda el error, y la pantalla dice el motivo, con
// «Reintentar», y no deja guardar. Igual con los ajustes del ticket y el correo de contacto.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
    business: vi.fn(), patchBusiness: vi.fn(), ticket: vi.fn(), patchTicket: vi.fn(), contact: vi.fn(), patchContact: vi.fn(),
}));
vi.mock("../../src/features/configuracion/api/configApis", () => ({
    configGetBusinessSettings: h.business, configPatchBusinessSettings: h.patchBusiness,
    configGetTicketSettings: h.ticket, configPatchTicketSettings: h.patchTicket,
    configGetContactSettings: h.contact, configPatchContactSettings: h.patchContact,
}));
vi.mock("../../src/shared/toast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock("../../src/shared/lib/imageUrl", () => ({ resolveImageUrl: async () => "", triggerImageUploadDrain: () => {} }));

const { useBusinessSettings } = await import("../../src/shared/stores/useBusinessSettings");
const { useTicketSettings } = await import("../../src/shared/stores/useTicketSettings");
const { useContactSettings } = await import("../../src/shared/stores/useContactSettings");
const { Negocio } = await import("../../src/features/configuracion/sections/Negocio");
const { Reservas } = await import("../../src/features/configuracion/sections/Reservas");

const fallo = { code: "external", message: "No se ha podido conectar con el servidor." };
const negocio = {
    business_name: "Bar La Plaza", logo_data_url: null, direccion: "C/ Mayor 1", telefono: "600", cif: "B12345674",
    mensaje_footer: "Gracias", iva_percent: 10, razon_social: "Plaza SL",
};

beforeEach(() => {
    vi.resetAllMocks();
    useBusinessSettings.getState().limpiarContexto();
    useTicketSettings.getState().limpiarContexto();
    useContactSettings.getState().limpiarContexto();
});
afterEach(cleanup);

describe("los stores", () => {
    it("una lectura que falla no pone los valores por defecto como leídos", async () => {
        h.business.mockRejectedValue(fallo);
        h.ticket.mockRejectedValue(fallo);
        h.contact.mockRejectedValue(fallo);
        await useBusinessSettings.getState().init();
        await useTicketSettings.getState().init();
        await useContactSettings.getState().init();
        for (const s of [useBusinessSettings.getState(), useTicketSettings.getState(), useContactSettings.getState()]) {
            expect(s.ready).toBe(false);
            expect(s.error).toBe("No se ha podido conectar con el servidor.");
        }
    });

    it("si falla una relectura se quedan los últimos leídos, con el error", async () => {
        h.business.mockResolvedValueOnce({ ...negocio, direccion: "C/ Real 3" }).mockRejectedValueOnce(fallo);
        await useBusinessSettings.getState().init();
        await useBusinessSettings.getState().init();
        const s = useBusinessSettings.getState();
        expect(s.ready).toBe(true);
        expect(s.direccion).toBe("C/ Real 3");
        expect(s.error).toBe("No se ha podido conectar con el servidor.");

        // Y una lectura buena lo quita.
        h.business.mockResolvedValueOnce(negocio);
        await useBusinessSettings.getState().init();
        expect(useBusinessSettings.getState().error).toBeNull();
    });
});

function pintarNegocio(props: { listo: boolean; error: string | null; onReintentar?: () => Promise<void> }) {
    return render(
        <Negocio
            darkMode={false}
            inputTone=""
            draft={negocio}
            setDraft={() => {}}
            choques={{}}
            choqueCorreo={undefined}
            correo=""
            setCorreo={() => {}}
            correoCargando={false}
            correoError={null}
            onReintentarCorreo={async () => {}}
            dirty
            saving={false}
            onSave={async () => {}}
            onReset={() => {}}
            onReintentar={props.onReintentar ?? (async () => {})}
            listo={props.listo}
            error={props.error}
        />,
    );
}

describe("Negocio", () => {
    it("sin leer los datos dice por qué, con «Reintentar», y no enseña el formulario", async () => {
        const reintentar = vi.fn(async () => {});
        pintarNegocio({ listo: false, error: "No se ha podido conectar con el servidor.", onReintentar: reintentar });
        expect(await screen.findByText("No se han podido leer los datos del negocio")).toBeInTheDocument();
        expect(screen.getByText("No se ha podido conectar con el servidor.")).toBeInTheDocument();
        expect(screen.queryByText("Guardar cambios")).not.toBeInTheDocument();
        expect(screen.queryByDisplayValue("Bar La Plaza")).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
        await waitFor(() => expect(reintentar).toHaveBeenCalledTimes(1));
    });

    it("con una relectura fallida avisa y no deja guardar", async () => {
        pintarNegocio({ listo: true, error: "No se ha podido conectar con el servidor." });
        expect(await screen.findByText("No se han podido volver a leer los datos del negocio")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Guardar cambios" })).toBeDisabled();
    });

    it("leídos, deja guardar", async () => {
        pintarNegocio({ listo: true, error: null });
        expect(await screen.findByRole("button", { name: "Guardar cambios" })).toBeEnabled();
    });
});

it("Reservas tampoco enseña los valores por defecto si no se han leído", async () => {
    h.business.mockRejectedValue(fallo);
    await useBusinessSettings.getState().init();
    render(<Reservas inputTone="" isMain={false} />);
    expect(await screen.findByText("No se han podido leer los ajustes de las reservas")).toBeInTheDocument();
    expect(screen.queryByText("Cargando…")).not.toBeInTheDocument();
    expect(screen.queryByText("Duración de una reserva")).not.toBeInTheDocument();
});
