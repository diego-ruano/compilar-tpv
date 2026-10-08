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
	| "PERMISOS"
	/** FISCAL-01 (Veri*factu): datos del obligado, certificado y estado del envío a la AEAT. */
	| "FISCAL"
	| "CONTACTO"
	/** RI-61: duración por defecto de una reserva y qué hacer cuando dos se pisan. */
	| "RESERVAS"
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
	business_name: string;
	logo_data_url: string | null;
	direccion: string;
	telefono: string;
	cif: string;
	mensaje_footer: string;
	iva_percent: number;
	/**
	 * FISCAL-01: quién factura. **No es `business_name`** — uno es el rótulo («Bar La Plaza») y el
	 * otro el obligado («Francisco García SL»). Va en el borrador del negocio aunque se edite desde
	 * la sección Fiscal, porque se guarda en la misma fila (`Business_Settings`) y con el mismo
	 * botón: dos borradores para una fila serían dos cosas que pueden divergir.
	 */
	razon_social: string;
};

export function shallowEqualDraft(a: BusinessDraft, b: BusinessDraft) {
	return (
		a.business_name === b.business_name &&
		a.logo_data_url === b.logo_data_url &&
		a.direccion === b.direccion &&
		a.telefono === b.telefono &&
		a.cif === b.cif &&
		a.mensaje_footer === b.mensaje_footer &&
		Number(a.iva_percent) === Number(b.iva_percent) &&
		a.razon_social === b.razon_social
	);
}