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
//! Este caso de uso los recalcula y **avisa**. No corrige nada, ni siquiera el gasto del cliente,
//! que sí sería derivable sin ambigüedad: es un dato que el dueño del negocio mira y usa, y que la
//! aplicación se lo cambie de madrugada y sin decir nada es peor que enseñarle el descuadre. Quien
//! decide qué hacer con cada uno es él.

use tpv_domain::notificaciones::{Destino, NuevaNotificacion, Severidad, ADMIN_ROL_ID};

use crate::error::AppResult;
use crate::ports::notificaciones::Notifier;
use crate::ports::reconciliacion::{ClienteDescuadrado, LoteDescuadrado, ReconciliacionRepository};

/// Medio céntimo: por debajo de eso es ruido de coma flotante, no un descuadre.
pub const TOLERANCIA_DINERO: f64 = 0.005;

/// Milésima de unidad. El stock admite decimales (0,5 kg), así que la tolerancia es más fina que
/// la del dinero pero sigue absorbiendo el error de representación de sumar muchos REAL.
pub const TOLERANCIA_STOCK: f64 = 0.001;

/// Cuántas filas se enumeran en el cuerpo de un aviso antes de resumir con "y N más".
const MAX_EN_AVISO: usize = 5;

/// Claves de deduplicación: mientras el aviso siga activo no se emite otro, y se resuelve solo en
/// cuanto una pasada encuentra esa mitad cuadrada.
const CLAVE_STOCK: &str = "reconciliacion:stock";
const CLAVE_GASTO: &str = "reconciliacion:gasto";

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Resultado {
    pub clientes_descuadrados: usize,
    pub lotes_descuadrados: usize,
}

pub async fn ejecutar(
    repo: &dyn ReconciliacionRepository,
    notifier: &dyn Notifier,
) -> AppResult<Resultado> {
    let lotes = repo.lotes_descuadrados(TOLERANCIA_STOCK).await?;
    let clientes = repo.clientes_descuadrados(TOLERANCIA_DINERO).await?;

    avisar(
        notifier,
        CLAVE_STOCK,
        lotes.is_empty(),
        NuevaNotificacion {
            tipo: "stock_descuadrado".to_string(),
            severidad: Severidad::Aviso,
            titulo: titulo_stock(lotes.len()),
            cuerpo: Some(cuerpo_stock(&lotes)),
            destino: Destino::Rol(ADMIN_ROL_ID.to_string()),
            accion: Some("ver_inventario".to_string()),
            payload: None,
            clave_dedupe: Some(CLAVE_STOCK.to_string()),
            expira_en: None,
        },
    )
    .await;

    avisar(
        notifier,
        CLAVE_GASTO,
        clientes.is_empty(),
        NuevaNotificacion {
            tipo: "gasto_cliente_descuadrado".to_string(),
            severidad: Severidad::Aviso,
            titulo: titulo_gasto(clientes.len()),
            cuerpo: Some(cuerpo_gasto(&clientes)),
            destino: Destino::Rol(ADMIN_ROL_ID.to_string()),
            accion: Some("ver_clientes".to_string()),
            payload: None,
            clave_dedupe: Some(CLAVE_GASTO.to_string()),
            expira_en: None,
        },
    )
    .await;

    Ok(Resultado {
        clientes_descuadrados: clientes.len(),
        lotes_descuadrados: lotes.len(),
    })
}

/// Rehace el gasto acumulado de un cliente desde sus pagos. Acción manual: la lanza quien
/// gestiona el negocio desde la ficha del cliente, normalmente tras recibir el aviso.
pub async fn recalcular_gasto_de_cliente(
    repo: &dyn ReconciliacionRepository,
    id_cliente: &str,
) -> AppResult<Option<f64>> {
    let id = id_cliente.trim();
    if id.is_empty() {
        return Err(crate::error::AppError::validation("Falta el cliente"));
    }
    repo.recalcular_gasto(id).await
}

/// Emite el aviso, o lo cierra si la condición ya no se da (alguien lo arregló, o era una
/// operación de sync que acabó aplicándose). Best-effort: que falle el notificador no aborta la
/// otra mitad de la pasada.
async fn avisar(notifier: &dyn Notifier, clave: &str, cuadrado: bool, aviso: NuevaNotificacion) {
    if cuadrado {
        let _ = notifier.resolver_por_clave(clave).await;
    } else {
        let _ = notifier.emitir(aviso).await;
    }
}

fn titulo_stock(n: usize) -> String {
    if n == 1 {
        "Un lote no cuadra con su historial".to_string()
    } else {
        format!("{n} lotes no cuadran con su historial")
    }
}

fn titulo_gasto(n: usize) -> String {
    if n == 1 {
        "El gasto de un cliente no cuadra con sus cobros".to_string()
    } else {
        format!("El gasto de {n} clientes no cuadra con sus cobros")
    }
}

/// Cuerpo del aviso de stock: qué lote, cuánto se desvía y en qué dirección. Con el signo delante,
/// porque "sobran 3" y "faltan 3" llevan a mirar sitios distintos.
fn cuerpo_stock(lotes: &[LoteDescuadrado]) -> String {
    resumir(lotes.len(), lotes.iter().take(MAX_EN_AVISO).map(|l| {
        format!(
            "{} ({}): {}{:.3} — guardado {:.3}, calculado {:.3}",
            l.producto,
            l.codigo_lote,
            signo(l.desviacion()),
            l.desviacion(),
            l.guardado,
            l.calculado
        )
    }))
}

/// Cuerpo del aviso de gasto: en euros, y diciendo cuál es cuál — la ficha y lo que suman sus
/// cobros— para que se entienda sin abrir nada.
fn cuerpo_gasto(clientes: &[ClienteDescuadrado]) -> String {
    resumir(
        clientes.len(),
        clientes.iter().take(MAX_EN_AVISO).map(|c| {
            format!(
                "{}: la ficha dice {:.2} € y sus cobros suman {:.2} € ({}{:.2} €)",
                c.nombre,
                c.guardado,
                c.calculado,
                signo(c.desviacion()),
                c.desviacion()
            )
        }),
    )
}

fn signo(d: f64) -> &'static str {
    if d > 0.0 {
        "+"
    } else {
        ""
    }
}

fn resumir(total: usize, lineas: impl Iterator<Item = String>) -> String {
    let mut v: Vec<String> = lineas.collect();
    if total > MAX_EN_AVISO {
        v.push(format!("y {} más", total - MAX_EN_AVISO));
    }
    v.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use std::sync::Mutex;

    #[derive(Default)]
    struct RepoFalso {
        lotes: Vec<LoteDescuadrado>,
        clientes: Vec<ClienteDescuadrado>,
        /// Cuenta las correcciones: el job no debe provocar ninguna.
        recalculos: Mutex<usize>,
    }

    #[async_trait]
    impl ReconciliacionRepository for RepoFalso {
        async fn lotes_descuadrados(&self, _t: f64) -> AppResult<Vec<LoteDescuadrado>> {
            Ok(self.lotes.clone())
        }
        async fn clientes_descuadrados(&self, _t: f64) -> AppResult<Vec<ClienteDescuadrado>> {
            Ok(self.clientes.clone())
        }
        async fn recalcular_gasto(&self, _id: &str) -> AppResult<Option<f64>> {
            *self.recalculos.lock().unwrap() += 1;
            Ok(Some(0.0))
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

    fn cliente(nombre: &str, guardado: f64, calculado: f64) -> ClienteDescuadrado {
        ClienteDescuadrado {
            id_cliente: nombre.to_string(),
            nombre: nombre.to_string(),
            guardado,
            calculado,
        }
    }

    #[tokio::test]
    async fn sin_descuadres_cierra_los_dos_avisos_en_vez_de_emitir() {
        let notif = NotifierFalso::default();

        let r = ejecutar(&RepoFalso::default(), &notif).await.unwrap();

        assert_eq!(r, Resultado::default());
        assert!(notif.emitidas.lock().unwrap().is_empty());
        assert_eq!(
            notif.resueltas.lock().unwrap().as_slice(),
            [CLAVE_STOCK, CLAVE_GASTO]
        );
    }

    #[tokio::test]
    async fn cada_mitad_avisa_por_su_cuenta() {
        // Solo descuadra el gasto: el aviso de stock no debe salir, y además debe cerrarse.
        let repo = RepoFalso {
            clientes: vec![cliente("Ana", 180.0, 220.0)],
            ..Default::default()
        };
        let notif = NotifierFalso::default();

        let r = ejecutar(&repo, &notif).await.unwrap();

        assert_eq!(r.clientes_descuadrados, 1);
        assert_eq!(r.lotes_descuadrados, 0);

        let emitidas = notif.emitidas.lock().unwrap();
        assert_eq!(emitidas.len(), 1);
        assert_eq!(emitidas[0].clave_dedupe.as_deref(), Some(CLAVE_GASTO));
        assert_eq!(notif.resueltas.lock().unwrap().as_slice(), [CLAVE_STOCK]);
    }

    #[tokio::test]
    async fn el_job_no_corrige_el_gasto_de_nadie() {
        // La corrección existe (`recalcular_gasto`), pero es una acción manual desde la ficha del
        // cliente. Este test es la red que impide que alguien la enganche al job.
        let repo = RepoFalso {
            clientes: vec![cliente("Ana", 180.0, 220.0)],
            ..Default::default()
        };
        let notif = NotifierFalso::default();

        let r = ejecutar(&repo, &notif).await.unwrap();

        assert_eq!(r.clientes_descuadrados, 1, "se informa del descuadre");
        assert_eq!(*repo.recalculos.lock().unwrap(), 0, "y no se corrige nada");
    }

    #[test]
    fn el_cuerpo_del_stock_lleva_el_signo_de_la_desviacion() {
        assert!(cuerpo_stock(&[lote("a", 10.0, 7.0)]).contains("+3.000"));
        assert!(cuerpo_stock(&[lote("a", 7.0, 10.0)]).contains("-3.000"));
    }

    #[test]
    fn el_cuerpo_del_gasto_dice_ficha_y_cobros() {
        let cuerpo = cuerpo_gasto(&[cliente("Ana", 180.0, 220.0)]);

        assert!(cuerpo.contains("180.00"), "{cuerpo}");
        assert!(cuerpo.contains("220.00"), "{cuerpo}");
        assert!(cuerpo.contains("-40.00"), "falta gasto por acreditar: {cuerpo}");
    }

    #[test]
    fn los_cuerpos_resumen_cuando_hay_muchos() {
        let lotes: Vec<_> = (0..MAX_EN_AVISO + 3)
            .map(|i| lote(&i.to_string(), 1.0, 0.0))
            .collect();

        let cuerpo = cuerpo_stock(&lotes);

        assert_eq!(cuerpo.lines().count(), MAX_EN_AVISO + 1);
        assert!(cuerpo.ends_with("y 3 más"), "{cuerpo}");
    }
}
