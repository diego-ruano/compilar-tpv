// src/features/configuracion/sections/Licencia.tsx
//
// Estado real de la licencia (antes era un placeholder). Lee `license_get_state`, que es lo que
// el gate ya cachea localmente: no hace red propia. Muestra estado, plan, días restantes y el
// dispositivo. La fuente de verdad es el servidor; esto es la última foto verificada.

import React, { useEffect, useState } from "react";
import { invokeClient } from "@tpv/client";
import type { LicenseLocalState } from "@tpv/contracts";

import { Panel } from "../ui/Panel";
import { cn } from "../utils";

const DAY_MS = 24 * 60 * 60 * 1000;

type Tono = "ok" | "warn" | "danger" | "muted";

const ESTADO: Record<string, { label: string; tono: Tono }> = {
	active: { label: "Activa", tono: "ok" },
	warn: { label: "Activa · caduca pronto", tono: "warn" },
	expiry_grace: { label: "Caducada · periodo de gracia", tono: "danger" },
	expired: { label: "Caducada", tono: "danger" },
	revoked: { label: "Revocada", tono: "danger" },
	device_replaced: { label: "Trasladada a otro equipo", tono: "muted" },
};

function tonoClases(tono: Tono): string {
	switch (tono) {
		case "ok":
			return "border-success bg-success-soft text-success";
		case "warn":
			return "border-warning bg-warning-soft text-fg";
		case "danger":
			return "border-danger bg-danger-soft text-danger";
		default:
			return "border-border bg-surface-2 text-fg-muted";
	}
}

function formatFecha(ms: number): string {
	return new Date(ms).toLocaleDateString("es-ES", {
		day: "numeric",
		month: "long",
		year: "numeric",
	});
}

function diasRestantes(expiresAtMs: number): number {
	return Math.ceil((expiresAtMs - Date.now()) / DAY_MS);
}

function Fila({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex items-center justify-between gap-4 py-2.5 border-b border-border last:border-0">
			<span className="text-sm text-fg-muted">{label}</span>
			<span className="text-sm font-medium text-fg text-right">{children}</span>
		</div>
	);
}

export function Licencia({ darkMode }: { darkMode: boolean }) {
	void darkMode; // el estilo va por tokens de tema; el prop se mantiene por firma común
	const [state, setState] = useState<LicenseLocalState | null | "loading">("loading");

	useEffect(() => {
		invokeClient<LicenseLocalState | null>("license_get_state")
			.then(setState)
			.catch(() => setState(null));
	}, []);

	if (state === "loading") {
		return (
			<div className="flex flex-col gap-4">
				<Panel title="Licencia">
					<p className="text-sm text-fg-muted">Cargando…</p>
				</Panel>
			</div>
		);
	}

	if (!state) {
		return (
			<div className="flex flex-col gap-4">
				<Panel title="Licencia">
					<p className="text-sm text-fg-muted">
						Este equipo no tiene ninguna licencia activada.
					</p>
				</Panel>
			</div>
		);
	}

	const statusCode = (state.status ?? "active").trim();
	const info = ESTADO[statusCode] ?? { label: statusCode, tono: "muted" as Tono };

	const expiresMs = state.expires_at_ms ?? null;
	const dias = expiresMs != null ? diasRestantes(expiresMs) : null;

	// Texto de los días restantes según cómo esté de cerca la caducidad.
	let diasTexto: string | null = null;
	if (dias != null) {
		if (dias > 1) diasTexto = `Quedan ${dias} días`;
		else if (dias === 1) diasTexto = "Queda 1 día";
		else if (dias === 0) diasTexto = "Caduca hoy";
		else diasTexto = `Caducó hace ${Math.abs(dias)} ${Math.abs(dias) === 1 ? "día" : "días"}`;
	}

	const avisaRenovar = statusCode === "warn" || statusCode === "expiry_grace";

	return (
		<div className="flex flex-col gap-4">
			<Panel
				title="Licencia"
				subtitle="Estado de la licencia de este TPV principal"
				right={
					<span
						className={cn(
							"inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold",
							tonoClases(info.tono),
						)}
					>
						{info.label}
					</span>
				}
			>
				<div className="flex flex-col">
					<Fila label="Plan">{state.plan ?? "standard"}</Fila>
					<Fila label="Caducidad">
						{expiresMs != null ? formatFecha(expiresMs) : "—"}
					</Fila>
					{diasTexto ? <Fila label="Tiempo restante">{diasTexto}</Fila> : null}
					<Fila label="Dispositivo">
						<span className="font-mono text-xs">{state.device_id}</span>
					</Fila>
				</div>

				{avisaRenovar ? (
					<div
						className={cn(
							"mt-4 rounded-xl border px-4 py-3 text-sm",
							statusCode === "warn"
								? "border-warning bg-warning-soft text-fg"
								: "border-danger bg-danger-soft text-danger",
						)}
					>
						{statusCode === "warn"
							? "Tu licencia caduca pronto. Renuévala para no perder el acceso: vuelve a comprarla con el mismo correo y se extenderá sola."
							: "Tu licencia ha caducado y estás en el periodo de gracia. Renuévala cuanto antes para no quedarte sin TPV."}
					</div>
				) : null}
			</Panel>
		</div>
	);
}
