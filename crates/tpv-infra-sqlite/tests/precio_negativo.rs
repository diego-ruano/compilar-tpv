//! AUD-17 · Un precio de venta negativo no saca dinero del cajón.
//!
//! El esquema deja «Precio_Unitario >= 0» e «Importe_Total >= 0» a la capa de aplicación (DB-06), y
//! nadie lo comprobaba: una Handy daba de alta un producto a −50 €, la Main aplicaba la réplica tal
//! cual y el cobro de mesa quedaba ACTIVO en −50 € con el arqueo cuadrado; y una devolución podía
//! pasar de lo cobrado. La puerta es la validación del producto, en la Main y en el worker
//! (`validacion_casos.json`); aquí se recorre lo que hace la Main si aun así le llega ese precio por
//! la réplica, que la Main aplica sin validar: la sentencia exacta que difundía el DO, aplicada con
//! `SqliteSyncRepository::apply_changes`, y después los caminos reales de la línea, el cobro de mesa
//! (`use_cases::mesas::cobrar_detalles`), el de barra, la devolución parcial
//! (`use_cases::cuentas::devolver_lineas`) y el arqueo (`totales_desde`).
//!
//! Sólo API pública, una BD de verdad en `%TEMP%/tpv_tests` y datos ficticios. Cada test cierra su
//! BD y borra su carpeta al terminar.

use std::path::PathBuf;
use std::sync::Arc;

use tpv_application::error::AppError;
use tpv_application::ports::cierre_caja::CierreCajaRepository;
use tpv_application::ports::mesas::MesasRepository;
use tpv_application::ports::sync::SyncRepository;
use tpv_application::ports::venta_rapida::VentaRapidaRepository;
use tpv_contracts::cuentas::{AnularPagoInput, DevolverLineasInput, LineaADevolverInput};
use tpv_contracts::inventario::{CreateLoteInput, UpsertProductoInput};
use tpv_contracts::mesas::MesasCobrarDetallesInput;
use tpv_contracts::permisos::AutorizacionUsuario;
use tpv_contracts::sync::{SqlStatement, SyncChange};
use tpv_contracts::venta_rapida::VrCobrarFraccionadoInput;
use tpv_domain::cuentas::RechazoDevolucion;
use tpv_domain::dinero::Dinero;
use tpv_infra_sqlite::cierre_caja::SqliteCierreCajaRepository;
use tpv_infra_sqlite::cuentas::SqliteCuentasRepository;
use tpv_infra_sqlite::db::{Db, Reader};
use tpv_infra_sqlite::ejecutor::Value;
use tpv_infra_sqlite::inventario::SqliteInventarioRepository;
use tpv_infra_sqlite::mapping::v_f64;
use tpv_infra_sqlite::mesas::SqliteMesasRepository;
use tpv_infra_sqlite::sync::SqliteSyncRepository;
use tpv_infra_sqlite::venta_rapida::SqliteVentaRapidaRepository;

/// Lo que dicen la mesa y la barra a un cobro en negativo.
const IMPORTE_NEGATIVO: &str = "El importe no puede ser negativo.";

/// La sentencia que el DO replicaba a la Main tras `POST /v1/inventario/productos` de una Handy
/// (`buildApplyBatch(...).replicated`). El worker ya no la produce con un precio negativo; aquí
/// hace de dato que llega de antes o de una nube que no valida.
const SQL_UPSERT_REPLICADO: &str = "INSERT INTO Productos (ID_Producto, ID_Categoria, ID_Proveedor, Nombre, Precio_Venta, Stock_Minimo, Unidad_Medida, Nombre_Imagen, Ruta_Imagen, Cantidad_Pedido_Esperada, Stock_Suelto, IVA_Percent)\n\tVALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)\n\tON CONFLICT(ID_Producto) DO UPDATE SET\n\t\tID_Categoria = excluded.ID_Categoria,\n\t\tID_Proveedor = excluded.ID_Proveedor,\n\t\tNombre = excluded.Nombre,\n\t\tPrecio_Venta = excluded.Precio_Venta,\n\t\tStock_Minimo = excluded.Stock_Minimo,\n\t\tUnidad_Medida = excluded.Unidad_Medida,\n\t\tNombre_Imagen = COALESCE(excluded.Nombre_Imagen, Productos.Nombre_Imagen),\n\t\tRuta_Imagen = COALESCE(excluded.Ruta_Imagen, Productos.Ruta_Imagen),\n\t\tCantidad_Pedido_Esperada = excluded.Cantidad_Pedido_Esperada,\n\t\tIVA_Percent = excluded.IVA_Percent;";

/// Un bar con NIF (sin él no se emite el registro y no se cobra), un usuario que cobra, un menú a
/// 60,00 € y una comanda abierta.
const NEGOCIO: &[&str] = &[
    "UPDATE Business_Settings SET CIF = 'B12345674', Razon_Social = 'Bar de Pruebas SL' WHERE ID = 1;",
    "INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre)
       VALUES ('u1', '00000000-0000-7000-8000-000000000001', 'jefe@bar.example', 'x', 'Marta');",
    "INSERT INTO Categorias_Producto (ID_Categoria, Nombre, Vendible) VALUES ('cat-1', 'Bebidas', 1);",
    "INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta) VALUES ('menu', 'cat-1', 'Menú', 6000);",
    "INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura, Estado, Total_Comanda)
       VALUES ('cn', 'BARRA', '2026-11-08 12:00:00', 'Abierta', 0);",
];

struct Base {
    db: Arc<Db>,
    dir: PathBuf,
}

impl Base {
    async fn nueva() -> Self {
        let dir = std::env::temp_dir()
            .join("tpv_tests")
            .join(format!("aud17-{}", tpv_infra_sqlite::util::new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        let b = Base { db, dir };
        let w = b.db.write().await;
        for sql in NEGOCIO {
            w.raw()
                .execute(sql, Vec::<Value>::new())
                .await
                .unwrap_or_else(|e| panic!("sembrando: {sql}\n{e}"));
        }
        drop(w);
        b
    }

    async fn num(&self, sql: &str) -> f64 {
        let r = self.db.read().await;
        let mut rows = r.query(sql, Vec::<Value>::new()).await.unwrap();
        let row = rows.next().await.unwrap().unwrap_or_else(|| panic!("sin filas: {sql}"));
        v_f64(row.get_value(0).unwrap()).unwrap_or(f64::NAN)
    }

    /// El alta llega a la Main como la difundía el DO: la misma sentencia, ya resuelta.
    async fn llega_por_la_replica(&self, id_producto: &str, precio: i64) {
        let cambio = SyncChange {
            op_id: format!("op-handy-{id_producto}"),
            seq: 1,
            statements: vec![
                SqlStatement {
                    sql: SQL_UPSERT_REPLICADO.into(),
                    args: serde_json::json!([id_producto, "cat-1", null, "Ajuste", precio, null, null, null, null, null, null, null])
                        .as_array()
                        .unwrap()
                        .clone(),
                },
                SqlStatement {
                    sql: "DELETE FROM Producto_Alergenos WHERE ID_Producto=?1;".into(),
                    args: vec![serde_json::json!(id_producto)],
                },
            ],
        };
        let r = SqliteSyncRepository::new(self.db.clone()).apply_changes(vec![cambio]).await.unwrap();
        assert_eq!(r.aplicadas.len(), 1, "la Main aplica la sentencia replicada tal cual");
    }

    /// Una línea por el camino de la Main (`snapshot_del_producto`). Devuelve su `ID_Detalle`.
    async fn linea(&self, id_producto: &str) -> (String, Dinero) {
        let filas = SqliteMesasRepository::new(self.db.clone())
            .add_linea_comanda("cn", id_producto, 1.0, None)
            .await
            .unwrap();
        let l = filas.iter().rev().find(|l| l.id_producto == id_producto).unwrap();
        (l.id_detalle.clone(), l.precio_unitario)
    }

    /// El cobro de mesa en efectivo por el caso de uso del comando `mesas_cobrar_detalles`.
    async fn cobrar(&self, detalles: &[&str]) -> Result<String, AppError> {
        let repo = SqliteMesasRepository::new(self.db.clone());
        tpv_application::use_cases::mesas::cobrar_detalles(
            &repo,
            "u1",
            MesasCobrarDetallesInput {
                id_comanda: "cn".into(),
                metodo: "Efectivo".into(),
                tipo: "TOTAL".into(),
                detalle_ids: detalles.iter().map(|s| s.to_string()).collect(),
                destinatario: None,
            },
        )
        .await
    }

    async fn devolver(&self, id_pago: &str, lineas: &[&str]) -> Result<tpv_contracts::cuentas::DevolucionDto, AppError> {
        let repo = SqliteCuentasRepository::new(self.db.clone());
        tpv_application::use_cases::cuentas::devolver_lineas(
            &repo,
            "u1",
            DevolverLineasInput {
                id_pago: id_pago.into(),
                lineas: lineas
                    .iter()
                    .map(|d| LineaADevolverInput { id_detalle: d.to_string(), cantidad: 1.0 })
                    .collect(),
                metodo: "Efectivo".into(),
                motivo: Some("estaba frío".into()),
            },
        )
        .await
    }

    async fn ventas_efectivo(&self) -> Dinero {
        SqliteCierreCajaRepository::new(self.db.clone()).totales_desde(None).await.unwrap().ventas_efectivo
    }

    async fn cerrar(self) {
        let _ = self.db.cerrar().await;
        let Base { db, dir } = self;
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

fn es_importe_negativo(e: &AppError) -> bool {
    matches!(e, AppError::Validation(m) if m == IMPORTE_NEGATIVO)
}

#[tokio::test]
async fn un_precio_negativo_que_llega_por_la_replica_no_se_cobra_en_mesa() {
    let b = Base::nueva().await;

    // La Main aplica la réplica tal cual y la línea copia el precio: eso no cambia.
    b.llega_por_la_replica("prod-neg", -5000).await;
    let (det, precio) = b.linea("prod-neg").await;
    assert_eq!(precio, Dinero::de_centimos(-5000));

    // Lo que cambia es el cobro: no entra, y no deja ni el pago, ni el apunte, ni la factura.
    let e = b.cobrar(&[&det]).await.unwrap_err();
    assert!(es_importe_negativo(&e), "{e:?}");
    assert_eq!(b.num("SELECT COUNT(*) FROM Pagos;").await, 0.0);
    assert_eq!(b.num("SELECT COUNT(*) FROM Movimientos_Caja;").await, 0.0);
    assert_eq!(b.num("SELECT COUNT(*) FROM Registros_Facturacion;").await, 0.0);
    assert_eq!(b.num("SELECT COUNT(*) FROM v_lineas_cobradas;").await, 0.0, "la línea sigue pendiente");

    // Y el arqueo no se mueve: quien saque 50 € del cajón deja un descuadre de −50 €.
    let ventas = b.ventas_efectivo().await;
    assert_eq!(ventas, Dinero::CERO);
    let fondo = Dinero::de_centimos(10_000);
    let contado = Dinero::de_centimos(5_000);
    let arqueo = tpv_domain::cierre_caja::calcular(fondo, ventas, Dinero::CERO, contado, Dinero::CERO);
    assert_eq!(arqueo.descuadre, Dinero::de_centimos(-5000), "el arqueo señala lo que falta");

    b.cerrar().await;
}

#[tokio::test]
async fn un_cobro_con_una_linea_en_negativo_se_devuelve_entero_y_no_por_partes() {
    let b = Base::nueva().await;
    b.llega_por_la_replica("prod-neg", -5000).await;

    // Un menú de 60,00 € y la línea de −50,00 €: el cobro es de 10,00 € y entra (no es negativo).
    let (menu, _) = b.linea("menu").await;
    let (neg, _) = b.linea("prod-neg").await;
    let id_pago = b.cobrar(&[&menu, &neg]).await.expect("el cobro de 10 € entra");
    assert_eq!(b.num(&format!("SELECT Importe_Total FROM Pagos WHERE ID_Pago = '{id_pago}';")).await, 1000.0);

    // Devolver sólo el menú sacaría 60,00 € de un cobro de 10,00 €, y la línea en negativo no tiene
    // nada que devolver: por partes no entra, ni deja nada.
    for lineas in [vec![menu.as_str()], vec![menu.as_str(), neg.as_str()], vec![neg.as_str()]] {
        let e = b.devolver(&id_pago, &lineas).await.unwrap_err();
        assert!(matches!(e, AppError::Conflict(_)), "{lineas:?}: {e:?}");
        assert_eq!(e.to_string(), RechazoDevolucion::LineaEnNegativo.mensaje(), "{lineas:?}");
    }
    assert_eq!(b.num("SELECT COUNT(*) FROM Pagos WHERE Tipo = 'DEVOLUCION';").await, 0.0);
    assert_eq!(b.num("SELECT COUNT(*) FROM Devolucion_Lineas;").await, 0.0);
    assert_eq!(
        b.num("SELECT COUNT(*) FROM Registros_Facturacion WHERE Tipo_Factura IN ('R1', 'R5');").await,
        0.0,
        "ni su rectificativa"
    );
    assert_eq!(b.ventas_efectivo().await, Dinero::de_centimos(1000));

    // La salida es la devolución entera, que devuelve lo cobrado: 10,00 €, y el periodo a cero.
    let repo = SqliteCuentasRepository::new(b.db.clone());
    let hecho = tpv_application::use_cases::cuentas::anular_pago(
        &repo,
        "u1",
        AnularPagoInput {
            id_pago: id_pago.clone(),
            motivo: Some("estaba frío".into()),
            clase: Some("DEVOLUCION".into()),
        },
    )
    .await
    .expect("la devolución entera sale");
    assert!(hecho.anulado);
    assert_eq!(
        b.num(&format!("SELECT Importe FROM Movimientos_Caja WHERE ID_Pago = '{id_pago}' AND Tipo = 'DEVOLUCION';")).await,
        1000.0
    );
    assert_eq!(b.ventas_efectivo().await, Dinero::CERO);

    b.cerrar().await;
}

#[tokio::test]
async fn la_mesa_rechaza_el_total_negativo_igual_que_la_barra() {
    let b = Base::nueva().await;
    b.llega_por_la_replica("prod-neg", -5000).await;
    let vr = SqliteVentaRapidaRepository::new(b.db.clone());
    let neg = vr.add_linea_comanda("cn", "prod-neg", 1.0).await.unwrap();

    // En barra, la pantalla manda la suma de lo elegido y el caso de uso mira su signo.
    let barra = tpv_application::use_cases::venta_rapida::cobrar_fraccionado(
        &vr,
        "u1",
        None,
        VrCobrarFraccionadoInput {
            id_pago: tpv_infra_sqlite::util::new_id(),
            id_comanda: "cn".into(),
            metodo: "Efectivo".into(),
            importe_total: Dinero::de_centimos(-5000),
            detalles: vec![neg.id_detalle.clone()],
            destinatario: None,
        },
    )
    .await
    .unwrap_err();
    assert!(es_importe_negativo(&barra), "{barra:?}");

    // Y si la pantalla manda 0 €, lo que mira es lo que suma la base: dice lo mismo.
    let barra_a_cero = tpv_application::use_cases::venta_rapida::cobrar_fraccionado(
        &vr,
        "u1",
        None,
        VrCobrarFraccionadoInput {
            id_pago: tpv_infra_sqlite::util::new_id(),
            id_comanda: "cn".into(),
            metodo: "Efectivo".into(),
            importe_total: Dinero::CERO,
            detalles: vec![neg.id_detalle.clone()],
            destinatario: None,
        },
    )
    .await
    .unwrap_err();
    assert!(es_importe_negativo(&barra_a_cero), "{barra_a_cero:?}");
    assert_eq!(b.num("SELECT COUNT(*) FROM Pagos;").await, 0.0);

    // En mesa el total lo suma la base, y dice lo mismo.
    let mesa = b.cobrar(&[&neg.id_detalle]).await.unwrap_err();
    assert!(es_importe_negativo(&mesa), "{mesa:?}");
    assert_eq!(b.num("SELECT COUNT(*) FROM Pagos;").await, 0.0);

    b.cerrar().await;
}

#[tokio::test]
async fn el_caso_de_uso_de_la_main_rechaza_el_precio_y_el_coste_negativos() {
    // Lo que ejecutan `inventario_upsert_producto` e `inventario_create_lote` (IPC), con una sesión
    // que tiene `catalogo.precios`.
    let b = Base::nueva().await;
    let repo = SqliteInventarioRepository::new(b.db.clone());
    let autorizacion = AutorizacionUsuario {
        rol: "Encargado".into(),
        permisos: vec!["catalogo.editar".into(), "catalogo.precios".into()],
    };
    let producto = |id: &str, centimos: i64| UpsertProductoInput {
        id_producto: Some(id.into()),
        id_categoria: "cat-1".into(),
        id_proveedor: None,
        nombre: "Ajuste".into(),
        precio_venta: Some(Dinero::de_centimos(centimos)),
        stock_minimo: None,
        unidad_medida: None,
        nombre_imagen: None,
        ruta_imagen: None,
        cantidad_pedido_esperada: None,
        stock_suelto: None,
        iva_percent: None,
        ids_alergenos: vec![],
        ids_ingredientes: None,
    };

    let e = tpv_application::use_cases::inventario::upsert_producto(&repo, "u1", producto("ipc-neg", -5000), &autorizacion)
        .await
        .unwrap_err();
    assert!(matches!(&e, AppError::Validation(m) if m == "El precio no puede ser negativo."), "{e:?}");
    assert_eq!(b.num("SELECT COUNT(*) FROM Productos WHERE ID_Producto = 'ipc-neg';").await, 0.0);

    // Una invitación (0 €) sí se da de alta.
    tpv_application::use_cases::inventario::upsert_producto(&repo, "u1", producto("ipc-cero", 0), &autorizacion)
        .await
        .expect("un precio de 0 € vale");
    assert_eq!(b.num("SELECT Precio_Venta FROM Productos WHERE ID_Producto = 'ipc-cero';").await, 0.0);

    let e = tpv_application::use_cases::inventario::create_lote(
        &repo,
        "u1",
        CreateLoteInput {
            id_lote: None,
            id_producto: "menu".into(),
            codigo_lote: "L-1".into(),
            caducidad: None,
            stock_disponible: 1.0,
            fecha_entrada: None,
            coste_unitario: Some(Dinero::de_centimos(-1)),
            id_proveedor: None,
            notas: None,
        },
    )
    .await
    .unwrap_err();
    assert!(matches!(&e, AppError::Validation(m) if m == "El coste unitario no puede ser negativo."), "{e:?}");
    assert_eq!(b.num("SELECT COUNT(*) FROM Lotes_Producto;").await, 0.0);

    b.cerrar().await;
}
