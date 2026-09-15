// src/app/arranque/useEmparejamientoHandy.ts
//
// El estado de la vinculación de un Handy con su Main durante el arranque: si ya está emparejado, la
// huella que se enseña para comprobarla en la Main y el emparejamiento en curso. La lógica del
// emparejamiento vive en `emparejamiento.ts`; esto la conecta con React y con el IPC.

import { useEffect, useRef, useState } from "react";
import { invokeClient } from "@tpv/client";

import { cloudPost } from "../../shared/lib/cloudApi";
import { deviceFingerprint } from "../../shared/lib/deviceFingerprint";
import type { ModeStateValue } from "../../shared/stores/useMode";
import {
	codigoParaVincular,
	emparejarHandy,
	identidadDelDispositivo,
	type CodigoDeVinculacion,
	type Invocar,
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

const invocar: Invocar = (comando, args) => invokeClient(comando, args);

export function useEmparejamientoHandy(modo: ModeStateValue) {
	const [estado, setEstado] = useState<EstadoEmparejamiento>({ step: "idle" });
	const [ocupado, setOcupado] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// Huella propia del dispositivo: el operador de la Main la compara con la que ve en la
	// lista de solicitudes antes de aprobar (sobre todo en la ruta de "solo código").
	const [huella, setHuella] = useState("");
	const vivoRef = useRef(true);

	useEffect(() => {
		let alive = true;
		void (async () => {
			try {
				const ident = await identidadDelDispositivo(invocar);
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
			const tenantIdRaw = await invokeClient<string | null>("handy_get_tenant");
			const tenantId = String(tenantIdRaw || "").trim();

			if (!tenantId) {
				setEstado({ step: "idle" });
				return;
			}

			const ident = await identidadDelDispositivo(invocar);

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
		setOcupado(true);
		setError(null);

		try {
			const emparejado = await emparejarHandy(codigo, {
				invoke: invocar,
				pedirALaNube: (ruta, cuerpo) => cloudPost("anon", ruta, cuerpo),
				sigueVivo: () => vivoRef.current,
				alQuedarPendiente: (p) => setEstado({ step: "waiting_approval", ...p }),
			});
			if (emparejado) setEstado({ step: "paired", ...emparejado });
		} catch (e: any) {
			setError(String(e?.message || e));
			setEstado({ step: "idle" });
		} finally {
			setOcupado(false);
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

	/** Vuelve a la pantalla de vinculación (re-emparejar o cambiar de TPV). */
	function volverAVincular() {
		setError(null);
		setEstado({ step: "idle" });
	}

	return { estado, ocupado, error, huella, vincular, volverAVincular };
}

export type EmparejamientoHandy = ReturnType<typeof useEmparejamientoHandy>;
