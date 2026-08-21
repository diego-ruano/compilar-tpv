// test/presenciaYSenal.test.ts
//
// Los dos stores pequeños de la sincronización, juntos porque cada uno da para poco:
//
//   · `useMainPresence` — lo que sabe un Handy sobre la Main. Decide si el Handy trabaja o espera.
//   · `useSyncSignal`   — el aviso de "han cambiado datos" para el POS, que no está en React Query
//                          y por tanto no se puede invalidar: observa un contador y relee.
//
// En los dos, lo que merece un test es el **valor por defecto**, porque los dos eligen a propósito
// el lado seguro y eso es lo que se pierde en un refactor descuidado: la presencia desconocida
// bloquea (no deja pasar), y un aviso sin detalle recarga de más (no de menos).

import { describe, it, expect, beforeEach } from "vitest";

import { useMainPresence } from "../src/shared/stores/useMainPresence";
import { useSyncSignal } from "../src/shared/stores/useSyncSignal";

describe("useMainPresence · lo que sabe el Handy de la Main", () => {
	beforeEach(() => {
		useMainPresence.setState({ mainOnline: null, volcando: false, retryTick: 0 });
	});

	it("arranca sin saber nada, que es lo que bloquea el Handy", () => {
		// `null` no es "no hay Main": es "todavía no me consta". Y se trata como bloqueo a
		// propósito (fail-closed), porque operar a ciegas contra una nube congelada es peor que
		// esperar: cualquier escritura sería rechazada de todos modos.
		expect(useMainPresence.getState().mainOnline).toBeNull();
	});

	it("distingue los tres estados: sin confirmar, sin Main y con Main", () => {
		const p = () => useMainPresence.getState();

		p().setMainOnline(true);
		expect(p().mainOnline).toBe(true);

		p().setMainOnline(false);
		expect(p().mainOnline).toBe(false);

		p().setMainOnline(null);
		expect(p().mainOnline).toBeNull();
	});

	it("el volcado es una espera aparte de la presencia (SYNC-18)", () => {
		// Hay Main, pero está subiendo su atraso: la nube está a medio construir. El Handy espera
		// igual, y son dos cosas distintas porque lo que se le cuenta al camarero es distinto.
		const p = () => useMainPresence.getState();
		p().setMainOnline(true);
		p().setVolcando(true);

		expect(p().mainOnline).toBe(true);
		expect(p().volcando).toBe(true);
	});

	it("pedir reconexión sube el contador que reabre el socket", () => {
		const antes = useMainPresence.getState().retryTick;
		useMainPresence.getState().requestReconnect();
		expect(useMainPresence.getState().retryTick).toBe(antes + 1);
	});
});

describe("useSyncSignal · el aviso de que han cambiado datos", () => {
	beforeEach(() => {
		useSyncSignal.setState({
			tick: 0,
			comanda: { ids: [], touchedComanda: false, uncertain: false, touchedCatalog: false },
		});
	});

	it("cada bump sube el tick, que es lo que hace releer al POS", () => {
		useSyncSignal.getState().bump();
		useSyncSignal.getState().bump();
		expect(useSyncSignal.getState().tick).toBe(2);
	});

	it("un bump SIN detalle asume lo peor y hace recargar todo", () => {
		// El valor por defecto es el seguro: quien no sabe qué tocó el lote no puede decidir que no
		// hace falta recargar. Cambiar esto por un objeto vacío dejaría tickets rancios en pantalla.
		useSyncSignal.getState().bump();

		const c = useSyncSignal.getState().comanda;
		expect(c.uncertain).toBe(true);
		expect(c.touchedComanda).toBe(true);
		expect(c.touchedCatalog).toBe(true);
	});

	it("un bump CON detalle lo transporta tal cual", () => {
		useSyncSignal.getState().bump({
			ids: ["com-1"],
			touchedComanda: true,
			uncertain: false,
			touchedCatalog: false,
		});

		const c = useSyncSignal.getState().comanda;
		expect(c.ids).toEqual(["com-1"]);
		expect(c.uncertain).toBe(false);
	});
});
