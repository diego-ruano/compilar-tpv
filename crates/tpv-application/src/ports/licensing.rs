//! Puertos de **licensing** e **identidad de dispositivo / pairing**.
//!
//! No SQLite: el adaptador (tpv-infra-licensing) gestiona keyring (clave ed25519 y tokens),
//! el fichero `license_state.json` y las llamadas HTTP a los workers. El comando Tauri
//! resuelve el directorio de datos (AppData) y construye el adaptador con esa ruta.

use async_trait::async_trait;
use serde_json::Value as JsonValue;

use tpv_domain::licensing::{
    EstadoVerificado, FalloConsulta, ResultadoActivacion, Sello, SolicitudActivacion,
};

use tpv_contracts::licensing::{
    ApiSignedHeaders, DeviceIdentity,  LicenseLocalState, PairCreateResult, FirmaDispositivo, DeviceFirmarEmparejamientoArgs,
};

use crate::error::{AppError, AppResult};

/// Un rechazo del contenido se aparta; fallos de red, credenciales y servidor siguen siendo Err.
pub enum ResultadoSubidaImagen {
    Subida,
    Rechazada { motivo: String },
}

/// Lo que contesta el servidor a una consulta de estado.
pub struct EstadoConsultado {
    pub verificado: EstadoVerificado,
    /// El token de sesión con el que seguir: el que renovó `/status` o, si no vino, el que se usó
    /// (el del keyring o el del `/refresh`). `None` en un rechazo firmado: el del keyring no cambia.
    pub token: Option<String>,
}

/// Servicio de licenciamiento: **transporte y almacén**, sin política.
///
/// El adaptador trae datos del servidor (incluida la verificación ed25519 de la firma, que es
/// cripto: no cabe en el dominio puro) y lee/escribe `license_state.json`. Quién puede usar el
/// TPV lo decide el dominio (`tpv_domain::licensing`) y lo orquesta el caso de uso.
#[async_trait]
pub trait LicensingService: Send + Sync {
    /// Lee el estado local. `None` si este dispositivo no tiene licencia activada.
    fn load_state(&self) -> AppResult<Option<LicenseLocalState>>;
    /// Persiste el estado local.
    fn save_state(&self, state: &LicenseLocalState) -> AppResult<()>;
    /// Borra el estado local, anotando POR QUÉ si el motivo importa.
    ///
    /// El motivo se guarda porque el borrado deja al equipo en la pantalla de activar, y esa
    /// pantalla no tiene forma de saber si es un TPV recién instalado o uno al que le acaban de
    /// anular la licencia. Sin la nota, quien llega ahí no sabe qué le ha pasado ni que basta con
    /// deshacer la anulación para volver —sin perder nada— con la misma clave.
    ///
    /// `None` cuando lo pide el usuario ("borrar y volver a activar"): ahí no hay nada que contar.
    fn delete_state(&self, motivo: Option<&str>) -> AppResult<()>;

    /// El motivo del último borrado, si sigue sin haber licencia. `save_state` lo limpia: con una
    /// licencia válida delante, no hay rechazo pendiente que enseñar.
    fn last_rejection(&self) -> AppResult<Option<String>>;

    /// Canjea la clave en el servidor. **No guarda nada en el equipo**: las credenciales concedidas
    /// (el token de sesión y la clave de cifrado de campo) se quedan en el adaptador hasta
    /// [`Self::guardar_credenciales`], y `license_state.json` lo escribe el caso de uso con
    /// `save_state`. `device_change_code` solo se envía al mover la licencia a otro equipo; el
    /// servidor puede responder pidiéndolo.
    async fn activar_remoto(
        &self,
        solicitud: &SolicitudActivacion,
        device_change_code: Option<&str>,
    ) -> AppResult<ResultadoActivacion>;

    /// Guarda en el almacén de secretos las credenciales que concedió la última `activar_remoto`.
    ///
    /// AUD-06: va aparte de la petición para que el caso de uso pueda decidir antes qué se hace con
    /// la base del equipo. Con ellas guardadas, cualquier cosa que hable con la nube lo hace ya en
    /// nombre del negocio concedido. La clave de cifrado de campo se guarda ligada a su negocio.
    fn guardar_credenciales(&self) -> AppResult<()>;

    /// AUD-06 · Guarda lo concedido por la última `activar_remoto` como **pendiente**, sin tocar lo
    /// vigente: el token y la DEK en entradas aparte del almacén de secretos, y `estado` aparte de
    /// `license_state.json`. Es la licencia de otro negocio que la base del equipo: no vale hasta el
    /// arranque siguiente, que aparta la base y la aplica (`aplicar_pendiente`).
    fn guardar_pendiente(&self, _estado: &LicenseLocalState) -> AppResult<()> {
        Err(crate::error::AppError::internal("Este equipo no guarda licencias pendientes."))
    }
    /// AUD-06 · El negocio de la licencia pendiente, si la hay.
    fn negocio_pendiente(&self) -> AppResult<Option<String>> {
        Ok(None)
    }
    /// AUD-06 · Lo pendiente pasa a vigente: credenciales, DEK y licencia. Repetible: un corte a medias
    /// se termina repitiéndolo, y sin nada pendiente no hace nada.
    fn aplicar_pendiente(&self) -> AppResult<()> {
        Ok(())
    }
    /// AUD-06 · Olvida lo pendiente (otra activación lo sustituye, o nunca llegó a anotarse el cambio).
    fn descartar_pendiente(&self) -> AppResult<()> {
        Ok(())
    }

    /// Pide al servidor que envíe el OTP de cambio de dispositivo al email de la licencia.
    async fn solicitar_cambio_dispositivo(&self, clave: &str) -> AppResult<()>;

    /// Consulta el estado de la licencia (petición firmada con el token del keyring) y **verifica
    /// la firma ed25519** contra la clave pública pineada antes de devolverla. Si el token de sesión
    /// ha caducado, lo renueva de forma transparente por device-proof (`/refresh`) y reintenta. El
    /// `Err` está clasificado para que el dominio sepa qué significa el fallo.
    ///
    /// No guarda nada: el token con el que seguir vuelve en `EstadoConsultado`, y lo guarda el caso
    /// de uso junto con el estado (LIC-08).
    async fn consultar_estado(
        &self,
        state: &LicenseLocalState,
    ) -> Result<EstadoConsultado, FalloConsulta>;

    /// Guarda en el keyring el token que trajo `consultar_estado`. Un fallo del keyring no invalida
    /// la comprobación (la petición ya se hizo con un token válido): se ignora y se reintentará en
    /// la siguiente.
    fn guardar_token(&self, token: &str);

    /// RI-36: milisegundos transcurridos según el reloj MONÓTONO del proceso desde la llamada
    /// anterior (que queda como nueva marca). `None` en la primera llamada del proceso: entre un
    /// arranque y otro no hay reloj monótono que valga. Atrasar el reloj del sistema no lo cambia.
    ///
    /// Por defecto `None`, que es lo que haría un proceso recién arrancado: sólo cuenta el reloj de
    /// pared, nunca hacia atrás.
    fn transcurrido_monotono(&self) -> Option<i64> {
        None
    }
}

/// AUD-06 · La base local de este equipo, vista desde la licencia que se activa y desde el arranque.
///
/// Una base sólo se usa con la licencia de su negocio, y de quién es lo dice ella: su sello. Con la
/// licencia de otro negocio no cambia nada en el proceso que la activa: se anota el cambio, y el
/// arranque siguiente aparta la base y aplica la licencia (`docs/arquitectura/recuperacion.md`).
#[async_trait]
pub trait BaseDelEquipo: Send + Sync {
    /// Lo que la base dice de sí misma: el negocio que lleva sellado, ninguno (o no hay base), o que
    /// no se deja leer.
    async fn sello(&self) -> AppResult<Sello>;
    /// Sella con `negocio` una base que no lleva sello.
    async fn sellar(&self, negocio: &str) -> AppResult<()>;
    /// La base es del negocio, pero de antes de que la licencia pasara por otro equipo: deja la
    /// marca de traslado y cierra las escrituras de negocio hasta que se reconstruya desde la nube.
    async fn marcar_traslado(&self) -> AppResult<()>;
    /// La licencia de `negocio` se ha guardado como pendiente sobre una base de otro negocio (o que no
    /// se sabe de quién es): deja anotado el cambio, de forma duradera (entero o nada). Lo que está en
    /// marcha sigue siendo del negocio de la base hasta el reinicio.
    async fn marcar_cambio_de_negocio(&self, negocio: &str) -> AppResult<()>;
    /// El negocio del cambio anotado, si lo hay.
    async fn cambio_de_negocio_pendiente(&self) -> AppResult<Option<String>>;
    /// Al arrancar, con la base cerrada: termina un apartado a medias y, si la base no es de
    /// `negocio` (o no se deja leer), aparta todo lo suyo. Repetible.
    async fn apartar_si_no_es_de(&self, negocio: &str) -> AppResult<()>;
    /// Quita la marca del cambio. Sólo lo hace el arranque, cuando ya está aplicado.
    async fn quitar_cambio_de_negocio(&self) -> AppResult<()>;
}

/// Servicio de identidad de dispositivo / pairing (claves, firma, handy token, tpv-server).
#[async_trait]
pub trait PairingService: Send + Sync {
    fn device_identity(&self) -> AppResult<DeviceIdentity>;
    fn firmar_hello(&self, mode: &str, nonce_b64: &str) -> AppResult<FirmaDispositivo>;
    fn firmar_emparejamiento(&self, args: DeviceFirmarEmparejamientoArgs) -> AppResult<FirmaDispositivo>;
    /// RELOJ-01: lo último que se ha medido de cuánto se aparta el reloj del equipo del de la nube
    /// (ms que hay que sumarle; positivo, va atrasado), o `None` si todavía no ha respondido la nube.
    /// Sólo para avisar: no corrige ninguna hora.
    fn desfase_del_reloj_ms(&self) -> Option<i64>;
    fn handy_set_token(&self, token: &str, tenant_id: &str) -> AppResult<()>;
    fn handy_clear_token(&self) -> AppResult<()>;
    fn handy_get_tenant(&self) -> AppResult<Option<String>>;
    /// AUD-06 · El negocio de la licencia de esta Main, o `None` si no tiene. Es con el que se
    /// firma en modo `tpv`: el token guardado tiene que ser de ese negocio.
    fn negocio_de_la_licencia(&self) -> AppResult<Option<String>>;
    /// Cabeceras firmadas para tpv-server según el modo (anon|tpv|handy).
    ///
    /// `body` son los bytes exactos del cuerpo que se enviará (vacío si no hay). Entra en la firma
    /// (FABLE-E), así que el llamante **debe** mandar ese mismo cuerpo sin re-serializarlo.
    fn tpv_server_signed_headers(
        &self,
        mode: &str,
        method: &str,
        path: &str,
        body: &[u8],
    ) -> AppResult<ApiSignedHeaders>;
    /// POST JSON al worker tpv-server (evita CORS/WebView).
    async fn tpv_server_post_json(
        &self,
        mode: &str,
        path: &str,
        body: JsonValue,
    ) -> AppResult<JsonValue>;
    /// El mismo POST, con el cuerpo de la respuesta tal cual. Es para lo que contesta con un
    /// volcado de la base del negocio (`/v1/sync/bootstrap`, `/historico`, `/verificar/*`…): quien
    /// lo pide lo lee directamente en su tipo (`use_cases::sync`), sin montar antes un
    /// `serde_json::Value` con todo dentro.
    ///
    /// Un estado que no es 2xx sale como en `tpv_server_post_json`. Un 200 con `ok:false` no se
    /// mira aquí: lo ve quien lee el cuerpo.
    ///
    /// Por defecto pasa por `tpv_server_post_json`, que es lo que tienen los dobles de los tests;
    /// el adaptador de verdad lo sustituye para no pasar por el árbol.
    async fn tpv_server_post_bytes(
        &self,
        mode: &str,
        path: &str,
        body: JsonValue,
    ) -> AppResult<Vec<u8>> {
        let valor = self.tpv_server_post_json(mode, path, body).await?;
        serde_json::to_vec(&valor)
            .map_err(|e| AppError::internal(format!("respuesta no serializable ({:?})", e.classify())))
    }
    /// Solicita al worker un nuevo código de emparejamiento (modo `tpv`, firmado).
    /// Lo expone tipado a la UI para que el Main lo muestre (QR + código).
    async fn pair_create(&self) -> AppResult<PairCreateResult>;

    /// Sube los bytes de una imagen al worker (PUT firmado) → bucket R2. `path` es el path
    /// canónico (`/v1/images/images/{subcarpeta}/{archivo}`); el tenant lo deriva el worker
    /// del token, no del cliente. `mode` es el de firma (`tpv`|`handy`).
    ///
    /// AUD-06 · `negocio` es el del equipo cuando empezó la subida. Cada intento (también el que
    /// repite tras un rechazo por la hora, o tras renovar el token) lo compara con el del token con
    /// el que va a firmar, y si no es el mismo no sube: una imagen no acaba en el bucket de otro
    /// negocio porque la licencia cambie a media subida.
    async fn upload_image(
        &self,
        mode: &str,
        path: &str,
        content_type: &str,
        bytes: Vec<u8>,
        negocio: &str,
    ) -> AppResult<ResultadoSubidaImagen>;

    /// Borra una imagen del bucket R2 (DELETE firmado). `path` igual que en `upload_image`.
    async fn delete_image(&self, mode: &str, path: &str) -> AppResult<()>;

    /// Descarga los bytes de una imagen desde R2 (POST firmado a `/v1/images/download`). El
    /// tenant lo deriva el worker del token; `rel_path` es la ruta relativa de BD
    /// (`images/{subcarpeta}/{archivo}`). Devuelve `None` si el objeto aún no existe (404).
    async fn download_image(&self, mode: &str, rel_path: &str) -> AppResult<Option<Vec<u8>>>;
}
