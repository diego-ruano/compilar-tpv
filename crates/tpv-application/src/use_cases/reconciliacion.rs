//! Reconciliación periódica de los valores derivados (INV-06 / DB-14).
//!
//! Dos cifras del TPV son suma de otras filas y se guardan aparte por rendimiento:
//!
//!   · `Lotes_Producto.Stock_Disponible` = movimientos de ese lote − consumos de ese lote
//!   · `Clientes.Total_Gastado`          = suma de los pagos de sus comandas
//!
//! Mientras todo va bien coinciden. Cuando no —un cobro que commitea y falla al sumar el gasto,
//! una operación de la nube que la Main no pudo aplicar y acabó en cuarentena— el valor guardado
//! se queda viejo **sin ningún síntoma visible**: no hay error, no falta un ticket, simplemente el
//! número deja de ser verdad.
//!
//! Este caso de uso los vuelve a calcular y actúa distinto según si se puede saber cuál es el
//! valor correcto:
//!
//!   · el gasto del cliente **se corrige** (es derivable al 100 % de `Pagos`),
//!   · el stock **solo se avisa** (no se puede saber si sobra en la columna o falta un movimiento,
//!     y machacarlo podría borrar stock que existe de verdad en el almacén).

use tpv_domain::notificaciones::{Destino, NuevaNotificacion, Severidad, ADMIN_ROL_ID};

use crate::error::AppResult;
use crate::ports::notificaciones::Notifier;
use crate::ports::reconciliacion::{LoteDescuadrado, ReconciliacionRepository};

/// Medio céntimo: por debajo de eso es ruido de coma flotante, no un descuadre.
pub const TOLERANCIA_DINERO: f64 = 0.005;

/// Milésima de unidad. El stock admite decimales (0,5 kg), así que la tolerancia es más fina que
/// la del dinero pero sigue absorbiendo el error de representación de sumar muchos REAL.
pub const TOLERANCIA_STOCK: f64 = 0.001;

/// Cuántos lotes se enumeran en el cuerpo del aviso antes de resumir con "y N más".
const MAX_LOTES_EN_AVISO: usize = 5;

/// Clave de deduplicación del aviso de stock: mientras siga activa no se emite otro, y se resuelve
/// sola en cuanto una pasada encuentra todo cuadrado.
const CLAVE_STOCK: &str = "reconciliacion:stock";

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Resultado {
    pub clientes_corregidos: usize,
    pub lotes_descuadrados: usize,
}

pub async fn ejecutar(
    repo: &dyn ReconciliacionRepository,
    notifier: &dyn Notifier,
) -> AppResult<Resultado> {
    // ── Gasto de clientes: derivable, así que se corrige y no se molesta a nadie ──────────────
    let corregidos = repo.corregir_gasto_de_clientes(TOLERANCIA_DINERO).await?;

    // ── Stock por lote: solo se avisa ────────────────────────────────────────────────────────
    let descuadrados = repo.lotes_descuadrados(TOLERANCIA_STOCK).await?;

    if descuadrados.is_empty() {
        // La condición desapareció (alguien lo arregló, o era una op de sync que acabó
        // aplicándose): se cierra el aviso para que no quede colgado.
        let _ = notifier.resolver_por_clave(CLAVE_STOCK).await;
    } else {
        let _ = notifier
            .emitir(NuevaNotificacion {
                tipo: "stock_descuadrado".to_string(),
                severidad: Severidad::Aviso,
                titulo: titulo_stock(descuadrados.len()),
                cuerpo: Some(cuerpo_stock(&descuadrados)),
                destino: Destino::Rol(ADMIN_ROL_ID.to_string()),
                accion: Some("ver_inventario".to_string()),
                payload: None,
                clave_dedupe: Some(CLAVE_STOCK.to_string()),
                expira_en: None,
            })
            .await;
    }

    Ok(Resultado {
        clientes_corregidos: corregidos.len(),
        lotes_descuadrados: descuadrados.len(),
    })
}

fn titulo_stock(n: usize) -> String {
    if n == 1 {
        "Un lote no cuadra con su historial".to_string()
    } else {
        format!("{n} lotes no cuadran con su historial")
    }
}

/// Cuerpo del aviso: qué lote, cuánto se desvía y en qué dirección. Con el signo delante, porque
/// "sobran 3" y "faltan 3" llevan a mirar sitios distintos.
fn cuerpo_stock(lotes: &[LoteDescuadrado]) -> String {
    let mut lineas: Vec<String> = lotes
        .iter()
        .take(MAX_LOTES_EN_AVISO)
        .map(|l| {
            let d = l.desviacion();
            let signo = if d > 0.0 { "+" } else { "" };
            format!(
                "{} ({}): {}{:.3} — guardado {:.3}, calculado {:.3}",
                l.producto, l.codigo_lote, signo, d, l.guardado, l.calculado
            )
        })
        .collect();

    if lotes.len() > MAX_LOTES_EN_AVISO {
        lineas.push(format!("y {} más", lotes.len() - MAX_LOTES_EN_AVISO));
    }

    lineas.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ports::notificaciones::Notifier;
    use crate::ports::reconciliacion::ClienteCorregido;
    use async_trait::async_trait;
    use std::sync::Mutex;

    #[derive(Default)]
    struct RepoFalso {
        lotes: Vec<LoteDescuadrado>,
        clientes: Vec<ClienteCorregido>,
    }

    #[async_trait]
    impl ReconciliacionRepository for RepoFalso {
        async fn lotes_descuadrados(&self, _t: f64) -> AppResult<Vec<LoteDescuadrado>> {
            Ok(self.lotes.clone())
        }
        async fn corregir_gasto_de_clientes(&self, _t: f64) -> AppResult<Vec<ClienteCorregido>> {
            Ok(self.clientes.clone())
        }
    }

    #[derive(Default)]
    struct NotifierFalso {
        emitidas: Mutex<Vec<NuevaNotificacion>>,
        resueltas: Mutex<Vec<String>>,
    }

    #[async_trait]
    impl Notifier for NotifierFalso {
        async fn emitir(&self, nueva: NuevaNotificacion) -> AppResult<String> {
            self.emitidas.lock().unwrap().push(nueva);
            Ok("id".to_string())
        }
        async fn resolver_por_clave(&self, clave: &str) -> AppResult<bool> {
            self.resueltas.lock().unwrap().push(clave.to_string());
            Ok(true)
        }
    }

    fn lote(id: &str, guardado: f64, calculado: f64) -> LoteDescuadrado {
        LoteDescuadrado {
            id_lote: id.to_string(),
            codigo_lote: format!("L-{id}"),
            producto: "Cerveza".to_string(),
            guardado,
            calculado,
        }
    }

    #[tokio::test]
    async fn sin_descuadres_cierra_el_aviso_en_vez_de_emitir() {
        let repo = RepoFalso::default();
        let notif = NotifierFalso::default();

        let r = ejecutar(&repo, &notif).await.unwrap();

        assert_eq!(r, Resultado::default());
        assert!(notif.emitidas.lock().unwrap().is_empty());
        assert_eq!(notif.resueltas.lock().unwrap().as_slice(), [CLAVE_STOCK]);
    }

    #[tokio::test]
    async fn con_descuadres_avisa_una_sola_vez_y_con_la_clave_de_dedupe() {
        let repo = RepoFalso {
            lotes: vec![lote("a", 10.0, 7.0)],
            ..Default::default()
        };
        let notif = NotifierFalso::default();

        let r = ejecutar(&repo, &notif).await.unwrap();

        assert_eq!(r.lotes_descuadrados, 1);
        let emitidas = notif.emitidas.lock().unwrap();
        assert_eq!(emitidas.len(), 1);
        assert_eq!(emitidas[0].clave_dedupe.as_deref(), Some(CLAVE_STOCK));
        assert!(notif.resueltas.lock().unwrap().is_empty());
    }

    #[test]
    fn el_cuerpo_lleva_el_signo_de_la_desviacion() {
        let sobra = cuerpo_stock(&[lote("a", 10.0, 7.0)]);
        assert!(sobra.contains("+3.000"), "sobra stock → signo +: {sobra}");

        let falta = cuerpo_stock(&[lote("a", 7.0, 10.0)]);
        assert!(falta.contains("-3.000"), "falta stock → signo -: {falta}");
    }

    #[test]
    fn el_cuerpo_resume_cuando_hay_muchos() {
        let lotes: Vec<_> = (0..MAX_LOTES_EN_AVISO + 3)
            .map(|i| lote(&i.to_string(), 1.0, 0.0))
            .collect();

        let cuerpo = cuerpo_stock(&lotes);

        assert_eq!(cuerpo.lines().count(), MAX_LOTES_EN_AVISO + 1);
        assert!(cuerpo.ends_with("y 3 más"), "{cuerpo}");
    }

    #[tokio::test]
    async fn el_gasto_corregido_se_cuenta_pero_no_genera_aviso() {
        let repo = RepoFalso {
            clientes: vec![ClienteCorregido {
                id_cliente: "c1".to_string(),
                nombre: "Ana".to_string(),
                antes: 10.0,
                despues: 12.5,
            }],
            ..Default::default()
        };
        let notif = NotifierFalso::default();

        let r = ejecutar(&repo, &notif).await.unwrap();

        assert_eq!(r.clientes_corregidos, 1);
        assert!(
            notif.emitidas.lock().unwrap().is_empty(),
            "corregir un valor derivable no molesta a nadie"
        );
    }
}
