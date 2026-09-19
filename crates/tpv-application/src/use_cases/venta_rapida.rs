//! Casos de uso de venta rápida (barra). Local-First: validan/normalizan e invocan el puerto.

use tpv_contracts::venta_rapida::{
    CategoriaRow, ComandaBarraRow, IndexRow, LineaComandaRow, ProductoRow, StockLinea,
    VerTicketsDetalleRow, VrAddLineaComandaInput, VrCobrarFraccionadoInput,
    VrCreateComandaBarraInput, VrDeleteComandaIfSafeInput, VrDeleteLineaIfUnpaidInput,
    VrIdCategoriaArgs, VrIdComandaArgs, VrIdsArgs, VrListComandasArgs,
    VrRemoveLastUnpaidLineaInput, VrRestarStockInput, VrSearchProductosArgs,
    VrUpdateNotaDetalleInput,
};
use tpv_contracts::verifactu::DestinatarioInput;
use tpv_domain::venta_rapida::{id_de_cobro, limpiar_opcional, normalize_metodo, CobroFraccionado};

use crate::error::{AppError, AppResult};
use crate::ports::venta_rapida::VentaRapidaRepository;

/* Lecturas */

pub async fn list_categorias_vendibles(
    repo: &dyn VentaRapidaRepository,
) -> AppResult<Vec<CategoriaRow>> {
    repo.list_categorias_vendibles().await
}

pub async fn list_productos_by_categoria(
    repo: &dyn VentaRapidaRepository,
    args: VrIdCategoriaArgs,
) -> AppResult<Vec<ProductoRow>> {
    if args.id_categoria.trim().is_empty() {
        return Ok(vec![]);
    }
    repo.list_productos_by_categoria(&args.id_categoria).await
}

pub async fn search_productos(
    repo: &dyn VentaRapidaRepository,
    args: VrSearchProductosArgs,
) -> AppResult<Vec<ProductoRow>> {
    let q = args.query.trim().to_string();
    if q.is_empty() {
        return Ok(vec![]);
    }
    let lim = if args.limit <= 0 { 60 } else { args.limit };
    repo.search_productos(q, lim).await
}

pub async fn list_comandas_barra(
    repo: &dyn VentaRapidaRepository,
    args: VrListComandasArgs,
) -> AppResult<Vec<ComandaBarraRow>> {
    repo.list_comandas_barra(args.include_pagadas, args.limit)
        .await
}

pub async fn get_lineas_comanda(
    repo: &dyn VentaRapidaRepository,
    args: VrIdComandaArgs,
) -> AppResult<Vec<LineaComandaRow>> {
    if args.id_comanda.trim().is_empty() {
        return Ok(vec![]);
    }
    repo.get_lineas_comanda(&args.id_comanda).await
}

pub async fn get_index_rows(
    repo: &dyn VentaRapidaRepository,
    args: VrIdsArgs,
) -> AppResult<Vec<IndexRow>> {
    let ids: Vec<String> = args
        .ids
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if ids.is_empty() {
        return Ok(vec![]);
    }
    repo.get_index_rows(ids).await
}

pub async fn get_detalles_ver_ticket(
    repo: &dyn VentaRapidaRepository,
    args: VrIdComandaArgs,
) -> AppResult<Vec<VerTicketsDetalleRow>> {
    if args.id_comanda.trim().is_empty() {
        return Ok(vec![]);
    }
    repo.get_detalles_ver_ticket(&args.id_comanda).await
}

/* Escrituras */

pub async fn create_comanda_barra(
    repo: &dyn VentaRapidaRepository,
    input: VrCreateComandaBarraInput,
) -> AppResult<String> {
    let id_trabajador = input
        .id_trabajador
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let get_or_create = input.get_or_create.unwrap_or(false);
    repo.create_comanda_barra(id_trabajador, get_or_create)
        .await
}

pub async fn add_linea_comanda(
    repo: &dyn VentaRapidaRepository,
    input: VrAddLineaComandaInput,
) -> AppResult<String> {
    if input.id_comanda.trim().is_empty()
        || input.id_producto.trim().is_empty()
        || !input.cantidad.is_finite()
        || input.cantidad <= 0.0
    {
        return Err(AppError::validation(
            "id_comanda/id_producto/cantidad invalid",
        ));
    }
    // DB-06: Precio_Unitario nunca negativo (paridad con el worker: precio.min(0)).
    if !input.precio_unitario.is_finite() || input.precio_unitario < 0.0 {
        return Err(AppError::validation(
            "precio_unitario invalid (debe ser >= 0)",
        ));
    }
    repo.add_linea_comanda(
        &input.id_comanda,
        &input.id_producto,
        input.cantidad,
        input.precio_unitario,
    )
    .await
}

pub async fn remove_last_unpaid_linea(
    repo: &dyn VentaRapidaRepository,
    input: VrRemoveLastUnpaidLineaInput,
) -> AppResult<bool> {
    if input.id_comanda.trim().is_empty() || input.id_producto.trim().is_empty() {
        return Err(AppError::validation("id_comanda/id_producto invalid"));
    }
    repo.remove_last_unpaid_linea(&input.id_comanda, &input.id_producto)
        .await
}

pub async fn delete_linea_if_unpaid(
    repo: &dyn VentaRapidaRepository,
    input: VrDeleteLineaIfUnpaidInput,
) -> AppResult<bool> {
    if input.id_comanda.trim().is_empty() || input.id_detalle.trim().is_empty() {
        return Err(AppError::validation("id_comanda/id_detalle invalid"));
    }
    repo.delete_linea_if_unpaid(&input.id_comanda, &input.id_detalle)
        .await
}

pub async fn update_nota_detalle(
    repo: &dyn VentaRapidaRepository,
    input: VrUpdateNotaDetalleInput,
) -> AppResult<bool> {
    if input.id_detalle.trim().is_empty() {
        return Err(AppError::validation("id_detalle invalid"));
    }
    repo.update_nota_detalle(&input.id_detalle, limpiar_opcional(input.nota))
        .await
}

fn limpio(s: Option<&str>) -> Option<String> {
    s.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// REV-17: el cobrador llega **aparte** del input, porque sale de la sesión y no de la pantalla.
/// Que sean dos parámetros y no un campo más es lo que impide que alguien lo vuelva a meter ahí
/// sin darse cuenta: el input ya no tiene dónde.
pub async fn cobrar_fraccionado(
    repo: &dyn VentaRapidaRepository,
    id_usuario: &str,
    id_trabajador: Option<&str>,
    input: VrCobrarFraccionadoInput,
) -> AppResult<String> {
    let Some(id_pago) = id_de_cobro(&input.id_pago) else {
        return Err(AppError::validation("id_pago invalid"));
    };
    if input.id_comanda.trim().is_empty() {
        return Err(AppError::validation("id_comanda invalid"));
    }
    if !input.importe_total.is_finite() || input.importe_total < 0.0 {
        return Err(AppError::validation("importe_total invalid"));
    }

    let mut detalles: Vec<String> = input
        .detalles
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    detalles.sort_unstable();
    detalles.dedup();

    if detalles.is_empty() {
        return Err(AppError::validation("detalles required"));
    }

    let data = CobroFraccionado {
        id_pago,
        id_comanda: input.id_comanda,
        metodo: normalize_metodo(&input.metodo),
        importe_total: input.importe_total,
        id_usuario_cobrador: limpio(Some(id_usuario)),
        id_trabajador_cobrador: limpio(id_trabajador),
        detalles,
        destinatario: destinatario_de(input.destinatario),
    };

    repo.cobrar_fraccionado(data).await
}

pub async fn restar_stock(
    repo: &dyn VentaRapidaRepository,
    input: VrRestarStockInput,
) -> AppResult<bool> {
    let mut norm: Vec<StockLinea> = input
        .lineas
        .into_iter()
        .filter(|it| {
            !it.producto_id.trim().is_empty() && it.cantidad.is_finite() && it.cantidad > 0.0
        })
        .collect();

    norm.sort_by(|a, b| a.producto_id.cmp(&b.producto_id));

    let mut merged: Vec<StockLinea> = Vec::new();
    for item in norm {
        if let Some(last) = merged.last_mut() {
            if last.producto_id == item.producto_id {
                last.cantidad += item.cantidad;
                continue;
            }
        }
        merged.push(item);
    }

    if merged.is_empty() {
        return Ok(true);
    }

    repo.restar_stock(merged).await
}

pub async fn delete_comanda_if_safe(
    repo: &dyn VentaRapidaRepository,
    input: VrDeleteComandaIfSafeInput,
) -> AppResult<bool> {
    if input.id_comanda.trim().is_empty() {
        return Err(AppError::validation("id_comanda invalid"));
    }
    repo.delete_comanda_if_safe(&input.id_comanda).await
}

/// Traduce el destinatario del input al del dominio.
///
/// La VALIDACIÓN (nombre, NIF y su dígito de control) no se hace aquí sino en el repositorio, justo
/// antes de emitir: es donde se conoce el límite configurado del negocio y donde está la transacción
/// que hay que rodar atrás si los datos no sirven. Aquí sólo se cambia de forma.
fn destinatario_de(input: Option<DestinatarioInput>) -> Option<tpv_domain::verifactu::Destinatario> {
    input.map(|d| tpv_domain::verifactu::Destinatario {
        nombre_razon: d.nombre_razon,
        nif: d.nif,
        direccion: d.domicilio,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use std::sync::Mutex;

    #[derive(Default)]
    struct FakeRepo { stock: Mutex<Vec<Vec<StockLinea>>>, cobros: Mutex<Vec<CobroFraccionado>> }

    #[async_trait]
    impl VentaRapidaRepository for FakeRepo {
        async fn list_categorias_vendibles(&self) -> AppResult<Vec<CategoriaRow>> { panic!("no usado") }
        async fn list_productos_by_categoria(&self, _: &str) -> AppResult<Vec<ProductoRow>> { panic!("no usado") }
        async fn search_productos(&self, _: String, _: i64) -> AppResult<Vec<ProductoRow>> { panic!("no usado") }
        async fn list_comandas_barra(&self, _: bool, _: Option<i64>) -> AppResult<Vec<ComandaBarraRow>> { panic!("no usado") }
        async fn get_lineas_comanda(&self, _: &str) -> AppResult<Vec<LineaComandaRow>> { panic!("no usado") }
        async fn get_index_rows(&self, _: Vec<String>) -> AppResult<Vec<IndexRow>> { panic!("no usado") }
        async fn get_detalles_ver_ticket(&self, _: &str) -> AppResult<Vec<VerTicketsDetalleRow>> { panic!("no usado") }
        async fn create_comanda_barra(&self, _: Option<String>, _: bool) -> AppResult<String> { panic!("no usado") }
        async fn add_linea_comanda(&self, _: &str, _: &str, _: f64, _: f64) -> AppResult<String> { panic!("no usado") }
        async fn remove_last_unpaid_linea(&self, _: &str, _: &str) -> AppResult<bool> { panic!("no usado") }
        async fn delete_linea_if_unpaid(&self, _: &str, _: &str) -> AppResult<bool> { panic!("no usado") }
        async fn update_nota_detalle(&self, _: &str, _: Option<String>) -> AppResult<bool> { panic!("no usado") }
        async fn cobrar_fraccionado(&self, data: CobroFraccionado) -> AppResult<String> { self.cobros.lock().unwrap().push(data); Ok("T-000001".into()) }
        async fn restar_stock(&self, lineas: Vec<StockLinea>) -> AppResult<bool> { self.stock.lock().unwrap().push(lineas); Ok(true) }
        async fn delete_comanda_if_safe(&self, _: &str) -> AppResult<bool> { panic!("no usado") }
    }

    #[test]
    fn metodo_de_cobro_se_normaliza() {
        assert_eq!(normalize_metodo(" tarjeta "), "Tarjeta");
        assert_eq!(normalize_metodo("otro"), "Efectivo");
    }

    #[test]
    fn notas_vacias_se_convierten_en_none() {
        assert_eq!(
            limpiar_opcional(Some("  sin cebolla  ".into())),
            Some("sin cebolla".into())
        );
        assert_eq!(limpiar_opcional(Some(" ".into())), None);
    }

    #[test]
    fn metodo_tarjeta_es_insensible_a_mayusculas() {
        assert_eq!(normalize_metodo("TARJETA"), "Tarjeta");
        assert_eq!(normalize_metodo("  TaRjEtA  "), "Tarjeta");
    }

    #[test]
    fn notas_none_permanecen_ausentes() {
        assert_eq!(limpiar_opcional(None), None);
    }

    #[tokio::test]
    async fn restar_stock_filtra_invalidos_ordena_y_agrupa_productos() {
        let repo = FakeRepo::default();
        let input = VrRestarStockInput { lineas: vec![
            StockLinea { producto_id: "b".into(), cantidad: 2.0 },
            StockLinea { producto_id: "a".into(), cantidad: 1.5 },
            StockLinea { producto_id: "b".into(), cantidad: 3.0 },
            StockLinea { producto_id: " ".into(), cantidad: 8.0 },
            StockLinea { producto_id: "c".into(), cantidad: 0.0 },
            StockLinea { producto_id: "d".into(), cantidad: f64::NAN },
        ]};
        assert!(restar_stock(&repo, input).await.unwrap());
        let calls = repo.stock.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].len(), 2);
        assert_eq!(calls[0][0].producto_id, "a");
        assert_eq!(calls[0][0].cantidad, 1.5);
        assert_eq!(calls[0][1].producto_id, "b");
        assert_eq!(calls[0][1].cantidad, 5.0);
    }

    #[tokio::test]
    async fn restar_stock_sin_lineas_validas_no_toca_repo() {
        let repo = FakeRepo::default();
        let input = VrRestarStockInput { lineas: vec![StockLinea { producto_id: "".into(), cantidad: -1.0 }] };
        assert!(restar_stock(&repo, input).await.unwrap());
        assert!(repo.stock.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn cobrar_fraccionado_normaliza_metodo_ids_y_detalles() {
        let repo = FakeRepo::default();
        let input = VrCobrarFraccionadoInput {
            id_pago: " 0192F7A4-3B1C-7D2E-8F00-123456789ABC ".into(),
            id_comanda: "comanda-1".into(), metodo: " TARJETA ".into(), importe_total: 12.5,
            detalles: vec!["d2".into(), " d1 ".into(), "d2".into(), " ".into()],
            destinatario: None,
        };
        // Devuelve el número de ticket del cobro, que es lo que el POS imprime a continuación.
        assert_eq!(
            cobrar_fraccionado(&repo, " usuario-1 ", Some(" "), input).await.unwrap(),
            "T-000001"
        );
        let calls = repo.cobros.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].id_pago, "0192f7a4-3b1c-7d2e-8f00-123456789abc");
        assert_eq!(calls[0].metodo, "Tarjeta");
        // REV-17: el cobrador es el de la sesión, recortado; un trabajador en blanco no se inventa.
        assert_eq!(calls[0].id_usuario_cobrador.as_deref(), Some("usuario-1"));
        assert!(calls[0].id_trabajador_cobrador.is_none());
        assert_eq!(calls[0].detalles, vec!["d1".to_string(), "d2".to_string()]);
    }

    /// REV-17: y lo que mande la pantalla no puede cambiarlo. El campo ya no existe en el input,
    /// así que un cliente que lo siga enviando —una versión vieja de la webview, o alguien
    /// llamando al IPC a mano— se lo encuentra ignorado: serde no lo conoce y el cobro queda
    /// firmado por quien tiene la sesión abierta.
    #[tokio::test]
    async fn el_cobrador_es_el_de_la_sesion_aunque_la_pantalla_mande_otro() {
        let crudo = serde_json::json!({
            "id_pago": "0192f7a4-3b1c-7d2e-8f00-123456789abc",
            "id_comanda": "c1",
            "metodo": "Efectivo",
            "importe_total": 3.0,
            "detalles": ["d1"],
            "id_usuario_cobrador": "el-jefe",
            "id_trabajador_cobrador": "t-del-jefe",
        });
        let input: VrCobrarFraccionadoInput = serde_json::from_value(crudo).unwrap();

        let repo = FakeRepo::default();
        cobrar_fraccionado(&repo, "u-camarero", Some("t-camarero"), input).await.unwrap();

        let calls = repo.cobros.lock().unwrap();
        assert_eq!(calls[0].id_usuario_cobrador.as_deref(), Some("u-camarero"));
        assert_eq!(calls[0].id_trabajador_cobrador.as_deref(), Some("t-camarero"));
    }

    #[tokio::test]
    async fn cobrar_fraccionado_rechaza_importe_no_finito_y_detalles_vacios() {
        let repo = FakeRepo::default();
        let invalido = |importe, detalles| VrCobrarFraccionadoInput {
            id_pago: "0192f7a4-3b1c-7d2e-8f00-123456789abc".into(),
            id_comanda: "c1".into(), metodo: "efectivo".into(), importe_total: importe,
            detalles,
            destinatario: None,
        };
        let cobrar = |input| cobrar_fraccionado(&repo, "u1", None, input);
        assert!(cobrar(invalido(f64::INFINITY, vec!["d1".into()])).await.is_err());
        assert!(cobrar(invalido(1.0, vec![" ".into()])).await.is_err());
        // Sin un id válido no hay forma de reconocer un reintento: no se cobra.
        let sin_id = VrCobrarFraccionadoInput { id_pago: "tmp-1".into(), ..invalido(1.0, vec!["d1".into()]) };
        assert!(cobrar(sin_id).await.is_err());
        assert!(repo.cobros.lock().unwrap().is_empty());
    }
}
