//! Los dos caminos que nunca habían tocado la AEAT: **el lote de 1000** y **la subsanación**.
//!
//! ```text
//! pnpm verifactu:limites -- <huella> <NIF> "Razon Social"
//! ```
//!
//! ## Prueba A — el tope de 1000 registros por envío
//!
//! El art. 16.2 de la Orden pone dos condiciones para el siguiente envío: que pasen `t` segundos **o**
//! que se acumulen 1000 registros, lo que ocurra primero. Nuestro `pendientes()` recorta a 1000 y
//! `puede_enviar()` implementa la regla, pero **un lote de ese tamaño nunca se había mandado**. Lo
//! que se comprueba aquí no es la aritmética —eso está en tests puros— sino que el sobre resultante
//! (unos 2 MB de XML) viaje, que WinHTTP lo suba y que la respuesta con 1000 líneas se parsee.
//!
//! Se manda **una sola vez**: la AEAT pide pruebas puntuales, no masivas.
//!
//! ## Prueba B — la subsanación de un rechazo
//!
//! Un registro rechazado no se reintenta solo: lo saca de ahí `subsanar_rechazados`, que emite una
//! subsanación con el mismo `IDFactura`. Aquí se provoca un rechazo de verdad (una `F1` sin destinatario, error 1189 — comprobado en el
//! banco adversario), se emite la subsanación y se mira si la AEAT la acepta.

use tpv_domain::dinero::Dinero;

fn main() {
    #[cfg(not(windows))]
    eprintln!("Sólo Windows.");

    #[cfg(windows)]
    {
        use libsql::Value;
        use tpv_application::use_cases::verifactu as uc;
        use tpv_domain::ticket::LineaTicket;
        use tpv_infra_sqlite::db::Db;
        use tpv_infra_sqlite::verifactu::{
            self as vfdb, DatosFactura, SistemaInformatico, SqliteVerifactuRepository,
        };

        let a: Vec<String> = std::env::args().skip(1).collect();
        let (Some(huella), Some(nif), Some(razon)) =
            (a.first().cloned(), a.get(1).cloned(), a.get(2).cloned())
        else {
            eprintln!("Uso: pnpm verifactu:limites -- <huella> <NIF> \"Razon Social\"");
            std::process::exit(2);
        };

        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async move {
            vfdb::set_sistema_informatico(SistemaInformatico {
                nombre_razon: razon.clone(),
                nif: nif.clone(),
                nombre_sistema: "TPV Altaria".into(),
                id_sistema: "01".into(),
                version: "0.1.0-pruebas".into(),
                numero_instalacion: "pruebas-aeat".into(),
            });

            let preparar = |sub: &str| {
                let d = std::path::PathBuf::from("target/verifactu-pruebas").join(sub);
                std::fs::create_dir_all(&d).unwrap();
                d.join("data.db").to_str().unwrap().to_string()
            };
            let cli = tpv_infra_aeat::AeatAdapter::new();

            // ══ PRUEBA A: el lote de 1000 ═══════════════════════════════════════════════════════
            println!("\n═══ A · UN LOTE DE 1000 REGISTROS (el tope del art. 16.2) ═══\n");
            let db = Db::open(&preparar("lote")).await.unwrap();
            {
                let g = db.write().await;
                g.raw().execute(
                    "UPDATE Business_Settings SET CIF = ?1, Razon_Social = ?2, Verifactu_Entorno = 'pruebas' WHERE ID = 1;",
                    vec![Value::Text(nif.clone()), Value::Text(razon.clone())],
                ).await.unwrap();
                // Numeración única: repetir números devolvería 3000 y no probaría nada.
                g.raw().execute(
                    "INSERT OR REPLACE INTO Serie_Facturacion (Serie, Ultimo) VALUES (?1, ?2);",
                    vec![
                        Value::Text(chrono::Local::now().format("%Y").to_string()),
                        Value::Integer((chrono::Local::now().timestamp() % 8_000_000) + 1_000_000),
                    ],
                ).await.unwrap();
            }

            let t0 = std::time::Instant::now();
            for _ in 0..1000 {
                let g = db.write().await;
                vfdb::emitir_alta(&g, DatosFactura {
                    lineas: vec![LineaTicket { total_con_iva: Dinero::de_euros(12.10), tipo_iva: 10.0, exento: false, causa_exencion: None }],
                    ..Default::default()
                }).await.unwrap();
            }
            println!("  1000 registros emitidos y encadenados en {:.1} s", t0.elapsed().as_secs_f64());

            let repo = SqliteVerifactuRepository::new(db.clone());
            println!("  Remitiendo el lote…");
            let t1 = std::time::Instant::now();
            match uc::remitir_ciclo(&repo, &cli, Some(&huella), chrono::Local::now().timestamp_millis()).await {
                Ok(Ok(r)) => println!(
                    "  ► enviados {} · aceptados {} · con avisos {} · rechazados {}   ({:.1} s)",
                    r.enviados, r.aceptados, r.aceptados_con_errores, r.rechazados, t1.elapsed().as_secs_f64()
                ),
                Ok(Err(m)) => println!("  ► no se envió: {m:?}"),
                Err(e) => println!("  ► ERROR: {e}"),
            }
            let e = uc::estado(&repo).await.unwrap();
            println!("  Estado: {} aceptados · {} rechazados · {} pendientes", e.aceptados, e.rechazados, e.pendientes);

            // ══ PRUEBA B: la subsanación ════════════════════════════════════════════════════════
            println!("\n\n═══ B · SUBSANACIÓN DE UN RECHAZO ═══\n");
            println!("  Esperando 62 s (control de flujo)…");
            tokio::time::sleep(std::time::Duration::from_secs(62)).await;

            let db2 = Db::open(&preparar("subsana")).await.unwrap();
            {
                let g = db2.write().await;
                g.raw().execute(
                    "UPDATE Business_Settings SET CIF = ?1, Razon_Social = ?2, Verifactu_Entorno = 'pruebas' WHERE ID = 1;",
                    vec![Value::Text(nif.clone()), Value::Text(razon.clone())],
                ).await.unwrap();
                g.raw().execute(
                    "INSERT OR REPLACE INTO Serie_Facturacion (Serie, Ultimo) VALUES (?1, ?2);",
                    vec![
                        Value::Text(chrono::Local::now().format("%Y").to_string()),
                        Value::Integer((chrono::Local::now().timestamp() % 900_000) + 20_000_000),
                    ],
                ).await.unwrap();
            }

            // Se emite normal y se rompe para que la AEAT lo RECHACE (F1 sin destinatario → 1189).
            let b = {
                let g = db2.write().await;
                vfdb::emitir_alta(&g, DatosFactura {
                    lineas: vec![LineaTicket { total_con_iva: Dinero::de_euros(12.10), tipo_iva: 10.0, exento: false, causa_exencion: None }],
                    ..Default::default()
                }).await.unwrap()
            };
            {
                let g = db2.write().await;
                g.raw().execute(
                    "UPDATE Registros_Facturacion SET Tipo_Factura = 'F1', Destinatario_Json = NULL WHERE Num_Serie_Factura = ?1;",
                    vec![Value::Text(b.num_serie_factura.clone())],
                ).await.unwrap();
            }
            println!("  Emitida {} y rota a proposito (F1 sin destinatario).", b.num_serie_factura);

            let repo2 = SqliteVerifactuRepository::new(db2.clone());
            println!("\n  1) Remitiendo — se espera un RECHAZO…");
            let _ = uc::remitir_ciclo(&repo2, &cli, Some(&huella), chrono::Local::now().timestamp_millis()).await;
            estado_de(&db2).await;

            // Se «arregla el programa»: se le pone el destinatario que le faltaba.
            {
                let g = db2.write().await;
                g.raw().execute(
                    "UPDATE Registros_Facturacion SET Destinatario_Json = '{\"NombreRazon\":\"Cliente de Pruebas SL\",\"NIF\":\"B12345674\"}' WHERE Num_Serie_Factura = ?1;",
                    vec![Value::Text(b.num_serie_factura.clone())],
                ).await.unwrap();
            }

            println!("\n  2) Emitiendo la SUBSANACIÓN…");
            let n = vfdb::subsanar_rechazados(&db2).await.unwrap();
            println!("     {n} subsanación(es) emitida(s).");
            estado_de(&db2).await;

            println!("\n  3) Esperando 62 s y remitiendo la subsanación…");
            tokio::time::sleep(std::time::Duration::from_secs(62)).await;
            match uc::remitir_ciclo(&repo2, &cli, Some(&huella), chrono::Local::now().timestamp_millis()).await {
                Ok(Ok(r)) => println!(
                    "     ► enviados {} · aceptados {} · con avisos {} · rechazados {}",
                    r.enviados, r.aceptados, r.aceptados_con_errores, r.rechazados
                ),
                Ok(Err(m)) => println!("     ► no se envió: {m:?}"),
                Err(e) => println!("     ► ERROR: {e}"),
            }
            estado_de(&db2).await;

            // Y que pulsar dos veces no emita dos.
            let repetida = vfdb::subsanar_rechazados(&db2).await.unwrap();
            println!(
                "\n  4) Volver a subsanar emite {repetida} (debe ser 0: ya tiene una por delante)"
            );
        });
    }
}

#[cfg(windows)]
async fn estado_de(db: &std::sync::Arc<tpv_infra_sqlite::db::Db>) {
    use libsql::Value;
    use tpv_infra_sqlite::db::Reader;
    let r = db.read().await;
    let mut rows = r
        .query(
            "SELECT rf.Orden, rf.Num_Serie_Factura, COALESCE(rf.Tipo_Factura,''), \
                    COALESCE(rf.Subsanacion,'-'), COALESCE(rf.Rechazo_Previo,'-'), \
                    e.Estado, COALESCE(e.Codigo_Error,''), COALESCE(e.Descripcion_Error,'') \
             FROM Registros_Facturacion rf JOIN _Verifactu_Envios e ON e.ID_Registro = rf.ID_Registro \
             ORDER BY rf.Orden;",
            Vec::<Value>::new(),
        )
        .await
        .unwrap();
    while let Some(row) = rows.next().await.unwrap() {
        let t = |i: i32| match row.get_value(i) {
            Ok(Value::Text(s)) => s,
            Ok(Value::Integer(n)) => n.to_string(),
            _ => String::new(),
        };
        println!(
            "       #{} {} {}  subsana={} rechazoPrevio={}  → {} {}",
            t(0), t(1), t(2), t(3), t(4), t(5),
            if t(6).is_empty() { String::new() } else { format!("[{}] {}", t(6), t(7)) }
        );
    }
}
