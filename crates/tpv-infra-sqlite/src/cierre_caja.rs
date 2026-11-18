//! Persistencia del **cierre de caja** (arqueo). CUENTA-06 · CAJA-01.
//!
//! Todo va por `execute()` y no por `raw()`: un cierre es un dato de negocio y se replica como
//! cualquier otro (ver la regla del escritor único en docs/arquitectura/sincronizacion.md). Las rectificaciones también:
//! la Handy tiene que ver en un cierre lo mismo que la Main.

use crate::util::new_id;
use crate::consultas::{db_err};
use tpv_domain::dinero::Dinero;
use std::sync::Arc;

use async_trait::async_trait;
use crate::ejecutor::Value;
use crate::ejecutor::Row;

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::cierre_caja::{
    ApunteCaja, ApunteGuardado, ArmarCierre, CierreCajaRepository, CierreNuevo, PeriodoAbierto,
    RectificacionNueva,
};
use tpv_contracts::cierre_caja::{
    CierreDto, CierreResumenDto, DenominacionDto, RectificacionDto,
};
use tpv_domain::cierre_caja::{TotalesCaja, HORA_DE_UN_GASTO};

use crate::db::{Db, Reader, Writer};
use crate::mapping::{dinero_val, norm_opt_string, v_dinero, v_i64, v_string};

pub struct SqliteCierreCajaRepository {
    db: Arc<Db>,
}

impl SqliteCierreCajaRepository {
    pub fn new(db: Arc<Db>) -> Self {
        Self { db }
    }
}

fn texto_o_nulo(s: Option<&str>) -> Value {
    match s {
        Some(v) => Value::Text(v.to_string()),
        None => Value::Null,
    }
}

/// El instante con el que se compara un gasto contra un cierre, escrito en SQL.
///
/// Tiene que decir lo mismo que `tpv_domain::cierre_caja::momento_de_gasto_guardado`, y por eso las
/// dos salen de la misma constante: si cada lado eligiera su hora, un gasto podría contar en el
/// arqueo de un cierre y rectificar el de otro. Su hora de caja si la tiene (CAJ-INC-01) y, si no,
/// su día a las 12:00.
fn momento_de_gasto_sql() -> String {
    format!("COALESCE(datetime(Momento_Caja), datetime(date(Fecha) || ' {HORA_DE_UN_GASTO}'))")
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
    c.Reabierto_Por,
    c.Periodo_Desde,
    c.Gastos_Caja,
    c.Rect_Ventas_Efectivo,
    c.Rect_Gastos_Caja,
    c.Rect_Esperado,
    c.Rect_Descuadre
"#;

fn map_cierre(row: &Row) -> AppResult<CierreDto> {
    let g = |i: i32| row.get_value(i).map_err(db_err);
    Ok(CierreDto {
        id_cierre: v_string(g(0)?).unwrap_or_default(),
        fecha_hora: v_string(g(1)?).unwrap_or_default(),
        id_usuario: norm_opt_string(g(2)?),
        usuario_nombre: norm_opt_string(g(3)?),
        fondo_inicial: v_dinero(g(4)?).unwrap_or(Dinero::CERO),
        ventas_efectivo: v_dinero(g(5)?).unwrap_or(Dinero::CERO),
        esperado: v_dinero(g(6)?).unwrap_or(Dinero::CERO),
        contado: v_dinero(g(7)?).unwrap_or(Dinero::CERO),
        descuadre: v_dinero(g(8)?).unwrap_or(Dinero::CERO),
        dejado: v_dinero(g(9)?).unwrap_or(Dinero::CERO),
        retirado: v_dinero(g(10)?).unwrap_or(Dinero::CERO),
        motivo: norm_opt_string(g(11)?),
        reabierto_en: norm_opt_string(g(12)?),
        reabierto_por: norm_opt_string(g(13)?),
        periodo_desde: norm_opt_string(g(14)?),
        gastos_caja: v_dinero(g(15)?).unwrap_or(Dinero::CERO),
        rect_ventas_efectivo: v_dinero(g(16)?),
        rect_gastos_caja: v_dinero(g(17)?),
        rect_esperado: v_dinero(g(18)?),
        rect_descuadre: v_dinero(g(19)?),
        contado_denoms: vec![],
        dejado_denoms: vec![],
        rectificaciones: vec![],
    })
}

/// Lo que entró y salió del cajón en `(desde, hasta]`: cobros en efectivo y gastos pagados con
/// caja. `desde = None` es desde el principio; `hasta = None`, hasta ahora.
///
/// El límite superior lo pone el cierre (RI-58): suma y guarda en la misma transacción, con la
/// misma hora como límite y como `Fecha_Hora` del cierre, para que lo que cae dentro del periodo
/// cerrado sea exactamente lo que suman sus cifras.
async fn totales_entre<C: Reader>(
    conn: &C,
    desde: Option<&str>,
    hasta: Option<&str>,
) -> AppResult<TotalesCaja> {
    // COBROS. El método se normaliza igual que en el resto de caja: todo lo que no sea 'Tarjeta'
    // u 'Otro' cuenta como efectivo (CUENTA-03, `pago::es_efectivo`). Un método nuevo entra por
    // defecto en el cajón, que es el lado seguro: aparecería como descuadre y se investigaría, en
    // vez de desaparecer sin más. 'Otro' sólo lo lleva una devolución (una transferencia).
    //
    // Una devolución de PARTE de un cobro es un cobro negativo, ACTIVO, del día que se devuelve: el
    // primer sumando la resta sola, en su periodo.
    //
    // ⚠️ El `Estado = 'ACTIVO'` es LA consulta de CUENTA-07. Antes anular borraba la fila, así
    // que el esperado bajaba exactamente lo mismo que faltaba en el cajón y el descuadre salía
    // cero: el único control de caja del producto era ciego ante la forma más común de sisa.
    // Ahora el cobro anulado sigue ahí pero no cuenta como venta, así que el dinero que falta
    // sale como que falta.
    //
    // ⚠️ Y con FISCAL-01 ese mismo filtro cubre ya las DEVOLUCIONES: una devolución deja el
    // cobro en 'ANULADO' (`Motivo_Baja = 'DEVOLUCION'`). Al cajón le da igual POR QUÉ salió el
    // dinero: lo que cambia entre los dos instrumentos es el registro fiscal que se emite, no
    // la aritmética.
    //
    // ⚠️ Pero sólo cubre la devolución del MISMO periodo, y por eso está la segunda resta
    // (REV-08). El dinero de una devolución sale del cajón el día que se devuelve, no el día
    // que se vendió: devolver el martes una venta del viernes no quita nada del periodo
    // abierto —aquel cobro ya no está en él— y el arqueo del martes salía con esa falta. Se
    // resta aquí, que es donde el dinero se fue de verdad.
    //
    // La condición `Fecha_Hora <= desde` es la que impide contarlo dos veces: una venta
    // devuelta DENTRO de su propio periodo ya sale del primer sumando al dejar de ser 'ACTIVO'
    // —entró y salió, neto cero—, y restarla otra vez la dejaría en negativo. Sin cierre
    // anterior (`?1 IS NULL`) no hay «periodo anterior» posible, así que tampoco se resta.
    //
    // Quien venga a «arreglar» esto restando además desde `Movimientos_Caja` habría creado la
    // segunda fuente para la misma cifra que esa tabla existe para no ser, y restaría dos veces.
    //
    // GASTOS (CAJA-01). Sólo los que salieron del cajón, y comparados por su hora de caja
    // (`Momento_Caja`, CAJ-INC-01) o, sin ella, a mediodía de su día (`HORA_DE_UN_GASTO`).
    //
    // Las mismas reglas, sumadas aquí, son las que usa `TotalesCaja::de_cobro`/`de_gasto` para
    // previsualizar un cambio. Si una cambia, la otra también.
    //
    // Las horas se comparan como TEXTO, sin `datetime()` (RI-18): envolver la columna impedía
    // usar idx_pagos_estado_fecha y cada arqueo recorría todos los cobros de la historia. Vale
    // porque las dos partes están en formato canónico: `desde` es la `Fecha_Hora` de un cierre y
    // `Fecha_Hora`/`Anulado_En` de un pago las pone el sistema (`fecha_de_apunte` normaliza lo que
    // se edita a mano). Los gastos sí pasan por `momento_de_gasto_sql`: no todos guardan la hora.
    let gasto = momento_de_gasto_sql();
    let sql = format!(
        r#"
        SELECT
            COALESCE((
              SELECT SUM(Importe_Total) FROM Pagos
              WHERE Metodo_Pago = 'Efectivo'
                AND Estado = 'ACTIVO'
                AND (?1 IS NULL OR Fecha_Hora > ?1)
                AND (?2 IS NULL OR Fecha_Hora <= ?2)
            ), 0)
            - COALESCE((
              SELECT SUM(Importe_Total) FROM Pagos
              WHERE Metodo_Pago = 'Efectivo'
                AND Estado = 'ANULADO'
                AND Motivo_Baja = 'DEVOLUCION'
                AND ?1 IS NOT NULL
                AND Fecha_Hora <= ?1
                AND Anulado_En IS NOT NULL
                AND Anulado_En > ?1
                AND (?2 IS NULL OR Anulado_En <= ?2)
            ), 0),
          COALESCE((
            SELECT SUM(Importe) FROM Cuentas_Gastos
            WHERE Pagado_Con_Caja = 1
              AND (?1 IS NULL OR {gasto} > datetime(?1))
              AND (?2 IS NULL OR {gasto} <= datetime(?2))
          ), 0);
        "#
    );

    let mut rows = conn
        .query(sql.as_str(), vec![texto_o_nulo(desde), texto_o_nulo(hasta)])
        .await
        .map_err(db_err)?;
    Ok(match rows.next().await.map_err(db_err)? {
        Some(r) => TotalesCaja {
            ventas_efectivo: v_dinero(r.get_value(0).map_err(db_err)?).unwrap_or(Dinero::CERO),
            gastos_caja: v_dinero(r.get_value(1).map_err(db_err)?).unwrap_or(Dinero::CERO),
        },
        None => TotalesCaja::default(),
    })
}

/// Un instante en el formato con el que se guardan las horas de caja: el de
/// `datetime('now','localtime')`.
pub(crate) fn como_hora_de_caja(t: chrono::DateTime<chrono::Local>) -> String {
    t.format("%Y-%m-%d %H:%M:%S").to_string()
}

/// Cierra el periodo en **una sola transacción del escritor** (RI-58).
///
/// Antes eran tres pasos sueltos: leer el último cierre y los totales por el pool de lectura,
/// insertar el cierre con su propio `datetime('now')` y luego, una a una y sin transacción, sus
/// denominaciones. Un cobro entre la lectura y el `INSERT` caía dentro del periodo cerrado (su hora
/// era anterior a la del cierre) pero fuera de sus cifras, y el periodo siguiente empieza después: no
/// lo contaba nadie. Un corte entre los dos `INSERT` dejaba un arqueo sin desglose. Y dos
/// confirmaciones creaban dos cierres.
async fn cerrar_periodo(db: &Db, id_cierre: &str, armar: ArmarCierre<'_>) -> AppResult<()> {
    let g = db.write().await;
    // La hora del cierre, que es también el límite superior de los totales. La pone quien escribe
    // (decisión 0004), con el mismo formato que `datetime('now','localtime')`.
    let inicio = chrono::Local::now();
    let ahora = como_hora_de_caja(inicio);

    let res: AppResult<bool> = g.transaccion(async {
        // Confirmar dos veces es confirmar una: el id lo genera la pantalla al abrir el arqueo.
        let ya_existe = g
            .query(
                "SELECT 1 FROM Cierres_Caja WHERE ID_Cierre = ?1 LIMIT 1;",
                vec![Value::Text(id_cierre.to_string())],
            )
            .await
            .map_err(db_err)?
            .next()
            .await
            .map_err(db_err)?
            .is_some();
        if ya_existe {
            return Ok(false);
        }

        let (desde, dejado_anterior) = {
            let mut rows = g
                .query(
                    "SELECT Fecha_Hora, Dejado FROM Cierres_Caja \
                     WHERE Reabierto_En IS NULL \
                     ORDER BY Fecha_Hora DESC, ID_Cierre DESC LIMIT 1;",
                    (),
                )
                .await
                .map_err(db_err)?;
            match rows.next().await.map_err(db_err)? {
                Some(r) => (
                    v_string(r.get_value(0).map_err(db_err)?),
                    Some(v_dinero(r.get_value(1).map_err(db_err)?).unwrap_or(Dinero::CERO)),
                ),
                None => (None, None),
            }
        };

        let totales = totales_entre(&g, desde.as_deref(), Some(&ahora)).await?;
        let c = armar(PeriodoAbierto { desde, dejado_anterior, totales })?;
        insertar_cierre(&g, &c, &ahora).await?;
        esperar_al_segundo_siguiente(inicio).await;
        Ok(true)
    }).await;

    res.map(|_| ())
}

/// Espera, **con el escritor todavía tomado**, a que cambie el segundo.
///
/// Las horas tienen precisión de segundo, el periodo cerrado cuenta hasta su hora inclusive y el
/// siguiente desde ella en exclusiva. Un cobro guardado justo después del cierre y en el mismo
/// segundo llevaría su misma `Fecha_Hora` y no lo contaría ninguno de los dos. Los cobros fijan su
/// hora al abrir su transacción, que es después de soltar el escritor: esperando aquí, todo lo que
/// se escriba después lleva una hora posterior. Es menos de un segundo, una vez por noche.
async fn esperar_al_segundo_siguiente(inicio: chrono::DateTime<chrono::Local>) {
    use chrono::Timelike;
    let Some(base) = inicio.with_nanosecond(0) else {
        return;
    };
    let siguiente = base + chrono::Duration::seconds(1);
    if let Ok(falta) = (siguiente - chrono::Local::now()).to_std() {
        tokio::time::sleep(falta).await;
    }
}

/// El `INSERT` del cierre y de su doble recuento, dentro de la transacción de [`cerrar_periodo`].
async fn insertar_cierre<C: Writer>(db: &C, c: &CierreNuevo, fecha_hora: &str) -> AppResult<()> {
    db.execute(
        r#"
        INSERT INTO Cierres_Caja (
          ID_Cierre, Fecha_Hora, ID_Usuario, Periodo_Desde, Fondo_Inicial, Ventas_Efectivo,
          Gastos_Caja, Esperado, Contado, Descuadre, Dejado, Retirado, Motivo
        ) VALUES (?1, ?13, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12);
        "#,
        vec![
            Value::Text(c.id_cierre.clone()),
            texto_o_nulo(c.id_usuario.as_deref()),
            texto_o_nulo(c.periodo_desde.as_deref()),
            dinero_val(c.fondo_inicial),
            dinero_val(c.ventas_efectivo),
            dinero_val(c.gastos_caja),
            dinero_val(c.esperado),
            dinero_val(c.contado),
            dinero_val(c.descuadre),
            dinero_val(c.dejado),
            dinero_val(c.retirado),
            texto_o_nulo(c.motivo.as_deref()),
            Value::Text(fecha_hora.to_string()),
        ],
    )
    .await
    .map_err(|e| {
        // `idx_cierres_un_periodo`: ya hay un cierre vigente que empieza donde este. Con la
        // transacción no puede pasar; si pasa, es un fallo nuestro y no se guarda un segundo
        // arqueo del mismo periodo.
        if e.to_string().contains("UNIQUE") {
            AppError::conflict("Ya hay un cierre de este periodo. Vuelve a abrir el cierre de caja.")
        } else {
            db_err(e)
        }
    })?;

    for (momento, denoms) in [("CONTADO", &c.contado_denoms), ("DEJADO", &c.dejado_denoms)] {
        for d in denoms.iter().filter(|d| d.unidades > 0 && d.valor > Dinero::CERO) {
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
                    dinero_val(d.valor),
                    Value::Integer(d.unidades),
                ],
            )
            .await
            .map_err(db_err)?;
        }
    }
    Ok(())
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

    async fn totales_desde(&self, desde: Option<&str>) -> AppResult<TotalesCaja> {
        // CAJ-INC-01: hasta ahora, con el mismo límite que pondrá `cerrar_periodo` al confirmar.
        // Sin él, la preparación contaba lo que tiene una hora posterior —el gasto de «hoy», que
        // sin hora propia cuenta a las 12:00, cerrando de madrugada— y el cierre no: la pantalla
        // enseñaba un esperado y se guardaba otro, y el periodo siguiente lo volvía a contar.
        let ahora = como_hora_de_caja(chrono::Local::now());
        let db = self.db.read().await;
        totales_entre(&db, desde, Some(&ahora)).await
    }

    /// Cuántas anulaciones ha habido en el periodo y por cuánto importe. **Informativo**: no entra
    /// en el cálculo del arqueo, que sigue derivando de los cobros activos. Es el dato que no
    /// existía y que hace visible la sisa: un descuadre de 40 € junto a "3 anulaciones por 40 €"
    /// se explica solo.
    ///
    /// Se cuenta por `Anulado_En` y no por `Fecha_Hora`: lo que pertenece a este periodo es el
    /// acto de anular, no la venta original —que puede ser de anteayer.
    ///
    /// Cuenta las dos clases de baja juntas (FISCAL-01: `Motivo_Baja` 'ERROR' y 'DEVOLUCION')
    /// porque para explicar un descuadre son lo mismo: dinero que salió del cajón sin venta que lo
    /// respalde en el arqueo. La diferencia entre ellas es fiscal y se ve en el historial de caja,
    /// donde sí llevan tipos distintos.
    async fn anulaciones_desde(&self, desde: Option<&str>) -> AppResult<(i64, Dinero)> {
        let db = self.db.read().await;
        let (sql, params) = match desde {
            Some(d) => (
                r#"
                SELECT COUNT(*), COALESCE(SUM(Importe_Total),0)
                FROM Pagos
                WHERE Estado = 'ANULADO'
                  AND Anulado_En IS NOT NULL
                  AND Anulado_En > ?1;
                "#,
                vec![Value::Text(d.to_string())],
            ),
            None => (
                r#"
                SELECT COUNT(*), COALESCE(SUM(Importe_Total),0)
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
                v_dinero(r.get_value(1).map_err(db_err)?).unwrap_or(Dinero::CERO),
            ),
            None => (0, Dinero::CERO),
        })
    }

    async fn caja_por_bajar(&self, desde: Option<&str>) -> AppResult<bool> {
        // Las dos tablas de las que suman `totales_entre` y `anulaciones_desde`. La comanda de un
        // cobro baja antes que él (es su clave foránea), así que con `Pagos` completo también está.
        //
        // DO-02: una tabla sin completar ya tiene aquí todo lo suyo desde `Ventana_Desde`, que trajo
        // entero la fase 1: un cobro, con todos los de su comanda, desde ese instante; un gasto,
        // desde ese día (`Fecha >= date(…)`, `bootstrap.ventana.ts`). Si el periodo empieza ahí o
        // después, a este arqueo no le falta nada: los gastos se comparan por día, porque uno de la
        // mañana del mismo día ya bajó aunque la ventana empiece a mediodía (Codex). Sin periodo (el
        // primer cierre suma desde el principio) o sin saber hasta dónde llegó la fase 1, falta.
        let db = self.db.read().await;
        let mut rows = db
            .query(
                "SELECT COUNT(*) FROM _Backfill_Historico \
                  WHERE Completada = 0 AND Tabla IN ('Pagos', 'Cuentas_Gastos') \
                    AND (?1 IS NULL OR Ventana_Desde IS NULL \
                         OR (Tabla = 'Pagos' AND ?1 < Ventana_Desde) \
                         OR (Tabla = 'Cuentas_Gastos' AND date(?1) < date(Ventana_Desde)));",
                vec![desde.map_or(Value::Null, |d| Value::Text(d.to_string()))],
            )
            .await
            .map_err(db_err)?;
        Ok(match rows.next().await.map_err(db_err)? {
            Some(r) => v_i64(r.get_value(0).map_err(db_err)?).unwrap_or(0) > 0,
            None => false,
        })
    }

    async fn comandas_sin_cobrar(&self) -> AppResult<(i64, i64)> {
        // CAJ-INC-04: sólo lo que de verdad queda por cobrar. Un ticket de barra vacío o una mesa
        // abierta sin nada pendiente salían como «mesas sin cobrar»; y una mesa y un ticket de
        // barra no son lo mismo para quien cierra.
        let db = self.db.read().await;
        let mut rows = db
            .query(
                r#"
                SELECT
                  COALESCE(SUM(CASE WHEN c.Canal = 'MESA' THEN 1 ELSE 0 END), 0),
                  COALESCE(SUM(CASE WHEN c.Canal = 'BARRA' THEN 1 ELSE 0 END), 0)
                FROM Comandas c
                WHERE c.Estado = 'Abierta'
                  AND EXISTS (
                    SELECT 1 FROM Detalle_Comanda dc
                    WHERE dc.ID_Comanda = c.ID_Comanda
                      AND EXISTS (SELECT 1 FROM v_lineas_por_cobrar lp WHERE lp.ID_Detalle = dc.ID_Detalle)
                  );
                "#,
                (),
            )
            .await
            .map_err(db_err)?;
        Ok(match rows.next().await.map_err(db_err)? {
            Some(r) => (
                v_i64(r.get_value(0).map_err(db_err)?).unwrap_or(0),
                v_i64(r.get_value(1).map_err(db_err)?).unwrap_or(0),
            ),
            None => (0, 0),
        })
    }

    async fn cerrar_periodo(&self, id_cierre: &str, armar: ArmarCierre<'_>) -> AppResult<()> {
        cerrar_periodo(&self.db, id_cierre, armar).await
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
                  c.Reabierto_En,
                  c.Rect_Esperado,
                  c.Rect_Descuadre
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
                esperado: v_dinero(g(3)?).unwrap_or(Dinero::CERO),
                contado: v_dinero(g(4)?).unwrap_or(Dinero::CERO),
                descuadre: v_dinero(g(5)?).unwrap_or(Dinero::CERO),
                retirado: v_dinero(g(6)?).unwrap_or(Dinero::CERO),
                motivo: norm_opt_string(g(7)?),
                reabierto_en: norm_opt_string(g(8)?),
                rect_esperado: v_dinero(g(9)?),
                rect_descuadre: v_dinero(g(10)?),
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
                valor: v_dinero(g(1)?).unwrap_or(Dinero::CERO),
                unidades: v_i64(g(2)?).unwrap_or(0),
            };
            if momento == "DEJADO" {
                dto.dejado_denoms.push(item);
            } else {
                dto.contado_denoms.push(item);
            }
        }

        // CAJA-01. El `ID_Rectificacion` desempata dos correcciones del mismo segundo: es un UUIDv7,
        // que se ordena por el momento en que se generó.
        let mut rrows = db
            .query(
                r#"
                SELECT
                  r.ID_Rectificacion,
                  r.Fecha_Hora,
                  TRIM(COALESCE(u.Nombre,'') || CASE WHEN COALESCE(u.Apellido,'')='' THEN '' ELSE ' ' || u.Apellido END) AS Usuario_Nombre,
                  r.Descripcion,
                  r.Motivo,
                  r.Esperado_Antes,
                  r.Esperado_Despues,
                  r.Descuadre_Antes,
                  r.Descuadre_Despues
                FROM Cierre_Rectificaciones r
                LEFT JOIN Usuarios u ON u.ID_Usuario = r.ID_Usuario
                WHERE r.ID_Cierre = ?1
                ORDER BY r.Fecha_Hora ASC, r.ID_Rectificacion ASC;
                "#,
                vec![Value::Text(id_cierre.to_string())],
            )
            .await
            .map_err(db_err)?;

        while let Some(x) = rrows.next().await.map_err(db_err)? {
            let g = |i: i32| x.get_value(i).map_err(db_err);
            dto.rectificaciones.push(RectificacionDto {
                id_rectificacion: v_string(g(0)?).unwrap_or_default(),
                fecha_hora: v_string(g(1)?).unwrap_or_default(),
                usuario_nombre: norm_opt_string(g(2)?),
                descripcion: v_string(g(3)?).unwrap_or_default(),
                motivo: norm_opt_string(g(4)?),
                esperado_antes: v_dinero(g(5)?).unwrap_or(Dinero::CERO),
                esperado_despues: v_dinero(g(6)?).unwrap_or(Dinero::CERO),
                descuadre_antes: v_dinero(g(7)?).unwrap_or(Dinero::CERO),
                descuadre_despues: v_dinero(g(8)?).unwrap_or(Dinero::CERO),
            });
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
                vec![Value::Text(id_cierre.to_string()), texto_o_nulo(id_usuario)],
            )
            .await
            .map_err(db_err)?;

        Ok(n > 0)
    }

    async fn cierre_de_momento(&self, momento: &str) -> AppResult<Option<CierreDto>> {
        let db = self.db.read().await;
        // El periodo de un cierre es `(Periodo_Desde, Fecha_Hora]`: incluye el segundo del cierre,
        // porque el cobro de ese segundo entró en su arqueo. Los deshechos no cuentan: su periodo lo
        // contó el cierre siguiente.
        let mut rows = db
            .query(
                r#"
                SELECT c.ID_Cierre
                FROM Cierres_Caja c
                WHERE c.Reabierto_En IS NULL
                  AND (c.Periodo_Desde IS NULL OR datetime(?1) > datetime(c.Periodo_Desde))
                  AND datetime(?1) <= datetime(c.Fecha_Hora)
                ORDER BY c.Fecha_Hora ASC, c.ID_Cierre ASC
                LIMIT 1;
                "#,
                vec![Value::Text(momento.to_string())],
            )
            .await
            .map_err(db_err)?;
        let id = match rows.next().await.map_err(db_err)? {
            Some(r) => v_string(r.get_value(0).map_err(db_err)?).unwrap_or_default(),
            None => return Ok(None),
        };
        drop(rows);
        drop(db);
        self.detalle(&id).await
    }

    async fn apunte(&self, tipo: ApunteCaja, id: &str) -> AppResult<Option<ApunteGuardado>> {
        let db = self.db.read().await;
        let sql = match tipo {
            ApunteCaja::Pago => {
                r#"
                SELECT COALESCE(Fecha_Hora,''), IFNULL(Importe_Total,0), COALESCE(Metodo_Pago,''),
                       COALESCE(Estado,'ACTIVO'), Numero_Ticket
                FROM Pagos WHERE ID_Pago = ?1 LIMIT 1;
                "#
            }
            ApunteCaja::Gasto => {
                r#"
                SELECT COALESCE(Fecha,''), IFNULL(Importe,0), COALESCE(Pagado_Con_Caja,0),
                       COALESCE(Concepto,''), Momento_Caja
                FROM Cuentas_Gastos WHERE ID_Gasto = ?1 LIMIT 1;
                "#
            }
        };
        let mut rows = db
            .query(sql, vec![Value::Text(id.to_string())])
            .await
            .map_err(db_err)?;
        let Some(r) = rows.next().await.map_err(db_err)? else {
            return Ok(None);
        };
        let g = |i: i32| r.get_value(i).map_err(db_err);
        Ok(Some(match tipo {
            ApunteCaja::Pago => ApunteGuardado::Cobro {
                fecha_hora: v_string(g(0)?).unwrap_or_default(),
                importe: v_dinero(g(1)?).unwrap_or(Dinero::CERO),
                metodo: v_string(g(2)?).unwrap_or_default(),
                // Igual que el SQL de `totales`: activo es exactamente 'ACTIVO'.
                activo: v_string(g(3)?).as_deref() == Some("ACTIVO"),
                numero_ticket: norm_opt_string(g(4)?),
            },
            ApunteCaja::Gasto => ApunteGuardado::Gasto {
                fecha: v_string(g(0)?).unwrap_or_default(),
                importe: v_dinero(g(1)?).unwrap_or(Dinero::CERO),
                pagado_con_caja: v_i64(g(2)?).unwrap_or(0) != 0,
                concepto: v_string(g(3)?).unwrap_or_default(),
                momento_caja: norm_opt_string(g(4)?),
            },
        }))
    }

    async fn devoluciones_de(&self, id_pago: &str) -> AppResult<Vec<ApunteGuardado>> {
        let db = self.db.read().await;
        let mut rows = db
            .query(
                r#"
                SELECT COALESCE(Fecha_Hora,''), IFNULL(Importe_Total,0), COALESCE(Metodo_Pago,''),
                       Numero_Ticket
                FROM Pagos
                WHERE ID_Pago_Origen = ?1 AND Estado = 'ACTIVO'
                ORDER BY Fecha_Hora ASC, ID_Pago ASC;
                "#,
                vec![Value::Text(id_pago.to_string())],
            )
            .await
            .map_err(db_err)?;
        let mut out = Vec::new();
        while let Some(r) = rows.next().await.map_err(db_err)? {
            let g = |i: i32| r.get_value(i).map_err(db_err);
            out.push(ApunteGuardado::Cobro {
                fecha_hora: v_string(g(0)?).unwrap_or_default(),
                importe: v_dinero(g(1)?).unwrap_or(Dinero::CERO),
                metodo: v_string(g(2)?).unwrap_or_default(),
                activo: true,
                numero_ticket: norm_opt_string(g(3)?),
            });
        }
        Ok(out)
    }

    async fn guardar_rectificacion(&self, r: RectificacionNueva) -> AppResult<()> {
        let g = self.db.write().await;
        let conn = &g;
        // El id se genera ANTES del INSERT y viaja como valor: una `TEXT PRIMARY KEY` calculada
        // dentro de la sentencia se re-evaluaría al replicar (docs/arquitectura/sincronizacion.md).
        let id_rectificacion = new_id();

        // Las dos escrituras van juntas: un cierre que dice lo que marca hoy sin la fila que explica
        // por qué sería exactamente el número sin explicación que esto existe para evitar.
        let res: AppResult<()> = conn.transaccion(async {
            conn.execute(
                r#"
                UPDATE Cierres_Caja
                SET Rect_Ventas_Efectivo = ?2,
                    Rect_Gastos_Caja = ?3,
                    Rect_Esperado = ?4,
                    Rect_Descuadre = ?5
                WHERE ID_Cierre = ?1;
                "#,
                vec![
                    Value::Text(r.id_cierre.clone()),
                    dinero_val(r.totales.ventas_efectivo),
                    dinero_val(r.totales.gastos_caja),
                    dinero_val(r.esperado),
                    dinero_val(r.descuadre),
                ],
            )
            .await
            .map_err(db_err)?;

            conn.execute(
                r#"
                INSERT INTO Cierre_Rectificaciones (
                  ID_Rectificacion, ID_Cierre, Fecha_Hora, ID_Usuario, Descripcion, Motivo,
                  Esperado_Antes, Esperado_Despues, Descuadre_Antes, Descuadre_Despues
                ) VALUES (?1, ?2, datetime('now','localtime'), ?3, ?4, ?5, ?6, ?7, ?8, ?9);
                "#,
                vec![
                    Value::Text(id_rectificacion),
                    Value::Text(r.id_cierre.clone()),
                    texto_o_nulo(r.id_usuario.as_deref()),
                    Value::Text(r.descripcion.clone()),
                    texto_o_nulo(r.motivo.as_deref()),
                    dinero_val(r.esperado_antes),
                    dinero_val(r.esperado),
                    dinero_val(r.descuadre_antes),
                    dinero_val(r.descuadre),
                ],
            )
            .await
            .map_err(db_err)?;
            Ok(())
        }).await;

        res
    }
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)] // los nombres en mayúsculas señalan qué afirma cada test

    //! CAJA-01 contra una BD de verdad: que las sumas del periodo, el cierre al que pertenece un
    //! apunte y la rectificación guardada digan lo mismo que prometen el dominio y el caso de uso.

    use super::*;
    use crate::cuentas::SqliteCuentasRepository;
    use crate::ejecutor::Connection;
    use tpv_application::use_cases::{cierre_caja as cierre_uc, rectificacion_caja as rect};
    use tpv_contracts::cierre_caja::CambioCajaInput;
    use tpv_contracts::cuentas::CreateGastoInput;
    use tpv_contracts::errors::ErrorCode;
    use tpv_domain::cierre_caja::momento_de_gasto;

    /// Euros -> `Dinero`. Los supuestos se escriben en euros; lo que
    /// se compara son centimos.
    #[allow(dead_code)]
    fn eur(euros: f64) -> Dinero {
        Dinero::de_euros(euros)
    }

    async fn db_temporal() -> (Arc<Db>, std::path::PathBuf) {
        let dir = crate::test_temp::dir_temporal("cierre_caja");
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        (db, dir)
    }

    async fn sembrar(db: &Arc<Db>, sentencias: &[&str]) {
        let w = db.write().await;
        let conn: &Connection = w.raw();
        for sql in sentencias {
            conn.execute(sql, Vec::<Value>::new())
                .await
                .unwrap_or_else(|e| panic!("sembrando: {sql}\n{e}"));
        }
    }

    async fn contar(db: &Arc<Db>, sql: &str) -> i64 {
        let r = db.read().await;
        let mut rows = r.query(sql, Vec::<Value>::new()).await.unwrap();
        let row = rows.next().await.unwrap().expect("sin filas");
        v_i64(row.get_value(0).unwrap()).unwrap_or(0)
    }

    /// Quien firma: `Reabierto_Por`, `Movimientos_Caja.ID_Usuario` y la rectificación son FK.
    const USUARIO: &str = "INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre)
        VALUES ('u1', '00000000-0000-7000-8000-000000000001', 'jefe@bar.example', 'x', 'Marta');";

    /// Un cierre de las 23:00 que cuadró: 20 € cobrados en efectivo y 20 € contados.
    const CIERRE_CUADRADO: &str = "INSERT INTO Cierres_Caja (ID_Cierre, Fecha_Hora, ID_Usuario,
        Periodo_Desde, Fondo_Inicial, Ventas_Efectivo, Gastos_Caja, Esperado, Contado, Descuadre,
        Dejado, Retirado)
        VALUES ('c1', '2026-05-10 23:00:00', 'u1', '2026-05-09 23:00:00', 0, 2000, 0, 2000, 2000, 0, 0, 2000);";

    /// El cobro de ese cierre: 20 € en efectivo a las 21:30.
    const COBRO: &[&str] = &[
        "INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura, Estado)
           VALUES ('com', 'BARRA', '2026-05-10 21:00:00', 'Pagada');",
        "INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo)
           VALUES ('p1', 'com', '2026-05-10 21:30:00', 'Efectivo', 2000, 'TOTAL');",
    ];

    fn gasto(fecha: &str, importe: f64, pagado_con_caja: Option<bool>) -> CreateGastoInput {
        CreateGastoInput {
            id_gasto: None,
            fecha: fecha.into(),
            tipo_gasto: "Suministros".into(),
            concepto: "Hielo".into(),
            importe: eur(importe),
            proveedor_id: None,
            pagado_con_caja,
        }
    }

    /// Anula el cobro `p1` como devolución, tal y como lo deja `cuentas::anular_pago`.
    async fn devolver_p1_en(db: &Arc<Db>, cuando: &str) {
        sembrar(
            db,
            &[&format!(
                "UPDATE Pagos SET Estado='ANULADO', Motivo_Baja='DEVOLUCION',
                        Anulado_En='{cuando}', Anulado_Por='u1', Motivo_Anulacion='no le gustó'
                  WHERE ID_Pago='p1';"
            )],
        )
        .await;
    }

    #[tokio::test]
    async fn una_devolucion_de_otro_dia_sale_del_cajon_de_HOY() {
        // REV-08. La venta fue el día 10 y se cerró esa noche con el dinero dentro; el arqueo del
        // 10 estaba bien. El día 12 se devuelve: salen 20 € del cajón de HOY. Como aquel cobro ya
        // no está en el periodo abierto, no lo restaba nadie y el arqueo de hoy salía con 20 € de
        // falta — una operación normal produciendo un descuadre que hay que ir a investigar.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, &[USUARIO]).await;
        sembrar(&db, COBRO).await;
        sembrar(&db, &[CIERRE_CUADRADO]).await;
        devolver_p1_en(&db, "2026-05-12 13:00:00").await;

        let caja = SqliteCierreCajaRepository::new(db.clone());
        let t = caja.totales_desde(Some("2026-05-10 23:00:00")).await.unwrap();

        assert_eq!(t.ventas_efectivo, eur(-20.0), "el dinero sale del periodo abierto");
    }

    #[tokio::test]
    async fn devolver_dentro_del_MISMO_periodo_no_resta_dos_veces() {
        // El caso que hace falso lo obvio. Si se vende y se devuelve antes de cerrar, el cobro ya
        // deja de sumar al dejar de ser 'ACTIVO' —entró y salió, neto cero—: restarlo otra vez
        // dejaría el esperado en -20 y el arqueo saldría con 20 € de sobra.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, &[USUARIO]).await;
        sembrar(&db, COBRO).await;
        devolver_p1_en(&db, "2026-05-10 22:00:00").await;

        let caja = SqliteCierreCajaRepository::new(db.clone());
        // Sin cierre anterior, y con uno anterior a la venta: en los dos casos el neto es cero.
        assert_eq!(caja.totales_desde(None).await.unwrap().ventas_efectivo, Dinero::CERO);
        assert_eq!(
            caja.totales_desde(Some("2026-05-09 23:00:00")).await.unwrap().ventas_efectivo,
            Dinero::CERO
        );
    }

    #[tokio::test]
    async fn una_anulacion_por_ERROR_no_sale_del_cajon_de_hoy() {
        // La otra mitad, y la que impide que esto se convierta en «restar toda baja». Anular por
        // error dice que aquel cobro no debió existir: el dinero no salió hoy de ninguna parte, lo
        // que hay que corregir es el arqueo de aquella noche, y de eso se encarga la rectificación.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, &[USUARIO]).await;
        sembrar(&db, COBRO).await;
        sembrar(&db, &[CIERRE_CUADRADO]).await;
        sembrar(
            &db,
            &["UPDATE Pagos SET Estado='ANULADO', Motivo_Baja='ERROR',
                      Anulado_En='2026-05-12 13:00:00', Anulado_Por='u1', Motivo_Anulacion='mesa equivocada'
                WHERE ID_Pago='p1';"],
        )
        .await;

        let caja = SqliteCierreCajaRepository::new(db.clone());
        let t = caja.totales_desde(Some("2026-05-10 23:00:00")).await.unwrap();

        assert_eq!(t.ventas_efectivo, Dinero::CERO);
    }

    #[tokio::test]
    async fn devolver_una_venta_con_TARJETA_no_toca_el_cajon() {
        // El dinero vuelve por donde vino. El filtro es el mismo de siempre, pero conviene fijarlo:
        // la resta nueva tenía que heredarlo y no heredarlo habría metido las tarjetas en el arqueo.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, &[USUARIO]).await;
        sembrar(&db, COBRO).await;
        sembrar(&db, &["UPDATE Pagos SET Metodo_Pago='Tarjeta' WHERE ID_Pago='p1';"]).await;
        sembrar(&db, &[CIERRE_CUADRADO]).await;
        devolver_p1_en(&db, "2026-05-12 13:00:00").await;

        let caja = SqliteCierreCajaRepository::new(db.clone());
        assert_eq!(
            caja.totales_desde(Some("2026-05-10 23:00:00")).await.unwrap().ventas_efectivo,
            Dinero::CERO
        );
    }

    #[tokio::test]
    async fn una_devolucion_NO_rectifica_el_cierre_de_la_venta() {
        // La otra mitad del descuadre doble: aquel arqueo estaba bien —el dinero sí estuvo en el
        // cajón esa noche—, así que rectificarlo le inventa un sobrante de 20 € que nunca hubo.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, &[USUARIO]).await;
        sembrar(&db, COBRO).await;
        sembrar(&db, &[CIERRE_CUADRADO]).await;

        let caja = SqliteCierreCajaRepository::new(db.clone());
        let impacto = rect::previsualizar(
            &caja,
            &CambioCajaInput::AnularPago {
                id_pago: "p1".into(),
                clase: Some("DEVOLUCION".into()),
            },
        )
        .await
        .unwrap();

        assert!(impacto.cierres.is_empty(), "una devolución no toca ningún cierre hecho");
        assert!(!impacto.requiere_motivo);
    }

    #[tokio::test]
    async fn una_anulacion_por_ERROR_si_lo_rectifica() {
        // Y aquí sí: el esperado de aquella noche contaba un dinero que no estaba, o sea que el
        // arqueo salió mal y hay que corregirlo.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, &[USUARIO]).await;
        sembrar(&db, COBRO).await;
        sembrar(&db, &[CIERRE_CUADRADO]).await;

        let caja = SqliteCierreCajaRepository::new(db.clone());
        for clase in [None, Some("ERROR".to_string())] {
            let impacto = rect::previsualizar(
                &caja,
                &CambioCajaInput::AnularPago { id_pago: "p1".into(), clase },
            )
            .await
            .unwrap();

            assert_eq!(impacto.cierres.len(), 1, "tiene que tocar el cierre de esa noche");
            assert_eq!(impacto.cierres[0].esperado_despues, Dinero::CERO);
            assert_eq!(impacto.cierres[0].descuadre_despues, eur(20.0));
        }
    }

    /// Una devolución de parte de `p1` (5 € de los 20) el día 11, por `metodo`, y el cierre de esa
    /// noche, que la contó: 10 € de fondo, -5 de ventas, 5 € esperados y contados.
    fn devolucion_de_p1_el_11(metodo: &str) -> Vec<String> {
        vec![
            format!(
                "INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo,
                   ID_Pago_Origen, Motivo_Devolucion)
                 VALUES ('p1-dev', 'com', '2026-05-11 12:00:00', '{metodo}', -500, 'DEVOLUCION', 'p1', 'fría');"
            ),
            "INSERT INTO Cierres_Caja (ID_Cierre, Fecha_Hora, ID_Usuario, Periodo_Desde, Fondo_Inicial,
                Ventas_Efectivo, Gastos_Caja, Esperado, Contado, Descuadre, Dejado, Retirado)
             VALUES ('c2', '2026-05-11 23:00:00', 'u1', '2026-05-10 23:00:00', 1000, -500, 0, 500, 500, 0, 0, 500);"
                .to_string(),
        ]
    }

    #[tokio::test]
    async fn una_devolucion_parcial_resta_de_SU_periodo_solo_si_salio_en_efectivo() {
        // Es un cobro negativo, activo, del día que se devuelve: el periodo del 11 lo resta solo, y
        // el del 10 —el de la venta— no se entera. Por el datáfono o por transferencia, el dinero no
        // sale del cajón.
        for (metodo, ventas_del_11) in [("Efectivo", -5.0), ("Tarjeta", 0.0), ("Otro", 0.0)] {
            let (db, _dir) = db_temporal().await;
            sembrar(&db, &[USUARIO]).await;
            sembrar(&db, COBRO).await;
            let dev = devolucion_de_p1_el_11(metodo);
            sembrar(&db, &[dev[0].as_str()]).await;

            let caja = SqliteCierreCajaRepository::new(db.clone());
            let del_10 = {
                let r = db.read().await;
                totales_entre(&r, Some("2026-05-09 23:00:00"), Some("2026-05-10 23:00:00")).await.unwrap()
            };
            let del_11 = caja.totales_desde(Some("2026-05-10 23:00:00")).await.unwrap();
            assert_eq!(del_10.ventas_efectivo, eur(20.0), "{metodo}");
            assert_eq!(del_11.ventas_efectivo, eur(ventas_del_11), "{metodo}");
        }
    }

    #[tokio::test]
    async fn la_baja_por_error_de_un_cobro_con_devoluciones_rectifica_tambien_el_cierre_de_la_devolucion() {
        // La baja por error deshace sus devoluciones: si la venta no existió, el dinero devuelto de
        // ella tampoco salió por una venta. El cierre del 10 contaba 20 € que no estaban, y el del
        // 11 restaba 5 € de una devolución que deja de existir: los dos se rectifican.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, &[USUARIO]).await;
        sembrar(&db, COBRO).await;
        sembrar(&db, &[CIERRE_CUADRADO]).await;
        let dev = devolucion_de_p1_el_11("Efectivo");
        sembrar(&db, &dev.iter().map(String::as_str).collect::<Vec<_>>()).await;

        let caja = SqliteCierreCajaRepository::new(db.clone());
        let impacto = rect::previsualizar(
            &caja,
            &CambioCajaInput::AnularPago { id_pago: "p1".into(), clase: Some("ERROR".into()) },
        )
        .await
        .unwrap();

        let de = |id: &str| impacto.cierres.iter().find(|c| c.id_cierre == id).cloned();
        let c1 = de("c1").expect("el cierre de la venta");
        assert_eq!((c1.esperado_despues, c1.descuadre_despues), (Dinero::CERO, eur(20.0)));
        let c2 = de("c2").expect("el cierre de la devolución");
        assert_eq!((c2.esperado_antes, c2.esperado_despues), (eur(5.0), eur(10.0)));
        assert_eq!(c2.descuadre_despues, eur(-5.0));
        assert_eq!(impacto.cierres.len(), 2);
        assert!(impacto.requiere_motivo);
    }

    #[tokio::test]
    async fn solo_restan_los_gastos_que_salieron_del_cajon() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, COBRO).await;
        sembrar(
            &db,
            &["INSERT INTO Cuentas_Gastos (ID_Gasto, Fecha, Concepto, Importe, Tipo_Gasto, Pagado_Con_Caja)
                 VALUES ('g1', '2026-05-10', 'Hielo', 1800, 'Suministros', 1),
                        ('g2', '2026-05-10', 'Barril', 40000, 'Proveedor', 0);"],
        )
        .await;

        let t = SqliteCierreCajaRepository::new(db.clone()).totales_desde(None).await.unwrap();
        assert_eq!(t, TotalesCaja { ventas_efectivo: eur(20.0), gastos_caja: eur(18.0) });
    }

    #[tokio::test]
    async fn un_gasto_de_la_tarde_cae_en_el_cierre_de_esa_noche_aunque_se_cierre_de_madrugada() {
        // El bar cierra a la 01:30 del día siguiente. El gasto del 10 es del servicio del 10, que
        // se cierra la madrugada del 11 — no del de la madrugada del 10.
        let (db, _dir) = db_temporal().await;
        sembrar(
            &db,
            &[
                "INSERT INTO Cierres_Caja (ID_Cierre, Fecha_Hora) VALUES ('a', '2026-05-10 01:30:00');",
                "INSERT INTO Cierres_Caja (ID_Cierre, Fecha_Hora, Periodo_Desde)
                   VALUES ('b', '2026-05-11 01:30:00', '2026-05-10 01:30:00');",
            ],
        )
        .await;
        let repo = SqliteCierreCajaRepository::new(db.clone());

        let de_gasto = momento_de_gasto("2026-05-10").unwrap();
        let c = repo.cierre_de_momento(&de_gasto).await.unwrap().unwrap();
        assert_eq!(c.id_cierre, "b");

        let c = repo.cierre_de_momento("2026-05-10 01:00:00").await.unwrap().unwrap();
        assert_eq!(c.id_cierre, "a", "lo de antes del primer cierre es del primero");

        assert!(
            repo.cierre_de_momento("2026-05-12 10:00:00").await.unwrap().is_none(),
            "después del último cierre es el periodo abierto"
        );
    }

    #[tokio::test]
    async fn cambiar_de_metodo_un_cobro_de_un_cierre_hecho_se_ve_antes_de_hacerlo() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, &[USUARIO, CIERRE_CUADRADO]).await;
        sembrar(&db, COBRO).await;
        let repo = SqliteCierreCajaRepository::new(db.clone());

        let a_tarjeta = CambioCajaInput::EditarPago {
            id_pago: "p1".into(),
            fecha_hora: "2026-05-10 21:30:00".into(),
            metodo: "Tarjeta".into(),
        };
        let imp = rect::previsualizar(&repo, &a_tarjeta).await.unwrap();
        assert_eq!(imp.cierres.len(), 1);
        let c = &imp.cierres[0];
        assert_eq!((c.esperado_antes, c.descuadre_antes), (eur(20.0), Dinero::CERO));
        // Esa noche el cajón debería haber tenido 0 € y había 20: sobran 20.
        assert_eq!((c.esperado_despues, c.descuadre_despues), (Dinero::CERO, eur(20.0)));
        assert!(imp.requiere_motivo);

        // Llevárselo al periodo abierto también descuadra el cierre del que sale.
        let a_hoy = CambioCajaInput::EditarPago {
            id_pago: "p1".into(),
            fecha_hora: "2026-05-11 10:00".into(),
            metodo: "Efectivo".into(),
        };
        let imp = rect::previsualizar(&repo, &a_hoy).await.unwrap();
        assert_eq!(imp.cierres.len(), 1);
        assert_eq!(imp.cierres[0].descuadre_despues, eur(20.0));

        // Y previsualizar no toca nada.
        assert!(repo.detalle("c1").await.unwrap().unwrap().rect_esperado.is_none());
    }

    #[tokio::test]
    async fn un_gasto_de_caja_apuntado_tarde_rectifica_el_cierre_y_guarda_la_foto() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, &[USUARIO, CIERRE_CUADRADO]).await;
        sembrar(&db, COBRO).await;
        let cierres = SqliteCierreCajaRepository::new(db.clone());
        let cuentas = SqliteCuentasRepository::new(db.clone());

        let ok = rect::crear_gasto(
            &cuentas,
            &cierres,
            "u1",
            gasto("2026-05-10", 5.0, Some(true)),
            Some("  el hielo de la tarde  ".into()),
        )
        .await
        .unwrap();
        assert!(ok);

        let c = cierres.detalle("c1").await.unwrap().unwrap();
        // La foto de esa noche no se toca…
        assert_eq!((c.esperado, c.descuadre), (eur(20.0), Dinero::CERO));
        // …y al lado queda lo que marca hoy.
        assert_eq!(c.rect_gastos_caja, Some(eur(5.0)));
        assert_eq!(c.rect_esperado, Some(eur(15.0)));
        assert_eq!(c.rect_descuadre, Some(eur(5.0)));

        assert_eq!(c.rectificaciones.len(), 1);
        let r = &c.rectificaciones[0];
        assert_eq!((r.descuadre_antes, r.descuadre_despues), (Dinero::CERO, eur(5.0)));
        assert_eq!(r.motivo.as_deref(), Some("el hielo de la tarde"));
        assert_eq!(r.usuario_nombre.as_deref(), Some("Marta"));
        assert!(r.descripcion.contains("Hielo"), "{}", r.descripcion);

        let lista = cierres.listar(10).await.unwrap();
        assert_eq!(lista[0].rect_descuadre, Some(eur(5.0)));
    }

    /// Un cierre de la madrugada del 11, a la 01:30, que empieza en el de la noche del 10.
    const CIERRE_DE_MADRUGADA: &str = "INSERT INTO Cierres_Caja (ID_Cierre, Fecha_Hora, ID_Usuario,
        Periodo_Desde, Fondo_Inicial, Ventas_Efectivo, Gastos_Caja, Esperado, Contado, Descuadre,
        Dejado, Retirado)
        VALUES ('c2', '2026-05-11 01:30:00', 'u1', '2026-05-10 23:00:00', 0, 0, 500, -500, 0, 500, 0, 0);";

    /// El hielo que se pagó del cajón a la 01:20 del día 11, apuntado en ese momento.
    const GASTO_DE_MADRUGADA: &str = "INSERT INTO Cuentas_Gastos (ID_Gasto, Fecha, Concepto, Importe,
        Tipo_Gasto, Pagado_Con_Caja, Momento_Caja)
        VALUES ('g-1h', '2026-05-11', 'Hielo', 500, 'Suministros', 1, '2026-05-11 01:20:00');";

    #[tokio::test]
    async fn un_gasto_apuntado_de_madrugada_cuenta_en_el_cierre_de_esa_madrugada() {
        // CAJ-INC-01. Con sólo el día, el gasto del 11 contaba a las 12:00 del 11: después del
        // cierre de la 01:30, que es cuando salió el dinero. Con su hora de caja, cuenta en él.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, &[GASTO_DE_MADRUGADA]).await;

        let t = totales_entre(&db.read().await, Some("2026-05-10 23:00:00"), Some("2026-05-11 01:30:00"))
            .await
            .unwrap();
        assert_eq!(t.gastos_caja, eur(5.0));
        let siguiente = totales_entre(&db.read().await, Some("2026-05-11 01:30:00"), None).await.unwrap();
        assert_eq!(siguiente.gastos_caja, Dinero::CERO, "y no lo vuelve a contar el siguiente");
    }

    #[tokio::test]
    async fn corregir_un_gasto_de_madrugada_rectifica_el_cierre_en_que_conto() {
        // La rectificación busca el cierre por la misma hora que el arqueo: si no, el gasto contaría
        // en un cierre y corregirlo rectificaría otro (o ninguno).
        let (db, _dir) = db_temporal().await;
        sembrar(&db, &[USUARIO, CIERRE_DE_MADRUGADA, GASTO_DE_MADRUGADA]).await;
        let caja = SqliteCierreCajaRepository::new(db.clone());

        let impacto = rect::previsualizar(
            &caja,
            &CambioCajaInput::EditarGasto {
                id_gasto: "g-1h".into(),
                fecha: "2026-05-11".into(),
                importe: eur(8.0),
                pagado_con_caja: true,
            },
        )
        .await
        .unwrap();

        assert_eq!(impacto.cierres.len(), 1);
        assert_eq!(impacto.cierres[0].id_cierre, "c2");
        assert_eq!(impacto.cierres[0].esperado_despues, eur(-8.0));
    }

    /// La hora de caja guardada de un gasto.
    async fn momento_caja(db: &Arc<Db>, id: &str) -> Option<String> {
        let r = db.read().await;
        let mut rows = r
            .query(
                "SELECT Momento_Caja FROM Cuentas_Gastos WHERE ID_Gasto = ?1;",
                vec![Value::Text(id.into())],
            )
            .await
            .unwrap();
        norm_opt_string(rows.next().await.unwrap().unwrap().get_value(0).unwrap())
    }

    #[tokio::test]
    async fn un_gasto_guarda_su_hora_de_caja_al_apuntarlo_y_al_cambiarlo_de_dia() {
        // CAJ-INC-01. La pone quien escribe: de hoy, la hora de apuntarlo; de otro día, ese día a
        // las 12:00. Cambiar el importe no la mueve; cambiar el día, sí.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, &[USUARIO]).await;
        let cuentas = SqliteCuentasRepository::new(db.clone());
        let hoy = chrono::Local::now().format("%Y-%m-%d").to_string();
        let antes = como_hora_de_caja(chrono::Local::now());

        let mut de_hoy = gasto(&hoy, 5.0, Some(true));
        de_hoy.id_gasto = Some("g-hoy".into());
        tpv_application::use_cases::cuentas::create_gasto(&cuentas, Some("u1"), de_hoy).await.unwrap();
        let m = momento_caja(&db, "g-hoy").await.expect("un gasto de hoy lleva su hora");
        assert!(m.starts_with(&hoy) && m.as_str() >= antes.as_str(), "{m} es la hora de apuntarlo");

        let mut de_ayer = gasto("2026-05-10", 5.0, Some(true));
        de_ayer.id_gasto = Some("g-otro".into());
        tpv_application::use_cases::cuentas::create_gasto(&cuentas, Some("u1"), de_ayer).await.unwrap();
        assert_eq!(momento_caja(&db, "g-otro").await.as_deref(), Some("2026-05-10 12:00:00"));

        let editar = |id: &str, fecha: &str, importe: f64| tpv_contracts::cuentas::UpdateGastoInput {
            id_gasto: id.into(),
            fecha: fecha.into(),
            tipo_gasto: "Suministros".into(),
            concepto: "Hielo".into(),
            importe: eur(importe),
            proveedor_id: None,
            pagado_con_caja: Some(true),
        };
        tpv_application::use_cases::cuentas::update_gasto(&cuentas, editar("g-hoy", &hoy, 7.0))
            .await
            .unwrap();
        assert_eq!(momento_caja(&db, "g-hoy").await.as_deref(), Some(m.as_str()), "mismo día, misma hora");

        tpv_application::use_cases::cuentas::update_gasto(&cuentas, editar("g-hoy", "2026-05-09", 7.0))
            .await
            .unwrap();
        assert_eq!(momento_caja(&db, "g-hoy").await.as_deref(), Some("2026-05-09 12:00:00"));
    }

    #[tokio::test]
    async fn si_cambia_un_descuadre_sin_motivo_no_se_toca_nada() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, &[USUARIO, CIERRE_CUADRADO]).await;
        let cierres = SqliteCierreCajaRepository::new(db.clone());
        let cuentas = SqliteCuentasRepository::new(db.clone());

        let e = rect::crear_gasto(&cuentas, &cierres, "u1", gasto("2026-05-10", 5.0, Some(true)), None)
            .await
            .unwrap_err();
        assert_eq!(e.code(), ErrorCode::Validation);
        assert_eq!(contar(&db, "SELECT COUNT(*) FROM Cuentas_Gastos;").await, 0);
    }

    #[tokio::test]
    async fn un_gasto_pagado_por_banco_no_rectifica_ni_pide_motivo() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, &[USUARIO, CIERRE_CUADRADO]).await;
        let cierres = SqliteCierreCajaRepository::new(db.clone());
        let cuentas = SqliteCuentasRepository::new(db.clone());

        assert!(rect::crear_gasto(&cuentas, &cierres, "u1", gasto("2026-05-10", 400.0, None), None)
            .await
            .unwrap());

        let c = cierres.detalle("c1").await.unwrap().unwrap();
        assert!(c.rect_esperado.is_none());
        assert!(c.rectificaciones.is_empty());
    }

    #[tokio::test]
    async fn con_el_historico_a_medias_se_rectifica_con_lo_que_dice_el_cierre() {
        // Tras recuperar un equipo, los cobros antiguos bajan por partes (SYNC-19, fase 2). Aquí el
        // cierre dice que cobró 20 € en efectivo pero su cobro todavía no ha llegado. Un gasto de caja
        // de 5 € apuntado tarde tiene que dejarlo en 15 € de esperado: si se volviera a sumar el
        // periodo desde la BD saldría -5 €, y la rectificación grabaría un descuadre de 25 € falso.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, &[USUARIO, CIERRE_CUADRADO]).await;
        let cierres = SqliteCierreCajaRepository::new(db.clone());
        let cuentas = SqliteCuentasRepository::new(db.clone());

        rect::crear_gasto(&cuentas, &cierres, "u1", gasto("2026-05-10", 5.0, Some(true)), Some("hielo".into()))
            .await
            .unwrap();

        let c = cierres.detalle("c1").await.unwrap().unwrap();
        assert_eq!(c.rect_ventas_efectivo, Some(eur(20.0)));
        assert_eq!(c.rect_esperado, Some(eur(15.0)));
        assert_eq!(c.rect_descuadre, Some(eur(5.0)));
    }

    #[tokio::test]
    async fn la_segunda_correccion_parte_de_la_primera() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, &[USUARIO, CIERRE_CUADRADO]).await;
        let cierres = SqliteCierreCajaRepository::new(db.clone());
        let cuentas = SqliteCuentasRepository::new(db.clone());

        for importe in [5.0, 3.0] {
            rect::crear_gasto(&cuentas, &cierres, "u1", gasto("2026-05-10", importe, Some(true)), Some("x".into()))
                .await
                .unwrap();
        }

        let c = cierres.detalle("c1").await.unwrap().unwrap();
        assert_eq!(c.rect_gastos_caja, Some(eur(8.0)));
        assert_eq!(c.rect_esperado, Some(eur(12.0)));
        assert_eq!(c.rectificaciones.len(), 2);
        // Cada fila dice de dónde partía ella, no la foto de esa noche.
        assert_eq!(c.rectificaciones[1].descuadre_antes, eur(5.0));
        assert_eq!(c.rectificaciones[1].descuadre_despues, eur(8.0));
    }

    #[tokio::test]
    async fn solo_se_deshace_el_ultimo_cierre() {
        let (db, _dir) = db_temporal().await;
        sembrar(
            &db,
            &[
                USUARIO,
                "INSERT INTO Cierres_Caja (ID_Cierre, Fecha_Hora) VALUES ('a', '2026-05-10 23:00:00');",
                "INSERT INTO Cierres_Caja (ID_Cierre, Fecha_Hora, Periodo_Desde)
                   VALUES ('b', '2026-05-11 23:00:00', '2026-05-10 23:00:00');",
            ],
        )
        .await;
        let repo = SqliteCierreCajaRepository::new(db.clone());

        let e = cierre_uc::reabrir(&repo, "a", Some("u1")).await.unwrap_err();
        assert_eq!(e.code(), ErrorCode::Conflict);
        assert!(cierre_uc::reabrir(&repo, "b", Some("u1")).await.unwrap());
    }

    // ── RI-58: una sola vez y en una sola transacción ──

    /// Un arqueo de 20 € en dos billetes de 10, sin fondo y sin dejar nada.
    fn arqueo_de_20(id: &str, motivo: Option<&str>) -> tpv_contracts::cierre_caja::ConfirmarCierreInput {
        tpv_contracts::cierre_caja::ConfirmarCierreInput {
            id_cierre: id.into(),
            fondo_inicial: None,
            contado: vec![tpv_contracts::cierre_caja::DenominacionInput { valor: eur(10.0), unidades: 2 }],
            dejado: vec![],
            motivo: motivo.map(str::to_string),
            esperado_visto: None,
        }
    }

    /// Mañana, en el formato de `Cuentas_Gastos.Fecha`.
    fn manana() -> String {
        (chrono::Local::now() + chrono::Duration::days(1)).format("%Y-%m-%d").to_string()
    }

    #[tokio::test]
    async fn la_preparacion_suma_hasta_AHORA_como_el_cierre() {
        // CAJ-INC-01. Un gasto de caja cuya hora de caja aún no ha llegado (mañana a las 12:00)
        // no es de este periodo para el cierre, que corta en su propia hora. La preparación lo
        // sumaba —no tenía límite superior— y enseñaba un esperado que luego no se guardaba.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, &[USUARIO, COBRO[0], COBRO[1]]).await;
        sembrar(
            &db,
            &[&format!(
                "INSERT INTO Cuentas_Gastos (ID_Gasto, Fecha, Concepto, Importe, Tipo_Gasto, Pagado_Con_Caja)
                 VALUES ('g-manana', '{}', 'Hielo', 500, 'Suministros', 1);",
                manana()
            )],
        )
        .await;
        let repo = SqliteCierreCajaRepository::new(db.clone());

        let prep = cierre_uc::preparar(&repo, Dinero::CERO, None).await.unwrap();
        assert_eq!(prep.gastos_caja, Dinero::CERO, "el gasto de mañana no es de este periodo");
        assert_eq!(prep.esperado, eur(20.0));

        let mut arqueo = arqueo_de_20("cierre-1", None);
        arqueo.esperado_visto = Some(prep.esperado);
        let c = cierre_uc::confirmar(&repo, Some("u1"), arqueo, Dinero::CERO).await.unwrap();
        assert_eq!(c.esperado, prep.esperado, "se guarda lo que se enseñó");
    }

    #[tokio::test]
    async fn si_el_esperado_cambio_mientras_se_contaba_no_se_cierra() {
        // CAJ-INC-01, la red: la pantalla enseñó 20 € y, al confirmar, el backend suma 25 € (un
        // cobro entró mientras se contaba). No se guarda nada y se pide revisar.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, &[USUARIO, COBRO[0], COBRO[1]]).await;
        let repo = SqliteCierreCajaRepository::new(db.clone());
        sembrar(
            &db,
            &["INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo)
                 VALUES ('p2', 'com', '2026-05-10 22:00:00', 'Efectivo', 500, 'TOTAL');"],
        )
        .await;

        let mut arqueo = arqueo_de_20("cierre-1", Some("faltan 5"));
        arqueo.esperado_visto = Some(eur(20.0));
        let e = cierre_uc::confirmar(&repo, Some("u1"), arqueo, Dinero::CERO).await.unwrap_err();

        assert_eq!(e.code(), ErrorCode::Conflict);
        assert_eq!(e.to_string(), cierre_uc::ESPERADO_CAMBIADO);
        assert_eq!(contar(&db, "SELECT COUNT(*) FROM Cierres_Caja;").await, 0);
    }

    #[tokio::test]
    async fn confirmar_DOS_VECES_con_el_mismo_id_guarda_un_solo_cierre() {
        // El doble clic o el reintento tras una respuesta que no llegó. Antes cada llamada generaba
        // su id y el segundo arqueo salía con un periodo casi vacío y su descuadre.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, &[USUARIO, COBRO[0], COBRO[1]]).await;
        let repo = SqliteCierreCajaRepository::new(db.clone());

        let a = cierre_uc::confirmar(&repo, Some("u1"), arqueo_de_20("cierre-1", None), Dinero::CERO)
            .await
            .unwrap();
        let b = cierre_uc::confirmar(&repo, Some("u1"), arqueo_de_20("cierre-1", None), Dinero::CERO)
            .await
            .unwrap();

        assert_eq!(a.id_cierre, b.id_cierre);
        assert_eq!(a.fecha_hora, b.fecha_hora, "el segundo devuelve el que ya estaba");
        assert_eq!(contar(&db, "SELECT COUNT(*) FROM Cierres_Caja;").await, 1);
        assert_eq!(contar(&db, "SELECT COUNT(*) FROM Cierre_Denominaciones;").await, 1);
    }

    #[tokio::test]
    async fn la_hora_del_cierre_es_tambien_el_LIMITE_de_sus_cifras() {
        // Lo que tenga una hora posterior a la del cierre es del periodo siguiente, no de este: el
        // cierre suma hasta su propia `Fecha_Hora` inclusive y el siguiente empieza ahí en exclusiva.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, &[USUARIO, COBRO[0], COBRO[1]]).await;
        sembrar(
            &db,
            &["INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo)
                 VALUES ('p-futuro', 'com', '2099-01-01 00:00:00', 'Efectivo', 5000, 'TOTAL');"],
        )
        .await;
        let repo = SqliteCierreCajaRepository::new(db.clone());

        let c = cierre_uc::confirmar(&repo, Some("u1"), arqueo_de_20("cierre-1", None), Dinero::CERO)
            .await
            .unwrap();

        assert_eq!(c.ventas_efectivo, eur(20.0), "el cobro de 2099 no es de este periodo");
        assert_eq!(c.descuadre, Dinero::CERO);
    }

    #[tokio::test]
    async fn un_cierre_rechazado_no_deja_NADA_a_medias() {
        // Un descuadre por encima del umbral sin motivo: no se guarda ni el cierre ni su recuento.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, &[USUARIO, COBRO[0], COBRO[1]]).await;
        let repo = SqliteCierreCajaRepository::new(db.clone());
        let mut faltan_15 = arqueo_de_20("cierre-1", None);
        faltan_15.contado = vec![tpv_contracts::cierre_caja::DenominacionInput { valor: eur(5.0), unidades: 1 }];

        let e = cierre_uc::confirmar(&repo, Some("u1"), faltan_15, Dinero::CERO).await.unwrap_err();

        assert_eq!(e.code(), ErrorCode::Validation);
        assert_eq!(contar(&db, "SELECT COUNT(*) FROM Cierres_Caja;").await, 0);
        assert_eq!(contar(&db, "SELECT COUNT(*) FROM Cierre_Denominaciones;").await, 0);
    }

    #[tokio::test]
    async fn dos_cierres_VIGENTES_no_pueden_empezar_en_el_mismo_sitio() {
        // `idx_cierres_un_periodo`, la red de seguridad. Deshacer el primero sí deja volver a
        // cerrar desde el mismo punto.
        let (db, _dir) = db_temporal().await;
        sembrar(
            &db,
            &["INSERT INTO Cierres_Caja (ID_Cierre, Fecha_Hora, Periodo_Desde)
                 VALUES ('a', '2026-05-10 23:00:00', '2026-05-09 23:00:00');"],
        )
        .await;
        let w = db.write().await;
        let duplicado = w
            .raw()
            .execute(
                "INSERT INTO Cierres_Caja (ID_Cierre, Fecha_Hora, Periodo_Desde)
                 VALUES ('b', '2026-05-10 23:00:05', '2026-05-09 23:00:00');",
                Vec::<Value>::new(),
            )
            .await;
        assert!(duplicado.is_err(), "dos cierres vigentes del mismo periodo");
        drop(w);

        sembrar(
            &db,
            &[
                "UPDATE Cierres_Caja SET Reabierto_En = '2026-05-10 23:01:00' WHERE ID_Cierre = 'a';",
                "INSERT INTO Cierres_Caja (ID_Cierre, Fecha_Hora, Periodo_Desde)
                   VALUES ('b', '2026-05-10 23:05:00', '2026-05-09 23:00:00');",
            ],
        )
        .await;
        assert_eq!(contar(&db, "SELECT COUNT(*) FROM Cierres_Caja;").await, 2);
    }

    #[tokio::test]
    async fn sin_cobrar_cuenta_solo_lo_que_queda_por_cobrar_y_separa_mesas_y_barra() {
        // CAJ-INC-04. El aviso decía «3 mesas sin cobrar» con un ticket de barra vacío, una mesa
        // ya cobrada que nadie había cerrado y una mesa de verdad.
        let (db, _dir) = db_temporal().await;
        sembrar(
            &db,
            &[
                "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z', 'Salon');",
                "INSERT INTO Mesas (ID_Mesa, ID_Zona, Numero_Mesa, Capacidad, Ubicacion_X, Ubicacion_Y, Shape, Width, Height)
                   VALUES ('m1', 'z', '1', 4, 0, 0, 'rect', 10, 10), ('m2', 'z', '2', 4, 0, 0, 'rect', 10, 10);",
                "INSERT INTO Comandas (ID_Comanda, Canal, ID_Mesa, Fecha_Hora_Apertura, Estado) VALUES
                   ('mesa-pendiente', 'MESA', 'm1', '2026-05-10 20:00:00', 'Abierta'),
                   ('mesa-cobrada', 'MESA', 'm2', '2026-05-10 20:00:00', 'Abierta'),
                   ('barra-pendiente', 'BARRA', NULL, '2026-05-10 20:00:00', 'Abierta'),
                   ('barra-vacia', 'BARRA', NULL, '2026-05-10 20:00:00', 'Abierta'),
                   ('barra-pagada', 'BARRA', NULL, '2026-05-10 20:00:00', 'Pagada');",
                "INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, Cantidad, Precio_Unitario) VALUES
                   ('d1', 'mesa-pendiente', 1, 300), ('d2', 'mesa-cobrada', 1, 300),
                   ('d3', 'barra-pendiente', 1, 300), ('d4', 'barra-pagada', 1, 300);",
                "INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo)
                   VALUES ('p-m2', 'mesa-cobrada', '2026-05-10 21:00:00', 'Efectivo', 300, 'TOTAL');",
                "INSERT INTO Pago_Detalles (ID_Pago, ID_Detalle) VALUES ('p-m2', 'd2');",
            ],
        )
        .await;
        let repo = SqliteCierreCajaRepository::new(db.clone());

        let prep = cierre_uc::preparar(&repo, Dinero::CERO, None).await.unwrap();

        assert_eq!((prep.mesas_sin_cobrar, prep.tickets_sin_cobrar), (1, 1));
    }
}


#[cfg(test)]
mod tests_historico_pendiente {
    //! DO-02 («encoger y avisar»): una recuperación que no cabe entera trae primero lo imprescindible
    //! para trabajar y el resto del histórico baja después, también lo que hay desde el último cierre
    //! si no cabía. Mientras falte algo de lo que suma el arqueo del periodo abierto, se avisa de que
    //! puede salir corto. Nunca se impide cerrar.

    use std::sync::Arc;

    use super::*;
    use crate::db::Db;
    use crate::ejecutor::Connection;
    use crate::sync::SqliteSyncRepository;
    use tpv_application::ports::sync::SyncRepository;
    use tpv_application::use_cases::cierre_caja as cierre_uc;

    async fn db_temporal() -> (Arc<Db>, std::path::PathBuf) {
        let dir = crate::test_temp::dir_temporal("cierre_historico");
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        (db, dir)
    }

    async fn sembrar(db: &Arc<Db>, sql: &str) {
        let w = db.write().await;
        let conn: &Connection = w.raw();
        conn.execute_batch(sql).await.unwrap_or_else(|e| panic!("sembrando: {sql}\n{e}"));
    }

    /// Como lo deja una recuperación: `Pagos` bajado, `Cuentas_Gastos` aún por bajar.
    const HISTORICO_A_MEDIAS: &str = "INSERT INTO _Backfill_Historico (Tabla, Orden, Completada, Filas_Traidas) VALUES
        ('Pagos', 1, 1, 1200), ('Cuentas_Gastos', 2, 0, 0);";

    async fn preparar(db: &Arc<Db>) -> tpv_contracts::cierre_caja::PreparacionCierreDto {
        let historico = SqliteSyncRepository::new(db.clone()).backfill_estado().await.unwrap();
        let repo = SqliteCierreCajaRepository::new(db.clone());
        cierre_uc::preparar(&repo, Dinero::CERO, Some(historico)).await.unwrap()
    }

    #[tokio::test]
    async fn el_primer_cierre_con_el_historico_bajando_avisa_con_el_progreso() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, HISTORICO_A_MEDIAS).await;
        let prep = preparar(&db).await;
        assert!(prep.es_primer_cierre);
        let h = prep.historico_pendiente.expect("el primer arqueo puede salir corto: se avisa");
        assert_eq!((h.tablas_pendientes, h.tablas_completadas, h.filas_traidas), (1, 1, 1200));
        assert_eq!(h.tabla_actual.as_deref(), Some("Cuentas_Gastos"));
    }

    /// El último cierre de caja, el 10 de mayo a las 23:00.
    const UN_CIERRE: &str = "INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre)
           VALUES ('u1', '00000000-0000-7000-8000-000000000001', 'jefe@bar.example', 'x', 'Marta');
         INSERT INTO Cierres_Caja (ID_Cierre, Fecha_Hora, ID_Usuario, Periodo_Desde, Fondo_Inicial,
           Ventas_Efectivo, Gastos_Caja, Esperado, Contado, Descuadre, Dejado, Retirado)
           VALUES ('c1', '2026-05-10 23:00:00', 'u1', '2026-05-01 00:00:00', 0, 0, 0, 0, 0, 0, 0, 0);";

    /// Como lo deja una recuperación cuya fase 1 trajo entero lo que hay desde `desde` (o no se sabe
    /// desde dónde, con `NULL`): `Pagos` y `Cuentas_Gastos` todavía bajando.
    fn cobros_bajando_desde(desde: &str) -> String {
        format!(
            "INSERT INTO _Backfill_Historico (Tabla, Orden, Completada, Filas_Traidas, Ventana_Desde) VALUES
               ('Comandas', 0, 1, 900, {desde}), ('Pagos', 1, 0, 300, {desde}), ('Cuentas_Gastos', 2, 0, 0, {desde});"
        )
    }

    #[tokio::test]
    async fn con_lo_del_periodo_ya_aqui_no_se_avisa_aunque_siga_bajando_lo_anterior() {
        // La fase 1 se estiró hasta el último cierre (o más atrás): lo que suma este arqueo llegó
        // entero con ella, y lo que baja es de antes.
        for desde in ["'2026-05-10 23:00:00'", "'2026-04-10 23:00:00'"] {
            let (db, _dir) = db_temporal().await;
            sembrar(&db, UN_CIERRE).await;
            sembrar(&db, &cobros_bajando_desde(desde)).await;
            let prep = preparar(&db).await;
            assert!(!prep.es_primer_cierre);
            assert!(prep.historico_pendiente.is_none(), "fase 1 desde {desde}");
        }
    }

    #[tokio::test]
    async fn si_lo_del_periodo_no_cupo_en_la_fase_1_se_avisa_tambien_con_un_cierre_anterior() {
        // La fase 1 sólo trajo lo imprescindible para trabajar (desde «ahora», después del cierre),
        // o no se sabe desde dónde: los cobros del periodo abierto pueden estar bajando todavía.
        for desde in ["'2026-05-14 12:00:00'", "NULL"] {
            let (db, _dir) = db_temporal().await;
            sembrar(&db, UN_CIERRE).await;
            sembrar(&db, &cobros_bajando_desde(desde)).await;
            let prep = preparar(&db).await;
            assert!(!prep.es_primer_cierre);
            let h = prep.historico_pendiente.unwrap_or_else(|| panic!("fase 1 desde {desde}: se avisa"));
            assert_eq!((h.tablas_pendientes, h.tablas_completadas), (2, 1));
        }
    }

    #[tokio::test]
    async fn los_gastos_del_dia_en_que_empieza_la_fase_1_ya_estan_aqui() {
        // La fase 1 trae los gastos desde el día de su ventana, no desde su hora: con el cierre
        // esta mañana y la ventana a mediodía del mismo día, a los gastos no les falta nada.
        let (db, _dir) = db_temporal().await;
        sembrar(
            &db,
            "INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre)
               VALUES ('u1', '00000000-0000-7000-8000-000000000001', 'jefe@bar.example', 'x', 'Marta');
             INSERT INTO Cierres_Caja (ID_Cierre, Fecha_Hora, ID_Usuario, Periodo_Desde, Fondo_Inicial,
               Ventas_Efectivo, Gastos_Caja, Esperado, Contado, Descuadre, Dejado, Retirado)
               VALUES ('c1', '2026-05-14 09:00:00', 'u1', '2026-05-13 23:00:00', 0, 0, 0, 0, 0, 0, 0, 0);
             INSERT INTO _Backfill_Historico (Tabla, Orden, Completada, Filas_Traidas, Ventana_Desde) VALUES
               ('Pagos', 1, 1, 300, '2026-05-14 12:00:00'), ('Cuentas_Gastos', 2, 0, 0, '2026-05-14 12:00:00');",
        )
        .await;
        assert!(preparar(&db).await.historico_pendiente.is_none(), "sólo bajan gastos de días anteriores");

        // Los cobros sí se miden al instante: los de entre las 9 y las 12 pueden estar bajando.
        sembrar(&db, "UPDATE _Backfill_Historico SET Completada = 0 WHERE Tabla = 'Pagos';").await;
        assert!(preparar(&db).await.historico_pendiente.is_some());
    }

    #[tokio::test]
    async fn un_cierre_hecho_despues_de_recuperar_ya_cuenta_con_todo() {
        // El periodo que se cierra empieza después de lo que trajo la fase 1.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, UN_CIERRE).await;
        sembrar(&db, &cobros_bajando_desde("'2026-05-09 08:00:00'")).await;
        assert!(preparar(&db).await.historico_pendiente.is_none());
    }

    #[tokio::test]
    async fn sin_nada_por_bajar_o_sin_saberlo_no_se_avisa() {
        let (db, _dir) = db_temporal().await;
        assert!(preparar(&db).await.historico_pendiente.is_none(), "un equipo que nunca ha perdido su base");
        sembrar(&db, HISTORICO_A_MEDIAS).await;
        let repo = SqliteCierreCajaRepository::new(db.clone());
        let prep = cierre_uc::preparar(&repo, Dinero::CERO, None).await.unwrap();
        assert!(prep.historico_pendiente.is_none(), "si no se pudo leer, el arqueo sigue igual");
    }

    #[tokio::test]
    async fn con_los_cobros_y_los_gastos_ya_bajados_el_recuento_esta_completo_y_no_se_avisa() {
        let (db, _dir) = db_temporal().await;
        sembrar(
            &db,
            "INSERT INTO _Backfill_Historico (Tabla, Orden, Completada, Filas_Traidas) VALUES
               ('Pagos', 1, 1, 1200), ('Cuentas_Gastos', 2, 1, 40), ('Fichajes', 3, 0, 0), ('Notificaciones', 4, 0, 0);",
        )
        .await;
        let prep = preparar(&db).await;
        assert!(prep.es_primer_cierre);
        assert!(prep.historico_pendiente.is_none(), "lo que falta no entra en el arqueo");
    }
}
