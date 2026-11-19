import { commands, toAppError } from "@tpv/client";
// src/features/configuracion/sections/Dispositivo.tsx
//
// Sección de Configuración para el Handy: desvincular este dispositivo. Hace un "reset de
// fábrica" local (borra el emparejamiento y el modo) PERO conserva la identidad del dispositivo
// (keypair / device_id), así que se puede volver a emparejar sin reinstalar. Tras desvincular,
// la app vuelve al selector Main/Handy.

import React, { useState } from "react";

import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";

import { Panel } from "../ui/Panel";
import { GhostButton } from "../ui/Buttons";
import { limpiarSesionLocal } from "../../../shared/stores/useAuth";
import { useMode } from "../../../shared/stores/useMode";
import { conAviso } from "../../../shared/lib/conAviso";

export function Dispositivo({ darkMode }: { darkMode: boolean }) {
	const setMode = useMode((s) => s.setMode);
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);

	async function unpair() {
		if (
			!(await confirmDialog(
				"¿Desvincular este dispositivo? Volverás al selector Main/Handy y tendrás que emparejarlo de nuevo. La identidad del equipo se conserva.",
				{ title: "Desvincular dispositivo", kind: "warning" },
			))
		)
			return;

		setBusy(true);
		setErr(null);
		try {
			// device_reset_mode: persiste modo=None, suelta backends y borra el token Handy del
			// keyring (la identidad ed25519 / device_id NO se tocan).
			await commands.deviceResetMode();
			// Rust ya ha cerrado su sesión; se retira también la de la pantalla, para que al volver a
			// elegir Handy se pida el PIN.
			limpiarSesionLocal();
			setMode(null); // AppBoot vuelve al selector de modo.
		} catch (e: unknown) {
			setErr(toAppError(e).message);
			setBusy(false);
		}
	}

	return (
		<div className="flex flex-col gap-4">
			<Panel
				title="Dispositivo"
				subtitle="Este equipo está vinculado como Handy."
			>
				{err ? (
					<div
						className={cnDanger(darkMode)}
					>
						{err}
					</div>
				) : null}

				<GhostButton onClick={conAviso(unpair)} disabled={busy}>
					{busy ? "Desvinculando..." : "Desvincular este dispositivo"}
				</GhostButton>

				<p className="mt-3 text-xs text-fg-muted">
					Se borra el emparejamiento local y vuelves al selector Main/Handy. No se
					reinstala nada: la identidad del dispositivo se mantiene para poder volver a
					emparejarlo.
				</p>
			</Panel>
		</div>
	);
}

function cnDanger(_darkMode: boolean): string {
	return "mb-3 text-sm rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-danger";
}
