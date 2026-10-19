// Cómo se nombra una mesa en un texto («Mesa 5 · 4 plazas»). En la Main el nombre es libre y el que
// propone al crearla ya es «Mesa 5»: sólo se antepone «Mesa» cuando el nombre es un número a secas,
// y «Terraza 3» se queda como está. El plano dibuja el nombre tal cual, como la sala de la Main.
//
// La misma regla está en SQL en el ticket (`tickets.rs`) y en la lista de cobros (`cuentas.rs` y su
// espejo del worker), en Rust en el aviso de una reserva web (`reservas_web_recogida.rs`) y, copiada,
// en los correos de la reserva web (`domains/reservas_web/correos.ts`, en el worker).
export function nombreDeMesa(nombre: string): string {
	return /^[0-9]+$/.test(nombre) ? `Mesa ${nombre}` : nombre;
}
