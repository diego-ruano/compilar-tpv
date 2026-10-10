//! **Devoluciones, canjes y correcciones contra la AEAT** (preproducción).
//!
//! ```text
//! pnpm verifactu:devoluciones -- <huella> <NIF> "Razon Social"
//! ```
//!
//! Lleva a la AEAT cada registro que emiten la baja de un cobro, la devolución de parte de él, el
//! canje de tickets por una `F3` y la corrección del cliente de una factura completa, **por el camino
//! de verdad** (los repositorios de la aplicación, no `emitir_alta` a mano), y enseña lo que contesta
//! a cada uno. El cliente de las facturas completas es el propio obligado: es un NIF que seguro está
//! en el censo.
//!
//! Va en tres tandas, porque una anulación tiene que llegar después de lo que anula:
//!
//! 1. Las altas: cobros, devoluciones parciales y enteras (`R5`, `R1` con la parte que queda), canjes
//!    de uno y de varios tickets, la `F3` negativa de un canje devuelto y las correcciones (`F3`
//!    negativa + nueva, `R4` por sustitución con `ImporteRectificacion`).
//! 2. Las bajas por error: la de un cobro con una devolución parcial (anula la `R5` y el ticket), la
//!    de un ticket canjeado (la `F3` y el ticket) y la de un ticket dentro de una `F3` de varios (su
//!    `F3` negativa y el ticket).
//! 3. La anulación de todo lo que quede vivo: las facturas de prueba no se dejan en pie.
//!
//! ## La base
//!
//! Es una copia de la última base de los arneses (`target/verifactu-pruebas/cero/data.db`, o
//! `data.db`), para seguir su cadena y su numeración: una base nueva repetiría `2026/000001` y la
//! AEAT contestaría «duplicado» (3000), que tapa lo que se quiere ver. La copia se pone al día con el
//! esquema actual —columnas que falten y el `0001` vuelto a pasar, que es idempotente— porque el hash
//! de la migración cambia cada vez que se edita.
//!
//! Va contra **preproducción** siempre: el entorno lo fija el arnés en `pruebas`.

fn main() {
    #[cfg(not(windows))]
    {
        eprintln!("La remisión a la AEAT sólo está disponible en Windows.");
        std::process::exit(2);
    }

    #[cfg(windows)]
    windows::main();
}

#[cfg(windows)]
mod windows {
    use std::path::{Path, PathBuf};
    use std::sync::Arc;

    use tpv_infra_sqlite::ejecutor::Value;
    use tpv_application::ports::cuentas::{AnularPagoArgs, ClaseBaja, CuentasRepository, DevolverLineasArgs};
    use tpv_application::ports::venta_rapida::VentaRapidaRepository;
    use tpv_application::ports::verifactu::VerifactuRepository;
    use tpv_application::use_cases::verifactu as uc;
    use tpv_domain::dinero::Dinero;
    use tpv_domain::verifactu::Destinatario;
    use tpv_infra_sqlite::cuentas::SqliteCuentasRepository;
    use tpv_infra_sqlite::db::{Db, Reader, Writer};
    use tpv_infra_sqlite::util::new_id;
    use tpv_infra_sqlite::venta_rapida::SqliteVentaRapidaRepository;
    use tpv_infra_sqlite::verifactu::{self as vfdb, SistemaInformatico, SqliteVerifactuRepository};

    const DIR: &str = "target/verifactu-pruebas/devoluciones";

    pub fn main() {
        let args: Vec<String> = std::env::args().skip(1).skip_while(|a| a == "--").collect();
        let (Some(huella), Some(nif), Some(razon)) =
            (args.first().cloned(), args.get(1).cloned(), args.get(2).cloned())
        else {
            eprintln!("Uso: pnpm verifactu:devoluciones -- <huella> <NIF> \"Razon Social\"");
            std::process::exit(2);
        };

        let rt = tokio::runtime::Runtime::new().expect("runtime");
        rt.block_on(async move {
            let db = preparar_base().await;
            vfdb::set_sistema_informatico(SistemaInformatico {
                nombre_razon: razon.clone(),
                nif: nif.clone(),
                nombre_sistema: "TPV Altaria".into(),
                id_sistema: "01".into(),
                version: "0.1.0-pruebas".into(),
                numero_instalacion: "pruebas-aeat".into(),
            });
            {
                let g = db.write().await;
                g.raw()
                    .execute(
                        "UPDATE Business_Settings SET CIF = ?1, Razon_Social = ?2, \
                         Verifactu_Entorno = 'pruebas' WHERE ID = 1;",
                        vec![Value::Text(nif.clone()), Value::Text(razon.clone())],
                    )
                    .await
                    .expect("configurando el obligado");
            }
            vfdb::set_modo_prueba(&db, false).await.expect("sin modo prueba");
            sembrar_catalogo(&db).await;
            println!("Entorno         : PRUEBAS (prewww1.aeat.es)");

            let desde = max_orden(&db).await;
            println!("Último registro de la base: Orden {desde}\n");

            let c = Casos {
                db: db.clone(),
                cliente: Destinatario { nombre_razon: razon.clone(), nif: nif.clone(), direccion: None },
            };
            let repo = SqliteVerifactuRepository::new(db.clone());
            let aeat = tpv_infra_aeat::AeatAdapter::con_volcado("target/verifactu-pruebas/respuestas");

            // ── Tanda 1: las altas ────────────────────────────────────────────────────────────
            println!("── Tanda 1: altas ───────────────────────────────────────────");

            // A. Devolución parcial de un ticket, en tres veces: la última se lleva lo que queda.
            let a = c.cobrar(None).await;
            c.devolver(&a, &[(0, 1.0)], "A1 una caña").await;
            c.devolver(&a, &[(0, 1.0)], "A2 otra caña").await;
            c.devolver(&a, &[(0, 1.0), (1, 2.0)], "A3 lo que queda (desglose = lo que falta)").await;

            // B. Devolución parcial de un ticket canjeado: R5 + F3 negativa con el cliente.
            let b = c.cobrar(None).await;
            c.canjear(&[&b], "B canje").await;
            c.devolver(&b, &[(0, 1.0)], "B devolución parcial de un ticket canjeado").await;

            // C. Devolución parcial de una F1: R1 con el cliente.
            let cc = c.cobrar(Some(())).await;
            c.devolver(&cc, &[(1, 1.0)], "C devolución parcial de una F1").await;

            // D. F1 corregida (R4 por sustitución) y luego devuelta en parte: la R1 rectifica la R4.
            let d = c.cobrar(Some(())).await;
            c.corregir(&d.num, "D corrección de la F1 (R4 S)").await;
            c.devolver(&d, &[(0, 1.0)], "D devolución parcial de la F1 corregida").await;

            // E. Devolución entera de un ticket: R5.
            let e = c.cobrar(None).await;
            c.baja(&e, ClaseBaja::Devolucion, "E devolución entera de un ticket").await;

            // F. Una F3 de dos tickets, y su corrección (F3 negativa + F3 nueva).
            let f1 = c.cobrar(None).await;
            let f2 = c.cobrar(None).await;
            let f3 = c.canjear(&[&f1, &f2], "F canje de dos tickets").await;
            if let Some(n) = f3 {
                c.corregir(&n, "F corrección de la F3 de dos tickets").await;
            }

            // G. Devolución entera de una F1: R1.
            let g = c.cobrar(Some(())).await;
            c.baja(&g, ClaseBaja::Devolucion, "G devolución entera de una F1").await;

            // H. Devolución entera de un ticket canjeado: R5 + F3 negativa.
            let h = c.cobrar(None).await;
            c.canjear(&[&h], "H canje").await;
            c.baja(&h, ClaseBaja::Devolucion, "H devolución entera de un ticket canjeado").await;

            // Lo que se da de baja en la tanda 2 tiene que estar ya en la AEAT.
            let i = c.cobrar(None).await;
            c.devolver(&i, &[(0, 1.0)], "I devolución parcial (se deshará)").await;
            let j = c.cobrar(None).await;
            c.canjear(&[&j], "J canje (se deshará)").await;
            let k1 = c.cobrar(None).await;
            let k2 = c.cobrar(None).await;
            c.canjear(&[&k1, &k2], "K canje de dos tickets").await;

            remitir_todo(&repo, &aeat, &huella).await;

            // ── Tanda 2: bajas por error ──────────────────────────────────────────────────────
            println!("\n── Tanda 2: bajas por error ─────────────────────────────────");
            c.baja(&i, ClaseBaja::Error, "I baja por error con una devolución parcial").await;
            c.baja(&j, ClaseBaja::Error, "J baja por error de un ticket canjeado").await;
            c.baja(&k1, ClaseBaja::Error, "K baja por error de un ticket de una F3 de dos").await;
            remitir_todo(&repo, &aeat, &huella).await;

            // ── Tanda 3: anular lo que quede vivo ─────────────────────────────────────────────
            println!("\n── Tanda 3: anular las facturas de prueba que quedan ────────");
            let n = anular_vivas(&db, desde).await;
            println!("  {n} anulación(es) emitidas");
            remitir_todo(&repo, &aeat, &huella).await;

            println!("\n── Lo que contestó la AEAT a cada registro ──────────────────");
            detalle(&db, desde).await;
            let est = uc::estado(&repo).await.expect("estado");
            println!("\n  aceptados {} · con avisos {} · rechazados {} · pendientes {}",
                est.aceptados, est.aceptados_con_errores, est.rechazados, est.pendientes);
        });
    }

    /// Un cobro hecho: su pago, su número y sus líneas.
    struct Cobro {
        id_pago: String,
        num: String,
        detalles: Vec<String>,
    }

    struct Casos {
        db: Arc<Db>,
        cliente: Destinatario,
    }

    impl Casos {
        /// Una comanda de barra con tres cañas a 3,33 € (10 %) y dos vinos a 4,00 € (21 %), cobrada
        /// en efectivo. Con `Some(())`, con el cliente: una `F1`.
        async fn cobrar(&self, con_cliente: Option<()>) -> Cobro {
            let id_comanda = new_id();
            let detalles = vec![new_id(), new_id()];
            {
                let g = self.db.write().await;
                let w = g.raw();
                w.execute(
                    "INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura, Estado, Total_Comanda) \
                     VALUES (?1, 'BARRA', datetime('now','localtime'), 'Abierta', 1799);",
                    vec![Value::Text(id_comanda.clone())],
                )
                .await
                .expect("comanda");
                for (det, prod, cant, precio, iva) in [
                    (&detalles[0], "pruebas-cana", 3.0, 333, 10.0),
                    (&detalles[1], "pruebas-vino", 2.0, 400, 21.0),
                ] {
                    w.execute(
                        "INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Cantidad, \
                         Precio_Unitario, IVA_Percent) VALUES (?1, ?2, ?3, ?4, ?5, ?6);",
                        vec![
                            Value::Text(det.clone()),
                            Value::Text(id_comanda.clone()),
                            Value::Text(prod.into()),
                            Value::Real(cant),
                            Value::Integer(precio),
                            Value::Real(iva),
                        ],
                    )
                    .await
                    .expect("línea");
                }
            }
            let id_pago = new_id();
            SqliteVentaRapidaRepository::new(self.db.clone())
                .cobrar_fraccionado(tpv_domain::venta_rapida::CobroFraccionado {
                    id_pago: id_pago.clone(),
                    id_comanda,
                    metodo: tpv_domain::pago::MetodoPago::Efectivo,
                    importe_total: Dinero::CERO,
                    id_usuario_cobrador: Some("pruebas-u1".into()),
                    id_trabajador_cobrador: None,
                    detalles: detalles.clone(),
                    destinatario: con_cliente.map(|_| self.cliente.clone()),
                })
                .await
                .expect("el cobro tiene que salir");
            let num = texto(&self.db, "SELECT Numero_Ticket FROM Pagos WHERE ID_Pago = ?1;", &id_pago)
                .await
                .unwrap_or_default();
            println!("  cobro {num} ({})", if con_cliente.is_some() { "F1" } else { "F2" });
            Cobro { id_pago, num, detalles }
        }

        async fn devolver(&self, cobro: &Cobro, lineas: &[(usize, f64)], que: &str) {
            let r = SqliteCuentasRepository::new(self.db.clone())
                .devolver_lineas(DevolverLineasArgs {
                    id_pago: cobro.id_pago.clone(),
                    id_usuario: "pruebas-u1".into(),
                    motivo: "prueba AEAT".into(),
                    metodo: tpv_domain::pago::MetodoDevolucion::Efectivo,
                    lineas: lineas.iter().map(|(i, n)| (cobro.detalles[*i].clone(), *n)).collect(),
                })
                .await;
            match r {
                Ok(d) => println!(
                    "  {que}: {} ({} €)",
                    d.num_factura.unwrap_or_default(),
                    d.importe.texto_fiscal()
                ),
                Err(e) => println!("  {que}: ERROR {e}"),
            }
        }

        async fn baja(&self, cobro: &Cobro, clase: ClaseBaja, que: &str) {
            let r = SqliteCuentasRepository::new(self.db.clone())
                .anular_pago(AnularPagoArgs {
                    id_pago: cobro.id_pago.clone(),
                    id_usuario: "pruebas-u1".into(),
                    motivo: "prueba AEAT".into(),
                    clase,
                })
                .await;
            match r {
                Ok(_) => println!("  {que}: hecha"),
                Err(e) => println!("  {que}: ERROR {e}"),
            }
        }

        async fn canjear(&self, cobros: &[&Cobro], que: &str) -> Option<String> {
            let ids: Vec<String> = cobros.iter().map(|c| c.id_pago.clone()).collect();
            match SqliteVerifactuRepository::new(self.db.clone())
                .emitir_sustitutiva(&ids, self.cliente.clone())
                .await
            {
                Ok(b) => {
                    println!("  {que}: {}", b.num_serie_factura);
                    Some(b.num_serie_factura)
                }
                Err(e) => {
                    println!("  {que}: ERROR {e}");
                    None
                }
            }
        }

        async fn corregir(&self, num: &str, que: &str) {
            match SqliteVerifactuRepository::new(self.db.clone())
                .corregir_factura(num, self.cliente.clone())
                .await
            {
                Ok(b) => println!("  {que}: {}", b.num_serie_factura),
                Err(e) => println!("  {que}: ERROR {e}"),
            }
        }
    }

    /// La copia de la última base de los arneses, puesta al día con el esquema actual.
    async fn preparar_base() -> Arc<Db> {
        std::fs::create_dir_all(DIR).expect("creando el directorio");
        let ruta = PathBuf::from(DIR).join("data.db");
        if !ruta.exists() {
            let origen = ["target/verifactu-pruebas/cero/data.db", "target/verifactu-pruebas/data.db"]
                .into_iter()
                .map(PathBuf::from)
                .find(|p| p.exists())
                .expect("no hay ninguna base de los arneses que continuar");
            std::fs::copy(&origen, &ruta).expect("copiando la base");
            println!("Base de pruebas : copia de {}", origen.display());
            poner_al_dia(&ruta).await;
        }
        println!("Base de pruebas : {}", ruta.display());
        Db::open(ruta.to_str().unwrap()).await.expect("abriendo la base")
    }

    /// Añade a la copia las columnas que el esquema actual tiene y ella no, y le quita el `0001` de
    /// `_migrations` para que `Db::open` lo vuelva a pasar: todo él es `IF NOT EXISTS` y
    /// `INSERT OR IGNORE`, así que crea lo nuevo y deja lo demás.
    async fn poner_al_dia(ruta: &Path) {
        let ref_dir = PathBuf::from(DIR).join("esquema");
        let _ = std::fs::remove_dir_all(&ref_dir);
        std::fs::create_dir_all(&ref_dir).expect("directorio del esquema");
        let referencia = Db::open(ref_dir.join("data.db").to_str().unwrap())
            .await
            .expect("esquema de referencia");

        let vieja = libsql::Builder::new_local(ruta.to_str().unwrap())
            .build()
            .await
            .expect("abriendo la copia")
            .connect()
            .expect("conectando a la copia");

        let tablas = columna(&referencia, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%';").await;
        for t in tablas {
            let existe = {
                let mut rs = vieja
                    .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1;", vec![Value::Text(t.clone())])
                    .await
                    .expect("mirando la tabla");
                rs.next().await.expect("fila").is_some()
            };
            if !existe {
                continue; // la crea el 0001
            }
            let nuevas = columnas(&referencia, &t).await;
            let viejas: Vec<String> = {
                let mut rs = vieja.query(&format!("PRAGMA table_info(\"{t}\");"), ()).await.expect("table_info");
                let mut v = Vec::new();
                while let Some(r) = rs.next().await.expect("fila") {
                    if let Ok(Value::Text(n)) = r.get_value(1) {
                        v.push(n);
                    }
                }
                v
            };
            for (nombre, tipo, defecto) in nuevas {
                if viejas.contains(&nombre) {
                    continue;
                }
                let def = defecto.map(|d| format!(" DEFAULT {d}")).unwrap_or_default();
                vieja
                    .execute(&format!("ALTER TABLE \"{t}\" ADD COLUMN \"{nombre}\" {tipo}{def};"), ())
                    .await
                    .unwrap_or_else(|e| panic!("añadiendo {t}.{nombre}: {e}"));
                println!("  esquema: + {t}.{nombre}");
            }
        }
        vieja
            .execute("DELETE FROM _migrations WHERE name = '0001_inicial.sql';", ())
            .await
            .expect("quitando el 0001");
    }

    async fn columna(db: &Arc<Db>, sql: &str) -> Vec<String> {
        let r = db.read().await;
        let mut rs = r.query(sql, Vec::<Value>::new()).await.expect("consulta");
        let mut v = Vec::new();
        while let Some(row) = rs.next().await.expect("fila") {
            if let Ok(Value::Text(s)) = row.get_value(0) {
                v.push(s);
            }
        }
        v
    }

    async fn columnas(db: &Arc<Db>, tabla: &str) -> Vec<(String, String, Option<String>)> {
        let r = db.read().await;
        let mut rs = r
            .query(&format!("PRAGMA table_info(\"{tabla}\");"), Vec::<Value>::new())
            .await
            .expect("table_info");
        let mut v = Vec::new();
        while let Some(row) = rs.next().await.expect("fila") {
            let t = |i: i32| match row.get_value(i) {
                Ok(Value::Text(s)) => Some(s),
                _ => None,
            };
            v.push((t(1).unwrap_or_default(), t(2).unwrap_or_default(), t(4)));
        }
        v
    }

    async fn sembrar_catalogo(db: &Arc<Db>) {
        let g = db.write().await;
        for sql in [
            "INSERT OR IGNORE INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre) \
             VALUES ('pruebas-u1', '00000000-0000-7000-8000-000000000001', 'pruebas-aeat@tpv.invalid', 'x', 'Pruebas');",
            "INSERT OR IGNORE INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('pruebas-cat', 'Pruebas AEAT');",
            "INSERT OR IGNORE INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta) \
             VALUES ('pruebas-cana', 'pruebas-cat', 'Caña', 333);",
            "INSERT OR IGNORE INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta) \
             VALUES ('pruebas-vino', 'pruebas-cat', 'Vino', 400);",
        ] {
            g.raw().execute(sql, ()).await.unwrap_or_else(|e| panic!("sembrando: {e}"));
        }
    }

    async fn texto(db: &Arc<Db>, sql: &str, arg: &str) -> Option<String> {
        let r = db.read().await;
        let mut rs = r.query(sql, vec![Value::Text(arg.into())]).await.ok()?;
        match rs.next().await.ok()??.get_value(0) {
            Ok(Value::Text(s)) => Some(s),
            _ => None,
        }
    }

    async fn max_orden(db: &Arc<Db>) -> i64 {
        let r = db.read().await;
        let mut rs = r
            .query("SELECT COALESCE(MAX(Orden), 0) FROM Registros_Facturacion;", Vec::<Value>::new())
            .await
            .expect("max orden");
        match rs.next().await.expect("fila").map(|row| row.get_value(0)) {
            Some(Ok(Value::Integer(n))) => n,
            _ => 0,
        }
    }

    /// Remite hasta que no quede nada pendiente, respetando la espera que dice la AEAT.
    async fn remitir_todo(repo: &SqliteVerifactuRepository, aeat: &tpv_infra_aeat::AeatAdapter, huella: &str) {
        for _ in 0..10 {
            let pendientes = repo.contar_pendientes().await.unwrap_or(0);
            if pendientes == 0 {
                return;
            }
            let ahora = chrono::Local::now().timestamp_millis();
            match uc::remitir_ciclo(repo, aeat, Some(huella), ahora).await {
                Ok(Ok(r)) => println!(
                    "  remitidos {} · aceptados {} · con avisos {} · rechazados {}",
                    r.enviados, r.aceptados, r.aceptados_con_errores, r.rechazados
                ),
                Ok(Err(motivo)) => {
                    let espera = repo.flujo().await.map(|(s, _)| s).unwrap_or(60).max(1);
                    println!("  ({motivo:?}: espero {espera} s)");
                    tokio::time::sleep(std::time::Duration::from_secs(espera as u64 + 2)).await;
                }
                Err(e) => {
                    println!("  ERROR al remitir: {e}");
                    return;
                }
            }
        }
    }

    /// Anula, de la última a la primera, las altas de esta tanda que sigan vivas.
    async fn anular_vivas(db: &Arc<Db>, desde: i64) -> usize {
        let g = db.write().await;
        let mut ids = Vec::new();
        {
            let mut rs = g
                .query(
                    "SELECT a.ID_Registro FROM Registros_Facturacion a \
                     WHERE a.Tipo = 'ALTA' AND a.Orden > ?1 \
                       AND NOT EXISTS (SELECT 1 FROM Registros_Facturacion b \
                                       WHERE b.Tipo = 'ALTA' AND b.Num_Serie_Factura = a.Num_Serie_Factura \
                                         AND b.Orden > a.Orden) \
                       AND NOT EXISTS (SELECT 1 FROM Registros_Facturacion n \
                                       WHERE n.Tipo = 'ANULACION' AND n.Num_Serie_Factura = a.Num_Serie_Factura \
                                         AND n.NIF_Emisor = a.NIF_Emisor) \
                     ORDER BY a.Orden DESC;",
                    vec![Value::Integer(desde)],
                )
                .await
                .expect("altas vivas");
            while let Some(row) = rs.next().await.expect("fila") {
                if let Ok(Value::Text(id)) = row.get_value(0) {
                    ids.push(id);
                }
            }
        }
        g.execute_batch("BEGIN;").await.expect("begin");
        for id in &ids {
            vfdb::emitir_anulacion(&g, id).await.expect("anulando");
        }
        g.execute_batch("COMMIT;").await.expect("commit");
        ids.len()
    }

    /// Cada registro de esta prueba, con lo que la AEAT contestó y quedó guardado.
    async fn detalle(db: &Arc<Db>, desde: i64) {
        let r = db.read().await;
        let mut rs = r
            .query(
                "SELECT rf.Orden, rf.Num_Serie_Factura, rf.Tipo, COALESCE(rf.Tipo_Factura,''), \
                        COALESCE(rf.Tipo_Rectificativa,''), COALESCE(rf.Importe_Total,''), \
                        COALESCE(e.Estado,''), COALESCE(e.Codigo_Error,''), COALESCE(e.Descripcion_Error,'') \
                 FROM Registros_Facturacion rf \
                 LEFT JOIN _Verifactu_Envios e ON e.ID_Registro = rf.ID_Registro \
                 WHERE rf.Orden > ?1 ORDER BY rf.Orden ASC;",
                vec![Value::Integer(desde)],
            )
            .await
            .expect("detalle");
        while let Some(row) = rs.next().await.expect("fila") {
            let t = |i: i32| match row.get_value(i) {
                Ok(Value::Text(s)) => s,
                Ok(Value::Integer(n)) => n.to_string(),
                _ => String::new(),
            };
            let (cod, desc) = (t(7), t(8));
            println!(
                "  {:>4} {:<16} {:<9} {:<3}{:<2} {:>8}  {}{}",
                t(0),
                t(1),
                t(2),
                t(3),
                t(4),
                t(5),
                t(6),
                if cod.is_empty() { String::new() } else { format!("  [{cod}] {desc}") },
            );
        }
    }
}
