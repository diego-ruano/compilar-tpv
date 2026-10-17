//! Casos de uso de la reserva desde la web (docs/estudios/reservas-web.md).

use tpv_domain::reservas_web::zona_por_desfases;

use crate::error::AppResult;
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

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use async_trait::async_trait;

    use super::*;

    struct RepoZona {
        guardada: Mutex<String>,
        escrituras: Mutex<u32>,
    }

    impl RepoZona {
        fn con(zona: &str) -> Self {
            RepoZona { guardada: Mutex::new(zona.into()), escrituras: Mutex::new(0) }
        }
    }

    #[async_trait]
    impl ReservasWebRepository for RepoZona {
        async fn zona_horaria(&self) -> AppResult<String> {
            Ok(self.guardada.lock().unwrap().clone())
        }
        async fn fijar_zona_horaria(&self, zona: &str) -> AppResult<()> {
            *self.guardada.lock().unwrap() = zona.into();
            *self.escrituras.lock().unwrap() += 1;
            Ok(())
        }
    }

    #[tokio::test]
    async fn un_tpv_en_canarias_deja_su_zona() {
        let repo = RepoZona::con("Europe/Madrid");
        assert_eq!(
            sincronizar_zona_horaria(&repo, Some((0, 60))).await.unwrap(),
            Some("Atlantic/Canary")
        );
        assert_eq!(*repo.guardada.lock().unwrap(), "Atlantic/Canary");
    }

    /// Cada escritura sube a la nube: si ya está bien, no se escribe nada.
    #[tokio::test]
    async fn si_ya_esta_bien_no_escribe() {
        let repo = RepoZona::con("Europe/Madrid");
        assert_eq!(sincronizar_zona_horaria(&repo, Some((60, 120))).await.unwrap(), None);
        assert_eq!(*repo.escrituras.lock().unwrap(), 0);
    }

    #[tokio::test]
    async fn sin_desfases_o_con_unos_desconocidos_se_deja_la_que_hay() {
        let repo = RepoZona::con("Atlantic/Canary");
        for desfases in [None, Some((0, 0))] {
            assert_eq!(sincronizar_zona_horaria(&repo, desfases).await.unwrap(), None);
        }
        assert_eq!(*repo.guardada.lock().unwrap(), "Atlantic/Canary");
        assert_eq!(*repo.escrituras.lock().unwrap(), 0);
    }
}
