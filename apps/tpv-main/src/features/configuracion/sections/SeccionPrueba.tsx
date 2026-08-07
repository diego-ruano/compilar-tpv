// src/features/configuracion/sections/SeccionPrueba.tsx
//
// TEMPORAL — testigo del sistema de auto-actualización. Se añadió en la v0.2.0 con el único fin de
// que la actualización tenga algo VISIBLE: si un TPV que tenía la v0.1.0 acaba mostrando esta
// sección, la cadena entera (release → R2 → feed → banner → instalar → reiniciar) funcionó.
//
// Se puede borrar (junto con su entrada en Configuracion.tsx y en SectionKey) en cuanto la prueba
// esté dada por buena.

import React from "react";

import { Panel } from "../ui/Panel";
import { Badge } from "../ui/Badge";

export function SeccionPrueba() {
	return (
		<div className="flex flex-col gap-4">
			<Panel
				title="Sección de prueba"
				subtitle="Testigo de la actualización automática."
				right={<Badge tone="good">v0.2.0</Badge>}
			>
				<p className="text-sm text-fg">
					Si estás viendo esta sección, este dispositivo se actualizó solo a la versión
					0.2.0: descargó el instalador firmado, lo verificó, lo instaló y volvió a abrir
					la aplicación.
				</p>
				<p className="mt-3 text-xs text-fg-muted">
					Sección temporal, sin ninguna función. Se quitará cuando la prueba esté dada por
					buena.
				</p>
			</Panel>
		</div>
	);
}
