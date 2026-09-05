//! Casos de uso del **cierre de caja** (arqueo). CUENTA-06.

use tpv_contracts::cierre_caja::{
    CierreDto, CierreResumenDto, ConfirmarCierreInput, PreparacionCierreDto,
};
use tpv_contracts::errors::ErrorCode;
use tpv_domain::cierre_caja::{
    calcular, total_recuento, validar, Denominacion, UMBRAL_DESCUADRE_POR_DEFECTO,
};

use tpv_domain::notificaciones::{Destino, NuevaNotificacion, Severidad, ADMIN_ROL_ID};

use crate::error::{AppError, AppResult};
use crate::ports::cierre_caja::{CierreCajaRepository, CierreNuevo};
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
    // Informativo, fuera del cálculo (CUENTA-07): el esperado sigue saliendo de los cobros
    // activos. Lo que aporta es contexto — un descuadre de 40 € con "3 anulaciones por 40 €" al
    // lado deja de ser un misterio.
    let (anulaciones, anulaciones_importe) = repo.anulaciones_desde(desde.as_deref()).await?;

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
        anulaciones,
        anulaciones_importe,
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
///
/// `id_usuario` es un parámetro y no un campo del input **a propósito** (SEC-01): quien firma
/// el arqueo lo pone la sesión del backend, así que no puede llegar por el mismo camino que los
/// datos que sí escribe la pantalla.
pub async fn confirmar(
    repo: &dyn CierreCajaRepository,
    id_cierre: String,
    id_usuario: Option<&str>,
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
        id_usuario: id_usuario.map(str::to_string),
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

#[cfg(test)]
mod tests_gate_del_periodo {
    //! El gate que impide tocar un apunte de un cierre ya hecho.
    //!
    //! Vale para editar un cobro, para borrar un gasto y —desde CUENTA-07— para **anular un
    //! cobro**: anular un cobro de anoche después de haber cuadrado la caja de anoche cambia un
    //! arqueo que ya está firmado. Por eso `anular_pago` no escribe su propio gate: reutiliza éste
    //! (dos definiciones de «periodo cerrado» son una que acaba llegando tarde).

    use super::*;
    use crate::ports::cierre_caja::ApunteCaja;
    use async_trait::async_trait;

    /// Un repositorio que sólo sabe una cosa: dónde está el corte. Es lo único que mira el gate.
    struct SoloElCorte(Option<String>);

    #[async_trait]
    impl CierreCajaRepository for SoloElCorte {
        async fn corte_vigente(&self) -> AppResult<Option<String>> {
            Ok(self.0.clone())
        }
        async fn ultimo_cierre(&self) -> AppResult<Option<CierreDto>> {
            unimplemented!("el gate no lo usa")
        }
        async fn ventas_efectivo_desde(&self, _d: Option<&str>) -> AppResult<f64> {
            unimplemented!("el gate no lo usa")
        }
        async fn anulaciones_desde(&self, _d: Option<&str>) -> AppResult<(i64, f64)> {
            unimplemented!("el gate no lo usa")
        }
        async fn comandas_abiertas(&self) -> AppResult<i64> {
            unimplemented!("el gate no lo usa")
        }
        async fn crear(&self, _c: CierreNuevo) -> AppResult<()> {
            unimplemented!("el gate no lo usa")
        }
        async fn listar(&self, _l: i64) -> AppResult<Vec<CierreResumenDto>> {
            unimplemented!("el gate no lo usa")
        }
        async fn detalle(&self, _id: &str) -> AppResult<Option<CierreDto>> {
            unimplemented!("el gate no lo usa")
        }
        async fn reabrir(&self, _id: &str, _u: Option<&str>) -> AppResult<bool> {
            unimplemented!("el gate no lo usa")
        }
        async fn fecha_apunte(&self, _t: ApunteCaja, _id: &str) -> AppResult<Option<String>> {
            unimplemented!("el gate no lo usa")
        }
        async fn horas_periodo_abierto(&self) -> AppResult<i64> {
            unimplemented!("el gate no lo usa")
        }
    }

    fn corte(v: Option<&str>) -> SoloElCorte {
        SoloElCorte(v.map(str::to_string))
    }

    #[tokio::test]
    async fn un_cobro_de_un_periodo_ya_cerrado_no_se_toca() {
        let repo = corte(Some("2026-05-10 23:00:00"));
        let e = exigir_periodo_abierto(&repo, "2026-05-10 21:30:00")
            .await
            .unwrap_err();
        assert_eq!(e.code(), ErrorCode::PeriodoCerrado);
    }

    #[tokio::test]
    async fn el_cobro_del_propio_corte_tambien_esta_dentro() {
        // El límite es «anterior **o igual**»: el cobro que se hizo en el segundo del cierre entró
        // en ese arqueo.
        let repo = corte(Some("2026-05-10 23:00:00"));
        assert!(exigir_periodo_abierto(&repo, "2026-05-10 23:00:00")
            .await
            .is_err());
    }

    #[tokio::test]
    async fn un_cobro_posterior_al_corte_si_se_puede_anular() {
        let repo = corte(Some("2026-05-10 23:00:00"));
        assert!(exigir_periodo_abierto(&repo, "2026-05-11 01:15:00")
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn tras_reabrir_el_cierre_el_apunte_vuelve_a_ser_tocable() {
        // Reabrir no borra el cierre: le pone `Reabierto_En`, y entonces deja de ser el corte
        // vigente. Con el corte anterior (o ninguno), el mismo apunte pasa.
        let repo = corte(None);
        assert!(exigir_periodo_abierto(&repo, "2026-05-10 21:30:00")
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn un_gasto_del_dia_del_cierre_cuenta_como_dentro() {
        // Un gasto guarda 'YYYY-MM-DD' sin hora. Comparar los textos tal cual dejaría
        // '2026-05-10' por debajo de '2026-05-10 23:00:00' y el gasto se colaría como editable.
        let repo = corte(Some("2026-05-10 23:00:00"));
        assert!(exigir_periodo_abierto(&repo, "2026-05-10").await.is_err());
    }

    #[tokio::test]
    async fn un_apunte_sin_fecha_no_lo_decide_este_gate() {
        // Si el apunte no existe, `fecha_apunte` devuelve `None` y aquí no llega nada. Una cadena
        // vacía es el mismo caso: decidirlo aquí sería adelantarse al comando, que ya devuelve
        // `false` cuando no encuentra la fila.
        let repo = corte(Some("2026-05-10 23:00:00"));
        assert!(exigir_periodo_abierto(&repo, "   ").await.is_ok());
    }
}
