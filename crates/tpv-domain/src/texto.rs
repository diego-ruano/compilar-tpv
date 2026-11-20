//! Normalización compartida de texto e identificadores (RI-48).

/// Recorta y exige que quede algo. Si no, el error es `mensaje`, que se le enseña a quien está
/// delante: una frase que dice qué falta («Escribe el nombre del producto.»), no el nombre del
/// campo (VALID-03).
pub fn requerido(input: &str, mensaje: &str) -> Result<String, String> {
    let out = input.trim().to_string();
    if out.is_empty() { return Err(mensaje.to_string()); }
    Ok(out)
}
pub fn limpiar_opcional(input: Option<String>) -> Option<String> {
    input.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// AUD-36 · Lo más largo que se guarda en un texto libre (unas notas, la nota de una reserva, la
/// información de un proveedor), en caracteres y ya recortado. Por la API de la Handy entraban megas
/// en cada uno. El mismo tope y el mismo mensaje en el worker (`lib/texto.ts`), con sus casos en
/// `validacion_casos.json`.
pub const MAX_TEXTO_LIBRE: usize = 4000;
pub const MSG_TEXTO_DEMASIADO_LARGO: &str = "Ese texto es demasiado largo: como mucho 4.000 caracteres.";

/// Un texto libre: recortado, vacío es `None`, y como mucho [`MAX_TEXTO_LIBRE`] caracteres.
pub fn texto_libre(input: Option<String>) -> Result<Option<String>, String> {
    match limpiar_opcional(input) {
        Some(t) if t.chars().count() > MAX_TEXTO_LIBRE => Err(MSG_TEXTO_DEMASIADO_LARGO.into()),
        t => Ok(t),
    }
}
pub fn normalizar_ids(ids: Vec<String>) -> Vec<String> {
    let mut out: Vec<_> = ids.into_iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    out.sort_unstable(); out.dedup(); out
}
