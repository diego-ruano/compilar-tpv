//! Comandos Tauri de **Veri\*factu** (FISCAL-01). Capa fina: ni SQL ni reglas.
//!
//! La emisión de un alta no tiene comando propio a propósito: ocurre **dentro de la transacción
//! del cobro** (o de la baja de un cobro), en el repositorio, porque ahí es donde está la
//! transacción. Un comando «emitir registro» sería la puerta a expedir una factura sin registro (o
//! al revés), que es la única forma de romper esto de verdad. Los únicos que escriben un registro
//! son la `F3` de un ticket ya expedido y la subsanación de los rechazados, y los dos parten de un
//! registro que ya existe.

use tauri::{AppHandle, Manager, State};

use tpv_application::use_cases::verifactu as uc;
use tpv_contracts::errors::AppErrorDto;
use tpv_contracts::verifactu::{BloqueFiscal, EstadoFiscal, RegistroFiscal};

use crate::{AppState, ADMIN};

/// Resumen del estado fiscal para Configuración → Fiscal y para la escalera de avisos.
///
/// Sin exigir rol tampoco: el escalón de aviso lo leen el aviso al iniciar sesión y el aviso tras
/// cada cobro, que salen a quien esté delante, y el objetivo de la escalera es justamente que **no
/// se pueda ignorar**.
#[tauri::command]
pub async fn verifactu_estado(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<EstadoFiscal, AppErrorDto> {
    let repo = state.verifactu_repo().await?;
    let mut estado = uc::estado(repo.as_ref()).await?;
    // Lo del certificado lo añade el shell: el almacén de Windows no está en la base de datos, así
    // que `estado_fiscal` no puede saberlo. Es best-effort — si el almacén no se deja leer, el panel
    // enseña todo lo demás en vez de fallar entero.
    if let Ok(dir) = app_data_dir(&app) {
        uc::completar_con_el_certificado(&mut estado, &estado_del_certificado(&dir).await);
    }
    Ok(estado)
}

/// Mira el almacén de Windows y resume el estado del certificado **elegido**.
///
/// Ante la duda devuelve el estado más pesimista que sea cierto: si el almacén no se puede leer, se
/// informa «no encontrado» en vez de «todo bien». Un panel que dice que se puede remitir cuando no
/// se puede es peor que uno que se equivoca al revés — el segundo provoca una llamada, el primero
/// deja la cola creciendo en silencio.
pub(crate) async fn estado_del_certificado(dir: &std::path::Path) -> uc::EstadoCertificado {
    let Some(huella) = crate::certificado_verifactu(dir) else {
        return uc::EstadoCertificado {
            elegido: false,
            ..Default::default()
        };
    };

    let Ok(certs) = AeatAdapter::new().certificados().await else {
        return uc::EstadoCertificado {
            elegido: true,
            encontrado: false,
            ..Default::default()
        };
    };

    match certs.into_iter().find(|c| c.huella == huella) {
        Some(c) => uc::EstadoCertificado {
            elegido: true,
            encontrado: true,
            dias_para_caducar: dias_hasta(&c.valido_hasta),
            uso_silencioso: c.uso_silencioso,
        },
        None => uc::EstadoCertificado {
            elegido: true,
            encontrado: false,
            ..Default::default()
        },
    }
}

/// Días desde hoy hasta una fecha `AAAA-MM-DD`. Negativo si ya pasó, `None` si no se puede leer.
fn dias_hasta(fecha: &str) -> Option<i64> {
    let d = chrono::NaiveDate::parse_from_str(fecha.trim(), "%Y-%m-%d").ok()?;
    Some((d - chrono::Local::now().date_naive()).num_days())
}

/// MODO-PRUEBA (temporal): activa o desactiva el modo prueba. Con él los cobros no emiten registro
/// de facturación, no se remite nada y no hacen falta NIF ni certificado. Se quita entero antes de
/// que Veri*factu sea obligatorio: `grep -rn MODO-PRUEBA` lista todo lo que hay que borrar.
#[tauri::command]
pub async fn verifactu_set_modo_prueba(
    app: AppHandle,
    state: State<'_, AppState>,
    encendido: bool,
) -> Result<(), AppErrorDto> {
    state.exigir_rol(&[ADMIN]).await?;
    let db = {
        let guard = state.db.lock().await;
        guard.as_ref().cloned().ok_or_else(|| {
            AppErrorDto::internal("El modo prueba sólo existe en el TPV principal")
        })?
    };
    tpv_infra_sqlite::verifactu::set_modo_prueba(&db, encendido).await?;
    // Que el panel y la barra de estado se enteren sin recargar.
    let _ = tauri::Emitter::emit(&app, "verifactu:cambio", ());
    Ok(())
}

/// Vuelve a mandar los registros que la AEAT **rechazó**, como subsanación. Devuelve cuántos.
///
/// Sin esto, un rechazo era el final del camino: `pendientes()` sólo coge los `PENDIENTE`, así que el
/// registro se quedaba en el panel, contado como rechazado y sin ninguna forma de avanzar.
///
/// Es **manual a propósito**. Un reintento automático de algo que la AEAT ya rechazó una vez
/// repetiría el rechazo cada minuto: si el motivo era un fallo del programa, hace falta la versión
/// que lo arregla; si era otra cosa, hace falta mirarla. Lo que se automatiza aquí es lo que no
/// puede fallar dos veces igual, no lo que ya falló.
#[tauri::command]
pub async fn verifactu_subsanar_rechazados(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<usize, AppErrorDto> {
    state.exigir_rol(&[ADMIN]).await?;
    let db = {
        let guard = state.db.lock().await;
        guard.as_ref().cloned().ok_or_else(|| {
            AppErrorDto::internal("Los registros de facturación sólo existen en el TPV principal")
        })?
    };
    let n = tpv_infra_sqlite::verifactu::subsanar_rechazados(&db).await?;
    let _ = tauri::Emitter::emit(&app, "verifactu:cambio", ());
    Ok(n)
}

/// Da por vistas las anomalías de la cadena. Devuelve cuántas ha marcado.
///
/// «Reconocida» no es «resuelta»: las filas se conservan, porque lo que registran es que a este
/// equipo le pasó algo y eso no deja de ser cierto porque alguien pulse un botón. Lo único que
/// cambia es que dejan de gritarlo.
#[tauri::command]
pub async fn verifactu_reconocer_anomalias(
    state: State<'_, AppState>,
) -> Result<usize, AppErrorDto> {
    state.exigir_rol(&[ADMIN]).await?;
    let db = {
        let guard = state.db.lock().await;
        guard.as_ref().cloned().ok_or_else(|| {
            AppErrorDto::internal("Las anomalías sólo existen en el TPV principal")
        })?
    };
    Ok(tpv_infra_sqlite::verifactu::reconocer_anomalias(&db).await?)
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

/// Emite una **factura completa en sustitución** de los tickets de unos cobros (`F3`,
/// FISCAL-02): uno, o varios del mismo cliente en una sola factura.
///
/// Es el camino del cliente que vuelve con el ticket —o con los de un periodo— y pide factura. Los
/// tickets **no se tocan**: canjearlos por una completa no es rectificarlos (art. 15.6 ROF), así
/// que se emite una `F3` que los sustituye y que sí lleva destinatario.
///
/// Es de Administrador, como el resto de Cuentas: emite un documento fiscal nuevo.
#[tauri::command]
pub async fn verifactu_emitir_factura_de_tickets(
    state: State<'_, AppState>,
    id_pagos: Vec<String>,
    destinatario: tpv_contracts::verifactu::DestinatarioInput,
) -> Result<BloqueFiscal, AppErrorDto> {
    state.exigir_rol(&[ADMIN]).await?;
    let repo = state.verifactu_repo().await?;
    Ok(uc::emitir_sustitutiva(repo.as_ref(), &id_pagos, destinatario).await?)
}

/// Corrige los datos del cliente de una factura completa ya expedida (una `F3` o una `F1`).
/// Devuelve la factura nueva, que es la que se imprime. Administrador, como emitirla.
#[tauri::command]
pub async fn verifactu_corregir_factura(
    state: State<'_, AppState>,
    num_factura: String,
    destinatario: tpv_contracts::verifactu::DestinatarioInput,
) -> Result<BloqueFiscal, AppErrorDto> {
    state.exigir_rol(&[ADMIN]).await?;
    let repo = state.verifactu_repo().await?;
    Ok(uc::corregir_factura(repo.as_ref(), &num_factura, destinatario).await?)
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
    let estado = uc::estado(repo.as_ref()).await?;
    let entorno = if estado.entorno_pruebas {
        EntornoAeat::Pruebas
    } else {
        EntornoAeat::Produccion
    };

    // Con los datos del obligado ya configurados, la prueba comprueba ADEMÁS que el titular del
    // certificado esté autorizado sobre ese NIF. Es lo otro que puede tumbar un envío real, y así
    // sale con el usuario delante en vez de con la primera venta. Sigue sin enviar ningún registro.
    let obligado = match (estado.nif.as_deref(), estado.razon_social.as_deref()) {
        (Some(nif), Some(razon)) if !nif.trim().is_empty() && !razon.trim().is_empty() => {
            Some(tpv_application::ports::aeat::CabeceraEnvio {
                nif_obligado: nif.trim().to_uppercase(),
                nombre_razon_obligado: razon.trim().to_string(),
                incidencia: false,
            })
        }
        _ => None,
    };

    Ok(AeatAdapter::new()
        .probar_conexion(entorno, &h, obligado.as_ref())
        .await?)
}
// ─────────────────────────────────────────────────────────────────────────────
// Exportación (art. 8 RRSIF) y declaración responsable (art. 13 RRSIF)
// ─────────────────────────────────────────────────────────────────────────────

/// Genera el ZIP con los registros de facturación de un rango.
///
/// Es una **obligación del sistema**, no una comodidad: el art. 8 RRSIF exige que el SIF pueda
/// exportar sus registros, y un inspector puede pedirlo. El ZIP lleva cuatro ficheros y el que lo
/// justifica es `cadena.txt`: con la cadena exacta que se hasheó de cada registro, **un tercero
/// verifica la integridad entera con un SHA-256 y sin nuestro código**.
///
/// El destino lo elige el usuario (`destino` es una ruta absoluta, fuera de AppData), como en las
/// copias de seguridad. Devuelve cuántos registros entraron — un rango vacío no es un error.
#[tauri::command]
pub async fn verifactu_exportar(
    app: AppHandle,
    state: State<'_, AppState>,
    destino: String,
    desde: String,
    hasta: String,
) -> Result<usize, AppErrorDto> {
    state.exigir_rol(&[ADMIN]).await?;

    // Se lee de la BD directamente y no por el repositorio: exportar es de las cosas que se piden
    // justo cuando algo va mal, así que no se apoya en nada más que en leer filas.
    let db = {
        let guard = state.db.lock().await;
        guard.as_ref().cloned().ok_or_else(|| {
            AppErrorDto::internal("Los registros de facturación sólo existen en el TPV principal")
        })?
    };

    // El contexto del manifiesto: quién factura, con qué sistema y en qué entorno.
    let estado = uc::estado(state.verifactu_repo().await?.as_ref()).await?;
    let ctx = tpv_infra_sqlite::verifactu_export::ContextoExport {
        nif: estado.nif.clone().unwrap_or_default(),
        razon_social: estado.razon_social.clone().unwrap_or_default(),
        version_sistema: app.package_info().version.to_string(),
        nombre_sistema: crate::PRODUCTOR_NOMBRE_SISTEMA.to_string(),
        id_sistema: crate::PRODUCTOR_ID_SISTEMA.to_string(),
        nif_productor: crate::PRODUCTOR_NIF.to_string(),
        nombre_productor: crate::PRODUCTOR_NOMBRE_RAZON.to_string(),
        entorno: if estado.entorno_pruebas {
            "pruebas".to_string()
        } else {
            "produccion".to_string()
        },
    };

    Ok(tpv_infra_sqlite::verifactu_export::exportar(
        &db,
        std::path::Path::new(&destino),
        &desde,
        &hasta,
        &ctx,
    )
    .await?)
}

/// La **declaración responsable** del productor del software (art. 13 RRSIF).
///
/// > *«Los sistemas informáticos […] deberán incluir una declaración responsable […] que podrá
/// > figurar en el propio sistema informático, visible en cada una de sus versiones»*.
///
/// O sea que no basta con tenerla en un PDF: tiene que poder verse **desde dentro del programa**, y
/// con la versión delante. Esto es lo que alimenta esa pantalla.
///
/// Sin exigir rol: la declaración es pública por definición — su objeto es que cualquiera pueda
/// leerla, incluido un inspector que se siente en la barra.
#[tauri::command]
pub async fn verifactu_declaracion_responsable(
    app: AppHandle,
) -> Result<DeclaracionResponsableDto, AppErrorDto> {
    Ok(DeclaracionResponsableDto {
        productor_nombre_razon: crate::PRODUCTOR_NOMBRE_RAZON.to_string(),
        productor_nif: crate::PRODUCTOR_NIF.to_string(),
        nombre_sistema: crate::PRODUCTOR_NOMBRE_SISTEMA.to_string(),
        id_sistema: crate::PRODUCTOR_ID_SISTEMA.to_string(),
        version: app.package_info().version.to_string(),
        // ⚠️ El texto es un borrador y necesita el NIF y la razón social definitivos del productor
        // (`docs/pendientes.md`, Veri*factu). Lo que NO puede es salir en blanco sin decirlo:
        // una pantalla vacía donde la ley exige una declaración se lee como que la hay.
        texto: if crate::PRODUCTOR_NIF.trim().is_empty() {
            String::new()
        } else {
            TEXTO_DECLARACION.to_string()
        },
        completa: !crate::PRODUCTOR_NIF.trim().is_empty(),
    })
}

/// La declaración responsable tal como la enseña la pantalla.
#[derive(Debug, Clone, serde::Serialize)]
pub struct DeclaracionResponsableDto {
    pub productor_nombre_razon: String,
    pub productor_nif: String,
    pub nombre_sistema: String,
    pub id_sistema: String,
    pub version: String,
    pub texto: String,
    /// `false` mientras falten los datos definitivos del productor. La pantalla lo dice en vez de
    /// enseñar una declaración a medias, que sería peor que no enseñar ninguna.
    pub completa: bool,
}

/// Texto de la declaración responsable.
///
/// ⚠️ **Borrador.** Recoge lo que el art. 13 RRSIF exige declarar, pero hay que revisarlo con la
/// empresa constituida y, si procede, con un asesor: es una declaración con consecuencias.
const TEXTO_DECLARACION: &str = "\
Declaración responsable (art. 13 del Real Decreto 1007/2023)

El productor de este sistema informático de facturación declara, bajo su responsabilidad, que el \
sistema cumple lo dispuesto en el Real Decreto 1007/2023, de 5 de diciembre, y en su normativa de \
desarrollo (Orden HAC/1177/2024), y en particular que:

· Produce un registro de facturación de alta por cada factura expedida, de forma simultánea o \
inmediatamente anterior a su expedición.
· Encadena cada registro con el inmediatamente anterior mediante una huella o «hash» SHA-256, \
calculada conforme a las especificaciones publicadas por la Agencia Estatal de Administración \
Tributaria.
· Conserva los registros de facturación sin que puedan ser modificados ni eliminados, y permite su \
exportación.
· Funciona exclusivamente como «Sistema de emisión de facturas verificables» (VERI*FACTU), \
remitiendo a la Agencia Estatal de Administración Tributaria todos los registros de facturación \
generados.
· Incluye en cada factura el código «QR» y la leyenda exigidos por los artículos 20 y 21 de la \
Orden HAC/1177/2024.
· No permite la llevanza de contabilidades, registros o cuentas distintas de las declaradas, ni la \
ocultación o alteración de operaciones.";
