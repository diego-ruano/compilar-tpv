import { describe, expect, it } from "vitest";
import { hashPin, verifyPin } from "../src/domains/login/login.crypto";

describe("RI-37: par?metros del hash replicado", () => {
    it("verifica el formato actual y rechaza par?metros de coste excesivo", async () => {
        const hash = await hashPin("1234");
        await expect(verifyPin("1234", hash)).resolves.toBeUndefined();
        for (const iterations of [100001, 1000000, 4000000000]) {
            await expect(verifyPin("1234", hash.replace("i=100000", `i=${iterations}`))).rejects.toThrow("Hash params");
        }
        const parts = hash.split("$");
        await expect(verifyPin("1234", `$pbkdf2-sha256$i=100000$AA==$${parts[4]}`)).rejects.toThrow("mal formado");
        await expect(verifyPin("1234", `$pbkdf2-sha256$i=100000$${parts[3]}$AA==`)).rejects.toThrow("mal formado");
        await expect(verifyPin("1234", "x".repeat(129))).rejects.toThrow("mal formado");
    });
});
