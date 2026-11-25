//! Contratos (DTOs) de la frontera UI<->Rust para **stats** (analítica, solo lectura).
//! Los campos van en snake_case o en PascalCase, según lo que lee la pantalla de cada gráfica, y los
//! enums con sus `#[serde(rename)]`.
//!
//! Como es un módulo puramente de lectura no tiene entidades de dominio: todos los
//! tipos viven aquí (incluidos los enums de filtro y las series de gráfica compartidas).

use tpv_domain::dinero::Dinero;

use serde::{Deserialize, Serialize};
/* =========================================================
   Enums de filtro (rango temporal / turno)
========================================================= */

#[derive(Debug, Clone, Copy, Serialize, Deserialize, specta::Type)]
pub enum StatsRange {
    #[serde(rename = "hoy")]
    Hoy,
    #[serde(rename = "semana")]
    Semana,
    #[serde(rename = "mes")]
    Mes,
    #[serde(rename = "anio")]
    Anio,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, specta::Type)]
pub enum StatsTurno {
    #[serde(rename = "COMIDA")]
    Comida,
    #[serde(rename = "CENA")]
    Cena,
    #[serde(rename = "TODOS")]
    Todos,
}

/* =========================================================
   Series de gráfica compartidas
========================================================= */

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ChartSeriesI64 {
    pub labels: Vec<String>,
    pub values: Vec<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ChartSerieDinero {
    pub labels: Vec<String>,
    pub values: Vec<Dinero>,
}

/* =========================================================
   MESAS
========================================================= */

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct MesasTopComandas {
    pub mesa: String,
    pub zona: String,
    pub comandas: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct MesaIngresoRow {
    pub mesa: String,
    pub zona: String,
    pub total: Dinero,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct MesasStatsResponse {
    pub total_mesas: i64,
    pub ocupadas: i64,
    pub ticket_medio_por_mesa: Dinero,
    pub mesa_top_comandas: Option<MesasTopComandas>,
    pub servicios: ChartSeriesI64,
    pub top_mesas_ingresos: Vec<MesaIngresoRow>,
}

/* =========================================================
   PRODUCTOS
========================================================= */

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[allow(non_snake_case)]
pub struct StatsCategoriaRow {
    pub ID_Categoria: String,
    pub Nombre: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ProductosStatsArgs {
    pub range: StatsRange,
    pub categoria_top_id: Option<String>,
    pub categoria_worst_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ProductosStatsResponse {
    pub mejor_producto: Option<String>,
    pub peor_producto_vendible: Option<String>,
    pub top10_mejores: ChartSeriesI64,
    pub top10_peores: ChartSeriesI64,
}

/* =========================================================
   RESERVAS
========================================================= */

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ReservasStatsArgs {
    pub range: StatsRange,
    pub turno: StatsTurno,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ReservasMesasTurno {
    pub turno: StatsTurno,
    pub mesas_reservadas: i64,
    pub mesas_no_reservadas: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ReservasStatsResponse {
    pub total_reservas: i64,
    pub cancelaciones: i64,
    pub mesas_turno: ReservasMesasTurno,
    pub reservas_por_bucket: ChartSeriesI64,
    pub estado: ChartSeriesI64,
    pub franjas: ChartSeriesI64,
}

/* =========================================================
   TRABAJADORES
========================================================= */

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct PuntualidadInfo {
    pub puntual: bool,
    pub programado: String,
    pub entrada: String,
    pub minutos_retraso: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct TrabajadoresStatsArgs {
    pub range: StatsRange,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct TrabajadorCardStats {
    pub id_trabajador: String,
    pub nombre: String,
    pub rol: String,

    pub tareas_asignadas: i64,
    pub tareas_finalizadas: i64,

    pub puntualidad: Option<PuntualidadInfo>,
    pub horas_trabajadas: f64,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub comandas_preparadas: Option<i64>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub comandas_tomadas: Option<i64>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub cobros_realizados: Option<i64>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub ticket_medio: Option<Dinero>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct TrabajadoresStatsResponse {
    pub cocineros: Vec<TrabajadorCardStats>,
    pub camareros: Vec<TrabajadorCardStats>,
    pub limpieza: Vec<TrabajadorCardStats>,
    pub ranking_ventas: ChartSerieDinero,
}

/* =========================================================
   CLIENTES
========================================================= */

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ClientesStatsArgs {
    pub range: StatsRange,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ClientesStatsResponse {
    pub nuevos: i64,
    pub recurrentes: i64,
    pub no_recurrentes: i64,
    pub ticket_medio_cliente: Dinero,

    pub nuevos_por_bucket: ChartSeriesI64,
    pub top_clientes_gasto: ChartSerieDinero,
}

/* =========================================================
   PROVEEDORES
========================================================= */

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ProveedoresStatsArgs {
    pub range: StatsRange,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ProveedorTop {
    pub nombre: String,
    pub total: Dinero,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct UltimoGastoProveedor {
    pub fecha: String,
    pub proveedor: String,
    pub concepto: String,
    pub importe: Dinero,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ProveedoresStatsResponse {
    pub total_gasto: Dinero,
    pub num_gastos: i64,
    pub gasto_medio: Dinero,
    pub porcentaje_sobre_total_gastos: f64,

    pub proveedor_top: Option<ProveedorTop>,

    pub gastos_evolucion: ChartSerieDinero,
    pub gasto_por_proveedor: ChartSerieDinero,

    pub ultimos_gastos: Vec<UltimoGastoProveedor>,
}
