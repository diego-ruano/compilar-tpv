//! **Qué hace la AEAT con una cadena que no cuadra**: los dos experimentos cuyo resultado
//! recoge `docs/PRUEBAS_AEAT.md`.
//!
//! ```text
//! pnpm verifactu:experimento -- <huella> <NIF> "Razon Social"
//! ```
//!
//! Va **sólo contra preproducción** y emite registros a propósito: es la única forma de responder
//! estas dos preguntas, porque el catálogo de errores permite deducirlas pero no confirmarlas.
//!
//! ## Experimento A — un eslabón anterior que la AEAT no tiene
//!
//! Se emiten dos registros encadenados y se remite **sólo el segundo**. El primero se marca como
//! enviado sin enviarlo, así que la AEAT recibe un registro que declara como anterior una huella que
//! nunca ha visto. Es exactamente lo que pasaría si alguien restaurara una copia antigua y siguiera
//! facturando.
//!
//! ## Experimento B — declararse «primer registro» teniendo ya facturas
//!
//! Base nueva, primer registro de la cadena (`PrimerRegistro='S'`) con un NIF para el que la AEAT
//! **ya tiene** registros. Es el escenario de «resetear la base y empezar de cero», que es justo lo
//! que `PRUEBAS_AEAT.md` manda hacer antes de pasar a producción — conviene saber qué contesta.
//!
//! El error 2007 existe para esto y está en la banda admisible (2000-2999). Lo que se comprueba aquí
//! es que efectivamente sea eso y no un rechazo.

use tpv_domain::dinero::Dinero;

fn main() {
    #[cfg(not(windows))]
    eprintln!("Sólo Windows.");

    #[cfg(windows)]
    {
        use tpv_infra_sqlite::ejecutor::Value;
        use tpv_application::use_cases::verifactu as uc;
        use tpv_domain::ticket::LineaTicket;
        use tpv_infra_sqlite::db::{Db, Reader};
        use tpv_infra_sqlite::verifactu::{
            self as vfdb, DatosFactura, SistemaInformatico, SqliteVerifactuRepository,
        };

        // `pnpm <script> -- …` le pasa el `--` al programa: sin quitarlo, cada argumento caería en el
        // sitio del anterior (la huella sería «--»).
        let a: Vec<String> = std::env::args().skip(1).skip_while(|a| a == "--").collect();
        let (Some(huella), Some(nif), Some(razon)) =
            (a.first().cloned(), a.get(1).cloned(), a.get(2).cloned())
        else {
            eprintln!("Uso: pnpm verifactu:experimento -- <huella> <NIF> \"Razon Social\"");
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

            let abrir = |sub: &str| {
                let dir = std::path::PathBuf::from("target/verifactu-pruebas").join(sub);
                std::fs::create_dir_all(&dir).unwrap();
                dir.join("data.db").to_str().unwrap().to_string()
            };

            let preparar = |db: std::sync::Arc<Db>, nif: String, razon: String| async move {
                let g = db.write().await;
                g.raw()
                    .execute(
                        "UPDATE Business_Settings SET CIF = ?1, Razon_Social = ?2, \
                         Verifactu_Entorno = 'pruebas' WHERE ID = 1;",
                        vec![Value::Text(nif), Value::Text(razon)],
                    )
                    .await
                    .unwrap();
            };

            let emitir = |db: std::sync::Arc<Db>| async move {
                let g = db.write().await;
                vfdb::emitir_alta(
                    &g,
                    DatosFactura {
                        lineas: vec![LineaTicket {
                            total_con_iva: Dinero::de_euros(12.10),
                            tipo_iva: 10.0,
                        }],
                        ..Default::default()
                    },
                )
                .await
                .unwrap()
            };

            let detalle = |db: std::sync::Arc<Db>| async move {
                let r = db.read().await;
                let mut rows = r
                    .query(
                        "SELECT rf.Num_Serie_Factura, COALESCE(rf.Primer_Registro,'-'), e.Estado, \
                                COALESCE(e.Codigo_Error,''), COALESCE(e.Descripcion_Error,'') \
                         FROM Registros_Facturacion rf \
                         JOIN _Verifactu_Envios e ON e.ID_Registro = rf.ID_Registro \
                         ORDER BY rf.Orden;",
                        Vec::<Value>::new(),
                    )
                    .await
                    .unwrap();
                while let Some(row) = rows.next().await.unwrap() {
                    let t = |i: i32| match row.get_value(i) {
                        Ok(Value::Text(s)) => s,
                        _ => String::new(),
                    };
                    println!(
                        "      · {:<16} primero={:<2} {:<22} {}",
                        t(0),
                        t(1),
                        t(2),
                        if t(3).is_empty() { String::new() } else { format!("[{}] {}", t(3), t(4)) }
                    );
                }
            };

            // ── Experimento A ────────────────────────────────────────────────────────────────
            println!("\n═══ EXPERIMENTO A: la AEAT recibe un registro cuyo eslabón anterior NO tiene\n");
            let db_a = Db::open(&abrir("exp-a")).await.unwrap();
            preparar(db_a.clone(), nif.clone(), razon.clone()).await;

            let r1 = emitir(db_a.clone()).await;
            let r2 = emitir(db_a.clone()).await;
            println!("  Emitidos {} y {} (el 2.º encadena con el 1.º)", r1.num_serie_factura, r2.num_serie_factura);

            // El primero se da por enviado SIN enviarlo: así la AEAT nunca ve su huella.
            {
                let g = db_a.write().await;
                g.raw()
                    .execute(
                        "UPDATE _Verifactu_Envios SET Estado = 'ACEPTADO' \
                         WHERE ID_Registro = (SELECT ID_Registro FROM Registros_Facturacion ORDER BY Orden LIMIT 1);",
                        Vec::<Value>::new(),
                    )
                    .await
                    .unwrap();
            }
            println!("  El 1.º se marca como enviado SIN enviarlo. Sólo saldrá el 2.º.");

            let repo_a = SqliteVerifactuRepository::new(db_a.clone());
            let cli = tpv_infra_aeat::AeatAdapter::new();
            println!("\n  Remitiendo…");
            match uc::remitir_ciclo(&repo_a, &cli, Some(&huella), chrono::Local::now().timestamp_millis()).await {
                Ok(Ok(r)) => println!("    enviados {} · aceptados {} · con avisos {} · rechazados {}",
                    r.enviados, r.aceptados, r.aceptados_con_errores, r.rechazados),
                Ok(Err(m)) => println!("    no se envió: {m:?}"),
                Err(e) => println!("    ERROR: {e}"),
            }
            detalle(db_a.clone()).await;

            // ── Experimento B ────────────────────────────────────────────────────────────────
            println!("\n\n═══ EXPERIMENTO B: declararse «primer registro» teniendo ya facturas\n");
            println!("  Esperando 62 s (control de flujo del art. 16.2)…");
            tokio::time::sleep(std::time::Duration::from_secs(62)).await;

            let db_b = Db::open(&abrir("exp-b")).await.unwrap();
            preparar(db_b.clone(), nif.clone(), razon.clone()).await;
            let r = emitir(db_b.clone()).await;
            println!("  Base nueva. Emitido {} con PrimerRegistro='S'.", r.num_serie_factura);

            let repo_b = SqliteVerifactuRepository::new(db_b.clone());
            println!("\n  Remitiendo…");
            match uc::remitir_ciclo(&repo_b, &cli, Some(&huella), chrono::Local::now().timestamp_millis()).await {
                Ok(Ok(r)) => println!("    enviados {} · aceptados {} · con avisos {} · rechazados {}",
                    r.enviados, r.aceptados, r.aceptados_con_errores, r.rechazados),
                Ok(Err(m)) => println!("    no se envió: {m:?}"),
                Err(e) => println!("    ERROR: {e}"),
            }
            detalle(db_b.clone()).await;
        });
    }
}
