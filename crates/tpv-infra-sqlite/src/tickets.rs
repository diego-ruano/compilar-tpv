//! Adaptador SQLite del ticket de un cobro (RI-29): el pago, sus líneas y su factura.
//!
//! Sólo lectura. El papel entero sale de aquí: la pantalla no aporta ni las líneas ni el número.

use crate::consultas::{db_err};
use std::sync::Arc;

use async_trait::async_trait;
use libsql::Value;

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::tickets::{
    FacturaDelCobro, FacturaDelTicket, TicketDePago, TicketsRepository,
};
use tpv_domain::dinero::Dinero;
use tpv_domain::ticket::LineaVendida;

use crate::db::{Db, Reader};
use crate::mapping::{v_dinero, v_f64, v_i64, v_string};

pub struct SqliteTicketsRepository {
    db: Arc<Db>,
}

impl SqliteTicketsRepository {
    pub fn new(db: Arc<Db>) -> Self {
        Self { db }
    }
}

/// La cabecera del cobro. El origen se arma aquí y no en la pantalla para que una copia diga
/// exactamente lo mismo que el original.
const SQL_PAGO: &str = r#"
    SELECT
      COALESCE(p.Numero_Ticket, ''),
      COALESCE(p.Metodo_Pago, ''),
      CASE WHEN m.Numero_Mesa IS NOT NULL THEN 'Mesa ' || m.Numero_Mesa ELSE 'Barra' END,
      CASE WHEN COALESCE(p.Estado, 'ACTIVO') = 'ANULADO' THEN 1 ELSE 0 END,
      COALESCE(p.Fecha_Hora, ''),
      CASE WHEN p.ID_Pago_Origen IS NOT NULL THEN 1 ELSE 0 END
    FROM Pagos p
    LEFT JOIN Comandas c ON c.ID_Comanda = p.ID_Comanda
    LEFT JOIN Mesas m ON m.ID_Mesa = c.ID_Mesa
    WHERE p.ID_Pago = ?1
    LIMIT 1;
"#;

/// Las líneas que cobró ESE pago, no las de la comanda entera: en un cobro fraccionado son otras.
/// Sin filtro por estado: un cobro anulado se puede reimprimir —es la prueba de qué contenía—, y el
/// papel sale marcado.
const SQL_LINEAS: &str = r#"
    SELECT
      COALESCE(dc.Nombre_Producto, pr.Nombre, 'Producto'),
      COALESCE(dc.Cantidad, 1),
      COALESCE(dc.Precio_Unitario, 0),
      dc.IVA_Percent
    FROM Pago_Detalles pd
    JOIN Detalle_Comanda dc ON dc.ID_Detalle = pd.ID_Detalle
    LEFT JOIN Productos pr ON pr.ID_Producto = dc.ID_Producto
    WHERE pd.ID_Pago = ?1
    ORDER BY dc.ID_Detalle ASC;
"#;

/// Las líneas que devolvió una devolución de parte de un cobro: las unidades devueltas y lo que se
/// devolvió por ellas, que no siempre es unidades × precio (la última devolución de una línea se
/// lleva lo que quede).
const SQL_LINEAS_DEVUELTAS: &str = r#"
    SELECT
      COALESCE(dc.Nombre_Producto, pr.Nombre, 'Producto'),
      dl.Cantidad,
      COALESCE(dc.Precio_Unitario, 0),
      dc.IVA_Percent,
      dl.Importe
    FROM Devolucion_Lineas dl
    JOIN Detalle_Comanda dc ON dc.ID_Detalle = dl.ID_Detalle
    LEFT JOIN Productos pr ON pr.ID_Producto = dc.ID_Producto
    WHERE dl.ID_Pago = ?1
    ORDER BY dc.ID_Detalle ASC;
"#;

/// La factura de un número. Si hay varias filas de alta (una subsanación repite el `IDFactura`),
/// vale la última. Un ticket antiguo se encuentra por `idx_regfact_numserie`, no recorriendo los
/// registros hacia atrás: lo vigila `planes::tests` (RI-03).
pub(crate) const SQL_FACTURA: &str = "SELECT Num_Serie_Factura, COALESCE(Tipo_Factura, ''), \
            NIF_Emisor, Nombre_Razon_Emisor, Fecha_Expedicion, Fecha_Hora_Huso, QR_Url, \
            COALESCE(Importe_Total, ''), Desglose_Json, ID_Pago, Destinatario_Json, \
            Referencias_Json \
     FROM Registros_Facturacion \
     WHERE Num_Serie_Factura = ?1 AND Tipo = 'ALTA' \
     ORDER BY Orden DESC LIMIT 1;";

/// Las facturas de un pago, en el orden en que se expidieron. Va por `idx_regfact_pago`.
const SQL_FACTURAS_DEL_PAGO: &str = "SELECT Num_Serie_Factura, COALESCE(Tipo_Factura, ''),             COALESCE(Importe_Total, ''), Orden      FROM Registros_Facturacion      WHERE ID_Pago = ?1 AND Tipo = 'ALTA'      ORDER BY Orden ASC;";

/// Las F3 que no cuelgan de ningún pago: las que canjean varios tickets (y las que las corrigen).
/// Sus cobros las encuentran por `FacturasSustituidas`.
const SQL_F3_SIN_PAGO: &str = "SELECT Num_Serie_Factura, COALESCE(Importe_Total, ''), Orden,             Referencias_Json      FROM Registros_Facturacion      WHERE ID_Pago IS NULL AND Tipo = 'ALTA' AND Tipo_Factura = 'F3'      ORDER BY Orden ASC;";

/// El cobro de un número de ticket.
const SQL_PAGO_DE_TICKET: &str =
    "SELECT ID_Pago FROM Pagos WHERE Numero_Ticket = ?1 ORDER BY Fecha_Hora ASC LIMIT 1;";

#[async_trait]
impl TicketsRepository for SqliteTicketsRepository {
    async fn ticket_de_pago(
        &self,
        id_pago: &str,
        num_factura: Option<&str>,
    ) -> AppResult<Option<TicketDePago>> {
        let r = self.db.read().await;
        let conn = r.conn();

        let mut rows = conn
            .query(SQL_PAGO, vec![Value::Text(id_pago.to_string())])
            .await
            .map_err(db_err)?;
        let Some(row) = rows.next().await.map_err(db_err)? else {
            return Ok(None);
        };
        let texto = |i: i32| -> AppResult<String> {
            Ok(v_string(row.get_value(i).map_err(db_err)?).unwrap_or_default())
        };
        let numero_ticket = texto(0)?;
        let mut metodo_pago = texto(1)?;
        let mut origen = texto(2)?;
        let anulado = v_i64(row.get_value(3).map_err(db_err)?).unwrap_or(0) == 1;
        let fecha_hora = texto(4)?;
        let es_devolucion = v_i64(row.get_value(5).map_err(db_err)?).unwrap_or(0) == 1;
        let mut lineas = if es_devolucion {
            lineas_devueltas(&r, id_pago).await?
        } else {
            lineas_de_pago(&r, id_pago).await?
        };

        let pedida = num_factura.map(str::trim).filter(|n| !n.is_empty());
        let factura = match pedida {
            // Otra factura del cobro: la `F3` del canje (sola o con otros tickets), la rectificativa
            // de una devolución o su `F3` negativa. Si no es de este cobro, no se imprime con sus
            // líneas: mezclaría dos cobros.
            Some(n) => match factura(&r, n).await? {
                Some((f, de_pago))
                    if de_pago.as_deref() == Some(id_pago)
                        || f.sustituye.iter().any(|s| s == numero_ticket.trim()) =>
                {
                    Some(f)
                }
                _ => return Err(AppError::not_found("Esa factura no es de este cobro.")),
            },
            None if numero_ticket.trim().is_empty() => None,
            None => factura(&r, numero_ticket.trim()).await?.map(|(f, _)| f),
        };

        // Una F3 de varios tickets documenta las líneas de todos sus cobros. No es un cobro: no
        // lleva método de pago (ni abre el cajón) ni el origen de uno de ellos.
        if let Some(f) = &factura {
            if f.tipo_factura == "F3" && f.sustituye.len() > 1 {
                lineas = Vec::new();
                for num in &f.sustituye {
                    if let Some(p) = pago_de_ticket(&r, num).await? {
                        lineas.extend(lineas_de_pago(&r, &p).await?);
                    }
                }
                metodo_pago = String::new();
                origen = String::new();
            }
        }

        // Todas las facturas del cobro: las suyas y las F3 que canjean su ticket con otros. Una
        // subsanación repite el número: cuenta una vez, con los datos de su última fila.
        let mut con_orden: Vec<(i64, FacturaDelCobro)> = Vec::new();
        let mut anotar = |orden: i64, num: String, tipo: String, importe: Dinero| {
            match con_orden.iter_mut().find(|(_, (n, _, _))| *n == num) {
                Some(f) => *f = (f.0, (num, tipo, importe)),
                None => con_orden.push((orden, (num, tipo, importe))),
            }
        };
        let mut rows = conn
            .query(SQL_FACTURAS_DEL_PAGO, vec![Value::Text(id_pago.to_string())])
            .await
            .map_err(db_err)?;
        while let Some(row) = rows.next().await.map_err(db_err)? {
            let t = |i: i32| -> AppResult<String> {
                Ok(v_string(row.get_value(i).map_err(db_err)?).unwrap_or_default())
            };
            let importe = Dinero::de_texto_fiscal(&t(2)?).unwrap_or(Dinero::CERO);
            let orden = v_i64(row.get_value(3).map_err(db_err)?).unwrap_or(0);
            anotar(orden, t(0)?, t(1)?, importe);
        }
        if !numero_ticket.trim().is_empty() {
            let mut rows = conn.query(SQL_F3_SIN_PAGO, ()).await.map_err(db_err)?;
            while let Some(row) = rows.next().await.map_err(db_err)? {
                let refs = v_string(row.get_value(3).map_err(db_err)?);
                if !crate::verifactu::numeros_sustituidos(refs.as_deref())
                    .iter()
                    .any(|n| n == numero_ticket.trim())
                {
                    continue;
                }
                let num = v_string(row.get_value(0).map_err(db_err)?).unwrap_or_default();
                let importe = Dinero::de_texto_fiscal(
                    &v_string(row.get_value(1).map_err(db_err)?).unwrap_or_default(),
                )
                .unwrap_or(Dinero::CERO);
                let orden = v_i64(row.get_value(2).map_err(db_err)?).unwrap_or(0);
                anotar(orden, num, "F3".to_string(), importe);
            }
        }
        con_orden.sort_by_key(|(orden, _)| *orden);
        let facturas = con_orden.into_iter().map(|(_, f)| f).collect();

        Ok(Some(TicketDePago {
            numero_ticket,
            metodo_pago,
            origen,
            anulado,
            es_devolucion,
            fecha_hora,
            lineas,
            factura,
            facturas,
        }))
    }
}

/// Las líneas que cobró un pago.
async fn lineas_de_pago<R: Reader>(r: &R, id_pago: &str) -> AppResult<Vec<LineaVendida>> {
    let mut rows = r
        .query(SQL_LINEAS, vec![Value::Text(id_pago.to_string())])
        .await
        .map_err(db_err)?;
    let mut lineas = Vec::new();
    while let Some(row) = rows.next().await.map_err(db_err)? {
        lineas.push(LineaVendida {
            nombre: v_string(row.get_value(0).map_err(db_err)?).unwrap_or_default(),
            cantidad: v_f64(row.get_value(1).map_err(db_err)?).unwrap_or(1.0),
            precio_unitario: v_dinero(row.get_value(2).map_err(db_err)?).unwrap_or(Dinero::CERO),
            iva_percent: v_f64(row.get_value(3).map_err(db_err)?),
        });
    }
    Ok(lineas)
}

/// Las líneas que devolvió una devolución. Si lo devuelto de una no es unidades × precio, sale como
/// una unidad por lo devuelto: el papel cuadra con el dinero, que es lo que importa.
async fn lineas_devueltas<R: Reader>(r: &R, id_pago: &str) -> AppResult<Vec<LineaVendida>> {
    let mut rows = r
        .query(SQL_LINEAS_DEVUELTAS, vec![Value::Text(id_pago.to_string())])
        .await
        .map_err(db_err)?;
    let mut lineas = Vec::new();
    while let Some(row) = rows.next().await.map_err(db_err)? {
        let nombre = v_string(row.get_value(0).map_err(db_err)?).unwrap_or_default();
        let cantidad = v_f64(row.get_value(1).map_err(db_err)?).unwrap_or(1.0);
        let precio = v_dinero(row.get_value(2).map_err(db_err)?).unwrap_or(Dinero::CERO);
        let iva_percent = v_f64(row.get_value(3).map_err(db_err)?);
        let importe = v_dinero(row.get_value(4).map_err(db_err)?).unwrap_or(Dinero::CERO);
        let (cantidad, precio_unitario) = if precio.escala(cantidad) == importe {
            (cantidad, precio)
        } else {
            (1.0, importe)
        };
        lineas.push(LineaVendida { nombre, cantidad, precio_unitario, iva_percent });
    }
    Ok(lineas)
}

/// El cobro de un número de ticket, si existe.
async fn pago_de_ticket<R: Reader>(r: &R, num: &str) -> AppResult<Option<String>> {
    let mut rows = r
        .query(SQL_PAGO_DE_TICKET, vec![Value::Text(num.trim().to_string())])
        .await
        .map_err(db_err)?;
    Ok(match rows.next().await.map_err(db_err)? {
        Some(row) => v_string(row.get_value(0).map_err(db_err)?),
        None => None,
    })
}


/// La factura de un número, con el pago al que pertenece.
async fn factura<R: Reader>(
    r: &R,
    num_serie: &str,
) -> AppResult<Option<(FacturaDelTicket, Option<String>)>> {
    let mut rows = r
        .query(SQL_FACTURA, vec![Value::Text(num_serie.to_string())])
        .await
        .map_err(db_err)?;
    let Some(row) = rows.next().await.map_err(db_err)? else {
        return Ok(None);
    };
    let texto = |i: i32| -> AppResult<String> {
        Ok(v_string(row.get_value(i).map_err(db_err)?).unwrap_or_default())
    };
    let desglose = v_string(row.get_value(8).map_err(db_err)?);
    let id_pago = v_string(row.get_value(9).map_err(db_err)?);
    let destinatario = v_string(row.get_value(10).map_err(db_err)?);
    let referencias = v_string(row.get_value(11).map_err(db_err)?);
    let f = FacturaDelTicket {
        num_serie: texto(0)?,
        tipo_factura: texto(1)?,
        nif_emisor: texto(2)?,
        razon_emisor: texto(3)?,
        fecha_expedicion: texto(4)?,
        fecha_hora_huso: texto(5)?,
        qr_url: texto(6)?,
        // El importe se guardó como TEXTO fiscal ("10.00"): se lee a céntimos sin pasar por f64.
        importe_total: Dinero::de_texto_fiscal(&texto(7)?).unwrap_or(Dinero::CERO),
        tramos: crate::verifactu::tramos_declarados(desglose.as_deref()),
        destinatario: crate::verifactu::destinatario_del_papel(destinatario.as_deref()),
        sustituye: crate::verifactu::numeros_sustituidos(referencias.as_deref()),
        rectifica: crate::verifactu::rectificada_del_papel(referencias.as_deref()),
    };
    Ok(Some((f, id_pago)))
}

#[cfg(test)]
mod tests {
    //! Lo que se puede volver a imprimir de un cobro ya hecho.
    //!
    //! Una reimpresión no es "imprimir otra vez lo que hay ahora": es sacar **el mismo papel** que
    //! salió el día de la venta. Por eso los datos salen del cobro (`Pagos` + `Pago_Detalles`) y no
    //! del producto ni de la comanda: entre medias han podido cambiar el precio, el tipo de IVA o
    //! hasta el nombre del plato, y la copia tiene que seguir diciendo lo que se cobró.

    use super::*;
    use crate::ejecutor::Connection;

    async fn db_temporal() -> (Arc<Db>, std::path::PathBuf) {
        let dir = crate::test_temp::dir_temporal("tickets");
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

    /// Euros -> `Dinero`. Los supuestos se escriben en euros; lo que se compara son centimos.
    #[allow(dead_code)]
    fn eur(euros: f64) -> Dinero {
        Dinero::de_euros(euros)
    }

    /// Una venta de barra: dos cafés y una tostada, cobradas de una vez.
    const VENTA_BARRA: &[&str] = &[
        "INSERT INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('cat', 'Bar');",
        "INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta, IVA_Percent)
           VALUES ('p1', 'cat', 'Cafe con leche', 130, 10);",
        "INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta, IVA_Percent)
           VALUES ('p2', 'cat', 'Tostada', 250, 10);",
        "INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura, Estado)
           VALUES ('com', 'BARRA', '2026-01-02 12:00:00', 'Pagada');",
        "INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Nombre_Producto, Cantidad, Precio_Unitario, IVA_Percent)
           VALUES ('d1', 'com', 'p1', 'Cafe con leche', 2, 130, 10);",
        "INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Nombre_Producto, Cantidad, Precio_Unitario, IVA_Percent)
           VALUES ('d2', 'com', 'p2', 'Tostada', 1, 250, 21);",
        "INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo, Numero_Ticket)
           VALUES ('pago', 'com', '2026-01-02 12:30:00', 'Efectivo', 510, 'TOTAL', 'T-000007');",
        "INSERT INTO Pago_Detalles (ID_Pago, ID_Detalle) VALUES ('pago', 'd1');",
        "INSERT INTO Pago_Detalles (ID_Pago, ID_Detalle) VALUES ('pago', 'd2');",
    ];

    fn repo(db: &Arc<Db>) -> SqliteTicketsRepository {
        SqliteTicketsRepository::new(db.clone())
    }

    #[tokio::test]
    async fn un_cobro_que_no_existe_no_devuelve_un_ticket_vacio() {
        // Devolver Some con los campos en blanco imprimiría un papel fantasma con número vacío.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_BARRA).await;

        assert!(repo(&db).ticket_de_pago("no-existe", None).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn la_copia_lleva_el_numero_y_el_metodo_del_cobro_original() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_BARRA).await;

        let t = repo(&db).ticket_de_pago("pago", None).await.unwrap().unwrap();

        assert_eq!(t.numero_ticket, "T-000007");
        assert_eq!(t.metodo_pago, "Efectivo");
    }

    #[tokio::test]
    async fn un_ticket_de_barra_dice_barra() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_BARRA).await;

        let t = repo(&db).ticket_de_pago("pago", None).await.unwrap().unwrap();
        assert_eq!(t.origen, "Barra");
    }

    #[tokio::test]
    async fn un_ticket_de_mesa_dice_que_mesa() {
        // El origen es lo que permite encontrar el cobro después: en un arqueo, "Mesa 4" es la
        // única pista de dónde salió ese dinero.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_BARRA).await;
        sembrar(
            &db,
            &[
                "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('zona', 'Terraza');",
                "INSERT INTO Mesas (ID_Mesa, ID_Zona, Numero_Mesa, Capacidad, Ubicacion_X, Ubicacion_Y, Shape, Width, Height)
                   VALUES ('mesa', 'zona', '4', 4, 0, 0, 'rect', 10, 10);",
                "UPDATE Comandas SET Canal = 'MESA', ID_Mesa = 'mesa' WHERE ID_Comanda = 'com';",
            ],
        )
        .await;

        let t = repo(&db).ticket_de_pago("pago", None).await.unwrap().unwrap();
        assert_eq!(t.origen, "Mesa 4");
    }

    #[tokio::test]
    async fn la_copia_lleva_las_lineas_con_su_cantidad_y_su_precio_unitario() {
        // Dos cafés a 1,30 son "2 x 1,30", no "1 x 2,60". El importe cuadraría igual, pero la
        // copia no diría lo mismo que el original — y una copia que no coincide con el original no
        // sirve para lo que se pide: una devolución, una reclamación, un arqueo.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_BARRA).await;

        let t = repo(&db).ticket_de_pago("pago", None).await.unwrap().unwrap();

        assert_eq!(t.lineas.len(), 2);
        assert_eq!(t.lineas[0].nombre, "Cafe con leche");
        assert_eq!(t.lineas[0].cantidad, 2.0);
        assert_eq!(t.lineas[0].precio_unitario, eur(1.3));
    }

    #[tokio::test]
    async fn cada_linea_conserva_el_tipo_de_iva_con_el_que_se_vendio() {
        // El tipo va congelado en el detalle, no en el producto: si mañana la tostada pasa al 10 %,
        // la copia de hoy tiene que seguir enseñando el 21 % que se cobró.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_BARRA).await;
        sembrar(&db, &["UPDATE Productos SET IVA_Percent = 4 WHERE ID_Producto = 'p2';"]).await;

        let t = repo(&db).ticket_de_pago("pago", None).await.unwrap().unwrap();

        assert_eq!(t.lineas[1].iva_percent, Some(21.0));
    }

    #[tokio::test]
    async fn un_cobro_fraccionado_solo_reimprime_sus_lineas() {
        // Dos amigos pagan por separado: cada uno se llevó un papel con lo suyo, y su copia tiene
        // que llevar lo suyo. Reimprimir la comanda entera enseñaría a uno lo que pagó el otro.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_BARRA).await;
        sembrar(
            &db,
            &[
                "DELETE FROM Pago_Detalles WHERE ID_Pago = 'pago' AND ID_Detalle = 'd2';",
                "INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo, Numero_Ticket)
                   VALUES ('pago2', 'com', '2026-01-02 12:31:00', 'Tarjeta', 250, 'PARCIAL', 'T-000008');",
                "INSERT INTO Pago_Detalles (ID_Pago, ID_Detalle) VALUES ('pago2', 'd2');",
            ],
        )
        .await;

        let uno = repo(&db).ticket_de_pago("pago", None).await.unwrap().unwrap();
        let otro = repo(&db).ticket_de_pago("pago2", None).await.unwrap().unwrap();

        assert_eq!(uno.lineas.len(), 1);
        assert_eq!(uno.lineas[0].nombre, "Cafe con leche");
        assert_eq!(otro.lineas.len(), 1);
        assert_eq!(otro.lineas[0].nombre, "Tostada");
        assert_eq!(otro.metodo_pago, "Tarjeta");
    }

    #[tokio::test]
    async fn borrar_un_producto_vendido_no_se_lleva_por_delante_su_ticket() {
        // INV-05: el catálogo puede quitar lo que ya no se vende. La copia del ticket sale igual,
        // con el nombre que tenía el producto el día de la venta.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_BARRA).await;

        {
            let w = db.write().await;
            w.raw()
                .execute("DELETE FROM Productos WHERE ID_Producto = 'p1';", Vec::<Value>::new())
                .await
                .expect("borrar un producto ya vendido tiene que poder hacerse");
        }

        let t = repo(&db).ticket_de_pago("pago", None).await.unwrap().unwrap();

        assert_eq!(t.lineas.len(), 2, "no puede perderse ninguna línea del cobro");
        assert_eq!(t.lineas[0].nombre, "Cafe con leche");
        assert_eq!(t.lineas[0].cantidad, 2.0);
        assert_eq!(t.lineas[0].precio_unitario, eur(1.3));
        assert_eq!(t.lineas[0].iva_percent, Some(10.0));
    }

    #[tokio::test]
    async fn una_linea_sin_nombre_ni_producto_no_sale_muda() {
        // El cinturón de seguridad: una línea a la que le falten las dos cosas (el snapshot y el
        // producto) sigue siendo un documento contable, y "Producto" se lee mejor que un hueco.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_BARRA).await;
        sembrar(
            &db,
            &[
                "UPDATE Detalle_Comanda SET Nombre_Producto = NULL WHERE ID_Detalle = 'd1';",
                "DELETE FROM Productos WHERE ID_Producto = 'p1';",
            ],
        )
        .await;

        let t = repo(&db).ticket_de_pago("pago", None).await.unwrap().unwrap();
        assert_eq!(t.lineas[0].nombre, "Producto");
    }

    #[tokio::test]
    async fn un_cobro_sin_numero_de_ticket_no_revienta_la_reimpresion() {
        // Los cobros anteriores a que existiera el número correlativo lo tienen a NULL.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_BARRA).await;
        sembrar(&db, &["UPDATE Pagos SET Numero_Ticket = NULL WHERE ID_Pago = 'pago';"]).await;

        let t = repo(&db).ticket_de_pago("pago", None).await.unwrap().unwrap();
        assert_eq!(t.numero_ticket, "");
    }

    /// La factura del cobro de [`VENTA_BARRA`], como la dejó la emisión.
    const FACTURA_DE_LA_VENTA: &[&str] = &[
        "INSERT INTO Registros_Facturacion (ID_Registro, Orden, Tipo, NIF_Emisor, Num_Serie_Factura,
           Fecha_Expedicion, Serie, Numero, Nombre_Razon_Emisor, Tipo_Factura, Importe_Total,
           Cuota_Total, Desglose_Json, Cadena_Huella, Huella, Fecha_Hora_Huso, Sistema_Json, QR_Url,
           ID_Pago)
         VALUES ('reg', 1, 'ALTA', 'B12345674', 'T-000007', '02-01-2026', 'T', 7, 'Bar Pepe SL',
           'F2', '5.10', '0.67',
           '[{\"TipoImpositivo\":\"10.00\",\"BaseImponibleOimporteNoSujeto\":\"2.36\",\"CuotaRepercutida\":\"0.24\"},{\"TipoImpositivo\":\"21.00\",\"BaseImponibleOimporteNoSujeto\":\"2.07\",\"CuotaRepercutida\":\"0.43\"}]',
           'cadena', 'HUELLA', '2026-01-02T12:30:05+01:00', '{}',
           'https://www2.agenciatributaria.gob.es/wlpl/TIKE-CONT/ValidarQR?nif=B12345674', 'pago');",
    ];

    #[tokio::test]
    async fn la_factura_del_cobro_sale_del_registro() {
        // RI-29: el número, la fecha, el QR, el desglose y el total del papel son los declarados.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_BARRA).await;
        sembrar(&db, FACTURA_DE_LA_VENTA).await;

        let t = repo(&db).ticket_de_pago("pago", None).await.unwrap().unwrap();
        let f = t.factura.expect("el cobro tiene factura");

        assert_eq!(f.num_serie, "T-000007");
        assert_eq!(f.tipo_factura, "F2");
        assert_eq!(f.razon_emisor, "Bar Pepe SL");
        assert_eq!(f.fecha_expedicion, "02-01-2026");
        assert_eq!(f.importe_total, eur(5.10));
        assert_eq!(f.tramos.len(), 2);
        assert_eq!((f.tramos[1].tipo, f.tramos[1].base, f.tramos[1].cuota), (21.0, eur(2.07), eur(0.43)));
        assert!(f.qr_url.contains("nif=B12345674"));
    }

    #[tokio::test]
    async fn de_varias_filas_de_alta_vale_la_ultima() {
        // Una subsanación repite el número: lo que se imprime es lo último que se declaró.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_BARRA).await;
        sembrar(&db, FACTURA_DE_LA_VENTA).await;
        sembrar(
            &db,
            &["INSERT INTO Registros_Facturacion (ID_Registro, Orden, Tipo, NIF_Emisor,
                 Num_Serie_Factura, Fecha_Expedicion, Serie, Numero, Nombre_Razon_Emisor, Tipo_Factura,
                 Importe_Total, Cadena_Huella, Huella, Fecha_Hora_Huso, Sistema_Json, QR_Url,
                 Subsanacion, ID_Pago)
               VALUES ('reg2', 2, 'ALTA', 'B12345674', 'T-000007', '02-01-2026', 'T', 7,
                 'Bar Pepe Subsanado SL', 'F2', '5.10', 'c2', 'H2', '2026-01-03T09:00:00+01:00', '{}',
                 'https://qr', 'S', 'pago');"],
        )
        .await;

        let f = repo(&db).ticket_de_pago("pago", None).await.unwrap().unwrap().factura.unwrap();
        assert_eq!(f.razon_emisor, "Bar Pepe Subsanado SL");
    }

    #[tokio::test]
    async fn un_cobro_sin_registro_no_inventa_una_factura() {
        // Un cobro de modo prueba no emite registro: el papel sale sin QR, no con uno vacío.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_BARRA).await;

        let t = repo(&db).ticket_de_pago("pago", None).await.unwrap().unwrap();
        assert!(t.factura.is_none());
        assert_eq!(t.fecha_hora, "2026-01-02 12:30:00");
    }

    #[tokio::test]
    async fn el_ticket_anulado_se_puede_reimprimir_marcado() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_BARRA).await;
        sembrar(
            &db,
            &[
                "INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre)
                   VALUES ('u1', '00000000-0000-7000-8000-000000000001', 'jefe@bar.example', 'x', 'Marta');",
                "UPDATE Pagos SET Estado = 'ANULADO', Anulado_En = '2026-01-02 13:00:00', Anulado_Por = 'u1'
                   WHERE ID_Pago = 'pago';",
            ],
        )
        .await;

        let t = repo(&db).ticket_de_pago("pago", None).await.unwrap().unwrap();

        assert!(t.anulado, "la copia tiene que decir que ese cobro ya no vale");
        assert_eq!(t.lineas.len(), 2, "y seguir enseñando lo que se cobró");
    }

    /// La `F3` que canjeó el ticket de [`FACTURA_DE_LA_VENTA`], con el cliente y su domicilio.
    const F3_DE_LA_VENTA: &[&str] = &[
        "INSERT INTO Registros_Facturacion (ID_Registro, Orden, Tipo, NIF_Emisor, Num_Serie_Factura,
           Fecha_Expedicion, Serie, Numero, Nombre_Razon_Emisor, Tipo_Factura, Importe_Total,
           Desglose_Json, Destinatario_Json, Referencias_Json, Cadena_Huella, Huella,
           Fecha_Hora_Huso, Sistema_Json, QR_Url, ID_Pago)
         VALUES ('reg-f3', 2, 'ALTA', 'B12345674', 'F-000001', '03-01-2026', 'F', 1, 'Bar Pepe SL', 'F3',
           '5.10', '[]',
           '{\"NombreRazon\":\"Cliente SL\",\"NIF\":\"B87654321\",\"Domicilio\":\"Calle Real 2, Madrid\"}',
           '{\"rectificadas\":[],\"sustituidas\":[{\"IDEmisorFactura\":\"B12345674\",\"NumSerieFactura\":\"T-000007\",\"FechaExpedicionFactura\":\"02-01-2026\"}]}',
           'c3', 'H3', '2026-01-03T10:00:00+01:00', '{}', 'https://qr-f3', 'pago');",
    ];

    #[tokio::test]
    async fn la_f3_de_un_cobro_sale_con_su_cliente_y_lo_que_sustituye() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_BARRA).await;
        sembrar(&db, FACTURA_DE_LA_VENTA).await;
        sembrar(&db, F3_DE_LA_VENTA).await;

        let t = repo(&db).ticket_de_pago("pago", Some("F-000001")).await.unwrap().unwrap();
        let f = t.factura.unwrap();

        assert_eq!(f.num_serie, "F-000001");
        assert_eq!(f.tipo_factura, "F3");
        assert_eq!(
            f.destinatario,
            Some(("Cliente SL".into(), "B87654321".into(), Some("Calle Real 2, Madrid".into())))
        );
        assert_eq!(f.sustituye, vec!["T-000007".to_string()]);
        assert_eq!(t.lineas.len(), 2, "las líneas son las del cobro");
    }

    #[tokio::test]
    async fn el_cobro_canjeado_lista_sus_dos_facturas_en_orden() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_BARRA).await;
        sembrar(&db, FACTURA_DE_LA_VENTA).await;
        sembrar(&db, F3_DE_LA_VENTA).await;

        let t = repo(&db).ticket_de_pago("pago", None).await.unwrap().unwrap();
        assert_eq!(t.factura.unwrap().num_serie, "T-000007", "sin pedir otra, la del pago");
        let nums: Vec<&str> = t.facturas.iter().map(|(n, _, _)| n.as_str()).collect();
        assert_eq!(nums, ["T-000007", "F-000001"]);
    }

    #[tokio::test]
    async fn una_factura_de_otro_cobro_no_se_imprime_con_estas_lineas() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_BARRA).await;
        sembrar(&db, FACTURA_DE_LA_VENTA).await;
        sembrar(&db, F3_DE_LA_VENTA).await;
        sembrar(
            &db,
            &["INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo, Numero_Ticket)
                 VALUES ('otro', 'com', '2026-01-02 12:40:00', 'Tarjeta', 100, 'PARCIAL', 'T-000008');"],
        )
        .await;

        assert!(repo(&db).ticket_de_pago("otro", Some("F-000001")).await.is_err());
    }
}

