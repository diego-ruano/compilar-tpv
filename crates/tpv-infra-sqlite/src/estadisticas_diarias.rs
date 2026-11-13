//! El resumen diario de las estadísticas (`_Estad_Producto_Dia`, `_Estad_Mesa_Dia` y
//! `_Estad_Dias_Sucios`, §17 de `0001_inicial.sql`).
//!
//! Las estadísticas de productos y de mesas de una semana, un mes o un año leen de ahí los días ya
//! cerrados, y de los cobros sólo lo de hoy (`stats.rs`). Es una caché: todo sale de `Pagos`,
//! `Pago_Detalles`, `Detalle_Comanda` y `Comandas`, así que es estado **local del equipo** y se
//! escribe por la conexión CRUDA (`WriteGuard::raw()`), sin pasar por el outbox. La nube mantiene
//! la suya con las mismas sentencias (`domains/stats/resumenDiario.ts`, en el worker).
//!
//! Quién hace qué:
//!
//! - Los **triggers** del esquema apuntan en `_Estad_Dias_Sucios` el día que cambia. No calculan.
//! - [`recalcular_dia`] rehace un día: borra sus filas, las inserta con las dos sentencias
//!   compartidas (`packages/database/estadisticas/`) y le quita la marca, en una transacción.
//! - [`poner_al_dia`] lo hace con los días sucios del rango que se va a leer, antes de leerlo.
//! - [`recalcular_pendientes`] lo adelanta desde un job, en un momento tranquilo.
//! - [`reiniciar`] vacía el resumen y lo deja todo por calcular: tras reconstruir la base desde la
//!   nube o desde una copia.
//! - [`contrastar`] es el vigía: compara unos días ya resumidos con lo que sale de los cobros. Si
//!   alguno no coincide es que un trigger no apuntó un cambio; lo rehace y lo dice.

use std::sync::LazyLock;
use std::time::{Duration, Instant};

use tpv_application::error::AppResult;

use crate::consultas::db_err;
use crate::db::{Db, Reader, Writer};
use crate::ejecutor::{Connection, Value};
use crate::mapping::{v_i64, v_string};

/// Lo vendido de cada día de `dias(Dia)`, por producto y nombre de línea. La misma que lee el
/// worker. Quien la usa le pone delante `dias`: un día para rehacerlo, o los días sucios de un rango
/// para leerlos de los cobros (`stats.rs`).
pub(crate) const SELECT_PRODUCTO_DIA: &str =
    include_str!("../../../packages/database/estadisticas/producto_dia.sql");

/// Los cobros de cada día de `dias(Dia)` de las comandas de cada mesa. La misma que lee el worker.
pub(crate) const SELECT_MESA_DIA: &str =
    include_str!("../../../packages/database/estadisticas/mesa_dia.sql");

/// Un solo día, el `?1`, como `dias` de las dos sentencias de arriba.
const UN_DIA: &str = "WITH dias(Dia) AS (SELECT ?1)";

/// Las columnas de cada tabla, en el orden en que las devuelve su sentencia.
const COLUMNAS_PRODUCTO: &str = "Dia, ID_Producto, Nombre_Producto, Milesimas";
const COLUMNAS_MESA: &str = "Dia, ID_Mesa, Importe, Comandas, Comandas_Ultimo_Mes, Comandas_Ultimo";

static INSERTAR_PRODUCTO_DIA: LazyLock<String> = LazyLock::new(|| {
    format!("INSERT INTO _Estad_Producto_Dia ({COLUMNAS_PRODUCTO})\n{UN_DIA}\n{SELECT_PRODUCTO_DIA}")
});

static INSERTAR_MESA_DIA: LazyLock<String> = LazyLock::new(|| {
    format!("INSERT INTO _Estad_Mesa_Dia ({COLUMNAS_MESA})\n{UN_DIA}\n{SELECT_MESA_DIA}")
});

/// Cuántas filas distinguen lo guardado de un día de lo que sale de los cobros: las que sobran,
/// las que faltan y las repetidas. Todo es exacto: las unidades van en milésimas enteras.
fn sql_diferencias(tabla: &str, columnas: &str, calculado: &str) -> String {
    // Las dos van materializadas: lo que sale de los cobros se calcula una vez y se lee tres.
    format!(
        r#"WITH
        guardado AS MATERIALIZED (SELECT {columnas} FROM {tabla} WHERE Dia = ?1),
        calculado AS MATERIALIZED (SELECT {columnas} FROM ({UN_DIA}
{calculado}))
        SELECT
          (SELECT COUNT(*) FROM (SELECT * FROM guardado EXCEPT SELECT * FROM calculado))
        + (SELECT COUNT(*) FROM (SELECT * FROM calculado EXCEPT SELECT * FROM guardado))
        + ABS((SELECT COUNT(*) FROM guardado) - (SELECT COUNT(*) FROM calculado));"#
    )
}

static DIFERENCIAS_PRODUCTO: LazyLock<String> = LazyLock::new(|| {
    sql_diferencias(
        "_Estad_Producto_Dia",
        "ID_Producto, Nombre_Producto, Milesimas",
        SELECT_PRODUCTO_DIA,
    )
});

static DIFERENCIAS_MESA: LazyLock<String> = LazyLock::new(|| {
    sql_diferencias(
        "_Estad_Mesa_Dia",
        "ID_Mesa, Importe, Comandas, Comandas_Ultimo_Mes, Comandas_Ultimo",
        SELECT_MESA_DIA,
    )
});

/// Cuántos días recientes mira el vigía, y cuántos más antiguos elige al azar.
const DIAS_RECIENTES_DEL_CONTRASTE: i64 = 7;
const DIAS_ANTIGUOS_DEL_CONTRASTE: i64 = 7;

fn un_dia(dia: &str) -> Vec<Value> {
    vec![Value::Text(dia.to_string())]
}

async fn dias<C: Reader>(conn: &C, sql: &str, args: Vec<Value>) -> AppResult<Vec<String>> {
    let mut filas = conn.query(sql, args).await.map_err(db_err)?;
    let mut out = Vec::new();
    while let Some(fila) = filas.next().await.map_err(db_err)? {
        if let Some(dia) = v_string(fila.get_value(0).map_err(db_err)?) {
            out.push(dia);
        }
    }
    Ok(out)
}

async fn un_entero<C: Reader>(conn: &C, sql: &str, args: Vec<Value>) -> AppResult<i64> {
    let mut filas = conn.query(sql, args).await.map_err(db_err)?;
    Ok(match filas.next().await.map_err(db_err)? {
        Some(fila) => v_i64(fila.get_value(0).map_err(db_err)?).unwrap_or(0),
        None => 0,
    })
}

/// Rehace el resumen de un día y le quita la marca, todo o nada.
///
/// Va por la conexión cruda del escritor: mientras dura no entra ninguna otra escritura, así que
/// la marca que se quita es la de lo que se acaba de calcular. Un cambio posterior la vuelve a
/// poner.
pub(crate) async fn recalcular_dia(conn: &Connection, dia: &str) -> AppResult<()> {
    conn.transaccion(async {
        conn.execute("DELETE FROM _Estad_Producto_Dia WHERE Dia = ?1;", un_dia(dia))
            .await
            .map_err(db_err)?;
        conn.execute(&INSERTAR_PRODUCTO_DIA, un_dia(dia)).await.map_err(db_err)?;
        conn.execute("DELETE FROM _Estad_Mesa_Dia WHERE Dia = ?1;", un_dia(dia))
            .await
            .map_err(db_err)?;
        conn.execute(&INSERTAR_MESA_DIA, un_dia(dia)).await.map_err(db_err)?;
        conn.execute("DELETE FROM _Estad_Dias_Sucios WHERE Dia = ?1;", un_dia(dia))
            .await
            .map_err(db_err)?;
        Ok(())
    })
    .await
}

/// Deja al día el resumen de los días que va a leer una estadística: los sucios desde `inicio_sql`
/// (la expresión SQL del inicio del rango) hasta ayer. Hoy no se lee del resumen.
///
/// Cada día es su propia transacción y suelta el escritor al acabar: un cobro que llegue mientras
/// tanto espera, como mucho, lo que tarda un día.
pub(crate) async fn poner_al_dia(db: &Db, inicio_sql: &str) -> AppResult<()> {
    let sucios = {
        let r = db.read().await;
        dias(
            &r,
            &format!(
                "SELECT Dia FROM _Estad_Dias_Sucios \
                 WHERE Dia >= date({inicio_sql}) AND Dia < date('now','localtime') \
                 ORDER BY Dia DESC;"
            ),
            Vec::new(),
        )
        .await?
    };
    for dia in &sucios {
        let w = db.write().await;
        recalcular_dia(w.raw(), dia).await?;
    }
    Ok(())
}

/// Lo que ha hecho una pasada de [`recalcular_pendientes`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Pendientes {
    pub recalculados: usize,
    pub quedan: usize,
}

/// ¿Ha habido alguna escritura en los últimos `ventana_ms`? Cada operación de aquí y cada cambio
/// aplicado de la nube deja su fila en `_Sync_Applied_Ops` con la hora a la que entró. Una marca
/// fechada más allá de ahora (un reloj que estuvo adelantado) no cuenta.
pub async fn hay_escrituras_recientes(db: &Db, ahora_ms: i64, ventana_ms: i64) -> AppResult<bool> {
    let r = db.read().await;
    let recientes = un_entero(
        &r,
        "SELECT COUNT(*) FROM _Sync_Applied_Ops WHERE Applied_At_Ms > ?1 AND Applied_At_Ms <= ?2;",
        vec![Value::Integer(ahora_ms.saturating_sub(ventana_ms)), Value::Integer(ahora_ms)],
    )
    .await?;
    Ok(recientes > 0)
}

/// Rehace los días sucios anteriores a hoy, del más reciente al más antiguo, hasta agotar el
/// `presupuesto`. Lo que no dé tiempo queda apuntado para la siguiente pasada (o para quien lea
/// antes ese rango). Hoy no se toca: lo apunta cada cobro y no se lee del resumen.
pub async fn recalcular_pendientes(db: &Db, presupuesto: Duration) -> AppResult<Pendientes> {
    let sucios = {
        let r = db.read().await;
        dias(
            &r,
            "SELECT Dia FROM _Estad_Dias_Sucios WHERE Dia < date('now','localtime') ORDER BY Dia DESC;",
            Vec::new(),
        )
        .await?
    };
    let empezado = Instant::now();
    let mut recalculados = 0usize;
    for dia in &sucios {
        if empezado.elapsed() >= presupuesto {
            break;
        }
        {
            let w = db.write().await;
            recalcular_dia(w.raw(), dia).await?;
        }
        recalculados += 1;
        // Entre un día y otro pasa quien esté esperando al escritor.
        tokio::task::yield_now().await;
    }
    Ok(Pendientes { recalculados, quedan: sucios.len() - recalculados })
}

/// Vacía el resumen y apunta como sucios todos los días con cobros. Es para una base cuyos datos
/// acaban de cambiar de golpe (reconstruida desde la nube, o una copia que se va a instalar): lo
/// resumido hablaba de otros datos. `conn` es la conexión cruda; quien llama pone la transacción.
pub(crate) async fn reiniciar(conn: &Connection) -> AppResult<()> {
    for sql in [
        "DELETE FROM _Estad_Producto_Dia;",
        "DELETE FROM _Estad_Mesa_Dia;",
        "DELETE FROM _Estad_Dias_Sucios;",
        "INSERT INTO _Estad_Dias_Sucios (Dia) SELECT DISTINCT substr(Fecha_Hora, 1, 10) FROM Pagos;",
    ] {
        conn.execute(sql, Vec::new()).await.map_err(db_err)?;
    }
    Ok(())
}

/// Lo que ha visto una pasada de [`contrastar`].
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Contraste {
    /// Días resumidos que se han comparado con los cobros.
    pub dias_mirados: usize,
    /// Los que no coincidían. Ya están rehechos.
    pub descuadrados: Vec<String>,
}

/// ¿Coincide lo guardado de `dia` con lo que sale ahora de los cobros?
pub(crate) async fn coincide(conn: &Connection, dia: &str) -> AppResult<bool> {
    let productos = un_entero(conn, &DIFERENCIAS_PRODUCTO, un_dia(dia)).await?;
    let mesas = un_entero(conn, &DIFERENCIAS_MESA, un_dia(dia)).await?;
    Ok(productos == 0 && mesas == 0)
}

/// El vigía del resumen: compara con los cobros los últimos días y unos cuantos más antiguos
/// elegidos al azar (entre los que tienen cobros o resumen). Un día que no coincide se rehace en
/// el acto y se devuelve: quiere decir que un cambio no dejó su marca, o sea que falta un trigger.
///
/// Un día sucio no se mira: ya se sabe que no vale, y se rehará al leerlo. Cada día se compara con
/// el escritor cogido, para que no entre un cobro entre lo guardado y lo calculado.
pub async fn contrastar(db: &Db) -> AppResult<Contraste> {
    let candidatos = {
        let r = db.read().await;
        let mut candidatos = dias(
            &r,
            "WITH RECURSIVE ultimos(dia, n) AS ( \
               SELECT date('now','localtime','-1 day'), 1 \
               UNION ALL \
               SELECT date(dia, '-1 day'), n + 1 FROM ultimos WHERE n < ?1 \
             ) SELECT dia FROM ultimos;",
            vec![Value::Integer(DIAS_RECIENTES_DEL_CONTRASTE)],
        )
        .await?;
        candidatos.extend(
            dias(
                &r,
                "SELECT dia FROM ( \
                   SELECT DISTINCT substr(Fecha_Hora, 1, 10) AS dia FROM Pagos \
                   UNION SELECT Dia FROM _Estad_Mesa_Dia \
                   UNION SELECT Dia FROM _Estad_Producto_Dia \
                 ) WHERE dia < date('now','localtime', ?1) \
                 ORDER BY random() LIMIT ?2;",
                vec![
                    Value::Text(format!("-{DIAS_RECIENTES_DEL_CONTRASTE} days")),
                    Value::Integer(DIAS_ANTIGUOS_DEL_CONTRASTE),
                ],
            )
            .await?,
        );
        candidatos
    };

    let mut contraste = Contraste::default();
    for dia in &candidatos {
        let w = db.write().await;
        let conn = w.raw();
        let sucio = un_entero(
            &**conn,
            "SELECT COUNT(*) FROM _Estad_Dias_Sucios WHERE Dia = ?1;",
            un_dia(dia),
        )
        .await?
            > 0;
        if sucio {
            continue;
        }
        contraste.dias_mirados += 1;
        if !coincide(conn, dia).await? {
            recalcular_dia(conn, dia).await?;
            contraste.descuadrados.push(dia.clone());
        }
        drop(w);
        tokio::task::yield_now().await;
    }
    Ok(contraste)
}

#[cfg(test)]
mod tests {
    //! Lo que tiene que cumplir el resumen diario, sobre el esquema de verdad:
    //!
    //! - los triggers apuntan el día de cada cambio que mueve una cifra, y sólo apuntan;
    //! - ninguno puede hacer fallar la escritura que lo dispara, se escriba como se escriba;
    //! - rehacer un día deja lo que dicen las dos sentencias compartidas, y el vigía ve un resumen
    //!   que no cuadra con los cobros.
    //!
    //! Que las estadísticas den lo mismo que antes del resumen lo comprueban los tests de
    //! `stats.rs`.

    use super::*;
    use crate::contract_comun::db_temporal;
    use std::sync::Arc;

    async fn ejecutar(db: &Arc<Db>, sql: &str) {
        let w = db.write().await;
        w.raw()
            .execute_batch(sql)
            .await
            .unwrap_or_else(|e| panic!("ejecutando: {sql}\n{e}"));
    }

    async fn sucios(db: &Arc<Db>) -> Vec<String> {
        let r = db.read().await;
        dias(&r, "SELECT Dia FROM _Estad_Dias_Sucios ORDER BY Dia;", Vec::new()).await.unwrap()
    }

    async fn limpiar_marcas(db: &Arc<Db>) {
        ejecutar(db, "DELETE FROM _Estad_Dias_Sucios;").await;
    }

    async fn filas(db: &Arc<Db>, sql: &str) -> Vec<Vec<Value>> {
        let r = db.read().await;
        let mut filas = r.query(sql, ()).await.unwrap();
        let mut out = Vec::new();
        while let Some(f) = filas.next().await.unwrap() {
            let mut fila = Vec::new();
            let mut i = 0;
            while let Ok(v) = f.get_value(i) {
                fila.push(v);
                i += 1;
            }
            out.push(fila);
        }
        out
    }

    /// Una mesa, dos comandas y sus líneas, sin ningún cobro todavía.
    const BASE: &str = "
        INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z', 'Sala');
        INSERT INTO Mesas (ID_Mesa, ID_Zona, Numero_Mesa, Capacidad, Ubicacion_X, Ubicacion_Y, Shape, Width, Height)
          VALUES ('m1', 'z', '1', 4, 0, 0, 'rect', 10, 10), ('m2', 'z', '2', 4, 0, 0, 'rect', 10, 10);
        INSERT INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('cat', 'Bebidas');
        INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta) VALUES ('agua', 'cat', 'Agua', 100), ('vino', 'cat', 'Vino', 300);
        INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre) VALUES ('u', '00000000-0000-7000-8000-000000000002', 'u@bar.com', 'h', 'Eva');
        INSERT INTO Comandas (ID_Comanda, Canal, ID_Mesa, Fecha_Hora_Apertura, Estado) VALUES ('c1', 'MESA', 'm1', '2026-03-01 12:00:00', 'Abierta');
        INSERT INTO Comandas (ID_Comanda, Canal, ID_Mesa, Fecha_Hora_Apertura, Estado) VALUES ('c2', 'MESA', 'm2', '2026-03-01 12:00:00', 'Abierta');
        INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Nombre_Producto, Cantidad, Precio_Unitario)
          VALUES ('d1', 'c1', 'agua', 'Agua', 2, 100), ('d2', 'c1', 'vino', 'Vino', 1, 300), ('d3', 'c2', 'agua', 'Agua', 5, 100);
    ";

    fn pago(id: &str, comanda: &str, cuando: &str, importe: i64) -> String {
        format!(
            "INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo) \
             VALUES ('{id}', '{comanda}', '{cuando}', 'Efectivo', {importe}, 'parcial');"
        )
    }

    const ANULAR_P1: &str = "UPDATE Pagos SET Estado = 'ANULADO', Anulado_En = '2026-03-09 10:00:00', Anulado_Por = 'u' WHERE ID_Pago = 'p1';";

    #[tokio::test]
    async fn cada_cambio_que_mueve_una_cifra_apunta_su_dia() {
        let (db, _dir) = db_temporal().await;
        ejecutar(&db, BASE).await;
        assert!(sucios(&db).await.is_empty(), "sin cobros no hay nada que apuntar");

        // Un cobro apunta su día.
        ejecutar(&db, &pago("p1", "c1", "2026-03-02 13:00:00", 200)).await;
        assert_eq!(sucios(&db).await, ["2026-03-02"]);
        limpiar_marcas(&db).await;

        // Una línea que entra en un cobro apunta el día de ese cobro.
        ejecutar(&db, "INSERT INTO Pago_Detalles (ID_Pago, ID_Detalle) VALUES ('p1', 'd1');").await;
        assert_eq!(sucios(&db).await, ["2026-03-02"]);
        limpiar_marcas(&db).await;

        // Otro cobro de la misma comanda, otro día: el suyo y el del primero (la comanda deja de
        // tener ahí su último cobro).
        ejecutar(&db, &pago("p2", "c1", "2026-03-05 13:00:00", 300)).await;
        assert_eq!(sucios(&db).await, ["2026-03-02", "2026-03-05"]);
        limpiar_marcas(&db).await;

        // La misma línea en el segundo cobro: los días de todos los cobros de la línea.
        ejecutar(&db, "INSERT INTO Pago_Detalles (ID_Pago, ID_Detalle) VALUES ('p2', 'd1');").await;
        assert_eq!(sucios(&db).await, ["2026-03-02", "2026-03-05"]);
        limpiar_marcas(&db).await;

        // Un cobro de otra comanda no apunta los de ésta.
        ejecutar(&db, &pago("p3", "c2", "2026-03-07 13:00:00", 500)).await;
        ejecutar(&db, "INSERT INTO Pago_Detalles (ID_Pago, ID_Detalle) VALUES ('p3', 'd3');").await;
        assert_eq!(sucios(&db).await, ["2026-03-07"]);
        limpiar_marcas(&db).await;

        // Anular un cobro: su día y los de los cobros con los que comparte comanda o líneas.
        ejecutar(&db, ANULAR_P1).await;
        assert_eq!(sucios(&db).await, ["2026-03-02", "2026-03-05"]);
        limpiar_marcas(&db).await;

        // Cambiarle la fecha: el día de antes y el de ahora.
        ejecutar(&db, "UPDATE Pagos SET Fecha_Hora = '2026-03-08 09:00:00' WHERE ID_Pago = 'p3';").await;
        assert_eq!(sucios(&db).await, ["2026-03-07", "2026-03-08"]);
        limpiar_marcas(&db).await;

        // Un cambio que no mueve ninguna cifra no apunta nada.
        ejecutar(&db, "UPDATE Pagos SET Numero_Ticket = 'T-1' WHERE ID_Pago = 'p3';").await;
        ejecutar(&db, "UPDATE Pagos SET Estado = Estado, Importe_Total = Importe_Total WHERE ID_Pago = 'p3';").await;
        ejecutar(&db, "UPDATE Detalle_Comanda SET Notas = 'sin hielo', Estado_Cocina = 'PREPARADO' WHERE ID_Detalle = 'd3';").await;
        ejecutar(&db, "UPDATE Comandas SET Estado = 'Pagada' WHERE ID_Comanda = 'c2';").await;
        assert!(sucios(&db).await.is_empty());

        // La cantidad, el producto o el nombre de una línea cobrada: los días de sus cobros.
        ejecutar(&db, "UPDATE Detalle_Comanda SET Cantidad = 6 WHERE ID_Detalle = 'd3';").await;
        assert_eq!(sucios(&db).await, ["2026-03-08"]);
        limpiar_marcas(&db).await;
        ejecutar(&db, "UPDATE Detalle_Comanda SET Nombre_Producto = 'Agua con gas' WHERE ID_Detalle = 'd3';").await;
        assert_eq!(sucios(&db).await, ["2026-03-08"]);
        limpiar_marcas(&db).await;
        // En una línea sin cobrar, nada.
        ejecutar(&db, "UPDATE Detalle_Comanda SET Cantidad = 9 WHERE ID_Detalle = 'd2';").await;
        assert!(sucios(&db).await.is_empty());

        // Una comanda que cambia de mesa: los días de sus cobros.
        ejecutar(&db, "UPDATE Comandas SET Estado = 'Pagada' WHERE ID_Comanda = 'c1';").await;
        ejecutar(&db, "UPDATE Comandas SET ID_Mesa = 'm1' WHERE ID_Comanda = 'c2';").await;
        assert_eq!(sucios(&db).await, ["2026-03-08"]);
        limpiar_marcas(&db).await;

        // Sacar una línea de un cobro: el día de ese cobro y los de los demás cobros de la línea.
        ejecutar(&db, "DELETE FROM Pago_Detalles WHERE ID_Pago = 'p2' AND ID_Detalle = 'd1';").await;
        assert_eq!(sucios(&db).await, ["2026-03-02", "2026-03-05"]);
        limpiar_marcas(&db).await;

        // Borrar un cobro: su día y los de los demás cobros de su comanda.
        ejecutar(&db, "DELETE FROM Pagos WHERE ID_Pago = 'p2';").await;
        assert_eq!(sucios(&db).await, ["2026-03-02", "2026-03-05"]);
    }

    #[tokio::test]
    async fn las_cascadas_de_las_claves_foraneas_tambien_apuntan() {
        let (db, _dir) = db_temporal().await;
        ejecutar(&db, BASE).await;
        ejecutar(&db, &pago("p1", "c1", "2026-03-02 13:00:00", 500)).await;
        ejecutar(&db, &pago("p3", "c2", "2026-03-07 13:00:00", 500)).await;
        ejecutar(
            &db,
            "INSERT INTO Pago_Detalles (ID_Pago, ID_Detalle) VALUES ('p1', 'd1'), ('p1', 'd2'), ('p3', 'd3');",
        )
        .await;
        limpiar_marcas(&db).await;

        // Borrar una línea se lleva su fila de Pago_Detalles (ON DELETE CASCADE).
        ejecutar(&db, "DELETE FROM Detalle_Comanda WHERE ID_Detalle = 'd2';").await;
        assert_eq!(sucios(&db).await, ["2026-03-02"]);
        limpiar_marcas(&db).await;

        // Borrar un producto del catálogo deja sus líneas sin él (ON DELETE SET NULL).
        ejecutar(&db, "DELETE FROM Productos WHERE ID_Producto = 'agua';").await;
        assert_eq!(sucios(&db).await, ["2026-03-02", "2026-03-07"]);
        limpiar_marcas(&db).await;

        // Borrar una comanda se lleva sus cobros (ON DELETE CASCADE); sus líneas van antes.
        ejecutar(&db, "DELETE FROM Detalle_Comanda WHERE ID_Comanda = 'c2';").await;
        limpiar_marcas(&db).await;
        ejecutar(&db, "DELETE FROM Comandas WHERE ID_Comanda = 'c2';").await;
        assert_eq!(sucios(&db).await, ["2026-03-07"]);
    }

    #[tokio::test]
    async fn una_comanda_o_una_linea_que_llega_despues_de_sus_cobros_apunta_sus_dias() {
        // Con las claves foráneas encendidas no se ve nunca un cobro sin su comanda o sin su línea
        // fuera de una transacción. Con ellas apagadas sí, y el resumen de ese día, rehecho sin la
        // comanda o sin la línea, dejaría de valer cuando llegan.
        let (db, _dir) = db_temporal().await;
        ejecutar(&db, BASE).await;
        ejecutar(&db, "PRAGMA foreign_keys = OFF;").await;
        ejecutar(&db, &pago("px", "cx", "2026-03-04 12:00:00", 300)).await;
        ejecutar(&db, "INSERT INTO Pago_Detalles (ID_Pago, ID_Detalle) VALUES ('px', 'dx');").await;
        {
            let w = db.write().await;
            recalcular_dia(w.raw(), "2026-03-04").await.unwrap();
        }
        assert!(sucios(&db).await.is_empty());

        ejecutar(&db, "INSERT INTO Comandas (ID_Comanda, Canal, ID_Mesa, Fecha_Hora_Apertura, Estado) VALUES ('cx', 'MESA', 'm1', '2026-03-04 11:00:00', 'Pagada');").await;
        assert_eq!(sucios(&db).await, ["2026-03-04"]);
        limpiar_marcas(&db).await;
        ejecutar(&db, "INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Nombre_Producto, Cantidad, Precio_Unitario) VALUES ('dx', 'cx', 'vino', 'Vino', 1, 300);").await;
        assert_eq!(sucios(&db).await, ["2026-03-04"]);
        limpiar_marcas(&db).await;

        // Y lo mismo al irse sin cascada que se lleve sus cobros.
        ejecutar(&db, "DELETE FROM Detalle_Comanda WHERE ID_Detalle = 'dx';").await;
        assert_eq!(sucios(&db).await, ["2026-03-04"]);
        limpiar_marcas(&db).await;
        ejecutar(&db, "DELETE FROM Comandas WHERE ID_Comanda = 'cx';").await;
        assert_eq!(sucios(&db).await, ["2026-03-04"]);
        ejecutar(&db, "PRAGMA foreign_keys = ON;").await;
    }

    /// El cuerpo de cada trigger del resumen, tal y como lo guarda SQLite.
    async fn cuerpos_de_los_triggers(db: &Arc<Db>) -> Vec<(String, String)> {
        filas(db, "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'estad\\_%' ESCAPE '\\' ORDER BY name;")
            .await
            .into_iter()
            .map(|f| match (&f[0], &f[1]) {
                (Value::Text(nombre), Value::Text(sql)) => (nombre.clone(), sql.clone()),
                otra => panic!("fila inesperada: {otra:?}"),
            })
            .collect()
    }

    #[tokio::test]
    async fn los_triggers_solo_apuntan_dias() {
        // Corren dentro de un cobro: no calculan, no tocan otra tabla y no pueden abortar. Cada
        // sentencia de su cuerpo es un `INSERT OR IGNORE` en `_Estad_Dias_Sucios` que deja fuera
        // los días que ya están, así que no hay restricción que pueda violar.
        let (db, _dir) = db_temporal().await;
        let triggers = cuerpos_de_los_triggers(&db).await;
        assert_eq!(
            triggers.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>(),
            [
                "estad_comandas_delete",
                "estad_comandas_insert",
                "estad_comandas_update",
                "estad_detalle_comanda_delete",
                "estad_detalle_comanda_insert",
                "estad_detalle_comanda_update",
                "estad_pago_detalles_delete",
                "estad_pago_detalles_insert",
                "estad_pago_detalles_update",
                "estad_pagos_delete",
                "estad_pagos_insert",
                "estad_pagos_reemplazo",
                "estad_pagos_reemplazo_clave",
                "estad_pagos_update",
            ]
        );
        for (nombre, sql) in &triggers {
            // Detrás de la escritura, salvo los dos que miran la fila que un reemplazo va a borrar.
            if nombre == "estad_pagos_reemplazo" {
                assert!(sql.contains("BEFORE INSERT ON Pagos"), "{nombre}: {sql}");
            } else if nombre == "estad_pagos_reemplazo_clave" {
                assert!(sql.contains("BEFORE UPDATE OF ID_Pago ON Pagos"), "{nombre}: {sql}");
            } else {
                assert!(sql.contains("AFTER "), "{nombre}: tiene que ir detrás de la escritura");
            }
            let cuerpo = sql.split_once("BEGIN").expect("un trigger tiene BEGIN").1;
            let cuerpo = cuerpo.rsplit_once("END").expect("y END").0;
            let sentencias: Vec<&str> =
                cuerpo.split(';').map(str::trim).filter(|s| !s.is_empty()).collect();
            assert!(!sentencias.is_empty(), "{nombre}: sin cuerpo");
            for sentencia in sentencias {
                assert!(
                    sentencia.starts_with("INSERT OR IGNORE INTO _Estad_Dias_Sucios (Dia)"),
                    "{nombre}: una sentencia que no es apuntar un día: {sentencia}"
                );
                assert!(
                    sentencia.ends_with("NOT IN (SELECT Dia FROM _Estad_Dias_Sucios)"),
                    "{nombre}: tiene que dejar fuera los días ya apuntados: {sentencia}"
                );
                let mayus = sentencia.to_uppercase();
                for prohibido in ["RAISE", "UPDATE ", "DELETE ", "REPLACE"] {
                    assert!(!mayus.contains(prohibido), "{nombre}: lleva {prohibido}: {sentencia}");
                }
            }
        }
    }

    #[tokio::test]
    async fn un_trigger_no_hace_fallar_la_escritura_que_lo_dispara() {
        // La cláusula de conflicto de la sentencia que dispara un trigger manda sobre la del
        // trigger: con `INSERT OR ABORT INTO Pagos`, el `OR IGNORE` de dentro deja de valer. Como
        // el día ya apuntado no se vuelve a insertar, da igual.
        let (db, _dir) = db_temporal().await;
        ejecutar(&db, BASE).await;
        ejecutar(&db, &pago("p0", "c1", "2026-03-02 09:00:00", 100)).await;
        assert_eq!(sucios(&db).await, ["2026-03-02"]);

        for (i, clausula) in ["OR ABORT", "OR FAIL", "OR ROLLBACK", "OR REPLACE", "OR IGNORE"].iter().enumerate() {
            let sql = pago(&format!("p{}", i + 1), "c1", "2026-03-02 13:00:00", 100)
                .replace("INSERT INTO", &format!("INSERT {clausula} INTO"));
            ejecutar(&db, &sql).await;
            ejecutar(
                &db,
                &format!("INSERT {clausula} INTO Pago_Detalles (ID_Pago, ID_Detalle) VALUES ('p{}', 'd1');", i + 1),
            )
            .await;
            ejecutar(
                &db,
                &format!("UPDATE {clausula} Pagos SET Importe_Total = Importe_Total + 1 WHERE ID_Pago = 'p{}';", i + 1),
            )
            .await;
        }
        // Un reemplazo de verdad: la misma clave con otra fecha. Con `recursive_triggers` apagado el
        // borrado implícito no dispara `estad_pagos_delete`; el día de la fila de antes lo apunta
        // `estad_pagos_reemplazo`, y el de la nueva, el alta.
        ejecutar(&db, &pago("px", "c2", "2026-03-06 09:00:00", 100)).await;
        limpiar_marcas(&db).await;
        ejecutar(&db, "PRAGMA recursive_triggers = OFF;").await;
        ejecutar(
            &db,
            &pago("px", "c2", "2026-03-08 09:00:00", 100).replace("INSERT INTO", "INSERT OR REPLACE INTO"),
        )
        .await;
        assert_eq!(sucios(&db).await, ["2026-03-06", "2026-03-08"]);
        ejecutar(&db, "DELETE FROM Pagos WHERE ID_Pago = 'px';").await;

        // Y un cobro que toma la clave de otro (revisión de Codex, segunda pasada): el que la
        // ocupaba se borra sin su trigger; su día lo apunta `estad_pagos_reemplazo_clave`.
        ejecutar(&db, &pago("pu", "c2", "2026-03-12 09:00:00", 100)).await;
        ejecutar(&db, &pago("pv", "c2", "2026-03-13 09:00:00", 200)).await;
        limpiar_marcas(&db).await;
        ejecutar(&db, "UPDATE OR REPLACE Pagos SET ID_Pago = 'pv' WHERE ID_Pago = 'pu';").await;
        assert_eq!(sucios(&db).await, ["2026-03-12", "2026-03-13"]);
        ejecutar(&db, "DELETE FROM Pagos WHERE ID_Pago = 'pv';").await;

        // Dos cobros del mismo día en una sola sentencia, con el día sin apuntar.
        limpiar_marcas(&db).await;
        ejecutar(
            &db,
            "INSERT OR ABORT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo) \
             VALUES ('pa', 'c2', '2026-03-03 10:00:00', 'Efectivo', 1, 'parcial'), ('pb', 'c2', '2026-03-03 11:00:00', 'Efectivo', 1, 'parcial');",
        )
        .await;
        assert_eq!(sucios(&db).await, ["2026-03-03"]);
        let cobros = filas(&db, "SELECT COUNT(*) FROM Pagos;").await;
        assert_eq!(cobros[0][0], Value::Integer(8));
    }

    #[tokio::test]
    async fn una_linea_cuenta_el_dia_de_su_ultimo_cobro_activo() {
        let (db, _dir) = db_temporal().await;
        ejecutar(&db, BASE).await;
        // d1 (2 de agua) se cobra el día 2 y otra vez el día 5; d2 (1 de vino) sólo el día 2.
        ejecutar(&db, &pago("p1", "c1", "2026-03-02 13:00:00", 300)).await;
        ejecutar(&db, &pago("p2", "c1", "2026-03-05 13:00:00", 200)).await;
        ejecutar(
            &db,
            "INSERT INTO Pago_Detalles (ID_Pago, ID_Detalle) VALUES ('p1', 'd1'), ('p1', 'd2'), ('p2', 'd1');",
        )
        .await;
        for dia in sucios(&db).await {
            let w = db.write().await;
            recalcular_dia(w.raw(), &dia).await.unwrap();
        }
        assert!(sucios(&db).await.is_empty(), "rehacer un día le quita la marca");

        let productos = "SELECT Dia, ID_Producto, Milesimas FROM _Estad_Producto_Dia ORDER BY Dia, ID_Producto;";
        let t = |s: &str| Value::Text(s.to_string());
        assert_eq!(
            filas(&db, productos).await,
            [
                vec![t("2026-03-02"), t("vino"), Value::Integer(1000)],
                vec![t("2026-03-05"), t("agua"), Value::Integer(2000)],
            ]
        );
        // La comanda cuenta en los dos días, y sólo en el último para el mes y para el rango.
        let mesas = "SELECT Dia, ID_Mesa, Importe, Comandas, Comandas_Ultimo_Mes, Comandas_Ultimo FROM _Estad_Mesa_Dia ORDER BY Dia;";
        let n = Value::Integer;
        assert_eq!(
            filas(&db, mesas).await,
            [
                vec![t("2026-03-02"), t("m1"), n(300), n(1), n(0), n(0)],
                vec![t("2026-03-05"), t("m1"), n(200), n(1), n(1), n(1)],
            ]
        );

        // Anulado el segundo cobro, la línea y la comanda vuelven al día del primero.
        ejecutar(&db, &ANULAR_P1.replace("'p1'", "'p2'")).await;
        assert_eq!(sucios(&db).await, ["2026-03-02", "2026-03-05"]);
        for dia in sucios(&db).await {
            let w = db.write().await;
            recalcular_dia(w.raw(), &dia).await.unwrap();
        }
        assert_eq!(
            filas(&db, productos).await,
            [
                vec![t("2026-03-02"), t("agua"), Value::Integer(2000)],
                vec![t("2026-03-02"), t("vino"), Value::Integer(1000)],
            ]
        );
        assert_eq!(filas(&db, mesas).await, [vec![t("2026-03-02"), t("m1"), n(300), n(1), n(1), n(1)]]);
    }

    #[tokio::test]
    async fn una_comanda_cobrada_en_dos_meses_cuenta_en_los_dos() {
        let (db, _dir) = db_temporal().await;
        ejecutar(&db, BASE).await;
        ejecutar(&db, &pago("p1", "c1", "2026-03-31 23:50:00", 300)).await;
        ejecutar(&db, &pago("p2", "c1", "2026-04-01 00:10:00", 200)).await;
        // Una devolución de parte del primer cobro, al día siguiente: resta y no es un cobro.
        ejecutar(
            &db,
            "INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo, ID_Pago_Origen, Motivo_Devolucion) \
             VALUES ('dev', 'c1', '2026-04-02 10:00:00', 'Efectivo', -100, 'DEVOLUCION', 'p1', 'frío');",
        )
        .await;
        for dia in sucios(&db).await {
            let w = db.write().await;
            recalcular_dia(w.raw(), &dia).await.unwrap();
        }
        let t = |s: &str| Value::Text(s.to_string());
        let n = Value::Integer;
        assert_eq!(
            filas(&db, "SELECT Dia, Importe, Comandas, Comandas_Ultimo_Mes, Comandas_Ultimo FROM _Estad_Mesa_Dia ORDER BY Dia;").await,
            [
                vec![t("2026-03-31"), n(300), n(1), n(1), n(0)],
                vec![t("2026-04-01"), n(200), n(1), n(1), n(1)],
                vec![t("2026-04-02"), n(-100), n(0), n(0), n(0)],
            ]
        );
    }

    #[tokio::test]
    async fn reiniciar_lo_deja_todo_por_calcular() {
        let (db, _dir) = db_temporal().await;
        ejecutar(&db, BASE).await;
        ejecutar(&db, &pago("p1", "c1", "2026-03-02 13:00:00", 300)).await;
        ejecutar(&db, &pago("p2", "c2", "2026-03-05 13:00:00", 200)).await;
        for dia in sucios(&db).await {
            let w = db.write().await;
            recalcular_dia(w.raw(), &dia).await.unwrap();
        }
        // Un resumen que habla de otros datos: un día que ya no tiene cobros.
        ejecutar(&db, "INSERT INTO _Estad_Mesa_Dia VALUES ('2025-01-01', 'm1', 999, 1, 1, 1);").await;
        ejecutar(&db, "INSERT INTO _Estad_Producto_Dia VALUES ('2025-01-01', 'agua', 'Agua', 9);").await;

        {
            let w = db.write().await;
            reiniciar(w.raw()).await.unwrap();
        }
        assert_eq!(sucios(&db).await, ["2026-03-02", "2026-03-05"]);
        assert!(filas(&db, "SELECT 1 FROM _Estad_Mesa_Dia UNION ALL SELECT 1 FROM _Estad_Producto_Dia;").await.is_empty());
    }

    #[tokio::test]
    async fn el_job_rehace_lo_anterior_a_hoy_y_deja_hoy() {
        let (db, _dir) = db_temporal().await;
        ejecutar(&db, BASE).await;
        ejecutar(&db, &pago("p1", "c1", "2026-03-02 13:00:00", 300)).await;
        ejecutar(&db, "INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo) VALUES ('p2', 'c2', datetime('now','localtime'), 'Efectivo', 200, 'total');").await;
        let hoy = crate::util::now_local_date();
        assert_eq!(sucios(&db).await, ["2026-03-02".to_string(), hoy.clone()]);

        // Sin presupuesto no hace nada, y lo dice.
        let nada = recalcular_pendientes(&db, Duration::ZERO).await.unwrap();
        assert_eq!(nada, Pendientes { recalculados: 0, quedan: 1 });

        let pasada = recalcular_pendientes(&db, Duration::from_secs(5)).await.unwrap();
        assert_eq!(pasada, Pendientes { recalculados: 1, quedan: 0 });
        assert_eq!(sucios(&db).await, [hoy]);
        assert_eq!(filas(&db, "SELECT Dia FROM _Estad_Mesa_Dia;").await, [vec![Value::Text("2026-03-02".into())]]);
    }

    #[tokio::test]
    async fn el_vigia_ve_un_resumen_que_no_cuadra_y_lo_rehace() {
        let (db, _dir) = db_temporal().await;
        ejecutar(&db, BASE).await;
        // Ayer y hace tres días (recientes), y un día antiguo.
        for (id, comanda, cuando) in [
            ("p1", "c1", "datetime('now','localtime','-1 day')"),
            ("p2", "c2", "datetime('now','localtime','-3 days')"),
            ("p3", "c2", "'2020-05-05 12:00:00'"),
        ] {
            ejecutar(&db, &format!("INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo) VALUES ('{id}', '{comanda}', {cuando}, 'Efectivo', 100, 'parcial');")).await;
        }
        ejecutar(&db, "INSERT INTO Pago_Detalles (ID_Pago, ID_Detalle) VALUES ('p1', 'd1'), ('p2', 'd3');").await;

        // Un día sucio no se contrasta: sólo se miran los cinco días recientes sin cobros.
        let sin_resumen = contrastar(&db).await.unwrap();
        assert_eq!(sin_resumen, Contraste { dias_mirados: 5, descuadrados: Vec::new() });

        recalcular_pendientes(&db, Duration::from_secs(5)).await.unwrap();
        let cuadra = contrastar(&db).await.unwrap();
        assert!(cuadra.descuadrados.is_empty(), "{cuadra:?}");
        // Los siete últimos días y el antiguo.
        assert_eq!(cuadra.dias_mirados, 8);

        // Un cambio que no deja marca (lo que haría un trigger que faltara): cada uno estropea
        // una cosa distinta del resumen.
        ejecutar(&db, "UPDATE _Estad_Producto_Dia SET Milesimas = Milesimas + 1 WHERE Dia = date('now','localtime','-1 day');").await;
        ejecutar(&db, "DELETE FROM _Estad_Mesa_Dia WHERE Dia = date('now','localtime','-3 days');").await;
        ejecutar(&db, "INSERT INTO _Estad_Producto_Dia VALUES ('2020-05-05', 'agua', 'Agua', 3);").await;

        let ayer = filas(&db, "SELECT date('now','localtime','-1 day'), date('now','localtime','-3 days');").await;
        let (Value::Text(ayer), Value::Text(hace_tres)) = (ayer[0][0].clone(), ayer[0][1].clone()) else {
            panic!("fechas");
        };
        let mut visto = contrastar(&db).await.unwrap();
        visto.descuadrados.sort();
        assert_eq!(visto.descuadrados, ["2020-05-05".to_string(), hace_tres, ayer]);

        // Y quedan rehechos: la siguiente pasada no ve nada.
        let despues = contrastar(&db).await.unwrap();
        assert!(despues.descuadrados.is_empty(), "{despues:?}");
        assert_eq!(despues.dias_mirados, 8);
    }

    #[tokio::test]
    async fn sin_escrituras_recientes_es_un_momento_tranquilo() {
        let (db, _dir) = db_temporal().await;
        let ahora = 1_800_000_000_000i64;
        assert!(!hay_escrituras_recientes(&db, ahora, 120_000).await.unwrap());
        ejecutar(&db, &format!("INSERT INTO _Sync_Applied_Ops (Op_Id, Seq, Applied_At_Ms) VALUES ('vieja', 0, {});", ahora - 600_000)).await;
        ejecutar(&db, &format!("INSERT INTO _Sync_Applied_Ops (Op_Id, Seq, Applied_At_Ms) VALUES ('futura', 0, {});", ahora + 600_000)).await;
        assert!(!hay_escrituras_recientes(&db, ahora, 120_000).await.unwrap());
        ejecutar(&db, &format!("INSERT INTO _Sync_Applied_Ops (Op_Id, Seq, Applied_At_Ms) VALUES ('reciente', 0, {});", ahora - 30_000)).await;
        assert!(hay_escrituras_recientes(&db, ahora, 120_000).await.unwrap());
    }
}
