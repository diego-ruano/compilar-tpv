//! Adaptador SQLite del repositorio de configuración. Local-First (sin outbox/applied).

use tpv_domain::dinero::Dinero;
use std::sync::Arc;

use async_trait::async_trait;
use libsql::Value;
use serde_json::Value as JsonValue;

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::configuracion::ConfiguracionRepository;
use tpv_contracts::configuracion::{BusinessSettings, ContactSettings, TicketSettings};
use tpv_domain::configuracion::{
    clamp_chars_per_line, clamp_font_scale, clamp_margin_mm, clamp_paper_dpi, clamp_paper_width_mm,
};

use crate::db::{Db, Reader, Writer};
use crate::mapping::{v_f64, v_i64, v_string, v_dinero, dinero_val};

/// `DescripcionOperacion` cuando nadie la ha configurado.
///
/// Es un campo OBLIGATORIO del registro de facturación (hasta 500 caracteres) y no se deriva de las
/// líneas: los nombres de producto los escribe el usuario. Un campo obligatorio que puede llegar
/// vacío es un rechazo garantizado, así que aquí no hay `Option`: hay un defecto que es correcto
/// para un bar. Mismo texto que el `DEFAULT` del esquema.
const DESCRIPCION_OP_POR_DEFECTO: &str = "Servicios de hosteleria y restauracion";

pub struct SqliteConfiguracionRepository {
    db: Arc<Db>,
}

impl SqliteConfiguracionRepository {
    pub fn new(db: Arc<Db>) -> Self {
        Self { db }
    }
}

fn db_err(e: impl std::fmt::Display) -> AppError {
    AppError::repository(e.to_string())
}

fn bool_to_i64(b: bool) -> i64 {
    if b {
        1
    } else {
        0
    }
}

fn value_to_bool(v: Value) -> Option<bool> {
    match v {
        Value::Integer(n) => Some(n != 0),
        Value::Real(n) => Some(n != 0.0),
        Value::Text(s) => match s.trim().to_lowercase().as_str() {
            "1" | "true" | "yes" | "si" | "sí" => Some(true),
            "0" | "false" | "no" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

/* ── Helpers de patch (JSON parcial) ── */

fn patch_get<'a>(patch: &'a JsonValue, key: &str) -> Option<&'a JsonValue> {
    patch.as_object()?.get(key)
}
fn patch_has(patch: &JsonValue, key: &str) -> bool {
    patch.as_object().map(|o| o.contains_key(key)).unwrap_or(false)
}
fn patch_string(patch: &JsonValue, key: &str) -> Option<String> {
    match patch_get(patch, key)? {
        JsonValue::Null => None,
        JsonValue::String(s) => Some(s.clone()),
        JsonValue::Number(n) => Some(n.to_string()),
        JsonValue::Bool(b) => Some(if *b { "true".into() } else { "false".into() }),
        _ => None,
    }
}
fn patch_f64(patch: &JsonValue, key: &str) -> Option<f64> {
    match patch_get(patch, key)? {
        JsonValue::Number(n) => n.as_f64(),
        JsonValue::String(s) => s.parse::<f64>().ok(),
        _ => None,
    }
}
/// Un importe que llega en el patch de configuracion. Viene en CENTIMOS enteros, igual que
/// cruza el resto de la frontera (ARQ-01); el `as_f64` de respaldo cubre un cliente que todavia
/// mande un decimal, que se redondea al centimo mas cercano en vez de truncarse.
fn patch_dinero(patch: &JsonValue, key: &str) -> Option<Dinero> {
    match patch_get(patch, key)? {
        JsonValue::Number(n) => n
            .as_i64()
            .or_else(|| n.as_f64().map(|f| f.round() as i64))
            .map(Dinero::de_centimos),
        JsonValue::String(s) => s.parse::<i64>().ok().map(Dinero::de_centimos),
        _ => None,
    }
}
fn patch_i64(patch: &JsonValue, key: &str) -> Option<i64> {
    match patch_get(patch, key)? {
        JsonValue::Number(n) => n.as_i64(),
        JsonValue::String(s) => s.parse::<i64>().ok(),
        _ => None,
    }
}
fn patch_bool(patch: &JsonValue, key: &str) -> Option<bool> {
    match patch_get(patch, key)? {
        JsonValue::Bool(b) => Some(*b),
        JsonValue::Number(n) => n.as_i64().map(|x| x != 0),
        JsonValue::String(s) => match s.trim().to_lowercase().as_str() {
            "1" | "true" | "yes" | "si" | "sí" => Some(true),
            "0" | "false" | "no" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

// Las tres filas singleton (`Business_Settings`, `Ticket_Settings` y `Contact_Settings`, ID=1) las
// siembra la migración inicial, que corre igual en la BD local y en la del tenant en la nube. Aquí
// había un `ensure_config_rows` que las re-aseguraba con tres `INSERT OR IGNORE` en CADA llamada,
// incluidas las de LECTURA. No garantizaba nada que no estuviera ya garantizado y costaba caro:
// toda escritura se captura en `_Sync_Outbox` por la FORMA del SQL (no por si cambió algo), así que
// leer los ajustes mandaba tres operaciones a la nube y a las Handy. Y esas operaciones anunciaban
// "los ajustes han cambiado", con lo que quien las recibía releía los ajustes... y las volvía a
// generar. Una lectura no puede escribir.

#[async_trait]
impl ConfiguracionRepository for SqliteConfiguracionRepository {
    async fn get_business(&self) -> AppResult<BusinessSettings> {
        let g = self.db.read().await;
        let conn = &g;
        let mut rows = conn
            .query(
                "SELECT Business_Name, Logo_DataUrl, Direccion, Telefono, CIF, Mensaje_Footer, IVA_Percent, Umbral_Descuadre, Razon_Social, Descripcion_Op, Limite_Simplif, Verifactu_Entorno FROM Business_Settings WHERE ID=1 LIMIT 1;",
                (),
            )
            .await
            .map_err(db_err)?;
        let row = rows
            .next()
            .await
            .map_err(db_err)?
            .ok_or_else(|| AppError::not_found("No existe Business_Settings (ID=1)"))?;
        let g = |idx: i32| row.get_value(idx).map_err(db_err);
        Ok(BusinessSettings {
            business_name: v_string(g(0)?).unwrap_or_else(|| "TPV".to_string()),
            logo_data_url: v_string(g(1)?),
            direccion: v_string(g(2)?).unwrap_or_default(),
            telefono: v_string(g(3)?).unwrap_or_default(),
            cif: v_string(g(4)?).unwrap_or_default(),
            mensaje_footer: v_string(g(5)?).unwrap_or_else(|| "¡Gracias por su visita!".to_string()),
            iva_percent: v_f64(g(6)?).unwrap_or(10.0),
            umbral_descuadre: v_dinero(g(7)?).unwrap_or(
                tpv_domain::cierre_caja::UMBRAL_DESCUADRE_POR_DEFECTO,
            ),
            razon_social: v_string(g(8)?).unwrap_or_default(),
            descripcion_op: v_string(g(9)?)
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| DESCRIPCION_OP_POR_DEFECTO.to_string()),
            limite_simplif: v_dinero(g(10)?)
                .filter(|v| *v > Dinero::CERO)
                .unwrap_or(tpv_domain::verifactu::LIMITE_SIMPLIFICADA_HOSTELERIA),
            verifactu_entorno: v_string(g(11)?).unwrap_or_else(|| "produccion".to_string()),
        })
    }

    async fn get_ticket(&self) -> AppResult<TicketSettings> {
        let g = self.db.read().await;
        let conn = &g;
        let mut rows = conn
            .query(
                "SELECT Show_Logo, Show_BusinessName, Show_Address, Show_Phone, Show_CIF, Show_DateTime, Show_LineItems, Show_BaseAndIVA, Show_Total, Show_FooterMessage, Paper_Width_Mm, Paper_Dpi, Chars_Per_Line, Margin_Top_Mm, Margin_Bottom_Mm, Margin_Left_Mm, Margin_Right_Mm, Font_Scale FROM Ticket_Settings WHERE ID=1 LIMIT 1;",
                (),
            )
            .await
            .map_err(db_err)?;
        let row = rows
            .next()
            .await
            .map_err(db_err)?
            .ok_or_else(|| AppError::not_found("No existe Ticket_Settings (ID=1)"))?;
        let getb = |idx: i32| -> AppResult<bool> {
            Ok(value_to_bool(row.get_value(idx).map_err(db_err)?).unwrap_or(true))
        };
        let paper_width_mm =
            clamp_paper_width_mm(v_i64(row.get_value(10).map_err(db_err)?).unwrap_or(80));
        let paper_dpi = clamp_paper_dpi(v_i64(row.get_value(11).map_err(db_err)?).unwrap_or(203));
        let chars_per_line =
            clamp_chars_per_line(v_i64(row.get_value(12).map_err(db_err)?).unwrap_or(42));
        let margin_top_mm = clamp_margin_mm(v_f64(row.get_value(13).map_err(db_err)?).unwrap_or(0.0));
        let margin_bottom_mm =
            clamp_margin_mm(v_f64(row.get_value(14).map_err(db_err)?).unwrap_or(0.0));
        let margin_left_mm =
            clamp_margin_mm(v_f64(row.get_value(15).map_err(db_err)?).unwrap_or(0.0));
        let margin_right_mm =
            clamp_margin_mm(v_f64(row.get_value(16).map_err(db_err)?).unwrap_or(0.0));
        let font_scale = clamp_font_scale(v_f64(row.get_value(17).map_err(db_err)?).unwrap_or(1.0));
        Ok(TicketSettings {
            show_logo: getb(0)?,
            show_business_name: getb(1)?,
            show_address: getb(2)?,
            show_phone: getb(3)?,
            show_cif: getb(4)?,
            show_date_time: getb(5)?,
            show_line_items: getb(6)?,
            show_base_and_iva: getb(7)?,
            show_total: getb(8)?,
            show_footer_message: getb(9)?,
            paper_width_mm,
            paper_dpi,
            chars_per_line,
            margin_top_mm,
            margin_bottom_mm,
            margin_left_mm,
            margin_right_mm,
            font_scale,
        })
    }

    async fn patch_business(&self, patch: &JsonValue) -> AppResult<()> {
        let g = self.db.write().await;
        let conn = &g;

        let mut sets: Vec<&str> = Vec::new();
        let mut args: Vec<Value> = Vec::new();

        if patch_has(patch, "business_name") {
            if let Some(v) = patch_string(patch, "business_name") {
                sets.push("Business_Name = ?");
                args.push(Value::Text(v));
            }
        }
        if patch_has(patch, "logo_data_url") {
            match patch_get(patch, "logo_data_url") {
                Some(JsonValue::Null) => {
                    sets.push("Logo_DataUrl = ?");
                    args.push(Value::Null);
                }
                Some(JsonValue::String(s)) => {
                    sets.push("Logo_DataUrl = ?");
                    if s.trim().is_empty() {
                        args.push(Value::Null);
                    } else {
                        args.push(Value::Text(s.clone()));
                    }
                }
                _ => {}
            }
        }
        if patch_has(patch, "direccion") {
            if let Some(v) = patch_string(patch, "direccion") {
                sets.push("Direccion = ?");
                args.push(Value::Text(v));
            }
        }
        if patch_has(patch, "telefono") {
            if let Some(v) = patch_string(patch, "telefono") {
                sets.push("Telefono = ?");
                args.push(Value::Text(v));
            }
        }
        if patch_has(patch, "cif") {
            if let Some(v) = patch_string(patch, "cif") {
                sets.push("CIF = ?");
                args.push(Value::Text(v));
            }
        }
        if patch_has(patch, "mensaje_footer") {
            if let Some(v) = patch_string(patch, "mensaje_footer") {
                sets.push("Mensaje_Footer = ?");
                args.push(Value::Text(v));
            }
        }
        if patch_has(patch, "umbral_descuadre") {
            if let Some(v) = patch_f64(patch, "umbral_descuadre") {
                sets.push("Umbral_Descuadre = ?");
                args.push(Value::Real(v));
            }
        }
        if patch_has(patch, "iva_percent") {
            if let Some(v) = patch_f64(patch, "iva_percent") {
                sets.push("IVA_Percent = ?");
                args.push(Value::Real(v));
            }
        }

        // ── Datos fiscales (FISCAL-01) ──────────────────────────────────────────────────────────
        if patch_has(patch, "razon_social") {
            if let Some(v) = patch_string(patch, "razon_social") {
                sets.push("Razon_Social = ?");
                args.push(Value::Text(v));
            }
        }
        if patch_has(patch, "descripcion_op") {
            if let Some(v) = patch_string(patch, "descripcion_op") {
                // Vacío no se acepta: es un campo obligatorio del registro y llegaría a la AEAT
                // como un rechazo. Se cae al texto por defecto, que es correcto para un bar.
                let v = if v.trim().is_empty() {
                    DESCRIPCION_OP_POR_DEFECTO.to_string()
                } else {
                    tpv_domain::verifactu::sanear_texto(&v, 500)
                };
                sets.push("Descripcion_Op = ?");
                args.push(Value::Text(v));
            }
        }
        if patch_has(patch, "limite_simplif") {
            if let Some(v) = patch_dinero(patch, "limite_simplif") {
                sets.push("Limite_Simplif = ?");
                args.push(dinero_val(if v > Dinero::CERO {
                    v
                } else {
                    tpv_domain::verifactu::LIMITE_SIMPLIFICADA_HOSTELERIA
                }));
            }
        }
        if patch_has(patch, "verifactu_entorno") {
            if let Some(v) = patch_string(patch, "verifactu_entorno") {
                // El CHECK del esquema sólo admite dos valores, y un UPDATE que lo viole es un
                // error de BD sin mensaje. Se normaliza aquí, donde sí se puede explicar.
                let v = if v.trim().eq_ignore_ascii_case("pruebas") {
                    "pruebas"
                } else {
                    "produccion"
                };
                sets.push("Verifactu_Entorno = ?");
                args.push(Value::Text(v.to_string()));
            }
        }

        if sets.is_empty() {
            return Ok(());
        }
        sets.push("Updated_At = datetime('now','localtime')");
        let sql = format!("UPDATE Business_Settings SET {} WHERE ID = 1;", sets.join(", "));

        let affected = conn.execute(&sql, args).await.map_err(db_err)?;
        if affected == 0 {
            return Err(AppError::not_found("No existe Business_Settings (ID=1)"));
        }
        Ok(())
    }

    async fn get_contact(&self) -> AppResult<ContactSettings> {
        let g = self.db.read().await;
        let conn = &g;
        let mut rows = conn
            .query(
                "SELECT Contact_Email, Contact_Phone FROM Contact_Settings WHERE ID=1 LIMIT 1;",
                (),
            )
            .await
            .map_err(db_err)?;
        let row = rows
            .next()
            .await
            .map_err(db_err)?
            .ok_or_else(|| AppError::not_found("No existe Contact_Settings (ID=1)"))?;
        let g = |idx: i32| row.get_value(idx).map_err(db_err);
        Ok(ContactSettings {
            contact_email: v_string(g(0)?).unwrap_or_default(),
            contact_phone: v_string(g(1)?).unwrap_or_default(),
        })
    }

    async fn patch_contact(&self, patch: &JsonValue) -> AppResult<()> {
        let g = self.db.write().await;
        let conn = &g;

        let mut sets: Vec<&str> = Vec::new();
        let mut args: Vec<Value> = Vec::new();

        if patch_has(patch, "contact_email") {
            if let Some(v) = patch_string(patch, "contact_email") {
                sets.push("Contact_Email = ?");
                args.push(Value::Text(v));
            }
        }
        if patch_has(patch, "contact_phone") {
            if let Some(v) = patch_string(patch, "contact_phone") {
                sets.push("Contact_Phone = ?");
                args.push(Value::Text(v));
            }
        }

        if sets.is_empty() {
            return Ok(());
        }
        sets.push("Updated_At = datetime('now','localtime')");
        let sql = format!("UPDATE Contact_Settings SET {} WHERE ID = 1;", sets.join(", "));

        let affected = conn.execute(&sql, args).await.map_err(db_err)?;
        if affected == 0 {
            return Err(AppError::not_found("No existe Contact_Settings (ID=1)"));
        }
        Ok(())
    }

    async fn patch_ticket(&self, patch: &JsonValue) -> AppResult<()> {
        let g = self.db.write().await;
        let conn = &g;

        let mut sets: Vec<&str> = Vec::new();
        let mut args: Vec<Value> = Vec::new();

        for (key, col) in [
            ("show_logo", "Show_Logo = ?"),
            ("show_business_name", "Show_BusinessName = ?"),
            ("show_address", "Show_Address = ?"),
            ("show_phone", "Show_Phone = ?"),
            ("show_cif", "Show_CIF = ?"),
            ("show_date_time", "Show_DateTime = ?"),
            ("show_line_items", "Show_LineItems = ?"),
            ("show_base_and_iva", "Show_BaseAndIVA = ?"),
            ("show_total", "Show_Total = ?"),
            ("show_footer_message", "Show_FooterMessage = ?"),
        ] {
            if let Some(v) = patch_bool(patch, key) {
                sets.push(col);
                args.push(Value::Integer(bool_to_i64(v)));
            }
        }

        if let Some(v) = patch_i64(patch, "paper_width_mm") {
            sets.push("Paper_Width_Mm = ?");
            args.push(Value::Integer(clamp_paper_width_mm(v)));
        }
        if let Some(v) = patch_i64(patch, "paper_dpi") {
            sets.push("Paper_Dpi = ?");
            args.push(Value::Integer(clamp_paper_dpi(v)));
        }
        if let Some(v) = patch_i64(patch, "chars_per_line") {
            sets.push("Chars_Per_Line = ?");
            args.push(Value::Integer(clamp_chars_per_line(v)));
        }
        for (key, col) in [
            ("margin_top_mm", "Margin_Top_Mm = ?"),
            ("margin_bottom_mm", "Margin_Bottom_Mm = ?"),
            ("margin_left_mm", "Margin_Left_Mm = ?"),
            ("margin_right_mm", "Margin_Right_Mm = ?"),
        ] {
            if let Some(v) = patch_f64(patch, key) {
                sets.push(col);
                args.push(Value::Real(clamp_margin_mm(v)));
            }
        }
        if let Some(v) = patch_f64(patch, "font_scale") {
            sets.push("Font_Scale = ?");
            args.push(Value::Real(clamp_font_scale(v)));
        }

        if sets.is_empty() {
            return Ok(());
        }
        sets.push("Updated_At = datetime('now','localtime')");
        let sql = format!("UPDATE Ticket_Settings SET {} WHERE ID = 1;", sets.join(", "));

        let affected = conn.execute(&sql, args).await.map_err(db_err)?;
        if affected == 0 {
            return Err(AppError::not_found("No existe Ticket_Settings (ID=1)"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests_lecturas_no_escriben {
    //! Una lectura de ajustes no puede dejar nada en el outbox.
    //!
    //! Aquí había tres `INSERT OR IGNORE` "por si las filas no existen" que se ejecutaban en cada
    //! llamada, lectura incluida. Como la captura del outbox mira la FORMA del SQL y no si cambió
    //! algo, abrir la app mandaba tres operaciones vacías a la nube... que anunciaban "los ajustes
    //! han cambiado", y quien las recibía releía los ajustes y volvía a generarlas. El bucle
    //! resultante generó decenas de miles de operaciones antes de que se viera.
    //!
    //! Este test es el que impide que vuelva: si alguien reintroduce un "ensure" en un camino de
    //! lectura, el outbox deja de estar vacío y esto se pone en rojo.

    use std::sync::Arc;

    use libsql::Value;
    use tpv_application::ports::configuracion::ConfiguracionRepository;

    use super::SqliteConfiguracionRepository;
    use crate::db::{Db, Reader};

    async fn abrir_db() -> (Arc<Db>, std::path::PathBuf) {
        let dir = crate::test_temp::dir_temporal("configuracion");
        let path = dir.join("data.db");
        let db = Db::open(path.to_str().unwrap()).await.unwrap();
        (db, dir)
    }

    async fn ops_en_outbox(db: &Db) -> i64 {
        let g = db.read().await;
        let mut rows = g
            .query("SELECT COUNT(*) FROM _Sync_Outbox;", Vec::<Value>::new())
            .await
            .unwrap();
        match rows.next().await.unwrap().unwrap().get_value(0).unwrap() {
            Value::Integer(n) => n,
            _ => -1,
        }
    }

    #[tokio::test]
    async fn leer_los_ajustes_no_deja_nada_en_el_outbox() {
        let (db, dir) = abrir_db().await;
        let repo = SqliteConfiguracionRepository::new(db.clone());

        // Las tres filas existen desde la migración inicial: leerlas tiene que ser sólo leer.
        assert_eq!(ops_en_outbox(&db).await, 0, "el arranque ya deja outbox");

        for _ in 0..3 {
            repo.get_business().await.unwrap();
            repo.get_ticket().await.unwrap();
            repo.get_contact().await.unwrap();
        }

        assert_eq!(
            ops_en_outbox(&db).await,
            0,
            "nueve lecturas de ajustes han generado operaciones para replicar"
        );

        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn guardar_ajustes_si_genera_exactamente_una_operacion() {
        // El reverso: quitar los `ensure` no puede haber dejado mudas las escrituras de verdad.
        let (db, dir) = abrir_db().await;
        let repo = SqliteConfiguracionRepository::new(db.clone());

        repo.patch_business(&serde_json::json!({ "business_name": "Bar Nuevo" }))
            .await
            .unwrap();

        assert_eq!(
            ops_en_outbox(&db).await,
            1,
            "un guardado son sus sentencias, ni más ni menos"
        );
        assert_eq!(repo.get_business().await.unwrap().business_name, "Bar Nuevo");

        let _ = std::fs::remove_dir_all(dir);
    }
}
