// OBS-01: un código de vinculación es de un solo uso. En cuanto una Handy lo reclama (o se aprueba o
// se rechaza su solicitud) la Main deja de enseñarlo, aunque le quede tiempo.
import { beforeEach, expect, it, vi } from "vitest";

const pedir = vi.hoisted(() => vi.fn());
vi.mock("@tpv/client", () => ({
    commands: { pairCreate: pedir },
    toAppError: (e: unknown) => ({ message: String(e) }),
}));

import { usePairCode } from "../src/shared/stores/usePairCode";

let n = 0;
beforeEach(() => {
    pedir.mockReset();
    pedir.mockImplementation(async () => ({
        pairCode: `codigo-${++n}`,
        pairSecret: "secreto",
        expiresAtMs: Date.now() + 10 * 60_000,
    }));
    usePairCode.setState({ code: "", secret: "", expiresAtMs: null, loading: false, error: null });
});

it("el código que se enseña, gastado, se cambia por uno nuevo", async () => {
    await usePairCode.getState().asegurar();
    const usado = usePairCode.getState().code;

    await usePairCode.getState().gastado(usado);

    expect(pedir).toHaveBeenCalledTimes(2);
    expect(usePairCode.getState().code).not.toBe(usado);
});

it("gastar otro código (uno anterior) no cambia el que se enseña", async () => {
    await usePairCode.getState().asegurar();
    const vigente = usePairCode.getState().code;

    await usePairCode.getState().gastado("codigo-anterior");

    expect(pedir).toHaveBeenCalledTimes(1);
    expect(usePairCode.getState().code).toBe(vigente);
});
