//! Adaptador SQLite del repositorio de **trabajadores / horarios**. Local-First:
//! sin Applied_Operations, sin Outbox, sin idempotencia por op_id ni rama remota.

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
use tpv_domain::trabajadores::{
    limpiar_opcional, AsignacionCambios, AsignacionNueva, TrabajadorCambios, TrabajadorNuevo,
};

use crate::db::{Db, Reader, Writer};
use crate::mapping::{v_i64, v_string};
use crate::util::new_id;

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
        let pendientes: Vec<(String, Option<String>, Option<String>, Option<String>)> = {
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

fn db_err(e: impl std::fmt::Display) -> AppError {
    AppError::repository(e.to_string())
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
            t.Nombre_Turno
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

                if id_trab.is_empty() || weekday < 1 || weekday > 7 || id_turno.is_empty() {
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
                let wd = (day_offset + 1) as i64;

                for ((id_trab, weekday), list) in defs.iter() {
                    if *weekday != wd {
                        continue;
                    }

                    if real_cells.contains(&(id_trab.clone(), ymd.clone())) {
                        continue;
                    }

                    for it in list.iter() {
                        out.push(AsignacionRow {
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
        let db = self.db.write().await;

        db.execute_batch("BEGIN;").await.map_err(db_err)?;

        let res: AppResult<bool> = async {
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
                    Value::Text(data.password_hash.clone()),
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
        }
        .await;

        match res {
            Ok(v) => {
                db.execute_batch("COMMIT;").await.map_err(db_err)?;
                Ok(v)
            }
            Err(e) => {
                let _ = db.execute_batch("ROLLBACK;").await;
                Err(e)
            }
        }
    }

    async fn update_trabajador(
        &self,
        id_trabajador: &str,
        cambios: TrabajadorCambios,
    ) -> AppResult<bool> {
        let db = self.db.write().await;

        db.execute_batch("BEGIN;").await.map_err(db_err)?;

        let res: AppResult<bool> = async {
            // Datos de cuenta (Usuarios). El PIN sólo se actualiza si llega un hash nuevo.
            if let Some(hash) = cambios.password_hash.clone() {
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
                .map_err(db_err)?;
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
                .map_err(db_err)?;
            }

            // Datos laborales (Trabajadores).
            db.execute(
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

            Ok(true)
        }
        .await;

        match res {
            Ok(v) => {
                db.execute_batch("COMMIT;").await.map_err(db_err)?;
                Ok(v)
            }
            Err(e) => {
                let _ = db.execute_batch("ROLLBACK;").await;
                Err(e)
            }
        }
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
                "DELETE FROM Asignacion_Turnos WHERE ID_Asignacion = ?1;",
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
                SELECT ID_Trabajador, Fecha, ID_Turno, Area, Hora_Inicio, Hora_Fin, Notas
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
                id_trabajador: v_string(r.get_value(0).map_err(db_err)?).unwrap_or_default(),
                fecha: v_string(r.get_value(1).map_err(db_err)?).unwrap_or_default(),
                id_turno: v_string(r.get_value(2).map_err(db_err)?).unwrap_or_default(),
                area: v_string(r.get_value(3).map_err(db_err)?).unwrap_or_else(|| "Sala".into()),
                hora_inicio: v_string(r.get_value(4).map_err(db_err)?),
                hora_fin: v_string(r.get_value(5).map_err(db_err)?),
                notas: v_string(r.get_value(6).map_err(db_err)?),
            });
        }

        db.execute_batch("BEGIN;").await.map_err(db_err)?;
        let res: AppResult<bool> = async {
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
            for s in origen.iter() {
                let src_date = match NaiveDate::parse_from_str(&s.fecha, "%Y-%m-%d") {
                    Ok(d) => d,
                    Err(_) => continue,
                };
                let dst = (src_date + Duration::days(shift)).format("%Y-%m-%d").to_string();
                db.execute(
                    r#"
                    INSERT INTO Asignacion_Turnos (
                      ID_Asignacion, ID_Trabajador, Fecha, ID_Turno, Area, Hora_Inicio, Hora_Fin, Notas
                    )
                    VALUES (?1, ?2, date(?3), ?4, ?5, ?6, ?7, ?8);
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
                    ],
                )
                .await
                .map_err(db_err)?;
                inserted += 1;
            }

            Ok(inserted > 0 || overwrite)
        }
        .await;

        match res {
            Ok(v) => {
                db.execute_batch("COMMIT;").await.map_err(db_err)?;
                Ok(v)
            }
            Err(e) => {
                let _ = db.execute_batch("ROLLBACK;").await;
                Err(e)
            }
        }
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
        db.execute_batch("BEGIN;").await.map_err(db_err)?;
        let res: AppResult<bool> = async {
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
        }
        .await;

        match res {
            Ok(v) => {
                db.execute_batch("COMMIT;").await.map_err(db_err)?;
                Ok(v)
            }
            Err(e) => {
                let _ = db.execute_batch("ROLLBACK;").await;
                Err(e)
            }
        }
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

    fn uniq() -> String {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        format!(
            "{}_{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        )
    }

    async fn abrir_db() -> (Arc<Db>, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("tpv_pii_test_{}", uniq()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("data.db");
        let db = Db::open(path.to_str().unwrap()).await.unwrap();
        (db, dir)
    }

    fn nuevo(email: &str) -> TrabajadorNuevo {
        TrabajadorNuevo {
            id_rol: ROL_ADMIN.to_string(),
            email: email.to_string(),
            password_hash: "hash".to_string(),
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
