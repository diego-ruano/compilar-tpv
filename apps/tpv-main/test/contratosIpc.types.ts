import { commands } from "@tpv/client";
import type { Dinero } from "@tpv/contracts";
import { deCentimos } from "../src/shared/lib/dinero";

// Se comprueba con tsc, sin ejecutar escrituras. Protege los tres huecos de RI-87.
export function comprobarFirmasSinEjecutar() {
    void commands.configPatchBusinessSettings({ patch: { logo_data_url: null, limite_simplif: deCentimos(300000) } });
    const recalculo: Promise<Dinero | null> = commands.clientesRecalcularGasto({ id_cliente: "id" });
    void recalculo;
    // @ts-expect-error: el nombre procede del registro de comandos Rust.
    void commands.comandoQueNoExiste();
    // @ts-expect-error: los parámetros planos no aceptan el envoltorio args.
    void commands.verifactuListar({ args: { limite: 100 } });
    // @ts-expect-error: el dinero exige céntimos marcados.
    void commands.configPatchBusinessSettings({ patch: { limite_simplif: 3 } });
    // @ts-expect-error: el patch no admite claves camelCase.
    void commands.configPatchBusinessSettings({ patch: { businessName: "Bar" } });
    // @ts-expect-error: null sólo borra campos anulables.
    void commands.configPatchBusinessSettings({ patch: { business_name: null } });
    // @ts-expect-error: un número del patch tampoco se puede vaciar con null.
    void commands.configPatchBusinessSettings({ patch: { iva_percent: null } });
}
