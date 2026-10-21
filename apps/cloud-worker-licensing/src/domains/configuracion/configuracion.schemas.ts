// src/domains/configuracion/configuracion.schemas.ts

import * as z from "zod";

import { recortar } from "../../lib/texto";
import type { Assert, SameKeys } from "../../lib/typeGuards";
import type { BusinessSettingsPatch, TicketSettingsPatch, ContactSettingsPatch } from "@tpv/contracts";
import { zDinero, zDineroNoNegativo } from "../../lib/dinero";
import { zIva } from "../../lib/iva";

const MSG_NO_VINO = "«No vino» se marca entre 0 (nunca) y 24 horas después de la hora de la reserva";

// RI-87: la Handy valida las mismas claves y tipos que el IPC de la Main.
// Ausente conserva; null sólo borra el logo. strict impide ignorar una clave mal escrita.
const negocio = z.object({
    business_name: z.string().optional(), logo_data_url: z.string().nullable().optional(),
    direccion: z.string().optional(), telefono: z.string().optional(), cif: z.string().optional(),
    mensaje_footer: z.string().optional(), iva_percent: zIva.optional(),
    umbral_descuadre: zDineroNoNegativo.optional(), razon_social: z.string().optional(),
    descripcion_op: z.string().optional(), limite_simplif: zDinero.optional(),
    verifactu_entorno: z.string().optional(), reserva_duracion_min: z.number().int().optional(),
    reserva_solape: z.string().optional(),
    // Mismo texto y rango que `no_vino_valido` en la Main (`tpv-domain/src/reservas.rs`).
    reserva_no_vino_min: z.number().int(MSG_NO_VINO).min(0, MSG_NO_VINO).max(24 * 60, MSG_NO_VINO).optional(),
}).strict();
const ticket = z.object({
    show_logo: z.boolean().optional(), show_business_name: z.boolean().optional(),
    show_address: z.boolean().optional(), show_phone: z.boolean().optional(), show_footer_message: z.boolean().optional(),
    paper_width_mm: z.number().int().optional(), paper_dpi: z.number().int().optional(), chars_per_line: z.number().int().optional(),
    margin_top_mm: z.number().finite().optional(), margin_bottom_mm: z.number().finite().optional(),
    margin_left_mm: z.number().finite().optional(), margin_right_mm: z.number().finite().optional(), font_scale: z.number().finite().optional(),
}).strict();
const contacto = z.object({
    contact_email: z.string().overwrite(recortar).max(254).refine(s => s === "" || z.string().email().safeParse(s).success, "Correo de contacto inválido").optional(),
    contact_phone: z.string().optional(),
}).strict();
export const negocioPatchSchema = z.object({ patch: negocio }).strict();
export const ticketPatchSchema = z.object({ patch: ticket }).strict();
export const contactoPatchSchema = z.object({ patch: contacto }).strict();

// ── Drift-guard con los DTOs de Rust (ARCH-03) ───────────────────────────────
// Una línea por schema: comprueba en LAS DOS DIRECCIONES que las claves del zod y
// las del DTO coinciden. Si en Rust se añade, quita o renombra un campo, este módulo
// deja de compilar y el error nombra el campo. Ver `lib/typeGuards.ts`.
type _GNegocio = Assert<SameKeys<z.infer<typeof negocio>, BusinessSettingsPatch>>;
type _GTicket = Assert<SameKeys<z.infer<typeof ticket>, TicketSettingsPatch>>;
type _GContacto = Assert<SameKeys<z.infer<typeof contacto>, ContactSettingsPatch>>;
