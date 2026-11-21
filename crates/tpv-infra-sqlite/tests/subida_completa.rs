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
    sembrar(&main, "INSERT INTO Tareas (ID_Tarea, Titulo, Fecha_Creacion) VALUES ('t1', 'Limpiar la cafetera', '2026-11-01 09:00:00');").await;
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
    // El núcleo (las zonas, y los clientes porque una comanda abierta puede apuntar a uno) va antes
    // que el resto (las tareas).
    let pos_zonas = nube.pasos.iter().position(|p| p["tabla"] == "Zonas").unwrap();
    let pos_clientes = nube.pasos.iter().position(|p| p["tabla"] == "Clientes").unwrap();
    let pos_tareas = nube.pasos.iter().position(|p| p["tabla"] == "Tareas").unwrap();
    assert!(pos_zonas < pos_tareas && pos_clientes < pos_tareas, "el núcleo antes que el resto");
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

/// Da pasos hasta que la subida se entrega a la nube y sube a la nube lo que quede en el outbox.
async fn hasta_el_final_y_el_outbox(main: &Arc<Db>, nube: &mut NubeDeSubida) {
    hasta_el_final(main, nube).await;
    nube.subir_outbox(main).await;
}

/// Da pasos hasta que el núcleo está arriba (lo que suelta a las Handy).
async fn hasta_el_nucleo(main: &Arc<Db>, nube: &mut NubeDeSubida) {
    for _ in 0..10_000 {
        let subida = SqliteSubidaCompleta::new(main.clone());
        if subida.nucleo_hecho().await.unwrap() {
            return;
        }
        match subida.paso(nube).await.unwrap() {
            PasoHecho::PorSubir => {
                nube.subir_outbox(main).await;
            }
            PasoHecho::Avanza => {}
            otro => panic!("paso inesperado: {otro:?}"),
        }
    }
    panic!("el núcleo no acaba");
}

/// DO-SUBIDA (repaso) · Lo que la nube no dejó entrar y aquí ya no existe sale del repaso sin
/// mandar nada: una lista vacía era un rechazo permanente, el repaso se repetía sin fin y la subida
/// no llegaba nunca a `fin` (ni el contraste volvía a correr).
#[tokio::test]
async fn el_repaso_suelta_lo_que_aqui_ya_no_existe_y_la_subida_acaba() {
    let (main, _dir) = base("repaso-fantasma").await;
    un_bar(&main).await;
    let mut nube = NubeDeSubida::nueva("repaso-fantasma").await;
    empezar(&main, "s1", "base_vacia").await;
    // El plan.
    assert!(matches!(SqliteSubidaCompleta::new(main.clone()).paso(&mut nube).await.unwrap(), PasoHecho::Avanza));
    // Algo que la nube no dejó entrar y que aquí se borró después.
    sembrar(
        &main,
        "INSERT INTO _Sync_Subida_Por_Revisar (Tabla, Clave_Json, Motivo, Intentos, Turno) VALUES ('Clientes', '[\"cli-borrado\"]', 'foranea', 0, 0);",
    )
    .await;
    hasta_el_final(&main, &mut nube).await;
    assert!(nube.rechazos.is_empty(), "la nube no rechaza nada: {:?}", nube.rechazos);
    assert_eq!(numero(&main, "SELECT COUNT(*) FROM _Sync_Subida_Por_Revisar;").await, 0);
    assert_eq!(nube.pasos.last().unwrap()["accion"], "fin");
    nube.cerrar().await;
}

/// SYNC-36 · Un maestro que aquí falta por una cuarentena de bajada (el alta de una Handy que aquí
/// no ha entrado) no se borra arriba como sobrante: se perdería en los dos lados.
#[tokio::test]
async fn un_maestro_de_una_cuarentena_no_se_borra_arriba_como_sobrante() {
    let (main, _dir) = base("sobrante-cuarentena").await;
    un_bar(&main).await;
    let filas_json = json!({"tablas": ["Clientes"], "incierto": false, "por_filtro": [], "dudosa": false,
        "filas": [{"tabla": "Clientes", "clave": ["cli-handy"], "borrada": false}]});
    sembrar(
        &main,
        &format!(
            "INSERT INTO _Sync_Failed (Op_Id, Seq, Statements_Json, Attempts, Quarantined, First_Failed_At_Ms, Last_Failed_At_Ms, Filas_Json) \
             VALUES ('op-handy', 5, '[]', 5, 1, 1, 1, '{filas_json}');"
        ),
    )
    .await;
    let mut nube = NubeDeSubida::nueva("sobrante-cuarentena").await;
    nube.sembrar("INSERT INTO Clientes (ID_Cliente, Nombre) VALUES ('cli-handy', 'Alta de la Handy'), ('cli-sobra', 'Borrado aqui');").await;
    empezar(&main, "s1", "copia").await;
    hasta_el_final_y_el_outbox(&main, &mut nube).await;
    assert_eq!(numero(&nube.db, "SELECT COUNT(*) FROM Clientes WHERE ID_Cliente = 'cli-handy';").await, 1, "lo de la cuarentena sigue arriba");
    assert_eq!(numero(&nube.db, "SELECT COUNT(*) FROM Clientes WHERE ID_Cliente = 'cli-sobra';").await, 0, "lo demás que sobra, no");
    nube.cerrar().await;
}

/// Una comanda abierta de la copia que aquí ya no existe, con su línea arriba. `escribe`: quién ha
/// escrito en la nube después del plan. Devuelve cuántas quedan arriba (comanda, línea).
async fn vivo_borrado_con_algo_encima(nombre: &str, escribe: &str) -> (i64, i64) {
    let (main, _dir) = base(nombre).await;
    un_bar(&main).await;
    let mut nube = NubeDeSubida::nueva(nombre).await;
    nube.sembrar(
        "INSERT INTO Comandas (ID_Comanda, Canal, Estado, Fecha_Hora_Apertura) VALUES ('com-borrada', 'BARRA', 'Abierta', '2026-11-19 10:00:00');
         INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, Nombre_Producto, Cantidad, Precio_Unitario) VALUES ('det-borrada', 'com-borrada', 'Cana', 1, 250);",
    )
    .await;
    let seq = nube.hasta_seq + 1;
    nube.sembrar(&format!(
        "INSERT INTO Sync_Changes (Seq, Op_Id, Command_Name, Statements_Json, Device_Id, Created_At_Ms) VALUES ({seq}, 'otro-cambio', 'cobrar', '[]', '{escribe}', 2);"
    ))
    .await;
    empezar(&main, "s1", "copia").await;
    hasta_el_final_y_el_outbox(&main, &mut nube).await;
    let r = (
        numero(&nube.db, "SELECT COUNT(*) FROM Comandas WHERE ID_Comanda = 'com-borrada';").await,
        numero(&nube.db, "SELECT COUNT(*) FROM Detalle_Comanda WHERE ID_Detalle = 'det-borrada';").await,
    );
    nube.cerrar().await;
    r
}

/// Lo vivo de la copia que aquí ya no existe se borra arriba con sus líneas, hijas primero (la
/// foránea de una línea no lleva cascada), aunque esta Main haya subido algo suyo desde el plan.
#[tokio::test]
async fn un_vivo_borrado_aqui_se_borra_con_sus_lineas_aunque_la_main_haya_subido_algo() {
    assert_eq!(vivo_borrado_con_algo_encima("vivo-main", comun::nube_de_subida::DISPOSITIVO).await, (0, 0));
}

/// Lo que ha escrito una Handy en la nube después del plan sí frena el borrado: no se toca nada.
#[tokio::test]
async fn un_vivo_borrado_aqui_no_se_borra_si_una_handy_ha_escrito_despues() {
    assert_eq!(vivo_borrado_con_algo_encima("vivo-handy", "handy-1").await, (1, 1));
}

/// Con una base vacía, el núcleo lleva lo que apuntan sus foráneas (el proveedor de un producto, el
/// cliente de una comanda abierta) y, antes de soltar a las Handy, otro intento de lo que no entró
/// a la primera (una devolución que va antes que su cobro de origen por su clave).
#[tokio::test]
async fn con_el_nucleo_arriba_estan_sus_padres_y_lo_que_no_entro_a_la_primera() {
    let (main, _dir) = base("nucleo-padres").await;
    un_bar(&main).await;
    sembrar(
        &main,
        "INSERT INTO Proveedores (ID_Proveedor, Nombre_Empresa) VALUES ('prov1', 'Bebidas SL');
         INSERT INTO Productos (ID_Producto, ID_Categoria, ID_Proveedor, Nombre, Precio_Venta) VALUES ('p-prov', 'cat1', 'prov1', 'Tonica', 200);
         INSERT INTO Comandas (ID_Comanda, ID_Cliente, Canal, Estado, Fecha_Hora_Apertura) VALUES ('viva-cli', 'cli-0001', 'BARRA', 'Abierta', '2026-11-20 11:00:00');
         INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo) VALUES ('pag-z', 'viva-cli', '2026-11-20 11:05:00', 'Efectivo', 500, 'PARCIAL');
         INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo, ID_Pago_Origen, Motivo_Devolucion) VALUES ('pag-a', 'viva-cli', '2026-11-20 11:06:00', 'Efectivo', -100, 'DEVOLUCION', 'pag-z', 'Error');",
    )
    .await;
    let mut nube = NubeDeSubida::nueva("nucleo-padres").await;
    empezar(&main, "s1", "base_vacia").await;
    hasta_el_nucleo(&main, &mut nube).await;
    assert_eq!(numero(&nube.db, "SELECT COUNT(*) FROM Productos WHERE ID_Producto = 'p-prov';").await, 1, "el producto con proveedor");
    assert_eq!(numero(&nube.db, "SELECT COUNT(*) FROM Comandas WHERE ID_Comanda = 'viva-cli';").await, 1, "la comanda abierta con cliente");
    assert_eq!(numero(&nube.db, "SELECT COUNT(*) FROM Pagos WHERE ID_Pago = 'pag-a';").await, 1, "la devolución que va antes que su cobro");
    // Y el histórico todavía no.
    assert!(numero(&nube.db, "SELECT COUNT(*) FROM Comandas;").await < 701);
    nube.cerrar().await;
}

/// La nube admite páginas de hasta 1,5 MiB: unas filas gruesas se mandan en trozos que caben, sin
/// que la nube tenga que rechazar ninguna (ni reducir la página del resto de la subida).
#[tokio::test]
async fn unas_filas_gruesas_viajan_en_trozos_que_caben() {
    let (main, _dir) = base("gruesas").await;
    let nota = "x".repeat(4_000);
    let mut sql = String::new();
    for i in 0..1_200 {
        sql.push_str(&format!(
            "INSERT INTO Comandas (ID_Comanda, Canal, Estado, Fecha_Hora_Apertura) VALUES ('g-{i:05}', 'BARRA', 'Abierta', '2026-11-20 10:00:00');
             INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, Nombre_Producto, Cantidad, Precio_Unitario, Notas) VALUES ('d-{i:05}', 'g-{i:05}', 'Cana', 1, 250, '{nota}');"
        ));
    }
    sembrar(&main, &sql).await;
    let mut nube = NubeDeSubida::nueva("gruesas").await;
    empezar(&main, "s1", "base_vacia").await;
    hasta_el_final(&main, &mut nube).await;
    assert!(nube.rechazos.is_empty(), "{:?}", nube.rechazos);
    assert_eq!(numero(&nube.db, "SELECT COUNT(*) FROM Detalle_Comanda;").await, 1_200);
    nube.cerrar().await;
}

/// Serie_Facturacion es un contador: el de la nube (una copia de antes) sube hasta el de aquí y
/// nunca baja, y no se pide borrar arriba una serie que aquí no está.
#[tokio::test]
async fn el_contador_de_la_serie_sube_y_no_baja() {
    let (main, _dir) = base("serie").await;
    un_bar(&main).await;
    sembrar(&main, "INSERT INTO Serie_Facturacion (Serie, Ultimo) VALUES ('A', 10), ('B', 2);").await;
    let mut nube = NubeDeSubida::nueva("serie").await;
    nube.sembrar("INSERT INTO Serie_Facturacion (Serie, Ultimo) VALUES ('A', 7), ('B', 5), ('C', 1);").await;
    empezar(&main, "s1", "copia").await;
    hasta_el_final_y_el_outbox(&main, &mut nube).await;
    assert_eq!(
        nube.filas("SELECT Serie, Ultimo FROM Serie_Facturacion ORDER BY Serie;", vec![]).await,
        vec![
            vec![Value::Text("A".into()), Value::Integer(10)],
            vec![Value::Text("B".into()), Value::Integer(5)],
            vec![Value::Text("C".into()), Value::Integer(1)],
        ]
    );
    assert_eq!(numero(&main, "SELECT COUNT(*) FROM _Sync_Subida_Por_Revisar WHERE Tabla = 'Serie_Facturacion';").await, 0);
    nube.cerrar().await;
}

/// Lo que enseña la pantalla: «se reintenta» mientras se reintenta, y se apaga en cuanto un paso
/// entra; una tabla que la nube no admite se cuenta aparte. Ningún código llega a la pantalla.
#[tokio::test]
async fn la_pantalla_dice_si_se_reintenta_o_si_una_tabla_queda_para_el_contraste() {
    let (main, _dir) = base("pantalla").await;
    un_bar(&main).await;
    let mut nube = NubeDeSubida::nueva("pantalla").await;
    empezar(&main, "s1", "base_vacia").await;
    let subida = SqliteSubidaCompleta::new(main.clone());
    subida.paso(&mut nube).await.unwrap();
    // Un rechazo sin clasificar: se reintenta.
    nube.rechazar_la_proxima = Some(json!({"ok": false, "error": "algo_raro"}));
    let mut vista = None;
    for _ in 0..200 {
        if let PasoHecho::Esperar(_) = subida.paso(&mut nube).await.unwrap() {
            vista = estado_para_la_pantalla(&main).await.unwrap();
            break;
        }
    }
    let vista = vista.expect("el rechazo se ha visto");
    assert!(vista.reintentando);
    assert_eq!(vista.tablas_fallidas, 0);
    // Un paso que entra lo apaga.
    for _ in 0..200 {
        if nube.paginas_aplicadas > 0 {
            break;
        }
        subida.paso(&mut nube).await.unwrap();
    }
    assert!(!estado_para_la_pantalla(&main).await.unwrap().unwrap().reintentando);
    // Un rechazo permanente: la tabla queda para el contraste, sin «se reintenta».
    nube.rechazar_la_proxima = Some(json!({"ok": false, "error": "subida_tabla_no_admitida", "permanente": true}));
    for _ in 0..200 {
        if nube.rechazar_la_proxima.is_none() {
            break;
        }
        subida.paso(&mut nube).await.unwrap();
    }
    let vista = estado_para_la_pantalla(&main).await.unwrap().unwrap();
    assert_eq!(vista.tablas_fallidas, 1);
    assert!(!vista.reintentando);
    nube.cerrar().await;
}

/// La administración reabre la misma petición (`--reabrir`, tras agotar su techo): se sigue por los
/// cursores, sin volver a recorrer lo que ya subió.
#[tokio::test]
async fn la_misma_peticion_reabierta_sigue_por_donde_iba() {
    let (main, _dir) = base("reabierta").await;
    un_bar(&main).await;
    let mut nube = NubeDeSubida::nueva("reabierta").await;
    empezar(&main, "s1", "base_vacia").await;
    for _ in 0..20 {
        SqliteSubidaCompleta::new(main.clone()).paso(&mut nube).await.unwrap();
    }
    let leidas = numero(&main, "SELECT SUM(Filas_Leidas) FROM _Sync_Subida_Tablas;").await;
    assert!(leidas > 0);
    let s = SqliteSubidaCompleta::new(main.clone());
    s.abandonar("subida_presupuesto_superado").await.unwrap();
    assert_eq!(s.conciliar(Some(&peticion("s1", "base_vacia"))).await.unwrap(), Conciliacion::Seguir);
    assert_eq!(numero(&main, "SELECT SUM(Filas_Leidas) FROM _Sync_Subida_Tablas;").await, leidas);
    assert!(s.pendiente().await.unwrap());
    hasta_el_final(&main, &mut nube).await;
    iguales(&main, &nube, "Comandas", "ID_Comanda").await;
    nube.cerrar().await;
}

/// Una cuarentena de bajada en `_Sync_Failed`, con lo que se sabe de sus filas (`None`: nada), del
/// cambio 5 de la nube: del log de antes de la vuelta.
async fn cuarentena(main: &Db, op: &str, filas_json: Option<serde_json::Value>, sentencias: serde_json::Value) {
    cuarentena_en(main, op, 5, filas_json, sentencias).await;
}

/// Una cuarentena de bajada del cambio `seq` de la nube.
async fn cuarentena_en(main: &Db, op: &str, seq: i64, filas_json: Option<serde_json::Value>, sentencias: serde_json::Value) {
    let w = main.write().await;
    w.raw()
        .execute(
            "INSERT INTO _Sync_Failed (Op_Id, Seq, Statements_Json, Attempts, Quarantined, First_Failed_At_Ms, Last_Failed_At_Ms, Filas_Json) \
             VALUES (?1, ?4, ?2, 5, 1, 1, 1, ?3);",
            vec![
                Value::Text(op.into()),
                Value::Text(sentencias.to_string()),
                filas_json.map_or(Value::Null, |f| Value::Text(f.to_string())),
                Value::Integer(seq),
            ],
        )
        .await
        .unwrap();
}

/// El plan, y unos clientes que la nube no dejó entrar por una foránea: el repaso los vuelve a
/// intentar al cambiar de etapa.
async fn plan_y_por_revisar(main: &Arc<Db>, nube: &mut NubeDeSubida, clientes: &[&str]) {
    assert!(matches!(SqliteSubidaCompleta::new(main.clone()).paso(nube).await.unwrap(), PasoHecho::Avanza));
    for c in clientes {
        sembrar(
            main,
            &format!("INSERT INTO _Sync_Subida_Por_Revisar (Tabla, Clave_Json, Motivo, Intentos, Turno) VALUES ('Clientes', '[\"{c}\"]', 'foranea', 0, 0);"),
        )
        .await;
    }
}

async fn nombre_arriba(nube: &NubeDeSubida, cliente: &str) -> Option<Value> {
    nube.filas("SELECT Nombre FROM Clientes WHERE ID_Cliente = ?1;", vec![Value::Text(cliente.into())]).await.into_iter().next().map(|f| f[0].clone())
}

/// DO-SUBIDA (repaso) · SYNC-36 · El repaso tampoco sube lo que toca una cuarentena de bajada: la
/// versión de la nube es la buena (lo que escribió una Handy y aquí no ha entrado), y subir la de aquí
/// la deshacía.
#[tokio::test]
async fn el_repaso_no_sube_lo_que_toca_una_cuarentena() {
    let (main, _dir) = base("repaso-cuarentena").await;
    un_bar(&main).await;
    let filas_json = json!({"tablas": ["Clientes"], "incierto": false, "por_filtro": [], "dudosa": false,
        "filas": [{"tabla": "Clientes", "clave": ["cli-0007"], "borrada": false}]});
    cuarentena(&main, "op-handy", Some(filas_json), json!([])).await;
    let mut nube = NubeDeSubida::nueva("repaso-cuarentena").await;
    nube.sembrar("INSERT INTO Clientes (ID_Cliente, Nombre) VALUES ('cli-0007', 'De la Handy');").await;
    empezar(&main, "s1", "copia").await;
    plan_y_por_revisar(&main, &mut nube, &["cli-0007"]).await;
    hasta_el_final_y_el_outbox(&main, &mut nube).await;
    assert_eq!(nombre_arriba(&nube, "cli-0007").await, Some(Value::Text("De la Handy".into())), "la versión de la nube se queda");
    assert_eq!(numero(&main, "SELECT COUNT(*) FROM _Sync_Subida_Por_Revisar;").await, 0, "se deja para el contraste");
    nube.cerrar().await;
}

/// DO-SUBIDA (repaso) · SYNC-29 · Una fila apuntada por el orden de la nube sólo se sube en el repaso
/// si arriba falta: la que está arriba es la buena y la trae la convergencia.
#[tokio::test]
async fn el_repaso_sube_una_fila_apuntada_solo_si_arriba_falta() {
    let (main, _dir) = base("repaso-apuntadas").await;
    un_bar(&main).await;
    sembrar(
        &main,
        "INSERT INTO _Sync_Por_Contrastar (Tabla, Clave_Json, Seq, Desde_Ms) VALUES ('Clientes', '[\"cli-0008\"]', 5, 1), ('Clientes', '[\"cli-0009\"]', 5, 1);",
    )
    .await;
    let mut nube = NubeDeSubida::nueva("repaso-apuntadas").await;
    nube.sembrar("INSERT INTO Clientes (ID_Cliente, Nombre) VALUES ('cli-0008', 'De la nube');").await;
    empezar(&main, "s1", "copia").await;
    plan_y_por_revisar(&main, &mut nube, &["cli-0008", "cli-0009"]).await;
    hasta_el_final_y_el_outbox(&main, &mut nube).await;
    assert_eq!(nombre_arriba(&nube, "cli-0008").await, Some(Value::Text("De la nube".into())), "la que está arriba no se pisa");
    assert_eq!(nombre_arriba(&nube, "cli-0009").await, Some(Value::Text("Cliente ñ 9".into())), "la que falta sí sube");
    nube.cerrar().await;
}

/// La nube rechaza siempre `cli-0005` cuando va sola (lo que manda el repaso) con `acuse`. Devuelve
/// la base de la Main con la subida entregada.
async fn repaso_siempre_rechazado(nombre: &str, acuse: serde_json::Value) -> Arc<Db> {
    let (main, _dir) = base(nombre).await;
    un_bar(&main).await;
    let mut nube = NubeDeSubida::nueva(nombre).await;
    nube.rechazar_si = Some(Box::new(move |p| {
        let filas = p["filas"].as_array()?;
        let sola = p["tabla"] == "Clientes" && filas.len() == 1 && filas[0].as_array().is_some_and(|f| f.contains(&json!("cli-0005")));
        sola.then(|| acuse.clone())
    }));
    empezar(&main, "s1", "base_vacia").await;
    plan_y_por_revisar(&main, &mut nube, &["cli-0005"]).await;
    hasta_el_final(&main, &mut nube).await;
    assert_eq!(nube.pasos.last().unwrap()["accion"], "fin", "la subida acaba");
    assert!(!nube.rechazos.is_empty(), "el repaso se ha rechazado");
    nube.cerrar().await;
    main
}

/// DO-SUBIDA (repaso) · Un rechazo sin clasificar en el repaso cuenta como un intento de lo mandado:
/// se repetía cada 30 s sin gastar ninguno y la subida no llegaba nunca a `fin`. Y no marca como
/// fallida la tabla, que ya había subido.
#[tokio::test]
async fn un_rechazo_sin_clasificar_en_el_repaso_gasta_sus_intentos_y_la_subida_acaba() {
    let main = repaso_siempre_rechazado("repaso-sin-clasificar", json!({"ok": false, "error": "algo_raro"})).await;
    assert_eq!(numero(&main, "SELECT Intentos FROM _Sync_Subida_Por_Revisar WHERE Clave_Json = '[\"cli-0005\"]';").await, 3);
    assert_eq!(numero(&main, "SELECT COUNT(*) FROM _Sync_Subida_Tablas WHERE Estado = 2;").await, 0, "ninguna tabla fallida");
    assert_eq!(estado_para_la_pantalla(&main).await.unwrap().unwrap().tablas_fallidas, 0);
}

/// DO-SUBIDA (repaso) · Un rechazo permanente en el repaso tampoco da por fallida una tabla que ya
/// había subido entera: la pantalla contaba una tabla para el contraste que no lo estaba.
#[tokio::test]
async fn un_rechazo_permanente_en_el_repaso_no_marca_fallida_la_tabla() {
    let main = repaso_siempre_rechazado("repaso-permanente", json!({"ok": false, "error": "subida_tabla_no_admitida", "permanente": true})).await;
    assert_eq!(numero(&main, "SELECT COUNT(*) FROM _Sync_Subida_Tablas WHERE Estado = 2;").await, 0, "ninguna tabla fallida");
    assert_eq!(estado_para_la_pantalla(&main).await.unwrap().unwrap().tablas_fallidas, 0);
}

/// Las claves de las filas de `tabla` que han viajado en páginas de filas, con su primera columna.
fn mandadas_de(nube: &NubeDeSubida, tabla: &str) -> Vec<serde_json::Value> {
    nube.pasos
        .iter()
        .filter(|p| p["accion"] == "filas" && p["tabla"] == tabla)
        .flat_map(|p| p["filas"].as_array().cloned().unwrap_or_default())
        .map(|f| f[0].clone())
        .collect()
}

/// Una cuarentena de la Handy que no dice qué filas toca y que escribe en `Clientes`.
fn sentencias_en_clientes() -> serde_json::Value {
    json!([{"sql": "UPDATE Clientes SET Nombre = ?1 WHERE ID_Cliente = ?2;", "args": ["De la Handy", "cli-0007"]}])
}

/// Un borrado de la Handy en `Clientes` del que no se saben las filas.
fn borrado_en_clientes() -> serde_json::Value {
    json!([{"sql": "DELETE FROM Clientes WHERE ID_Cliente IN (SELECT ID_Cliente FROM Clientes WHERE Nombre = ?1);", "args": ["Cliente ñ 7"]}])
}

/// DO-SUBIDA · SYNC-36 · Con una base vacía, una cuarentena del log de antes sin `Filas_Json` (no se
/// sabe qué filas toca) hace inciertas las tablas en las que escriben sus sentencias: de ellas sube
/// sólo lo que falta arriba, sin pisar lo que ya está (lo de la Handy) ni pedir borrar lo que aquí
/// falta, y la tabla no queda fallida.
#[tokio::test]
async fn una_cuarentena_sin_filas_solo_sube_lo_que_falta_en_las_tablas_que_escribe() {
    let (main, _dir) = base("cuarentena-sin-filas").await;
    un_bar(&main).await;
    cuarentena(&main, "op-handy", None, sentencias_en_clientes()).await;
    let mut nube = NubeDeSubida::nueva("cuarentena-sin-filas").await;
    nube.sembrar("INSERT INTO Clientes (ID_Cliente, Nombre) VALUES ('cli-0007', 'De la Handy'), ('cli-handy', 'Alta de la Handy');").await;
    empezar(&main, "s1", "base_vacia").await;
    hasta_el_final_y_el_outbox(&main, &mut nube).await;
    assert_eq!(nombre_arriba(&nube, "cli-0007").await, Some(Value::Text("De la Handy".into())), "lo que ya está no se pisa");
    assert!(!mandadas_de(&nube, "Clientes").contains(&json!("cli-0007")), "ni viaja");
    assert_eq!(nombre_arriba(&nube, "cli-handy").await, Some(Value::Text("Alta de la Handy".into())), "ni se pide borrar como sobrante");
    assert_eq!(numero(&nube.db, "SELECT COUNT(*) FROM Clientes;").await, 301, "lo que faltaba arriba sube");
    assert_eq!(numero(&main, "SELECT COUNT(*) FROM _Sync_Subida_Tablas WHERE Estado = 2;").await, 0, "ninguna tabla fallida");
    assert!(numero(&nube.db, "SELECT COUNT(*) FROM Zonas;").await > 0, "las demás tablas suben");
    nube.cerrar().await;
}

/// Lo que comprueban las dos de abajo: la fila que borró la cuarentena (`cli-0007`) sigue sin estar
/// arriba, nada de `Clientes` ha viajado, la tabla queda fallida para el contraste y las demás suben.
async fn clientes_fuera_sin_resucitar(main: &Db, nube: &NubeDeSubida) {
    assert_eq!(nombre_arriba(nube, "cli-0007").await, None, "lo que borró la cuarentena no vuelve");
    assert!(mandadas_de(nube, "Clientes").is_empty(), "nada de su tabla viaja");
    assert_eq!(
        filas(main, "SELECT DISTINCT Ultimo_Error FROM _Sync_Subida_Tablas WHERE Tabla = 'Clientes' AND Fase <> 4;").await,
        vec![vec![Value::Text("cuarentena".into())]],
        "la tabla, para el contraste"
    );
    assert_eq!(numero(main, "SELECT COUNT(*) FROM _Sync_Subida_Tablas WHERE Tabla = 'Clientes' AND Fase <> 4 AND Estado <> 2;").await, 0);
    assert!(numero(&nube.db, "SELECT COUNT(*) FROM Zonas;").await > 0, "las demás tablas suben");
}

/// DO-SUBIDA · SYNC-36 · Con una copia (o un instante), la nube devuelta puede tener ya el cambio de
/// una cuarentena que no dice qué filas toca: su tabla entera se deja para el contraste. Subía lo que
/// faltaba arriba, que podía ser justo lo que la Handy había borrado: la fila volvía a la nube y el
/// contraste, con las dos bases iguales, ya no lo veía.
#[tokio::test]
async fn con_una_copia_una_cuarentena_incierta_no_resucita_lo_que_borro() {
    let (main, _dir) = base("cuarentena-copia-borrado").await;
    un_bar(&main).await;
    cuarentena(&main, "op-handy", None, borrado_en_clientes()).await;
    let mut nube = NubeDeSubida::nueva("cuarentena-copia-borrado").await;
    nube.sembrar("INSERT INTO Clientes (ID_Cliente, Nombre) VALUES ('cli-0001', 'Cliente ñ 1'), ('cli-0008', 'Cliente ñ 8');").await;
    empezar(&main, "s1", "copia").await;
    hasta_el_final_y_el_outbox(&main, &mut nube).await;
    clientes_fuera_sin_resucitar(&main, &nube).await;
    nube.cerrar().await;
}

/// DO-SUBIDA · SYNC-36 · Con una base vacía, una cuarentena posterior al plan (del log nuevo) es un cambio escrito en
/// la nube devuelta: su tabla entera se deja para el contraste. Lo que aquí está y arriba falta puede
/// ser lo que borró, y subirlo lo resucitaba.
#[tokio::test]
async fn una_cuarentena_incierta_posterior_al_plan_no_resucita_lo_que_borro() {
    let (main, _dir) = base("cuarentena-tras-el-plan").await;
    un_bar(&main).await;
    let mut nube = NubeDeSubida::nueva("cuarentena-tras-el-plan").await;
    let seq = nube.hasta_seq + 1;
    cuarentena_en(&main, "op-handy", seq, None, borrado_en_clientes()).await;
    nube.sembrar("INSERT INTO Clientes (ID_Cliente, Nombre) VALUES ('cli-0001', 'Cliente ñ 1');").await;
    empezar(&main, "s1", "base_vacia").await;
    hasta_el_final_y_el_outbox(&main, &mut nube).await;
    clientes_fuera_sin_resucitar(&main, &nube).await;
    nube.cerrar().await;
}

/// DO-SUBIDA · SYNC-36 · Con una base vacía, una cuarentena de un cambio que una Handy escribió en la
/// nube devuelta antes del plan (entre la vuelta y el primer saludo de la Main, o con la subida en
/// pausa) es del log nuevo: su tabla entera se deja para el contraste. La frontera era el plan, ese
/// cambio contaba como perdido con la base, y lo que había borrado volvía a subir.
#[tokio::test]
async fn una_cuarentena_incierta_entre_la_vuelta_y_el_plan_no_resucita_lo_que_borro() {
    let (main, _dir) = base("cuarentena-antes-del-plan").await;
    un_bar(&main).await;
    let mut nube = NubeDeSubida::nueva("cuarentena-antes-del-plan").await;
    let inicio = nube.inicio_seq.unwrap();
    // El cambio de la Handy, y otro después: el plan los ve los dos.
    cuarentena_en(&main, "op-handy", inicio + 2, None, borrado_en_clientes()).await;
    nube.hasta_seq = inicio + 5;
    nube.sembrar(&format!(
        "INSERT INTO Sync_Changes (Seq, Op_Id, Command_Name, Statements_Json, Device_Id, Created_At_Ms) VALUES
           ({}, 'op-handy', 'x', '[]', 'handy-1', 2), ({}, 'otro', 'x', '[]', 'handy-1', 3);",
        inicio + 2,
        inicio + 5
    ))
    .await;
    nube.sembrar("INSERT INTO Clientes (ID_Cliente, Nombre) VALUES ('cli-0001', 'Cliente ñ 1');").await;
    empezar(&main, "s1", "base_vacia").await;
    hasta_el_final_y_el_outbox(&main, &mut nube).await;
    clientes_fuera_sin_resucitar(&main, &nube).await;
    nube.cerrar().await;
}

/// DO-SUBIDA · SYNC-36 · Si el plan no dice dónde empieza el log nuevo (un worker anterior), no se
/// sabe si el cambio de una cuarentena incierta se perdió con la base: su tabla se deja para el
/// contraste, como con una copia.
#[tokio::test]
async fn sin_el_inicio_del_log_una_cuarentena_incierta_deja_su_tabla_para_el_contraste() {
    let (main, _dir) = base("cuarentena-worker-viejo").await;
    un_bar(&main).await;
    cuarentena(&main, "op-handy", None, borrado_en_clientes()).await;
    let mut nube = NubeDeSubida::nueva("cuarentena-worker-viejo").await;
    nube.inicio_seq = None;
    nube.sembrar("INSERT INTO Clientes (ID_Cliente, Nombre) VALUES ('cli-0001', 'Cliente ñ 1');").await;
    empezar(&main, "s1", "base_vacia").await;
    hasta_el_final_y_el_outbox(&main, &mut nube).await;
    clientes_fuera_sin_resucitar(&main, &nube).await;
    nube.cerrar().await;
}

/// DO-SUBIDA · SYNC-36 · Con la vuelta a un instante, como con una copia: la nube devuelta puede tener
/// ya el cambio de la cuarentena, y su tabla se deja para el contraste.
#[tokio::test]
async fn con_un_instante_una_cuarentena_incierta_no_resucita_lo_que_borro() {
    let (main, _dir) = base("cuarentena-instante").await;
    un_bar(&main).await;
    cuarentena(&main, "op-handy", None, borrado_en_clientes()).await;
    let mut nube = NubeDeSubida::nueva("cuarentena-instante").await;
    nube.sembrar("INSERT INTO Clientes (ID_Cliente, Nombre) VALUES ('cli-0001', 'Cliente ñ 1'), ('cli-0008', 'Cliente ñ 8');").await;
    empezar(&main, "s1", "instante").await;
    hasta_el_final_y_el_outbox(&main, &mut nube).await;
    clientes_fuera_sin_resucitar(&main, &nube).await;
    nube.cerrar().await;
}

/// DO-SUBIDA · SYNC-36 · Dos cuarentenas inciertas en la misma tabla, una perdida con la base vacía y
/// otra del log nuevo: gana la de fuera, y la tabla se deja entera para el contraste.
#[tokio::test]
async fn con_una_cuarentena_perdida_y_otra_del_log_nuevo_la_tabla_queda_fuera() {
    let (main, _dir) = base("cuarentena-dos-clases").await;
    un_bar(&main).await;
    let mut nube = NubeDeSubida::nueva("cuarentena-dos-clases").await;
    let inicio = nube.inicio_seq.unwrap();
    cuarentena(&main, "op-perdida", None, sentencias_en_clientes()).await;
    cuarentena_en(&main, "op-nueva", inicio + 1, None, borrado_en_clientes()).await;
    nube.sembrar("INSERT INTO Clientes (ID_Cliente, Nombre) VALUES ('cli-0001', 'Cliente ñ 1');").await;
    empezar(&main, "s1", "base_vacia").await;
    hasta_el_final_y_el_outbox(&main, &mut nube).await;
    clientes_fuera_sin_resucitar(&main, &nube).await;
    nube.cerrar().await;
}

/// DO-SUBIDA · SYNC-36 · Con una base vacía, una cuarentena del log de antes de la que no se sabe ni
/// en qué tablas escribe (sin filas ni sentencias) hace inciertas todas: sube lo que falta arriba, no
/// pisa nada de lo que ya está ni pide borrar nada que pudiera ser suyo.
#[tokio::test]
async fn una_cuarentena_que_no_dice_nada_solo_sube_lo_que_falta_en_todas_las_tablas() {
    let (main, _dir) = base("cuarentena-sin-nada").await;
    un_bar(&main).await;
    cuarentena(&main, "op-handy", None, json!([])).await;
    let mut nube = NubeDeSubida::nueva("cuarentena-sin-nada").await;
    nube.sembrar(
        "INSERT INTO Clientes (ID_Cliente, Nombre) VALUES ('cli-handy', 'Alta de la Handy'), ('cli-0003', 'De la Handy');
         INSERT INTO Comandas (ID_Comanda, Canal, Estado, Fecha_Hora_Apertura) VALUES ('com-handy', 'BARRA', 'Abierta', '2026-11-19 10:00:00');",
    )
    .await;
    empezar(&main, "s1", "base_vacia").await;
    hasta_el_final_y_el_outbox(&main, &mut nube).await;
    assert_eq!(numero(&nube.db, "SELECT COUNT(*) FROM Clientes WHERE ID_Cliente = 'cli-handy';").await, 1, "un sobrante no se borra");
    assert_eq!(numero(&nube.db, "SELECT COUNT(*) FROM Comandas WHERE ID_Comanda = 'com-handy';").await, 1, "un vivo que aquí falta no se borra");
    assert_eq!(nombre_arriba(&nube, "cli-0003").await, Some(Value::Text("De la Handy".into())), "lo que ya está no se pisa");
    assert!(!mandadas_de(&nube, "Clientes").contains(&json!("cli-0003")));
    assert_eq!(numero(&nube.db, "SELECT COUNT(*) FROM Clientes;").await, 301);
    assert_eq!(numero(&nube.db, "SELECT COUNT(*) FROM Comandas;").await, 702);
    assert_eq!(numero(&main, "SELECT COUNT(*) FROM _Sync_Subida_Tablas WHERE Estado = 2;").await, 0, "ninguna tabla fallida");
    nube.cerrar().await;
}

/// DO-SUBIDA · SYNC-36 · Con una copia, una cuarentena de la que no se sabe ni en qué tablas escribe
/// deja todas para el contraste, y la pantalla las cuenta fallidas: daba por subidas sus tablas sin
/// subir nada de lo vivo (sus claves salen de la nube y ya están todas arriba) y subía lo que faltaba,
/// que podía ser lo que el cambio había borrado.
#[tokio::test]
async fn con_una_copia_una_cuarentena_que_no_dice_nada_deja_todas_las_tablas_para_el_contraste() {
    let (main, _dir) = base("cuarentena-copia-sin-nada").await;
    un_bar(&main).await;
    cuarentena(&main, "op-handy", None, json!([])).await;
    let mut nube = NubeDeSubida::nueva("cuarentena-copia-sin-nada").await;
    nube.sembrar(
        "INSERT INTO Clientes (ID_Cliente, Nombre) VALUES ('cli-handy', 'Alta de la Handy');
         INSERT INTO Comandas (ID_Comanda, Canal, Estado, Fecha_Hora_Apertura) VALUES ('com-handy', 'BARRA', 'Abierta', '2026-11-19 10:00:00');",
    )
    .await;
    empezar(&main, "s1", "copia").await;
    hasta_el_final_y_el_outbox(&main, &mut nube).await;
    assert_eq!(nube.filas_mandadas(), 0, "no sube ninguna fila");
    assert_eq!(numero(&nube.db, "SELECT COUNT(*) FROM Clientes WHERE ID_Cliente = 'cli-handy';").await, 1);
    assert_eq!(numero(&nube.db, "SELECT COUNT(*) FROM Comandas WHERE ID_Comanda = 'com-handy';").await, 1);
    assert_eq!(numero(&main, "SELECT COUNT(*) FROM _Sync_Subida_Tablas WHERE Fase <> 4 AND Estado <> 2;").await, 0, "todas fallidas");
    assert!(estado_para_la_pantalla(&main).await.unwrap().unwrap().tablas_fallidas > 0, "y la pantalla lo dice");
    nube.cerrar().await;
}

/// DO-SUBIDA · SYNC-36 · Con una base vacía y una cuarentena que no dice nada, la nube recibe la base
/// entera: dejar fuera todas las tablas inciertas dejaba la nube vacía, y la pantalla las contaba
/// como fallidas.
#[tokio::test]
async fn una_cuarentena_incierta_no_deja_vacia_una_nube_devuelta_con_una_base_vacia() {
    let (main, _dir) = base("cuarentena-base-vacia").await;
    un_bar(&main).await;
    cuarentena(&main, "op-handy", None, json!([])).await;
    let mut nube = NubeDeSubida::nueva("cuarentena-base-vacia").await;
    empezar(&main, "s1", "base_vacia").await;
    hasta_el_final_y_el_outbox(&main, &mut nube).await;
    iguales(&main, &nube, "Zonas", "ID_Zona").await;
    iguales(&main, &nube, "Productos", "ID_Producto").await;
    iguales(&main, &nube, "Clientes", "ID_Cliente").await;
    iguales(&main, &nube, "Comandas", "ID_Comanda").await;
    assert_eq!(numero(&main, "SELECT COUNT(*) FROM _Sync_Subida_Tablas WHERE Estado = 2;").await, 0, "ninguna tabla fallida");
    assert_eq!(estado_para_la_pantalla(&main).await.unwrap().unwrap().tablas_fallidas, 0);
    nube.cerrar().await;
}

/// El primer repaso tras el plan, con `cli-0007` (arriba, de la Handy) y `cli-0009` (sólo aquí) por
/// revisar y una cuarentena que no dice qué filas toca en `Clientes`. Devuelve lo que ha viajado en él.
async fn repaso_con_una_cuarentena_incierta(nombre: &str, origen: &str) -> Vec<serde_json::Value> {
    let (main, _dir) = base(nombre).await;
    un_bar(&main).await;
    cuarentena(&main, "op-handy", None, sentencias_en_clientes()).await;
    let mut nube = NubeDeSubida::nueva(nombre).await;
    nube.sembrar("INSERT INTO Clientes (ID_Cliente, Nombre) VALUES ('cli-0007', 'De la Handy');").await;
    empezar(&main, "s1", origen).await;
    plan_y_por_revisar(&main, &mut nube, &["cli-0007", "cli-0009"]).await;
    // El primer paso tras el plan es el repaso de lo que no entró (de la etapa 0).
    assert!(matches!(SqliteSubidaCompleta::new(main.clone()).paso(&mut nube).await.unwrap(), PasoHecho::Avanza));
    let mandadas = mandadas_de(&nube, "Clientes");
    assert_eq!(numero(&main, "SELECT COUNT(*) FROM _Sync_Subida_Por_Revisar;").await, 0, "suelta lo demás");
    hasta_el_final_y_el_outbox(&main, &mut nube).await;
    assert_eq!(nombre_arriba(&nube, "cli-0007").await, Some(Value::Text("De la Handy".into())));
    nube.cerrar().await;
    mandadas
}

/// DO-SUBIDA (repaso) · SYNC-36 · Con una base vacía, en una tabla incierta el repaso sube lo que no
/// entró sólo si arriba falta, y suelta lo que ya está: lo dejaba todo fuera, y lo que faltaba se
/// quedaba sin subir.
#[tokio::test]
async fn el_repaso_de_una_tabla_incierta_sube_solo_lo_que_falta() {
    let mandadas = repaso_con_una_cuarentena_incierta("repaso-incierta", "base_vacia").await;
    assert_eq!(mandadas, vec![json!("cli-0009")], "el repaso sube sólo lo que falta arriba");
}

/// DO-SUBIDA (repaso) · SYNC-36 · Con una copia, el repaso deja fuera la tabla de una cuarentena que
/// no dice qué filas toca, como una página: subía lo que faltaba arriba, que podía ser lo que el
/// cambio había borrado.
#[tokio::test]
async fn con_una_copia_el_repaso_deja_fuera_la_tabla_de_una_cuarentena_incierta() {
    let mandadas = repaso_con_una_cuarentena_incierta("repaso-incierta-copia", "copia").await;
    assert!(mandadas.is_empty(), "nada de su tabla viaja: {mandadas:?}");
}

/// DO-SUBIDA · Una fila viva que aquí existe pero no se puede mandar (no cabe en una página) queda
/// por revisar, y no se pide borrar arriba: la nube perdía una fila que la Main tiene.
#[tokio::test]
async fn un_vivo_que_no_cabe_en_una_pagina_no_se_borra_arriba() {
    let (main, _dir) = base("vivo-gordo").await;
    un_bar(&main).await;
    sembrar(
        &main,
        "INSERT INTO Comandas (ID_Comanda, Canal, Estado, Fecha_Hora_Apertura) VALUES ('com-gorda', 'BARRA', 'Abierta', '2026-11-20 10:00:00');
         INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, Nombre_Producto, Cantidad, Precio_Unitario, Notas)
           VALUES ('det-gorda', 'com-gorda', 'Cana', 1, 250, replace(hex(zeroblob(600000)), '0', 'x'));",
    )
    .await;
    let mut nube = NubeDeSubida::nueva("vivo-gordo").await;
    nube.sembrar(
        "INSERT INTO Comandas (ID_Comanda, Canal, Estado, Fecha_Hora_Apertura) VALUES ('com-gorda', 'BARRA', 'Abierta', '2026-11-20 10:00:00');
         INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, Nombre_Producto, Cantidad, Precio_Unitario, Notas) VALUES ('det-gorda', 'com-gorda', 'Cana', 1, 250, 'corta');",
    )
    .await;
    empezar(&main, "s1", "copia").await;
    hasta_el_final_y_el_outbox(&main, &mut nube).await;
    assert_eq!(numero(&nube.db, "SELECT COUNT(*) FROM Detalle_Comanda WHERE ID_Detalle = 'det-gorda';").await, 1, "sigue arriba");
    assert_eq!(numero(&main, "SELECT COUNT(*) FROM _Sync_Subida_Por_Revisar WHERE Tabla = 'Detalle_Comanda' AND Motivo = 'otro';").await, 1);
    nube.cerrar().await;
}

/// Un paso de la subida, con una base nueva cada vez (lo que se recuerda entre pasos va en la base).
async fn un_paso(main: &Arc<Db>, nube: &mut NubeDeSubida) -> PasoHecho {
    SqliteSubidaCompleta::new(main.clone()).paso(nube).await.unwrap()
}

fn segundos(p: PasoHecho) -> u64 {
    match p {
        PasoHecho::Esperar(d) => d.as_secs(),
        otro => panic!("se esperaba una espera: {otro:?}"),
    }
}

/// DO-SUBIDA · Un rechazo sin clasificar del plan o del `fin` se repetía cada 30 s sin fin. La espera
/// se dobla con cada rechazo seguido hasta 30 min, sin abandonar, y vuelve a 30 s en cuanto un paso
/// se confirma. Uno pasajero sigue esperando 30 s.
#[tokio::test]
async fn un_rechazo_sin_clasificar_del_plan_o_del_fin_espera_cada_vez_mas_y_vuelve_a_30_s_al_confirmarse_un_paso() {
    let (main, _dir) = base("rechazos-seguidos").await;
    un_bar(&main).await;
    let mut nube = NubeDeSubida::nueva("rechazos-seguidos").await;
    empezar(&main, "s1", "base_vacia").await;
    let rechazar = |accion: Option<&'static str>, acuse: serde_json::Value| -> Option<comun::nube_de_subida::Rechazo> {
        Some(Box::new(move |p| accion.is_none_or(|a| p["accion"] == a).then(|| acuse.clone())))
    };
    let sin_clasificar = json!({"ok": false, "error": "algo_raro"});

    nube.rechazar_paso = rechazar(Some("plan"), sin_clasificar.clone());
    let mut esperas = Vec::new();
    for _ in 0..8 {
        esperas.push(segundos(un_paso(&main, &mut nube).await));
    }
    assert_eq!(esperas, vec![30, 60, 120, 240, 480, 960, 1800, 1800], "se dobla hasta media hora");
    // Uno pasajero sigue igual, y no cuenta.
    nube.rechazar_paso = rechazar(Some("plan"), json!({"ok": false, "error": "presupuesto_de_subida_agotado", "transitorio": true}));
    assert_eq!(segundos(un_paso(&main, &mut nube).await), 30);
    nube.rechazar_paso = rechazar(Some("plan"), sin_clasificar.clone());
    assert_eq!(segundos(un_paso(&main, &mut nube).await), 1800);
    assert!(SqliteSubidaCompleta::new(main.clone()).pendiente().await.unwrap(), "sin abandonar");

    // El plan entra: el siguiente rechazo sin clasificar (de una página) vuelve a esperar 30 s.
    nube.rechazar_paso = None;
    assert_eq!(un_paso(&main, &mut nube).await, PasoHecho::Avanza);
    nube.rechazar_paso = rechazar(None, sin_clasificar.clone());
    assert_eq!(segundos(un_paso(&main, &mut nube).await), 30);
    assert_eq!(segundos(un_paso(&main, &mut nube).await), 60);

    // Todo entra hasta el `fin`, que se rechaza: otra vez desde 30 s.
    nube.rechazar_paso = rechazar(Some("fin"), sin_clasificar);
    let mut esperas = Vec::new();
    for _ in 0..10_000 {
        match un_paso(&main, &mut nube).await {
            PasoHecho::Esperar(d) => {
                esperas.push(d.as_secs());
                if esperas.len() == 3 {
                    break;
                }
            }
            PasoHecho::PorSubir => {
                nube.subir_outbox(&main).await;
            }
            PasoHecho::Avanza => {}
            otro => panic!("paso inesperado: {otro:?}"),
        }
    }
    assert_eq!(esperas, vec![30, 60, 120]);
    nube.rechazar_paso = None;
    assert_eq!(un_paso(&main, &mut nube).await, PasoHecho::Nada);
    assert_eq!(filas(&main, "SELECT Estado, Rechazos_Seguidos FROM _Sync_Subida;").await, vec![vec![Value::Text("contrastando".into()), Value::Integer(0)]]);
    nube.cerrar().await;
}

/// DO-SUBIDA · Una página rechazada sin clasificar a los `MAX_INTENTOS` deja su tabla sin esperar más
/// (esperaba 8 min más ya dada por fallida), pero la cuenta de seguidos no vuelve a cero hasta que la
/// nube admite un paso: con un fallo de todas las tablas (un worker roto que nadie ha clasificado),
/// la siguiente sigue esperando cada vez más. Empezar cada tabla por 30 s dejaba fallida una tabla
/// cada 7 min y medio, y el plan entero en unas horas.
#[tokio::test]
async fn con_un_fallo_sin_clasificar_de_todas_las_tablas_la_espera_sigue_creciendo_de_una_a_otra() {
    let (main, _dir) = base("rechazos-por-tabla").await;
    un_bar(&main).await;
    let mut nube = NubeDeSubida::nueva("rechazos-por-tabla").await;
    empezar(&main, "s1", "base_vacia").await;
    // Un worker que rechaza sin clasificar las páginas de todas las tablas.
    nube.rechazar_si = Some(Box::new(|_| Some(json!({"ok": false, "error": "algo_raro"}))));
    // Lo que hace cada paso hasta la octava espera: las de las dos primeras tablas.
    let mut pasos: Vec<String> = Vec::new();
    for _ in 0..10_000 {
        match un_paso(&main, &mut nube).await {
            PasoHecho::Esperar(d) => {
                pasos.push(d.as_secs().to_string());
                if pasos.iter().filter(|p| *p != "sigue").count() == 8 {
                    break;
                }
            }
            PasoHecho::PorSubir => {
                nube.subir_outbox(&main).await;
            }
            PasoHecho::Avanza => {
                if pasos.last().is_some_and(|p| p != "sigue") {
                    pasos.push("sigue".into());
                }
            }
            otro => panic!("paso inesperado: {otro:?}"),
        }
    }
    let esperas: Vec<&str> = pasos.iter().map(String::as_str).filter(|p| *p != "sigue").collect();
    assert_eq!(esperas, ["30", "60", "120", "240", "960", "1800", "1800", "1800"], "la segunda sigue la cuenta de la primera: {pasos:?}");
    assert_eq!(pasos.iter().filter(|p| *p == "sigue").count(), 1, "y tras la quinta sigue sin esperar: {pasos:?}");
    assert_eq!(un_paso(&main, &mut nube).await, PasoHecho::Avanza, "también en la segunda");
    assert_eq!(numero(&main, "SELECT Rechazos_Seguidos FROM _Sync_Subida;").await, 10);
    assert_eq!(numero(&main, "SELECT COUNT(*) FROM _Sync_Subida_Tablas WHERE Estado = 2;").await, 2, "las dos, fallidas");
    // La nube se arregla: en cuanto admite una página, la cuenta vuelve a cero, y el siguiente rechazo
    // espera otra vez 30 s.
    nube.rechazar_si = None;
    for _ in 0..10_000 {
        if nube.paginas_aplicadas > 0 {
            break;
        }
        match un_paso(&main, &mut nube).await {
            PasoHecho::PorSubir => {
                nube.subir_outbox(&main).await;
            }
            PasoHecho::Avanza => {}
            otro => panic!("paso inesperado: {otro:?}"),
        }
    }
    assert_eq!(numero(&main, "SELECT Rechazos_Seguidos FROM _Sync_Subida;").await, 0);
    nube.rechazar_si = Some(Box::new(|_| Some(json!({"ok": false, "error": "algo_raro"}))));
    let mut espera = None;
    for _ in 0..10_000 {
        match un_paso(&main, &mut nube).await {
            PasoHecho::Esperar(d) => {
                espera = Some(d.as_secs());
                break;
            }
            PasoHecho::PorSubir => {
                nube.subir_outbox(&main).await;
            }
            PasoHecho::Avanza => {}
            otro => panic!("paso inesperado: {otro:?}"),
        }
    }
    assert_eq!(espera, Some(30));
    nube.cerrar().await;
}
