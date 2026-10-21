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
pub fn normalizar_ids(ids: Vec<String>) -> Vec<String> {
    let mut out: Vec<_> = ids.into_iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    out.sort_unstable(); out.dedup(); out
}
