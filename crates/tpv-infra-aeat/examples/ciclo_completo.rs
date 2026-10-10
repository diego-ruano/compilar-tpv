//! **El ciclo completo contra la AEAT**: emitir, remitir, anular y volver a remitir.
//!
//! ```text
//! pnpm verifactu:ciclo -- <huella> <NIF> "Razon Social" [pruebas|produccion]
//! ```
//!
//! Es el paso 4 de `docs/PRUEBAS_AEAT.md`, el único que **emite registros de verdad**. Va contra
//! **preproducción** salvo que se escriba `produccion` entero.
//!
//! ## Qué hace, y por qué en ese orden
//!
//! 1. Abre una base **dedicada** (`target/verifactu-pruebas/data.db`), no la del TPV instalado. Así
//!    el equipo de desarrollo no se toca y «borrón y cuenta nueva» es borrar un fichero.
//! 2. Emite dos altas encadenadas por el camino de verdad (`emitir_alta`), no por uno de mentira.
//! 3. Las **remite** con el certificado del almacén de Windows y enseña la respuesta literal.
//! 4. **Anula** las altas que queden vivas y encola las anulaciones.
//! 5. Remite las anulaciones.
//!
//! Los pasos 4 y 5 no son adorno: la AEAT obliga a anular las facturas de prueba, y hacerlo aquí
//! prueba el camino de anulación entero.
//!
//! ## Lo que NO hace
//!
//! No toca la base del TPV instalado, no toca producción salvo que se le pida a gritos, y no saca
//! ningún dato del certificado: sólo usa su huella.

use tpv_domain::dinero::Dinero;

fn main() {
    #[cfg(not(windows))]
    {
        eprintln!("La remisión a la AEAT sólo está disponible en Windows.");
        std::process::exit(2);
    }

    #[cfg(windows)]
    {
        use tpv_infra_sqlite::ejecutor::Value;
        use tpv_application::use_cases::verifactu as uc;
        use tpv_domain::ticket::LineaTicket;
        use tpv_infra_sqlite::db::Db;
        use tpv_infra_sqlite::verifactu::{
            self as vfdb, DatosFactura, SistemaInformatico, SqliteVerifactuRepository,
        };

        // `pnpm <script> -- …` le pasa el `--` al programa: sin quitarlo, cada argumento caería en el
        // sitio del anterior (la huella sería «--»).
        let args: Vec<String> = std::env::args().skip(1).skip_while(|a| a == "--").collect();
        let (Some(huella), Some(nif), Some(razon)) =
            (args.first().cloned(), args.get(1).cloned(), args.get(2).cloned())
        else {
            eprintln!("Uso: pnpm verifactu:ciclo -- <huella> <NIF> \"Razon Social\" [pruebas|produccion]");
            std::process::exit(2);
        };
        let produccion = args.get(3).map(String::as_str) == Some("produccion");

        if produccion {
            eprintln!("⛔ Este arnés NO se usa contra producción: emite facturas REALES que");
            eprintln!("   quedarían en tus libros. Para eso está la aplicación.");
            std::process::exit(2);
        }

        let rt = tokio::runtime::Runtime::new().expect("runtime");
        rt.block_on(async move {
            // ── 1. Base dedicada ──────────────────────────────────────────────────────────────
            let dir = std::path::PathBuf::from("target/verifactu-pruebas");
            std::fs::create_dir_all(&dir).expect("creando el directorio");
            let ruta = dir.join("data.db");
            println!("Base de pruebas : {}", ruta.display());
            let db = Db::open(ruta.to_str().unwrap()).await.expect("abriendo la base");

            // El bloque del productor. Se inyecta el mismo NIF: es DATO DECLARADO y la AEAT no lo
            // contrasta contra ningún registro de actividad. Cuando exista la empresa, esto será su
            // NIF de verdad (docs/pendientes.md, Veri*factu).
            vfdb::set_sistema_informatico(SistemaInformatico {
                nombre_razon: razon.clone(),
                nif: nif.clone(),
                nombre_sistema: "TPV Altaria".into(),
                id_sistema: "01".into(),
                version: "0.1.0-pruebas".into(),
                numero_instalacion: "pruebas-aeat".into(),
            });

            // Datos del obligado y entorno de PRUEBAS.
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
            println!("Entorno         : PRUEBAS (prewww1.aeat.es)\n");

            // ── 2. Dos altas encadenadas ──────────────────────────────────────────────────────
            for i in 1..=2 {
                let g = db.write().await;
                let b = vfdb::emitir_alta(
                    &g,
                    DatosFactura {
                        lineas: vec![LineaTicket {
                            total_con_iva: Dinero::de_euros(11.0 * f64::from(i)),
                            tipo_iva: 10.0,
                        }],
                        ..Default::default()
                    },
                )
                .await
                .expect("emitiendo");
                println!("[2] Emitida {} · huella {}…", b.num_serie_factura, &b.huella[..16]);
                let _ = b;
            }

            let repo = SqliteVerifactuRepository::new(db.clone());
            let cliente = crate_adapter();

            // ── 3. Remitir ────────────────────────────────────────────────────────────────────
            println!("\n[3] Remitiendo a la AEAT…");
            informar(uc::remitir_ciclo(&repo, &cliente, Some(&huella), ahora()).await);
            detalle(&db).await;

            // ── 4. Anular lo que quede vivo ───────────────────────────────────────────────────
            let n = {
                use tpv_infra_sqlite::db::Reader;
                let g = db.write().await;
                let mut ids = Vec::new();
                {
                    let mut rows = g
                        .query(
                            "SELECT a.ID_Registro FROM Registros_Facturacion a \
                             WHERE a.Tipo = 'ALTA' AND NOT EXISTS ( \
                               SELECT 1 FROM Registros_Facturacion n \
                               WHERE n.Tipo = 'ANULACION' \
                                 AND n.Num_Serie_Factura = a.Num_Serie_Factura \
                                 AND n.NIF_Emisor = a.NIF_Emisor) \
                             ORDER BY a.Orden ASC;",
                            Vec::<Value>::new(),
                        )
                        .await
                        .expect("buscando las altas vivas");
                    while let Some(row) = rows.next().await.expect("fila") {
                        if let Ok(Value::Text(id)) = row.get_value(0) {
                            ids.push(id);
                        }
                    }
                }
                for id in &ids {
                    vfdb::emitir_anulacion(&g, id).await.expect("anulando");
                }
                ids.len()
            };
            println!("\n[4] {n} factura(s) de prueba anuladas.");

            // ── 5. Remitir las anulaciones ────────────────────────────────────────────────────
            // El control de flujo del art. 16.2 impone esperar entre envíos: la AEAT dice cuánto en
            // cada respuesta (60 s al principio). Se respeta, que para eso está.
            let espera = repo_espera(&repo).await;
            println!("\n[5] Esperando {espera} s (control de flujo del art. 16.2)…");
            tokio::time::sleep(std::time::Duration::from_secs(espera as u64 + 2)).await;
            println!("    Remitiendo las anulaciones…");
            informar(uc::remitir_ciclo(&repo, &cliente, Some(&huella), ahora()).await);
            detalle(&db).await;

            println!("\n── Estado final ─────────────────────────────────────────────");
            let e = uc::estado(&repo).await.expect("estado");
            println!("  registros   : {}", e.total_registros);
            println!("  aceptados   : {}", e.aceptados);
            println!("  con avisos  : {}", e.aceptados_con_errores);
            println!("  rechazados  : {}", e.rechazados);
            println!("  pendientes  : {}", e.pendientes);
        });
    }
}

/// Guarda cada respuesta de la AEAT en bruto en `target/verifactu-pruebas/respuestas/`: son la
/// materia prima de los tests del parser con respuestas reales (`crates/tpv-infra-aeat/testdata/`),
/// que se copian de aquí **anonimizadas** (llevan el NIF y el nombre del titular).
#[cfg(windows)]
fn crate_adapter() -> tpv_infra_aeat::AeatAdapter {
    tpv_infra_aeat::AeatAdapter::con_volcado("target/verifactu-pruebas/respuestas")
}

#[cfg(windows)]
fn ahora() -> i64 {
    chrono::Local::now().timestamp_millis()
}

/// Lee la espera que dijo la AEAT en la última respuesta.
#[cfg(windows)]
async fn repo_espera(repo: &tpv_infra_sqlite::verifactu::SqliteVerifactuRepository) -> i64 {
    use tpv_application::ports::verifactu::VerifactuRepository;
    repo.flujo().await.map(|(s, _)| s).unwrap_or(60)
}

/// Enseña el recuento del ciclo.
#[cfg(windows)]
fn informar(
    r: tpv_application::error::AppResult<
        Result<
            tpv_application::use_cases::verifactu::ResultadoCiclo,
            tpv_application::use_cases::verifactu::SinEnviar,
        >,
    >,
) {
    match r {
        Ok(Ok(res)) => println!(
            "    enviados {} · aceptados {} · con avisos {} · rechazados {}",
            res.enviados, res.aceptados, res.aceptados_con_errores, res.rechazados
        ),
        Ok(Err(motivo)) => println!("    no se envió: {motivo:?}"),
        Err(e) => println!("    ERROR: {e}"),
    }
}

/// Lo que quedó GUARDADO de cada registro, que es lo que de verdad importa: si la respuesta de la
/// AEAT se interpretó y se persistió bien, no sólo si llegó.
#[cfg(windows)]
async fn detalle(db: &std::sync::Arc<tpv_infra_sqlite::db::Db>) {
    use tpv_infra_sqlite::ejecutor::Value;
    use tpv_infra_sqlite::db::Reader;
    let r = db.read().await;
    let mut rows = r
        .query(
            "SELECT rf.Num_Serie_Factura, rf.Tipo, e.Estado, \
                    COALESCE(e.Codigo_Error,''), COALESCE(e.Descripcion_Error,''), \
                    COALESCE(e.CSV,'') \
             FROM Registros_Facturacion rf \
             JOIN _Verifactu_Envios e ON e.ID_Registro = rf.ID_Registro \
             ORDER BY rf.Orden ASC;",
            Vec::<Value>::new(),
        )
        .await
        .expect("leyendo el detalle");
    while let Some(row) = rows.next().await.expect("fila") {
        let t = |i: i32| -> String {
            match row.get_value(i) {
                Ok(Value::Text(s)) => s,
                _ => String::new(),
            }
        };
        let (cod, desc, csv) = (t(3), t(4), t(5));
        println!(
            "      · {:<18} {:<10} {}{}{}",
            t(0),
            t(1),
            t(2),
            if cod.is_empty() { String::new() } else { format!("  [{cod}] {desc}") },
            if csv.is_empty() { String::new() } else { format!("  CSV={csv}") },
        );
    }
}
