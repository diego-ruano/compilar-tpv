//! **Banco de pruebas adversarias**: se manda mal a propósito y se compara el error que devuelve la
//! AEAT con el que teníamos documentado.
//!
//! ```text
//! pnpm verifactu:errores -- <huella> <NIF> "Razon Social"
//! ```
//!
//! Sólo preproducción. Emite registros rotos a propósito.
//!
//! ## Por qué esto no es paranoia
//!
//! Todo el diseño se apoya en suposiciones sobre qué contesta la AEAT ante cada fallo, y esas
//! suposiciones salieron de **leer** su catálogo de errores. Leer no es comprobar. Dos de ellas
//! sostienen decisiones grandes:
//!
//! - **Que un duplicado sea el 3000** es la idempotencia de todo el sistema: es lo que hace que
//!   reenviar tras un corte, tras una restauración o tras un reintento converja en vez de duplicar.
//! - **Que los códigos 2000-2999 sean admisibles y el resto rechazos** es la clasificación entera.
//!   Si un código que creemos admisible fuera en realidad un rechazo, ese registro se reenviaría
//!   para siempre; y al revés, uno que creemos rechazo y fuera admisible se daría por perdido
//!   estando presentado.
//!
//! Cada caso declara el código que ESPERAMOS y el programa lo compara con el que llega. Un `DISTINTO`
//! aquí es un hallazgo, no un fallo del test.
//!
//! ## Cómo se rompe cada caso
//!
//! Se emite un registro **válido** por el camino de verdad y luego se **manipula su fila** antes de
//! remitir. Así lo que se prueba es la reacción de la AEAT a un dato concreto, y no la capacidad de
//! nuestro propio código para construir algo inválido — que además no puede, porque valida antes.

use tpv_domain::dinero::Dinero;

#[cfg(windows)]
struct Caso {
    nombre: &'static str,
    /// Qué esperamos que conteste la AEAT.
    esperado: i64,
    /// Qué le hacemos a la fila para romperla. `{id}` se sustituye por el ID del registro.
    sql: &'static str,
    /// Por qué esperamos ese código. Se lee al leer el fichero —es la mitad del valor de este
    /// banco de pruebas— y no en ejecución, de ahí el `allow`.
    #[allow(dead_code)]
    porque: &'static str,
    /// ¿Hay que **recalcular la huella** tras manipular?
    ///
    /// Hace falta cuando el campo tocado entra en la cadena hasheada (importe, cuota, tipo de
    /// factura, fecha-hora). Sin recalcular, la AEAT falla en el hash (2000) ANTES de llegar a la
    /// validación de negocio, y el caso no prueba lo que dice probar. Recalculando se simula lo que
    /// de verdad se quiere: un sistema que calcula bien pero declara mal.
    recomputar: bool,
}

fn main() {
    #[cfg(not(windows))]
    eprintln!("Sólo Windows.");

    #[cfg(windows)]
    {
        use libsql::Value;
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
            eprintln!("Uso: pnpm verifactu:errores -- <huella> <NIF> \"Razon Social\"");
            std::process::exit(2);
        };

        // ── El banco ────────────────────────────────────────────────────────────────────────────
        let casos: Vec<Caso> = vec![
            Caso {
                nombre: "huella incorrecta",
                esperado: 2000,
                sql: "UPDATE Registros_Facturacion SET Huella = '0000000000000000000000000000000000000000000000000000000000000000' WHERE ID_Registro = '{id}'",
                porque: "la AEAT recalcula la huella desde los datos que le mandas",
                recomputar: false,
            },
            Caso {
                nombre: "ImporteTotal que no cuadra con el desglose",
                esperado: 2005,
                sql: "UPDATE Registros_Facturacion SET Importe_Total = '99.99' WHERE ID_Registro = '{id}'",
                porque: "base + cuota tienen que dar el total",
                recomputar: true,
            },
            Caso {
                nombre: "CuotaTotal que no cuadra",
                esperado: 2006,
                sql: "UPDATE Registros_Facturacion SET Cuota_Total = '9.99' WHERE ID_Registro = '{id}'",
                porque: "la cuota total es la suma de las repercutidas",
                recomputar: true,
            },
            Caso {
                nombre: "fecha de generacion de hace tres dias",
                esperado: 2004,
                sql: "UPDATE Registros_Facturacion SET Fecha_Hora_Huso = '2026-09-06T10:00:00+02:00' WHERE ID_Registro = '{id}'",
                porque: "tiene que ser la hora actual del sistema de la AEAT, con margen",
                recomputar: true,
            },
            Caso {
                nombre: "F2 CON destinatario (prohibido)",
                esperado: 1190,
                sql: "UPDATE Registros_Facturacion SET Destinatario_Json = '{\"NombreRazon\":\"Cliente SL\",\"NIF\":\"B12345674\"}' WHERE ID_Registro = '{id}'",
                porque: "una simplificada no lleva destinatario",
                recomputar: false,
            },
            Caso {
                nombre: "caracteres prohibidos en la descripcion",
                esperado: 1287,
                sql: "UPDATE Registros_Facturacion SET Descripcion_Operacion = 'Menu <del> dia = \"bueno\"' WHERE ID_Registro = '{id}'",
                porque: "la AEAT prohibe < > \" ' = en los campos de texto libre",
                recomputar: false,
            },
            Caso {
                nombre: "F1 SIN destinatario (obligatorio)",
                esperado: 1189,
                sql: "UPDATE Registros_Facturacion SET Tipo_Factura = 'F1', Destinatario_Json = NULL WHERE ID_Registro = '{id}'",
                porque: "una factura completa necesita a quien va dirigida",
                recomputar: true,
            },
            Caso {
                nombre: "F2 por encima de 3.000 EUR",
                esperado: 1150,
                sql: "UPDATE Registros_Facturacion SET Desglose_Json = '[{\"Impuesto\":\"01\",\"ClaveRegimen\":\"01\",\"CalificacionOperacion\":\"S1\",\"TipoImpositivo\":\"10\",\"BaseImponibleOimporteNoSujeto\":\"4000.00\",\"CuotaRepercutida\":\"400.00\"}]', Importe_Total = '4400.00', Cuota_Total = '400.00' WHERE ID_Registro = '{id}'",
                porque: "el limite de la simplificada, que es la regla de FISCAL-02",
                recomputar: true,
            },
        ];

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

            let dir = std::path::PathBuf::from("target/verifactu-pruebas/errores");
            std::fs::create_dir_all(&dir).unwrap();
            let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
            {
                let g = db.write().await;
                g.raw()
                    .execute(
                        "UPDATE Business_Settings SET CIF = ?1, Razon_Social = ?2, \
                         Verifactu_Entorno = 'pruebas' WHERE ID = 1;",
                        vec![Value::Text(nif.clone()), Value::Text(razon.clone())],
                    )
                    .await
                    .unwrap();
            }

            // ⚠️ NUMERACIÓN ÚNICA POR EJECUCIÓN. Sin esto, la segunda vuelta del banco choca con la
            // primera: la AEAT identifica una factura por (emisor, número, fecha) y devuelve 3000
            // duplicado, que enmascara el error que se quería provocar. Costó un banco entero de
            // resultados inservibles descubrirlo.
            {
                let salto = (chrono::Local::now().timestamp() % 900_000) + 1_000;
                let g = db.write().await;
                g.raw()
                    .execute(
                        "INSERT OR REPLACE INTO Serie_Facturacion (Serie, Ultimo) VALUES (?1, ?2);",
                        vec![
                            Value::Text(chrono::Local::now().format("%Y").to_string()),
                            Value::Integer(salto),
                        ],
                    )
                    .await
                    .unwrap();
                println!("Numeración de esta tanda: a partir de la {}\n", salto + 1);
            }

            // Un registro por caso, y uno más SANO al final: sirve de control (si ese también
            // fallara, el problema sería del envío y no del caso).
            let mut ids: Vec<(String, String)> = Vec::new(); // (num_serie, id_registro)
            for _ in 0..=casos.len() {
                let g = db.write().await;
                let b = vfdb::emitir_alta(
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
                .unwrap();
                drop(g);
                let r = db.read().await;
                let mut rows = r
                    .query(
                        "SELECT ID_Registro FROM Registros_Facturacion WHERE Num_Serie_Factura = ?1;",
                        vec![Value::Text(b.num_serie_factura.clone())],
                    )
                    .await
                    .unwrap();
                let id = match rows.next().await.unwrap() {
                    Some(row) => match row.get_value(0) {
                        Ok(Value::Text(s)) => s,
                        _ => String::new(),
                    },
                    None => String::new(),
                };
                ids.push((b.num_serie_factura, id));
            }

            // Se rompe cada uno a su manera. El último se queda sano.
            for (caso, (_num, id)) in casos.iter().zip(ids.iter()) {
                {
                    let g = db.write().await;
                    let sql = caso.sql.replace("{id}", id);
                    g.raw().execute(&sql, Vec::<Value>::new()).await.unwrap();
                }
                if caso.recomputar {
                    recomputar_huella(&db, id).await;
                }
            }
            println!("Emitidos {} registros: {} rotos a proposito y 1 sano de control.\n", ids.len(), casos.len());

            let repo = SqliteVerifactuRepository::new(db.clone());
            let cli = tpv_infra_aeat::AeatAdapter::new();

            println!("Remitiendo el lote entero…\n");
            match uc::remitir_ciclo(&repo, &cli, Some(&huella), chrono::Local::now().timestamp_millis()).await {
                Ok(Ok(r)) => println!(
                    "  enviados {} · aceptados {} · con avisos {} · rechazados {}\n",
                    r.enviados, r.aceptados, r.aceptados_con_errores, r.rechazados
                ),
                Ok(Err(m)) => println!("  no se envió: {m:?}\n"),
                Err(e) => {
                    println!("  ERROR de envío: {e}\n");
                    return;
                }
            }

            // ── Comparación ─────────────────────────────────────────────────────────────────────
            println!("{:<44} {:>9} {:>9}  VEREDICTO", "CASO", "ESPERADO", "REAL");
            println!("{}", "─".repeat(100));
            let mut sorpresas = Vec::new();
            for (caso, (num, _id)) in casos.iter().zip(ids.iter()) {
                let (estado, cod, desc) = leer(&db, num).await;
                let veredicto = if cod == Some(caso.esperado) {
                    "coincide".to_string()
                } else {
                    sorpresas.push((caso.nombre, caso.esperado, cod, desc.clone(), estado.clone()));
                    "◆ DISTINTO".to_string()
                };
                println!(
                    "{:<44} {:>9} {:>9}  {}",
                    caso.nombre,
                    caso.esperado,
                    cod.map(|c| c.to_string()).unwrap_or_else(|| "-".into()),
                    veredicto
                );
            }
            // El de control.
            let (estado_ok, cod_ok, _) = leer(&db, &ids.last().unwrap().0).await;
            println!(
                "{:<44} {:>9} {:>9}  {}",
                "(control: registro sano)",
                "aceptado",
                cod_ok.map(|c| c.to_string()).unwrap_or_else(|| "-".into()),
                if estado_ok == "ACEPTADO" { "coincide" } else { "◆ DISTINTO" }
            );

            if !sorpresas.is_empty() {
                println!("\n── LO QUE NO ESPERÁBAMOS ────────────────────────────────────────────");
                for (n, esp, real, desc, estado) in &sorpresas {
                    println!("\n  {n}");
                    println!("    esperado : {esp}");
                    println!("    real     : {}  (estado {estado})", real.map(|c| c.to_string()).unwrap_or_else(|| "sin código".into()));
                    println!("    dice     : {desc}");
                }
            } else {
                println!("\nTodos los códigos coinciden con lo documentado.");
            }

            // ── Segunda tanda: el DUPLICADO ─────────────────────────────────────────────────────
            println!("\n\n═══ Y el que sostiene la idempotencia: reenviar lo mismo ═══\n");
            println!("Esperando 62 s (control de flujo)…");
            tokio::time::sleep(std::time::Duration::from_secs(62)).await;

            // Se devuelven todos a PENDIENTE para que el ciclo los reenvíe tal cual.
            {
                let g = db.write().await;
                g.raw()
                    .execute(
                        "UPDATE _Verifactu_Envios SET Estado = 'PENDIENTE', Codigo_Error = NULL, Descripcion_Error = NULL;",
                        Vec::<Value>::new(),
                    )
                    .await
                    .unwrap();
            }
            match uc::remitir_ciclo(&repo, &cli, Some(&huella), chrono::Local::now().timestamp_millis()).await {
                Ok(Ok(r)) => println!(
                    "  enviados {} · aceptados {} · con avisos {} · rechazados {}",
                    r.enviados, r.aceptados, r.aceptados_con_errores, r.rechazados
                ),
                Ok(Err(m)) => println!("  no se envió: {m:?}"),
                Err(e) => println!("  ERROR: {e}"),
            }
            let (estado_dup, cod_dup, desc_dup) = leer(&db, &ids.last().unwrap().0).await;
            println!("\n  El registro SANO reenviado:");
            println!("    esperado : 3000 (duplicado), y que lo tratemos como ACEPTADO");
            println!("    real     : {}  → estado guardado: {estado_dup}",
                cod_dup.map(|c| c.to_string()).unwrap_or_else(|| "sin código".into()));
            println!("    dice     : {desc_dup}");
            println!(
                "\n  {}",
                if cod_dup == Some(3000) && estado_dup == "ACEPTADO" {
                    "coincide — la idempotencia del sistema se sostiene"
                } else {
                    "◆ DISTINTO — revisar `clasificar()`: de esto depende toda la idempotencia"
                }
            );
        });
    }
}

/// Recalcula `Cadena_Huella` y `Huella` de una fila **con los datos que tenga ahora**.
///
/// Es lo que convierte una manipulación en un caso útil: sin esto, tocar un campo hasheado hace que
/// la AEAT falle en el hash (2000) antes de mirar nada más, y el caso no prueba lo que dice probar.
/// Con esto, el registro es internamente coherente y la validación de negocio llega a ejecutarse.
#[cfg(windows)]
async fn recomputar_huella(db: &std::sync::Arc<tpv_infra_sqlite::db::Db>, id: &str) {
    use libsql::Value;
    use tpv_infra_sqlite::db::Reader;

    let (emisor, num, fecha, tipo, cuota, importe, ant, fhh) = {
        let r = db.read().await;
        let mut rows = r
            .query(
                "SELECT NIF_Emisor, Num_Serie_Factura, Fecha_Expedicion, COALESCE(Tipo_Factura,''), \
                        COALESCE(Cuota_Total,''), COALESCE(Importe_Total,''), \
                        COALESCE(Ant_Huella,''), Fecha_Hora_Huso \
                 FROM Registros_Facturacion WHERE ID_Registro = ?1;",
                vec![Value::Text(id.to_string())],
            )
            .await
            .unwrap();
        let row = rows.next().await.unwrap().unwrap();
        let t = |i: i32| match row.get_value(i) {
            Ok(Value::Text(s)) => s,
            _ => String::new(),
        };
        (t(0), t(1), t(2), t(3), t(4), t(5), t(6), t(7))
    };

    let cadena = tpv_domain::verifactu::cadena_huella_alta(&tpv_domain::verifactu::EntradaHuellaAlta {
        id_emisor_factura: &emisor,
        num_serie_factura: &num,
        fecha_expedicion_factura: &fecha,
        tipo_factura: &tipo,
        cuota_total: &cuota,
        importe_total: &importe,
        huella_anterior: if ant.is_empty() { None } else { Some(&ant) },
        fecha_hora_huso: &fhh,
    });
    let h = tpv_domain::verifactu::huella(&cadena);

    let g = db.write().await;
    g.raw()
        .execute(
            "UPDATE Registros_Facturacion SET Cadena_Huella = ?2, Huella = ?3 WHERE ID_Registro = ?1;",
            vec![Value::Text(id.to_string()), Value::Text(cadena), Value::Text(h)],
        )
        .await
        .unwrap();
}

#[cfg(windows)]
async fn leer(
    db: &std::sync::Arc<tpv_infra_sqlite::db::Db>,
    num_serie: &str,
) -> (String, Option<i64>, String) {
    use libsql::Value;
    use tpv_infra_sqlite::db::Reader;
    let r = db.read().await;
    let mut rows = r
        .query(
            "SELECT e.Estado, COALESCE(e.Codigo_Error,''), COALESCE(e.Descripcion_Error,'') \
             FROM Registros_Facturacion rf JOIN _Verifactu_Envios e ON e.ID_Registro = rf.ID_Registro \
             WHERE rf.Num_Serie_Factura = ?1;",
            vec![Value::Text(num_serie.to_string())],
        )
        .await
        .unwrap();
    match rows.next().await.unwrap() {
        Some(row) => {
            let t = |i: i32| match row.get_value(i) {
                Ok(Value::Text(s)) => s,
                _ => String::new(),
            };
            (t(0), t(1).parse::<i64>().ok(), t(2))
        }
        None => (String::new(), None, String::new()),
    }
}
