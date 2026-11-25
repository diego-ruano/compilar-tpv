import { commands } from "@tpv/client";
// src/features/configuracion/sections/Licencia.tsx
//
// Estado real de la licencia (antes era un placeholder). Lee `license_get_state`, que es lo que
// el gate ya cachea localmente: no hace red propia. La fuente de verdad es el servidor; esto es
// la última foto verificada.
//
// Se enseña lo que el dueño del bar puede USAR para decidir algo: si está activa, cuándo caduca
// y cuánto queda. Ni el plan (sólo hay uno) ni el UUID del dispositivo pintaban nada aquí.

import React, { useCallback, useEffect, useState } from "react";
import { toAppError } from "@tpv/client";
import type { LicenseLocalState_Serialize as LicenseLocalState } from "@tpv/contracts";

import { Button, Input } from "../../../shared/ui";
import { conAviso } from "../../../shared/lib/conAviso";
import { avisoDeClave, claveCanonica, EJEMPLO_CLAVE } from "../../../shared/lib/claveLicencia";
import { Panel } from "../ui/Panel";
import { cn } from "../utils";
import { CopiasSeguridad } from "./CopiasSeguridad";
import { diasNaturalesHasta } from "../../../shared/lib/diasNaturales";
import { useMode } from "../../../shared/stores/useMode";

type Tono = "ok" | "warn" | "danger" | "muted";

const ESTADO: Record<string, { label: string; tono: Tono }> = {
	active: { label: "Activa", tono: "ok" },
	warn: { label: "Activa · caduca pronto", tono: "warn" },
	expiry_grace: { label: "Caducada · renuévala ya", tono: "danger" },
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

function Fila({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex items-center justify-between gap-4 py-2.5 border-b border-border last:border-0">
			<span className="text-sm text-fg-muted">{label}</span>
			<span className="text-sm font-medium text-fg text-right">{children}</span>
		</div>
	);
}

/**
 * RI-52 · Añadir el tiempo de otra clave a la licencia de este equipo (el canje de REV-13). Es
 * como renueva quien compra otra licencia, y como junta en un local el tiempo de varias.
 *
 * Va por `license_sumar_clave`, que sólo suma: la clave de otro local ya activada, o una clave que
 * estrenaría un negocio nuevo, se rechazan con su frase sin tocar nada. Mover una licencia de un
 * equipo a otro no se hace desde aquí.
 */
function AnadirClave({ onSumada }: { onSumada: () => void }) {
	const [clave, setClave] = useState("");
	// LIC-INC-01: una clave mal escrita se avisa al dejar el campo, sin esperar a pulsar.
	const [claveTerminada, setClaveTerminada] = useState(false);
	const [ocupado, setOcupado] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [sumada, setSumada] = useState<string | null>(null);

	async function anadir() {
		setOcupado(true);
		setError(null);
		setSumada(null);
		try {
			const r = await commands.licenseSumarClave({ activation_key: clave.trim() });
			const hasta = r.state?.expires_at ? new Date(r.state.expires_at) : null;
			setSumada(
				hasta && !Number.isNaN(hasta.getTime())
					? `Tiempo añadido. La licencia vence ahora el ${formatFecha(hasta.getTime())}.`
					: "Tiempo añadido.",
			);
			setClave("");
			setClaveTerminada(false);
			onSumada();
		} catch (e) {
			setError(toAppError(e).message);
		} finally {
			setOcupado(false);
		}
	}

	const avisoClave = avisoDeClave(clave, claveTerminada);

	return (
		<Panel title="Añadir otra licencia" subtitle="Suma el tiempo de otra clave a la de este equipo">
			<div className="flex flex-col gap-3">
				<label className="block">
					<span className="text-sm font-semibold text-fg">Clave de licencia</span>
					<Input
						value={clave}
						onChange={(e) => setClave(e.target.value)}
						onBlur={() => setClaveTerminada(true)}
						placeholder={EJEMPLO_CLAVE}
						autoComplete="off"
						spellCheck={false}
						disabled={ocupado}
						className="mt-1 h-11 font-mono"
					/>
				</label>
				{avisoClave ? (
					<p className="text-sm text-danger" role="alert">
						{avisoClave}
					</p>
				) : null}
				<p className="text-xs text-fg-muted">
					Para renovar, o para juntar aquí el tiempo de varias licencias compradas a la vez. Sólo
					valen claves sin estrenar: una que ya se usa en otro local no se puede añadir.
				</p>
				<div>
					<Button loading={ocupado} disabled={claveCanonica(clave) === null} onClick={conAviso(anadir)}>
						Añadir
					</Button>
				</div>
				{sumada ? (
					<p className="rounded-xl border border-success bg-success-soft px-4 py-3 text-sm text-success" role="status">
						{sumada}
					</p>
				) : null}
				{error ? (
					<p className="rounded-xl border border-danger bg-danger-soft px-4 py-3 text-sm text-danger" role="alert">
						{error}
					</p>
				) : null}
			</div>
		</Panel>
	);
}

/** La licencia y, en la Main, sus copias de seguridad: lo que el dueño mira para quedarse tranquilo. */
export function Licencia({ darkMode }: { darkMode: boolean }) {
	const esMain = useMode((s) => s.mode === "tpv");
	return (
		<div className="flex flex-col gap-4">
			<EstadoLicencia />
			{esMain && <CopiasSeguridad darkMode={darkMode} />}
		</div>
	);
}

function EstadoLicencia() {
	const [state, setState] = useState<LicenseLocalState | null | "loading">("loading");
	const esHandy = useMode((s) => s.mode === "handy");

	const leerEstado = useCallback(() => {
		commands.licenseGetState()
			.then(setState)
			.catch(() => setState(null));
	}, []);

	useEffect(leerEstado, [leerEstado]);

	if (state === "loading") {
		return (
			<div className="flex flex-col gap-4">
				<Panel title="Licencia">
					<p className="text-sm text-fg-muted">Cargando…</p>
				</Panel>
			</div>
		);
	}

	if (!state || esHandy) {
		return (
			<div className="flex flex-col gap-4">
				<Panel title="Licencia">
					<p className="text-sm text-fg-muted">
						{/* RI-77: la Handy trabaja con la licencia del local, que es de la Main (lo que quede guardado
						    de cuando este equipo fue Main no es la de ahora). */}
						{esHandy
							? "La licencia del local es la del TPV principal: se consulta y se renueva desde allí."
							: "Este equipo no tiene ninguna licencia activada."}
					</p>
				</Panel>
			</div>
		);
	}

	const statusCode = (state.status ?? "active").trim();
	const info = ESTADO[statusCode] ?? { label: statusCode, tono: "muted" as Tono };

	const expiresMs = state.expires_at_ms ?? null;
	// Días de calendario, no horas redondeadas: caducar a las 23:00 es «hoy» a las 08:00.
	const dias = expiresMs != null ? diasNaturalesHasta(expiresMs) : null;

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
					<Fila label="Caducidad">
						{expiresMs != null ? formatFecha(expiresMs) : "—"}
					</Fila>
					{diasTexto ? <Fila label="Tiempo restante">{diasTexto}</Fila> : null}
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
							? "Tu licencia caduca pronto. Para renovarla, compra otra y añade su clave aquí abajo: el tiempo se suma al que te queda."
							: "Tu licencia ha caducado y la aplicación puede bloquearse en cualquier momento. Compra otra y añade su clave aquí abajo cuanto antes."}
					</div>
				) : null}
			</Panel>

			<AnadirClave onSumada={leerEstado} />
		</div>
	);
}
