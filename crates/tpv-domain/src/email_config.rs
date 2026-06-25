//! Entidad de dominio: configuración de correo electrónico.

#[derive(Debug, Clone)]
pub struct EmailConfig {
    pub modo: String, // "managed" | "smtp"
    pub smtp_host: String,
    pub smtp_port: i32,
    pub smtp_user: String,
    pub smtp_password: String,
    pub smtp_from_email: String,
    pub smtp_from_name: String,
    pub smtp_use_tls: bool,
}

impl Default for EmailConfig {
    fn default() -> Self {
        Self {
            modo: "managed".into(),
            smtp_host: String::new(),
            smtp_port: 587,
            smtp_user: String::new(),
            smtp_password: String::new(),
            smtp_from_email: String::new(),
            smtp_from_name: String::new(),
            smtp_use_tls: true,
        }
    }
}
