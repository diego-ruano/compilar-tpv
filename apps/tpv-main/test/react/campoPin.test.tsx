/** @vitest-environment jsdom */
// TRA-INC-03: el PIN de un trabajador se escribía en claro en el alta y en la edición. `CampoPin`
// lo oculta por defecto, con el ojo del login para verlo a propósito. Montaje asíncrono: ver la
// cabecera de `shared-ui.test.tsx`.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import { CampoPin } from "../../src/shared/ui";

afterEach(cleanup);

function Envoltorio() {
    const [valor, setValor] = useState("");
    return <CampoPin aria-label="PIN" valor={valor} onCambio={setValor} />;
}

it("el PIN se escribe oculto, sólo con cifras, y el ojo lo enseña y lo vuelve a ocultar", async () => {
    render(<Envoltorio />);
    const campo = await screen.findByLabelText("PIN");
    expect(campo).toHaveAttribute("type", "password");
    expect(campo).toHaveAttribute("inputmode", "numeric");
    expect(campo).toHaveAttribute("autocomplete", "new-password");

    fireEvent.change(campo, { target: { value: "12a345678" } });
    await waitFor(() => expect(campo).toHaveValue("123456"));

    fireEvent.click(screen.getByRole("button", { name: "Mostrar PIN" }));
    await waitFor(() => expect(campo).toHaveAttribute("type", "text"));
    fireEvent.click(screen.getByRole("button", { name: "Ocultar PIN" }));
    await waitFor(() => expect(campo).toHaveAttribute("type", "password"));
});

it("el alta y la edición de un trabajador escriben el PIN en un CampoPin", () => {
    for (const pantalla of ["AddTrabajador.tsx", "EditTrabajador.tsx"]) {
        const fuente = readFileSync(
            resolve(__dirname, "../../src/app/pages/trabajadoresPages", pantalla),
            "utf8",
        );
        expect(fuente, pantalla).toMatch(/<CampoPin\b/);
        // Ningún otro campo de la ficha con teclado numérico, que sería un PIN en claro.
        expect(fuente, pantalla).not.toMatch(/inputMode="numeric"/);
    }
});
