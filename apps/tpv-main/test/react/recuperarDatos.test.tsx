/** @vitest-environment jsdom */
// AUD-19: la nube purga los cambios de más de 7 días, y una copia más antigua puede no poder
// reconciliarse con lo que queda. La pantalla de recuperación lo avisa antes de elegirla, junto a la
// antigüedad de cada copia, sin impedir usarla: si la nube aún lo guarda todo, la copia vale.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import RecuperarDatos from "../../src/app/pages/RecuperarDatos";
import { useEstadoSync } from "../../src/shared/stores/useEstadoSync";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../../src/app/layoutComponent/Titlebar", () => ({ default: () => null }));

const DIA = 24 * 60 * 60 * 1000;
const AVISO = /Tiene más de 7 días: puede que la nube ya no guarde todo lo que pasó después/;

const inicial = useEstadoSync.getState();
afterEach(() => {
    cleanup();
    useEstadoSync.setState(inicial, true);
});

it("enseña la antigüedad de cada copia y avisa, sin impedirla, de la que pasa de 7 días", async () => {
    const ahora = Date.now();
    const copia = (id: string, antes: number, importada = false) => ({
        id,
        created_at_ms: ahora - antes,
        size_bytes: 1024,
        importada,
    });
    invoke.mockImplementation(async (comando: string) =>
        comando === "recovery_list_backups"
            ? [
                  copia("data-1.db.gz", 2 * DIA + 60_000),
                  // Le falta un minuto para los 7 días: todavía no avisa.
                  copia("data-2.db.gz", 7 * DIA - 60_000),
                  copia("data-3.db.gz", 9 * DIA),
                  copia("import-4.db.gz", 30 * DIA, true),
              ]
            : undefined,
    );

    render(<RecuperarDatos />);

    const reciente = await screen.findByRole("button", { name: /^Última copia: .*\(hace 2 días\)$/ });
    const casiSiete = screen.getByRole("button", { name: /^Copia: .*\(hace 6 días\)$/ });
    const vieja = screen.getByRole("button", { name: /^Copia: .*\(hace 9 días\)$/ });
    const importada = screen.getByRole("button", { name: /^Copia importada: .*\(hace 30 días\)$/ });

    // El aviso va junto a cada copia que pasa de 7 días, y a ninguna otra.
    expect(screen.getAllByText(AVISO)).toHaveLength(2);
    expect(vieja.parentElement).toHaveTextContent(AVISO);
    expect(importada.parentElement).toHaveTextContent(AVISO);
    expect(reciente.parentElement).not.toHaveTextContent(AVISO);
    expect(casiSiete.parentElement).not.toHaveTextContent(AVISO);

    // Avisar no es bloquear: todas se pueden elegir, y la nube sigue ahí.
    for (const boton of [reciente, casiSiete, vieja, importada]) expect(boton).toBeEnabled();
    expect(screen.getByRole("button", { name: "Recuperar el estado actual de la nube" })).toBeEnabled();
});

it("una copia que no se puede restaurar se rechaza diciendo por qué, y deja elegir otra", async () => {
    // Una copia se corrompe en el disco como cualquier otro fichero. Que `prepare_restore` la valide
    // antes de tocar la `data.db` lo prueba Rust; esto fija que la pantalla lo cuente y no se quede en
    // «Recuperación en curso» con la copia buena justo debajo. (La E2E ya no llega a este caso: una
    // copia ilegible se aparta al arrancar con la base rota, AUD-06; ver `copias-2-recuperar.e2e.ts`.)
    const ahora = Date.now();
    invoke.mockImplementation(async (comando: string) => {
        if (comando === "recovery_list_backups") {
            return [
                { id: "data-2.db.gz", created_at_ms: ahora - 60_000, size_bytes: 1024, importada: false },
                { id: "data-1.db.gz", created_at_ms: ahora - 3_600_000, size_bytes: 1024, importada: false },
            ];
        }
        if (comando === "recovery_restore_backup") {
            throw { code: "backup_corrupt", message: "La copia está dañada y no se puede usar." };
        }
        return undefined;
    });

    render(<RecuperarDatos />);

    (await screen.findByRole("button", { name: /^Última copia: / })).click();

    expect(await screen.findByText(/La copia está dañada y no se puede usar/)).toBeInTheDocument();
    expect(screen.queryByText("Recuperación en curso")).not.toBeInTheDocument();
    // Las copias siguen ahí para elegir otra, y la nube también.
    expect(screen.getByRole("button", { name: /^Última copia: / })).toBeEnabled();
    expect(screen.getByRole("button", { name: /^Copia: / })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Recuperar el estado actual de la nube" })).toBeEnabled();
});

it("una copia anterior al log acaba ofreciendo la nube, con el motivo a la vista", async () => {
    // Lo que publica el motor tras cinco ciclos fallidos con esa copia (`replicacion.rs::arrancar`).
    useEstadoSync.setState({
        reconciliacionPendiente: true,
        faseRecuperacion: "bloqueada",
        errorRecuperacion: "Esta copia es anterior a lo que guarda la nube: recupera el estado actual de la nube.",
    });
    invoke.mockImplementation(async (comando: string) => (comando === "recovery_list_backups" ? [] : undefined));

    render(<RecuperarDatos />);

    expect(await screen.findByText("La recuperación no ha podido completarse")).toBeInTheDocument();
    expect(screen.getByText(/Esta copia es anterior a lo que guarda la nube/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Recuperar el estado actual de la nube" })).toBeEnabled();
});

it("si ni lo imprescindible para trabajar cabe en la descarga, lo dice y señala las copias", async () => {
    // DO-02: la nube se encoge hasta lo imprescindible antes de contestar que no cabe.
    invoke.mockImplementation(async (comando: string) => {
        if (comando === "recovery_list_backups") return [];
        if (comando === "sync_bootstrap_desde_nube") {
            throw { code: "bootstrap_too_large", message: "Lo imprescindible para volver a trabajar no cabe en una sola descarga desde la nube" };
        }
        return undefined;
    });

    render(<RecuperarDatos />);

    (await screen.findByRole("button", { name: "Recuperar el estado actual de la nube" })).click();

    expect(
        await screen.findByText(/lo imprescindible para volver a trabajar \(la carta, el personal, los clientes, las reservas y lo que sigue abierto\)/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Restaura una copia de este ordenador \(arriba\)/)).toBeInTheDocument();
    expect(screen.queryByText("Recuperación en curso")).not.toBeInTheDocument();
});

it("con la base anterior a lo que guarda la nube lo explica y sólo ofrece la nube (SYNC-32)", async () => {
    useEstadoSync.setState({ anteriorALaNube: true, datosPerdidos: true });
    invoke.mockImplementation(async (comando: string) =>
        comando === "recovery_list_backups"
            ? [{ id: "data-1.db.gz", created_at_ms: Date.now() - DIA, size_bytes: 1024, importada: false }]
            : undefined,
    );

    render(<RecuperarDatos />);

    expect(
        await screen.findByText(/se han cambiado por fuera del programa .* son anteriores a lo que guarda la nube/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Lo que este ordenador tenía sin subir se guarda aparte, sin borrarlo/)).toBeInTheDocument();
    // Sólo la nube: ni las copias de este ordenador ni traer una de fuera.
    expect(screen.getByRole("button", { name: "Recuperar el estado actual de la nube" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /copia/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Restaurar desde un archivo/ })).not.toBeInTheDocument();
});
