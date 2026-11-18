/** @vitest-environment jsdom */
// LIC-INC-02 · El formulario de activación de la licencia.
//
// «Limpiar» vaciaba los campos y dejaba el error de antes en pantalla; el ejemplo del campo era
// `XXXX-XXXX-XXXX`, que no es el formato de una clave; y una clave mal escrita se mandaba a la nube,
// que contestaba «No hay una licencia activa». Ahora la clave mal escrita se avisa al dejar el campo,
// con el texto que daría el backend, y «Limpiar» empieza de cero.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import ActivacionLicencia from "../../src/app/arranque/ActivacionLicencia";
import { EJEMPLO_CLAVE, MSG_CLAVE_MAL_FORMADA } from "../../src/shared/lib/claveLicencia";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

beforeEach(() => {
    invoke.mockReset();
});
afterEach(cleanup);

async function montar() {
    render(
        <ActivacionLicencia rechazoPrevio={null} volviendo={false} errorAlVolver={null} onVolver={async () => {}} onActivada={async () => {}} />,
    );
    await waitFor(() => expect(document.getElementById("activation-license-key")).not.toBeNull());
    return document.getElementById("activation-license-key") as HTMLInputElement;
}

function rellenar(clave: string) {
    for (const [campo, valor] of [
        ["activation-license-key", clave],
        ["activation-legal-name", "Bar de Pruebas S.L."],
        ["activation-business-name", "Bar de Pruebas"],
        ["activation-phone", "+34 600 000 000"],
        ["activation-country", "España"],
    ]) {
        fireEvent.change(document.getElementById(campo)!, { target: { value: valor } });
    }
}

it("el ejemplo del campo es el formato de verdad", async () => {
    const campo = await montar();
    expect(campo.placeholder).toBe(EJEMPLO_CLAVE);
});

it("una clave mal escrita se avisa al dejar el campo, y no se puede activar con ella", async () => {
    const campo = await montar();
    rellenar("TPV-ABCD-EFGH-JKMN");
    // Mientras se escribe, nada.
    expect(screen.queryByText(MSG_CLAVE_MAL_FORMADA)).toBeNull();

    fireEvent.blur(campo);
    expect(await screen.findByText(MSG_CLAVE_MAL_FORMADA)).toBeInTheDocument();
    expect(screen.getByText("Revisa la clave de licencia")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Activar TPV/ })).toBeDisabled();

    // Bien escrita, aunque sea en minúsculas y con espacios, el aviso se va y se puede activar.
    fireEvent.change(campo, { target: { value: "tpv abcde fghjk mnpqr stvwx" } });
    await waitFor(() => expect(screen.queryByText(MSG_CLAVE_MAL_FORMADA)).toBeNull());
    expect(screen.getByRole("button", { name: /Activar TPV/ })).toBeEnabled();
    expect(invoke).not.toHaveBeenCalled();
});

it("«Limpiar» quita también el error de la activación anterior", async () => {
    invoke.mockImplementation(async () => {
        throw { code: "license_not_found", message: "No hay ninguna licencia con esa clave. Revísala." };
    });
    await montar();
    rellenar("TPV-ABCDE-FGHJK-MNPQR-STVWX");
    fireEvent.submit(document.querySelector("form")!);
    expect(await screen.findByText("No hay ninguna licencia con esa clave. Revísala.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Limpiar" }));

    await waitFor(() => expect(screen.queryByText("No hay ninguna licencia con esa clave. Revísala.")).toBeNull());
    expect((document.getElementById("activation-license-key") as HTMLInputElement).value).toBe("");
});
