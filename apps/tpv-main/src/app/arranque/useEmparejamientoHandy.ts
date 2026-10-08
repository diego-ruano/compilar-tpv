import { commands } from "@tpv/client";
// src/app/arranque/useEmparejamientoHandy.ts
//
// El estado de la vinculación de un Handy con su Main durante el arranque: si ya está emparejado, la
// huella que se enseña para comprobarla en la Main y el emparejamiento en curso. La lógica del
// emparejamiento vive en `emparejamiento.ts`; esto la conecta con React y con el IPC.

import { useEffect, useRef, useState } from "react";


import { cloudPost } from "../../shared/lib/cloudApi";
import { deviceFingerprint } from "../../shared/lib/deviceFingerprint";
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

export function useEmparejamientoHandy(modo: ModeStateValue) {
	const [estado, setEstado] = useState<EstadoEmparejamiento>({ step: "idle" });
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

	async function cargarEmparejamientoExistente() {
		try {
			const tenantIdRaw = await commands.handyGetTenant();
			const tenantId = String(tenantIdRaw || "").trim();

			if (!tenantId) {
				setEstado({ step: "idle" });
				return;
			}

			const ident = await identidadDelDispositivo(commands);

			setEstado({ step: "paired", tenantId, token: "", deviceId: ident.deviceId });
		} catch {
			setEstado({ step: "idle" });
		}
	}

	useEffect(() => {
		if (modo !== "handy") return;
		void cargarEmparejamientoExistente();
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
				console.warn("[emparejamiento] no se ha podido soltar el código en la nube:", e),
			);
		}
	}

	/** Vuelve a la pantalla de vinculación (re-emparejar o cambiar de TPV). */
	function volverAVincular() {
		setError(null);
		setEstado({ step: "idle" });
	}

	return { estado, ocupado, error, huella, vincular, cancelar, volverAVincular };
}

export type EmparejamientoHandy = ReturnType<typeof useEmparejamientoHandy>;
