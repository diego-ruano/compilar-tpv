// src/features/configuracion/sections/Contacto.tsx
//
// El correo y el teléfono de contacto del negocio. El correo de RECUPERACIÓN no está aquí: vive en
// la base central y se cambia en Licencia, verificando el buzón nuevo (LOGIN-08).
import React from "react";
import { Panel } from "../ui/Panel";
import { Field } from "../ui/Field";
import { TextInput } from "../ui/Inputs";

export function Contacto({
	inputTone,
	contact_email,
	setContactEmail,
	contact_phone,
	setContactPhone,
	loading,
	saving,
	onSave,
}: {
	inputTone: string;
	contact_email: string;
	setContactEmail: (v: string) => void;
	contact_phone: string;
	setContactPhone: (v: string) => void;
	loading: boolean;
	saving: boolean;
	onSave: () => void;
}) {
	return (
		<div className="flex flex-col gap-4">
			<Panel title="Contacto">
				{loading ? (
					<div className="py-4 text-sm text-fg-muted">Cargando…</div>
				) : (
					<div className="grid grid-cols-1 gap-4">
						<Field label="Correo de contacto">
							<TextInput
								type="email"
								maxLength={254}
								value={contact_email}
								onChange={(e) => setContactEmail(e.target.value)}
								className={inputTone}
							/>
						</Field>
						<Field label="Teléfono de contacto">
							<TextInput
								value={contact_phone}
								onChange={(e) => setContactPhone(e.target.value)}
								className={inputTone}
							/>
						</Field>
					</div>
				)}
			</Panel>
			<p className="text-sm text-fg-muted">El correo es necesario para enviar pedidos y recibir las respuestas de los proveedores. El teléfono es opcional.</p>

			<div className="flex justify-end">
				<button
					type="button"
					disabled={loading || saving}
					onClick={onSave}
					className="rounded-xl px-5 py-2.5 text-sm font-semibold bg-accent text-white hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
				>
					{saving ? "Guardando…" : "Guardar contacto"}
				</button>
			</div>
		</div>
	);
}
