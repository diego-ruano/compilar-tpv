//! Casos de uso de clientes (Local-First: lectura/escritura directa contra el repo).

use tpv_contracts::clientes::{
    ClienteForm, ClienteOverview, ClientesParaFactura, ClientesParaFacturaArgs, CreateClienteInput,
    GuardarDatosFiscalesInput, UpdateClienteInput,
};
use tpv_domain::clientes::{Cliente, ClienteRanking, DatosFiscales, NuevoCliente};
use tpv_domain::verifactu::{validar_destinatario, Destinatario};

use crate::error::{AppError, AppResult};
use crate::ports::clientes::{ClientesFacturaRepository, ClientesRepository};

/// Overview de clientes según el ranking recibido de la UI.
pub async fn listar_overview(
    repo: &dyn ClientesRepository,
    ranking_arg: &str,
) -> AppResult<Vec<ClienteOverview>> {
    repo.overview(ClienteRanking::from_arg(ranking_arg)).await
}

/// Formulario de un cliente. Id no positivo => `None` (sin tocar el repo).
pub async fn obtener_form(
    repo: &dyn ClientesRepository,
    id_cliente: String,
) -> AppResult<Option<ClienteForm>> {
    let id_cliente = id_cliente.trim();
    if id_cliente.is_empty() {
        return Ok(None);
    }
    repo.form(id_cliente).await
}

/// Crea un cliente tras validar en el dominio.
pub async fn crear_cliente(
    repo: &dyn ClientesRepository,
    input: CreateClienteInput,
) -> AppResult<bool> {
    let nuevo = NuevoCliente::validar(
        input.id_cliente,
        input.nombre,
        input.email,
        input.telefono,
        input.notas,
        DatosFiscales {
            nif: input.nif,
            razon_social: input.razon_social,
            direccion_fiscal: input.direccion_fiscal,
        },
    )
    .map_err(AppError::validation)?;

    repo.create(nuevo).await
}

/// Actualiza un cliente tras validar en el dominio.
pub async fn actualizar_cliente(
    repo: &dyn ClientesRepository,
    input: UpdateClienteInput,
) -> AppResult<bool> {
    let cliente = Cliente::validar_edicion(
        input.id_cliente,
        input.nombre,
        input.email,
        input.telefono,
        input.notas,
        DatosFiscales {
            nif: input.nif,
            razon_social: input.razon_social,
            direccion_fiscal: input.direccion_fiscal,
        },
    )
    .map_err(AppError::validation)?;

    repo.update(cliente).await
}

/// FISCAL-02 · Las fichas para el formulario de la factura completa, y la del cliente de la comanda
/// que se cobra si se sabe.
pub async fn clientes_para_factura(
    repo: &dyn ClientesFacturaRepository,
    args: ClientesParaFacturaArgs,
) -> AppResult<ClientesParaFactura> {
    let id_comanda = args.id_comanda.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    repo.para_factura(id_comanda.as_deref()).await
}

/// FISCAL-02 · Guarda en la ficha del cliente los datos con los que se acaba de facturar, y devuelve
/// el id de la ficha.
///
/// Se llama **después** de cobrar o de emitir la factura, nunca antes ni dentro: lo que se guarde
/// aquí no puede impedir ni deshacer el cobro. Se validan como el destinatario de la factura
/// (`validar_destinatario`), así que en la ficha queda lo mismo que en el papel.
///
/// La ficha es la elegida (`id_cliente`); si no se eligió ninguna (o ya no existe), la que tenga ese
/// NIF; y si tampoco la hay, una nueva con la razón social de nombre. Buscar por el NIF hace que
/// repetir la llamada no dé de alta dos fichas.
///
/// FISCAL-03 · Con la ficha resuelta, el gasto de los cobros facturados (`ids_pago`) pasa a ella:
/// quien pide la factura es quien paga, aunque la mesa fuera de la reserva de otro.
pub async fn guardar_datos_fiscales(
    repo: &dyn ClientesFacturaRepository,
    input: GuardarDatosFiscalesInput,
) -> AppResult<String> {
    let d = validar_destinatario(Destinatario {
        nombre_razon: input.razon_social,
        nif: input.nif,
        direccion: input.direccion_fiscal,
    })
    .map_err(|e| AppError::validation(e.mensaje()))?;
    let datos = DatosFiscales {
        nif: Some(d.nif.clone()),
        razon_social: Some(d.nombre_razon.clone()),
        direccion_fiscal: d.direccion,
    };

    let elegida = input.id_cliente.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let id = ficha_con_datos(repo, elegida, &d.nif, &d.nombre_razon, &datos).await?;
    let ids_pago: Vec<String> =
        input.ids_pago.iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    if !ids_pago.is_empty() {
        repo.apuntar_gasto(&id, &ids_pago).await?;
    }
    Ok(id)
}

/// La ficha donde quedan los datos: la elegida, la de ese NIF o una nueva.
async fn ficha_con_datos(
    repo: &dyn ClientesFacturaRepository,
    elegida: Option<String>,
    nif: &str,
    nombre: &str,
    datos: &DatosFiscales,
) -> AppResult<String> {
    if let Some(id) = elegida {
        if repo.actualizar_datos_fiscales(&id, datos).await? {
            return Ok(id);
        }
    }
    if let Some(id) = repo.id_por_nif(nif).await? {
        if repo.actualizar_datos_fiscales(&id, datos).await? {
            return Ok(id);
        }
    }
    repo.alta_con_datos_fiscales(nombre, datos).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;

    struct RepoQueNoDebeLlamarse;

    #[async_trait]
    impl ClientesRepository for RepoQueNoDebeLlamarse {
        async fn overview(&self, _: ClienteRanking) -> AppResult<Vec<ClienteOverview>> {
            panic!("repo llamado")
        }
        async fn form(&self, _: &str) -> AppResult<Option<ClienteForm>> {
            panic!("repo llamado")
        }
        async fn create(&self, _: NuevoCliente) -> AppResult<bool> {
            panic!("repo llamado")
        }
        async fn update(&self, _: Cliente) -> AppResult<bool> {
            panic!("repo llamado")
        }
    }

    /// Un doble del repositorio de la factura: fichas en memoria y lo que se le pide.
    #[derive(Default)]
    struct FichasEnMemoria {
        fichas: std::sync::Mutex<Vec<(String, DatosFiscales)>>,
        altas: std::sync::Mutex<Vec<String>>,
        gastos: std::sync::Mutex<Vec<(String, Vec<String>)>>,
    }

    #[async_trait]
    impl ClientesFacturaRepository for FichasEnMemoria {
        async fn para_factura(&self, _: Option<&str>) -> AppResult<ClientesParaFactura> {
            unreachable!()
        }
        async fn id_por_nif(&self, nif: &str) -> AppResult<Option<String>> {
            let fichas = self.fichas.lock().unwrap();
            Ok(fichas.iter().find(|(_, d)| d.nif.as_deref() == Some(nif)).map(|(id, _)| id.clone()))
        }
        async fn actualizar_datos_fiscales(&self, id: &str, datos: &DatosFiscales) -> AppResult<bool> {
            let mut fichas = self.fichas.lock().unwrap();
            match fichas.iter_mut().find(|(i, _)| i == id) {
                Some((_, d)) => {
                    *d = datos.clone();
                    Ok(true)
                }
                None => Ok(false),
            }
        }
        async fn alta_con_datos_fiscales(&self, nombre: &str, datos: &DatosFiscales) -> AppResult<String> {
            let id = format!("nuevo-{}", self.altas.lock().unwrap().len() + 1);
            self.altas.lock().unwrap().push(nombre.to_string());
            self.fichas.lock().unwrap().push((id.clone(), datos.clone()));
            Ok(id)
        }
        async fn apuntar_gasto(&self, id: &str, ids_pago: &[String]) -> AppResult<u64> {
            self.gastos.lock().unwrap().push((id.to_string(), ids_pago.to_vec()));
            Ok(1)
        }
    }

    fn guardar(id: Option<&str>, nif: &str) -> GuardarDatosFiscalesInput {
        GuardarDatosFiscalesInput {
            id_cliente: id.map(str::to_string),
            nif: nif.into(),
            razon_social: "  Comidas  SL ".into(),
            direccion_fiscal: Some(" Calle Mayor 1 ".into()),
            ids_pago: Vec::new(),
        }
    }

    #[tokio::test]
    async fn guardar_datos_fiscales_actualiza_la_ficha_elegida_normalizados_como_la_factura() {
        let repo = FichasEnMemoria::default();
        repo.fichas.lock().unwrap().push(("c1".into(), DatosFiscales::default()));
        let id = guardar_datos_fiscales(&repo, guardar(Some("c1"), "b-12345674")).await.unwrap();
        assert_eq!(id, "c1");
        let fichas = repo.fichas.lock().unwrap();
        assert_eq!(
            fichas[0].1,
            DatosFiscales {
                nif: Some("B12345674".into()),
                razon_social: Some("Comidas SL".into()),
                direccion_fiscal: Some("Calle Mayor 1".into()),
            }
        );
        assert!(repo.altas.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn guardar_datos_fiscales_sin_ficha_usa_la_del_mismo_nif_y_si_no_da_de_alta_una() {
        let repo = FichasEnMemoria::default();
        let primera = guardar_datos_fiscales(&repo, guardar(None, "B12345674")).await.unwrap();
        assert_eq!(repo.altas.lock().unwrap().as_slice(), ["Comidas SL"]);
        // Repetirlo, o elegir una ficha que ya no existe, no da de alta otra: va a la del NIF.
        assert_eq!(guardar_datos_fiscales(&repo, guardar(None, "B12345674")).await.unwrap(), primera);
        assert_eq!(guardar_datos_fiscales(&repo, guardar(Some("borrada"), "B12345674")).await.unwrap(), primera);
        assert_eq!(repo.altas.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn guardar_datos_fiscales_pasa_el_gasto_de_los_cobros_a_la_ficha() {
        // FISCAL-03: quien pide la factura es quien paga. Sin cobros, el gasto no se toca.
        let repo = FichasEnMemoria::default();
        let id = guardar_datos_fiscales(&repo, guardar(None, "B12345674")).await.unwrap();
        assert!(repo.gastos.lock().unwrap().is_empty());
        let mut con_cobros = guardar(None, "B12345674");
        con_cobros.ids_pago = vec![" p1 ".into(), "".into(), "p2".into()];
        assert_eq!(guardar_datos_fiscales(&repo, con_cobros).await.unwrap(), id);
        assert_eq!(repo.gastos.lock().unwrap().as_slice(), [(id, vec!["p1".to_string(), "p2".to_string()])]);
    }

    #[tokio::test]
    async fn guardar_datos_fiscales_con_un_nif_que_no_vale_no_toca_nada() {
        let repo = FichasEnMemoria::default();
        let mut con_cobros = guardar(None, "12345678A");
        con_cobros.ids_pago = vec!["p1".into()];
        let e = guardar_datos_fiscales(&repo, con_cobros).await.unwrap_err();
        assert!(matches!(e, AppError::Validation(_)));
        assert!(repo.fichas.lock().unwrap().is_empty());
        assert!(repo.gastos.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn obtener_form_con_id_vacio_no_toca_repo() {
        assert!(obtener_form(&RepoQueNoDebeLlamarse, "   ".into())
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn crear_cliente_invalido_no_toca_repo() {
        let input = CreateClienteInput {
            id_cliente: None,
            nombre: " ".into(),
            email: None,
            telefono: None,
            notas: None,
            nif: None,
            razon_social: None,
            direccion_fiscal: None,
        };
        assert!(matches!(
            crear_cliente(&RepoQueNoDebeLlamarse, input).await,
            Err(AppError::Validation(_))
        ));
    }

    #[tokio::test]
    async fn actualizar_cliente_exige_id_y_nombre_validos() {
        let sin_id = UpdateClienteInput { id_cliente: " ".into(), nombre: "Ana".into(), email: None, telefono: None, notas: None, nif: None, razon_social: None, direccion_fiscal: None };
        let sin_nombre = UpdateClienteInput { id_cliente: "c1".into(), nombre: " ".into(), email: None, telefono: None, notas: None, nif: None, razon_social: None, direccion_fiscal: None };
        assert!(matches!(actualizar_cliente(&RepoQueNoDebeLlamarse, sin_id).await, Err(AppError::Validation(_))));
        assert!(matches!(actualizar_cliente(&RepoQueNoDebeLlamarse, sin_nombre).await, Err(AppError::Validation(_))));
    }

    #[tokio::test]
    async fn crear_cliente_rechaza_email_mal_formado() {
        let input = CreateClienteInput {
            id_cliente: Some("c1".into()), nombre: "Ana".into(),
            email: Some("correo-sin-arroba".into()), telefono: None, notas: None,
            nif: None, razon_social: None, direccion_fiscal: None,
        };
        assert!(matches!(crear_cliente(&RepoQueNoDebeLlamarse, input).await, Err(AppError::Validation(_))));
    }
}
