//! DO-SUBIDA · La Main sube su base entera a una nube devuelta en modo «main», de punta a punta, con
//! SQLite real en los dos lados: la base de la Main y la de una nube que contesta los pasos como el
//! `TenantHub` (`comun/nube_de_subida.rs`).

mod comun;

use std::sync::Arc;

use serde_json::json;

use comun::nube_de_subida::NubeDeSubida;
use tpv_application::ports::subida_completa::{Conciliacion, PasoHecho, PeticionDeSubida, SubidaCompleta};
use tpv_infra_sqlite::db::Db;
use tpv_infra_sqlite::ejecutor::Value;
use tpv_infra_sqlite::subida_completa::{estado_para_la_pantalla, SqliteSubidaCompleta};

async fn base(nombre: &str) -> (Arc<Db>, std::path::PathBuf) {
    let marca = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let dir = std::env::temp_dir().join("tpv_tests").join(format!("subida-main-{nombre}-{}-{marca}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    (Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap(), dir)
}

async fn sembrar(db: &Db, sql: &str) {
    let w = db.write().await;
    w.raw().execute_batch(sql).await.unwrap();
}

async fn filas(db: &Db, sql: &str) -> Vec<Vec<Value>> {
    let r = db.read().await;
    let mut f = r.conn().query(sql, ()).await.unwrap();
    let mut out = Vec::new();
    while let Some(fila) = f.next().await.unwrap() {
        let mut v = Vec::new();
        let mut i = 0;
        while let Ok(x) = fila.get_value(i) {
            v.push(x);
            i += 1;
        }
        out.push(v);
    }
    out
}

async fn numero(db: &Db, sql: &str) -> i64 {
    match filas(db, sql).await.first().and_then(|f| f.first()).cloned() {
        Some(Value::Integer(n)) => n,
        otro => panic!("{sql}: {otro:?}"),
    }
}

fn peticion(id: &str, origen: &str) -> PeticionDeSubida {
    PeticionDeSubida { id: id.into(), terminada: false, origen: origen.into() }
}

/// Da pasos hasta que la subida se entrega a la nube (`Nada`), subiendo el outbox cuando lo pide.
/// Devuelve los pasos dados.
async fn hasta_el_final(main: &Arc<Db>, nube: &mut NubeDeSubida) -> usize {
    for i in 0..10_000 {
        let subida = SqliteSubidaCompleta::new(main.clone());
        match subida.paso(nube).await.unwrap() {
            PasoHecho::Nada => return i,
            PasoHecho::PorSubir => {
                nube.subir_outbox(main).await;
            }
            PasoHecho::Avanza => {}
            otro => panic!("paso inesperado: {otro:?}"),
        }
    }
    panic!("la subida no acaba");
}

/// Las filas de una tabla en los dos lados, para compararlas.
async fn iguales(main: &Db, nube: &NubeDeSubida, tabla: &str, orden: &str) {
    let sql = format!("SELECT * FROM \"{tabla}\" ORDER BY {orden};");
    assert_eq!(filas(main, &sql).await, nube.filas(&sql, vec![]).await, "{tabla}");
}

/// Dos años de un bar pequeño: zonas, clientes y comandas cerradas, y una abierta.
async fn un_bar(db: &Db) {
    let mut sql = String::from(
        "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1', 'Sala'), ('z2', 'Terraza');
         INSERT INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('cat1', 'Bebidas');
         INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta) VALUES ('p1', 'cat1', 'Caña', 250), ('p2', 'cat1', 'Vino ''de la casa''', 300);",
    );
    for i in 0..300 {
        sql.push_str(&format!("INSERT INTO Clientes (ID_Cliente, Nombre, Total_Gastado) VALUES ('cli-{i:04}', 'Cliente ñ {i}', {});", i * 10));
    }
    for i in 0..700 {
        // Del 2024 al 2026: casi todo fuera de cualquier ventana.
        let dia = 1 + (i % 28);
        let mes = 1 + (i / 28) % 12;
        let anio = 2024 + i / 336;
        sql.push_str(&format!(
            "INSERT INTO Comandas (ID_Comanda, Canal, Estado, Fecha_Hora_Apertura, Fecha_Hora_Cierre, Total_Comanda) \
             VALUES ('com-{i:05}', 'BARRA', 'Pagada', '{anio}-{mes:02}-{dia:02} 12:00:00', '{anio}-{mes:02}-{dia:02} 13:00:00', {});",
            i * 100
        ));
    }
    sql.push_str("INSERT INTO Comandas (ID_Comanda, Canal, Estado, Fecha_Hora_Apertura) VALUES ('com-viva', 'BARRA', 'Abierta', '2026-11-20 10:00:00');");
    sembrar(db, &sql).await;
}

async fn empezar(main: &Arc<Db>, id: &str, origen: &str) {
    let r = SqliteSubidaCompleta::new(main.clone()).conciliar(Some(&peticion(id, origen))).await.unwrap();
    assert_eq!(r, Conciliacion::Empezar);
}

#[tokio::test]
async fn sube_las_filas_antiguas_fuera_de_la_ventana_del_contraste() {
    let (main, _dir) = base("antiguas").await;
    un_bar(&main).await;
    let mut nube = NubeDeSubida::nueva("antiguas").await;
    empezar(&main, "s1", "base_vacia").await;
    hasta_el_final(&main, &mut nube).await;

    iguales(&main, &nube, "Zonas", "ID_Zona").await;
    iguales(&main, &nube, "Productos", "ID_Producto").await;
    iguales(&main, &nube, "Clientes", "ID_Cliente").await;
    iguales(&main, &nube, "Comandas", "ID_Comanda").await;
    assert_eq!(numero(&nube.db, "SELECT COUNT(*) FROM Comandas;").await, 701);
    // Entregada a la nube, queda por confirmar con el contraste.
    assert_eq!(filas(&main, "SELECT Estado FROM _Sync_Subida;").await, vec![vec![Value::Text("contrastando".into())]]);
    assert_eq!(nube.pasos.last().unwrap()["accion"], "fin");
    // El núcleo (las zonas) va antes que el resto (los clientes).
    let pos_zonas = nube.pasos.iter().position(|p| p["tabla"] == "Zonas").unwrap();
    let pos_clientes = nube.pasos.iter().position(|p| p["tabla"] == "Clientes").unwrap();
    assert!(pos_zonas < pos_clientes, "el núcleo antes que el resto");
    nube.cerrar().await;
}

#[tokio::test]
async fn es_idempotente_y_con_tramos_solo_viaja_lo_distinto() {
    let (main, _dir) = base("tramos").await;
    un_bar(&main).await;
    let mut nube = NubeDeSubida::nueva("tramos").await;
    empezar(&main, "s1", "base_vacia").await;
    hasta_el_final(&main, &mut nube).await;

    // Una copia de la nube de ayer: tres comandas cambiadas y una nueva aquí.
    sembrar(
        &main,
        "UPDATE Comandas SET Total_Comanda = Total_Comanda + 1 WHERE ID_Comanda IN ('com-00010', 'com-00300', 'com-00650');
         INSERT INTO Comandas (ID_Comanda, Canal, Estado, Fecha_Hora_Apertura, Fecha_Hora_Cierre) VALUES ('com-nueva', 'BARRA', 'Pagada', '2025-03-03 10:00:00', '2025-03-03 11:00:00');",
    )
    .await;
    let mut otra = NubeDeSubida::nueva("tramos-2").await;
    // La nube de la copia: lo de antes del cambio.
    let volcado = filas(&nube.db, "SELECT ID_Comanda, Canal, Estado, Fecha_Hora_Apertura, Fecha_Hora_Cierre, Total_Comanda FROM Comandas;").await;
    let mut sql = String::from("INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1', 'Sala'), ('z2', 'Terraza');");
    for f in &volcado {
        let t = |v: &Value| match v {
            Value::Text(s) => format!("'{s}'"),
            Value::Integer(n) => n.to_string(),
            _ => "NULL".into(),
        };
        sql.push_str(&format!(
            "INSERT INTO Comandas (ID_Comanda, Canal, Estado, Fecha_Hora_Apertura, Fecha_Hora_Cierre, Total_Comanda) VALUES ({}, {}, {}, {}, {}, {});",
            t(&f[0]), t(&f[1]), t(&f[2]), t(&f[3]), t(&f[4]), t(&f[5])
        ));
    }
    otra.sembrar(&sql).await;
    nube.cerrar().await;

    empezar(&main, "s2", "copia").await;
    hasta_el_final(&main, &mut otra).await;
    iguales(&main, &otra, "Comandas", "ID_Comanda").await;
    let comandas_mandadas: usize = otra
        .pasos
        .iter()
        .filter(|p| p["accion"] == "filas" && p["tabla"] == "Comandas")
        .map(|p| p["filas"].as_array().unwrap().len())
        .sum();
    // Las tres cambiadas y la nueva, y nada más (lo vivo de la fase 0 es igual: no viaja).
    assert_eq!(comandas_mandadas, 4, "sólo lo distinto");

    // Otra vez, con todo igual: no viaja ninguna fila.
    let antes = otra.filas_mandadas();
    empezar(&main, "s3", "copia").await;
    hasta_el_final(&main, &mut otra).await;
    assert_eq!(otra.filas_mandadas(), antes, "la segunda vez no sube nada");
    otra.cerrar().await;
}

#[tokio::test]
async fn se_reanuda_tras_un_corte() {
    let (main, _dir) = base("corte").await;
    un_bar(&main).await;
    let mut nube = NubeDeSubida::nueva("corte").await;
    nube.cortar_tras = Some(4);
    empezar(&main, "s1", "base_vacia").await;
    let mut corte = false;
    for _ in 0..10_000 {
        match SqliteSubidaCompleta::new(main.clone()).paso(&mut nube).await.unwrap() {
            PasoHecho::SinAcuse => {
                corte = true;
                break;
            }
            PasoHecho::PorSubir => {
                nube.subir_outbox(&main).await;
            }
            _ => {}
        }
    }
    assert!(corte, "el acuse se perdió después de aplicarse");
    // Otra sesión: la nube sigue pidiendo la misma, y se sigue por los cursores.
    assert_eq!(SqliteSubidaCompleta::new(main.clone()).conciliar(Some(&peticion("s1", "base_vacia"))).await.unwrap(), Conciliacion::Seguir);
    hasta_el_final(&main, &mut nube).await;
    iguales(&main, &nube, "Clientes", "ID_Cliente").await;
    iguales(&main, &nube, "Comandas", "ID_Comanda").await;
    nube.cerrar().await;
}

#[tokio::test]
async fn un_vivo_que_la_main_borro_se_borra_por_el_outbox_y_un_maestro_que_sobra_tambien() {
    let (main, _dir) = base("vivos").await;
    un_bar(&main).await;
    let mut nube = NubeDeSubida::nueva("vivos").await;
    // La copia tiene una comanda abierta que aquí ya no existe, y un cliente que aquí se borró.
    nube.sembrar(
        "INSERT INTO Comandas (ID_Comanda, Canal, Estado, Fecha_Hora_Apertura) VALUES ('com-borrada', 'BARRA', 'Abierta', '2026-11-19 10:00:00');
         INSERT INTO Clientes (ID_Cliente, Nombre) VALUES ('cli-borrado', 'Ya no está');",
    )
    .await;
    empezar(&main, "s1", "copia").await;
    hasta_el_final(&main, &mut nube).await;
    assert_eq!(numero(&nube.db, "SELECT COUNT(*) FROM Comandas WHERE ID_Comanda = 'com-borrada';").await, 0);
    assert_eq!(numero(&nube.db, "SELECT COUNT(*) FROM Clientes WHERE ID_Cliente = 'cli-borrado';").await, 0);
    iguales(&main, &nube, "Clientes", "ID_Cliente").await;
    iguales(&main, &nube, "Comandas", "ID_Comanda").await;
    nube.cerrar().await;
}

#[tokio::test]
async fn un_cambio_de_la_handy_a_mitad_aplaza_la_pagina() {
    let (main, _dir) = base("aplazada").await;
    un_bar(&main).await;
    let mut nube = NubeDeSubida::nueva("aplazada").await;
    empezar(&main, "s1", "base_vacia").await;
    nube.ajeno = true;
    let mut visto = false;
    for _ in 0..200 {
        match SqliteSubidaCompleta::new(main.clone()).paso(&mut nube).await.unwrap() {
            PasoHecho::Aplazada => {
                visto = true;
                break;
            }
            PasoHecho::PorSubir => {
                nube.subir_outbox(&main).await;
            }
            _ => {}
        }
    }
    assert!(visto);
    // No ha movido ningún cursor de filas: lo aplazado se vuelve a leer.
    assert_eq!(numero(&main, "SELECT COALESCE(SUM(Filas_Leidas), 0) FROM _Sync_Subida_Tablas WHERE Fase IN (1, 3);").await, 0);
    nube.ajeno = false;
    hasta_el_final(&main, &mut nube).await;
    iguales(&main, &nube, "Clientes", "ID_Cliente").await;
    nube.cerrar().await;
}

#[tokio::test]
async fn las_filas_de_una_cuarentena_no_se_suben_nunca() {
    let (main, _dir) = base("cuarentena").await;
    un_bar(&main).await;
    let filas_json = json!({"tablas": ["Clientes"], "incierto": false, "por_filtro": [], "dudosa": false,
        "filas": [{"tabla": "Clientes", "clave": ["cli-0007"], "borrada": false}]});
    sembrar(
        &main,
        &format!(
            "INSERT INTO _Sync_Failed (Op_Id, Seq, Statements_Json, Attempts, Quarantined, First_Failed_At_Ms, Last_Failed_At_Ms, Filas_Json) \
             VALUES ('op-x', 5, '[]', 5, 1, 1, 1, '{filas_json}');"
        ),
    )
    .await;
    let mut nube = NubeDeSubida::nueva("cuarentena").await;
    empezar(&main, "s1", "base_vacia").await;
    hasta_el_final(&main, &mut nube).await;
    assert_eq!(numero(&nube.db, "SELECT COUNT(*) FROM Clientes WHERE ID_Cliente = 'cli-0007';").await, 0);
    assert_eq!(numero(&nube.db, "SELECT COUNT(*) FROM Clientes;").await, 299);
    nube.cerrar().await;
}

#[tokio::test]
async fn una_columna_que_la_nube_no_tiene_se_omite() {
    let (main, _dir) = base("columna").await;
    un_bar(&main).await;
    let mut nube = NubeDeSubida::nueva("columna").await;
    nube.sin_columnas.insert("Clientes".into(), vec!["Notas".into()]);
    empezar(&main, "s1", "base_vacia").await;
    hasta_el_final(&main, &mut nube).await;
    let columnas: Vec<_> = nube.pasos.iter().filter(|p| p["accion"] == "filas" && p["tabla"] == "Clientes").map(|p| p["columnas"].clone()).collect();
    assert!(!columnas.is_empty());
    assert!(columnas.iter().all(|c| !c.as_array().unwrap().iter().any(|x| x == "Notas")));
    nube.cerrar().await;
}

#[tokio::test]
async fn conciliar_empieza_de_cero_con_otra_peticion_y_abandona_sin_ninguna() {
    let (main, _dir) = base("conciliar").await;
    un_bar(&main).await;
    let mut nube = NubeDeSubida::nueva("conciliar").await;
    empezar(&main, "s1", "base_vacia").await;
    for _ in 0..5 {
        SqliteSubidaCompleta::new(main.clone()).paso(&mut nube).await.unwrap();
    }
    assert!(numero(&main, "SELECT COUNT(*) FROM _Sync_Subida_Tablas;").await > 0);
    let s = SqliteSubidaCompleta::new(main.clone());
    assert!(!s.nucleo_hecho().await.unwrap() || numero(&main, "SELECT COUNT(*) FROM _Sync_Subida_Tablas WHERE Turno <= 1 AND Estado = 0;").await == 0);
    assert!(estado_para_la_pantalla(&main).await.unwrap().is_some());

    // Otra petición (otra vuelta de la nube): de cero, sin el plan de la anterior.
    assert_eq!(s.conciliar(Some(&peticion("s2", "instante"))).await.unwrap(), Conciliacion::Empezar);
    assert_eq!(numero(&main, "SELECT COUNT(*) FROM _Sync_Subida_Tablas;").await, 0);
    // La nube ya no la pide (modo nube, caducada, un worker anterior): se deja.
    assert_eq!(s.conciliar(None).await.unwrap(), Conciliacion::Abandonada);
    assert!(!s.pendiente().await.unwrap());
    assert!(s.nucleo_hecho().await.unwrap(), "sin subida en curso no retiene a nadie");
    assert!(estado_para_la_pantalla(&main).await.unwrap().is_none());
    // La nube la da por terminada y aquí estaba subiendo: a contrastar.
    s.conciliar(Some(&peticion("s3", "copia"))).await.unwrap();
    assert_eq!(
        s.conciliar(Some(&PeticionDeSubida { id: "s3".into(), terminada: true, origen: "copia".into() })).await.unwrap(),
        Conciliacion::Contrastar
    );
    nube.cerrar().await;
}
