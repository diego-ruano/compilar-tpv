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
}: {
	inputTone: string;
	recoveryEmail: string;
	setRecoveryEmail: (v: string) => void;
	contactEmail: string;
	setContactEmail: (v: string) => void;
	contactPhone: string;
	setContactPhone: (v: string) => void;
}) {
	return (
		<div className="flex flex-col gap-4">
			<Panel title="Recuperación y contacto">
				<div className="grid grid-cols-1 gap-4">
					<Field label="Correo de recuperación">
						<TextInput value={recoveryEmail} onChange={(e) => setRecoveryEmail(e.target.value)} className={inputTone} />
					</Field>
					<Field label="Correo de contacto">
						<TextInput value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} className={inputTone} />
					</Field>
					<Field label="Teléfono de contacto">
						<TextInput value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} className={inputTone} />
					</Field>
				</div>
			</Panel>
		</div>
	);
}