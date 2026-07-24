//! Dominio de **notificaciones**: enums, entidad de emisión y validaciones puras.
//! No conoce SQLite, ni Tauri, ni la frontera de la UI.

/// `ID_Rol` FIJO del rol "Administrador" (seed de `0001_inicial.sql`, idéntico en Main y nube).
/// Para dirigir avisos a todos los administradores con `Destino::Rol(ADMIN_ROL_ID)` sin lookups:
/// la visibilidad compara `Destino_Valor` contra `Usuarios.ID_Rol`.
pub const ADMIN_ROL_ID: &str = "00000000-0000-7000-8000-000000000001";

/// Severidad visual de una notificación (mapea a la columna `Severidad`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severidad {
    Info,
    Exito,
    Aviso,
    Error,
}

impl Severidad {
    /// Valor persistido en SQL.
    pub fn as_str(&self) -> &'static str {
        match self {
            Severidad::Info => "info",
            Severidad::Exito => "exito",
            Severidad::Aviso => "aviso",
            Severidad::Error => "error",
        }
    }

    /// Mapea el argumento que envía la UI; desconocido => `Info` (tolerante).
    pub fn from_arg(s: &str) -> Self {
        match s.trim().to_lowercase().as_str() {
            "exito" => Severidad::Exito,
            "aviso" => Severidad::Aviso,
            "error" => Severidad::Error,
            _ => Severidad::Info,
        }
    }
}

/// A quién va dirigida una notificación. El valor concreto depende del tipo:
/// - `Usuario` -> `ID_Usuario` (el principal de la sesión).
/// - `Rol`     -> `ID_Rol` (estable frente al renombrado del rol).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Destino {
    Todos,
    Usuario(String),
    Rol(String),
}

impl Destino {
    /// Descompone en `(Destino_Tipo, Destino_Valor)` para persistir.
    pub fn to_columns(&self) -> (&'static str, Option<String>) {
        match self {
            Destino::Todos => ("todos", None),
            Destino::Usuario(v) => ("usuario", Some(v.clone())),
            Destino::Rol(v) => ("rol", Some(v.clone())),
        }
    }

    /// Reconstruye desde `(tipo, valor)` validando coherencia: `usuario`/`rol` exigen valor.
    pub fn from_columns(tipo: &str, valor: Option<String>) -> Result<Self, String> {
        let valor = valor.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        match tipo.trim().to_lowercase().as_str() {
            "todos" => Ok(Destino::Todos),
            "usuario" => valor
                .map(Destino::Usuario)
                .ok_or_else(|| "destino 'usuario' requiere ID_Usuario".to_string()),
            "rol" => valor
                .map(Destino::Rol)
                .ok_or_else(|| "destino 'rol' requiere ID_Rol".to_string()),
            otro => Err(format!("destino desconocido: '{otro}'")),
        }
    }
}

/// Notificación lista para emitir (ya normalizada/validada). El `id` lo asigna la persistencia.
#[derive(Debug, Clone)]
pub struct NuevaNotificacion {
    pub tipo: String,
    pub severidad: Severidad,
    pub titulo: String,
    pub cuerpo: Option<String>,
    pub destino: Destino,
    /// Acción opcional que ofrece la notificación (p. ej. `aprobar_pedido`). El backend es
    /// agnóstico: el frontend decide cómo pintarla y qué dispara.
    pub accion: Option<String>,
    /// Datos de la acción como JSON opaco (el dominio no lo interpreta).
    pub payload: Option<String>,
    /// Clave anti-duplicado mientras la notificación siga activa (p. ej. `stock_bajo:<ID_Producto>`).
    pub clave_dedupe: Option<String>,
    /// Caducidad opcional `YYYY-MM-DD HH:MM:SS` (None = no expira).
    pub expira_en: Option<String>,
}

/// Limpia un opcional de texto: trim + descarta vacíos.
fn limpia_opcional(v: Option<String>) -> Option<String> {
    v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

impl NuevaNotificacion {
    /// Normaliza y valida los datos crudos (los que llegan de la UI). `tipo` y `titulo` son
    /// obligatorios; el destino debe ser coherente.
    #[allow(clippy::too_many_arguments)]
    pub fn validar(
        tipo: String,
        severidad: &str,
        titulo: String,
        cuerpo: Option<String>,
        destino_tipo: &str,
        destino_valor: Option<String>,
        accion: Option<String>,
        payload: Option<String>,
        clave_dedupe: Option<String>,
        expira_en: Option<String>,
    ) -> Result<Self, String> {
        let tipo = tipo.trim().to_string();
        if tipo.is_empty() {
            return Err("tipo requerido".to_string());
        }
        let titulo = titulo.trim().to_string();
        if titulo.is_empty() {
            return Err("titulo requerido".to_string());
        }
        let destino = Destino::from_columns(destino_tipo, destino_valor)?;
        Ok(NuevaNotificacion {
            tipo,
            severidad: Severidad::from_arg(severidad),
            titulo,
            cuerpo: limpia_opcional(cuerpo),
            destino,
            accion: limpia_opcional(accion),
            // El payload es JSON opaco: solo descartamos el string vacío, no se hace trim del contenido.
            payload: payload.filter(|s| !s.trim().is_empty()),
            clave_dedupe: limpia_opcional(clave_dedupe),
            expira_en: limpia_opcional(expira_en),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn severidad_mapea_argumentos_y_desconocidos() {
        assert_eq!(Severidad::from_arg(" Aviso ").as_str(), "aviso");
        assert_eq!(Severidad::from_arg("ERROR").as_str(), "error");
        assert_eq!(Severidad::from_arg("otra").as_str(), "info");
    }

    #[test]
    fn destino_ida_y_vuelta() {
        let (t, v) = Destino::Rol("r1".into()).to_columns();
        assert_eq!(t, "rol");
        assert_eq!(Destino::from_columns(t, v).unwrap(), Destino::Rol("r1".into()));

        let (t, v) = Destino::Todos.to_columns();
        assert_eq!((t, v), ("todos", None));
    }

    #[test]
    fn destino_usuario_y_rol_exigen_valor() {
        assert!(Destino::from_columns("usuario", None).is_err());
        assert!(Destino::from_columns("rol", Some("  ".into())).is_err());
        assert!(Destino::from_columns("marciano", None).is_err());
    }

    #[test]
    fn nueva_notificacion_normaliza_y_exige_tipo_y_titulo() {
        let n = NuevaNotificacion::validar(
            " stock_bajo ".into(),
            "aviso",
            " Falta stock ".into(),
            Some("  ".into()),
            "rol",
            Some(" r1 ".into()),
            Some(" aprobar_pedido ".into()),
            Some("{\"id\":1}".into()),
            Some(" stock_bajo:p1 ".into()),
            None,
        )
        .unwrap();
        assert_eq!(n.tipo, "stock_bajo");
        assert_eq!(n.titulo, "Falta stock");
        assert!(n.cuerpo.is_none());
        assert_eq!(n.severidad, Severidad::Aviso);
        assert_eq!(n.destino, Destino::Rol("r1".into()));
        assert_eq!(n.accion.as_deref(), Some("aprobar_pedido"));
        assert_eq!(n.payload.as_deref(), Some("{\"id\":1}"));
        assert_eq!(n.clave_dedupe.as_deref(), Some("stock_bajo:p1"));

        assert!(NuevaNotificacion::validar(
            " ".into(), "info", "x".into(), None, "todos", None, None, None, None, None
        )
        .is_err());
        assert!(NuevaNotificacion::validar(
            "t".into(), "info", " ".into(), None, "todos", None, None, None, None, None
        )
        .is_err());
    }
}
