// src/features/configuracion/sections/Apariencia.tsx
import React from "react";
import { Panel } from "../ui/Panel";
import { Switch } from "../ui/Toggles";

export function Apariencia({
	darkMode,
	setDarkMode,
}: {
	darkMode: boolean;
	setDarkMode: (v: boolean) => void;
}) {
	return (
		<div className="flex flex-col gap-4">
			<Panel title="Tema">
				<Switch checked={darkMode} onChange={setDarkMode} label="Activar modo oscuro" />
			</Panel>
		</div>
	);
}