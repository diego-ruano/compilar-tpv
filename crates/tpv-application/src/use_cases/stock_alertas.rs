//! Escáner de **stock negativo** (corre en la Main). Desde VR-06 los lotes pueden quedar en negativo
//! (sobreventa); este caso de uso avisa **una vez por producto** cuando su stock total baja de cero
//! y **cierra** el aviso cuando el producto se recupera.
//!
//! La deduplicación es la de siempre (`clave_dedupe`): mientras la notificación de un producto siga
//! activa no se emite otra, así que vender más unidades del mismo producto en negativo **no** genera
//! avisos nuevos. La cantidad va en el cuerpo y se actualiza en cada pasada sin volver a ponerla como
//! no leída (RI-12: eso sólo lo hacen un título o una severidad nuevos); sólo `resolver_por_clave`
//! la cierra. Cuando una pasada
//! encuentra que un producto que tenía aviso ya no está en negativo, lo resuelve; si reincide, vuelve
//! a saltar. Mismo patrón que `reconciliacion` y `avisos`.

use std::collections::HashSet;

use tpv_domain::notificaciones::{Destino, NuevaNotificacion, Severidad, ADMIN_ROL_ID};

use crate::error::AppResult;
use crate::ports::notificaciones::Notifier;
use crate::ports::stock_alertas::{ProductoNegativo, StockAlertasRepository};

/// Prefijo de la clave de deduplicación: una notificación activa por producto en negativo. Es la
/// única fuente de esta cadena (se usa para emitir y para localizar/resolver las activas).
pub const CLAVE_PREFIJO: &str = "stock_negativo:";

/// Escanea productos en negativo, emite (deduplicado por producto) y resuelve los recuperados.
/// Devuelve cuántos productos están en negativo. Best-effort: que falle una emisión no aborta el
/// resto de la pasada.
pub async fn escanear(
    repo: &dyn StockAlertasRepository,
    notifier: &dyn Notifier,
) -> AppResult<usize> {
    let negativos = repo.productos_en_negativo().await?;
    let con_alerta = repo.productos_con_alerta_activa(CLAVE_PREFIJO).await?;

    let ids_negativos: HashSet<&str> = negativos.iter().map(|p| p.id_producto.as_str()).collect();

    // Un aviso por producto en negativo. La primera vez inserta; las siguientes pasadas re-emiten la
    // misma clave y `emitir` actualiza la cantidad del cuerpo sin duplicar ni volver a avisar →
    // nunca hay dos avisos del mismo producto ni "spam" al seguir vendiéndolo en negativo.
    for p in &negativos {
        let _ = notifier
            .emitir(NuevaNotificacion {
                tipo: "stock_negativo".to_string(),
                severidad: Severidad::Aviso,
                titulo: titulo(p),
                cuerpo: Some(cuerpo(p)),
                destino: Destino::Rol(ADMIN_ROL_ID.to_string()),
                accion: Some("ver_inventario".to_string()),
                payload: None,
                clave_dedupe: Some(format!("{CLAVE_PREFIJO}{}", p.id_producto)),
                expira_en: None,
            })
            .await;
    }

    // Cierre de los recuperados: tenían aviso activo y ya no están en negativo (alguien recontó o
    // repuso). Al resolverlos, si el producto vuelve a caer en negativo el aviso saltará de nuevo.
    for id in &con_alerta {
        if !ids_negativos.contains(id.as_str()) {
            let _ = notifier
                .resolver_por_clave(&format!("{CLAVE_PREFIJO}{id}"))
                .await;
        }
    }

    Ok(negativos.len())
}

fn nombre_visible(p: &ProductoNegativo) -> &str {
    if p.nombre.trim().is_empty() {
        "un producto"
    } else {
        p.nombre.trim()
    }
}

fn titulo(p: &ProductoNegativo) -> String {
    format!("Stock negativo: {}", nombre_visible(p))
}

fn cuerpo(p: &ProductoNegativo) -> String {
    format!(
        "«{}» tiene {:.3} en stock: se ha vendido más de lo registrado. Recuenta el inventario cuando puedas.",
        nombre_visible(p),
        p.stock_total
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use std::sync::Mutex;

    #[derive(Default)]
    struct RepoFalso {
        negativos: Vec<ProductoNegativo>,
        con_alerta: Vec<String>,
    }

    #[async_trait]
    impl StockAlertasRepository for RepoFalso {
        async fn productos_en_negativo(&self) -> AppResult<Vec<ProductoNegativo>> {
            Ok(self.negativos.clone())
        }
        async fn productos_con_alerta_activa(&self, _prefijo: &str) -> AppResult<Vec<String>> {
            Ok(self.con_alerta.clone())
        }
    }

    #[derive(Default)]
    struct NotifierFalso {
        emitidas: Mutex<Vec<NuevaNotificacion>>,
        resueltas: Mutex<Vec<String>>,
    }

    #[async_trait]
    impl Notifier for NotifierFalso {
        async fn emitir(&self, n: NuevaNotificacion) -> AppResult<String> {
            self.emitidas.lock().unwrap().push(n);
            Ok("n".to_string())
        }
        async fn resolver_por_clave(&self, clave: &str) -> AppResult<bool> {
            self.resueltas.lock().unwrap().push(clave.to_string());
            Ok(true)
        }
    }

    fn prod(id: &str, nombre: &str, total: f64) -> ProductoNegativo {
        ProductoNegativo {
            id_producto: id.to_string(),
            nombre: nombre.to_string(),
            stock_total: total,
        }
    }

    #[tokio::test]
    async fn emite_una_por_producto_en_negativo_con_su_clave() {
        let repo = RepoFalso {
            negativos: vec![prod("p1", "Cerveza", -3.0), prod("p2", "Vino", -1.5)],
            con_alerta: vec![],
        };
        let notif = NotifierFalso::default();

        let n = escanear(&repo, &notif).await.unwrap();

        assert_eq!(n, 2);
        let e = notif.emitidas.lock().unwrap();
        assert_eq!(e.len(), 2);
        assert!(e.iter().all(|x| x.tipo == "stock_negativo"));
        assert!(e.iter().any(|x| x.clave_dedupe.as_deref() == Some("stock_negativo:p1")));
        assert!(e.iter().any(|x| x.clave_dedupe.as_deref() == Some("stock_negativo:p2")));
        assert!(notif.resueltas.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn resuelve_el_aviso_de_un_producto_recuperado() {
        // p1 sigue en negativo; p2 tenía aviso activo pero ya no está en negativo → se cierra.
        let repo = RepoFalso {
            negativos: vec![prod("p1", "Cerveza", -3.0)],
            con_alerta: vec!["p1".to_string(), "p2".to_string()],
        };
        let notif = NotifierFalso::default();

        escanear(&repo, &notif).await.unwrap();

        // p1 se re-emite (dedupe lo absorbe en la infra), p2 se resuelve y p1 NO se resuelve.
        assert_eq!(
            notif.resueltas.lock().unwrap().as_slice(),
            ["stock_negativo:p2"]
        );
    }

    #[tokio::test]
    async fn sin_negativos_no_emite_nada() {
        let repo = RepoFalso::default();
        let notif = NotifierFalso::default();

        let n = escanear(&repo, &notif).await.unwrap();

        assert_eq!(n, 0);
        assert!(notif.emitidas.lock().unwrap().is_empty());
    }
}
