// src/features/configuracion/sections/Contacto.tsx
import React from "react";
import { Panel } from "../ui/Panel";
import { Field } from "../ui/Field";
import { TextInput } from "../ui/Inputs";

export function Contacto({
	inputTone,
	recoveryEmail,
	setRecoveryEmail,
	contactEmail,
	setContactEmail,
	contactPhone,
	setContactPhone,
	loading,
	saving,
	onSave,
}: {
	inputTone: string;
	recoveryEmail: string;
	setRecoveryEmail: (v: string) => void;
	contactEmail: string;
	setContactEmail: (v: string) => void;
	contactPhone: string;
	setContactPhone: (v: string) => void;
	loading: boolean;
	saving: boolean;
	onSave: () => void;
}) {
	return (
		<div className="flex flex-col gap-4">
			<Panel title="Recuperación y contacto">
				{loading ? (
					<div className="py-4 text-sm text-fg-muted">Cargando…</div>
				) : (
					<div className="grid grid-cols-1 gap-4">
						<Field label="Correo de recuperación">
							<TextInput
								value={recoveryEmail}
								onChange={(e) => setRecoveryEmail(e.target.value)}
								className={inputTone}
							/>
						</Field>
						<Field label="Correo de contacto">
							<TextInput
								value={contactEmail}
								onChange={(e) => setContactEmail(e.target.value)}
								className={inputTone}
							/>
						</Field>
						<Field label="Teléfono de contacto">
							<TextInput
								value={contactPhone}
								onChange={(e) => setContactPhone(e.target.value)}
								className={inputTone}
							/>
						</Field>
					</div>
				)}
			</Panel>

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
