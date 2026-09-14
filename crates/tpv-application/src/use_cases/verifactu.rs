//! Casos de uso de **Veri\*factu** (FISCAL-01).
//!
//! Son finos a propósito: la aritmética está en `tpv-domain` y la emisión ocurre **dentro de la
//! transacción del cobro**, en el repositorio, porque ahí es donde está la transacción. Lo que
//! queda aquí son las lecturas —el panel, el bloque para imprimir— y la orquestación de lo que no
//! puede vivir dentro de una transacción.

use crate::error::AppResult;
use crate::ports::aeat::{AeatClient, CabeceraEnvio, EntornoAeat};
use crate::ports::verifactu::VerifactuRepository;
use crate::error::AppError;
use tpv_contracts::verifactu::{
    BloqueFiscal, DestinatarioInput, EstadoFiscal, RegistroFiscal,
};

/// El bloque fiscal de un ticket ya emitido. Sirve igual para imprimir y para reimprimir.
pub async fn bloque_por_numero(
    repo: &dyn VerifactuRepository,
    num_serie_factura: &str,
) -> AppResult<Option<BloqueFiscal>> {
    let n = num_serie_factura.trim();
    if n.is_empty() {
        // Una precuenta no lleva número, y no llevar número es lo correcto: no es una factura, así
        // que no tiene registro ni QR. Devolver `None` en vez de un error es lo que permite que la
        // impresión de la precuenta comparta camino con la del ticket.
        return Ok(None);
    }
    repo.bloque_por_numero(n).await
}

/// Resumen del estado fiscal: datos del obligado, cola de envío y escalón de aviso.
pub async fn estado(repo: &dyn VerifactuRepository) -> AppResult<EstadoFiscal> {
    repo.estado().await
}

// ─────────────────────────────────────────────────────────────────────────────
// El certificado: lo que la capa de datos no puede saber
// ─────────────────────────────────────────────────────────────────────────────

/// Lo que el shell averigua del certificado elegido mirando el almacén de Windows.
///
/// `estado_fiscal` (infra-sqlite) no puede rellenarlo: el almacén no está en la base de datos. Antes
/// esto se resolvía dejando los campos en «no se puede remitir» con un comentario que decía que los
/// rellenaría «la capa que conoce el almacén de certificados» — y esa capa no existía, así que eran
/// dos campos muertos y el panel nunca podía decir «no hay certificado» ni «caduca en 12 días».
#[derive(Debug, Clone, Default)]
pub struct EstadoCertificado {
    /// ¿Hay una huella guardada en `device_config.json`?
    pub elegido: bool,
    /// ¿Y esa huella sigue estando en el almacén? Un certificado renovado cambia de huella, así que
    /// **esto se pone a `false` solo** el día que alguien reinstala el suyo.
    pub encontrado: bool,
    /// Días que faltan para que caduque. Negativo si ya caducó. `None` si no se ha encontrado.
    pub dias_para_caducar: Option<i64>,
    /// ¿Se puede usar sin que Windows pida un PIN o una contraseña?
    pub uso_silencioso: bool,
}

/// A partir de cuántos días de margen se empieza a avisar de que el certificado caduca.
///
/// Un mes es lo que tarda una gestoría en renovar sin prisa. Menos deja al bar con el problema
/// encima; más convierte el aviso en parte del paisaje once meses al año.
pub const DIAS_AVISO_CADUCIDAD: i64 = 30;

/// Cuando quedan menos de esto, el aviso sube a error: ya no es «acuérdate», es «hazlo».
pub const DIAS_CADUCIDAD_URGENTE: i64 = 7;

/// Clave de dedupe del aviso del certificado. Una sola, como la del atraso y por lo mismo: lo que
/// cambia entre «caduca en tres semanas» y «caducó» es el texto, no el hecho.
pub const CLAVE_CERTIFICADO: &str = "verifactu_certificado";

/// Completa el estado fiscal con lo que sólo el shell sabe.
///
/// **No pisa un `motivo_no_remite` que ya venga puesto.** Los que pone la capa de datos —faltan los
/// datos fiscales del negocio, falta la identidad del productor— van antes a propósito: el primero
/// impide cobrar, así que el usuario lo tiene delante de todos modos, y el segundo es un fallo
/// nuestro. Decirle «no hay certificado» a quien todavía no puede ni abrir la persiana es mandarlo a
/// resolver el tercer problema de la lista.
pub fn completar_con_el_certificado(estado: &mut EstadoFiscal, cert: &EstadoCertificado) {
    estado.dias_para_caducar_certificado = cert.dias_para_caducar;

    let caducado = cert.dias_para_caducar.is_some_and(|d| d < 0);
    estado.certificado_ok =
        cert.elegido && cert.encontrado && !caducado && cert.uso_silencioso;

    if estado.motivo_no_remite.is_some() {
        return;
    }

    estado.motivo_no_remite = if !cert.elegido {
        Some("sin_certificado".to_string())
    } else if !cert.encontrado {
        // El caso que más despista: el certificado ESTABA y ya no. Pasa al renovarlo (la huella
        // cambia) y al usar el TPV desde otra sesión de Windows, porque el almacén es por usuario.
        Some("certificado_no_encontrado".to_string())
    } else if caducado {
        Some("certificado_caducado".to_string())
    } else if !cert.uso_silencioso {
        // No impide *intentarlo*, pero el intento no va a terminar nunca sin alguien delante. Contar
        // esto como «se puede remitir» es lo que deja la cola creciendo sin que nada lo explique.
        Some("certificado_pide_pin".to_string())
    } else {
        None
    };
}

/// Emite (o cierra) el aviso del **certificado**: que falta, que ya no está, que caducó o que le
/// queda poco.
///
/// Es un aviso distinto del atraso y va aparte a propósito. El del atraso llega **tarde por
/// definición**: mide horas de cola, así que para cuando salta ya se ha dejado de remitir. Este
/// llega **antes de que pase nada**, que es el único momento en que renovar un certificado es un
/// trámite y no una urgencia.
pub async fn avisar_del_certificado(
    notifier: &dyn crate::ports::notificaciones::Notifier,
    cert: &EstadoCertificado,
) -> AppResult<bool> {
    use tpv_domain::notificaciones::{Destino, NuevaNotificacion, Severidad, ADMIN_ROL_ID};

    let dias = cert.dias_para_caducar;
    let caducado = dias.is_some_and(|d| d < 0);

    let (severidad, titulo, cuerpo) = if !cert.elegido {
        // Sin certificado elegido no se avisa desde aquí: es parte de la puesta en marcha y el panel
        // ya lo dice. Un TPV recién instalado no necesita una notificación de algo que todavía no ha
        // configurado nadie.
        let _ = notifier.resolver_por_clave(CLAVE_CERTIFICADO).await;
        return Ok(false);
    } else if !cert.encontrado {
        (
            Severidad::Error,
            "El certificado para enviar a Hacienda ya no está".to_string(),
            "El certificado que tenías elegido no aparece en el almacén de Windows. Pasa al \
             renovarlo —el nuevo tiene otra huella y hay que volver a elegirlo— y al entrar con otro \
             usuario de Windows, porque el almacén es de cada uno. Mientras tanto no se envía \
             ninguna factura. Configuración → Fiscal."
                .to_string(),
        )
    } else if caducado {
        (
            Severidad::Error,
            "El certificado para enviar a Hacienda ha caducado".to_string(),
            "No se está enviando ninguna factura. Las que se emitan se guardan y saldrán solas en \
             cuanto instales el certificado renovado y lo elijas en Configuración → Fiscal."
                .to_string(),
        )
    } else if !cert.uso_silencioso {
        (
            Severidad::Aviso,
            "El certificado pide una contraseña en cada envío".to_string(),
            "Así no se puede enviar solo: el envío se queda esperando a que alguien la escriba. Si \
             es un fichero .p12, vuelve a importarlo SIN marcar «protección alta»; si es un PIN de \
             tarjeta o del DNIe, hace falta otro certificado."
                .to_string(),
        )
    } else if dias.is_some_and(|d| d <= DIAS_CADUCIDAD_URGENTE) {
        (
            Severidad::Error,
            format!(
                "El certificado de Hacienda caduca en {} día(s)",
                dias.unwrap_or(0)
            ),
            "Cuando caduque se dejarán de enviar facturas. Renuévalo con tu gestoría e instálalo en \
             este equipo antes de esa fecha."
                .to_string(),
        )
    } else if dias.is_some_and(|d| d <= DIAS_AVISO_CADUCIDAD) {
        (
            Severidad::Aviso,
            format!(
                "El certificado de Hacienda caduca en {} día(s)",
                dias.unwrap_or(0)
            ),
            "Todavía hay tiempo, y por eso se avisa ahora: renovarlo con margen es un trámite, y el \
             día que caduca es una urgencia que para los envíos."
                .to_string(),
        )
    } else {
        let _ = notifier.resolver_por_clave(CLAVE_CERTIFICADO).await;
        return Ok(false);
    };

    let _ = notifier
        .emitir(NuevaNotificacion {
            tipo: "verifactu_certificado".to_string(),
            severidad,
            titulo,
            cuerpo: Some(cuerpo),
            destino: Destino::Rol(ADMIN_ROL_ID.to_string()),
            accion: Some("ver_fiscal".to_string()),
            payload: None,
            clave_dedupe: Some(CLAVE_CERTIFICADO.to_string()),
            expira_en: None,
        })
        .await;

    Ok(true)
}

/// Clave de dedupe del aviso por anomalías de la cadena.
pub const CLAVE_ANOMALIA: &str = "verifactu_anomalia";

/// Emite (o cierra) el aviso por **anomalías de la cadena** detectadas por la comprobación previa
/// del art. 7.i).
///
/// Es el tercer aviso fiscal y el más raro de los tres: los otros dos hablan de cosas que pasan en el
/// curso normal —una cola que crece, un certificado que caduca—, y éste sólo salta si el reloj del
/// equipo se ha movido hacia atrás o si alguien ha tocado la cadena por debajo. Precisamente por eso
/// no puede quedarse en un registro de diagnóstico que nadie abre.
///
/// **No lleva escalón.** A diferencia del atraso, aquí no hay un «todavía es pronto»: una cadena rota
/// no mejora esperando.
pub async fn avisar_de_anomalias(
    notifier: &dyn crate::ports::notificaciones::Notifier,
    sin_reconocer: i64,
    ultimo_mensaje: Option<&str>,
) -> AppResult<bool> {
    use tpv_domain::notificaciones::{Destino, NuevaNotificacion, Severidad, ADMIN_ROL_ID};

    if sin_reconocer <= 0 {
        let _ = notifier.resolver_por_clave(CLAVE_ANOMALIA).await;
        return Ok(false);
    }

    let detalle = ultimo_mensaje.unwrap_or("").trim();
    let cuerpo = if detalle.is_empty() {
        "Revisa Configuración → Fiscal.".to_string()
    } else {
        format!(
            "Lo último detectado: {detalle}. Las facturas se siguen emitiendo y enviando con \
             normalidad —esto no para la caja—, pero conviene mirarlo: revisa la hora del equipo y \
             avisa a soporte. Configuración → Fiscal."
        )
    };

    let _ = notifier
        .emitir(NuevaNotificacion {
            tipo: "verifactu_anomalia".to_string(),
            severidad: Severidad::Error,
            titulo: if sin_reconocer == 1 {
                "Se ha detectado una anomalía en la cadena de facturación".to_string()
            } else {
                format!("Se han detectado {sin_reconocer} anomalías en la cadena de facturación")
            },
            cuerpo: Some(cuerpo),
            destino: Destino::Rol(ADMIN_ROL_ID.to_string()),
            accion: Some("ver_fiscal".to_string()),
            payload: None,
            clave_dedupe: Some(CLAVE_ANOMALIA.to_string()),
            expira_en: None,
        })
        .await;

    Ok(true)
}

/// Clave de dedupe del aviso por atraso. Una sola, a propósito: lo que cambia con los escalones es
/// la severidad y el texto, no el hecho. Con una clave por escalón, subir de peldaño dejaría el
/// anterior abierto y el centro de notificaciones acumularía tres avisos de lo mismo.
pub const CLAVE_ATRASO: &str = "verifactu_atraso";

/// Emite (o cierra) el aviso por **atraso en la remisión**, según el escalón.
///
/// ## Por qué esto existe aparte del panel
///
/// La obligación de remitir es del bar, y un panel que hay que abrir para enterarse no informa a
/// nadie: el día que el atraso importa es justo el día en que nadie está mirando Configuración →
/// Fiscal. El escalón `visible` se queda en el panel a propósito —una hora de cola es
/// funcionamiento normal, incluso con fibra— y a partir de **6 horas** el aviso sale a buscar al
/// administrador.
///
/// ## Y se CIERRA solo
///
/// Cuando la cola se vacía (o baja del escalón), el aviso se resuelve. Un aviso que hay que
/// descartar a mano después de que el problema se arregle enseña a descartar avisos, que es lo
/// contrario de lo que esto busca.
pub async fn avisar_de_atraso(
    repo: &dyn VerifactuRepository,
    notifier: &dyn crate::ports::notificaciones::Notifier,
) -> AppResult<bool> {
    use tpv_domain::notificaciones::{Destino, NuevaNotificacion, Severidad, ADMIN_ROL_ID};

    let e = repo.estado().await?;

    // Sin datos fiscales no hay nada que remitir todavía, y el panel ya lo dice con un mensaje mucho
    // más útil («mientras falten, no se puede cobrar»). Avisar aquí sería decir dos veces lo mismo
    // por dos caminos distintos.
    if !e.datos_fiscales_completos {
        let _ = notifier.resolver_por_clave(CLAVE_ATRASO).await;
        return Ok(false);
    }

    // Cuando lo que impide remitir es un fallo NUESTRO, el texto cambia entero. Un bar al que se le
    // dice «revisa la conexión y el certificado» por algo que él no puede tocar pierde una tarde y
    // acaba desconfiando del aviso — que es el único que no puede permitirse ignorar.
    //
    // Lo que NO cambia es la puerta: sigue mandando el escalón. Un fallo nuestro con la cola vacía
    // no es nada que contarle a nadie, y avisar ahí sería avisar de que no pasa nada.
    let culpa_nuestra = e.motivo_no_remite.as_deref() == Some("sin_datos_del_productor");

    let (severidad, titulo, cuerpo) = match e.escalon_aviso.as_str() {
        "notificacion" | "modal_login" | "modal_cobro" if culpa_nuestra => (
            Severidad::Error,
            "No se están enviando las facturas a Hacienda".to_string(),
            "Es un problema de este programa, no de tu equipo ni de tu conexión: le falta un dato \
             identificativo del fabricante. Las facturas están emitidas y guardadas —no se ha \
             perdido ninguna— y se enviarán solas en cuanto se actualice el programa. Avisa a \
             soporte para que te confirmen cuándo."
                .to_string(),
        ),
        "notificacion" => (
            Severidad::Aviso,
            "Hay facturas sin enviar a Hacienda".to_string(),
            "Llevan más de 6 horas en cola. El registro se emite sin conexión y no se pierde nada, \
             pero hay que remitirlo: revisa la conexión y el certificado en Configuración → Fiscal."
                .to_string(),
        ),
        "modal_login" => (
            Severidad::Error,
            "Llevas más de un día sin enviar facturas a Hacienda".to_string(),
            "Esto ya no se arregla solo. Comprueba la conexión y que el certificado siga siendo \
             válido en Configuración → Fiscal; si no sabes por dónde empezar, llama a soporte."
                .to_string(),
        ),
        "modal_cobro" => (
            Severidad::Error,
            "Llevas más de TRES DÍAS sin enviar facturas a Hacienda".to_string(),
            "Un equipo al que se le pone internet cada tres días para soltar el atraso no es un \
             sistema VERI*FACTU. Hay que resolverlo hoy: Configuración → Fiscal, o soporte."
                .to_string(),
        ),
        // `ninguno` y `visible`: nada que avisar, y si había un aviso de antes se cierra.
        _ => {
            let _ = notifier.resolver_por_clave(CLAVE_ATRASO).await;
            return Ok(false);
        }
    };

    let _ = notifier
        .emitir(NuevaNotificacion {
            tipo: "verifactu_atraso".to_string(),
            severidad,
            titulo,
            cuerpo: Some(cuerpo),
            // Al Administrador y no a todos: el camarero no puede hacer nada con esto, y un aviso
            // que no se puede accionar es ruido que entrena a ignorar el centro de notificaciones.
            destino: Destino::Rol(ADMIN_ROL_ID.to_string()),
            accion: Some("ver_fiscal".to_string()),
            payload: None,
            clave_dedupe: Some(CLAVE_ATRASO.to_string()),
            expira_en: None,
        })
        .await;

    Ok(true)
}

/// Los registros del panel.
pub async fn listar(
    repo: &dyn VerifactuRepository,
    limite: Option<i64>,
    desplazamiento: Option<i64>,
) -> AppResult<Vec<RegistroFiscal>> {
    repo.listar(limite.unwrap_or(100), desplazamiento.unwrap_or(0))
        .await
}

/// Emite una factura completa en sustitución de un ticket (`F3`, FISCAL-02).
///
/// Los datos del cliente se validan en el repositorio, justo antes de emitir: un NIF con el dígito
/// de control mal no se rechaza al enviar, vuelve como error admisible 2001 horas después.
pub async fn emitir_sustitutiva(
    repo: &dyn VerifactuRepository,
    num_serie_original: &str,
    destinatario: DestinatarioInput,
) -> AppResult<BloqueFiscal> {
    let n = num_serie_original.trim();
    if n.is_empty() {
        return Err(AppError::validation(
            "Hace falta el número del ticket que se quiere facturar.",
        ));
    }
    repo.emitir_sustitutiva(
        n,
        tpv_domain::verifactu::Destinatario {
            nombre_razon: destinatario.nombre_razon,
            nif: destinatario.nif,
            direccion: destinatario.domicilio,
        },
    )
    .await
}

// ─────────────────────────────────────────────────────────────────────────────
// Clasificación de las respuestas de la AEAT
// ─────────────────────────────────────────────────────────────────────────────

/// En qué queda un registro tras un envío.
///
/// **Ninguno de estos estados bloquea la aplicación.** El peor caso —un bug nuestro que hace que la
/// AEAT rechace todo— se traduce en una cola creciente, un panel en rojo y una notificación; nunca
/// en una caja que no cobra. Es también la razón de que el envío no viva dentro de la transacción
/// del cobro.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EstadoEnvio {
    /// Está en la AEAT y correcto. Fin.
    Aceptado,
    /// **Está en la AEAT**, pero hay que subsanarlo. No se reenvía igual: se corrige y se manda una
    /// subsanación. Sale en el panel como pendiente de arreglar.
    AceptadoConErrores,
    /// **No** está en la AEAT. Se subsana con `Subsanacion=S` + `RechazoPrevio=X`.
    Rechazado,
    /// Sigue pendiente: el envío no llegó a procesarse (fallo de transporte). Se reintenta solo.
    Pendiente,
}

impl EstadoEnvio {
    pub fn wire(self) -> &'static str {
        match self {
            EstadoEnvio::Aceptado => "ACEPTADO",
            EstadoEnvio::AceptadoConErrores => "ACEPTADO_CON_ERRORES",
            EstadoEnvio::Rechazado => "RECHAZADO",
            EstadoEnvio::Pendiente => "PENDIENTE",
        }
    }
}

/// Código de «registro de facturación duplicado».
///
/// Es el que hace que el envío sea **idempotente**: si un lote se manda dos veces (porque el TPV se
/// apagó entre el envío y el guardado del resultado), la segunda vuelve con este código y se trata
/// como aceptado. Sin eso, un corte de luz en el momento justo dejaría registros reintentándose
/// para siempre contra una AEAT que ya los tiene.
pub const COD_DUPLICADO: i64 = 3000;

/// Rango de los **errores admisibles**: el registro se acepta y se registra, pero hay que
/// subsanarlo. Son los 2000-2008 del catálogo de la AEAT (`errores.properties`).
///
/// Se clasifica **por rango y no por lista** a propósito: el catálogo lo publica la AEAT y crece.
/// Una lista cerrada trataría un código nuevo del rango como un rechazo, y reintentaría para
/// siempre un registro que la AEAT ya tiene guardado.
pub const RANGO_ADMISIBLES: std::ops::RangeInclusive<i64> = 2000..=2999;

/// Los dos errores admisibles que **están exceptuados de subsanar**.
///
/// - `2004`: la `FechaHoraHusoGenRegistro` va por delante del reloj de la AEAT. El reloj del equipo
///   del bar puede ir adelantado y nadie ha hecho nada mal. No hay que corregirlo, pero sí hay que
///   **no asustarse** al verlo en el panel.
/// - El de `ClaveRegimen` sin informar con IPSI, que no nos toca (Ceuta y Melilla están fuera de
///   alcance).
pub const ADMISIBLES_SIN_SUBSANAR: [i64; 1] = [2004];

/// Clasifica **una línea** de la respuesta.
///
/// Esto es lo que decide si un fallo nuestro se convierte en un bar parado o en una fila de un
/// panel, así que vive aquí —en el caso de uso, puro y con tests— y no en el adaptador, que sólo
/// transcribe lo que dijo la AEAT.
pub fn clasificar(estado_registro: &str, codigo_error: Option<i64>) -> EstadoEnvio {
    match estado_registro.trim() {
        "Correcto" => EstadoEnvio::Aceptado,
        "AceptadoConErrores" => EstadoEnvio::AceptadoConErrores,
        "Incorrecto" => match codigo_error {
            // Ya lo teníamos allí: es la idempotencia del envío.
            Some(COD_DUPLICADO) => EstadoEnvio::Aceptado,
            // Un código del rango admisible con estado «Incorrecto» no debería llegar, pero si
            // llega hay que creer al CÓDIGO: dice que el registro se guardó.
            Some(c) if RANGO_ADMISIBLES.contains(&c) => EstadoEnvio::AceptadoConErrores,
            _ => EstadoEnvio::Rechazado,
        },
        // Un estado que este cliente no conoce (una versión nueva del servicio) NO se da por bueno:
        // se deja pendiente y se reintenta. Darlo por aceptado sería dejar de remitir en silencio,
        // que es la única forma de romper esto de verdad.
        _ => EstadoEnvio::Pendiente,
    }
}

/// ¿Este registro hay que subsanarlo?
///
/// Se usa para pintar el panel: un `AceptadoConErrores` normal pide acción, y los dos exceptuados
/// no. La subsanación **no puede ser automática** — si el TPV corrige y reenvía solo, un error
/// sistemático nuestro se convierte en dos registros malos por venta en vez de uno.
pub fn hay_que_subsanar(estado: EstadoEnvio, codigo_error: Option<i64>) -> bool {
    match estado {
        EstadoEnvio::AceptadoConErrores => !codigo_error
            .map(|c| ADMISIBLES_SIN_SUBSANAR.contains(&c))
            .unwrap_or(false),
        EstadoEnvio::Rechazado => true,
        _ => false,
    }
}

/// Cómo se subsana un registro, según dónde esté.
///
/// Las combinaciones salen del anexo *«Operativas de alta y anulación admisibles»* del documento de
/// validaciones, y **no son intercambiables**: mandar `RechazoPrevio=X` cuando el registro sí existe
/// en la AEAT es el ERROR (2) de ese cuadro, y omitirlo cuando no existe es el ERROR (3).
///
/// Devuelve `(Subsanacion, RechazoPrevio)`.
pub fn marcas_de_subsanacion(estado_previo: EstadoEnvio) -> (Option<&'static str>, Option<&'static str>) {
    match estado_previo {
        // El registro ESTÁ en la AEAT (aceptado, con o sin errores): «alta de subsanación».
        EstadoEnvio::Aceptado | EstadoEnvio::AceptadoConErrores => (Some("S"), None),
        // El registro NO está: «alta por rechazo».
        EstadoEnvio::Rechazado => (Some("S"), Some("X")),
        // Un pendiente no se subsana: se reintenta tal cual. No hay nada que corregir todavía.
        EstadoEnvio::Pendiente => (None, None),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Control de flujo (art. 16.2 de la Orden HAC/1177/2024)
// ─────────────────────────────────────────────────────────────────────────────

/// Máximo de registros por envío, del diseño de registro.
pub const MAX_POR_ENVIO: i64 = 1000;

/// ¿Se puede enviar ya?
///
/// La norma: *«para poder realizar el siguiente envío, el sistema informático deberá esperar a que
/// transcurran «t» segundos desde el anterior envío **o** deberá esperar a tener acumulados un
/// número de registros de facturación igual al límite establecido en el diseño de registro para
/// cada envío, **la circunstancia que ocurra primero**»*.
///
/// Es una función **pura**, como `proxima_espera` del runner de jobs, y por el mismo motivo: es una
/// política y las políticas se prueban.
///
/// `espera_s` es el `TiempoEsperaEnvio` que devolvió la AEAT en la última respuesta (60 al arrancar).
pub fn puede_enviar(
    ahora_ms: i64,
    ultimo_envio_ms: Option<i64>,
    espera_s: i64,
    pendientes: i64,
) -> bool {
    if pendientes <= 0 {
        return false;
    }
    // El tope de registros manda sobre el reloj: es el «lo que ocurra primero» de la norma.
    if pendientes >= MAX_POR_ENVIO {
        return true;
    }
    match ultimo_envio_ms {
        // Nunca se ha enviado: no hay nada que esperar.
        None => true,
        Some(ultimo) => {
            let espera = espera_s.max(0) * 1000;
            // Un reloj que retrocede (cambio de hora, sincronización NTP) dejaría `ahora` por
            // detrás del último envío y la resta sería negativa: bloquearía los envíos hasta que el
            // reloj alcanzara al valor guardado. Se trata como «ya ha pasado».
            ahora_ms < ultimo || ahora_ms - ultimo >= espera
        }
    }
}

/// El `TiempoEsperaEnvio` que hay que guardar tras una respuesta.
///
/// Si la AEAT no lo informa, se conserva el que había: inventarse uno (bajarlo) sería saltarse un
/// control de flujo que la norma impone, y subirlo mucho sería dejar de remitir «de forma
/// continuada». El valor se acota a un rango razonable porque un `0` dejaría al TPV martilleando el
/// servicio y un valor absurdo lo dejaría mudo un día entero.
pub fn espera_siguiente(devuelta: Option<i64>, actual: i64) -> i64 {
    match devuelta {
        Some(v) if v > 0 => v.clamp(1, 3600),
        _ => actual.clamp(1, 3600),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// El ciclo de remisión
// ─────────────────────────────────────────────────────────────────────────────

/// Por qué un ciclo no hizo nada. No son fallos: son las razones normales de no enviar.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SinEnviar {
    /// No hay nada pendiente. El caso normal en un bar con conexión.
    ColaVacia,
    /// El control de flujo del art. 16.2 todavía no lo permite.
    ControlDeFlujo,
    /// Faltan el NIF o la razón social del obligado. **No es un error del job**: es una tarea del
    /// dueño, y sale en el panel como tal.
    SinDatosFiscales,
    /// No hay certificado elegido. Igual que el anterior: una tarea, no una avería.
    SinCertificado,
}

/// Lo que hizo un ciclo de remisión.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResultadoCiclo {
    pub enviados: usize,
    pub aceptados: usize,
    pub aceptados_con_errores: usize,
    pub rechazados: usize,
}

/// Un ciclo de remisión: coge lo pendiente, lo manda y anota en qué quedó cada uno.
///
/// **No bloquea nada y no puede hacerlo.** Devuelve `Ok(Err(SinEnviar))` cuando no había nada que
/// hacer y `Err` sólo cuando el envío falló de verdad — que es lo que el runner de jobs traduce en
/// backoff y en una fila del panel. Ni una cosa ni la otra impide cobrar: el registro ya está
/// emitido y la cola crece hasta que se pueda drenar.
///
/// ## El orden importa y no es negociable
///
/// Se manda **por `Orden` ascendente** porque la AEAT valida cada registro contra su encadenamiento
/// anterior. Y se anota el resultado **registro a registro**, casando por número de factura y no
/// por posición: si la AEAT omitiera una línea de la respuesta, casar por índice desplazaría todos
/// los estados una posición y marcaría como aceptado un registro rechazado.
pub async fn remitir_ciclo(
    repo: &dyn VerifactuRepository,
    aeat: &dyn AeatClient,
    huella_certificado: Option<&str>,
    ahora_ms: i64,
) -> AppResult<Result<ResultadoCiclo, SinEnviar>> {
    let pendientes = repo.contar_pendientes().await?;
    if pendientes == 0 {
        return Ok(Err(SinEnviar::ColaVacia));
    }

    let Some((nif, razon, es_pruebas)) = repo.obligado().await? else {
        return Ok(Err(SinEnviar::SinDatosFiscales));
    };
    let Some(huella) = huella_certificado.map(str::trim).filter(|h| !h.is_empty()) else {
        return Ok(Err(SinEnviar::SinCertificado));
    };

    let (espera_s, ultimo_envio_ms) = repo.flujo().await?;
    if !puede_enviar(ahora_ms, ultimo_envio_ms, espera_s, pendientes) {
        return Ok(Err(SinEnviar::ControlDeFlujo));
    }

    let lote = repo.pendientes(MAX_POR_ENVIO).await?;
    if lote.is_empty() {
        return Ok(Err(SinEnviar::ColaVacia));
    }

    // `Incidencia = "S"` cuando esto llega tarde. El criterio es la propia cola: si hay más de un
    // lote acumulado, o si el registro más antiguo lleva esperando más de una hora, el envío no
    // pudo ser inmediato y la norma tiene un campo para decirlo. Usarlo es mejor que no usarlo.
    let incidencia = pendientes > MAX_POR_ENVIO
        || ultimo_envio_ms.is_some_and(|u| ahora_ms.saturating_sub(u) > 3_600_000);

    let cabecera = CabeceraEnvio {
        nif_obligado: nif,
        nombre_razon_obligado: razon,
        incidencia,
    };
    let entorno = if es_pruebas {
        EntornoAeat::Pruebas
    } else {
        EntornoAeat::Produccion
    };

    let ids: Vec<String> = lote.iter().map(|r| r.id_registro.clone()).collect();

    let respuesta = match aeat.remitir(entorno, huella, &cabecera, &lote).await {
        Ok(r) => r,
        Err(e) => {
            // Fallo de transporte, o un Fault que rechazó el envío entero. Los registros siguen
            // PENDIENTE: no sabemos si la AEAT los tiene, y darlos por perdidos sería tan malo como
            // darlos por buenos. Lo que sí se anota es el intento.
            repo.marcar_intento(&ids).await?;
            return Err(e);
        }
    };

    // El control de flujo se guarda ANTES de procesar las líneas, y con el instante del envío: si
    // el TPV se apaga a mitad del procesado, lo que no puede pasar es que al arrancar crea que
    // nunca envió y se salte la espera que impone la norma.
    repo.guardar_flujo(
        espera_siguiente(respuesta.tiempo_espera_envio, espera_s),
        ahora_ms,
    )
    .await?;

    let mut r = ResultadoCiclo {
        enviados: lote.len(),
        aceptados: 0,
        aceptados_con_errores: 0,
        rechazados: 0,
    };

    for enviado in &lote {
        // Se casa por **tipo y número**, no por posición. Ver la nota de arriba.
        //
        // El tipo no es un extra: un registro de anulación lleva el MISMO `NumSerieFactura` que el
        // alta que anula, y los dos pueden ir en el mismo envío — basta cobrar por error y anular
        // dentro del mismo ciclo. Casando
        // sólo por número, `find` devuelve la primera de las dos líneas para ambos registros.
        //
        // Lo que eso rompe no se ve: si la AEAT acepta el alta y rechaza la anulación, la anulación
        // queda anotada como ACEPTADA. Y como `pendientes()` sólo coge los `PENDIENTE` y
        // `subsanar_rechazados` sólo los `RECHAZADO`, esa anulación no se reintenta jamás: la
        // factura sigue viva para Hacienda y el panel dice que todo salió bien.
        let es_anulacion = enviado.tipo.eq_ignore_ascii_case("ANULACION");
        let Some(linea) = respuesta
            .lineas
            .iter()
            .find(|l| l.anulacion == es_anulacion && l.num_serie_factura == enviado.num_serie_factura)
        else {
            // La AEAT no dijo nada de este registro. Se queda PENDIENTE y se reintenta: es
            // exactamente el caso en el que no se puede suponer nada.
            repo.marcar_intento(std::slice::from_ref(&enviado.id_registro))
                .await?;
            continue;
        };

        let estado = clasificar(&linea.estado, linea.codigo_error);
        match estado {
            EstadoEnvio::Aceptado => r.aceptados += 1,
            EstadoEnvio::AceptadoConErrores => r.aceptados_con_errores += 1,
            EstadoEnvio::Rechazado => r.rechazados += 1,
            EstadoEnvio::Pendiente => {}
        }

        repo.marcar_resultado(
            &enviado.id_registro,
            estado.wire(),
            linea.codigo_error,
            linea.descripcion_error.as_deref(),
            // El CSV es del ENVÍO, no de la línea, y hay que guardarlo en el momento del alta: no
            // se puede recuperar con una consulta posterior. Se guarda en cada registro aceptado
            // del lote, que es donde alguien lo va a buscar.
            if matches!(estado, EstadoEnvio::Aceptado | EstadoEnvio::AceptadoConErrores) {
                respuesta.csv.as_deref()
            } else {
                None
            },
        )
        .await?;
    }

    Ok(Ok(r))
}

#[cfg(test)]
// Los nombres de estos tests usan MAYUSCULAS para enfatizar la afirmacion que fijan
// (`..._NO_gasta_numero`, `..._por_RANGO_...`). Es deliberado y no es snake case.
#[allow(non_snake_case)]
mod tests {
    use super::*;

    // ── Clasificación ──────────────────────────────────────────────────────────────────────────

    #[test]
    fn correcto_es_aceptado() {
        assert_eq!(clasificar("Correcto", None), EstadoEnvio::Aceptado);
    }

    #[test]
    fn aceptado_con_errores_esta_en_la_aeat_pero_pide_accion() {
        // La diferencia que importa: NO se reenvía igual (ya está allí), se subsana.
        assert_eq!(
            clasificar("AceptadoConErrores", Some(2000)),
            EstadoEnvio::AceptadoConErrores
        );
        assert!(hay_que_subsanar(EstadoEnvio::AceptadoConErrores, Some(2000)));
    }

    #[test]
    fn un_duplicado_se_trata_como_aceptado() {
        // Es lo que hace el envío idempotente. Sin esto, un corte de luz entre el envío y el
        // guardado del resultado dejaría registros reintentándose para siempre contra una AEAT que
        // ya los tiene.
        assert_eq!(clasificar("Incorrecto", Some(COD_DUPLICADO)), EstadoEnvio::Aceptado);
        assert!(!hay_que_subsanar(EstadoEnvio::Aceptado, Some(COD_DUPLICADO)));
    }

    #[test]
    fn cualquier_otro_incorrecto_es_un_rechazo() {
        assert_eq!(clasificar("Incorrecto", Some(1150)), EstadoEnvio::Rechazado);
        assert_eq!(clasificar("Incorrecto", Some(4102)), EstadoEnvio::Rechazado);
        assert_eq!(clasificar("Incorrecto", None), EstadoEnvio::Rechazado);
    }

    #[test]
    fn los_admisibles_se_clasifican_por_RANGO_y_no_por_lista() {
        // El catálogo lo publica la AEAT y crece. Una lista cerrada trataría un código nuevo del
        // rango como un rechazo y reintentaría para siempre un registro que la AEAT YA TIENE
        // guardado. Un 2999 que hoy no existe tiene que clasificarse como admisible.
        for c in [2000, 2001, 2005, 2007, 2008, 2050, 2999] {
            assert_eq!(
                clasificar("Incorrecto", Some(c)),
                EstadoEnvio::AceptadoConErrores,
                "el código {c} está en el rango admisible"
            );
        }
        assert_eq!(clasificar("Incorrecto", Some(1999)), EstadoEnvio::Rechazado);
        assert_eq!(clasificar("Incorrecto", Some(3001)), EstadoEnvio::Rechazado);
    }

    #[test]
    fn un_estado_desconocido_se_deja_pendiente_y_no_se_da_por_bueno() {
        // Una versión nueva del servicio con un estado que este cliente no conoce. Darlo por
        // aceptado sería dejar de remitir EN SILENCIO, que es la única forma de romper esto de
        // verdad: el TPV parecería sano y la AEAT no tendría nada.
        assert_eq!(clasificar("EstadoQueNoExiste", None), EstadoEnvio::Pendiente);
        assert_eq!(clasificar("", None), EstadoEnvio::Pendiente);
    }

    #[test]
    fn el_reloj_adelantado_no_pide_subsanacion() {
        // Error 2004: la fecha de generación va por delante del reloj de la AEAT. El del bar puede
        // ir adelantado y nadie ha hecho nada mal; el documento lo excepciona de subsanar. Hay que
        // NO ASUSTARSE al verlo en el panel.
        assert_eq!(
            clasificar("AceptadoConErrores", Some(2004)),
            EstadoEnvio::AceptadoConErrores
        );
        assert!(!hay_que_subsanar(EstadoEnvio::AceptadoConErrores, Some(2004)));
    }

    // ── Marcas de subsanación ──────────────────────────────────────────────────────────────────

    #[test]
    fn subsanar_lo_que_ESTA_en_la_aeat_no_lleva_rechazo_previo() {
        // «Alta de subsanación» del anexo. Poner `RechazoPrevio=X` aquí es el ERROR (2): no puede
        // recibirse un alta de esas características existiendo ya un registro de esa factura.
        assert_eq!(marcas_de_subsanacion(EstadoEnvio::Aceptado), (Some("S"), None));
        assert_eq!(
            marcas_de_subsanacion(EstadoEnvio::AceptadoConErrores),
            (Some("S"), None)
        );
    }

    #[test]
    fn subsanar_lo_que_NO_esta_en_la_aeat_lleva_rechazo_previo_x() {
        // «Alta por rechazo». Omitirlo aquí es el ERROR (3): debería existir ya un registro para
        // esa factura, y no existe.
        assert_eq!(
            marcas_de_subsanacion(EstadoEnvio::Rechazado),
            (Some("S"), Some("X"))
        );
    }

    #[test]
    fn un_pendiente_no_se_subsana_se_reintenta() {
        assert_eq!(marcas_de_subsanacion(EstadoEnvio::Pendiente), (None, None));
    }

    // ── El ciclo de remisión, con dobles ───────────────────────────────────────────────────────
    //
    // El adaptador de verdad necesita un certificado en el almacén de una máquina concreta y sale a
    // internet, así que no se puede usar en un test. Lo que sí se puede —y es lo que de verdad
    // duele si se equivoca— es la ORQUESTACIÓN: qué se manda, en qué orden, cómo se casan las
    // respuestas y qué pasa cuando algo falla a la mitad.

    // Los nombres de estos tests usan MAYUSCULAS para enfatizar la afirmacion que fijan
    // (`..._NO_gasta_numero`, `..._por_RANGO_...`). Es deliberado y no es snake case.
    #[allow(non_snake_case)]
    mod ciclo {
        use super::super::*;
        use crate::ports::aeat::{
            CertificadoDisponible, LineaRespuesta, RegistroParaEnvio, RespuestaRemision,
        };
        use std::sync::Mutex;
        use crate::error::AppError;
        use tpv_contracts::verifactu::{BloqueFiscal, EstadoFiscal, RegistroFiscal};

        fn registro(num: &str) -> RegistroParaEnvio {
            RegistroParaEnvio {
                id_registro: format!("id-{num}"),
                tipo: "ALTA".into(),
                nif_emisor: "89890001K".into(),
                num_serie_factura: num.into(),
                fecha_expedicion: "15-01-2027".into(),
                fecha_operacion: None,
                nombre_razon_emisor: "Bar".into(),
                tipo_factura: Some("F2".into()),
                tipo_rectificativa: None,
                descripcion_operacion: None,
                importe_total: Some("12.10".into()),
                cuota_total: Some("1.10".into()),
                desglose_json: None,
                destinatario_json: None,
                referencias_json: None,
                macrodato: None,
                primer_registro: Some("S".into()),
                ant_nif: None,
                ant_num_serie: None,
                ant_fecha: None,
                ant_huella: None,
                huella: "H".into(),
                tipo_huella: "01".into(),
                fecha_hora_huso: "2027-01-15T21:34:56+01:00".into(),
                sistema_json: "{}".into(),
                subsanacion: None,
                rechazo_previo: None,
                sin_registro_previo: None,
            }
        }

        /// Lo que el repositorio doble anotó, para poder afirmar sobre ello.
        #[derive(Default)]
        struct Anotado {
            resultados: Vec<(String, String, Option<i64>, Option<String>)>,
            intentos: Vec<String>,
            flujo: Option<(i64, i64)>,
        }

        struct RepoFalso {
            pendientes: Vec<RegistroParaEnvio>,
            obligado: Option<(String, String, bool)>,
            flujo: (i64, Option<i64>),
            anotado: Mutex<Anotado>,
        }

        impl RepoFalso {
            fn con(pendientes: Vec<RegistroParaEnvio>) -> Self {
                Self {
                    pendientes,
                    obligado: Some(("89890001K".into(), "Bar".into(), true)),
                    flujo: (60, None),
                    anotado: Mutex::new(Anotado::default()),
                }
            }
        }

        #[async_trait::async_trait]
        impl VerifactuRepository for RepoFalso {
            async fn bloque_por_numero(&self, _n: &str) -> AppResult<Option<BloqueFiscal>> {
                Ok(None)
            }
            async fn estado(&self) -> AppResult<EstadoFiscal> {
                unreachable!("el ciclo no lee el panel")
            }
            async fn listar(&self, _l: i64, _d: i64) -> AppResult<Vec<RegistroFiscal>> {
                Ok(vec![])
            }
            async fn pendientes(&self, limite: i64) -> AppResult<Vec<RegistroParaEnvio>> {
                Ok(self.pendientes.iter().take(limite as usize).cloned().collect())
            }
            async fn contar_pendientes(&self) -> AppResult<i64> {
                Ok(self.pendientes.len() as i64)
            }
            async fn flujo(&self) -> AppResult<(i64, Option<i64>)> {
                Ok(self.flujo)
            }
            async fn guardar_flujo(&self, espera_s: i64, ultimo: i64) -> AppResult<()> {
                self.anotado.lock().unwrap().flujo = Some((espera_s, ultimo));
                Ok(())
            }
            async fn marcar_resultado(
                &self,
                id: &str,
                estado: &str,
                cod: Option<i64>,
                _desc: Option<&str>,
                csv: Option<&str>,
            ) -> AppResult<()> {
                self.anotado.lock().unwrap().resultados.push((
                    id.to_string(),
                    estado.to_string(),
                    cod,
                    csv.map(str::to_string),
                ));
                Ok(())
            }
            async fn marcar_intento(&self, ids: &[String]) -> AppResult<()> {
                self.anotado.lock().unwrap().intentos.extend_from_slice(ids);
                Ok(())
            }
            async fn obligado(&self) -> AppResult<Option<(String, String, bool)>> {
                Ok(self.obligado.clone())
            }
            async fn emitir_sustitutiva(
                &self,
                _n: &str,
                _d: tpv_domain::verifactu::Destinatario,
            ) -> AppResult<BloqueFiscal> {
                unreachable!("el ciclo de remisión no emite facturas")
            }
        }

        /// Cliente doble: devuelve lo que se le diga y guarda lo que se le mandó.
        struct AeatFalso {
            respuesta: Mutex<Option<AppResult<RespuestaRemision>>>,
            recibido: Mutex<Vec<String>>,
        }

        impl AeatFalso {
            fn ok(lineas: Vec<LineaRespuesta>, csv: Option<&str>, espera: Option<i64>) -> Self {
                Self {
                    respuesta: Mutex::new(Some(Ok(RespuestaRemision {
                        estado_envio: "Correcto".into(),
                        csv: csv.map(str::to_string),
                        tiempo_espera_envio: espera,
                        lineas,
                    }))),
                    recibido: Mutex::new(Vec::new()),
                }
            }
            fn falla() -> Self {
                Self {
                    respuesta: Mutex::new(Some(Err(AppError::external("sin red")))),
                    recibido: Mutex::new(Vec::new()),
                }
            }
        }

        #[async_trait::async_trait]
        impl AeatClient for AeatFalso {
            async fn certificados(&self) -> AppResult<Vec<CertificadoDisponible>> {
                Ok(vec![])
            }
            async fn remitir(
                &self,
                _e: EntornoAeat,
                _h: &str,
                _c: &CabeceraEnvio,
                registros: &[RegistroParaEnvio],
            ) -> AppResult<RespuestaRemision> {
                *self.recibido.lock().unwrap() =
                    registros.iter().map(|r| r.num_serie_factura.clone()).collect();
                self.respuesta
                    .lock()
                    .unwrap()
                    .take()
                    .unwrap_or_else(|| Err(AppError::internal("el doble sólo responde una vez")))
            }
            async fn probar_conexion(
                &self,
                _e: EntornoAeat,
                _h: &str,
                _o: Option<&CabeceraEnvio>,
            ) -> AppResult<String> {
                Ok("ok".into())
            }
        }

        fn linea(num: &str, estado: &str, cod: Option<i64>) -> LineaRespuesta {
            LineaRespuesta {
                num_serie_factura: num.into(),
                anulacion: false,
                estado: estado.into(),
                codigo_error: cod,
                descripcion_error: None,
                estado_duplicado: None,
            }
        }

        /// La respuesta a un registro de ANULACIÓN: mismo número que su alta, otra cosa.
        fn linea_anulacion(num: &str, estado: &str, cod: Option<i64>) -> LineaRespuesta {
            LineaRespuesta {
                anulacion: true,
                ..linea(num, estado, cod)
            }
        }

        /// Un registro de anulación de la factura `num`. El `IDFactura` es el del alta: eso es
        /// precisamente lo que hace que no se puedan distinguir sólo por el número.
        fn registro_anulacion(num: &str) -> RegistroParaEnvio {
            RegistroParaEnvio {
                id_registro: format!("id-anul-{num}"),
                tipo: "ANULACION".into(),
                ..registro(num)
            }
        }

        fn correr(
            repo: &RepoFalso,
            aeat: &AeatFalso,
        ) -> AppResult<Result<ResultadoCiclo, SinEnviar>> {
            let rt = tokio::runtime::Builder::new_current_thread()
                .build()
                .unwrap();
            rt.block_on(remitir_ciclo(repo, aeat, Some("HUELLA"), 1_000_000))
        }

        #[test]
        fn con_la_cola_vacia_no_se_llama_a_la_aeat() {
            let repo = RepoFalso::con(vec![]);
            let aeat = AeatFalso::ok(vec![], None, None);
            assert_eq!(correr(&repo, &aeat).unwrap(), Err(SinEnviar::ColaVacia));
            assert!(aeat.recibido.lock().unwrap().is_empty());
        }

        #[test]
        fn sin_datos_fiscales_no_es_un_error_del_job() {
            // Es una tarea del dueño y sale en el panel como tal. Si fuera un `Err`, el runner lo
            // trataría como una avería y aplicaría backoff a algo que no se arregla esperando.
            let mut repo = RepoFalso::con(vec![registro("1")]);
            repo.obligado = None;
            let aeat = AeatFalso::ok(vec![], None, None);
            assert_eq!(correr(&repo, &aeat).unwrap(), Err(SinEnviar::SinDatosFiscales));
        }

        #[test]
        fn sin_certificado_tampoco() {
            let repo = RepoFalso::con(vec![registro("1")]);
            let aeat = AeatFalso::ok(vec![], None, None);
            let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
            let r = rt.block_on(remitir_ciclo(&repo, &aeat, None, 1_000_000)).unwrap();
            assert_eq!(r, Err(SinEnviar::SinCertificado));
        }

        #[test]
        fn el_control_de_flujo_frena_el_envio() {
            let mut repo = RepoFalso::con(vec![registro("1")]);
            // Se envió hace 10 s y la AEAT pidió 60.
            repo.flujo = (60, Some(1_000_000 - 10_000));
            let aeat = AeatFalso::ok(vec![], None, None);
            assert_eq!(correr(&repo, &aeat).unwrap(), Err(SinEnviar::ControlDeFlujo));
            assert!(aeat.recibido.lock().unwrap().is_empty(), "no se llegó a llamar");
        }

        #[test]
        fn cada_linea_se_casa_por_NUMERO_y_no_por_posicion() {
            // El test que importa de verdad. Si la AEAT devuelve las líneas en otro orden —o se
            // deja una—, casar por índice desplazaría todos los estados una posición y marcaría
            // como ACEPTADO un registro RECHAZADO. Eso es dejar de remitir en silencio.
            let repo = RepoFalso::con(vec![registro("A"), registro("B"), registro("C")]);
            let aeat = AeatFalso::ok(
                vec![
                    linea("C", "Incorrecto", Some(1150)),
                    linea("A", "Correcto", None),
                    linea("B", "AceptadoConErrores", Some(2000)),
                ],
                Some("CSV1"),
                Some(60),
            );

            let r = correr(&repo, &aeat).unwrap().unwrap();
            assert_eq!(r.aceptados, 1);
            assert_eq!(r.aceptados_con_errores, 1);
            assert_eq!(r.rechazados, 1);

            let a = repo.anotado.lock().unwrap();
            let por_id = |id: &str| {
                a.resultados
                    .iter()
                    .find(|(i, ..)| i == id)
                    .cloned()
                    .unwrap_or_else(|| panic!("falta {id}"))
            };
            assert_eq!(por_id("id-A").1, "ACEPTADO");
            assert_eq!(por_id("id-B").1, "ACEPTADO_CON_ERRORES");
            assert_eq!(por_id("id-C").1, "RECHAZADO");
        }

        #[test]
        fn un_alta_y_su_ANULACION_no_se_cruzan_aunque_compartan_numero() {
            // El caso que esto cierra es de todo menos raro: se cobra por error y se anula acto
            // seguido, dentro del mismo ciclo de 60 s. Los dos registros van en el mismo envío y
            // llevan el MISMO `NumSerieFactura`, porque el `IDFactura` de una anulación es el de la
            // factura que anula.
            //
            // Casando sólo por número, `find` devolvía la primera línea para los dos. Aquí la AEAT
            // acepta el alta y RECHAZA la anulación: si se cruzan, la anulación se anota como
            // aceptada, `subsanar_rechazados` no la ve nunca y la factura sigue viva para Hacienda
            // mientras el panel dice que todo salió bien.
            let repo = RepoFalso::con(vec![registro("A"), registro_anulacion("A")]);
            let aeat = AeatFalso::ok(
                vec![
                    linea("A", "Correcto", None),
                    linea_anulacion("A", "Incorrecto", Some(1150)),
                ],
                Some("CSV1"),
                Some(60),
            );

            let r = correr(&repo, &aeat).unwrap().unwrap();
            assert_eq!(r.aceptados, 1);
            assert_eq!(r.rechazados, 1, "la anulación fue rechazada y tiene que contarse");

            let a = repo.anotado.lock().unwrap();
            let por_id = |id: &str| {
                a.resultados
                    .iter()
                    .find(|(i, ..)| i == id)
                    .cloned()
                    .unwrap_or_else(|| panic!("falta {id}"))
            };
            assert_eq!(por_id("id-A").1, "ACEPTADO", "el alta la aceptaron");
            assert_eq!(
                por_id("id-anul-A").1,
                "RECHAZADO",
                "la anulación la rechazaron: anotarla como aceptada la deja sin subsanar para siempre",
            );
        }

        #[test]
        fn una_anulacion_sin_su_linea_se_queda_pendiente_en_vez_de_coger_la_del_alta() {
            // La otra mitad de lo mismo. Si la AEAT sólo contesta por el alta, la anulación no tiene
            // respuesta — y «no tiene respuesta» es PENDIENTE, no «lo que le pasó al alta».
            let repo = RepoFalso::con(vec![registro("A"), registro_anulacion("A")]);
            let aeat = AeatFalso::ok(vec![linea("A", "Correcto", None)], None, Some(60));

            correr(&repo, &aeat).unwrap().unwrap();

            let a = repo.anotado.lock().unwrap();
            assert!(
                a.resultados.iter().all(|(i, ..)| i != "id-anul-A"),
                "la anulación no puede quedar anotada con el resultado del alta",
            );
            assert!(
                a.intentos.iter().any(|i| i == "id-anul-A"),
                "tiene que quedar como intento para reintentarla",
            );
        }

        #[test]
        fn un_registro_del_que_la_aeat_no_dice_nada_se_queda_pendiente() {
            // No se puede suponer nada: ni que lo tiene ni que no. Se reintenta.
            let repo = RepoFalso::con(vec![registro("A"), registro("B")]);
            let aeat = AeatFalso::ok(vec![linea("A", "Correcto", None)], None, Some(60));

            correr(&repo, &aeat).unwrap().unwrap();
            let a = repo.anotado.lock().unwrap();
            assert_eq!(a.resultados.len(), 1, "sólo se anota el que contestó");
            assert_eq!(a.intentos, vec!["id-B".to_string()]);
        }

        #[test]
        fn un_fallo_de_transporte_deja_todo_pendiente_y_cuenta_el_intento() {
            // Un corte de red no dice si la AEAT los tiene. Darlos por perdidos sería tan malo como
            // darlos por buenos: siguen PENDIENTE y se reintentan.
            let repo = RepoFalso::con(vec![registro("A"), registro("B")]);
            let aeat = AeatFalso::falla();

            assert!(correr(&repo, &aeat).is_err());
            let a = repo.anotado.lock().unwrap();
            assert!(a.resultados.is_empty(), "no se marca ningún resultado");
            assert_eq!(a.intentos, vec!["id-A".to_string(), "id-B".to_string()]);
            assert!(a.flujo.is_none(), "un envío que falló no gasta la ventana de flujo");
        }

        #[test]
        fn el_csv_se_guarda_en_los_aceptados_y_no_en_los_rechazados() {
            // El CSV es del ENVÍO y hay que guardarlo en el momento: no se puede recuperar con una
            // consulta posterior. Ponérselo a un rechazado sería decir que la AEAT lo tiene.
            let repo = RepoFalso::con(vec![registro("A"), registro("B")]);
            let aeat = AeatFalso::ok(
                vec![
                    linea("A", "Correcto", None),
                    linea("B", "Incorrecto", Some(1104)),
                ],
                Some("CSV-DEL-ENVIO"),
                Some(60),
            );

            correr(&repo, &aeat).unwrap().unwrap();
            let a = repo.anotado.lock().unwrap();
            let csv = |id: &str| {
                a.resultados
                    .iter()
                    .find(|(i, ..)| i == id)
                    .and_then(|(_, _, _, c)| c.clone())
            };
            assert_eq!(csv("id-A").as_deref(), Some("CSV-DEL-ENVIO"));
            assert_eq!(csv("id-B"), None);
        }

        #[test]
        fn el_control_de_flujo_se_guarda_con_lo_que_dijo_la_aeat() {
            let repo = RepoFalso::con(vec![registro("A")]);
            let aeat = AeatFalso::ok(vec![linea("A", "Correcto", None)], None, Some(300));

            correr(&repo, &aeat).unwrap().unwrap();
            assert_eq!(repo.anotado.lock().unwrap().flujo, Some((300, 1_000_000)));
        }

        #[test]
        fn un_duplicado_cuenta_como_aceptado_y_no_como_rechazo() {
            // Es la idempotencia del envío: si un lote se manda dos veces (el TPV se apagó entre el
            // envío y el guardado del resultado), la segunda vuelve con 3000. Tratarlo como rechazo
            // dejaría el registro reintentándose para siempre contra una AEAT que ya lo tiene.
            let repo = RepoFalso::con(vec![registro("A")]);
            let aeat = AeatFalso::ok(
                vec![linea("A", "Incorrecto", Some(COD_DUPLICADO))],
                None,
                Some(60),
            );

            let r = correr(&repo, &aeat).unwrap().unwrap();
            assert_eq!(r.aceptados, 1);
            assert_eq!(r.rechazados, 0);
            assert_eq!(repo.anotado.lock().unwrap().resultados[0].1, "ACEPTADO");
        }

        #[test]
        fn los_registros_se_mandan_en_el_orden_en_que_los_da_el_repositorio() {
            // El repositorio los da por `Orden` ascendente porque la AEAT valida cada uno contra su
            // encadenamiento anterior. Reordenarlos aquí sería mandar el eslabón N+1 contra una
            // huella que todavía no existe.
            let repo = RepoFalso::con(vec![registro("A"), registro("B"), registro("C")]);
            let aeat = AeatFalso::ok(vec![], None, Some(60));

            correr(&repo, &aeat).unwrap().unwrap();
            assert_eq!(*aeat.recibido.lock().unwrap(), vec!["A", "B", "C"]);
        }
    }

    // ── Control de flujo ───────────────────────────────────────────────────────────────────────

    const MIN: i64 = 60_000;

    #[test]
    fn sin_pendientes_no_se_envia() {
        assert!(!puede_enviar(10 * MIN, None, 60, 0));
    }

    #[test]
    fn el_primer_envio_no_espera() {
        assert!(puede_enviar(0, None, 60, 1));
    }

    #[test]
    fn hay_que_esperar_los_segundos_que_dijo_la_aeat() {
        let ultimo = 10 * MIN;
        assert!(!puede_enviar(ultimo + 59_000, Some(ultimo), 60, 5));
        assert!(puede_enviar(ultimo + 60_000, Some(ultimo), 60, 5));
        // Y si la AEAT sube la espera, se respeta: es un control de flujo que impone la norma.
        assert!(!puede_enviar(ultimo + 60_000, Some(ultimo), 300, 5));
        assert!(puede_enviar(ultimo + 300_000, Some(ultimo), 300, 5));
    }

    #[test]
    fn mil_pendientes_mandan_sobre_el_reloj() {
        // «...o deberá esperar a tener acumulados un número de registros igual al límite, LA
        // CIRCUNSTANCIA QUE OCURRA PRIMERO».
        let ultimo = 10 * MIN;
        assert!(puede_enviar(ultimo + 1, Some(ultimo), 3600, MAX_POR_ENVIO));
        assert!(!puede_enviar(ultimo + 1, Some(ultimo), 3600, MAX_POR_ENVIO - 1));
    }

    #[test]
    fn un_reloj_que_retrocede_no_bloquea_los_envios_para_siempre() {
        // Un cambio de hora o una sincronización NTP puede dejar «ahora» por detrás del último
        // envío guardado. Con una resta a secas, eso bloquearía la remisión hasta que el reloj
        // alcanzara ese valor — que puede ser una hora, o un año.
        let ultimo = 100 * MIN;
        assert!(puede_enviar(50 * MIN, Some(ultimo), 60, 3));
    }

    #[test]
    fn la_espera_se_conserva_si_la_aeat_no_la_informa() {
        // Inventarse una (bajarla) sería saltarse un control de flujo que impone la norma.
        assert_eq!(espera_siguiente(None, 300), 300);
        assert_eq!(espera_siguiente(Some(0), 300), 300);
    }

    #[test]
    fn la_espera_se_acota_a_un_rango_razonable() {
        // Un 0 dejaría al TPV martilleando el servicio; un valor absurdo lo dejaría mudo un día.
        assert_eq!(espera_siguiente(Some(120), 60), 120);
        assert_eq!(espera_siguiente(Some(99_999), 60), 3600);
        assert_eq!(espera_siguiente(Some(-5), 60), 60);
    }
}
#[cfg(test)]
mod tests_aviso_de_atraso {
    #![allow(non_snake_case)] // los nombres en mayúsculas señalan qué afirma cada test

    //! La escalera de avisos, en el único peldaño que este caso de uso decide: si sale notificación.
    //!
    //! Los peldaños los calcula `tpv_infra_sqlite::verifactu::escalon_aviso` (y tiene sus propios
    //! tests de los umbrales); aquí se fija qué se hace con cada uno, que es otra decisión.

    use std::sync::Mutex;

    use async_trait::async_trait;
    use tpv_domain::notificaciones::{Destino, NuevaNotificacion, Severidad, ADMIN_ROL_ID};

    use super::*;
    use crate::ports::aeat::RegistroParaEnvio;
    use crate::ports::notificaciones::Notifier;

    struct RepoEstado(EstadoFiscal);

    fn estado_con(escalon: &str, completos: bool) -> EstadoFiscal {
        EstadoFiscal {
            datos_fiscales_completos: completos,
            nif: Some("89890001K".into()),
            razon_social: Some("Bar".into()),
            entorno_pruebas: false,
            total_registros: 10,
            pendientes: 4,
            aceptados: 6,
            aceptados_con_errores: 0,
            rechazados: 0,
            antiguedad_pendiente_min: Some(100),
            escalon_aviso: escalon.to_string(),
            certificado_ok: true,
            motivo_no_remite: None,
            dias_para_caducar_certificado: Some(300),
            anomalias_sin_reconocer: 0,
            ultima_anomalia: None,
            modo_prueba: false,
        }
    }

    #[async_trait]
    impl VerifactuRepository for RepoEstado {
        async fn bloque_por_numero(&self, _n: &str) -> AppResult<Option<BloqueFiscal>> {
            Ok(None)
        }
        async fn estado(&self) -> AppResult<EstadoFiscal> {
            Ok(self.0.clone())
        }
        async fn listar(&self, _l: i64, _d: i64) -> AppResult<Vec<RegistroFiscal>> {
            Ok(vec![])
        }
        async fn pendientes(&self, _l: i64) -> AppResult<Vec<RegistroParaEnvio>> {
            Ok(vec![])
        }
        async fn contar_pendientes(&self) -> AppResult<i64> {
            Ok(self.0.pendientes)
        }
        async fn flujo(&self) -> AppResult<(i64, Option<i64>)> {
            Ok((60, None))
        }
        async fn guardar_flujo(&self, _e: i64, _u: i64) -> AppResult<()> {
            Ok(())
        }
        async fn marcar_resultado(
            &self,
            _id: &str,
            _e: &str,
            _c: Option<i64>,
            _d: Option<&str>,
            _csv: Option<&str>,
        ) -> AppResult<()> {
            Ok(())
        }
        async fn marcar_intento(&self, _ids: &[String]) -> AppResult<()> {
            Ok(())
        }
        async fn obligado(&self) -> AppResult<Option<(String, String, bool)>> {
            Ok(None)
        }
        async fn emitir_sustitutiva(
            &self,
            _n: &str,
            _d: tpv_domain::verifactu::Destinatario,
        ) -> AppResult<BloqueFiscal> {
            unreachable!()
        }
    }

    #[derive(Default)]
    struct NotifierFalso {
        emitidas: Mutex<Vec<NuevaNotificacion>>,
        resueltas: Mutex<Vec<String>>,
    }

    #[async_trait]
    impl Notifier for NotifierFalso {
        async fn emitir(&self, nueva: NuevaNotificacion) -> AppResult<String> {
            self.emitidas.lock().unwrap().push(nueva);
            Ok("id".to_string())
        }
        async fn resolver_por_clave(&self, clave: &str) -> AppResult<bool> {
            self.resueltas.lock().unwrap().push(clave.to_string());
            Ok(true)
        }
    }

    async fn avisar(escalon: &str, completos: bool) -> (bool, NotifierFalso) {
        let repo = RepoEstado(estado_con(escalon, completos));
        let n = NotifierFalso::default();
        let r = avisar_de_atraso(&repo, &n).await.unwrap();
        (r, n)
    }

    #[tokio::test]
    async fn los_dos_primeros_peldanos_no_notifican() {
        // Una hora de cola es funcionamiento normal incluso con fibra: la AEAT impone una espera
        // entre envíos. Notificar ahí enseñaría a ignorar la notificación.
        for escalon in ["ninguno", "visible"] {
            let (emitio, n) = avisar(escalon, true).await;
            assert!(!emitio, "{escalon} no debe notificar");
            assert!(n.emitidas.lock().unwrap().is_empty());
        }
    }

    #[tokio::test]
    async fn a_partir_de_seis_horas_sale_a_buscar_al_administrador() {
        let (emitio, n) = avisar("notificacion", true).await;
        assert!(emitio);
        let e = n.emitidas.lock().unwrap();
        assert_eq!(e.len(), 1);
        assert_eq!(e[0].tipo, "verifactu_atraso");
        assert_eq!(e[0].severidad, Severidad::Aviso);
        assert_eq!(
            e[0].destino,
            Destino::Rol(ADMIN_ROL_ID.to_string()),
            "el camarero no puede hacer nada con esto"
        );
        assert_eq!(e[0].accion.as_deref(), Some("ver_fiscal"));
    }

    #[tokio::test]
    async fn los_peldanos_altos_suben_a_error() {
        for escalon in ["modal_login", "modal_cobro"] {
            let (emitio, n) = avisar(escalon, true).await;
            assert!(emitio);
            let e = n.emitidas.lock().unwrap();
            assert_eq!(e[0].severidad, Severidad::Error, "{escalon}");
        }
    }

    #[tokio::test]
    async fn la_clave_de_dedupe_es_UNA_para_todos_los_peldanos() {
        // Con una clave por peldaño, subir de escalón dejaría el anterior abierto y el centro de
        // notificaciones acumularía tres avisos del mismo problema.
        let mut claves = std::collections::HashSet::new();
        for escalon in ["notificacion", "modal_login", "modal_cobro"] {
            let (_, n) = avisar(escalon, true).await;
            claves.insert(n.emitidas.lock().unwrap()[0].clave_dedupe.clone());
        }
        assert_eq!(claves.len(), 1);
        assert_eq!(claves.into_iter().next().unwrap().as_deref(), Some(CLAVE_ATRASO));
    }

    #[tokio::test]
    async fn al_bajar_del_peldano_el_aviso_se_CIERRA() {
        // Un aviso que hay que descartar a mano después de que el problema se arregle enseña a
        // descartar avisos, que es lo contrario de lo que esto busca.
        let (_, n) = avisar("ninguno", true).await;
        assert_eq!(n.resueltas.lock().unwrap().as_slice(), [CLAVE_ATRASO.to_string()]);
    }

    #[tokio::test]
    async fn sin_datos_fiscales_no_avisa_de_esto() {
        // Faltan el NIF o la razón social: el panel ya lo dice con un mensaje mucho más útil
        // («mientras falten, no se puede cobrar»), y esto sería decir dos veces lo mismo por dos
        // caminos distintos.
        let (emitio, n) = avisar("modal_cobro", false).await;
        assert!(!emitio);
        assert!(n.emitidas.lock().unwrap().is_empty());
        assert_eq!(n.resueltas.lock().unwrap().as_slice(), [CLAVE_ATRASO.to_string()]);
    }

    #[tokio::test]
    async fn si_la_culpa_es_NUESTRA_el_aviso_no_manda_a_mirar_el_router() {
        // Cuando lo que impide remitir es un dato que falta en el propio programa, decirle al bar
        // «revisa la conexión y el certificado» le hace perder una tarde en algo que no puede tocar
        // — y a la tercera vez deja de leer el único aviso que no puede ignorar.
        let mut e = estado_con("modal_login", true);
        e.motivo_no_remite = Some("sin_datos_del_productor".to_string());
        let repo = RepoEstado(e);
        let n = NotifierFalso::default();

        assert!(avisar_de_atraso(&repo, &n).await.unwrap());
        let emitidas = n.emitidas.lock().unwrap();
        let cuerpo = emitidas[0].cuerpo.clone().unwrap_or_default();
        assert!(cuerpo.contains("problema de este programa"), "{cuerpo}");
        assert!(!cuerpo.contains("conexión y el certificado"), "{cuerpo}");
        assert!(
            cuerpo.contains("no se ha perdido ninguna"),
            "lo primero que hay que decirle es que sus ventas están: {cuerpo}"
        );
    }

    #[tokio::test]
    async fn la_culpa_nuestra_NO_se_salta_la_puerta_del_escalon() {
        // El texto cambia; la puerta no. Un fallo nuestro con la cola vacía no es nada que contarle
        // a nadie, y avisar ahí sería avisar de que no pasa nada.
        let mut e = estado_con("ninguno", true);
        e.motivo_no_remite = Some("sin_datos_del_productor".to_string());
        let repo = RepoEstado(e);
        let n = NotifierFalso::default();

        assert!(!avisar_de_atraso(&repo, &n).await.unwrap());
        assert!(n.emitidas.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn un_peldano_desconocido_no_avisa() {
        // Si alguien añade un escalón nuevo en Rust y se olvida de esto, lo que NO puede pasar es
        // que se emita un aviso con un texto que no corresponde.
        let (emitio, n) = avisar("peldano_del_futuro", true).await;
        assert!(!emitio);
        assert!(n.emitidas.lock().unwrap().is_empty());
    }
}
#[cfg(test)]
mod tests_certificado {
    #![allow(non_snake_case)] // los nombres en mayúsculas señalan qué afirma cada test

    //! El estado del certificado y su aviso.
    //!
    //! Estos dos campos (`certificado_ok`, `dias_para_caducar_certificado`) estuvieron declarados y
    //! sin rellenar: el comentario decía que lo haría «la capa que conoce el almacén de
    //! certificados» y esa capa no existía. El síntoma no era un fallo, era un silencio — el panel
    //! no podía decir «no hay certificado» ni «caduca en 12 días».

    use std::sync::Mutex;

    use async_trait::async_trait;
    use tpv_domain::notificaciones::{NuevaNotificacion, Severidad};

    use super::*;
    use crate::ports::notificaciones::Notifier;

    fn estado_base() -> EstadoFiscal {
        EstadoFiscal {
            datos_fiscales_completos: true,
            nif: Some("89890001K".into()),
            razon_social: Some("Bar".into()),
            entorno_pruebas: false,
            total_registros: 1,
            pendientes: 1,
            aceptados: 0,
            aceptados_con_errores: 0,
            rechazados: 0,
            antiguedad_pendiente_min: Some(10),
            escalon_aviso: "ninguno".to_string(),
            certificado_ok: false,
            motivo_no_remite: None,
            dias_para_caducar_certificado: None,
            anomalias_sin_reconocer: 0,
            ultima_anomalia: None,
            modo_prueba: false,
        }
    }

    fn cert_sano() -> EstadoCertificado {
        EstadoCertificado {
            elegido: true,
            encontrado: true,
            dias_para_caducar: Some(200),
            uso_silencioso: true,
        }
    }

    #[derive(Default)]
    struct NotifierFalso {
        emitidas: Mutex<Vec<NuevaNotificacion>>,
        resueltas: Mutex<Vec<String>>,
    }

    #[async_trait]
    impl Notifier for NotifierFalso {
        async fn emitir(&self, nueva: NuevaNotificacion) -> AppResult<String> {
            self.emitidas.lock().unwrap().push(nueva);
            Ok("id".to_string())
        }
        async fn resolver_por_clave(&self, clave: &str) -> AppResult<bool> {
            self.resueltas.lock().unwrap().push(clave.to_string());
            Ok(true)
        }
    }

    // ── El estado que ve el panel ────────────────────────────────────────────

    #[test]
    fn con_un_certificado_sano_el_panel_dice_que_se_puede_remitir() {
        let mut e = estado_base();
        completar_con_el_certificado(&mut e, &cert_sano());
        assert!(e.certificado_ok);
        assert_eq!(e.motivo_no_remite, None);
        assert_eq!(e.dias_para_caducar_certificado, Some(200));
    }

    #[test]
    fn cada_problema_del_certificado_tiene_su_motivo() {
        let casos: [(EstadoCertificado, &str); 4] = [
            (EstadoCertificado::default(), "sin_certificado"),
            (
                EstadoCertificado { elegido: true, ..Default::default() },
                "certificado_no_encontrado",
            ),
            (
                EstadoCertificado { dias_para_caducar: Some(-1), ..cert_sano() },
                "certificado_caducado",
            ),
            (
                EstadoCertificado { uso_silencioso: false, ..cert_sano() },
                "certificado_pide_pin",
            ),
        ];
        for (cert, esperado) in casos {
            let mut e = estado_base();
            completar_con_el_certificado(&mut e, &cert);
            assert_eq!(e.motivo_no_remite.as_deref(), Some(esperado));
            assert!(!e.certificado_ok, "{esperado}");
        }
    }

    #[test]
    fn NO_pisa_un_motivo_que_ya_venia_puesto() {
        // Los de la capa de datos van antes: «faltan tus datos fiscales» impide hasta cobrar, así
        // que el usuario lo tiene delante de todos modos. Decirle «no hay certificado» a quien
        // todavía no puede abrir la persiana es mandarlo al tercer problema de la lista.
        let mut e = estado_base();
        e.motivo_no_remite = Some("sin_datos_fiscales".to_string());
        completar_con_el_certificado(&mut e, &EstadoCertificado::default());
        assert_eq!(e.motivo_no_remite.as_deref(), Some("sin_datos_fiscales"));
        // Pero los DATOS del certificado sí se rellenan igual: el panel los enseña aparte.
        assert!(!e.certificado_ok);
    }

    #[test]
    fn caducar_hoy_todavia_no_es_haber_caducado() {
        // El borde exacto. `0` es «caduca hoy»: sigue valiendo. `-1` es ayer.
        let mut e = estado_base();
        completar_con_el_certificado(
            &mut e,
            &EstadoCertificado { dias_para_caducar: Some(0), ..cert_sano() },
        );
        assert!(e.certificado_ok);
        assert_eq!(e.motivo_no_remite, None);
    }

    // ── El aviso ─────────────────────────────────────────────────────────────

    async fn avisar(cert: EstadoCertificado) -> (bool, NotifierFalso) {
        let n = NotifierFalso::default();
        let r = avisar_del_certificado(&n, &cert).await.unwrap();
        (r, n)
    }

    #[tokio::test]
    async fn un_certificado_sano_y_con_margen_no_avisa() {
        let (aviso, n) = avisar(cert_sano()).await;
        assert!(!aviso);
        assert!(n.emitidas.lock().unwrap().is_empty());
        assert_eq!(n.resueltas.lock().unwrap().as_slice(), [CLAVE_CERTIFICADO.to_string()]);
    }

    #[tokio::test]
    async fn sin_certificado_elegido_NO_se_avisa() {
        // Es parte de la puesta en marcha, no una avería. Un TPV recién instalado no necesita una
        // notificación de algo que todavía no ha configurado nadie — y el panel ya lo dice.
        let (aviso, n) = avisar(EstadoCertificado::default()).await;
        assert!(!aviso);
        assert!(n.emitidas.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_treinta_dias_avisa_y_a_siete_sube_a_error() {
        // El escalón importa: el primero es «acuérdate» y el segundo «hazlo». Renovar con margen es
        // un trámite de gestoría; el día que caduca es una urgencia que para los envíos.
        let (_, n) = avisar(EstadoCertificado { dias_para_caducar: Some(DIAS_AVISO_CADUCIDAD), ..cert_sano() }).await;
        assert_eq!(n.emitidas.lock().unwrap()[0].severidad, Severidad::Aviso);

        let (_, n) = avisar(EstadoCertificado { dias_para_caducar: Some(DIAS_CADUCIDAD_URGENTE), ..cert_sano() }).await;
        assert_eq!(n.emitidas.lock().unwrap()[0].severidad, Severidad::Error);
    }

    #[tokio::test]
    async fn un_dia_mas_del_umbral_todavia_no_avisa() {
        // Sin este borde, el aviso saltaría once meses al año y se convertiría en parte del paisaje.
        let (aviso, _) = avisar(EstadoCertificado {
            dias_para_caducar: Some(DIAS_AVISO_CADUCIDAD + 1),
            ..cert_sano()
        })
        .await;
        assert!(!aviso);
    }

    #[tokio::test]
    async fn el_que_ya_no_esta_en_el_almacen_avisa_como_error() {
        // El caso que más despista: el certificado ESTABA y ya no. Pasa al renovarlo (la huella
        // cambia) y al usar el TPV desde otra sesión de Windows.
        let (aviso, n) = avisar(EstadoCertificado { elegido: true, ..Default::default() }).await;
        assert!(aviso);
        let e = n.emitidas.lock().unwrap();
        assert_eq!(e[0].severidad, Severidad::Error);
        assert!(e[0].cuerpo.as_deref().unwrap_or("").contains("otro usuario de Windows"));
    }

    #[tokio::test]
    async fn la_clave_de_dedupe_es_UNA_para_todos_los_casos() {
        // Igual que la del atraso y por lo mismo: pasar de «caduca en tres semanas» a «caducó»
        // dejaría el aviso anterior abierto y el centro acumularía dos avisos del mismo hecho.
        let mut claves = std::collections::HashSet::new();
        for cert in [
            EstadoCertificado { elegido: true, ..Default::default() },
            EstadoCertificado { dias_para_caducar: Some(-1), ..cert_sano() },
            EstadoCertificado { dias_para_caducar: Some(3), ..cert_sano() },
            EstadoCertificado { uso_silencioso: false, ..cert_sano() },
        ] {
            let (_, n) = avisar(cert).await;
            claves.insert(n.emitidas.lock().unwrap()[0].clave_dedupe.clone());
        }
        assert_eq!(claves.len(), 1);
        assert_eq!(claves.into_iter().next().unwrap().as_deref(), Some(CLAVE_CERTIFICADO));
    }

    #[tokio::test]
    async fn el_aviso_del_certificado_es_DISTINTO_del_aviso_por_atraso() {
        // Y tiene que serlo: el del atraso mide horas de cola, así que llega cuando ya se ha dejado
        // de remitir. Éste llega antes de que pase nada. Si compartieran clave, uno cerraría al otro.
        assert_ne!(CLAVE_CERTIFICADO, CLAVE_ATRASO);
    }
}
