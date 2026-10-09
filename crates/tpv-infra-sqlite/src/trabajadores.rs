//! Adaptador SQLite del repositorio de **trabajadores / horarios**. Local-First:
//! sin Applied_Operations, sin Outbox, sin idempotencia por op_id ni rama remota.

use crate::util::new_id;
use crate::consultas::{db_err};
use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;

use async_trait::async_trait;
use chrono::{Datelike, Duration, Local, NaiveDate, Weekday};
use libsql::Value;

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::field_cipher::FieldCipher;
use tpv_application::ports::trabajadores::TrabajadoresRepository;
use tpv_contracts::trabajadores::{
    AsignacionRow, RolRow, TrabajadorDetailRow, TrabajadorRow, TurnoRow,
};
use tpv_domain::login::hash_pin;
use tpv_domain::trabajadores::{
    limpiar_opcional, AsignacionCambios, AsignacionNueva, TrabajadorCambios, TrabajadorNuevo,
};

use crate::db::{Db, Reader, Writer};
use crate::mapping::{v_i64, v_string};

/// RI-62: ¿este cambio deja el negocio sin ningún administrador activo? Sí cuando el usuario que se
/// edita es administrador activo, deja de serlo (otro rol, o `Inactivo`) y no queda ningún otro.
/// Con cero administradores se cierran Configuración, Cuentas, los cierres, Fiscal y el alta de
/// personal, y no hay salida desde la aplicación: la recuperación del PIN por correo es para un
/// administrador (LOGIN-07) y la pantalla de recuperación sólo sale con cero usuarios.
///
/// Sólo se mira el paso de «hay» a «no hay»: si ya no había ninguno (una base rara), editar a
/// cualquier otro sigue funcionando. Mismo SQL en el worker (`dejariaSinAdministrador`).
///
/// ?1 = ID_Usuario editado, ?2 = su ID_Rol nuevo, ?3 = su Estado nuevo.
const SQL_DEJARIA_SIN_ADMINISTRADOR: &str = r#"
    SELECT
      EXISTS (
        SELECT 1 FROM Usuarios u JOIN Roles r ON r.ID_Rol = u.ID_Rol
        WHERE u.ID_Usuario = ?1 AND u.Estado = 'Activo' AND r.Nombre_Rol = 'Administrador'
      )
      AND NOT (
        ?3 = 'Activo'
        AND EXISTS (SELECT 1 FROM Roles WHERE ID_Rol = ?2 AND Nombre_Rol = 'Administrador')
      )
      AND NOT EXISTS (
        SELECT 1 FROM Usuarios u JOIN Roles r ON r.ID_Rol = u.ID_Rol
        WHERE u.ID_Usuario <> ?1 AND u.Estado = 'Activo' AND r.Nombre_Rol = 'Administrador'
      );
"#;

const MSG_ULTIMO_ADMINISTRADOR: &str = "No se puede dejar el negocio sin ningún administrador \
     activo. Da antes el rol de Administrador a otra persona.";

async fn dejaria_sin_administrador<C: Reader>(
    conn: &C,
    cambios: &TrabajadorCambios,
) -> AppResult<bool> {
    let mut rows = conn
        .query(
            SQL_DEJARIA_SIN_ADMINISTRADOR,
            vec![
                Value::Text(cambios.id_usuario.clone()),
                Value::Text(cambios.id_rol.clone()),
                Value::Text(cambios.estado.clone()),
            ],
        )
        .await
        .map_err(db_err)?;
    Ok(match rows.next().await.map_err(db_err)? {
        Some(row) => v_i64(row.get_value(0).map_err(db_err)?).unwrap_or(0) != 0,
        None => false,
    })
}

pub struct SqliteTrabajadoresRepository {
    db: Arc<Db>,
    /// TRAB-03: cifra DNI/IBAN/nº de la Seguridad Social antes de que el valor entre en la
    /// sentencia. Como el outbox captura la sentencia YA construida, la replicación a la nube
    /// se lleva el texto cifrado sin enterarse: no hay que tocar el sync.
    ///
    /// `None` = no hay clave en este dispositivo (instalación aún sin activar, o worker
    /// antiguo que no la entrega). En ese caso se opera en claro, como antes: quedarse sin
    /// poder dar de alta a un trabajador sería peor que operar sin cifrado.
    cipher: Option<Arc<dyn FieldCipher>>,
}

impl SqliteTrabajadoresRepository {
    pub fn new(db: Arc<Db>) -> Self {
        Self { db, cipher: None }
    }

    pub fn with_cipher(db: Arc<Db>, cipher: Option<Arc<dyn FieldCipher>>) -> Self {
        Self { db, cipher }
    }

    /// Claro -> guardado. Sin cifrador, pasa de largo.
    fn cifrar(&self, v: Option<String>) -> AppResult<Option<String>> {
        match &self.cipher {
            Some(c) => c.encrypt(v.as_deref()),
            None => Ok(v),
        }
    }

    /// Guardado -> claro. Sin cifrador, pasa de largo (y con cifrador, un valor sin prefijo
    /// también: son las filas que el job de migración todavía no ha convertido).
    fn descifrar(&self, v: Option<String>) -> AppResult<Option<String>> {
        match &self.cipher {
            Some(c) => c.decrypt(v.as_deref()),
            None => Ok(v),
        }
    }

    /// TRAB-03: cifra la PII del personal que todavía está en claro y devuelve cuántas filas
    /// convirtió. Lo llama el job `cifrado_pii`.
    ///
    /// El UPDATE va por el camino normal de escritura (`execute`), no por `raw()`, **a
    /// propósito**: así lo captura el outbox y la nube recibe también el texto cifrado. Si
    /// fuera por `raw()`, el dato quedaría cifrado en local y seguiría legible en Turso, que
    /// es justo lo que se quiere evitar.
    ///
    /// Es idempotente: una fila ya cifrada no entra en la selección, y aunque entrase, cifrar
    /// dos veces devuelve el mismo valor.
    pub async fn cifrar_pii_pendiente(&self) -> AppResult<usize> {
        let Some(cipher) = self.cipher.clone() else {
            // Sin clave no hay nada que hacer: el dispositivo aún no se ha activado.
            return Ok(0);
        };

        // El personal de un negocio son decenas de filas: se leen todas y se filtra en Rust,
        // que evita repetir el prefijo de versión dentro del SQL.
        /// Una fila de PII del personal tal y como sale de la tabla: el id y las tres columnas
        /// cifradas (`DNI`, `IBAN`, `Numero_Seguridad_Social`), cualquiera de ellas ausente.
        type FilaPii = (String, Option<String>, Option<String>, Option<String>);

        let pendientes: Vec<FilaPii> = {
            let db = self.db.read().await;
            let mut rows = db
                .query(
                    r#"
                    SELECT ID_Trabajador, DNI, IBAN, Numero_Seguridad_Social
                    FROM Trabajadores;
                    "#,
                    vec![],
                )
                .await
                .map_err(db_err)?;

            let mut out = Vec::new();
            while let Some(row) = rows.next().await.map_err(db_err)? {
                let id = v_string(row.get_value(0).map_err(db_err)?).unwrap_or_default();
                let dni = v_string(row.get_value(1).map_err(db_err)?);
                let iban = v_string(row.get_value(2).map_err(db_err)?);
                let nss = v_string(row.get_value(3).map_err(db_err)?);

                let falta = [&dni, &iban, &nss].into_iter().flatten().any(|v| {
                    !v.is_empty() && !cipher.is_encrypted(v)
                });

                if falta && !id.is_empty() {
                    out.push((id, dni, iban, nss));
                }
            }
            out
        };

        if pendientes.is_empty() {
            return Ok(0);
        }

        let db = self.db.write().await;
        let mut convertidas = 0usize;

        for (id, dni, iban, nss) in pendientes {
            db.execute(
                r#"
                UPDATE Trabajadores
                   SET DNI = ?1, IBAN = ?2, Numero_Seguridad_Social = ?3
                 WHERE ID_Trabajador = ?4;
                "#,
                vec![
                    opt_text(cipher.encrypt(dni.as_deref())?),
                    opt_text(cipher.encrypt(iban.as_deref())?),
                    opt_text(cipher.encrypt(nss.as_deref())?),
                    Value::Text(id),
                ],
            )
            .await
            .map_err(db_err)?;

            convertidas += 1;
        }

        Ok(convertidas)
    }
}

fn weekday_1_to_7_from_ymd(ymd: &str) -> Option<i64> {
    let d = NaiveDate::parse_from_str(ymd, "%Y-%m-%d").ok()?;
    let n = match d.weekday() {
        Weekday::Mon => 1,
        Weekday::Tue => 2,
        Weekday::Wed => 3,
        Weekday::Thu => 4,
        Weekday::Fri => 5,
        Weekday::Sat => 6,
        Weekday::Sun => 7,
    };
    Some(n)
}

fn hhmm_opt(t: &Option<String>) -> String {
    t.as_deref().unwrap_or("").chars().take(5).collect()
}

fn opt_text(o: Option<String>) -> Value {
    o.map(Value::Text).unwrap_or(Value::Null)
}

#[async_trait]
impl TrabajadoresRepository for SqliteTrabajadoresRepository {
    async fn get_roles(&self) -> AppResult<Vec<RolRow>> {
        let db = self.db.read().await;

        let sql = r#"
          SELECT ID_Rol, Nombre_Rol
          FROM Roles
          ORDER BY Nombre_Rol ASC;
        "#;

        let mut rows = db.query(sql, ()).await.map_err(db_err)?;
        let mut out: Vec<RolRow> = vec![];

        while let Some(row) = rows.next().await.map_err(db_err)? {
            out.push(RolRow {
                id_rol: v_string(row.get_value(0).map_err(db_err)?).unwrap_or_default(),
                nombre_rol: v_string(row.get_value(1).map_err(db_err)?).unwrap_or_default(),
            });
        }

        Ok(out)
    }

    async fn get_all(&self) -> AppResult<Vec<TrabajadorRow>> {
        let db = self.db.read().await;

        let sql = r#"
          SELECT
            t.ID_Trabajador,
            t.ID_Usuario,
            t.Telefono,
            t.Puesto,
            u.Nombre,
            u.Apellido,
            u.Email,
            u.Estado,
            r.Nombre_Rol
          FROM Trabajadores t
          JOIN Usuarios u ON u.ID_Usuario = t.ID_Usuario
          JOIN Roles r ON r.ID_Rol = u.ID_Rol
          ORDER BY u.Nombre ASC;
        "#;

        let mut rows = db.query(sql, ()).await.map_err(db_err)?;
        let mut out: Vec<TrabajadorRow> = vec![];

        while let Some(row) = rows.next().await.map_err(db_err)? {
            out.push(TrabajadorRow {
                id_trabajador: v_string(row.get_value(0).map_err(db_err)?).unwrap_or_default(),
                id_usuario: v_string(row.get_value(1).map_err(db_err)?).unwrap_or_default(),
                telefono: v_string(row.get_value(2).map_err(db_err)?),
                puesto: v_string(row.get_value(3).map_err(db_err)?),
                nombre: v_string(row.get_value(4).map_err(db_err)?).unwrap_or_default(),
                apellido: v_string(row.get_value(5).map_err(db_err)?),
                email: v_string(row.get_value(6).map_err(db_err)?).unwrap_or_default(),
                estado: v_string(row.get_value(7).map_err(db_err)?)
                    .unwrap_or_else(|| "Activo".into()),
                nombre_rol: v_string(row.get_value(8).map_err(db_err)?).unwrap_or_default(),
            });
        }

        Ok(out)
    }

    async fn get_detail(&self, id_trabajador: &str) -> AppResult<Option<TrabajadorDetailRow>> {
        let db = self.db.read().await;

        if id_trabajador.trim().is_empty() {
            return Err(AppError::validation("id_trabajador required"));
        }

        let mut rows = db
            .query(
                r#"
                SELECT
                  t.ID_Trabajador,
                  t.ID_Usuario,
                  u.ID_Rol,
                  u.Email,
                  u.Nombre,
                  u.Apellido,
                  u.Estado,
                  t.DNI,
                  t.Telefono,
                  t.Puesto,
                  t.IBAN,
                  t.Numero_Seguridad_Social,
                  t.Fecha_Inicio_Contrato,
                  t.Fecha_Fin_Contrato
                FROM Trabajadores t
                JOIN Usuarios u ON u.ID_Usuario = t.ID_Usuario
                WHERE t.ID_Trabajador = ?1
                LIMIT 1;
                "#,
                vec![Value::Text(id_trabajador.to_string())],
            )
            .await
            .map_err(db_err)?;

        let Some(row) = rows.next().await.map_err(db_err)? else {
            return Ok(None);
        };

        Ok(Some(TrabajadorDetailRow {
            id_trabajador: v_string(row.get_value(0).map_err(db_err)?).unwrap_or_default(),
            id_usuario: v_string(row.get_value(1).map_err(db_err)?).unwrap_or_default(),
            id_rol: v_string(row.get_value(2).map_err(db_err)?).unwrap_or_default(),
            email: v_string(row.get_value(3).map_err(db_err)?).unwrap_or_default(),
            nombre: v_string(row.get_value(4).map_err(db_err)?).unwrap_or_default(),
            apellido: v_string(row.get_value(5).map_err(db_err)?),
            estado: v_string(row.get_value(6).map_err(db_err)?)
                .unwrap_or_else(|| "Activo".into()),
            // TRAB-03: las tres columnas sensibles vienen cifradas de la BD.
            dni: self.descifrar(v_string(row.get_value(7).map_err(db_err)?))?,
            telefono: v_string(row.get_value(8).map_err(db_err)?),
            puesto: v_string(row.get_value(9).map_err(db_err)?),
            iban: self.descifrar(v_string(row.get_value(10).map_err(db_err)?))?,
            numero_seguridad_social: self
                .descifrar(v_string(row.get_value(11).map_err(db_err)?))?,
            fecha_inicio_contrato: v_string(row.get_value(12).map_err(db_err)?),
            fecha_fin_contrato: v_string(row.get_value(13).map_err(db_err)?),
        }))
    }

    async fn get_id_by_usuario(&self, id_usuario: &str) -> AppResult<Option<String>> {
        let db = self.db.read().await;

        if id_usuario.trim().is_empty() {
            return Ok(None);
        }

        let mut rows = db
            .query(
                r#"
                SELECT ID_Trabajador
                FROM Trabajadores
                WHERE ID_Usuario = ?1
                LIMIT 1;
                "#,
                vec![Value::Text(id_usuario.to_string())],
            )
            .await
            .map_err(db_err)?;

        let Some(row) = rows.next().await.map_err(db_err)? else {
            return Ok(None);
        };

        let id_trab = v_string(row.get_value(0).map_err(db_err)?).unwrap_or_default();

        if id_trab.trim().is_empty() {
            Ok(None)
        } else {
            Ok(Some(id_trab))
        }
    }

    async fn turnos_get_all(&self) -> AppResult<Vec<TurnoRow>> {
        let db = self.db.read().await;

        let sql = r#"
          SELECT ID_Turno, Nombre_Turno
          FROM Turnos
          ORDER BY
            CASE WHEN Nombre_Turno='LIBRE' THEN 0 ELSE 1 END,
            Nombre_Turno ASC;
        "#;

        let mut rows = db.query(sql, ()).await.map_err(db_err)?;
        let mut out: Vec<TurnoRow> = vec![];

        while let Some(row) = rows.next().await.map_err(db_err)? {
            out.push(TurnoRow {
                id_turno: v_string(row.get_value(0).map_err(db_err)?).unwrap_or_default(),
                nombre_turno: v_string(row.get_value(1).map_err(db_err)?).unwrap_or_default(),
            });
        }

        Ok(out)
    }

    async fn get_asignaciones_semana(&self, fecha_lunes: String) -> AppResult<Vec<AsignacionRow>> {
        let db = self.db.read().await;

        let sql = r#"
          SELECT
            a.ID_Asignacion,
            a.ID_Trabajador,
            a.Fecha,
            a.ID_Turno,
            a.Area,
            a.Hora_Inicio,
            a.Hora_Fin,
            a.Notas,
            t.Nombre_Turno,
            a.ID_Grupo
          FROM Asignacion_Turnos a
          JOIN Turnos t ON t.ID_Turno = a.ID_Turno
          WHERE a.Fecha >= date(?1)
            AND a.Fecha < date(?1, '+7 day')
          ORDER BY a.Fecha ASC, a.ID_Trabajador ASC, a.Hora_Inicio ASC;
        "#;

        let mut rows = db
            .query(sql, vec![Value::Text(fecha_lunes.clone())])
            .await
            .map_err(db_err)?;

        let mut out: Vec<AsignacionRow> = vec![];

        while let Some(row) = rows.next().await.map_err(db_err)? {
            out.push(AsignacionRow {
                id_grupo: v_string(row.get_value(9).map_err(db_err)?),
                id_asignacion: v_string(row.get_value(0).map_err(db_err)?).unwrap_or_default(),
                id_trabajador: v_string(row.get_value(1).map_err(db_err)?).unwrap_or_default(),
                fecha: v_string(row.get_value(2).map_err(db_err)?).unwrap_or_default(),
                id_turno: v_string(row.get_value(3).map_err(db_err)?).unwrap_or_default(),
                area: v_string(row.get_value(4).map_err(db_err)?).unwrap_or_else(|| "Sala".into()),
                hora_inicio: v_string(row.get_value(5).map_err(db_err)?),
                hora_fin: v_string(row.get_value(6).map_err(db_err)?),
                notas: v_string(row.get_value(7).map_err(db_err)?),
                nombre_turno: v_string(row.get_value(8).map_err(db_err)?).unwrap_or_default(),
            });
        }

        let req_monday = NaiveDate::parse_from_str(&fecha_lunes, "%Y-%m-%d")
            .map_err(|_| AppError::validation("fecha_lunes invalida (esperado YYYY-MM-DD)"))?;

        let today = Local::now().date_naive();
        let weekday_today = today.weekday().number_from_monday() as i64;
        let current_monday = today - Duration::days(weekday_today - 1);

        let should_fill_defaults = req_monday >= current_monday;

        if should_fill_defaults {
            let mut real_cells: HashSet<(String, String)> = HashSet::new();

            for a in out.iter() {
                real_cells.insert((a.id_trabajador.clone(), a.fecha.clone()));
            }

            let mut drows = db
                .query(
                    r#"
                    SELECT
                      h.ID_Trabajador,
                      h.Weekday,
                      h.Orden,
                      h.ID_Turno,
                      h.Area,
                      h.Hora_Inicio,
                      h.Hora_Fin,
                      h.Notas,
                      t.Nombre_Turno
                    FROM Horario_Predeterminado h
                    JOIN Turnos t ON t.ID_Turno = h.ID_Turno
                    ORDER BY h.ID_Trabajador, h.Weekday, h.Orden;
                    "#,
                    (),
                )
                .await
                .map_err(db_err)?;

            #[derive(Clone)]
            struct DefItem {
                id_turno: String,
                area: String,
                hora_inicio: Option<String>,
                hora_fin: Option<String>,
                notas: Option<String>,
                nombre_turno: String,
            }

            let mut defs: BTreeMap<(String, i64), Vec<DefItem>> = BTreeMap::new();

            while let Some(r) = drows.next().await.map_err(db_err)? {
                let id_trab = v_string(r.get_value(0).map_err(db_err)?).unwrap_or_default();
                let weekday = v_i64(r.get_value(1).map_err(db_err)?).unwrap_or(0);

                let id_turno = v_string(r.get_value(3).map_err(db_err)?).unwrap_or_default();
                let area =
                    v_string(r.get_value(4).map_err(db_err)?).unwrap_or_else(|| "Sala".into());
                let hora_inicio = v_string(r.get_value(5).map_err(db_err)?);
                let hora_fin = v_string(r.get_value(6).map_err(db_err)?);
                let notas = v_string(r.get_value(7).map_err(db_err)?);
                let nombre_turno =
                    v_string(r.get_value(8).map_err(db_err)?).unwrap_or_default();

                if id_trab.is_empty() || !(1..=7).contains(&weekday) || id_turno.is_empty() {
                    continue;
                }

                defs.entry((id_trab, weekday)).or_default().push(DefItem {
                    id_turno,
                    area,
                    hora_inicio,
                    hora_fin,
                    notas,
                    nombre_turno,
                });
            }

            for day_offset in 0..7 {
                let date = req_monday + Duration::days(day_offset);
                let ymd = date.format("%Y-%m-%d").to_string();
                let wd = day_offset + 1;

                for ((id_trab, weekday), list) in defs.iter() {
                    if *weekday != wd {
                        continue;
                    }

                    if real_cells.contains(&(id_trab.clone(), ymd.clone())) {
                        continue;
                    }

                    for it in list.iter() {
                        out.push(AsignacionRow {
                            id_grupo: None,
                            // Cadena vacía = fila de horario predeterminado (no es una
                            // asignación real persistida). Antes era id 0.
                            id_asignacion: String::new(),
                            id_trabajador: id_trab.clone(),
                            fecha: ymd.clone(),
                            id_turno: it.id_turno.clone(),
                            area: it.area.clone(),
                            hora_inicio: it.hora_inicio.clone(),
                            hora_fin: it.hora_fin.clone(),
                            notas: it.notas.clone(),
                            nombre_turno: it.nombre_turno.clone(),
                        });
                    }
                }
            }

            out.sort_by(|a, b| {
                a.fecha
                    .cmp(&b.fecha)
                    .then(a.id_trabajador.cmp(&b.id_trabajador))
                    .then(hhmm_opt(&a.hora_inicio).cmp(&hhmm_opt(&b.hora_inicio)))
            });
        }

        Ok(out)
    }

    async fn create_trabajador(&self, data: TrabajadorNuevo) -> AppResult<bool> {
        // RI-63: el PIN llega en claro y el hash se hace aquí, así que no se guarda un hash que
        // venga de fuera (con las iteraciones que sea). Antes de coger el cerrojo: PBKDF2 tarda.
        let password_hash = hash_pin(&data.pin).map_err(AppError::validation)?;
        let db = self.db.write().await;

        let res: AppResult<bool> = db.transaccion(async {
            // UUIDv7 explícitos (la BD ya no autoincrementa).
            let id_usuario = new_id();
            db.execute(
                r#"
                INSERT INTO Usuarios (
                  ID_Usuario, ID_Rol, Email, Password_Hash, Nombre, Apellido, Estado
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7);
                "#,
                vec![
                    Value::Text(id_usuario.clone()),
                    Value::Text(data.id_rol.clone()),
                    Value::Text(data.email.clone()),
                    Value::Text(password_hash),
                    Value::Text(data.nombre.clone()),
                    opt_text(data.apellido.clone()),
                    Value::Text(data.estado.clone()),
                ],
            )
            .await
            .map_err(db_err)?;

            db.execute(
                r#"
                INSERT INTO Trabajadores (
                  ID_Trabajador, ID_Usuario, DNI, Telefono, Puesto, IBAN,
                  Numero_Seguridad_Social, Fecha_Inicio_Contrato, Fecha_Fin_Contrato
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9);
                "#,
                vec![
                    Value::Text(new_id()),
                    Value::Text(id_usuario.clone()),
                    opt_text(self.cifrar(data.dni.clone())?),
                    opt_text(data.telefono.clone()),
                    opt_text(data.puesto.clone()),
                    opt_text(self.cifrar(data.iban.clone())?),
                    opt_text(self.cifrar(data.numero_seguridad_social.clone())?),
                    opt_text(data.fecha_inicio_contrato.clone()),
                    opt_text(data.fecha_fin_contrato.clone()),
                ],
            )
            .await
            .map_err(db_err)?;

            Ok(true)
        }).await;

        res
    }

    async fn update_trabajador(
        &self,
        id_trabajador: &str,
        cambios: TrabajadorCambios,
    ) -> AppResult<bool> {
        // RI-63: como en el alta, el hash del PIN nuevo se hace aquí y antes del cerrojo.
        let password_hash = match cambios.pin.as_deref() {
            Some(pin) => Some(hash_pin(pin).map_err(AppError::validation)?),
            None => None,
        };
        let db = self.db.write().await;

        let res: AppResult<bool> = db.transaccion(async {
            // RI-62: dentro de la transacción y con el cerrojo de escritura, así que nadie puede
            // degradar al otro administrador entre la comprobación y el UPDATE.
            if dejaria_sin_administrador(&db, &cambios).await? {
                return Err(AppError::conflict(MSG_ULTIMO_ADMINISTRADOR));
            }

            // RI-63: un id que no existe era un `Ok(true)` sin tocar nada.
            let sin_fila = || AppError::not_found("Ese trabajador ya no existe. Actualiza la lista.");

            // Datos de cuenta (Usuarios). El PIN sólo se actualiza si llega uno nuevo.
            let usuarios = if let Some(hash) = password_hash {
                db.execute(
                    r#"
                    UPDATE Usuarios
                       SET ID_Rol = ?1, Email = ?2, Nombre = ?3, Apellido = ?4,
                           Estado = ?5, Password_Hash = ?6
                     WHERE ID_Usuario = ?7;
                    "#,
                    vec![
                        Value::Text(cambios.id_rol.clone()),
                        Value::Text(cambios.email.clone()),
                        Value::Text(cambios.nombre.clone()),
                        opt_text(cambios.apellido.clone()),
                        Value::Text(cambios.estado.clone()),
                        Value::Text(hash),
                        Value::Text(cambios.id_usuario.clone()),
                    ],
                )
                .await
                .map_err(db_err)?
            } else {
                db.execute(
                    r#"
                    UPDATE Usuarios
                       SET ID_Rol = ?1, Email = ?2, Nombre = ?3, Apellido = ?4, Estado = ?5
                     WHERE ID_Usuario = ?6;
                    "#,
                    vec![
                        Value::Text(cambios.id_rol.clone()),
                        Value::Text(cambios.email.clone()),
                        Value::Text(cambios.nombre.clone()),
                        opt_text(cambios.apellido.clone()),
                        Value::Text(cambios.estado.clone()),
                        Value::Text(cambios.id_usuario.clone()),
                    ],
                )
                .await
                .map_err(db_err)?
            };
            if usuarios == 0 {
                return Err(sin_fila());
            }

            // Datos laborales (Trabajadores).
            let trabajadores = db.execute(
                r#"
                UPDATE Trabajadores
                   SET DNI = ?1, Telefono = ?2, Puesto = ?3, IBAN = ?4,
                       Numero_Seguridad_Social = ?5,
                       Fecha_Inicio_Contrato = ?6, Fecha_Fin_Contrato = ?7
                 WHERE ID_Trabajador = ?8;
                "#,
                vec![
                    opt_text(self.cifrar(cambios.dni.clone())?),
                    opt_text(cambios.telefono.clone()),
                    opt_text(cambios.puesto.clone()),
                    opt_text(self.cifrar(cambios.iban.clone())?),
                    opt_text(self.cifrar(cambios.numero_seguridad_social.clone())?),
                    opt_text(cambios.fecha_inicio_contrato.clone()),
                    opt_text(cambios.fecha_fin_contrato.clone()),
                    Value::Text(id_trabajador.to_string()),
                ],
            )
            .await
            .map_err(db_err)?;
            if trabajadores == 0 {
                return Err(sin_fila());
            }

            Ok(true)
        }).await;

        res
    }

    async fn guardar_asignacion(&self, id_asignacion: Option<String>, tramos: Vec<AsignacionNueva>) -> AppResult<bool> {
        use tpv_domain::trabajadores::{intervalo_horario, validar_tramos};
        validar_tramos(&tramos).map_err(AppError::validation)?;
        let db = self.db.write().await;
        let primero = &tramos[0];
        let mut ids = Vec::new();
        let grupo = if let Some(id) = id_asignacion {
            let mut rows = db.query("SELECT COALESCE(ID_Grupo, ID_Asignacion), ID_Trabajador, Fecha FROM Asignacion_Turnos WHERE ID_Asignacion = ?1;", vec![Value::Text(id)]).await.map_err(db_err)?;
            let fila = rows.next().await.map_err(db_err)?.ok_or_else(|| AppError::not_found("Asignación no encontrada"))?;
            if v_string(fila.get_value(1).map_err(db_err)?).as_deref() != Some(&primero.id_trabajador)
                || v_string(fila.get_value(2).map_err(db_err)?).as_deref() != Some(&primero.fecha) {
                return Err(AppError::validation("No se puede mover un horario a otro trabajador o jornada"));
            }
            let grupo = v_string(fila.get_value(0).map_err(db_err)?).unwrap_or_default();
            let mut miembros = db.query("SELECT ID_Asignacion FROM Asignacion_Turnos WHERE COALESCE(ID_Grupo, ID_Asignacion) = ?1 ORDER BY Hora_Inicio, ID_Asignacion;", vec![Value::Text(grupo.clone())]).await.map_err(db_err)?;
            while let Some(fila) = miembros.next().await.map_err(db_err)? { ids.push(v_string(fila.get_value(0).map_err(db_err)?).unwrap_or_default()); }
            grupo
        } else { new_id() };
        let nuevos: Vec<_> = tramos.iter().filter_map(|t| intervalo_horario(&t.fecha, t.hora_inicio.as_deref(), t.hora_fin.as_deref()).transpose()).collect::<Result<_, _>>().map_err(AppError::validation)?;
        let mut existentes = db.query("SELECT Fecha, Hora_Inicio, Hora_Fin FROM Asignacion_Turnos WHERE ID_Trabajador = ?1 AND Fecha BETWEEN date(?2, '-1 day') AND date(?2, '+1 day') AND COALESCE(ID_Grupo, ID_Asignacion) <> ?3;", vec![Value::Text(primero.id_trabajador.clone()), Value::Text(primero.fecha.clone()), Value::Text(grupo.clone())]).await.map_err(db_err)?;
        while let Some(fila) = existentes.next().await.map_err(db_err)? {
            let fecha = v_string(fila.get_value(0).map_err(db_err)?).unwrap_or_default();
            let inicio = v_string(fila.get_value(1).map_err(db_err)?);
            let fin = v_string(fila.get_value(2).map_err(db_err)?);
            if let Some(intervalo) = intervalo_horario(&fecha, inicio.as_deref(), fin.as_deref()).map_err(AppError::validation)? {
                if nuevos.iter().any(|nuevo| nuevo.solapa(&intervalo)) { return Err(AppError::conflict("Ese horario se solapa con otro tramo del trabajador. Corrige las horas antes de guardar.")); }
            }
        }
        let resultado: AppResult<bool> = db.transaccion(async {
            db.execute("DELETE FROM Asignacion_Turnos WHERE COALESCE(ID_Grupo, ID_Asignacion) = ?1;", vec![Value::Text(grupo.clone())]).await.map_err(db_err)?;
            for (indice, tramo) in tramos.into_iter().enumerate() {
                let id = ids.get(indice).cloned().unwrap_or_else(new_id);
                db.execute("INSERT INTO Asignacion_Turnos (ID_Asignacion, ID_Grupo, ID_Trabajador, Fecha, ID_Turno, Area, Hora_Inicio, Hora_Fin, Notas) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9);", vec![Value::Text(id), Value::Text(grupo.clone()), Value::Text(tramo.id_trabajador), Value::Text(tramo.fecha), Value::Text(tramo.id_turno), Value::Text(tramo.area), opt_text(tramo.hora_inicio), opt_text(tramo.hora_fin), opt_text(tramo.notas)]).await.map_err(db_err)?;
            }
            Ok(true)
        }).await;

        resultado
    }

    async fn create_asignacion(&self, data: AsignacionNueva) -> AppResult<bool> {
        let db = self.db.write().await;

        // TRAB-04: no permitir asignar el mismo turno al mismo trabajador el mismo día dos veces.
        // (El área puede diferir; el duplicado que se bloquea es trabajador+fecha+turno.) El lock de
        // escritura serializa el check-then-insert, así que no hace falta transacción explícita.
        let mut dup = db
            .query(
                "SELECT 1 FROM Asignacion_Turnos WHERE ID_Trabajador = ?1 AND Fecha = date(?2) AND ID_Turno = ?3 LIMIT 1;",
                vec![
                    Value::Text(data.id_trabajador.clone()),
                    Value::Text(data.fecha.clone()),
                    Value::Text(data.id_turno.clone()),
                ],
            )
            .await
            .map_err(db_err)?;
        if dup.next().await.map_err(db_err)?.is_some() {
            return Err(AppError::conflict(
                "Ese trabajador ya tiene ese turno asignado ese día.",
            ));
        }

        db.execute(
            r#"
            INSERT INTO Asignacion_Turnos (
              ID_Asignacion,
              ID_Trabajador,
              Fecha,
              ID_Turno,
              Area,
              Hora_Inicio,
              Hora_Fin,
              Notas
            )
            VALUES (
              ?1,
              ?2,
              date(?3),
              ?4,
              ?5,
              ?6,
              ?7,
              ?8
            );
            "#,
            vec![
                Value::Text(new_id()),
                Value::Text(data.id_trabajador.clone()),
                Value::Text(data.fecha.clone()),
                Value::Text(data.id_turno.clone()),
                Value::Text(data.area.clone()),
                opt_text(data.hora_inicio.clone()),
                opt_text(data.hora_fin.clone()),
                opt_text(data.notas.clone()),
            ],
        )
        .await
        .map_err(db_err)?;

        Ok(true)
    }

    async fn update_asignacion(
        &self,
        id_asignacion: &str,
        cambios: AsignacionCambios,
    ) -> AppResult<bool> {
        let db = self.db.write().await;

        let mut miembros = db.query("SELECT COUNT(*) FROM Asignacion_Turnos WHERE COALESCE(ID_Grupo, ID_Asignacion) = (SELECT COALESCE(ID_Grupo, ID_Asignacion) FROM Asignacion_Turnos WHERE ID_Asignacion = ?1);", vec![Value::Text(id_asignacion.to_owned())]).await.map_err(db_err)?;
        if let Some(fila) = miembros.next().await.map_err(db_err)? {
            if v_i64(fila.get_value(0).map_err(db_err)?).unwrap_or(0) > 1 {
                return Err(AppError::conflict("Edita los dos tramos del horario como un conjunto."));
            }
        }

        let affected = db
            .execute(
                r#"
                UPDATE Asignacion_Turnos
                SET
                  ID_Turno = ?2,
                  Area = ?3,
                  Hora_Inicio = ?4,
                  Hora_Fin = ?5,
                  Notas = ?6
                WHERE ID_Asignacion = ?1;
                "#,
                vec![
                    Value::Text(id_asignacion.to_string()),
                    Value::Text(cambios.id_turno.clone()),
                    Value::Text(cambios.area.clone()),
                    opt_text(cambios.hora_inicio.clone()),
                    opt_text(cambios.hora_fin.clone()),
                    opt_text(cambios.notas.clone()),
                ],
            )
            .await
            .map_err(db_err)?;

        if affected == 0 {
            return Err(AppError::not_found("Asignación no encontrada"));
        }

        Ok(true)
    }

    async fn delete_asignacion(&self, id_asignacion: &str) -> AppResult<bool> {
        let db = self.db.write().await;

        let affected = db
            .execute(
                "DELETE FROM Asignacion_Turnos WHERE COALESCE(ID_Grupo, ID_Asignacion) = (SELECT COALESCE(ID_Grupo, ID_Asignacion) FROM Asignacion_Turnos WHERE ID_Asignacion = ?1);",
                vec![Value::Text(id_asignacion.to_string())],
            )
            .await
            .map_err(db_err)?;

        if affected == 0 {
            return Err(AppError::not_found("Asignación no encontrada"));
        }

        Ok(true)
    }

    async fn copy_semana(
        &self,
        from_monday: String,
        to_monday: String,
        overwrite: bool,
    ) -> AppResult<bool> {
        let db = self.db.write().await;

        // Desplazamiento en días entre la semana origen y la destino.
        let from_d = NaiveDate::parse_from_str(&from_monday, "%Y-%m-%d")
            .map_err(|_| AppError::validation("from_monday inválido (YYYY-MM-DD)"))?;
        let to_d = NaiveDate::parse_from_str(&to_monday, "%Y-%m-%d")
            .map_err(|_| AppError::validation("to_monday inválido (YYYY-MM-DD)"))?;
        let shift = (to_d - from_d).num_days();

        // Leemos las asignaciones origen en Rust para poder asignar a cada copia un UUIDv7
        // propio (un INSERT…SELECT no puede generar ids deterministas que sincronicen).
        struct SrcRow {
            id_grupo: Option<String>,
            id_trabajador: String,
            fecha: String,
            id_turno: String,
            area: String,
            hora_inicio: Option<String>,
            hora_fin: Option<String>,
            notas: Option<String>,
        }
        let mut srows = db
            .query(
                r#"
                SELECT ID_Trabajador, Fecha, ID_Turno, Area, Hora_Inicio, Hora_Fin, Notas, ID_Grupo
                FROM Asignacion_Turnos
                WHERE Fecha >= date(?1) AND Fecha < date(?1, '+7 day');
                "#,
                vec![Value::Text(from_monday.clone())],
            )
            .await
            .map_err(db_err)?;
        let mut origen: Vec<SrcRow> = Vec::new();
        while let Some(r) = srows.next().await.map_err(db_err)? {
            origen.push(SrcRow {
                id_grupo: v_string(r.get_value(7).map_err(db_err)?),
                id_trabajador: v_string(r.get_value(0).map_err(db_err)?).unwrap_or_default(),
                fecha: v_string(r.get_value(1).map_err(db_err)?).unwrap_or_default(),
                id_turno: v_string(r.get_value(2).map_err(db_err)?).unwrap_or_default(),
                area: v_string(r.get_value(3).map_err(db_err)?).unwrap_or_else(|| "Sala".into()),
                hora_inicio: v_string(r.get_value(4).map_err(db_err)?),
                hora_fin: v_string(r.get_value(5).map_err(db_err)?),
                notas: v_string(r.get_value(6).map_err(db_err)?),
            });
        }

        let res: AppResult<bool> = db.transaccion(async {
            if overwrite {
                db.execute(
                    r#"
                    DELETE FROM Asignacion_Turnos
                    WHERE Fecha >= date(?1)
                      AND Fecha < date(?1, '+7 day');
                    "#,
                    vec![Value::Text(to_monday.clone())],
                )
                .await
                .map_err(db_err)?;
            }

            let mut inserted = 0u64;
            let mut grupos: BTreeMap<String, String> = BTreeMap::new();
            for s in origen.iter() {
                let src_date = match NaiveDate::parse_from_str(&s.fecha, "%Y-%m-%d") {
                    Ok(d) => d,
                    Err(_) => continue,
                };
                let dst = (src_date + Duration::days(shift)).format("%Y-%m-%d").to_string();
                db.execute(
                    r#"
                    INSERT INTO Asignacion_Turnos (
                      ID_Asignacion, ID_Trabajador, Fecha, ID_Turno, Area, Hora_Inicio, Hora_Fin, Notas, ID_Grupo
                    )
                    VALUES (?1, ?2, date(?3), ?4, ?5, ?6, ?7, ?8, ?9);
                    "#,
                    vec![
                        Value::Text(new_id()),
                        Value::Text(s.id_trabajador.clone()),
                        Value::Text(dst),
                        Value::Text(s.id_turno.clone()),
                        Value::Text(s.area.clone()),
                        opt_text(s.hora_inicio.clone()),
                        opt_text(s.hora_fin.clone()),
                        opt_text(s.notas.clone()),
                        opt_text(s.id_grupo.as_ref().map(|g| grupos.entry(g.clone()).or_insert_with(new_id).clone())),
                    ],
                )
                .await
                .map_err(db_err)?;
                inserted += 1;
            }

            Ok(inserted > 0 || overwrite)
        }).await;

        res
    }

    async fn set_predeterminado_desde_semana(&self, fecha_lunes: String) -> AppResult<bool> {
        let db = self.db.write().await;

        // 1) Recolectar el mapa (id_trabajador, weekday) -> items, leyendo la semana.
        let sql = r#"
          SELECT
            a.ID_Trabajador,
            a.Fecha,
            a.ID_Turno,
            a.Area,
            a.Hora_Inicio,
            a.Hora_Fin,
            a.Notas
          FROM Asignacion_Turnos a
          WHERE a.Fecha >= date(?1)
            AND a.Fecha < date(?1, '+7 day')
          ORDER BY a.ID_Trabajador ASC, a.Fecha ASC, a.Hora_Inicio ASC;
        "#;

        let mut rows = db
            .query(sql, vec![Value::Text(fecha_lunes.clone())])
            .await
            .map_err(db_err)?;

        struct PredItem {
            id_turno: String,
            area: String,
            hora_inicio: Option<String>,
            hora_fin: Option<String>,
            notas: Option<String>,
        }

        let mut map: BTreeMap<(String, i64), Vec<PredItem>> = BTreeMap::new();

        while let Some(row) = rows.next().await.map_err(db_err)? {
            let id_trab = v_string(row.get_value(0).map_err(db_err)?).unwrap_or_default();
            let fecha = v_string(row.get_value(1).map_err(db_err)?).unwrap_or_default();
            let id_turno = v_string(row.get_value(2).map_err(db_err)?).unwrap_or_default();
            let area =
                v_string(row.get_value(3).map_err(db_err)?).unwrap_or_else(|| "Sala".into());
            let hora_inicio = v_string(row.get_value(4).map_err(db_err)?);
            let hora_fin = v_string(row.get_value(5).map_err(db_err)?);
            let notas = v_string(row.get_value(6).map_err(db_err)?);

            if id_trab.is_empty() || id_turno.is_empty() || fecha.trim().is_empty() {
                continue;
            }

            let Some(weekday) = weekday_1_to_7_from_ymd(&fecha) else {
                continue;
            };

            map.entry((id_trab, weekday)).or_default().push(PredItem {
                id_turno,
                area,
                hora_inicio,
                hora_fin,
                notas,
            });
        }

        if map.is_empty() {
            return Ok(false);
        }

        // 2) Aplicar el mapa: borra el predeterminado de cada trabajador implicado e inserta.
        let res: AppResult<bool> = db.transaccion(async {
            let mut trabajadores: Vec<String> = map.keys().map(|(t, _)| t.clone()).collect();
            trabajadores.sort_unstable();
            trabajadores.dedup();

            for id_trab in trabajadores.iter() {
                db.execute(
                    "DELETE FROM Horario_Predeterminado WHERE ID_Trabajador = ?1;",
                    vec![Value::Text(id_trab.clone())],
                )
                .await
                .map_err(db_err)?;
            }

            for ((id_trab, weekday), list) in map.into_iter() {
                for (idx, it) in list.into_iter().enumerate() {
                    let orden = (idx as i64) + 1;

                    db.execute(
                        r#"
                        INSERT INTO Horario_Predeterminado (
                          ID_Default,
                          ID_Trabajador,
                          Weekday,
                          Orden,
                          ID_Turno,
                          Area,
                          Hora_Inicio,
                          Hora_Fin,
                          Notas
                        )
                        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9);
                        "#,
                        vec![
                            Value::Text(new_id()),
                            Value::Text(id_trab.clone()),
                            Value::Integer(weekday),
                            Value::Integer(orden),
                            Value::Text(it.id_turno),
                            Value::Text(it.area),
                            opt_text(limpiar_opcional(it.hora_inicio)),
                            opt_text(limpiar_opcional(it.hora_fin)),
                            opt_text(limpiar_opcional(it.notas)),
                        ],
                    )
                    .await
                    .map_err(db_err)?;
                }
            }

            Ok(true)
        }).await;

        res
    }
}

#[cfg(test)]
mod tests_horarios_agrupados {
    use super::*;
    use tpv_contracts::trabajadores::{AsignacionGuardarInput, TramoHorarioInput};
    use tpv_application::use_cases::trabajadores::guardar_asignacion;

    async fn preparar() -> (Arc<Db>, SqliteTrabajadoresRepository) {
        let dir = crate::test_temp::dir_temporal("horarios_agrupados");
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        db.write().await.raw().execute_batch("INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre, Estado) SELECT 'u', ID_Rol, 'u@bar.test', 'h', 'Ana', 'Activo' FROM Roles WHERE Nombre_Rol = 'Administrador'; INSERT INTO Trabajadores (ID_Trabajador, ID_Usuario) VALUES ('t', 'u');").await.unwrap();
        let repo = SqliteTrabajadoresRepository::new(db.clone());
        (db, repo)
    }

    fn entrada(horas: &[(&str, &str)]) -> AsignacionGuardarInput {
        AsignacionGuardarInput { id_asignacion: None, id_trabajador: "t".into(), fecha: "2026-10-09".into(), id_turno: "00000000-0000-7000-8000-000000000102".into(), area: "Sala".into(), notas: None, tramos: horas.iter().map(|(i, f)| TramoHorarioInput { hora_inicio: (*i).into(), hora_fin: (*f).into() }).collect() }
    }

    #[tokio::test]
    async fn crear_editar_copiar_y_borrar_conserva_el_conjunto() {
        let (_db, repo) = preparar().await;
        guardar_asignacion(&repo, entrada(&[("09:00", "14:00"), ("17:00", "22:00")])).await.unwrap();
        let filas = repo.get_asignaciones_semana("2026-10-05".into()).await.unwrap();
        assert_eq!(filas.len(), 2);
        assert!(filas[0].id_grupo.is_some());
        assert_eq!(filas[0].id_grupo, filas[1].id_grupo);
        let mut cambio = entrada(&[("10:00", "15:00"), ("18:00", "23:00")]);
        cambio.id_asignacion = Some(filas[0].id_asignacion.clone());
        guardar_asignacion(&repo, cambio).await.unwrap();
        repo.copy_semana("2026-10-05".into(), "2026-10-12".into(), false).await.unwrap();
        let copia = repo.get_asignaciones_semana("2026-10-12".into()).await.unwrap();
        assert_eq!(copia.len(), 2);
        assert_eq!(copia[0].id_grupo, copia[1].id_grupo);
        assert_ne!(copia[0].id_grupo, filas[0].id_grupo);
        repo.delete_asignacion(&filas[0].id_asignacion).await.unwrap();
        assert!(repo.get_asignaciones_semana("2026-10-05".into()).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn fallo_del_segundo_tramo_revierte_las_filas_y_el_outbox() {
        let (db, repo) = preparar().await;
        guardar_asignacion(&repo, entrada(&[("09:00", "14:00"), ("17:00", "22:00")])).await.unwrap();
        let antes = repo.get_asignaciones_semana("2026-10-05".into()).await.unwrap();
        let outbox = async || {
            let guardia = db.read().await;
            let mut filas = guardia.query("SELECT COUNT(*) FROM _Sync_Outbox;", ()).await.unwrap();
            v_i64(filas.next().await.unwrap().unwrap().get_value(0).unwrap()).unwrap()
        };
        let cuenta = outbox().await;
        db.write().await.raw().execute_batch("CREATE TRIGGER fallo_segundo BEFORE INSERT ON Asignacion_Turnos WHEN NEW.Hora_Inicio = '18:00' BEGIN SELECT RAISE(ABORT, 'fallo_segundo'); END;").await.unwrap();
        let mut cambio = entrada(&[("10:00", "15:00"), ("18:00", "23:00")]);
        cambio.id_asignacion = Some(antes[0].id_asignacion.clone());
        assert!(guardar_asignacion(&repo, cambio).await.is_err());
        assert_eq!(serde_json::to_value(repo.get_asignaciones_semana("2026-10-05".into()).await.unwrap()).unwrap(), serde_json::to_value(antes).unwrap());
        assert_eq!(outbox().await, cuenta);
    }

    #[tokio::test]
    async fn impide_solapes_de_otras_asignaciones_incluido_el_dia_siguiente() {
        let (_db, repo) = preparar().await;
        guardar_asignacion(&repo, entrada(&[("22:00", "02:00")])).await.unwrap();
        let mut siguiente = entrada(&[("01:00", "03:00")]);
        siguiente.fecha = "2026-10-10".into();
        assert!(guardar_asignacion(&repo, siguiente).await.is_err());
        let mut siguiente = entrada(&[("02:00", "03:00")]);
        siguiente.fecha = "2026-10-10".into();
        guardar_asignacion(&repo, siguiente).await.unwrap();
    }
}

#[cfg(test)]
mod tests_edicion {
    //! El alta y la edición de una ficha: no pueden dejar el negocio sin ningún administrador
    //! activo (RI-62), y el PIN llega en claro y lo hashea el repositorio (RI-63).

    use std::sync::Arc;

    use libsql::Value;
    use tpv_application::error::AppError;
    use tpv_application::ports::trabajadores::TrabajadoresRepository;
    use tpv_domain::trabajadores::{TrabajadorCambios, TrabajadorNuevo};

    use super::SqliteTrabajadoresRepository;
    use crate::db::{Db, Reader};

    const ADMIN: &str = "00000000-0000-7000-8000-000000000001";
    const CAMARERO: &str = "00000000-0000-7000-8000-000000000002";

    struct Ficha {
        id_trabajador: String,
        id_usuario: String,
        email: String,
    }

    async fn abrir() -> (Arc<Db>, SqliteTrabajadoresRepository, std::path::PathBuf) {
        let dir = crate::test_temp::dir_temporal("ultimo_admin");
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        let repo = SqliteTrabajadoresRepository::new(db.clone());
        (db, repo, dir)
    }

    async fn alta(db: &Arc<Db>, repo: &SqliteTrabajadoresRepository, email: &str, rol: &str, estado: &str) -> Ficha {
        repo.create_trabajador(TrabajadorNuevo {
            id_rol: rol.to_string(),
            email: email.to_string(),
            pin: "1234".to_string(),
            nombre: "Nombre".to_string(),
            apellido: None,
            estado: estado.to_string(),
            dni: None,
            telefono: None,
            puesto: None,
            iban: None,
            numero_seguridad_social: None,
            fecha_inicio_contrato: None,
            fecha_fin_contrato: None,
        })
        .await
        .unwrap();

        let conn = db.read().await;
        let mut rows = conn
            .query(
                "SELECT t.ID_Trabajador, u.ID_Usuario FROM Trabajadores t \
                 JOIN Usuarios u ON u.ID_Usuario = t.ID_Usuario WHERE u.Email = ?1;",
                vec![Value::Text(email.to_string())],
            )
            .await
            .unwrap();
        let row = rows.next().await.unwrap().unwrap();
        let txt = |i: i32| match row.get_value(i).unwrap() {
            Value::Text(t) => t,
            otro => panic!("se esperaba texto, había {otro:?}"),
        };
        Ficha { id_trabajador: txt(0), id_usuario: txt(1), email: email.to_string() }
    }

    async fn editar(
        repo: &SqliteTrabajadoresRepository,
        f: &Ficha,
        rol: &str,
        estado: &str,
    ) -> Result<bool, AppError> {
        editar_con_pin(repo, f, rol, estado, None).await
    }

    async fn editar_con_pin(
        repo: &SqliteTrabajadoresRepository,
        f: &Ficha,
        rol: &str,
        estado: &str,
        pin: Option<&str>,
    ) -> Result<bool, AppError> {
        repo.update_trabajador(
            &f.id_trabajador,
            TrabajadorCambios {
                id_usuario: f.id_usuario.clone(),
                id_rol: rol.to_string(),
                email: f.email.clone(),
                nombre: "Nombre editado".to_string(),
                apellido: None,
                estado: estado.to_string(),
                dni: None,
                telefono: None,
                puesto: None,
                iban: None,
                numero_seguridad_social: None,
                fecha_inicio_contrato: None,
                fecha_fin_contrato: None,
                pin: pin.map(str::to_string),
            },
        )
        .await
    }

    async fn hash_guardado(db: &Arc<Db>, f: &Ficha) -> String {
        let conn = db.read().await;
        let mut rows = conn
            .query(
                "SELECT Password_Hash FROM Usuarios WHERE ID_Usuario = ?1;",
                vec![Value::Text(f.id_usuario.clone())],
            )
            .await
            .unwrap();
        match rows.next().await.unwrap().unwrap().get_value(0).unwrap() {
            Value::Text(t) => t,
            otro => panic!("se esperaba texto, había {otro:?}"),
        }
    }

    async fn rol_y_estado(db: &Arc<Db>, f: &Ficha) -> (String, String) {
        let conn = db.read().await;
        let mut rows = conn
            .query(
                "SELECT ID_Rol, Estado FROM Usuarios WHERE ID_Usuario = ?1;",
                vec![Value::Text(f.id_usuario.clone())],
            )
            .await
            .unwrap();
        let row = rows.next().await.unwrap().unwrap();
        let txt = |i: i32| match row.get_value(i).unwrap() {
            Value::Text(t) => t,
            otro => panic!("se esperaba texto, había {otro:?}"),
        };
        (txt(0), txt(1))
    }

    #[tokio::test]
    async fn el_unico_administrador_no_puede_quitarse_el_rol_ni_desactivarse() {
        let (db, repo, _dir) = abrir().await;
        let ana = alta(&db, &repo, "ana@bar.test", ADMIN, "Activo").await;

        let r = editar(&repo, &ana, CAMARERO, "Activo").await;
        assert!(matches!(r, Err(AppError::Conflict(_))), "{r:?}");
        let r = editar(&repo, &ana, ADMIN, "Inactivo").await;
        assert!(matches!(r, Err(AppError::Conflict(_))), "{r:?}");

        // Rechazado entero: ni el rol, ni el estado, ni el resto de la ficha.
        assert_eq!(rol_y_estado(&db, &ana).await, (ADMIN.into(), "Activo".into()));
    }

    #[tokio::test]
    async fn editar_al_unico_administrador_sin_quitarle_nada_funciona() {
        let (db, repo, _dir) = abrir().await;
        let ana = alta(&db, &repo, "ana@bar.test", ADMIN, "Activo").await;

        assert!(editar(&repo, &ana, ADMIN, "Activo").await.unwrap());
    }

    #[tokio::test]
    async fn con_otro_administrador_activo_si_se_puede() {
        let (db, repo, _dir) = abrir().await;
        let ana = alta(&db, &repo, "ana@bar.test", ADMIN, "Activo").await;
        alta(&db, &repo, "luis@bar.test", ADMIN, "Activo").await;

        assert!(editar(&repo, &ana, CAMARERO, "Activo").await.unwrap());
        assert_eq!(rol_y_estado(&db, &ana).await, (CAMARERO.into(), "Activo".into()));
    }

    #[tokio::test]
    async fn un_administrador_inactivo_no_cuenta_como_el_otro() {
        let (db, repo, _dir) = abrir().await;
        let ana = alta(&db, &repo, "ana@bar.test", ADMIN, "Activo").await;
        alta(&db, &repo, "luis@bar.test", ADMIN, "Inactivo").await;

        let r = editar(&repo, &ana, ADMIN, "Inactivo").await;
        assert!(matches!(r, Err(AppError::Conflict(_))), "{r:?}");
    }

    #[tokio::test]
    async fn sin_administradores_de_partida_editar_a_otro_no_se_bloquea() {
        // La regla mira el paso de «hay» a «no hay»: una base que ya no tenía ninguno no deja a
        // nadie sin poder editar al resto.
        let (db, repo, _dir) = abrir().await;
        let pepe = alta(&db, &repo, "pepe@bar.test", CAMARERO, "Activo").await;

        assert!(editar(&repo, &pepe, CAMARERO, "Inactivo").await.unwrap());
    }

    /* RI-63: el PIN llega en claro y el hash lo hace el repositorio. */

    #[tokio::test]
    async fn el_alta_guarda_el_hash_del_pin_y_no_el_pin() {
        let (db, repo, _dir) = abrir().await;
        let ana = alta(&db, &repo, "ana@bar.test", ADMIN, "Activo").await;

        let hash = hash_guardado(&db, &ana).await;
        assert_ne!(hash, "1234");
        assert!(tpv_domain::login::verify_pin("1234", &hash).is_ok());
    }

    #[tokio::test]
    async fn editar_con_pin_lo_cambia_y_sin_pin_no_lo_toca() {
        let (db, repo, _dir) = abrir().await;
        let ana = alta(&db, &repo, "ana@bar.test", ADMIN, "Activo").await;

        assert!(editar(&repo, &ana, ADMIN, "Activo").await.unwrap());
        assert!(tpv_domain::login::verify_pin("1234", &hash_guardado(&db, &ana).await).is_ok());

        assert!(editar_con_pin(&repo, &ana, ADMIN, "Activo", Some("987654")).await.unwrap());
        let hash = hash_guardado(&db, &ana).await;
        assert!(tpv_domain::login::verify_pin("987654", &hash).is_ok());
        assert!(tpv_domain::login::verify_pin("1234", &hash).is_err());
    }

    #[tokio::test]
    async fn editar_una_ficha_que_no_existe_es_un_error() {
        // RI-63: era un `Ok(true)` sin haber tocado nada.
        let (db, repo, _dir) = abrir().await;
        alta(&db, &repo, "ana@bar.test", ADMIN, "Activo").await;
        let fantasma = Ficha {
            id_trabajador: "no-existe".into(),
            id_usuario: "tampoco".into(),
            email: "x@bar.test".into(),
        };

        let r = editar(&repo, &fantasma, CAMARERO, "Activo").await;
        assert!(matches!(r, Err(AppError::NotFound(_))), "{r:?}");
    }
}

#[cfg(test)]
mod tests_cifrado {
    //! TRAB-03 — verificación de extremo a extremo sobre una BD real.
    //!
    //! Lo que se comprueba aquí no es la criptografía (eso está en
    //! `tpv-infra-licensing::field_crypto`), sino lo que de verdad puede salir mal al
    //! integrarla: que el texto cifrado llegue **a la columna** y **al outbox**. Si el
    //! cifrado se hiciera después de construir la sentencia, la BD local quedaría cifrada
    //! y la nube seguiría recibiendo el DNI en claro; ese fallo sólo se ve mirando el outbox.

    use std::sync::Arc;

    use libsql::Value;
    use tpv_application::error::AppResult;
    use tpv_application::ports::field_cipher::FieldCipher;
    use tpv_application::ports::trabajadores::TrabajadoresRepository;
    use tpv_domain::trabajadores::TrabajadorNuevo;

    use super::SqliteTrabajadoresRepository;
    use crate::db::{Db, Reader};

    const ROL_ADMIN: &str = "00000000-0000-7000-8000-000000000001";
    const DNI: &str = "12345678Z";
    const IBAN: &str = "ES9121000418450200051332";
    const NSS: &str = "281234567840";
    const PREFIJO: &str = "FAKE:";

    /// Cifrador de juguete: invierte el texto y le pone un prefijo. No se usa el real a
    /// propósito —eso ya tiene sus tests— sino uno cuyo resultado se puede predecir en las
    /// aserciones, para que este test hable sólo del cableado.
    struct CipherFalso;

    impl FieldCipher for CipherFalso {
        fn encrypt(&self, plain: Option<&str>) -> AppResult<Option<String>> {
            Ok(plain.map(|v| {
                if v.is_empty() || v.starts_with(PREFIJO) {
                    v.to_string()
                } else {
                    format!("{PREFIJO}{}", v.chars().rev().collect::<String>())
                }
            }))
        }

        fn decrypt(&self, stored: Option<&str>) -> AppResult<Option<String>> {
            Ok(stored.map(|v| match v.strip_prefix(PREFIJO) {
                Some(resto) => resto.chars().rev().collect::<String>(),
                None => v.to_string(),
            }))
        }

        fn is_encrypted(&self, stored: &str) -> bool {
            stored.starts_with(PREFIJO)
        }
    }

    async fn abrir_db() -> (Arc<Db>, std::path::PathBuf) {
        let dir = crate::test_temp::dir_temporal("pii");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("data.db");
        let db = Db::open(path.to_str().unwrap()).await.unwrap();
        (db, dir)
    }

    fn nuevo(email: &str) -> TrabajadorNuevo {
        TrabajadorNuevo {
            id_rol: ROL_ADMIN.to_string(),
            email: email.to_string(),
            pin: "1234".to_string(),
            nombre: "Ada".to_string(),
            apellido: Some("Lovelace".to_string()),
            estado: "Activo".to_string(),
            dni: Some(DNI.to_string()),
            telefono: Some("600000000".to_string()),
            puesto: Some("Camarera".to_string()),
            iban: Some(IBAN.to_string()),
            numero_seguridad_social: Some(NSS.to_string()),
            fecha_inicio_contrato: None,
            fecha_fin_contrato: None,
        }
    }

    /// Columnas tal y como están guardadas, sin pasar por el repositorio.
    async fn columnas_crudas(db: &Arc<Db>) -> (String, String, String, String) {
        let conn = db.read().await;
        let mut rows = conn
            .query(
                "SELECT DNI, IBAN, Numero_Seguridad_Social, Telefono FROM Trabajadores LIMIT 1;",
                Vec::<Value>::new(),
            )
            .await
            .unwrap();
        let row = rows.next().await.unwrap().unwrap();
        let txt = |i: i32| match row.get_value(i).unwrap() {
            Value::Text(t) => t,
            otro => panic!("se esperaba texto, había {otro:?}"),
        };
        (txt(0), txt(1), txt(2), txt(3))
    }

    async fn primer_id(db: &Arc<Db>) -> String {
        let conn = db.read().await;
        let mut rows = conn
            .query(
                "SELECT ID_Trabajador FROM Trabajadores LIMIT 1;",
                Vec::<Value>::new(),
            )
            .await
            .unwrap();
        match rows.next().await.unwrap().unwrap().get_value(0).unwrap() {
            Value::Text(t) => t,
            otro => panic!("se esperaba texto, había {otro:?}"),
        }
    }

    #[tokio::test]
    async fn la_pii_se_guarda_cifrada_y_se_lee_en_claro() {
        let (db, _dir) = abrir_db().await;
        let repo =
            SqliteTrabajadoresRepository::with_cipher(db.clone(), Some(Arc::new(CipherFalso)));

        repo.create_trabajador(nuevo("ada@test.local")).await.unwrap();

        let (dni, iban, nss, telefono) = columnas_crudas(&db).await;

        assert!(dni.starts_with(PREFIJO), "DNI sin cifrar: {dni}");
        assert!(iban.starts_with(PREFIJO), "IBAN sin cifrar: {iban}");
        assert!(nss.starts_with(PREFIJO), "NSS sin cifrar: {nss}");
        assert!(!dni.contains(DNI));
        assert!(!iban.contains(IBAN));

        // El resto de columnas, intactas: sólo se cifra lo sensible.
        assert_eq!(telefono, "600000000");

        let detalle = repo.get_detail(&primer_id(&db).await).await.unwrap().unwrap();
        assert_eq!(detalle.dni.as_deref(), Some(DNI));
        assert_eq!(detalle.iban.as_deref(), Some(IBAN));
        assert_eq!(detalle.numero_seguridad_social.as_deref(), Some(NSS));
    }

    /// El test que justifica el diseño entero: si el cifrado ocurriera después de construir la
    /// sentencia, el outbox replicaría el DNI en claro y el cifrado no serviría de nada.
    #[tokio::test]
    async fn el_outbox_replica_texto_cifrado_no_el_dni_en_claro() {
        let (db, _dir) = abrir_db().await;
        let repo =
            SqliteTrabajadoresRepository::with_cipher(db.clone(), Some(Arc::new(CipherFalso)));

        repo.create_trabajador(nuevo("grace@test.local")).await.unwrap();

        let conn = db.read().await;
        let mut rows = conn
            .query("SELECT Statements_Json FROM _Sync_Outbox;", Vec::<Value>::new())
            .await
            .unwrap();

        let mut visto_cifrado = false;
        let mut filas = 0;

        while let Some(row) = rows.next().await.unwrap() {
            let payload = match row.get_value(0).unwrap() {
                Value::Text(t) => t,
                _ => continue,
            };
            filas += 1;
            assert!(!payload.contains(DNI), "el outbox lleva el DNI en claro: {payload}");
            assert!(!payload.contains(IBAN), "el outbox lleva el IBAN en claro: {payload}");
            assert!(!payload.contains(NSS), "el outbox lleva el nº SS en claro: {payload}");
            if payload.contains(PREFIJO) {
                visto_cifrado = true;
            }
        }

        assert!(filas > 0, "la escritura debería haber dejado algo en el outbox");
        assert!(visto_cifrado, "el outbox debería contener los valores cifrados");
    }

    #[tokio::test]
    async fn sin_cifrador_todo_sigue_como_antes() {
        let (db, _dir) = abrir_db().await;
        let repo = SqliteTrabajadoresRepository::new(db.clone());

        repo.create_trabajador(nuevo("sin@test.local")).await.unwrap();

        let (dni, iban, nss, _) = columnas_crudas(&db).await;
        assert_eq!(dni, DNI);
        assert_eq!(iban, IBAN);
        assert_eq!(nss, NSS);
    }

    /// Filas dadas de alta antes de activar el cifrado: el job las convierte, y es idempotente.
    #[tokio::test]
    async fn el_job_convierte_las_filas_antiguas_y_no_repite() {
        let (db, _dir) = abrir_db().await;

        SqliteTrabajadoresRepository::new(db.clone())
            .create_trabajador(nuevo("vieja@test.local"))
            .await
            .unwrap();

        let (dni_antes, _, _, _) = columnas_crudas(&db).await;
        assert_eq!(dni_antes, DNI, "de partida debe estar en claro");

        let repo =
            SqliteTrabajadoresRepository::with_cipher(db.clone(), Some(Arc::new(CipherFalso)));

        assert_eq!(repo.cifrar_pii_pendiente().await.unwrap(), 1);

        let (dni, iban, nss, _) = columnas_crudas(&db).await;
        assert!(dni.starts_with(PREFIJO));
        assert!(iban.starts_with(PREFIJO));
        assert!(nss.starts_with(PREFIJO));

        // Segunda pasada: no queda nada pendiente y el valor no se cifra dos veces.
        assert_eq!(repo.cifrar_pii_pendiente().await.unwrap(), 0);
        let (dni_final, _, _, _) = columnas_crudas(&db).await;
        assert_eq!(dni_final, dni);
    }

    /// Lo que se perdería con un nonce aleatorio: el UNIQUE dejaría de ver los duplicados.
    #[tokio::test]
    async fn el_unique_del_dni_sigue_detectando_duplicados() {
        let (db, _dir) = abrir_db().await;
        let repo =
            SqliteTrabajadoresRepository::with_cipher(db.clone(), Some(Arc::new(CipherFalso)));

        repo.create_trabajador(nuevo("uno@test.local")).await.unwrap();

        let segundo = repo.create_trabajador(nuevo("dos@test.local")).await;
        assert!(segundo.is_err(), "un DNI repetido debe seguir siendo un error");
    }
}

