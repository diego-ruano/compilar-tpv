//! Casos de uso del **cierre de caja** (arqueo). CUENTA-06.

use tpv_contracts::cierre_caja::{
    CierreDto, CierreResumenDto, ConfirmarCierreInput, PreparacionCierreDto,
};
use tpv_contracts::errors::ErrorCode;
use tpv_domain::cierre_caja::{
    calcular, total_recuento, validar, Denominacion, UMBRAL_DESCUADRE_POR_DEFECTO,
};

use crate::error::{AppError, AppResult};
use crate::ports::cierre_caja::{CierreCajaRepository, CierreNuevo};

fn a_denoms(input: &[tpv_contracts::cierre_caja::DenominacionInput]) -> Vec<Denominacion> {
    input
        .iter()
        .map(|d| Denominacion {
            valor: d.valor,
            unidades: d.unidades,
        })
        .collect()
}

/// Lo que la pantalla necesita antes de que nadie cuente nada: desde cuándo está abierto el
/// periodo, cuánto se espera encontrar y si hay mesas sin cobrar.
pub async fn preparar(
    repo: &dyn CierreCajaRepository,
    umbral_descuadre: f64,
) -> AppResult<PreparacionCierreDto> {
    let ultimo = repo.ultimo_cierre().await?;
    let desde = ultimo.as_ref().map(|c| c.fecha_hora.clone());
    let fondo_inicial = ultimo.as_ref().map(|c| c.dejado).unwrap_or(0.0);

    let ventas_efectivo = repo.ventas_efectivo_desde(desde.as_deref()).await?;
    let comandas_abiertas = repo.comandas_abiertas().await?;

    Ok(PreparacionCierreDto {
        es_primer_cierre: ultimo.is_none(),
        desde,
        fondo_inicial,
        ventas_efectivo,
        esperado: ((fondo_inicial + ventas_efectivo) * 100.0).round() / 100.0,
        comandas_abiertas,
        umbral_descuadre: if umbral_descuadre > 0.0 {
            umbral_descuadre
        } else {
            UMBRAL_DESCUADRE_POR_DEFECTO
        },
    })
}

/// Cierra el periodo.
///
/// El fondo de partida **no se acepta de la entrada salvo en el primer cierre**: en los demás lo
/// manda el `dejado` del anterior. Si se admitiera siempre, cualquiera podría reescribir el punto de
/// partida a posteriori y hacer que un descuadre desapareciera cambiando un número.
///
/// Las ventas también se recalculan aquí, no se reciben: son la mitad del esperado, y aceptarlas de
/// fuera sería dejar que la pantalla decidiera cuánto debería haber en el cajón.
pub async fn confirmar(
    repo: &dyn CierreCajaRepository,
    id_cierre: String,
    input: ConfirmarCierreInput,
    umbral_descuadre: f64,
) -> AppResult<CierreDto> {
    let ultimo = repo.ultimo_cierre().await?;
    let desde = ultimo.as_ref().map(|c| c.fecha_hora.clone());

    let fondo_inicial = match &ultimo {
        Some(c) => c.dejado,
        None => input.fondo_inicial.unwrap_or(0.0),
    };
    if fondo_inicial < 0.0 {
        return Err(AppError::validation("El fondo inicial no puede ser negativo"));
    }

    let ventas_efectivo = repo.ventas_efectivo_desde(desde.as_deref()).await?;

    let contado_denoms = a_denoms(&input.contado);
    let dejado_denoms = a_denoms(&input.dejado);

    let calculo = calcular(
        fondo_inicial,
        ventas_efectivo,
        total_recuento(&contado_denoms),
        total_recuento(&dejado_denoms),
    );

    let umbral = if umbral_descuadre > 0.0 {
        umbral_descuadre
    } else {
        UMBRAL_DESCUADRE_POR_DEFECTO
    };
    let motivo = validar(&calculo, input.motivo.as_deref(), umbral).map_err(AppError::validation)?;

    repo.crear(CierreNuevo {
        id_cierre: id_cierre.clone(),
        id_usuario: input.id_usuario.clone(),
        fondo_inicial: calculo.fondo_inicial,
        ventas_efectivo: calculo.ventas_efectivo,
        esperado: calculo.esperado,
        contado: calculo.contado,
        descuadre: calculo.descuadre,
        dejado: calculo.dejado,
        retirado: calculo.retirado,
        motivo,
        contado_denoms,
        dejado_denoms,
    })
    .await?;

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

/// Reabre un cierre para poder corregir su periodo. Queda registrado quién y cuándo.
pub async fn reabrir(
    repo: &dyn CierreCajaRepository,
    id_cierre: &str,
    id_usuario: Option<&str>,
) -> AppResult<bool> {
    if repo.detalle(id_cierre).await?.is_none() {
        return Err(AppError::not_found("Ese cierre no existe"));
    }
    repo.reabrir(id_cierre, id_usuario).await
}

/// El gate: ¿se puede tocar un apunte de caja con esta fecha?
///
/// Una fila está bloqueada si es **anterior o igual** al último cierre no reabierto. No hay columna
/// "bloqueado" en `Pagos` ni en `Cuentas_Gastos`: se deduce de la fecha del corte. Es una consulta y
/// no hay estado que mantener sincronizado, que es el tipo de campo que siempre acaba mintiendo.
///
/// Se compara sólo la **fecha** cuando el apunte no trae hora (los gastos son `DATE`): un gasto del
/// mismo día del cierre se considera dentro del periodo cerrado.
pub async fn exigir_periodo_abierto(
    repo: &dyn CierreCajaRepository,
    fecha_apunte: &str,
) -> AppResult<()> {
    let Some(corte) = repo.corte_vigente().await? else {
        return Ok(());
    };

    let apunte = fecha_apunte.trim();
    if apunte.is_empty() {
        return Ok(());
    }

    // Un gasto guarda 'YYYY-MM-DD' y un cobro 'YYYY-MM-DD HH:MM:SS'. Comparar como texto funciona
    // porque el formato es lexicográficamente ordenable, pero hay que igualar la longitud: si no,
    // '2026-05-10' saldría "menor" que '2026-05-10 21:00:00' y un gasto del día del cierre se
    // colaría como editable.
    let bloqueado = if apunte.len() <= 10 {
        apunte <= &corte[..corte.len().min(10)]
    } else {
        apunte <= corte.as_str()
    };

    if bloqueado {
        return Err(AppError::coded(
            ErrorCode::PeriodoCerrado,
            "Ese apunte pertenece a un cierre de caja ya hecho. Reabre el cierre para poder tocarlo.",
        ));
    }
    Ok(())
}
