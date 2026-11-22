//! El **PDF de las facturas completas**: componerlo una vez, guardarlo en el equipo y en la nube.
//!
//! Una factura completa (un alta de `Registros_Facturacion` con destinatario: `F1`, `F3` y las
//! rectificativas con cliente) tiene su PDF A4, con lo mismo que su papel (`use_cases::tickets`).
//! Se compone **una vez**, después del cobro o de la emisión y nunca dentro de su transacción, y no
//! se vuelve a componer: es el documento que se entregó. Por eso la nube va primero: en un equipo
//! restaurado, el PDF de una factura antigua es el que se subió el día que se emitió, no uno nuevo
//! con los datos del negocio de hoy.
//!
//! Lo mueve el job `facturas_pdf` (`pasada`) y, cuando la pantalla pide una que todavía no está,
//! [`pdf_de_factura`]. Lo de cada factura se anota en `_Facturas_Pdf`, estado local del equipo.
//!
//! - **Sin PDF local**: se baja de la nube; si no lo tiene, se compone aquí. Si consta que la nube
//!   lo tiene (una copia restaurada), la nube va antes que lo que haya en la carpeta.
//! - **Sin subir**: se sube. La nube no sobrescribe; si ya tenía uno («ya estaba») y el de aquí lo
//!   compuso este equipo, se cambia por el de la nube, que es el que se emitió, y no se da por
//!   subido hasta que se ha cambiado. Por eso uno compuesto aquí vuelve siempre a la subida, aunque
//!   la nube constara con el suyo (`anotar_local`).
//! - **No se compone con el histórico a medias** (SYNC-19): sus líneas pueden no haber bajado
//!   todavía, y lo compuesto se quedaría así para siempre. Bajar de la nube sí; la que la nube no
//!   tiene espera [`ESPERA_HISTORICO_MS`] antes de volver a preguntar, sin contar como intento.
//! - Un fallo al componer se anota en la fila con una espera que crece (`espera_tras_fallos`) y no
//!   frena a las demás. Un fallo de la nube (sin red, credenciales, un fallo suyo) no es de la
//!   factura: no cuenta como intento, y la pasada deja la nube para la siguiente.

use async_trait::async_trait;

use crate::error::{AppError, AppResult};
use crate::ports::clientes::ClientesRepository;
use crate::ports::configuracion::ConfiguracionRepository;
use crate::ports::facturas_pdf::{
    ArchivoFacturas, CobroDeLaFactura, EstadoPdfFactura, FacturasDeClienteRepository, FacturasNube,
    FacturasPdfRepository, GeneradorFacturas, MaquetaFactura, OrigenPdf, SubidaFactura,
};
use crate::ports::tickets::TicketsRepository;
use tpv_contracts::clientes::{ClaseFactura, FacturaDelCliente, FacturasDelCliente};
use tpv_contracts::impresion::TicketDePagoInput;
use tpv_domain::verifactu::normalizar_nif;

/// Cuántas facturas se documentan y cuántas se suben, como mucho, en cada pasada. Tras restaurar un
/// equipo con años de facturas, las baja a este ritmo sin acaparar la red ni el disco.
pub const LIMITE_POR_PASADA: i64 = 30;

/// La espera tras el primer fallo al componer una factura; se dobla con cada fallo seguido.
pub const ESPERA_BASE_MS: i64 = 60 * 1000;

/// Lo más que se espera entre dos intentos de componer la misma factura.
pub const ESPERA_TECHO_MS: i64 = 6 * 60 * 60 * 1000;

/// Lo más que se deja la nube sin intentar tras un fallo suyo.
pub const PAUSA_NUBE_TECHO_MS: i64 = 30 * 60 * 1000;

/// Con el histórico a medias, cuánto se tarda en volver a preguntar a la nube por una factura que
/// no tiene: mientras, la pasada sigue con otras en vez de preguntar cada minuto por las mismas.
pub const ESPERA_HISTORICO_MS: i64 = 15 * 60 * 1000;

/// Lo que se le dice a la pantalla cuando pide el PDF de algo que no es una factura completa.
pub const MSG_NO_ES_FACTURA_COMPLETA: &str = "Esa factura no existe o no lleva los datos de un cliente.";

/// Lo que se le dice cuando el PDF no está y no se puede componer todavía.
pub const MSG_HISTORICO_A_MEDIAS: &str =
    "Todavía se está bajando el histórico de la nube: el PDF de esta factura estará cuando acabe.";

/// Cuántas facturas de un cliente enseña su ficha, como mucho: las más recientes.
pub const LIMITE_FACTURAS_DEL_CLIENTE: i64 = 200;

/// Lo que se dice cuando se piden las facturas de una ficha que no existe.
pub const MSG_CLIENTE_NO_EXISTE: &str = "Ese cliente ya no existe: vuelve a la lista de clientes.";

/// ¿Empiezan estos bytes como un PDF? Es lo que comprueba también la nube al recibirlo.
pub fn es_pdf(bytes: &[u8]) -> bool {
    bytes.starts_with(b"%PDF-")
}

/// La espera hasta el siguiente intento de componer una factura que ha fallado `intentos` veces
/// seguidas (1 o más): un minuto, dos, cuatro… hasta seis horas.
pub fn espera_tras_fallos(intentos: i64) -> i64 {
    let exp = intentos.saturating_sub(1).clamp(0, 30) as u32;
    ESPERA_BASE_MS.saturating_mul(2i64.saturating_pow(exp)).min(ESPERA_TECHO_MS)
}

/// Cuándo se vuelve a hablar con la nube tras un fallo suyo. Vive en memoria del proceso: un
/// equipo sin red no le pregunta cada minuto, sino al minuto, a los dos, a los cuatro… hasta media
/// hora; y al reiniciar se vuelve a probar enseguida.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct PausaNube {
    fallos: u32,
    hasta_ms: i64,
}

impl PausaNube {
    /// ¿Hay que dejar la nube en paz en este momento?
    pub fn activa(&self, ahora_ms: i64) -> bool {
        self.fallos > 0 && ahora_ms < self.hasta_ms
    }

    /// La nube ha fallado: la espera siguiente es el doble que la anterior.
    pub fn fallo(&mut self, ahora_ms: i64) {
        self.fallos = self.fallos.saturating_add(1);
        let exp = self.fallos.saturating_sub(1).min(30);
        let espera = ESPERA_BASE_MS.saturating_mul(2i64.saturating_pow(exp)).min(PAUSA_NUBE_TECHO_MS);
        self.hasta_ms = ahora_ms.saturating_add(espera);
    }

    /// La nube ha contestado: se acabó la pausa.
    pub fn exito(&mut self) {
        *self = PausaNube::default();
    }
}

/// Lo que hace falta para documentar las facturas.
pub struct Facturas<'a> {
    pub repo: &'a dyn FacturasPdfRepository,
    pub archivos: &'a dyn ArchivoFacturas,
    pub generador: &'a dyn GeneradorFacturas,
    /// `None`: esta vez no se habla con la nube (conectividad apagada, base sin negocio o la nube
    /// en pausa).
    pub nube: Option<&'a dyn FacturasNube>,
}

/// Lo que ha hecho una pasada.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Pasada {
    pub apuntadas: u64,
    pub bajadas: u32,
    pub generadas: u32,
    pub subidas: u32,
    pub apartadas: u32,
    /// Las que no se han podido componer (quedan con su espera).
    pub fallidas: u32,
    /// Las que esperan a que acabe de bajar el histórico para poder componerse.
    pub en_espera: u32,
    /// Si la nube ha fallado, por qué: se ha dejado de hablar con ella en esta pasada.
    pub fallo_de_la_nube: Option<String>,
    /// Si se ha hablado con la nube y ha contestado.
    pub nube_contesto: bool,
}

/// Una pasada del job: apunta las facturas nuevas, documenta las que no tienen PDF local y sube
/// las que la nube no tiene. Idempotente: lo hecho queda anotado y no se repite.
///
/// `se_puede_generar` es `false` mientras se baja el histórico de una recuperación.
///
/// Un `Err` es una avería local (la base o la carpeta de las facturas); lo de cada factura queda en
/// su fila y lo de la nube en [`Pasada::fallo_de_la_nube`].
pub async fn pasada(f: &Facturas<'_>, ahora_ms: i64, se_puede_generar: bool) -> AppResult<Pasada> {
    let mut p = Pasada { apuntadas: f.repo.apuntar_nuevas().await?, ..Pasada::default() };
    let mut nube = f.nube;

    for fila in f.repo.sin_pdf_local(ahora_ms, LIMITE_POR_PASADA).await? {
        documentar(f, &mut nube, &fila, ahora_ms, se_puede_generar, &mut p).await?;
    }

    if nube.is_some() {
        for fila in f.repo.sin_subir(LIMITE_POR_PASADA).await? {
            subir(f, &mut nube, &fila, ahora_ms, &mut p).await?;
            if nube.is_none() {
                break;
            }
        }
    }
    Ok(p)
}

/// El PDF de una factura para enseñarlo: el local; si no, el de la nube; y si no lo tiene, se
/// compone ahora (y se queda, como si lo hubiera hecho el job).
pub async fn pdf_de_factura(
    f: &Facturas<'_>,
    id_registro: &str,
    ahora_ms: i64,
    se_puede_generar: bool,
) -> AppResult<Vec<u8>> {
    let id = id_registro.trim();
    let cobro = match id {
        "" => None,
        id => f.repo.cobro_de_la_factura(id).await?,
    }
    .ok_or_else(|| AppError::not_found(MSG_NO_ES_FACTURA_COMPLETA))?;

    if let Some(local) = f.archivos.leer(id)?.filter(|b| es_pdf(b)) {
        if f.repo.estado(id).await?.and_then(|e| e.origen).is_none() {
            f.repo.anotar_local(id, &f.archivos.ruta(id), OrigenPdf::Generado, ahora_ms).await?;
        }
        return Ok(local);
    }

    if let Some(nube) = f.nube {
        // Si la nube no contesta, se compone aquí: quien lo pide quiere verlo ya. Al subirlo, si la
        // nube tenía otro, se cambia por el suyo (`subir`).
        if let Ok(Some(bajado)) = nube.bajar(id).await {
            if es_pdf(&bajado) {
                f.archivos.guardar(id, &bajado)?;
                f.repo.anotar_local(id, &f.archivos.ruta(id), OrigenPdf::Bajado, ahora_ms).await?;
                f.repo.anotar_subido(id, ahora_ms).await?;
                return Ok(bajado);
            }
        }
    }

    if !se_puede_generar {
        return Err(AppError::conflict(MSG_HISTORICO_A_MEDIAS));
    }
    let pdf = f.generador.generar(&cobro).await?;
    if !es_pdf(&pdf) {
        return Err(AppError::internal("lo compuesto para la factura no es un PDF"));
    }
    f.archivos.guardar(id, &pdf)?;
    f.repo.anotar_local(id, &f.archivos.ruta(id), OrigenPdf::Generado, ahora_ms).await?;
    Ok(pdf)
}

/// Deja el PDF local de una factura que no lo tiene: el que ya esté en la carpeta, el de la nube o
/// uno compuesto aquí.
async fn documentar(
    f: &Facturas<'_>,
    nube: &mut Option<&dyn FacturasNube>,
    fila: &EstadoPdfFactura,
    ahora_ms: i64,
    se_puede_generar: bool,
    p: &mut Pasada,
) -> AppResult<()> {
    let id = fila.id_registro.as_str();
    let ruta = f.archivos.ruta(id);
    // La nube ya lo tiene: lo confirmó antes de que se perdiera el local, o lo dice la copia
    // restaurada (`olvidar_los_pdf_locales`). El suyo es el que se emitió y va antes que la carpeta.
    let en_la_nube = fila.subido_ms.is_some();

    // Ya está en la carpeta: una base restaurada de una copia que no lo tenía anotado. No se
    // vuelve a componer: es el que se hizo. Se anota como compuesto aquí, así que se sube, y si la
    // nube tenía otro se cambia por el suyo (`subir`).
    let en_la_carpeta = || f.archivos.leer(id).map(|b| b.is_some_and(|b| es_pdf(&b)));
    if !en_la_nube && en_la_carpeta()? {
        f.repo.anotar_local(id, &ruta, OrigenPdf::Generado, ahora_ms).await?;
        return Ok(());
    }

    // La nube primero: si lo tiene, es el que se emitió.
    let mut no_lo_tiene = false;
    if let Some(n) = *nube {
        match n.bajar(id).await {
            Ok(Some(bajado)) if es_pdf(&bajado) => {
                p.nube_contesto = true;
                f.archivos.guardar(id, &bajado)?;
                f.repo.anotar_local(id, &ruta, OrigenPdf::Bajado, ahora_ms).await?;
                f.repo.anotar_subido(id, ahora_ms).await?;
                p.bajadas += 1;
                return Ok(());
            }
            // No lo tiene (o lo que tiene no es un PDF, que la nube no deja subir): se compone.
            Ok(_) => {
                p.nube_contesto = true;
                no_lo_tiene = true;
            }
            Err(e) => {
                p.fallo_de_la_nube = Some(e.to_string());
                *nube = None;
            }
        }
    }

    if en_la_nube && en_la_carpeta()? {
        f.repo.anotar_local(id, &ruta, OrigenPdf::Generado, ahora_ms).await?;
        return Ok(());
    }

    if !se_puede_generar {
        p.en_espera += 1;
        // La nube ha dicho que no lo tiene: no se le vuelve a preguntar en cada pasada, que así
        // sigue con las demás (no cuenta como intento: no es un fallo de la factura).
        if no_lo_tiene {
            f.repo.aplazar(id, ahora_ms.saturating_add(ESPERA_HISTORICO_MS)).await?;
        }
        return Ok(());
    }

    let compuesto = match f.repo.cobro_de_la_factura(id).await? {
        None => Err(AppError::not_found("No se encuentra el cobro de la factura.")),
        Some(cobro) => f.generador.generar(&cobro).await.and_then(|pdf| {
            if es_pdf(&pdf) {
                Ok(pdf)
            } else {
                Err(AppError::internal("lo compuesto para la factura no es un PDF"))
            }
        }),
    };
    match compuesto {
        Ok(pdf) => {
            // Una carpeta en la que no se puede escribir es una avería del equipo, no de la factura.
            f.archivos.guardar(id, &pdf)?;
            f.repo.anotar_local(id, &ruta, OrigenPdf::Generado, ahora_ms).await?;
            p.generadas += 1;
        }
        Err(e) => {
            let intentos = fila.intentos + 1;
            f.repo
                .anotar_fallo(id, &e.to_string(), ahora_ms.saturating_add(espera_tras_fallos(intentos)))
                .await?;
            p.fallidas += 1;
        }
    }
    Ok(())
}

/// Sube a la nube el PDF local de una factura.
async fn subir(
    f: &Facturas<'_>,
    nube: &mut Option<&dyn FacturasNube>,
    fila: &EstadoPdfFactura,
    ahora_ms: i64,
    p: &mut Pasada,
) -> AppResult<()> {
    let Some(n) = *nube else { return Ok(()) };
    let id = fila.id_registro.as_str();

    let Some(local) = f.archivos.leer(id)?.filter(|b| es_pdf(b)) else {
        // Anotado y no está (o no es un PDF): se vuelve a documentar en la pasada siguiente.
        f.repo.olvidar_local(id).await?;
        return Ok(());
    };

    match n.subir(id, &local).await {
        Ok(SubidaFactura::Guardada) => {
            p.nube_contesto = true;
            f.repo.anotar_subido(id, ahora_ms).await?;
            p.subidas += 1;
        }
        Ok(SubidaFactura::YaEstaba) => {
            p.nube_contesto = true;
            // La nube ya tenía uno y no lo cambia. Si el de aquí lo compuso este equipo (sin red,
            // tras restaurar), el bueno es el de la nube: el que se emitió. Hasta que se haya
            // cambiado no se anota como subido: si la bajada falla, la pasada siguiente lo repite.
            if fila.origen == Some(OrigenPdf::Generado) {
                match n.bajar(id).await {
                    Ok(Some(bajado)) if es_pdf(&bajado) => {
                        if bajado != local {
                            f.archivos.guardar(id, &bajado)?;
                            f.repo.anotar_local(id, &f.archivos.ruta(id), OrigenPdf::Bajado, ahora_ms).await?;
                        }
                    }
                    // Dice que lo tiene y no lo da: se queda el de aquí.
                    Ok(_) => {}
                    Err(e) => {
                        p.fallo_de_la_nube = Some(e.to_string());
                        *nube = None;
                        return Ok(());
                    }
                }
            }
            f.repo.anotar_subido(id, ahora_ms).await?;
            p.subidas += 1;
        }
        Ok(SubidaFactura::Rechazada { motivo }) => {
            p.nube_contesto = true;
            f.repo.apartar(id, &motivo).await?;
            p.apartadas += 1;
        }
        Err(e) => {
            p.fallo_de_la_nube = Some(e.to_string());
            *nube = None;
        }
    }
    Ok(())
}

/// Qué es una factura completa, por su tipo: una `F3` sustituye a tickets, una `R` rectifica, y lo
/// demás (`F1`) es la factura de un cobro.
pub fn clase_de_factura(tipo_factura: &str) -> ClaseFactura {
    match tipo_factura.trim() {
        "F3" => ClaseFactura::Sustitutiva,
        t if t.starts_with('R') => ClaseFactura::Rectificativa,
        _ => ClaseFactura::Factura,
    }
}

/// Las facturas completas de una ficha de cliente: las de su NIF, de la más reciente a la más
/// antigua y [`LIMITE_FACTURAS_DEL_CLIENTE`] como mucho. Una ficha sin NIF no tiene: no hay con qué
/// saber cuáles son suyas.
pub async fn facturas_de_cliente(
    clientes: &dyn ClientesRepository,
    facturas: &dyn FacturasDeClienteRepository,
    id_cliente: &str,
) -> AppResult<FacturasDelCliente> {
    let id = id_cliente.trim();
    let ficha = match id {
        "" => None,
        id => clientes.form(id).await?,
    }
    .ok_or_else(|| AppError::not_found(MSG_CLIENTE_NO_EXISTE))?;

    let nif = ficha.nif.as_deref().map(normalizar_nif).filter(|n| !n.is_empty());
    let Some(nif) = nif else {
        return Ok(FacturasDelCliente { nif: None, facturas: Vec::new(), hay_mas: false });
    };

    let mut filas = facturas.facturas_del_nif(&nif, LIMITE_FACTURAS_DEL_CLIENTE + 1).await?;
    let hay_mas = filas.len() as i64 > LIMITE_FACTURAS_DEL_CLIENTE;
    filas.truncate(LIMITE_FACTURAS_DEL_CLIENTE as usize);
    Ok(FacturasDelCliente {
        nif: Some(nif),
        facturas: filas
            .into_iter()
            .map(|f| FacturaDelCliente {
                clase: clase_de_factura(&f.tipo_factura),
                id_registro: f.id_registro,
                num_serie: f.num_serie,
                fecha_expedicion: f.fecha_expedicion,
                tipo_factura: f.tipo_factura,
                importe: f.importe,
                id_pago: f.id_pago,
                anulada: f.anulada,
            })
            .collect(),
        hay_mas,
    })
}

/// Compone el PDF de una factura con su papel: el mismo `ticket_de_pago` que se imprime, pedido
/// por el número de la factura, maquetado en A4.
pub struct PapelDeLaFactura<'a> {
    pub tickets: &'a dyn TicketsRepository,
    pub config: &'a dyn ConfiguracionRepository,
    pub maqueta: &'a dyn MaquetaFactura,
}

#[async_trait]
impl GeneradorFacturas for PapelDeLaFactura<'_> {
    async fn generar(&self, cobro: &CobroDeLaFactura) -> AppResult<Vec<u8>> {
        let input = TicketDePagoInput {
            id_pago: cobro.id_pago.clone(),
            es_copia: false,
            num_factura: Some(cobro.num_serie.clone()),
        };
        let papel = super::tickets::ticket_de_pago(self.tickets, self.config, &input).await?;
        // El papel tiene que ser el de esa factura: si no, el PDF diría otra cosa que su registro.
        if papel.numero_ticket.as_deref().map(str::trim) != Some(cobro.num_serie.trim()) {
            return Err(AppError::internal("el papel compuesto no es el de la factura"));
        }
        self.maqueta.pdf(papel).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    const PDF: &[u8] = b"%PDF-1.4 compuesto aqui";
    const PDF_NUBE: &[u8] = b"%PDF-1.4 el que se emitio";
    const AHORA: i64 = 1_000_000_000;

    /// `_Facturas_Pdf` en memoria, con las facturas completas que hay en la base.
    #[derive(Default)]
    struct Repo {
        completas: Vec<String>,
        filas: Mutex<HashMap<String, EstadoPdfFactura>>,
        sin_cobro: Vec<String>,
    }

    impl Repo {
        fn con(ids: &[&str]) -> Self {
            Repo { completas: ids.iter().map(|s| s.to_string()).collect(), ..Repo::default() }
        }
        fn fila(&self, id: &str) -> EstadoPdfFactura {
            self.filas.lock().unwrap().get(id).cloned().unwrap()
        }
        fn nueva(id: &str) -> EstadoPdfFactura {
            EstadoPdfFactura {
                id_registro: id.into(),
                origen: None,
                generado_ms: None,
                subido_ms: None,
                intentos: 0,
                ultimo_error: None,
                proximo_intento_ms: None,
                apartado: false,
            }
        }
        fn editar(&self, id: &str, cambio: impl FnOnce(&mut EstadoPdfFactura)) {
            let mut filas = self.filas.lock().unwrap();
            cambio(filas.entry(id.to_string()).or_insert_with(|| Repo::nueva(id)));
        }
    }

    #[async_trait]
    impl FacturasPdfRepository for Repo {
        async fn apuntar_nuevas(&self) -> AppResult<u64> {
            let mut filas = self.filas.lock().unwrap();
            let mut n = 0;
            for id in &self.completas {
                if !filas.contains_key(id) {
                    filas.insert(id.clone(), Repo::nueva(id));
                    n += 1;
                }
            }
            Ok(n)
        }
        async fn sin_pdf_local(&self, ahora: i64, limite: i64) -> AppResult<Vec<EstadoPdfFactura>> {
            let filas = self.filas.lock().unwrap();
            let mut v: Vec<_> = filas
                .values()
                .filter(|e| e.generado_ms.is_none() && e.proximo_intento_ms.is_none_or(|p| p <= ahora))
                .cloned()
                .collect();
            v.sort_by(|a, b| a.id_registro.cmp(&b.id_registro));
            v.truncate(limite as usize);
            Ok(v)
        }
        async fn sin_subir(&self, limite: i64) -> AppResult<Vec<EstadoPdfFactura>> {
            let filas = self.filas.lock().unwrap();
            let mut v: Vec<_> = filas
                .values()
                .filter(|e| e.generado_ms.is_some() && e.subido_ms.is_none() && !e.apartado)
                .cloned()
                .collect();
            v.sort_by(|a, b| a.id_registro.cmp(&b.id_registro));
            v.truncate(limite as usize);
            Ok(v)
        }
        async fn estado(&self, id: &str) -> AppResult<Option<EstadoPdfFactura>> {
            Ok(self.filas.lock().unwrap().get(id).cloned())
        }
        async fn cobro_de_la_factura(&self, id: &str) -> AppResult<Option<CobroDeLaFactura>> {
            if !self.completas.iter().any(|c| c == id) || self.sin_cobro.iter().any(|c| c == id) {
                return Ok(None);
            }
            Ok(Some(CobroDeLaFactura { id_pago: format!("pago-{id}"), num_serie: format!("F-{id}") }))
        }
        async fn anotar_local(&self, id: &str, _ruta: &str, origen: OrigenPdf, ahora: i64) -> AppResult<()> {
            self.editar(id, |e| {
                if origen == OrigenPdf::Generado {
                    e.subido_ms = None;
                }
                e.origen = Some(origen);
                e.generado_ms = Some(ahora);
                e.intentos = 0;
                e.ultimo_error = None;
                e.proximo_intento_ms = None;
            });
            Ok(())
        }
        async fn olvidar_local(&self, id: &str) -> AppResult<()> {
            self.editar(id, |e| {
                e.origen = None;
                e.generado_ms = None;
            });
            Ok(())
        }
        async fn anotar_subido(&self, id: &str, ahora: i64) -> AppResult<()> {
            self.editar(id, |e| e.subido_ms = Some(ahora));
            Ok(())
        }
        async fn anotar_fallo(&self, id: &str, motivo: &str, proximo: i64) -> AppResult<()> {
            self.editar(id, |e| {
                e.intentos += 1;
                e.ultimo_error = Some(motivo.into());
                e.proximo_intento_ms = Some(proximo);
            });
            Ok(())
        }
        async fn apartar(&self, id: &str, motivo: &str) -> AppResult<()> {
            self.editar(id, |e| {
                e.apartado = true;
                e.ultimo_error = Some(motivo.into());
            });
            Ok(())
        }
        async fn aplazar(&self, id: &str, proximo: i64) -> AppResult<()> {
            self.editar(id, |e| e.proximo_intento_ms = Some(proximo));
            Ok(())
        }
    }

    #[derive(Default)]
    struct Carpeta(Mutex<HashMap<String, Vec<u8>>>);

    impl Carpeta {
        fn de(&self, id: &str) -> Option<Vec<u8>> {
            self.0.lock().unwrap().get(id).cloned()
        }
    }

    impl ArchivoFacturas for Carpeta {
        fn ruta(&self, id: &str) -> String {
            format!("facturas/{id}.pdf")
        }
        fn leer(&self, id: &str) -> AppResult<Option<Vec<u8>>> {
            Ok(self.de(id))
        }
        fn guardar(&self, id: &str, pdf: &[u8]) -> AppResult<()> {
            self.0.lock().unwrap().insert(id.into(), pdf.to_vec());
            Ok(())
        }
    }

    /// La nube: lo que tiene, y si está caída.
    #[derive(Default)]
    struct Nube {
        tiene: Mutex<HashMap<String, Vec<u8>>>,
        caida: bool,
        /// Acepta la subida pero falla al bajar (la red que se corta entre las dos peticiones).
        falla_al_bajar: bool,
        rechaza: bool,
        bajadas: Mutex<u32>,
        subidas: Mutex<u32>,
    }

    #[async_trait]
    impl FacturasNube for Nube {
        async fn subir(&self, id: &str, pdf: &[u8]) -> AppResult<SubidaFactura> {
            *self.subidas.lock().unwrap() += 1;
            if self.caida {
                return Err(AppError::sin_conexion("prueba"));
            }
            if self.rechaza {
                return Ok(SubidaFactura::Rechazada { motivo: "factura_no_es_pdf".into() });
            }
            let mut tiene = self.tiene.lock().unwrap();
            if tiene.contains_key(id) {
                return Ok(SubidaFactura::YaEstaba);
            }
            tiene.insert(id.into(), pdf.to_vec());
            Ok(SubidaFactura::Guardada)
        }
        async fn bajar(&self, id: &str) -> AppResult<Option<Vec<u8>>> {
            *self.bajadas.lock().unwrap() += 1;
            if self.caida || self.falla_al_bajar {
                return Err(AppError::sin_conexion("prueba"));
            }
            Ok(self.tiene.lock().unwrap().get(id).cloned())
        }
    }

    #[derive(Default)]
    struct Generador {
        veces: Mutex<u32>,
        falla: bool,
    }

    #[async_trait]
    impl GeneradorFacturas for Generador {
        async fn generar(&self, _: &CobroDeLaFactura) -> AppResult<Vec<u8>> {
            *self.veces.lock().unwrap() += 1;
            if self.falla {
                return Err(AppError::internal("no se pudo maquetar"));
            }
            Ok(PDF.to_vec())
        }
    }

    fn facturas<'a>(r: &'a Repo, c: &'a Carpeta, g: &'a Generador, n: Option<&'a Nube>) -> Facturas<'a> {
        Facturas { repo: r, archivos: c, generador: g, nube: n.map(|n| n as &dyn FacturasNube) }
    }

    #[tokio::test]
    async fn una_factura_nueva_se_compone_y_se_sube() {
        let (r, c, g, n) = (Repo::con(&["a"]), Carpeta::default(), Generador::default(), Nube::default());
        let p = pasada(&facturas(&r, &c, &g, Some(&n)), AHORA, true).await.unwrap();

        assert_eq!((p.apuntadas, p.generadas, p.subidas, p.bajadas), (1, 1, 1, 0));
        assert_eq!(c.de("a").as_deref(), Some(PDF));
        assert_eq!(n.tiene.lock().unwrap().get("a").map(Vec::as_slice), Some(PDF));
        let fila = r.fila("a");
        assert_eq!(fila.origen, Some(OrigenPdf::Generado));
        assert!(fila.subido_ms.is_some());
    }

    #[tokio::test]
    async fn repetir_la_pasada_no_vuelve_a_componer_ni_a_subir() {
        let (r, c, g, n) = (Repo::con(&["a"]), Carpeta::default(), Generador::default(), Nube::default());
        let f = facturas(&r, &c, &g, Some(&n));
        pasada(&f, AHORA, true).await.unwrap();
        let p = pasada(&f, AHORA + 60_000, true).await.unwrap();

        assert_eq!(p, Pasada { nube_contesto: false, ..Pasada::default() });
        assert_eq!(*g.veces.lock().unwrap(), 1);
        assert_eq!(*n.subidas.lock().unwrap(), 1);
    }

    #[tokio::test]
    async fn si_la_nube_lo_tiene_se_baja_y_no_se_compone() {
        // Un equipo restaurado: el PDF es el que se emitió, no uno nuevo con los datos de hoy.
        let (r, c, g, n) = (Repo::con(&["a"]), Carpeta::default(), Generador::default(), Nube::default());
        n.tiene.lock().unwrap().insert("a".into(), PDF_NUBE.to_vec());

        let p = pasada(&facturas(&r, &c, &g, Some(&n)), AHORA, true).await.unwrap();

        assert_eq!((p.bajadas, p.generadas, p.subidas), (1, 0, 0));
        assert_eq!(*g.veces.lock().unwrap(), 0);
        assert_eq!(*n.subidas.lock().unwrap(), 0);
        assert_eq!(c.de("a").as_deref(), Some(PDF_NUBE));
        assert_eq!(r.fila("a").origen, Some(OrigenPdf::Bajado));
        assert!(r.fila("a").subido_ms.is_some());
    }

    #[tokio::test]
    async fn el_que_ya_esta_en_la_carpeta_no_se_vuelve_a_componer() {
        let (r, c, g, n) = (Repo::con(&["a"]), Carpeta::default(), Generador::default(), Nube::default());
        c.guardar("a", PDF_NUBE).unwrap();

        let p = pasada(&facturas(&r, &c, &g, Some(&n)), AHORA, true).await.unwrap();

        assert_eq!(*g.veces.lock().unwrap(), 0);
        assert_eq!(*n.bajadas.lock().unwrap(), 0);
        assert_eq!(c.de("a").as_deref(), Some(PDF_NUBE));
        // Y se sube, que la nube no lo tenía.
        assert_eq!(p.subidas, 1);
    }

    #[tokio::test]
    async fn sin_red_se_compone_igual_y_se_sube_cuando_vuelve() {
        let (r, c, g) = (Repo::con(&["a", "b"]), Carpeta::default(), Generador::default());
        let caida = Nube { caida: true, ..Nube::default() };

        let p = pasada(&facturas(&r, &c, &g, Some(&caida)), AHORA, true).await.unwrap();
        assert_eq!(p.generadas, 2);
        assert!(p.fallo_de_la_nube.is_some());
        // Al primer fallo se deja la nube: no se le pregunta por cada factura.
        assert_eq!(*caida.bajadas.lock().unwrap(), 1);
        assert_eq!(*caida.subidas.lock().unwrap(), 0);
        // Un fallo de la red no es de la factura: no cuenta como intento.
        assert_eq!(r.fila("a").intentos, 0);
        assert!(r.fila("a").subido_ms.is_none());

        let n = Nube::default();
        let p = pasada(&facturas(&r, &c, &g, Some(&n)), AHORA + 60_000, true).await.unwrap();
        assert_eq!((p.subidas, p.generadas), (2, 0));
    }

    #[tokio::test]
    async fn si_la_nube_ya_tenia_otro_se_queda_el_suyo() {
        // Compuesto sin red tras restaurar; la nube tenía el que se emitió y no lo cambia.
        let (r, c, g) = (Repo::con(&["a"]), Carpeta::default(), Generador::default());
        let caida = Nube { caida: true, ..Nube::default() };
        pasada(&facturas(&r, &c, &g, Some(&caida)), AHORA, true).await.unwrap();
        assert_eq!(c.de("a").as_deref(), Some(PDF));

        let n = Nube::default();
        n.tiene.lock().unwrap().insert("a".into(), PDF_NUBE.to_vec());
        pasada(&facturas(&r, &c, &g, Some(&n)), AHORA + 60_000, true).await.unwrap();

        assert_eq!(n.tiene.lock().unwrap().get("a").map(Vec::as_slice), Some(PDF_NUBE));
        assert_eq!(c.de("a").as_deref(), Some(PDF_NUBE));
        assert_eq!(r.fila("a").origen, Some(OrigenPdf::Bajado));
    }

    #[tokio::test]
    async fn si_la_nube_ya_tenia_otro_y_falla_la_bajada_se_vuelve_a_intentar() {
        // La nube contesta «ya estaba» y la red se corta antes de bajar el suyo: no se da por
        // subido, y la pasada siguiente lo cambia.
        let (r, c, g) = (Repo::con(&["a"]), Carpeta::default(), Generador::default());
        pasada(&facturas(&r, &c, &g, None), AHORA, true).await.unwrap();
        assert_eq!(c.de("a").as_deref(), Some(PDF));

        let cortada = Nube { falla_al_bajar: true, ..Nube::default() };
        cortada.tiene.lock().unwrap().insert("a".into(), PDF_NUBE.to_vec());
        let p = pasada(&facturas(&r, &c, &g, Some(&cortada)), AHORA + 60_000, true).await.unwrap();
        assert!(p.fallo_de_la_nube.is_some());
        assert!(r.fila("a").subido_ms.is_none());
        assert_eq!(c.de("a").as_deref(), Some(PDF));

        let n = Nube::default();
        n.tiene.lock().unwrap().insert("a".into(), PDF_NUBE.to_vec());
        pasada(&facturas(&r, &c, &g, Some(&n)), AHORA + 120_000, true).await.unwrap();
        assert_eq!(c.de("a").as_deref(), Some(PDF_NUBE));
        assert_eq!(r.fila("a").origen, Some(OrigenPdf::Bajado));
        assert!(r.fila("a").subido_ms.is_some());
    }

    #[tokio::test]
    async fn uno_compuesto_sin_nube_para_la_pantalla_se_cambia_por_el_que_se_emitio() {
        // Tras restaurar: la nube lo tiene (consta subido), el equipo no, y la pantalla lo pide sin
        // red. Se compone para enseñarlo, pero no se queda: el job sube, oye «ya estaba» y baja el
        // de la nube.
        let (r, c, g) = (Repo::con(&["a"]), Carpeta::default(), Generador::default());
        r.editar("a", |e| e.subido_ms = Some(1));
        assert_eq!(pdf_de_factura(&facturas(&r, &c, &g, None), "a", AHORA, true).await.unwrap(), PDF);

        let n = Nube::default();
        n.tiene.lock().unwrap().insert("a".into(), PDF_NUBE.to_vec());
        pasada(&facturas(&r, &c, &g, Some(&n)), AHORA + 60_000, true).await.unwrap();
        assert_eq!(c.de("a").as_deref(), Some(PDF_NUBE));
        assert_eq!(n.tiene.lock().unwrap().get("a").map(Vec::as_slice), Some(PDF_NUBE));
    }

    #[tokio::test]
    async fn si_la_nube_lo_tiene_va_antes_que_la_carpeta() {
        // Una copia restaurada dice que la nube lo tiene, y en la carpeta hay otro: se queda el de
        // la nube, sin subir nada.
        let (r, c, g, n) = (Repo::con(&["a"]), Carpeta::default(), Generador::default(), Nube::default());
        r.editar("a", |e| e.subido_ms = Some(1));
        c.guardar("a", PDF).unwrap();
        n.tiene.lock().unwrap().insert("a".into(), PDF_NUBE.to_vec());

        let p = pasada(&facturas(&r, &c, &g, Some(&n)), AHORA, true).await.unwrap();
        assert_eq!((p.bajadas, p.subidas, p.generadas), (1, 0, 0));
        assert_eq!(c.de("a").as_deref(), Some(PDF_NUBE));
        assert_eq!(*n.subidas.lock().unwrap(), 0);

        // Sin nube, la de la carpeta se anota y se comprueba al subirla.
        let (r, c, g) = (Repo::con(&["b"]), Carpeta::default(), Generador::default());
        r.editar("b", |e| e.subido_ms = Some(1));
        c.guardar("b", PDF).unwrap();
        pasada(&facturas(&r, &c, &g, None), AHORA, true).await.unwrap();
        assert_eq!(*g.veces.lock().unwrap(), 0);
        let fila = r.fila("b");
        assert_eq!((fila.origen, fila.subido_ms), (Some(OrigenPdf::Generado), None));
    }

    #[tokio::test]
    async fn sin_nube_se_compone_y_se_queda_por_subir() {
        let (r, c, g) = (Repo::con(&["a"]), Carpeta::default(), Generador::default());
        let p = pasada(&facturas(&r, &c, &g, None), AHORA, true).await.unwrap();
        assert_eq!((p.generadas, p.subidas), (1, 0));
        assert!(p.fallo_de_la_nube.is_none());
        assert!(r.fila("a").subido_ms.is_none());
    }

    #[tokio::test]
    async fn un_fallo_al_componer_espera_cada_vez_mas() {
        let (r, c, n) = (Repo::con(&["a"]), Carpeta::default(), Nube::default());
        let g = Generador { falla: true, ..Generador::default() };
        let f = facturas(&r, &c, &g, Some(&n));

        let p = pasada(&f, AHORA, true).await.unwrap();
        assert_eq!(p.fallidas, 1);
        let fila = r.fila("a");
        assert_eq!(fila.intentos, 1);
        assert_eq!(fila.proximo_intento_ms, Some(AHORA + ESPERA_BASE_MS));
        assert!(fila.ultimo_error.is_some());

        // Antes de su hora no se reintenta.
        pasada(&f, AHORA + ESPERA_BASE_MS - 1, true).await.unwrap();
        assert_eq!(*g.veces.lock().unwrap(), 1);

        // A su hora sí, y la espera siguiente es el doble.
        let t = AHORA + ESPERA_BASE_MS;
        pasada(&f, t, true).await.unwrap();
        assert_eq!(*g.veces.lock().unwrap(), 2);
        assert_eq!(r.fila("a").proximo_intento_ms, Some(t + 2 * ESPERA_BASE_MS));
    }

    #[tokio::test]
    async fn una_factura_que_falla_no_frena_a_las_demas() {
        let (c, g, n) = (Carpeta::default(), Generador::default(), Nube::default());
        let r = Repo { sin_cobro: vec!["a".into()], ..Repo::con(&["a", "b"]) };
        let p = pasada(&facturas(&r, &c, &g, Some(&n)), AHORA, true).await.unwrap();
        assert_eq!((p.fallidas, p.generadas, p.subidas), (1, 1, 1));
        assert!(c.de("b").is_some());
        assert!(c.de("a").is_none());
    }

    #[tokio::test]
    async fn con_el_historico_a_medias_se_baja_pero_no_se_compone() {
        let (r, c, g, n) = (Repo::con(&["a", "b"]), Carpeta::default(), Generador::default(), Nube::default());
        n.tiene.lock().unwrap().insert("a".into(), PDF_NUBE.to_vec());

        let p = pasada(&facturas(&r, &c, &g, Some(&n)), AHORA, false).await.unwrap();

        assert_eq!((p.bajadas, p.generadas, p.en_espera), (1, 0, 1));
        assert_eq!(*g.veces.lock().unwrap(), 0);
        assert!(c.de("b").is_none());
        // Y no cuenta como fallo: se compone cuando acabe.
        assert_eq!(r.fila("b").intentos, 0);
    }

    #[tokio::test]
    async fn con_el_historico_a_medias_no_se_pregunta_cada_minuto_por_lo_que_la_nube_no_tiene() {
        let (r, c, g, n) = (Repo::con(&["a"]), Carpeta::default(), Generador::default(), Nube::default());
        let f = facturas(&r, &c, &g, Some(&n));
        pasada(&f, AHORA, false).await.unwrap();
        assert_eq!(*n.bajadas.lock().unwrap(), 1);

        // La pasada siguiente no vuelve a preguntar por ella (sigue con las demás)…
        let p = pasada(&f, AHORA + 60_000, false).await.unwrap();
        assert_eq!(*n.bajadas.lock().unwrap(), 1);
        assert_eq!(p.en_espera, 0);
        assert_eq!(r.fila("a").intentos, 0);

        // …hasta pasado un rato; y si el histórico ha acabado, se compone.
        let p = pasada(&f, AHORA + ESPERA_HISTORICO_MS, true).await.unwrap();
        assert_eq!((p.generadas, p.subidas), (1, 1));
    }

    #[tokio::test]
    async fn lo_que_la_nube_rechaza_se_aparta_y_no_se_vuelve_a_subir() {
        let (r, c, g) = (Repo::con(&["a"]), Carpeta::default(), Generador::default());
        let n = Nube { rechaza: true, ..Nube::default() };
        let f = facturas(&r, &c, &g, Some(&n));
        let p = pasada(&f, AHORA, true).await.unwrap();
        assert_eq!(p.apartadas, 1);
        assert!(r.fila("a").apartado);

        pasada(&f, AHORA + 60_000, true).await.unwrap();
        assert_eq!(*n.subidas.lock().unwrap(), 1);
    }

    #[tokio::test]
    async fn la_pantalla_recibe_el_local_el_de_la_nube_o_uno_compuesto() {
        let (r, c, g, n) = (Repo::con(&["a", "b", "x"]), Carpeta::default(), Generador::default(), Nube::default());
        c.guardar("a", PDF_NUBE).unwrap();
        n.tiene.lock().unwrap().insert("b".into(), PDF_NUBE.to_vec());
        let f = facturas(&r, &c, &g, Some(&n));

        assert_eq!(pdf_de_factura(&f, "a", AHORA, true).await.unwrap(), PDF_NUBE);
        assert_eq!(*n.bajadas.lock().unwrap(), 0);

        assert_eq!(pdf_de_factura(&f, "b", AHORA, true).await.unwrap(), PDF_NUBE);
        assert_eq!(r.fila("b").origen, Some(OrigenPdf::Bajado));
        assert_eq!(*g.veces.lock().unwrap(), 0);

        assert_eq!(pdf_de_factura(&f, "x", AHORA, true).await.unwrap(), PDF);
        assert_eq!(c.de("x").as_deref(), Some(PDF));
        assert_eq!(r.fila("x").origen, Some(OrigenPdf::Generado));

        // Pedirlo otra vez no lo vuelve a componer.
        pdf_de_factura(&f, "x", AHORA, true).await.unwrap();
        assert_eq!(*g.veces.lock().unwrap(), 1);
    }

    #[tokio::test]
    async fn la_pantalla_no_recibe_nada_de_lo_que_no_es_una_factura_completa() {
        let (r, c, g, n) = (Repo::con(&["a"]), Carpeta::default(), Generador::default(), Nube::default());
        let f = facturas(&r, &c, &g, Some(&n));
        for id in ["", "  ", "ticket-simplificado"] {
            let e = pdf_de_factura(&f, id, AHORA, true).await.unwrap_err();
            assert!(matches!(e, AppError::NotFound(_)), "{id:?}: {e:?}");
        }
        let e = pdf_de_factura(&f, "a", AHORA, false).await.unwrap_err();
        assert!(matches!(e, AppError::Conflict(_)));
    }

    #[test]
    fn la_espera_entre_intentos_crece_y_tiene_techo() {
        assert_eq!(espera_tras_fallos(1), ESPERA_BASE_MS);
        assert_eq!(espera_tras_fallos(2), 2 * ESPERA_BASE_MS);
        assert_eq!(espera_tras_fallos(4), 8 * ESPERA_BASE_MS);
        assert_eq!(espera_tras_fallos(100), ESPERA_TECHO_MS);
        assert_eq!(espera_tras_fallos(0), ESPERA_BASE_MS);
    }

    #[test]
    fn sin_red_la_nube_se_deja_cada_vez_mas_rato() {
        let mut p = PausaNube::default();
        assert!(!p.activa(AHORA));
        p.fallo(AHORA);
        assert!(p.activa(AHORA + ESPERA_BASE_MS - 1));
        assert!(!p.activa(AHORA + ESPERA_BASE_MS));
        p.fallo(AHORA);
        assert!(p.activa(AHORA + 2 * ESPERA_BASE_MS - 1));
        for _ in 0..20 {
            p.fallo(AHORA);
        }
        assert!(!p.activa(AHORA + PAUSA_NUBE_TECHO_MS));
        p.exito();
        assert!(!p.activa(AHORA));
    }

    #[test]
    fn un_pdf_empieza_como_un_pdf() {
        assert!(es_pdf(b"%PDF-1.4\n"));
        assert!(!es_pdf(b""));
        assert!(!es_pdf(b"<html>"));
    }
}

#[cfg(test)]
mod tests_facturas_de_cliente {
    use super::*;
    use std::sync::Mutex;
    use crate::ports::facturas_pdf::FacturaCompleta;
    use tpv_contracts::clientes::{ClienteForm, ClienteOverview};
    use tpv_domain::clientes::{Cliente, ClienteRanking, NuevoCliente};
    use tpv_domain::dinero::Dinero;

    /// Una ficha, con o sin NIF.
    struct Fichas(Option<ClienteForm>);

    #[async_trait]
    impl ClientesRepository for Fichas {
        async fn overview(&self, _: ClienteRanking) -> AppResult<Vec<ClienteOverview>> {
            unreachable!()
        }
        async fn form(&self, _: &str) -> AppResult<Option<ClienteForm>> {
            Ok(self.0.clone())
        }
        async fn create(&self, _: NuevoCliente) -> AppResult<bool> {
            unreachable!()
        }
        async fn update(&self, _: Cliente) -> AppResult<bool> {
            unreachable!()
        }
    }

    /// `n` facturas de un NIF, y con qué NIF y qué límite se han pedido.
    struct Registros {
        n: usize,
        pedido: Mutex<Option<(String, i64)>>,
    }

    #[async_trait]
    impl FacturasDeClienteRepository for Registros {
        async fn facturas_del_nif(&self, nif: &str, limite: i64) -> AppResult<Vec<FacturaCompleta>> {
            *self.pedido.lock().unwrap() = Some((nif.to_string(), limite));
            let tipos = ["F1", "F3", "R1", "R5"];
            Ok((0..self.n.min(limite as usize))
                .map(|i| FacturaCompleta {
                    id_registro: format!("id-{i}"),
                    num_serie: format!("F-{i:06}"),
                    fecha_expedicion: "02-01-2026".into(),
                    tipo_factura: tipos[i % tipos.len()].into(),
                    importe: Dinero::de_centimos(510),
                    id_pago: Some(format!("p{i}")),
                    anulada: i == 1,
                })
                .collect())
        }
    }


    fn ficha(nif: Option<&str>) -> Fichas {
        Fichas(Some(ClienteForm {
            nombre: "Cliente".into(),
            email: None,
            telefono: None,
            notas: None,
            nif: nif.map(str::to_string),
            razon_social: None,
            direccion_fiscal: None,
        }))
    }

    fn registros(n: usize) -> Registros {
        Registros { n, pedido: Mutex::new(None) }
    }

    #[tokio::test]
    async fn se_buscan_por_el_nif_normalizado_de_la_ficha() {
        let r = registros(4);
        let out = facturas_de_cliente(&ficha(Some(" b-12345674 ")), &r, "c1").await.unwrap();
        assert_eq!(out.nif.as_deref(), Some("B12345674"));
        assert_eq!(r.pedido.lock().unwrap().clone(), Some(("B12345674".into(), LIMITE_FACTURAS_DEL_CLIENTE + 1)));
        let clases: Vec<_> = out.facturas.iter().map(|f| f.clase).collect();
        assert_eq!(
            clases,
            [ClaseFactura::Factura, ClaseFactura::Sustitutiva, ClaseFactura::Rectificativa, ClaseFactura::Rectificativa]
        );
        // La que está anulada llega dicha a la pantalla.
        let anuladas: Vec<_> = out.facturas.iter().map(|f| f.anulada).collect();
        assert_eq!(anuladas, [false, true, false, false]);
        assert!(!out.hay_mas);
    }

    #[tokio::test]
    async fn una_ficha_sin_nif_no_tiene_facturas_y_no_se_buscan() {
        for nif in [None, Some(""), Some("  ")] {
            let r = registros(4);
            let out = facturas_de_cliente(&ficha(nif), &r, "c1").await.unwrap();
            assert_eq!(out, FacturasDelCliente { nif: None, facturas: vec![], hay_mas: false });
            assert!(r.pedido.lock().unwrap().is_none());
        }
    }

    #[tokio::test]
    async fn la_lista_tiene_techo_y_dice_si_hay_mas() {
        let todas = LIMITE_FACTURAS_DEL_CLIENTE as usize;
        let out = facturas_de_cliente(&ficha(Some("B12345674")), &registros(todas), "c1").await.unwrap();
        assert_eq!((out.facturas.len(), out.hay_mas), (todas, false));
        let out = facturas_de_cliente(&ficha(Some("B12345674")), &registros(todas + 5), "c1").await.unwrap();
        assert_eq!((out.facturas.len(), out.hay_mas), (todas, true));
    }

    #[tokio::test]
    async fn una_ficha_que_no_existe_es_not_found() {
        let e = facturas_de_cliente(&Fichas(None), &registros(1), "c1").await.unwrap_err();
        assert_eq!(e.to_string(), MSG_CLIENTE_NO_EXISTE);
        let e = facturas_de_cliente(&ficha(Some("B12345674")), &registros(1), "  ").await.unwrap_err();
        assert_eq!(e.to_string(), MSG_CLIENTE_NO_EXISTE);
    }
}
