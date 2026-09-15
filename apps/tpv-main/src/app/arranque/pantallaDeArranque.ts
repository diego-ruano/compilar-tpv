// src/app/arranque/pantallaDeArranque.ts
//
// Qué pantalla enseña el arranque, decidido en un solo sitio y sin React.
//
// Antes era un ternario de seis niveles dentro del JSX de `AppBoot`, mezclado con el marcado de cada
// pantalla. Lo que hay que conservar de esa decisión son reglas de seguridad, no de maquetación, y por
// eso vive aparte y se prueba (`test/arranque.test.ts`):
//
//   · Un Handy sin Main confirmada NO trabaja. `mainOnline === null` es «todavía no me consta» y
//     bloquea igual que `false`: operar contra una nube congelada es peor que esperar.
//   · Una Main no enseña la aplicación hasta que el gate de licencia deja pasar; mientras se comprueba
//     no se enseña nada.
//   · El aviso de caducidad sólo acompaña a una Main que trabaja, nunca a una bloqueada.

import type { LicenseGateResult } from "@tpv/contracts";

import type { ModeStateValue } from "../../shared/stores/useMode";

export type EntradaArranque = {
	modo: ModeStateValue;
	/** Todavía no se ha leído el estado local de la licencia. */
	licenciaCargando: boolean;
	/** El último veredicto del gate de licencia; `null` mientras se comprueba. */
	gate: LicenseGateResult | null;
	/** El Handy tiene token de emparejamiento. */
	handyEmparejado: boolean;
	mainOnline: boolean | null;
	mainVolcando: boolean;
};

export type AvisoCaducidad = { motivo: "warn" | "expiry_grace"; expiresAtMs: number | null };

export type Pantalla =
	| { tipo: "cargando" }
	| { tipo: "elegir_modo" }
	| { tipo: "handy_vincular" }
	| { tipo: "handy_esperando_main"; conectando: boolean; volcando: boolean }
	| { tipo: "handy_app" }
	| { tipo: "tpv_activar"; rechazoPrevio: string | null }
	| { tipo: "tpv_bloqueada"; motivo: string }
	| { tipo: "tpv_app" }
	| { tipo: "modo_invalido" };

export type Arranque = {
	pantalla: Pantalla;
	/** La Main puede trabajar: el gate de licencia deja pasar. Es lo que le dice al socket que lo intente ya. */
	mainLista: boolean;
	/** La barra de título propia del arranque. Las aplicaciones de la Main y del Handy traen la suya. */
	conBarraDeArranque: boolean;
	avisoCaducidad: AvisoCaducidad | null;
};

export function decidirArranque(e: EntradaArranque): Arranque {
	const mainLista = e.modo === "tpv" && e.gate !== null && e.gate.allowed;
	const handyTrabajando =
		e.modo === "handy" && e.handyEmparejado && e.mainOnline === true && !e.mainVolcando;

	const motivo = e.gate?.reason;
	const avisoCaducidad: AvisoCaducidad | null =
		mainLista && (motivo === "warn" || motivo === "expiry_grace")
			? { motivo, expiresAtMs: e.gate?.state?.expires_at_ms ?? null }
			: null;

	return {
		pantalla: pantalla(e),
		mainLista,
		conBarraDeArranque: !mainLista && !handyTrabajando,
		avisoCaducidad,
	};
}

function pantalla(e: EntradaArranque): Pantalla {
	if (e.modo === "loading" || e.licenciaCargando) return { tipo: "cargando" };
	if (e.modo === null) return { tipo: "elegir_modo" };

	if (e.modo === "handy") {
		if (!e.handyEmparejado) return { tipo: "handy_vincular" };
		if (e.mainOnline === true && !e.mainVolcando) return { tipo: "handy_app" };
		return {
			tipo: "handy_esperando_main",
			conectando: e.mainOnline === null,
			volcando: e.mainVolcando,
		};
	}

	if (e.modo === "tpv") {
		if (e.gate === null) return { tipo: "cargando" };
		if (!e.gate.allowed && e.gate.reason === "needs_activation") {
			return { tipo: "tpv_activar", rechazoPrevio: e.gate.last_rejection ?? null };
		}
		if (!e.gate.allowed) return { tipo: "tpv_bloqueada", motivo: e.gate.reason };
		return { tipo: "tpv_app" };
	}

	// El modo se persiste en localStorage: un valor que no es ninguno de los conocidos es posible.
	return { tipo: "modo_invalido" };
}
