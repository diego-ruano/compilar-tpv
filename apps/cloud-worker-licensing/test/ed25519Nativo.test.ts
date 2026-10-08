import { describe, expect, it } from "vitest";
import * as ed from "@noble/ed25519";
import { ed25519Sign, ed25519Verify } from "../src/server/utils/ed25519";
import { ensureEd25519Sha512 } from "./helpers/ed25519";
import { licenseAssertionMessage, signLicenseAssertion } from "../src/domains/licensing/licensing.helpers";
import { bytesToB64, b64ToBytes } from "../src/server/utils/base64";
import type { Env } from "../src/env";

describe("RI-44 · Ed25519 nativo", () => {
	it("conserva claves, mensaje canónico y firma frente al firmante independiente", async () => {
		ensureEd25519Sha512();
		const seed = new Uint8Array(32).fill(9);
		const pub = await ed.getPublicKeyAsync(seed);
		const fields = { v: 1 as const, tenantId: "tenant", deviceId: "device", licenseId: "license", state: "active" as const, plan: "standard", expiresAtMs: null, issuedAtMs: 1000, assertionExpiresAtMs: 2000, clientTs: 1000 };
		const message = new TextEncoder().encode(licenseAssertionMessage(fields));
		const signed = await signLicenseAssertion({ LICENSE_SIGNING_PRIVATE_KEY: bytesToB64(seed) } as Env, fields);
		expect(b64ToBytes(signed.sig)).toEqual(await ed.signAsync(message, seed));
		expect(await ed25519Verify(b64ToBytes(signed.sig), message, pub)).toBe(true);
		message[0] ^= 1;
		expect(await ed25519Verify(b64ToBytes(signed.sig), message, pub)).toBe(false);
	});
	it("rechaza longitudes inválidas", async () => {
		expect(await ed25519Verify(new Uint8Array(63), new Uint8Array(), new Uint8Array(32))).toBe(false);
		await expect(ed25519Sign(new Uint8Array(), new Uint8Array(31))).rejects.toThrow();
	});
});
