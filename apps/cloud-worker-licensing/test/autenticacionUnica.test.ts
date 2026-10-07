import { describe, expect, it } from "vitest";

const fuentes = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true });

describe("RI-21: una única entrada para la autenticaci?n del tenant", () => {
    it("solo tenantAuth puede consumir la verificación de device-proof", () => {
        expect(Object.keys(fuentes).some((ruta) => ruta.endsWith("/withTenant.ts"))).toBe(false);
        const consumidores = Object.entries(fuentes).filter(([ruta, contenido]) =>
            !ruta.endsWith("/server/middleware/auth.ts") && /import\s*\{[^}]*\bverifyDeviceProofOrThrow\b[^}]*\}\s*from/s.test(String(contenido)));
        expect(consumidores.map(([ruta]) => ruta)).toEqual(["../src/middleware/tenant.ts"]);
    });
});
