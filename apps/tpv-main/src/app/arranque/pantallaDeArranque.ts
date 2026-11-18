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
//   · Un Handy al que la nube rechaza no está «conectando»: se le dice qué pasa y qué hacer. Es
//     la diferencia entre una espera que termina sola y una que no va a terminar nunca.
//   · INC-20261030-014: un Handy que ya ha trabajado con este vínculo no pierde lo que tenía abierto
//     al quedarse sin Main. La espera bloquea igual, pero encima de la aplicación, sin desmontarla:
//     antes se sustituía entera, y al volver la Main cada página empezaba de cero (la ficha que se
//     editaba, el modal abierto, la lista en la que se estaba). Al arrancar o al vincular de nuevo
//     no hay nada que conservar, y la espera sigue siendo la pantalla entera.
//   · SYN-INC-08: un Handy que todavía no sabe si tiene vínculo guardado no es un Handy sin vincular:
//     mientras lo lee, la pantalla de carga, no el formulario de vincular.

import type { LicenseGateResult_Serialize as LicenseGateResult } from "@tpv/contracts";

import type { MotivoRechazo } from "../../shared/stores/useMainPresence";
import type { ModeStateValue } from "../../shared/stores/useMode";

export type EntradaArranque = {
	modo: ModeStateValue;
	/** Todavía no se ha leído el estado local de la licencia. */
	licenciaCargando: boolean;
	/** El último veredicto del gate de licencia; `null` mientras se comprueba. */
	gate: LicenseGateResult | null;
	/** El Handy tiene token de emparejamiento. */
	handyEmparejado: boolean;
	/** SYN-INC-08: todavía se está leyendo si el Handy tiene vínculo guardado. */
	handyLeyendoVinculo: boolean;
	mainOnline: boolean | null;
	mainVolcando: boolean;
	/** La nube no deja entrar a este Handy, y por qué. `null` mientras no lo haya dicho. */
	rechazoHandy: MotivoRechazo | null;
	/** El Handy ya ha trabajado con este vínculo: tiene pantallas abiertas que conservar. */
	handyYaTrabajo: boolean;
};

/** Por qué espera un Handy, y si es una espera que termina sola. */
export type EsperaHandy = {
	conectando: boolean;
	volcando: boolean;
	rechazo: MotivoRechazo | null;
};

export type AvisoCaducidad = { motivo: "warn" | "expiry_grace"; expiresAtMs: number | null };

export type Pantalla =
	| { tipo: "cargando" }
	| { tipo: "elegir_modo" }
	| { tipo: "handy_vincular" }
	| ({ tipo: "handy_esperando_main" } & EsperaHandy)
	/** `espera`: la aplicación sigue montada, pero bloqueada por la espera, encima. */
	| { tipo: "handy_app"; espera: EsperaHandy | null }
	| { tipo: "tpv_activar"; rechazoPrevio: string | null }
	| { tipo: "tpv_bloqueada"; motivo: string }
	| { tipo: "tpv_app" };

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
		// También con la espera encima de la aplicación: tapa la barra propia de la aplicación, y en
		// el escritorio es la que mueve y cierra la ventana.
		conBarraDeArranque: !mainLista && !handyTrabajando,
		avisoCaducidad,
	};
}

function pantalla(e: EntradaArranque): Pantalla {
	if (e.modo === "loading" || e.licenciaCargando) return { tipo: "cargando" };
	if (e.modo === null) return { tipo: "elegir_modo" };

	if (e.modo === "handy") {
		// SYN-INC-08: sin saber todavía si hay vínculo, no se pide vincular: es la pantalla de carga.
		if (e.handyLeyendoVinculo) return { tipo: "cargando" };
		if (!e.handyEmparejado) return { tipo: "handy_vincular" };
		if (e.mainOnline === true && !e.mainVolcando) return { tipo: "handy_app", espera: null };
		const espera: EsperaHandy = {
			// Un rechazo NO es estar conectando: la nube ya ha contestado, y lo que ha dicho es
			// que no. Confundirlos es lo que dejaba la pantalla girando para siempre.
			conectando: e.mainOnline === null && e.rechazoHandy === null,
			volcando: e.mainVolcando,
			rechazo: e.rechazoHandy,
		};
		return e.handyYaTrabajo ? { tipo: "handy_app", espera } : { tipo: "handy_esperando_main", ...espera };
	}

	if (e.gate === null) return { tipo: "cargando" };
	if (!e.gate.allowed && e.gate.reason === "needs_activation") {
		return { tipo: "tpv_activar", rechazoPrevio: e.gate.last_rejection ?? null };
	}
	if (!e.gate.allowed) return { tipo: "tpv_bloqueada", motivo: e.gate.reason };
	return { tipo: "tpv_app" };
}
