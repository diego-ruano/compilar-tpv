// src/app/arranque/AvisoCaducidad.tsx
//
// El banner que cuelga por encima de la aplicación cuando el gate deja pasar pero la licencia está en
// la ventana de aviso (`warn`) o ya caducada dentro del margen del servidor (`expiry_grace`). No
// bloquea: informa.

import { cn } from "../../shared/lib/cn";
import type { AvisoCaducidad as Aviso } from "./pantallaDeArranque";
import { textoAvisoCaducidad } from "./textosLicencia";

export default function AvisoCaducidad({ aviso }: { aviso: Aviso }) {
	const grace = aviso.motivo === "expiry_grace";

	return (
		<div
			className={cn(
				"w-full px-4 py-2 text-center text-sm font-medium",
				grace ? "bg-danger-soft text-danger border-b border-danger" : "bg-warning-soft text-fg border-b border-warning",
			)}
			role="status"
		>
			{textoAvisoCaducidad(aviso)} Renuévala con el mismo correo de compra y se extenderá sola.
		</div>
	);
}
