// src/features/configuracion/sections/Licencia.tsx
import React from "react";
import { Panel } from "../ui/Panel";
import { cn } from "../utils";
import type { LicenseInfo } from "../types";

export function Licencia({ darkMode, license }: { darkMode: boolean; license: LicenseInfo }) {
	return (
		<div className="flex flex-col gap-4">
			<Panel title="Licencia">
				<div className="grid grid-cols-1 md:grid-cols-2 gap-3">
					{[
						{ k: "Plan", v: license.plan },
						{ k: "Estado", v: license.status },
						{ k: "Próximo pago", v: license.nextPaymentDate },
						{ k: "Dispositivos", v: String(license.devices) },
					].map((x) => (
						<div
							key={x.k}
							className={cn(
								"rounded-xl border p-4",
								darkMode ? "border-slate-800 bg-slate-950/40" : "border-slate-200 bg-white"
							)}
						>
							<div className={cn("text-xs font-semibold", darkMode ? "text-slate-300" : "text-slate-600")}>{x.k}</div>
							<div className={cn("text-lg font-extrabold mt-1", darkMode ? "text-white" : "text-slate-900")}>{x.v}</div>
						</div>
					))}
				</div>
			</Panel>
		</div>
	);
}