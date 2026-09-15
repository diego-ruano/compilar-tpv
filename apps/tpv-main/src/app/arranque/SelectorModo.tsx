// src/app/arranque/SelectorModo.tsx
//
// El primer inicio: ¿este equipo es el TPV principal o un Handy?

import React from "react";
import { ArrowRight, Check, Database, Monitor, Smartphone, Wifi } from "lucide-react";

import LogoAltaria from "../../assets/img/logo-altaria-azul-transparente.png";
import { cn } from "../../shared/lib/cn";
import { conAviso } from "../../shared/lib/conAviso";
import type { DeviceMode } from "../../shared/stores/useMode";
import { Badge, Card } from "../../shared/ui";
import FondoDecorado from "./FondoDecorado";

export default function SelectorModo({
	logoSrc,
	businessName,
	ocupado,
	error,
	onElegir,
}: {
	logoSrc: string;
	businessName: string | null;
	ocupado: boolean;
	error: string | null;
	onElegir: (modo: DeviceMode) => Promise<void>;
}) {
	return (
		<div className="relative flex min-h-full w-full items-center justify-center overflow-hidden bg-bg px-4 py-6 font-sans text-fg sm:px-6 lg:px-10">
			<FondoDecorado />

			<div className="relative w-full max-w-5xl">
				<div className="mb-5 flex items-center justify-between gap-4">
					<div className="flex min-w-0 items-center gap-3">
						<div className="grid size-11 shrink-0 place-items-center overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
							<img src={logoSrc || LogoAltaria} className="size-8 rounded-lg object-cover" alt="" />
						</div>
						<div className="min-w-0">
							<p className="truncate text-sm font-bold text-fg">{businessName || "TPV"}</p>
							<p className="text-xs text-fg-muted">Configuración del dispositivo</p>
						</div>
					</div>
				</div>

				<Card padded={false} className="overflow-hidden rounded-3xl shadow-xl">
					<div className="border-b border-border px-5 py-5 sm:px-7 sm:py-6">
						<Badge tone="accent">Primer inicio</Badge>
						<h1 className="mt-3 text-2xl font-bold tracking-tight text-fg sm:text-3xl">
							¿Cómo vas a usar este dispositivo?
						</h1>
						<p className="mt-2 max-w-2xl text-sm leading-relaxed text-fg-muted sm:text-base">
							Elige el tipo de equipo que estás configurando.
							Podrás restablecerlo más adelante desde la propia aplicación.
						</p>
					</div>

					<div className="grid gap-4 p-4 sm:p-6 md:grid-cols-2">
						<button
							type="button"
							disabled={ocupado}
							onClick={conAviso(() => onElegir("tpv"))}
							className={cn(
								"group flex min-h-[280px] flex-col rounded-2xl border border-border bg-surface p-5 text-left",
								"transition duration-200 hover:-translate-y-0.5 hover:border-accent hover:shadow-lg",
								"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
								"disabled:pointer-events-none disabled:opacity-50 sm:p-6",
							)}
						>
							<div className="flex items-start justify-between gap-4">
								<div className="grid size-14 place-items-center rounded-2xl bg-accent-soft text-accent">
									<Monitor className="size-7" aria-hidden />
								</div>
								<Badge tone="accent">Principal</Badge>
							</div>

							<h2 className="mt-5 text-xl font-bold text-fg">TPV principal</h2>
							<p className="mt-2 text-sm leading-relaxed text-fg-muted">
								El equipo central del negocio. Guarda los datos
								localmente y puede trabajar aunque no haya conexión.
							</p>

							<ul className="mt-5 space-y-2.5 text-sm text-fg-muted">
								<li className="flex items-center gap-2">
									<Database className="size-4 text-accent" aria-hidden />
									Base de datos local
								</li>
								<li className="flex items-center gap-2">
									<Check className="size-4 text-success" aria-hidden />
									Gestión completa del negocio
								</li>
							</ul>

							<span className="mt-auto flex items-center justify-between border-t border-border pt-5 font-semibold text-accent">
								Configurar como TPV
								<ArrowRight className="size-5 transition-transform group-hover:translate-x-1" aria-hidden />
							</span>
						</button>

						<button
							type="button"
							disabled={ocupado}
							onClick={conAviso(() => onElegir("handy"))}
							className={cn(
								"group flex min-h-[280px] flex-col rounded-2xl border border-border bg-surface p-5 text-left",
								"transition duration-200 hover:-translate-y-0.5 hover:border-accent hover:shadow-lg",
								"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
								"disabled:pointer-events-none disabled:opacity-50 sm:p-6",
							)}
						>
							<div className="flex items-start justify-between gap-4">
								<div className="grid size-14 place-items-center rounded-2xl bg-surface-2 text-fg">
									<Smartphone className="size-7" aria-hidden />
								</div>
								<Badge>Dispositivo auxiliar</Badge>
							</div>

							<h2 className="mt-5 text-xl font-bold text-fg">Handy</h2>
							<p className="mt-2 text-sm leading-relaxed text-fg-muted">
								Un dispositivo para camareros conectado al TPV
								principal. Necesitarás vincularlo después.
							</p>

							<ul className="mt-5 space-y-2.5 text-sm text-fg-muted">
								<li className="flex items-center gap-2">
									<Wifi className="size-4 text-accent" aria-hidden />
									Conexión con la Main
								</li>
								<li className="flex items-center gap-2">
									<Check className="size-4 text-success" aria-hidden />
									Uso móvil en sala
								</li>
							</ul>

							<span className="mt-auto flex items-center justify-between border-t border-border pt-5 font-semibold text-accent">
								Configurar como Handy
								<ArrowRight className="size-5 transition-transform group-hover:translate-x-1" aria-hidden />
							</span>
						</button>
					</div>

					{ocupado ? (
						<div
							className="border-t border-border bg-surface-2 px-6 py-3 text-center text-sm font-medium text-fg-muted"
							role="status"
						>
							Preparando el dispositivo…
						</div>
					) : null}

					{error && (
						<pre className="mx-4 mb-4 whitespace-pre-wrap rounded-xl border border-danger bg-danger-soft p-3 text-sm text-danger sm:mx-6 sm:mb-6">
							{error}
						</pre>
					)}
				</Card>

				<p className="mt-4 text-center text-xs text-fg-subtle">
					El TPV principal debe configurarse antes de vincular dispositivos Handy.
				</p>
			</div>
		</div>
	);
}
