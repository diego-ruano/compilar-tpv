//! Casos de uso del **cierre de caja** (arqueo). CUENTA-06 · CAJA-01.
//!
//! Corregir un apunte que pertenece a un cierre ya hecho no vive aquí sino en
//! `rectificacion_caja`: aquí están cerrar, consultar y deshacer.

use tpv_domain::dinero::Dinero;
use tpv_contracts::cierre_caja::{
    CierreDto, CierreResumenDto, ConfirmarCierreInput, PreparacionCierreDto,
};
use tpv_contracts::sync::BackfillEstado;
use tpv_domain::cierre_caja::{
    calcular, total_recuento, validar, Denominacion, UMBRAL_DESCUADRE_POR_DEFECTO,
};

use tpv_domain::notificaciones::{Destino, NuevaNotificacion, Severidad, ADMIN_ROL_ID};

use crate::error::{AppError, AppResult};
use crate::ports::cierre_caja::{CierreCajaRepository, CierreNuevo, PeriodoAbierto};
use crate::ports::notificaciones::Notifier;

fn a_denoms(input: &[tpv_contracts::cierre_caja::DenominacionInput]) -> Vec<Denominacion> {
    input
        .iter()
        .map(|d| Denominacion {
            valor: d.valor,
            unidades: d.unidades,
        })
        .collect()
}

fn umbral_o_defecto(umbral_descuadre: Dinero) -> Dinero {
    if umbral_descuadre > Dinero::CERO {
        umbral_descuadre
    } else {
        UMBRAL_DESCUADRE_POR_DEFECTO
    }
}

/// Lo que la pantalla necesita antes de que nadie cuente nada: desde cuándo está abierto el
/// periodo, cuánto se espera encontrar y si hay mesas sin cobrar.
///
/// `historico` es cómo va la descarga del histórico tras una recuperación (SYNC-19), si se sabe.
/// DO-02 («encoger y avisar»): un negocio que nunca ha cerrado la caja se recupera con lo
/// reciente y el resto baja después, así que su primer arqueo, que suma desde el principio, sólo
/// cuenta lo que haya bajado. No se le impide cerrar: se le avisa, con el progreso.
pub async fn preparar(
    repo: &dyn CierreCajaRepository,
    umbral_descuadre: Dinero,
    historico: Option<BackfillEstado>,
) -> AppResult<PreparacionCierreDto> {
    let ultimo = repo.ultimo_cierre().await?;
    let historico_pendiente = historico.filter(|h| ultimo.is_none() && h.tablas_pendientes > 0);
    let desde = ultimo.as_ref().map(|c| c.fecha_hora.clone());
    let fondo_inicial = ultimo.as_ref().map(|c| c.dejado).unwrap_or(Dinero::CERO);

    let totales = repo.totales_desde(desde.as_deref()).await?;
    let comandas_abiertas = repo.comandas_abiertas().await?;
    // Informativo, fuera del cálculo (CUENTA-07): el esperado sigue saliendo de los cobros
    // activos. Lo que aporta es contexto — un descuadre de 40 € con "3 anulaciones por 40 €" al
    // lado deja de ser un misterio.
    let (anulaciones, anulaciones_importe) = repo.anulaciones_desde(desde.as_deref()).await?;

    // Sin recuento todavía: sólo interesa el esperado, que no depende de lo contado.
    let calculo = calcular(
        fondo_inicial,
        totales.ventas_efectivo,
        totales.gastos_caja,
        Dinero::CERO,
        Dinero::CERO,
    );

    Ok(PreparacionCierreDto {
        es_primer_cierre: ultimo.is_none(),
        desde,
        fondo_inicial,
        ventas_efectivo: calculo.ventas_efectivo,
        gastos_caja: calculo.gastos_caja,
        esperado: calculo.esperado,
        comandas_abiertas,
        umbral_descuadre: umbral_o_defecto(umbral_descuadre),
        anulaciones,
        anulaciones_importe,
        historico_pendiente,
    })
}

/// Cierra el periodo.
///
/// El fondo de partida **no se acepta de la entrada salvo en el primer cierre**: en los demás lo
/// manda el `dejado` del anterior. Si se admitiera siempre, cualquiera podría reescribir el punto de
/// partida a posteriori y hacer que un descuadre desapareciera cambiando un número.
///
/// Las ventas y los gastos de caja también se recalculan aquí, no se reciben: son el esperado, y
/// aceptarlos de fuera sería dejar que la pantalla decidiera cuánto debería haber en el cajón.
///
/// Se guarda desde cuándo cuenta el cierre (`periodo_desde`, CAJA-01): es lo que permite saber
/// después a qué cierre pertenece un apunte que se corrige.
///
/// `id_usuario` es un parámetro y no un campo del input **a propósito** (SEC-01): quien firma
/// el arqueo lo pone la sesión del backend, así que no puede llegar por el mismo camino que los
/// datos que sí escribe la pantalla.
///
/// ## Una sola vez y en una sola transacción (RI-58)
///
/// El id lo genera la pantalla al abrir el cierre (`input.id_cierre`), así que confirmar dos veces
/// —un doble clic, un reintento tras una respuesta que no llegó— devuelve el mismo cierre en vez de
/// crear un segundo arqueo con un periodo vacío. Y leer el último cierre, sumar y guardar ocurren en
/// la misma transacción del escritor: antes los totales se leían por el pool de lectura y el
/// `INSERT` iba después, con su propia hora, y un cobro confirmado entre las dos cosas caía dentro
/// del periodo cerrado pero fuera de sus cifras.
pub async fn confirmar(
    repo: &dyn CierreCajaRepository,
    id_usuario: Option<&str>,
    input: ConfirmarCierreInput,
    umbral_descuadre: Dinero,
) -> AppResult<CierreDto> {
    let id_cierre = input.id_cierre.trim().to_string();
    if id_cierre.is_empty() || id_cierre.len() > 64 {
        return Err(AppError::validation("Falta el identificador del cierre"));
    }

    let contado_denoms = a_denoms(&input.contado);
    let dejado_denoms = a_denoms(&input.dejado);
    let umbral = umbral_o_defecto(umbral_descuadre);

    let armar = |periodo: PeriodoAbierto| -> AppResult<CierreNuevo> {
        let fondo_inicial = match periodo.dejado_anterior {
            Some(dejado) => dejado,
            None => input.fondo_inicial.unwrap_or(Dinero::CERO),
        };
        if fondo_inicial.es_negativo() {
            return Err(AppError::validation("El fondo inicial no puede ser negativo"));
        }

        let calculo = calcular(
            fondo_inicial,
            periodo.totales.ventas_efectivo,
            periodo.totales.gastos_caja,
            total_recuento(&contado_denoms),
            total_recuento(&dejado_denoms),
        );

        let motivo =
            validar(&calculo, input.motivo.as_deref(), umbral).map_err(AppError::validation)?;

        Ok(CierreNuevo {
            id_cierre: id_cierre.clone(),
            id_usuario: id_usuario.map(str::to_string),
            periodo_desde: periodo.desde,
            fondo_inicial: calculo.fondo_inicial,
            ventas_efectivo: calculo.ventas_efectivo,
            gastos_caja: calculo.gastos_caja,
            esperado: calculo.esperado,
            contado: calculo.contado,
            descuadre: calculo.descuadre,
            dejado: calculo.dejado,
            retirado: calculo.retirado,
            motivo,
            contado_denoms: contado_denoms.clone(),
            dejado_denoms: dejado_denoms.clone(),
        })
    };

    repo.cerrar_periodo(&id_cierre, &armar).await?;

    repo.detalle(&id_cierre)
        .await?
        .ok_or_else(|| AppError::repository("el cierre no se pudo releer tras guardarlo"))
}

pub async fn listar(
    repo: &dyn CierreCajaRepository,
    limite: Option<i64>,
) -> AppResult<Vec<CierreResumenDto>> {
    repo.listar(limite.unwrap_or(50)).await
}

pub async fn detalle(repo: &dyn CierreCajaRepository, id_cierre: &str) -> AppResult<CierreDto> {
    repo.detalle(id_cierre)
        .await?
        .ok_or_else(|| AppError::not_found("Ese cierre no existe"))
}

/// Deshace un cierre para volver a contar el cajón. Queda registrado quién y cuándo.
///
/// **Sólo el último** (CAJA-01). El cajón de hace tres días ya no se puede volver a contar, y
/// deshacer un cierre antiguo dejaría su dinero sin contar en ningún periodo: los cierres de después
/// ya empezaron a contar desde él.
///
/// Antes esto se llamaba «reabrir» y servía sobre todo para desbloquear el periodo y poder corregir
/// un apunte. Corregir ya no se bloquea —rectifica el cierre (`rectificacion_caja`)—, así que lo que
/// queda es lo que la rectificación no arregla: un recuento mal hecho.
pub async fn reabrir(
    repo: &dyn CierreCajaRepository,
    id_cierre: &str,
    id_usuario: Option<&str>,
) -> AppResult<bool> {
    if repo.detalle(id_cierre).await?.is_none() {
        return Err(AppError::not_found("Ese cierre no existe"));
    }
    let ultimo = repo.ultimo_cierre().await?;
    if ultimo.as_ref().map(|c| c.id_cierre.as_str()) != Some(id_cierre) {
        return Err(AppError::conflict(
            "Sólo se puede deshacer el último cierre: el cajón de uno anterior ya no se puede \
             volver a contar.",
        ));
    }
    repo.reabrir(id_cierre, id_usuario).await
}

/// Clave de deduplicación del aviso de caja sin cerrar. Sólo puede haber uno activo a la vez.
pub const CLAVE_CAJA_ABIERTA: &str = "caja_sin_cerrar";

/// Avisa si la caja lleva demasiado tiempo sin cerrarse.
///
/// **Avisa; no cierra.** Un cierre automático tendría el esperado pero no el contado —nadie habría
/// abierto el cajón—, así que guardaría un arqueo con descuadre cero que nadie ha comprobado: un
/// dato falso que parece bueno. Lo único que puede hacer el programa es dar un toque.
///
/// Va como job y no "al arrancar" porque el runner sólo corre con la app abierta, que es
/// exactamente cuando el aviso sirve, y así también salta en un TPV que lleva días encendido.
///
/// Idempotente por la clave de dedupe: mientras el aviso siga activo no se emite otro, por muchas
/// pasadas que haga el motor. Al cerrar la caja se resuelve solo.
pub async fn avisar_si_lleva_mucho_abierta(
    repo: &dyn CierreCajaRepository,
    notifier: &dyn Notifier,
    horas_limite: i64,
) -> AppResult<bool> {
    let horas_abierta = repo.horas_periodo_abierto().await?;
    if horas_abierta < horas_limite {
        // Nada que avisar. Y si había un aviso de antes, se cierra: la caja ya se cerró.
        let _ = notifier.resolver_por_clave(CLAVE_CAJA_ABIERTA).await;
        return Ok(false);
    }

    let desde = repo
        .ultimo_cierre()
        .await?
        .map(|c| c.fecha_hora)
        .unwrap_or_else(|| "el principio".to_string());

    let dias = horas_abierta / 24;
    let cuanto = if dias >= 1 {
        format!("{dias} día(s)")
    } else {
        format!("{horas_abierta} horas")
    };

    let _ = notifier
        .emitir(NuevaNotificacion {
            tipo: "caja_sin_cerrar".to_string(),
            severidad: Severidad::Aviso,
            titulo: format!("La caja lleva {cuanto} sin cerrarse"),
            cuerpo: Some(format!(
                "El periodo abierto empezó el {desde}. Si pasan varios servicios sin cerrar, el \
                 descuadre deja de poder atribuirse a nadie."
            )),
            destino: Destino::Rol(ADMIN_ROL_ID.to_string()),
            accion: Some("ver_cuentas".to_string()),
            payload: None,
            clave_dedupe: Some(CLAVE_CAJA_ABIERTA.to_string()),
            expira_en: None,
        })
        .await;

    Ok(true)
}
