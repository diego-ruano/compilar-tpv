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
	/** FISCAL-01 (Veri*factu): datos del obligado, certificado y estado del envío a la AEAT. */
	| "FISCAL"
	| "CONTACTO"
	| "TICKET"
	| "LICENCIA"
	| "APARIENCIA"
	| "CONECTIVIDAD"
	| "VINCULAR_HANDY"
	| "DISPOSITIVO"
	| "ACTUALIZACIONES";

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
	/**
	 * FISCAL-01: quién factura. **No es `businessName`** — uno es el rótulo («Bar La Plaza») y el
	 * otro el obligado («Francisco García SL»). Va en el borrador del negocio aunque se edite desde
	 * la sección Fiscal, porque se guarda en la misma fila (`Business_Settings`) y con el mismo
	 * botón: dos borradores para una fila serían dos cosas que pueden divergir.
	 */
	razonSocial: string;
};

export function shallowEqualDraft(a: BusinessDraft, b: BusinessDraft) {
	return (
		a.businessName === b.businessName &&
		a.logoDataUrl === b.logoDataUrl &&
		a.direccion === b.direccion &&
		a.telefono === b.telefono &&
		a.cif === b.cif &&
		a.mensajeFooter === b.mensajeFooter &&
		Number(a.ivaPercent) === Number(b.ivaPercent) &&
		a.razonSocial === b.razonSocial
	);
}