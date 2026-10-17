//! Casos de uso de la reserva desde la web (docs/estudios/reservas-web.md).

use tpv_contracts::reservas_web::{
    AjustesReservaWebDto, ReservaWebActivarInput, ReservaWebCierreInput,
    ReservaWebQuitarCierreInput,
};
use tpv_domain::reservas_web::{zona_por_desfases, CierreValidado};

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

/// Enciende o apaga la reserva desde la web. Sólo escribe si cambia: cada escritura viaja a la nube.
pub async fn activar(repo: &dyn ReservasWebRepository, input: ReservaWebActivarInput) -> AppResult<()> {
    if repo.activa().await? != input.activa {
        repo.fijar_activa(input.activa).await?;
    }
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
        async fn fijar_activa(&self, activa: bool) -> AppResult<()> {
            *self.activa.lock().unwrap() = activa;
            *self.escrituras.lock().unwrap() += 1;
            Ok(())
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

    #[tokio::test]
    async fn activar_solo_escribe_si_cambia() {
        let repo = RepoFalso::default();
        activar(&repo, ReservaWebActivarInput { activa: false }).await.unwrap();
        assert_eq!(repo.escrituras(), 0);
        activar(&repo, ReservaWebActivarInput { activa: true }).await.unwrap();
        activar(&repo, ReservaWebActivarInput { activa: true }).await.unwrap();
        assert!(*repo.activa.lock().unwrap());
        assert_eq!(repo.escrituras(), 1);
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
