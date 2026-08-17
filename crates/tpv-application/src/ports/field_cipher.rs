//! Puerto de cifrado de campo (TRAB-03).
//!
//! Los datos personales sensibles del personal (DNI, IBAN, nº de la Seguridad Social) se
//! replican a la nube igual que el resto de la fila, pero **no pueden viajar legibles**:
//! un volcado de la base de datos del tenant no debe entregar la identidad fiscal ni la
//! cuenta bancaria de nadie.
//!
//! La solución es cifrarlos **antes** de que el valor entre en la sentencia SQL. Eso tiene
//! una consecuencia que es justo la que interesa: como el outbox captura la sentencia ya
//! construida, la replicación transporta el texto cifrado **sin enterarse de nada**. No hay
//! que tocar ni el TenantHub ni el protocolo de sincronización.
//!
//! La implementación vive en `tpv-infra-licensing`, que es quien custodia la clave.

use crate::error::AppResult;

/// Cifra y descifra valores de columna sueltos.
///
/// Trabaja con `Option<&str>` porque las tres columnas son opcionales: un trabajador puede
/// no tener IBAN. `None` y la cadena vacía se dejan intactos — no hay nada que proteger y
/// cifrarlos sólo estorbaría a los `NULL` del esquema.
pub trait FieldCipher: Send + Sync {
    /// Texto claro -> texto cifrado (con su prefijo de versión).
    ///
    /// Es **idempotente**: un valor que ya viene cifrado se devuelve tal cual. Sin esto, el
    /// job de migración volvería a cifrar lo ya cifrado en cada pasada.
    fn encrypt(&self, plain: Option<&str>) -> AppResult<Option<String>>;

    /// Texto cifrado -> texto claro.
    ///
    /// Un valor **sin** el prefijo de versión se devuelve tal cual: son las filas que
    /// existían antes de activar el cifrado y que el job de migración aún no ha convertido.
    /// Así la app sigue leyendo bien durante la transición.
    fn decrypt(&self, stored: Option<&str>) -> AppResult<Option<String>>;

    /// ¿Está ya cifrado este valor? Lo usa el job de migración para saber qué falta.
    fn is_encrypted(&self, stored: &str) -> bool;
}
