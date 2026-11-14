import assert from "node:assert/strict";
import { test } from "node:test";

import { horaConHuso, horaLocal, mensajeDeviceProof, mensajeSaludo, nuevaIdentidad, nuevoId, sha256Hex } from "./firma.mjs";

test("el device-proof tiene el formato que fija device.rs", () => {
  const lineas = mensajeDeviceProof(1700000000000, "post", "/v1/mesas/cobrar", "tok", '{"a":1}').split("\n");
  assert.deepEqual(lineas.slice(0, 4), ["DEVICE_PROOF", "1700000000000", "POST", "/v1/mesas/cobrar"]);
  // Los mismos valores que `mensaje_device_proof_tiene_el_formato_acordado` en device.rs.
  assert.equal(lineas[4], "1a7674eb4ee78df7e1ac439a93c3fa8e3c945784d4dec9fd8e3011738b2f1d62");
  assert.equal(lineas[5], "015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862");
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("la identidad sale de la semilla como en la app: clave cruda en base64 estándar y firma Ed25519", () => {
  const identidad = nuevaIdentidad(Buffer.alloc(32, 7));
  assert.equal(identidad.clavePublica, "6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=");
  assert.match(identidad.deviceId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const firma = identidad.firmar(mensajeDeviceProof(1700000000000, "POST", "/v1/mesas/cobrar", "tok", '{"a":1}'));
  assert.equal(Buffer.from(firma, "base64").length, 64);
  // Ed25519 es determinista: la misma semilla y el mismo mensaje dan siempre la misma firma.
  assert.equal(firma, identidad.firmar(mensajeDeviceProof(1700000000000, "POST", "/v1/mesas/cobrar", "tok", '{"a":1}')));
});

test("el saludo distingue la Main de la Handy", () => {
  assert.equal(mensajeSaludo("main", 1, "t", "d", "n"), "WS_HELLO\n1\nt\nd\nn");
  assert.equal(mensajeSaludo("handy", 1, "t", "d", "n"), "WS_HANDY_HELLO\n1\nt\nd\nn");
});

test("los ids son UUIDv7 y crecen aunque se pidan en el mismo milisegundo", () => {
  const ids = Array.from({ length: 2000 }, () => nuevoId());
  for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual([...ids].sort(), ids);
  assert.equal(new Set(ids).size, ids.length);
});

test("la hora local tiene el formato de x-client-now y la del registro lleva su huso", () => {
  const d = new Date(2026, 10, 10, 9, 5, 7);
  assert.equal(horaLocal(d), "2026-11-10 09:05:07");
  assert.match(horaConHuso(d), /^2026-11-10T09:05:07[+-]\d{2}:\d{2}$/);
});
