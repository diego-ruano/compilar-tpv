//! Contratos (DTOs) de la reserva desde la web (docs/estudios/reservas-web.md).

use serde::{Deserialize, Serialize};

/// Lo que se configura en Configuración → Reservas, en el bloque de la web.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct AjustesReservaWebDto {
    /// El interruptor general (`Business_Settings.Reserva_Web_Activa`).
    pub activa: bool,
    /// Los días cerrados de hoy en adelante, por fecha.
    pub cierres: Vec<CierreReservaWebDto>,
}

/// Un día en que la web no acepta reservas.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct CierreReservaWebDto {
    pub id_cierre: String,
    pub dia_ymd: String,
    pub motivo: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ReservaWebActivarInput {
    pub activa: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ReservaWebCierreInput {
    pub dia_ymd: String,
    pub motivo: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ReservaWebQuitarCierreInput {
    pub id_cierre: String,
}

/// Cómo se puede reservar una mesa desde la web: la casilla y su franja. La pantalla edita una
/// franja por mesa aunque el esquema admita varias.
///
/// `dias_semana` es la máscara de `Reserva_Web_Franjas` (1 lunes … 64 domingo; 127 = todos). Sin
/// franja guardada, las horas llegan vacías.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ReservaWebMesaDto {
    pub id_mesa: String,
    pub activa: bool,
    pub dias_semana: i64,
    pub fecha_desde: Option<String>,
    pub fecha_hasta: Option<String>,
    pub hora_desde: Option<String>,
    pub hora_hasta: Option<String>,
}

/// La clave pública del negocio y la línea que se pega en su web (`POST /v1/reservas-web/clave`).
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ClaveReservaWebDto {
    pub clave: String,
    pub codigo: String,
}

/// El alta de una reserva desde el widget (`POST /v1/publico/reservas/:clave/reservas`). La valida
/// el worker y, al registrarla, la Main: `tpv_domain::reservas_web::AltaWebValidada`, con la tabla
/// de casos compartida (`validacion_casos.json`, dominio `reserva_web`).
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ReservaWebAltaInput {
    pub dia_ymd: String,
    pub hora: String,
    pub personas: i64,
    pub id_mesa: String,
    pub nombre: String,
    pub email: String,
    pub telefono: String,
    pub nota: Option<String>,
}

/// Lo que guarda la pantalla para una mesa. Mismos campos que [`ReservaWebMesaDto`].
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ReservaWebMesaInput {
    pub id_mesa: String,
    pub activa: bool,
    pub dias_semana: i64,
    pub fecha_desde: Option<String>,
    pub fecha_hasta: Option<String>,
    pub hora_desde: Option<String>,
    pub hora_hasta: Option<String>,
}

// ── La entrega a la Main (docs/estudios/reservas-web.md §4.5 y §5.4) ─────────────────────────────
//
// Lo que viaja entre la agenda del worker y la Main. No son comandos de Tauri: la Main los pide y
// los manda por HTTP firmado (`POST /v1/reservas-web/pendientes` y `/recogidas`). Se exportan a
// TypeScript para que el worker escriba contra los mismos tipos.

/// Qué pide una petición de la agenda.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum TipoPeticionWeb {
    Alta,
    Cancelacion,
}

/// Los datos de quien reserva. Sólo en un alta, y sólo mientras la Main no la ha registrado.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct DatosAltaWebDto {
    pub nombre: String,
    pub email: String,
    pub telefono: String,
    pub nota: Option<String>,
}

/// Una petición de la agenda para la Main: un alta (con el `ID_Reserva` que puso la agenda) o la
/// cancelación de una que ya le entregó.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct PeticionReservaWebDto {
    pub id_peticion: String,
    pub tipo: TipoPeticionWeb,
    pub id_reserva: String,
    pub id_mesa: Option<String>,
    pub dia_ymd: String,
    pub hora: String,
    pub personas: i64,
    /// El instante del alta en la hora del negocio: el `Created_At` que escribe la Main.
    pub creada_local: String,
    pub datos: Option<DatosAltaWebDto>,
}

/// La respuesta de `POST /v1/reservas-web/pendientes`.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct PendientesReservaWebDto {
    pub peticiones: Vec<PeticionReservaWebDto>,
    /// Quedan más: la Main vuelve a pedir después de contestar éstas.
    pub hay_mas: bool,
}

/// Cómo le ha ido a la Main con una petición.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ResultadoRecogidaWeb {
    /// Guardada (o ya lo estaba).
    Registrada,
    /// Guardada, pero pisa otra reserva o una comanda, o su mesa ya no está: el restaurante la
    /// tiene que mover. Una reserva web confirmada nunca se rechaza.
    Solapada,
    /// No se ha podido guardar: al cliente se le avisa por correo.
    Fallida,
}

/// Una línea de `POST /v1/reservas-web/recogidas`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct RecogidaReservaWebDto {
    pub id_peticion: String,
    pub resultado: ResultadoRecogidaWeb,
    /// En una `fallida`, el código del error (nunca su texto, que podría llevar datos).
    pub codigo: Option<String>,
}

/// El cuerpo de `POST /v1/reservas-web/recogidas`.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct RecogidasReservaWebInput {
    pub resultados: Vec<RecogidaReservaWebDto>,
}
