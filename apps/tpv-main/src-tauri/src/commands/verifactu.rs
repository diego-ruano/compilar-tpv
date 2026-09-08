//! Comandos Tauri de **Veri\*factu** (FISCAL-01). Capa fina: ni SQL ni reglas.
//!
//! Los tres son de LECTURA. La emisión no tiene comando propio a propósito: ocurre **dentro de la
//! transacción del cobro**, en el repositorio, porque ahí es donde está la transacción. Un comando
//! «emitir registro» sería la puerta a expedir una factura sin registro (o al revés), que es la
//! única forma de romper esto de verdad.

use tauri::{AppHandle, Manager, State};

use tpv_application::use_cases::verifactu as uc;
use tpv_contracts::errors::AppErrorDto;
use tpv_contracts::verifactu::{BloqueFiscal, EstadoFiscal, RegistroFiscal};

use crate::{AppState, ADMIN};

/// El bloque fiscal de un ticket (número, QR y huella), por su número de factura.
///
/// Sirve igual para **imprimir** y para **reimprimir**: una reimpresión saca los mismos tres, y por
/// eso se leen de la fila en vez de recalcularse — recalcular daría otra hora de generación y, por
/// tanto, otra huella.
///
/// Devuelve `null` si el número está vacío o no tiene registro: es el caso de la **precuenta**, que
/// no es una factura y por tanto no lleva ni registro ni QR. Que no sea un error es lo que permite
/// que la precuenta y el ticket compartan el mismo camino de impresión.
///
/// Sin exigir rol: lo llama la impresión, que hace cualquiera que pueda cobrar.
#[tauri::command]
pub async fn verifactu_bloque_ticket(
    state: State<'_, AppState>,
    numero_ticket: String,
) -> Result<Option<BloqueFiscal>, AppErrorDto> {
    let repo = state.verifactu_repo().await?;
    Ok(uc::bloque_por_numero(repo.as_ref(), &numero_ticket).await?)
}

/// Resumen del estado fiscal para Configuración → Fiscal y para la escalera de avisos.
///
/// Sin exigir rol tampoco: el escalón de aviso lo pinta la barra de estado, que ve todo el mundo, y
/// el objetivo de la escalera es justamente que **no se pueda ignorar**.
#[tauri::command]
pub async fn verifactu_estado(state: State<'_, AppState>) -> Result<EstadoFiscal, AppErrorDto> {
    let repo = state.verifactu_repo().await?;
    Ok(uc::estado(repo.as_ref()).await?)
}

/// Los registros del panel, del más reciente al más antiguo.
///
/// Este sí es de Administrador: es el libro de facturación del negocio.
#[tauri::command]
pub async fn verifactu_listar(
    state: State<'_, AppState>,
    limite: Option<i64>,
    desplazamiento: Option<i64>,
) -> Result<Vec<RegistroFiscal>, AppErrorDto> {
    state.exigir_rol(&[ADMIN]).await?;
    let repo = state.verifactu_repo().await?;
    Ok(uc::listar(repo.as_ref(), limite, desplazamiento).await?)
}

// ─────────────────────────────────────────────────────────────────────────────
// El certificado
// ─────────────────────────────────────────────────────────────────────────────

use tpv_application::ports::aeat::{AeatClient, CertificadoDisponible, EntornoAeat};
use tpv_infra_aeat::AeatAdapter;

fn app_data_dir(app: &AppHandle) -> Result<std::path::PathBuf, AppErrorDto> {
    app.path()
        .app_data_dir()
        .map_err(|e| AppErrorDto::internal(format!("Error obteniendo AppData: {e}")))
}

/// Un certificado del almacén, tal como lo enseña la pantalla de selección.
///
/// **No lleva nada de dentro del certificado más allá de lo que hace falta para reconocerlo.** La
/// huella identifica pero no abre; la clave privada no sale nunca del almacén de Windows.
#[derive(Debug, Clone, serde::Serialize)]
pub struct CertificadoDto {
    pub huella: String,
    pub sujeto: String,
    pub emisor: String,
    pub valido_hasta: String,
    /// `CurrentUser` | `LocalMachine`. **Se enseña**: el almacén es por usuario de Windows, y si la
    /// gestoría lo instaló con su sesión el TPV no lo ve. Es la llamada de soporte más previsible
    /// de todas y esta palabra es la respuesta.
    pub almacen: String,
    /// ¿Se puede usar sin que salga un diálogo o un PIN? Si no, no sirve para el envío automático.
    pub uso_silencioso: bool,
    /// ¿Es el que está elegido ahora mismo?
    pub elegido: bool,
}

fn a_dto(c: CertificadoDisponible, elegido: Option<&str>) -> CertificadoDto {
    let es = elegido.map(|h| h == c.huella).unwrap_or(false);
    CertificadoDto {
        huella: c.huella,
        sujeto: c.sujeto,
        emisor: c.emisor,
        valido_hasta: c.valido_hasta,
        almacen: c.almacen,
        uso_silencioso: c.uso_silencioso,
        elegido: es,
    }
}

/// Los certificados del almacén de Windows que sirven para remitir.
///
/// El único filtro es que tengan **clave privada**: un `.cer` o un `.crt` sólo llevan la parte
/// pública y no pueden autenticar nada. La lista **no menciona el sello de entidad** a propósito —
/// es de pago, sólo se emite a personas jurídicas y recomendarlo convierte una pantalla de dos
/// clics en una conversación fiscal. Quien lo tenga lo elige como cualquier otro; el tipo sólo
/// decide el endpoint, que es una cuenta interna.
#[tauri::command]
pub async fn verifactu_certificados(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<CertificadoDto>, AppErrorDto> {
    state.exigir_rol(&[ADMIN]).await?;
    let elegido = crate::certificado_verifactu(&app_data_dir(&app)?);
    let certs = AeatAdapter::new().certificados().await?;
    Ok(certs
        .into_iter()
        .map(|c| a_dto(c, elegido.as_deref()))
        .collect())
}

/// Elige el certificado con el que se remitirá.
///
/// Se guarda **sólo la huella**, en `device_config.json`. Pasar una vacía lo desconfigura, que es
/// una acción legítima (por ejemplo antes de reinstalar uno renovado).
#[tauri::command]
pub async fn verifactu_set_certificado(
    app: AppHandle,
    state: State<'_, AppState>,
    huella: String,
) -> Result<(), AppErrorDto> {
    state.exigir_rol(&[ADMIN]).await?;
    let h = huella.trim().to_uppercase().replace([' ', ':'], "");

    if !h.is_empty() {
        // Se comprueba que existe ANTES de guardarlo: guardar una huella que no está en el almacén
        // dejaría el panel diciendo «configurado» y la cola creciendo en silencio, que es
        // exactamente lo que no puede pasar.
        let certs = AeatAdapter::new().certificados().await?;
        if !certs.iter().any(|c| c.huella == h) {
            return Err(AppErrorDto::from(tpv_application::error::AppError::validation(
                "Ese certificado no está en el almacén de Windows.",
            )));
        }
    }

    crate::set_certificado_verifactu(&app_data_dir(&app)?, if h.is_empty() { None } else { Some(h) })
        .map_err(tpv_application::error::AppError::internal)?;
    Ok(())
}

/// Handshake real contra la AEAT con el certificado elegido, **sin enviar ningún registro**.
///
/// Es el botón «probar ahora», y existe por una razón concreta: si el certificado esconde un
/// diálogo de PIN —lo que pasa con lectores con pinpad, donde Windows ignora la petición de
/// silencio—, sale **ahí, con el usuario delante**, y no a las tres de la mañana con la cola
/// creciendo.
#[tauri::command]
pub async fn verifactu_probar_conexion(
    app: AppHandle,
    state: State<'_, AppState>,
    huella: Option<String>,
) -> Result<String, AppErrorDto> {
    state.exigir_rol(&[ADMIN]).await?;

    let dir = app_data_dir(&app)?;
    let h = huella
        .map(|s| s.trim().to_uppercase().replace([' ', ':'], ""))
        .filter(|s| !s.is_empty())
        .or_else(|| crate::certificado_verifactu(&dir))
        .ok_or_else(|| {
            AppErrorDto::from(tpv_application::error::AppError::validation(
                "No hay ningún certificado elegido.",
            ))
        })?;

    // La prueba va SIEMPRE contra el entorno configurado. Probar contra preproducción cuando el
    // TPV está en producción daría un «funciona» que no dice nada: son subsedes distintas y la
    // autorización del titular se comprueba en cada una.
    let repo = state.verifactu_repo().await?;
    let entorno = if uc::estado(repo.as_ref()).await?.entorno_pruebas {
        EntornoAeat::Pruebas
    } else {
        EntornoAeat::Produccion
    };

    Ok(AeatAdapter::new().probar_conexion(entorno, &h).await?)
}
