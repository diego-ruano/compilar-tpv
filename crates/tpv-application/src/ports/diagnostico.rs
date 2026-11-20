//! OPS-02 · Puertos del **paquete de diagnóstico** para soporte.
//!
//! El caso de uso (`use_cases::diagnostico`) compone el paquete con lo que le traen las secciones;
//! aquí están las dos piezas que no puede hacer él: leer la base local (SQLite, en
//! `tpv-infra-sqlite::diagnostico`) y quitar lo que tenga forma de dato personal o de secreto (el
//! filtro de `tpv-telemetry`, el mismo que pasa todo lo que sale a Axiom y a Sentry).

use async_trait::async_trait;
use serde::Serialize;
use serde_json::Value;

use crate::error::AppResult;

/// Lo que se cuenta de la base local de la Main. **Ni una fila de negocio**: tamaños, la versión
/// del esquema y la comprobación de integridad de SQLite.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct EstadoDeLaBase {
    /// Lo que dice `PRAGMA quick_check`: `["ok"]`, o los problemas que ha visto (hasta 20). Habla
    /// de páginas, índices y tablas, nunca de lo que hay dentro.
    pub integridad: Vec<String>,
    /// Lo que ocupa el fichero (páginas por tamaño de página), sin el WAL.
    pub bytes: i64,
    /// Páginas libres: lo que se recuperaría compactando.
    pub paginas_libres: i64,
    /// `wal` en uso normal.
    pub modo_del_diario: String,
    pub version_sqlite: String,
    /// Migraciones aplicadas y la última, por nombre (`0001_inicial.sql`).
    pub migraciones_aplicadas: i64,
    pub ultima_migracion: Option<String>,
}

/// La base local, vista desde el diagnóstico. Sólo lectura.
#[async_trait]
pub trait DiagnosticoDeLaBase: Send + Sync {
    async fn estado(&self) -> AppResult<EstadoDeLaBase>;
}

/// El filtro de datos personales (OBS-01) por el que pasa **todo** lo que entra en el paquete:
/// los datos de cada sección y el texto de sus errores.
pub trait FiltroDeDatosPersonales: Send + Sync {
    fn filtrar(&self, valor: &mut Value);
}
