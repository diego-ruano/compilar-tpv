// src/features/configuracion/types.ts
export type SectionKey =
	| "NEGOCIO"
	| "PERMISOS"
	/** RI-61: duración por defecto de una reserva y qué hacer cuando dos se pisan. */
	| "RESERVAS"
	| "TICKET"
	| "LICENCIA"
	| "CONECTIVIDAD"
	| "VINCULAR_HANDY"
	| "DISPOSITIVO"
	| "ACTUALIZACIONES";

export type NavItem = {
	key: SectionKey;
	title: string;
	desc: string;
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
	 * otro el obligado («Francisco García SL»). Va en el borrador del negocio porque se guarda en
	 * la misma fila (`Business_Settings`) y con el mismo botón: dos borradores para una fila serían
	 * dos cosas que pueden divergir.
	 */
	razon_social: string;
};

/** Los campos del borrador, en el orden del formulario. */
export const BUSINESS_DRAFT_CAMPOS: readonly (keyof BusinessDraft)[] = [
	"business_name",
	"logo_data_url",
	"direccion",
	"telefono",
	"cif",
	"mensaje_footer",
	"iva_percent",
	"razon_social",
];
