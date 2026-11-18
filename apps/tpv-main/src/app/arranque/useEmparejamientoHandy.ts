import { commands, toAppError } from "@tpv/client";
// src/app/arranque/useEmparejamientoHandy.ts
//
// El estado de la vinculación de un Handy con su Main durante el arranque: si ya está emparejado, la
// huella que se enseña para comprobarla en la Main y el emparejamiento en curso. La lógica del
// emparejamiento vive en `emparejamiento.ts`; esto la conecta con React y con el IPC.

import { useEffect, useRef, useState } from "react";


import { cloudPost } from "../../shared/lib/cloudApi";
import { deviceFingerprint } from "../../shared/lib/deviceFingerprint";
import { captureException } from "../../shared/observability/sentry";
import type { ModeStateValue } from "../../shared/stores/useMode";
import {
	cancelarEmparejamiento,
	codigoParaVincular,
	emparejarHandy,
	identidadDelDispositivo,
	type CodigoDeVinculacion,

	type PedirALaNube,
} from "./emparejamiento";

export type EstadoEmparejamiento =
	/**
	 * SYN-INC-08: todavía no se ha leído el vínculo guardado. No es «sin vincular»: un Handy ya
	 * vinculado que arranca sin red tardaba en contestar, y entretanto se le pedía vincularse.
	 */
	| { step: "leyendo" }
	| { step: "idle" }
	| {
			step: "waiting_approval";
			pairCode: string;
			pairSecret: string;
			nonceB64: string;
			nonceExpiresAtMs: number;
	  }
	| { step: "paired"; tenantId: string; token: string; deviceId: string };

const pedirALaNube: PedirALaNube = (ruta, cuerpo) => cloudPost("anon", ruta, cuerpo);

/** El vínculo guardado: la Handy emparejada, o `idle` si no lo está. Si no se puede leer, lanza. */
async function leerVinculoGuardado(): Promise<EstadoEmparejamiento> {
	const tenantIdRaw = await commands.handyGetTenant();
	const tenantId = String(tenantIdRaw || "").trim();

	if (!tenantId) return { step: "idle" };

	const ident = await identidadDelDispositivo(commands);

	return { step: "paired", tenantId, token: "", deviceId: ident.deviceId };
}

export function useEmparejamientoHandy(modo: ModeStateValue) {
	// SYN-INC-08: se empieza leyendo; lo que no es un Handy no mira este estado.
	const [estado, setEstado] = useState<EstadoEmparejamiento>({ step: "leyendo" });
	const [ocupado, setOcupado] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// Huella propia del dispositivo: el operador de la Main la compara con la que ve en la
	// lista de solicitudes antes de aprobar (sobre todo en la ruta de "solo código").
	const [huella, setHuella] = useState("");
	const vivoRef = useRef(true);
	// Cada intento lleva su número. Cancelar lo sube, y así el intento que estaba esperando se
	// entera en su siguiente vuelta y deja de tocar el estado — también si ya ha empezado otro.
	const intentoRef = useRef(0);

	useEffect(() => {
		let alive = true;
		void (async () => {
			try {
				const ident = await identidadDelDispositivo(commands);
				const fp = await deviceFingerprint(ident.devicePubKeyB64);
				if (alive) setHuella(fp);
			} catch {
				/* sin identidad todavía: simplemente no mostramos huella */
			}
		})();
		return () => {
			alive = false;
		};
	}, []);

	useEffect(() => {
		vivoRef.current = true;
		return () => {
			vivoRef.current = false;
		};
	}, []);

	/**
	 * Al arrancar en modo Handy y al elegir «Handy» en el selector: con un vínculo guardado se vuelve
	 * a él, sin pedir un código nuevo. AUD-23: si no se puede leer, se dice, para que nadie lo tome
	 * por una Handy sin vincular.
	 */
	async function cargarEmparejamientoExistente() {
		setError(null);
		setEstado({ step: "leyendo" });
		try {
			setEstado(await leerVinculoGuardado());
		} catch (e: unknown) {
			setEstado({ step: "idle" });
			setError(
				`No se ha podido leer la vinculación guardada de este Handy: ${toAppError(e).message}. ` +
					"Para volver a intentarlo, pulsa «← Volver» y elige Handy.",
			);
		}
	}

	useEffect(() => {
		if (modo !== "handy") return;
		void cargarEmparejamientoExistente();
	}, [modo]);

	// AUD-23: en el selector de modo, si el equipo guarda un vínculo de Handy, la tarjeta lo dice:
	// elegir «Handy» vuelve a él sin código. Si no se puede leer, la tarjeta dice lo de siempre: es un
	// texto, y al elegir «Handy» la vinculación cuenta el fallo (el comando ya lo registra `invocar`).
	const [hayVinculoGuardado, setHayVinculoGuardado] = useState(false);
	useEffect(() => {
		if (modo !== null) return;
		let vivo = true;
		void commands
			.handyGetTenant()
			.then((tenant) => {
				if (vivo) setHayVinculoGuardado(String(tenant || "").trim() !== "");
			})
			.catch(() => {
				if (vivo) setHayVinculoGuardado(false);
			});
		return () => {
			vivo = false;
		};
	}, [modo]);

	async function iniciar(codigo: CodigoDeVinculacion) {
		const intento = ++intentoRef.current;
		const esElActual = () => vivoRef.current && intentoRef.current === intento;

		setOcupado(true);
		setError(null);

		try {
			const emparejado = await emparejarHandy(codigo, {
				commands,
				pedirALaNube,
				sigueVivo: esElActual,
				alQuedarPendiente: (p) => {
					if (esElActual()) setEstado({ step: "waiting_approval", ...p });
				},
			});
			if (emparejado && esElActual()) setEstado({ step: "paired", ...emparejado });
		} catch (e: any) {
			if (!esElActual()) return;
			setError(String(e?.message || e));
			setEstado({ step: "idle" });
		} finally {
			if (esElActual()) setOcupado(false);
		}
	}

	/** Vincula con lo que se ha escrito: el contenido del QR o, si no vale, el código manual. */
	function vincular(contenidoQr: string, codigoManual: string) {
		const codigo = codigoParaVincular(contenidoQr, codigoManual);

		if (!codigo) {
			setError("QR o código inválido");
			return;
		}

		void iniciar(codigo);
	}

	/**
	 * Deja de esperar la aprobación y vuelve a la pantalla de vinculación. Además suelta el código en
	 * la nube, para que la solicitud desaparezca de la lista de la Main.
	 */
	function cancelar() {
		const espera = estado.step === "waiting_approval" ? estado : null;

		intentoRef.current++;
		setOcupado(false);
		setError(null);
		setEstado({ step: "idle" });

		if (espera) {
			// Sin aviso a propósito: la pantalla ya ha vuelto a la vinculación, que es lo que se pidió.
			// Si no llega, lo único que pasa es que la solicitud sigue en la lista de la Main hasta que
			// caduque el código, y aprobarla entonces no le da acceso a nadie: la Handy ya no la espera.
			cancelarEmparejamiento(espera, { commands, pedirALaNube }).catch((e: unknown) =>
				captureException(e, { fase: "cancelar_emparejamiento" }),
			);
		}
	}

	/** Vuelve a la pantalla de vinculación (re-emparejar o cambiar de TPV). */
	function volverAVincular() {
		setError(null);
		setEstado({ step: "idle" });
	}

	return { estado, ocupado, error, huella, hayVinculoGuardado, vincular, cancelar, volverAVincular };
}

export type EmparejamientoHandy = ReturnType<typeof useEmparejamientoHandy>;
