// src/pages/Configuracion/types.ts
export type LicenseInfo = {
	plan: "FREE" | "PRO";
	status: "ACTIVA" | "EN_GRACIA" | "VENCIDA";
	nextPaymentDate: string; // YYYY-MM-DD
	seats: number;
	devices: number;
};

export type SectionKey =
	| "NEGOCIO"
	| "CONTACTO"
	| "TICKET"
	| "LICENCIA"
	| "APARIENCIA"
	| "VINCULAR_HANDY";

export type NavItem = {
	key: SectionKey;
	title: string;
	desc: string;
	keywords: string[];
};

export type BusinessDraft = {
	businessName: string;
	logoDataUrl: string | null;
	direccion: string;
	telefono: string;
	cif: string;
	mensajeFooter: string;
	ivaPercent: number;
};

export function shallowEqualDraft(a: BusinessDraft, b: BusinessDraft) {
	return (
		a.businessName === b.businessName &&
		a.logoDataUrl === b.logoDataUrl &&
		a.direccion === b.direccion &&
		a.telefono === b.telefono &&
		a.cif === b.cif &&
		a.mensajeFooter === b.mensajeFooter &&
		Number(a.ivaPercent) === Number(b.ivaPercent)
	);
}