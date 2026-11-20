// OPS-02 · «Guardar diagnóstico…»: el paquete para soporte.
//
// Cuando el bar no tiene internet y la telemetría no ha salido, esto es lo que se le pide a quien
// llama a soporte. El backend lo compone ya filtrado y acotado (`diagnostico_generar_paquete`, que
// nunca falla por una parte: lo que no ha podido leer va dentro, explicado); aquí sólo se pregunta
// dónde guardarlo y se escribe, igual que los PDF. En Android el diálogo es el selector de
// documentos del sistema y `writeFile` escribe en lo que devuelve.
//
// Está en Configuración → Actualizaciones y soporte y junto a los avisos que dicen «contacta con
// soporte», también en la pantalla de recuperación, antes del login: por eso el comando no pide
// sesión.

import React from "react";

import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { LifeBuoy } from "lucide-react";
import { commands } from "@tpv/client";

import { conAviso } from "../lib/conAviso";
import { CORREO_SOPORTE } from "../lib/soporte";
import { useToast } from "../toast";
import Button, { type ButtonSize, type ButtonVariant } from "./Button";

export const DIAGNOSTICO_GUARDADO = "Diagnóstico guardado";
export const DIAGNOSTICO_FALLIDO = "No se pudo guardar el diagnóstico";

/** Lo que se dice al guardarlo: a quién mandarlo y, si falta algo, que el motivo va dentro. */
export function textoGuardado(partesSinLeer: number): string {
	const mandar = `Mándaselo a soporte (${CORREO_SOPORTE}).`;
	if (partesSinLeer === 0) return mandar;
	const partes = partesSinLeer === 1 ? "Una parte no se ha podido leer" : `${partesSinLeer} partes no se han podido leer`;
	return `${mandar} ${partes}; el motivo va dentro del fichero.`;
}

export function BotonDiagnostico({
	variant = "secondary",
	size = "md",
}: {
	variant?: ButtonVariant;
	size?: ButtonSize;
}) {
	const toast = useToast();
	const [ocupado, setOcupado] = React.useState(false);

	async function guardar() {
		setOcupado(true);
		try {
			const paquete = await commands.diagnosticoGenerarPaquete();
			const destino = await save({
				title: "Guardar el diagnóstico para soporte",
				defaultPath: paquete.nombre_fichero,
				filters: [{ name: "Diagnóstico", extensions: ["json"] }],
			});
			if (!destino) return;
			await writeFile(destino, new TextEncoder().encode(paquete.contenido));
			const sinLeer = paquete.secciones_con_error.length;
			if (sinLeer === 0) toast.success(DIAGNOSTICO_GUARDADO, textoGuardado(0));
			else toast.warning(DIAGNOSTICO_GUARDADO, textoGuardado(sinLeer));
		} finally {
			setOcupado(false);
		}
	}

	return (
		<Button
			variant={variant}
			size={size}
			loading={ocupado}
			disabled={ocupado}
			leftIcon={<LifeBuoy className="size-4" aria-hidden />}
			onClick={conAviso(guardar, DIAGNOSTICO_FALLIDO)}
		>
			Guardar diagnóstico…
		</Button>
	);
}
