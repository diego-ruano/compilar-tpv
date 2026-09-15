//! El correo de recuperación del negocio (LOGIN-08).
//!
//! Aquí sólo se valida y se normaliza: las reglas —el código va al correo nuevo, se avisa al
//! anterior y al de la compra, volver al de la compra no pide código— viven en el worker
//! (`domains/login/correoRecuperacion.ts`), que es quien manda los correos. Que sólo lo toque un
//! administrador lo exige el comando con la sesión (SEC-01).

use tpv_contracts::login::{
    CodigoEnviado, ConfirmarCambioCorreoInput, EstadoCorreoRecuperacion, SolicitarCambioCorreoInput,
};
use tpv_domain::login::validate_email_basic;

use crate::error::{AppError, AppResult};
use crate::ports::correo_recuperacion::CorreoRecuperacionService;
use crate::use_cases::recuperacion_pin::codigo_valido;

pub async fn estado(svc: &dyn CorreoRecuperacionService) -> AppResult<EstadoCorreoRecuperacion> {
    svc.estado().await
}

pub async fn solicitar_cambio(
    svc: &dyn CorreoRecuperacionService,
    input: SolicitarCambioCorreoInput,
) -> AppResult<CodigoEnviado> {
    // En minúsculas: la comparación con el actual y con el de la compra no puede depender de cómo
    // se haya escrito.
    let correo = input.correo.trim().to_lowercase();
    if !validate_email_basic(&correo) {
        return Err(AppError::validation("Ese correo no parece válido. Revísalo."));
    }
    svc.solicitar_cambio(&correo).await
}

pub async fn confirmar_cambio(
    svc: &dyn CorreoRecuperacionService,
    input: ConfirmarCambioCorreoInput,
) -> AppResult<EstadoCorreoRecuperacion> {
    let codigo = codigo_valido(&input.codigo)?;
    svc.confirmar_cambio(&codigo).await
}

pub async fn usar_el_de_la_compra(
    svc: &dyn CorreoRecuperacionService,
) -> AppResult<EstadoCorreoRecuperacion> {
    svc.usar_el_de_la_compra().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use std::sync::Mutex;

    #[derive(Default)]
    struct FakeNube {
        llamadas: Mutex<Vec<String>>,
    }

    impl FakeNube {
        fn llamadas(&self) -> Vec<String> {
            self.llamadas.lock().unwrap().clone()
        }
    }

    fn estado_de_prueba() -> EstadoCorreoRecuperacion {
        EstadoCorreoRecuperacion { email_hint: "e***@bar.test".into(), es_el_de_la_compra: false }
    }

    #[async_trait]
    impl CorreoRecuperacionService for FakeNube {
        async fn estado(&self) -> AppResult<EstadoCorreoRecuperacion> {
            Ok(estado_de_prueba())
        }
        async fn solicitar_cambio(&self, correo: &str) -> AppResult<CodigoEnviado> {
            self.llamadas.lock().unwrap().push(format!("solicitar:{correo}"));
            Ok(CodigoEnviado { email_hint: "e***@bar.test".into(), minutos: 10 })
        }
        async fn confirmar_cambio(&self, codigo: &str) -> AppResult<EstadoCorreoRecuperacion> {
            self.llamadas.lock().unwrap().push(format!("confirmar:{codigo}"));
            Ok(estado_de_prueba())
        }
        async fn usar_el_de_la_compra(&self) -> AppResult<EstadoCorreoRecuperacion> {
            Ok(estado_de_prueba())
        }
    }

    #[tokio::test]
    async fn el_correo_se_manda_normalizado() {
        let nube = FakeNube::default();
        let input = SolicitarCambioCorreoInput { correo: "  Encargado@Bar.TEST ".into() };
        solicitar_cambio(&nube, input).await.unwrap();
        assert_eq!(nube.llamadas(), vec!["solicitar:encargado@bar.test".to_string()]);
    }

    /// Cada envío cuenta para el tope por hora: uno mal escrito no puede gastarlo.
    #[tokio::test]
    async fn un_correo_mal_escrito_no_llega_a_la_nube() {
        let nube = FakeNube::default();
        for malo in ["", "sin-arroba", "a b@bar.test", "@."] {
            let input = SolicitarCambioCorreoInput { correo: malo.into() };
            assert!(matches!(solicitar_cambio(&nube, input).await, Err(AppError::Validation(_))), "{malo:?}");
        }
        assert!(nube.llamadas().is_empty());
    }

    /// Verificar gasta intentos: un código con otra forma se rechaza antes de llegar a la nube.
    #[tokio::test]
    async fn un_codigo_con_otra_forma_no_gasta_intentos() {
        let nube = FakeNube::default();
        for malo in ["12345", "1234567", "abcdef", ""] {
            let input = ConfirmarCambioCorreoInput { codigo: malo.into() };
            assert!(confirmar_cambio(&nube, input).await.is_err(), "{malo:?}");
        }
        assert!(nube.llamadas().is_empty());

        let bueno = ConfirmarCambioCorreoInput { codigo: " 123456 ".into() };
        confirmar_cambio(&nube, bueno).await.unwrap();
        assert_eq!(nube.llamadas(), vec!["confirmar:123456".to_string()]);
    }
}
