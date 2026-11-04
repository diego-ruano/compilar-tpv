//! Recuperar el PIN de un administrador por correo (LOGIN-07).
//!
//! Dos pasos, los dos **sin sesión**: quien llega aquí es justo quien no puede iniciarla.
//!
//!   1. `solicitar`: comprueba que el usuario es un administrador activo y pide a la nube que mande
//!      un código al correo del titular de la licencia.
//!   2. `confirmar`: valida el PIN nuevo, pide a la nube que verifique el código y, sólo si vale,
//!      guarda el PIN en la base local. De ahí sube por el outbox, y la Handy lo recibe.
//!
//! Reglas:
//!
//!   · **Verificar y guardar van en el mismo caso de uso.** Si fueran dos comandos, cualquiera con el
//!     IPC podría llamar sólo al segundo.
//!   · **Sólo administradores.** A cualquier otro le cambia el PIN un administrador desde
//!     Trabajadores: ya existe, no necesita internet y deja al encargado enterado. Quién es
//!     administrador lo dice la base local, que es la que manda en el login.
//!   · **Todo lo que puede fallar en local va antes de tocar la nube**, porque verificar el código lo
//!     gasta: un PIN mal escrito no puede costarle al usuario un código.

use tpv_contracts::login::{CodigoEnviado, ConfirmarCodigoPinInput, SolicitarCodigoPinInput};
use tpv_domain::login::pin_de_teclado;

use crate::error::{AppError, AppResult};
use crate::ports::login::LoginRepository;
use crate::ports::recuperacion_pin::RecuperacionPinService;

/// El mismo nombre de rol que `lib.rs::ADMIN` y `permisos.ts::ROL_ADMIN`.
const ROL_ADMIN: &str = "Administrador";

fn id_usuario(input: &str) -> AppResult<String> {
    let id = input.trim();
    if id.is_empty() {
        return Err(AppError::validation("Falta el usuario."));
    }
    Ok(id.to_string())
}

pub(crate) fn codigo_valido(input: &str) -> AppResult<String> {
    let c = input.trim();
    if c.len() != 6 || !c.chars().all(|ch| ch.is_ascii_digit()) {
        return Err(AppError::validation("El código son 6 cifras."));
    }
    Ok(c.to_string())
}

/// El PIN se teclea en el teclado del login: uno que no se pueda escribir ahí dejaría al
/// administrador igual de fuera que antes de recuperarlo (ver `pin_de_teclado`).
fn pin_valido(input: &str) -> AppResult<String> {
    pin_de_teclado(input).map_err(AppError::validation)
}

async fn exigir_admin_activo(repo: &dyn LoginRepository, id: &str) -> AppResult<()> {
    // La lista del login sólo trae usuarios activos: uno dado de baja no aparece.
    let usuarios = repo.list_login_users().await?;
    match usuarios.iter().find(|u| u.id_usuario == id) {
        None => Err(AppError::not_found("Usuario no encontrado")),
        Some(u) if u.nombre_rol == ROL_ADMIN => Ok(()),
        Some(_) => Err(AppError::validation(
            "Solo un administrador puede recuperar su PIN por correo. Pide a un administrador que te lo cambie desde Trabajadores.",
        )),
    }
}

pub async fn solicitar(
    repo: &dyn LoginRepository,
    svc: &dyn RecuperacionPinService,
    input: SolicitarCodigoPinInput,
) -> AppResult<CodigoEnviado> {
    let id = id_usuario(&input.id_usuario)?;
    exigir_admin_activo(repo, &id).await?;
    svc.solicitar_codigo(&id).await
}

pub async fn confirmar(
    repo: &dyn LoginRepository,
    svc: &dyn RecuperacionPinService,
    input: ConfirmarCodigoPinInput,
) -> AppResult<()> {
    let id = id_usuario(&input.id_usuario)?;
    let codigo = codigo_valido(&input.codigo)?;
    let pin = pin_valido(&input.pin_nuevo)?;
    exigir_admin_activo(repo, &id).await?;

    svc.verificar_codigo(&id, &codigo).await?;
    repo.restablecer_pin_admin(&id, &pin).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use std::sync::Mutex;
    use tpv_contracts::login::{LoginOk, PunchStatus, SetupPendiente, UserListItem};

    struct FakeLogin {
        usuarios: Vec<UserListItem>,
        pines: Mutex<Vec<(String, String)>>,
    }

    impl FakeLogin {
        fn con(usuarios: &[(&str, &str)]) -> Self {
            Self {
                usuarios: usuarios
                    .iter()
                    .map(|(id, rol)| UserListItem {
                        id_usuario: id.to_string(),
                        nombre: "Nombre".into(),
                        apellido: None,
                        nombre_rol: rol.to_string(),
                        sin_pin: false,
                    })
                    .collect(),
                pines: Mutex::new(vec![]),
            }
        }
        fn pines(&self) -> Vec<(String, String)> {
            self.pines.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl LoginRepository for FakeLogin {
        async fn list_login_users(&self) -> AppResult<Vec<UserListItem>> {
            Ok(self.usuarios.clone())
        }
        async fn setup_pendiente(&self) -> AppResult<SetupPendiente> {
            unimplemented!("no usado")
        }
        async fn get_today_punch_status(&self, _: &str) -> AppResult<PunchStatus> {
            unimplemented!("no usado")
        }
        async fn login(&self, _: &str, _: &str) -> AppResult<LoginOk> {
            unimplemented!("no usado")
        }
        async fn complete_initial_setup(&self, _: &str, _: &str) -> AppResult<()> {
            unimplemented!("no usado")
        }
        async fn punch(&self, _: &str, _: &str, _: &str) -> AppResult<PunchStatus> {
            unimplemented!("no usado")
        }
        async fn set_turno_partido(&self, _: &str, _: Option<String>, _: bool) -> AppResult<()> {
            unimplemented!("no usado")
        }
        async fn restablecer_pin_admin(&self, id: &str, pin: &str) -> AppResult<()> {
            self.pines.lock().unwrap().push((id.to_string(), pin.to_string()));
            Ok(())
        }
    }

    /// La nube de mentira: acepta sólo `codigo_bueno` y anota a quién se le ha llamado.
    struct FakeNube {
        codigo_bueno: &'static str,
        llamadas: Mutex<Vec<String>>,
    }

    impl FakeNube {
        fn nueva() -> Self {
            Self { codigo_bueno: "123456", llamadas: Mutex::new(vec![]) }
        }
        fn llamadas(&self) -> Vec<String> {
            self.llamadas.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl RecuperacionPinService for FakeNube {
        async fn solicitar_codigo(&self, id: &str) -> AppResult<CodigoEnviado> {
            self.llamadas.lock().unwrap().push(format!("solicitar:{id}"));
            Ok(CodigoEnviado {
                email_hint: "t***@bar.test".into(),
                minutos: 10,
                reenvio_segundos: 300,
                sin_cambios: false,
            })
        }
        async fn verificar_codigo(&self, id: &str, codigo: &str) -> AppResult<()> {
            self.llamadas.lock().unwrap().push(format!("verificar:{id}"));
            if codigo == self.codigo_bueno {
                Ok(())
            } else {
                Err(AppError::validation("El código no es correcto"))
            }
        }
    }

    fn confirmar_input(codigo: &str, pin: &str) -> ConfirmarCodigoPinInput {
        ConfirmarCodigoPinInput {
            id_usuario: "admin".into(),
            codigo: codigo.into(),
            pin_nuevo: pin.into(),
        }
    }

    #[tokio::test]
    async fn un_administrador_recibe_el_codigo_y_con_el_bueno_cambia_su_pin() {
        let repo = FakeLogin::con(&[("admin", "Administrador")]);
        let nube = FakeNube::nueva();

        let enviado = solicitar(&repo, &nube, SolicitarCodigoPinInput { id_usuario: " admin ".into() })
            .await
            .unwrap();
        assert_eq!(enviado.minutos, 10);

        confirmar(&repo, &nube, confirmar_input("123456", "4321")).await.unwrap();
        assert_eq!(repo.pines(), vec![("admin".to_string(), "4321".to_string())]);
    }

    #[tokio::test]
    async fn quien_no_es_administrador_no_puede_ni_pedir_el_codigo() {
        let repo = FakeLogin::con(&[("camarero", "Camarero")]);
        let nube = FakeNube::nueva();

        let r = solicitar(&repo, &nube, SolicitarCodigoPinInput { id_usuario: "camarero".into() }).await;
        assert!(matches!(r, Err(AppError::Validation(_))));

        let mut input = confirmar_input("123456", "4321");
        input.id_usuario = "camarero".into();
        assert!(confirmar(&repo, &nube, input).await.is_err());

        assert!(nube.llamadas().is_empty(), "no se puede molestar al titular por un no-administrador");
        assert!(repo.pines().is_empty());
    }

    #[tokio::test]
    async fn un_usuario_que_no_esta_en_la_lista_no_existe() {
        let repo = FakeLogin::con(&[("admin", "Administrador")]);
        let nube = FakeNube::nueva();
        let r = solicitar(&repo, &nube, SolicitarCodigoPinInput { id_usuario: "baja".into() }).await;
        assert!(matches!(r, Err(AppError::NotFound(_))));
        assert!(nube.llamadas().is_empty());
    }

    #[tokio::test]
    async fn con_el_codigo_malo_no_se_toca_el_pin() {
        let repo = FakeLogin::con(&[("admin", "Administrador")]);
        let nube = FakeNube::nueva();
        assert!(confirmar(&repo, &nube, confirmar_input("654321", "4321")).await.is_err());
        assert!(repo.pines().is_empty());
    }

    /// Verificar gasta el código: un PIN que no vale tiene que rechazarse antes de llegar a la nube.
    #[tokio::test]
    async fn un_pin_invalido_no_gasta_el_codigo() {
        let repo = FakeLogin::con(&[("admin", "Administrador")]);
        let nube = FakeNube::nueva();
        for malo in ["123", "1234567", "12a4", "", "12 34"] {
            assert!(confirmar(&repo, &nube, confirmar_input("123456", malo)).await.is_err(), "{malo:?}");
        }
        for codigo in ["12345", "abcdef", ""] {
            assert!(confirmar(&repo, &nube, confirmar_input(codigo, "4321")).await.is_err(), "{codigo:?}");
        }
        assert!(nube.llamadas().is_empty());
        assert!(repo.pines().is_empty());
    }
}
