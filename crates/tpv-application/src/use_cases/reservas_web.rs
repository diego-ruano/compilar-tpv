//! Casos de uso de la reserva desde la web (docs/estudios/reservas-web.md).

use serde_json::{json, Value as JsonValue};
use tpv_contracts::reservas_web::{
    AjustesReservaWebDto, ClaveReservaWebDto, ReservaWebActivarInput, ReservaWebCierreInput,
    ReservaWebMesaDto, ReservaWebMesaInput, ReservaWebQuitarCierreInput,
};

use crate::ports::licensing::PairingService;
use tpv_domain::reservas_web::{zona_por_desfases, CierreValidado, MesaWebEntrada, MesaWebValidada};

use crate::error::{AppError, AppResult};
use crate::ports::reservas_web::ReservasWebRepository;

/// Deja en la base la zona horaria del reloj de esta Main, a partir de sus desfases con UTC en
/// invierno y en verano (`None` si no se han podido calcular). Devuelve la zona si la ha cambiado.
///
/// Sólo escribe si cambia: cada escritura viaja a la nube. Unos desfases que no corresponden a
/// ninguna zona conocida no son una avería: se deja la que hubiera.
pub async fn sincronizar_zona_horaria(
    repo: &dyn ReservasWebRepository,
    desfases: Option<(i32, i32)>,
) -> AppResult<Option<&'static str>> {
    let Some(zona) = desfases.and_then(|(invierno, verano)| zona_por_desfases(invierno, verano))
    else {
        return Ok(None);
    };
    if repo.zona_horaria().await? == zona {
        return Ok(None);
    }
    repo.fijar_zona_horaria(zona).await?;
    Ok(Some(zona))
}

/// El interruptor general y los días cerrados que vienen.
pub async fn ajustes(repo: &dyn ReservasWebRepository) -> AppResult<AjustesReservaWebDto> {
    Ok(AjustesReservaWebDto { activa: repo.activa().await?, cierres: repo.cierres().await? })
}

/// Enciende o apaga la reserva desde la web. La comparación con lo que hay va dentro del
/// repositorio, bajo su cerrojo de escritura (ver `fijar_activa`).
pub async fn activar(repo: &dyn ReservasWebRepository, input: ReservaWebActivarInput) -> AppResult<()> {
    repo.fijar_activa(input.activa).await?;
    Ok(())
}

/// Cierra un día para la web. Devuelve el id del cierre.
pub async fn cerrar_dia(repo: &dyn ReservasWebRepository, input: ReservaWebCierreInput) -> AppResult<String> {
    let cierre = CierreValidado::validar(&input.dia_ymd, input.motivo).map_err(AppError::validation)?;
    repo.cerrar_dia(cierre).await
}

/// Vuelve a abrir un día. Devuelve si estaba cerrado.
pub async fn quitar_cierre(
    repo: &dyn ReservasWebRepository,
    input: ReservaWebQuitarCierreInput,
) -> AppResult<bool> {
    let id = input.id_cierre.trim();
    if id.is_empty() {
        return Err(AppError::validation("Falta el día que se quiere abrir"));
    }
    repo.quitar_cierre(id).await
}

/// La clave pública del negocio y la línea que se pega en su web. La da el worker, que la crea si el
/// negocio todavía no tiene (`POST /v1/reservas-web/clave`, firmada con la clave de este equipo).
pub async fn clave_para_la_web(nube: &dyn PairingService) -> AppResult<ClaveReservaWebDto> {
    let bruto = nube.tpv_server_post_json("tpv", "/v1/reservas-web/clave", json!({})).await?;
    leer_clave(&bruto)
}

/// Interpreta `{ ok, clave, codigo }`.
pub fn leer_clave(bruto: &JsonValue) -> AppResult<ClaveReservaWebDto> {
    let campo = |k: &str| {
        bruto.get(k).and_then(JsonValue::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
    };
    match (campo("clave"), campo("codigo")) {
        (Some(clave), Some(codigo)) => Ok(ClaveReservaWebDto { clave, codigo }),
        _ => Err(AppError::external("La nube no ha devuelto el código para la web")),
    }
}

/// La configuración web de las mesas del plano.
pub async fn mesas(repo: &dyn ReservasWebRepository) -> AppResult<Vec<ReservaWebMesaDto>> {
    repo.mesas().await
}

/// Guarda cómo se puede reservar una mesa desde la web.
pub async fn guardar_mesa(repo: &dyn ReservasWebRepository, input: ReservaWebMesaInput) -> AppResult<()> {
    let mesa = MesaWebValidada::validar(MesaWebEntrada {
        id_mesa: input.id_mesa,
        activa: input.activa,
        dias_semana: input.dias_semana,
        fecha_desde: input.fecha_desde,
        fecha_hasta: input.fecha_hasta,
        hora_desde: input.hora_desde,
        hora_hasta: input.hora_hasta,
    })
    .map_err(AppError::validation)?;
    repo.guardar_mesa(mesa).await
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use async_trait::async_trait;
    use tpv_contracts::reservas_web::CierreReservaWebDto;

    use super::*;

    #[derive(Default)]
    struct RepoFalso {
        zona: Mutex<String>,
        activa: Mutex<bool>,
        escrituras: Mutex<u32>,
        cierres: Mutex<Vec<CierreValidado>>,
        mesas_guardadas: Mutex<Vec<MesaWebValidada>>,
    }

    impl RepoFalso {
        fn con_zona(zona: &str) -> Self {
            RepoFalso { zona: Mutex::new(zona.into()), ..Default::default() }
        }
        fn escrituras(&self) -> u32 {
            *self.escrituras.lock().unwrap()
        }
    }

    #[async_trait]
    impl ReservasWebRepository for RepoFalso {
        async fn zona_horaria(&self) -> AppResult<String> {
            Ok(self.zona.lock().unwrap().clone())
        }
        async fn fijar_zona_horaria(&self, zona: &str) -> AppResult<()> {
            *self.zona.lock().unwrap() = zona.into();
            *self.escrituras.lock().unwrap() += 1;
            Ok(())
        }
        async fn activa(&self) -> AppResult<bool> {
            Ok(*self.activa.lock().unwrap())
        }
        async fn fijar_activa(&self, activa: bool) -> AppResult<bool> {
            let mut actual = self.activa.lock().unwrap();
            if *actual == activa {
                return Ok(false);
            }
            *actual = activa;
            *self.escrituras.lock().unwrap() += 1;
            Ok(true)
        }
        async fn cierres(&self) -> AppResult<Vec<CierreReservaWebDto>> {
            Ok(vec![])
        }
        async fn cerrar_dia(&self, cierre: CierreValidado) -> AppResult<String> {
            self.cierres.lock().unwrap().push(cierre);
            Ok("c1".into())
        }
        async fn quitar_cierre(&self, _id_cierre: &str) -> AppResult<bool> {
            Ok(true)
        }
        async fn mesas(&self) -> AppResult<Vec<tpv_contracts::reservas_web::ReservaWebMesaDto>> {
            Ok(vec![])
        }
        async fn guardar_mesa(&self, mesa: MesaWebValidada) -> AppResult<()> {
            self.mesas_guardadas.lock().unwrap().push(mesa);
            Ok(())
        }
    }

    #[tokio::test]
    async fn una_mesa_se_valida_antes_de_llegar_al_repositorio() {
        let repo = RepoFalso::default();
        let input = |activa: bool, desde: Option<&str>| ReservaWebMesaInput {
            id_mesa: "m1".into(),
            activa,
            dias_semana: 127,
            fecha_desde: None,
            fecha_hasta: None,
            hora_desde: desde.map(str::to_string),
            hora_hasta: Some("16:00".into()),
        };
        assert!(matches!(guardar_mesa(&repo, input(true, Some("17:00"))).await, Err(AppError::Validation(_))));
        assert!(repo.mesas_guardadas.lock().unwrap().is_empty());

        guardar_mesa(&repo, input(true, Some("12:00"))).await.unwrap();
        assert_eq!(repo.mesas_guardadas.lock().unwrap()[0].franja.as_ref().unwrap().hora_desde, "12:00");
    }

    #[tokio::test]
    async fn un_tpv_en_canarias_deja_su_zona() {
        let repo = RepoFalso::con_zona("Europe/Madrid");
        assert_eq!(
            sincronizar_zona_horaria(&repo, Some((0, 60))).await.unwrap(),
            Some("Atlantic/Canary")
        );
        assert_eq!(*repo.zona.lock().unwrap(), "Atlantic/Canary");
    }

    /// Cada escritura sube a la nube: si ya está bien, no se escribe nada.
    #[tokio::test]
    async fn si_ya_esta_bien_no_escribe() {
        let repo = RepoFalso::con_zona("Europe/Madrid");
        assert_eq!(sincronizar_zona_horaria(&repo, Some((60, 120))).await.unwrap(), None);
        assert_eq!(repo.escrituras(), 0);
    }

    #[tokio::test]
    async fn sin_desfases_o_con_unos_desconocidos_se_deja_la_que_hay() {
        let repo = RepoFalso::con_zona("Atlantic/Canary");
        for desfases in [None, Some((0, 0))] {
            assert_eq!(sincronizar_zona_horaria(&repo, desfases).await.unwrap(), None);
        }
        assert_eq!(*repo.zona.lock().unwrap(), "Atlantic/Canary");
        assert_eq!(repo.escrituras(), 0);
    }

    #[test]
    fn la_clave_se_lee_de_la_respuesta_del_worker() {
        let ok = leer_clave(&json!({ "ok": true, "clave": "rw_x", "codigo": "<div></div>" })).unwrap();
        assert_eq!((ok.clave.as_str(), ok.codigo.as_str()), ("rw_x", "<div></div>"));
        for mala in [json!({ "ok": true }), json!({ "clave": "rw_x", "codigo": "  " }), json!(null)] {
            assert!(matches!(leer_clave(&mala), Err(AppError::External(_))), "{mala}");
        }
    }

    #[tokio::test]
    async fn activar_deja_la_ultima_eleccion() {
        let repo = RepoFalso::default();
        activar(&repo, ReservaWebActivarInput { activa: true }).await.unwrap();
        activar(&repo, ReservaWebActivarInput { activa: false }).await.unwrap();
        assert!(!*repo.activa.lock().unwrap());
    }

    #[tokio::test]
    async fn un_dia_cerrado_se_valida_antes_de_llegar_al_repositorio() {
        let repo = RepoFalso::default();
        let malo = ReservaWebCierreInput { dia_ymd: "2026-02-30".into(), motivo: None };
        assert!(matches!(cerrar_dia(&repo, malo).await, Err(AppError::Validation(_))));
        assert!(repo.cierres.lock().unwrap().is_empty());

        let bueno = ReservaWebCierreInput { dia_ymd: "2026-12-24".into(), motivo: Some(" Nochebuena ".into()) };
        assert_eq!(cerrar_dia(&repo, bueno).await.unwrap(), "c1");
        assert_eq!(repo.cierres.lock().unwrap()[0].motivo.as_deref(), Some("Nochebuena"));
    }

    #[tokio::test]
    async fn quitar_un_cierre_exige_su_id() {
        let repo = RepoFalso::default();
        let vacio = ReservaWebQuitarCierreInput { id_cierre: "  ".into() };
        assert!(matches!(quitar_cierre(&repo, vacio).await, Err(AppError::Validation(_))));
    }
}
