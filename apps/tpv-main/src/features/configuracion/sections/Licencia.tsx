// src/features/configuracion/sections/Licencia.tsx
import React from "react";
import { Panel } from "../ui/Panel";
import { cn } from "../utils";

export function Licencia({ darkMode }: { darkMode: boolean }) {
	return (
		<div className="flex flex-col gap-4">
			<Panel title="Licencia">
				<p className={cn("text-sm", darkMode ? "text-fg-muted" : "text-fg-muted")}>
					Información de licencia pendiente de implementar.
				</p>
			</Panel>
		</div>
	);
}