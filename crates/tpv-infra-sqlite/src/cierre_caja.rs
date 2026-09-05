//! Persistencia del **cierre de caja** (arqueo). CUENTA-06.
//!
//! Todo va por `execute()` y no por `raw()`: un cierre es un dato de negocio y se replica como
//! cualquier otro (ver la regla del escritor único en CLAUDE.md §9).

use std::sync::Arc;

use async_trait::async_trait;
use libsql::{Row, Value};

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::cierre_caja::{ApunteCaja, CierreCajaRepository, CierreNuevo};
use tpv_contracts::cierre_caja::{CierreDto, CierreResumenDto, DenominacionDto};

use crate::db::{Db, Reader, Writer};
use crate::mapping::{norm_opt_string, v_f64, v_i64, v_string};

pub struct SqliteCierreCajaRepository {
    db: Arc<Db>,
}

impl SqliteCierreCajaRepository {
    pub fn new(db: Arc<Db>) -> Self {
        Self { db }
    }
}

fn db_err(e: impl std::fmt::Display) -> AppError {
    AppError::repository(e.to_string())
}

/// Columnas de un cierre, en el orden que espera `map_cierre`. El nombre de quien cerró se resuelve
/// aquí y no en la UI: la fila sólo guarda el id, y un LEFT JOIN evita que un usuario borrado haga
/// desaparecer el arqueo entero.
const COLS: &str = r#"
    c.ID_Cierre,
    c.Fecha_Hora,
    c.ID_Usuario,
    TRIM(COALESCE(u.Nombre,'') || CASE WHEN COALESCE(u.Apellido,'')='' THEN '' ELSE ' ' || u.Apellido END) AS Usuario_Nombre,
    c.Fondo_Inicial,
    c.Ventas_Efectivo,
    c.Esperado,
    c.Contado,
    c.Descuadre,
    c.Dejado,
    c.Retirado,
    c.Motivo,
    c.Reabierto_En,
    c.Reabierto_Por
"#;

fn map_cierre(row: &Row) -> AppResult<CierreDto> {
    let g = |i: i32| row.get_value(i).map_err(db_err);
    Ok(CierreDto {
        id_cierre: v_string(g(0)?).unwrap_or_default(),
        fecha_hora: v_string(g(1)?).unwrap_or_default(),
        id_usuario: norm_opt_string(g(2)?),
        usuario_nombre: norm_opt_string(g(3)?),
        fondo_inicial: v_f64(g(4)?).unwrap_or(0.0),
        ventas_efectivo: v_f64(g(5)?).unwrap_or(0.0),
        esperado: v_f64(g(6)?).unwrap_or(0.0),
        contado: v_f64(g(7)?).unwrap_or(0.0),
        descuadre: v_f64(g(8)?).unwrap_or(0.0),
        dejado: v_f64(g(9)?).unwrap_or(0.0),
        retirado: v_f64(g(10)?).unwrap_or(0.0),
        motivo: norm_opt_string(g(11)?),
        reabierto_en: norm_opt_string(g(12)?),
        reabierto_por: norm_opt_string(g(13)?),
        contado_denoms: vec![],
        dejado_denoms: vec![],
    })
}

#[async_trait]
impl CierreCajaRepository for SqliteCierreCajaRepository {
    async fn ultimo_cierre(&self) -> AppResult<Option<CierreDto>> {
        let db = self.db.read().await;
        let sql = format!(
            r#"
            SELECT {COLS}
            FROM Cierres_Caja c
            LEFT JOIN Usuarios u ON u.ID_Usuario = c.ID_Usuario
            WHERE c.Reabierto_En IS NULL
            ORDER BY c.Fecha_Hora DESC, c.ID_Cierre DESC
            LIMIT 1;
            "#
        );
        let mut rows = db.query(sql.as_str(), ()).await.map_err(db_err)?;
        let id = match rows.next().await.map_err(db_err)? {
            Some(r) => map_cierre(&r)?.id_cierre,
            None => return Ok(None),
        };
        drop(db);

        // Se relee por `detalle` para que traiga tambien el desglose por denominacion: un CierreDto
        // con las listas vacias no distinguiria "no hubo recuento" de "aqui no lo cargue".
        self.detalle(&id).await
    }

    async fn corte_vigente(&self) -> AppResult<Option<String>> {
        let db = self.db.read().await;
        let mut rows = db
            .query(
                r#"
                SELECT Fecha_Hora
                FROM Cierres_Caja
                WHERE Reabierto_En IS NULL
                ORDER BY Fecha_Hora DESC, ID_Cierre DESC
                LIMIT 1;
                "#,
                (),
            )
            .await
            .map_err(db_err)?;
        Ok(match rows.next().await.map_err(db_err)? {
            Some(r) => norm_opt_string(r.get_value(0).map_err(db_err)?),
            None => None,
        })
    }

    async fn horas_periodo_abierto(&self) -> AppResult<i64> {
        let db = self.db.read().await;
        let mut rows = db
            .query(
                r#"
                WITH inicio AS (
                  SELECT COALESCE(
                    (SELECT MAX(Fecha_Hora) FROM Cierres_Caja WHERE Reabierto_En IS NULL),
                    (SELECT MIN(Fecha_Hora) FROM Pagos WHERE COALESCE(Estado,'ACTIVO') = 'ACTIVO')
                  ) AS desde
                )
                SELECT CASE
                         WHEN desde IS NULL THEN 0
                         ELSE CAST((julianday('now','localtime') - julianday(desde)) * 24 AS INTEGER)
                       END
                FROM inicio;
                "#,
                (),
            )
            .await
            .map_err(db_err)?;
        Ok(match rows.next().await.map_err(db_err)? {
            Some(r) => v_i64(r.get_value(0).map_err(db_err)?).unwrap_or(0).max(0),
            None => 0,
        })
    }

    async fn fecha_apunte(&self, tipo: ApunteCaja, id: &str) -> AppResult<Option<String>> {
        let db = self.db.read().await;
        let sql = match tipo {
            ApunteCaja::Pago => "SELECT Fecha_Hora FROM Pagos WHERE ID_Pago = ?1 LIMIT 1;",
            ApunteCaja::Gasto => "SELECT Fecha FROM Cuentas_Gastos WHERE ID_Gasto = ?1 LIMIT 1;",
        };
        let mut rows = db
            .query(sql, vec![Value::Text(id.to_string())])
            .await
            .map_err(db_err)?;
        Ok(match rows.next().await.map_err(db_err)? {
            Some(r) => norm_opt_string(r.get_value(0).map_err(db_err)?),
            None => None,
        })
    }

    async fn ventas_efectivo_desde(&self, desde: Option<&str>) -> AppResult<f64> {
        let db = self.db.read().await;

        // El método se normaliza igual que en el resto de caja: todo lo que no sea 'Tarjeta' cuenta
        // como efectivo (CUENTA-03). Un método nuevo entra por defecto en el cajón, que es el lado
        // seguro: aparecería como descuadre y se investigaría, en vez de desaparecer sin más.
        //
        // ⚠️ El `Estado = 'ACTIVO'` es LA consulta de CUENTA-07. Antes anular borraba la fila, así
        // que el esperado bajaba exactamente lo mismo que faltaba en el cajón y el descuadre salía
        // cero: el único control de caja del producto era ciego ante la forma más común de sisa.
        // Ahora el cobro anulado sigue ahí pero no cuenta como venta, así que el dinero que falta
        // sale como que falta.
        let (sql, params) = match desde {
            Some(d) => (
                r#"
                SELECT ROUND(COALESCE(SUM(Importe_Total),0),2)
                FROM Pagos
                WHERE COALESCE(Metodo_Pago,'') <> 'Tarjeta'
                  AND COALESCE(Estado,'ACTIVO') = 'ACTIVO'
                  AND datetime(Fecha_Hora) > datetime(?1);
                "#,
                vec![Value::Text(d.to_string())],
            ),
            None => (
                r#"
                SELECT ROUND(COALESCE(SUM(Importe_Total),0),2)
                FROM Pagos
                WHERE COALESCE(Metodo_Pago,'') <> 'Tarjeta'
                  AND COALESCE(Estado,'ACTIVO') = 'ACTIVO';
                "#,
                vec![],
            ),
        };

        let mut rows = db.query(sql, params).await.map_err(db_err)?;
        Ok(match rows.next().await.map_err(db_err)? {
            Some(r) => v_f64(r.get_value(0).map_err(db_err)?).unwrap_or(0.0),
            None => 0.0,
        })
    }

    /// Cuántas anulaciones ha habido en el periodo y por cuánto importe. **Informativo**: no entra
    /// en el cálculo del arqueo, que sigue derivando de los cobros activos. Es el dato que no
    /// existía y que hace visible la sisa: un descuadre de 40 € junto a "3 anulaciones por 40 €"
    /// se explica solo.
    ///
    /// Se cuenta por `Anulado_En` y no por `Fecha_Hora`: lo que pertenece a este periodo es el
    /// acto de anular, no la venta original —que puede ser de anteayer.
    async fn anulaciones_desde(&self, desde: Option<&str>) -> AppResult<(i64, f64)> {
        let db = self.db.read().await;
        let (sql, params) = match desde {
            Some(d) => (
                r#"
                SELECT COUNT(*), ROUND(COALESCE(SUM(Importe_Total),0),2)
                FROM Pagos
                WHERE COALESCE(Estado,'ACTIVO') = 'ANULADO'
                  AND Anulado_En IS NOT NULL
                  AND datetime(Anulado_En) > datetime(?1);
                "#,
                vec![Value::Text(d.to_string())],
            ),
            None => (
                r#"
                SELECT COUNT(*), ROUND(COALESCE(SUM(Importe_Total),0),2)
                FROM Pagos
                WHERE COALESCE(Estado,'ACTIVO') = 'ANULADO';
                "#,
                vec![],
            ),
        };
        let mut rows = db.query(sql, params).await.map_err(db_err)?;
        Ok(match rows.next().await.map_err(db_err)? {
            Some(r) => (
                v_i64(r.get_value(0).map_err(db_err)?).unwrap_or(0),
                v_f64(r.get_value(1).map_err(db_err)?).unwrap_or(0.0),
            ),
            None => (0, 0.0),
        })
    }

    async fn comandas_abiertas(&self) -> AppResult<i64> {
        let db = self.db.read().await;
        let mut rows = db
            .query("SELECT COUNT(*) FROM Comandas WHERE Estado = 'Abierta';", ())
            .await
            .map_err(db_err)?;
        Ok(match rows.next().await.map_err(db_err)? {
            Some(r) => v_i64(r.get_value(0).map_err(db_err)?).unwrap_or(0),
            None => 0,
        })
    }

    async fn crear(&self, c: CierreNuevo) -> AppResult<()> {
        let db = self.db.write().await;

        db.execute(
            r#"
            INSERT INTO Cierres_Caja (
              ID_Cierre, Fecha_Hora, ID_Usuario, Fondo_Inicial, Ventas_Efectivo,
              Esperado, Contado, Descuadre, Dejado, Retirado, Motivo
            ) VALUES (?1, datetime('now','localtime'), ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10);
            "#,
            vec![
                Value::Text(c.id_cierre.clone()),
                match c.id_usuario {
                    Some(u) => Value::Text(u),
                    None => Value::Null,
                },
                Value::Real(c.fondo_inicial),
                Value::Real(c.ventas_efectivo),
                Value::Real(c.esperado),
                Value::Real(c.contado),
                Value::Real(c.descuadre),
                Value::Real(c.dejado),
                Value::Real(c.retirado),
                match c.motivo {
                    Some(m) => Value::Text(m),
                    None => Value::Null,
                },
            ],
        )
        .await
        .map_err(db_err)?;

        for (momento, denoms) in [("CONTADO", &c.contado_denoms), ("DEJADO", &c.dejado_denoms)] {
            for d in denoms.iter().filter(|d| d.unidades > 0 && d.valor > 0.0) {
                db.execute(
                    r#"
                    INSERT INTO Cierre_Denominaciones (ID_Cierre, Momento, Valor, Unidades)
                    VALUES (?1, ?2, ?3, ?4)
                    ON CONFLICT(ID_Cierre, Momento, Valor) DO UPDATE SET
                      Unidades = excluded.Unidades;
                    "#,
                    vec![
                        Value::Text(c.id_cierre.clone()),
                        Value::Text(momento.to_string()),
                        Value::Real(d.valor),
                        Value::Integer(d.unidades),
                    ],
                )
                .await
                .map_err(db_err)?;
            }
        }

        Ok(())
    }

    async fn listar(&self, limite: i64) -> AppResult<Vec<CierreResumenDto>> {
        let db = self.db.read().await;
        let mut rows = db
            .query(
                r#"
                SELECT
                  c.ID_Cierre,
                  c.Fecha_Hora,
                  TRIM(COALESCE(u.Nombre,'') || CASE WHEN COALESCE(u.Apellido,'')='' THEN '' ELSE ' ' || u.Apellido END) AS Usuario_Nombre,
                  c.Esperado,
                  c.Contado,
                  c.Descuadre,
                  c.Retirado,
                  c.Motivo,
                  c.Reabierto_En
                FROM Cierres_Caja c
                LEFT JOIN Usuarios u ON u.ID_Usuario = c.ID_Usuario
                ORDER BY c.Fecha_Hora DESC, c.ID_Cierre DESC
                LIMIT ?1;
                "#,
                vec![Value::Integer(if limite > 0 { limite } else { 50 })],
            )
            .await
            .map_err(db_err)?;

        let mut out = Vec::new();
        while let Some(r) = rows.next().await.map_err(db_err)? {
            let g = |i: i32| r.get_value(i).map_err(db_err);
            out.push(CierreResumenDto {
                id_cierre: v_string(g(0)?).unwrap_or_default(),
                fecha_hora: v_string(g(1)?).unwrap_or_default(),
                usuario_nombre: norm_opt_string(g(2)?),
                esperado: v_f64(g(3)?).unwrap_or(0.0),
                contado: v_f64(g(4)?).unwrap_or(0.0),
                descuadre: v_f64(g(5)?).unwrap_or(0.0),
                retirado: v_f64(g(6)?).unwrap_or(0.0),
                motivo: norm_opt_string(g(7)?),
                reabierto_en: norm_opt_string(g(8)?),
            });
        }
        Ok(out)
    }

    async fn detalle(&self, id_cierre: &str) -> AppResult<Option<CierreDto>> {
        let db = self.db.read().await;
        let sql = format!(
            r#"
            SELECT {COLS}
            FROM Cierres_Caja c
            LEFT JOIN Usuarios u ON u.ID_Usuario = c.ID_Usuario
            WHERE c.ID_Cierre = ?1
            LIMIT 1;
            "#
        );
        let mut rows = db
            .query(sql.as_str(), vec![Value::Text(id_cierre.to_string())])
            .await
            .map_err(db_err)?;

        let Some(r) = rows.next().await.map_err(db_err)? else {
            return Ok(None);
        };
        let mut dto = map_cierre(&r)?;

        let mut drows = db
            .query(
                r#"
                SELECT Momento, Valor, Unidades
                FROM Cierre_Denominaciones
                WHERE ID_Cierre = ?1
                ORDER BY Momento ASC, Valor ASC;
                "#,
                vec![Value::Text(id_cierre.to_string())],
            )
            .await
            .map_err(db_err)?;

        while let Some(d) = drows.next().await.map_err(db_err)? {
            let g = |i: i32| d.get_value(i).map_err(db_err);
            let momento = v_string(g(0)?).unwrap_or_default();
            let item = DenominacionDto {
                valor: v_f64(g(1)?).unwrap_or(0.0),
                unidades: v_i64(g(2)?).unwrap_or(0),
            };
            if momento == "DEJADO" {
                dto.dejado_denoms.push(item);
            } else {
                dto.contado_denoms.push(item);
            }
        }

        Ok(Some(dto))
    }

    async fn reabrir(&self, id_cierre: &str, id_usuario: Option<&str>) -> AppResult<bool> {
        let db = self.db.write().await;

        // El `Reabierto_En IS NULL` del WHERE hace la operación idempotente: reabrir dos veces no
        // reescribe quién lo hizo la primera, que es justo el dato que da sentido al registro.
        let n = db
            .execute(
                r#"
                UPDATE Cierres_Caja
                SET Reabierto_En = datetime('now','localtime'),
                    Reabierto_Por = ?2
                WHERE ID_Cierre = ?1 AND Reabierto_En IS NULL;
                "#,
                vec![
                    Value::Text(id_cierre.to_string()),
                    match id_usuario {
                        Some(u) => Value::Text(u.to_string()),
                        None => Value::Null,
                    },
                ],
            )
            .await
            .map_err(db_err)?;

        Ok(n > 0)
    }
}
