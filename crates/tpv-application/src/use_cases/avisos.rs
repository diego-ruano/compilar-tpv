//! Escáner periódico de avisos (corre en la Main). Consulta condiciones de tiempo/estado y emite
//! notificaciones con `clave_dedupe` → idempotente: re-escanear no duplica (el aviso ya activo se
//! suprime). Best-effort: un fallo de lectura o de emisión no aborta el resto.

use tpv_domain::notificaciones::{Destino, NuevaNotificacion, Severidad, ADMIN_ROL_ID};

use crate::error::AppResult;
use crate::ports::avisos::AvisosScanRepository;
use crate::ports::notificaciones::Notifier;

/// Antelación por defecto para "reserva próxima" (minutos). Confirmado: 30 min.
pub const VENTANA_RESERVA_MIN: i64 = 30;

pub async fn escanear(
    scan: &dyn AvisosScanRepository,
    notifier: &dyn Notifier,
    ventana_reserva_min: i64,
) -> AppResult<()> {
    // Tareas vencidas sin finalizar → administradores.
    if let Ok(tareas) = scan.tareas_vencidas().await {
        for t in tareas {
            let _ = notifier
                .emitir(NuevaNotificacion {
                    tipo: "tarea_vencida".to_string(),
                    severidad: Severidad::Aviso,
                    titulo: "Tarea vencida".to_string(),
                    cuerpo: Some(t.titulo),
                    destino: Destino::Rol(ADMIN_ROL_ID.to_string()),
                    accion: Some("ver_tareas".to_string()),
                    payload: None,
                    clave_dedupe: Some(format!("tarea_vencida:{}", t.id_tarea)),
                    expira_en: None,
                })
                .await;
        }
    }

    // Reservas próximas → administradores.
    if let Ok(reservas) = scan.reservas_proximas(ventana_reserva_min).await {
        for r in reservas {
            let cuerpo = if r.nombre_cliente.trim().is_empty() {
                format!("{} {}", r.dia_ymd, r.hora)
            } else {
                format!("{} · {} {}", r.nombre_cliente, r.dia_ymd, r.hora)
            };
            let _ = notifier
                .emitir(NuevaNotificacion {
                    tipo: "reserva_proxima".to_string(),
                    severidad: Severidad::Info,
                    titulo: "Reserva próxima".to_string(),
                    cuerpo: Some(cuerpo),
                    destino: Destino::Rol(ADMIN_ROL_ID.to_string()),
                    accion: Some("ver_reservas".to_string()),
                    payload: None,
                    clave_dedupe: Some(format!("reserva_proxima:{}", r.id_reserva)),
                    expira_en: None,
                })
                .await;
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ports::avisos::{ReservaProxima, TareaVencida};
    use async_trait::async_trait;
    use std::sync::Mutex;

    struct FakeScan {
        tareas: Vec<TareaVencida>,
        reservas: Vec<ReservaProxima>,
    }
    #[async_trait]
    impl AvisosScanRepository for FakeScan {
        async fn tareas_vencidas(&self) -> AppResult<Vec<TareaVencida>> {
            Ok(self.tareas.clone())
        }
        async fn reservas_proximas(&self, _v: i64) -> AppResult<Vec<ReservaProxima>> {
            Ok(self.reservas.clone())
        }
    }

    #[derive(Default)]
    struct FakeNotifier {
        emitidas: Mutex<Vec<NuevaNotificacion>>,
    }
    #[async_trait]
    impl Notifier for FakeNotifier {
        async fn emitir(&self, n: NuevaNotificacion) -> AppResult<String> {
            self.emitidas.lock().unwrap().push(n);
            Ok("n".into())
        }
        async fn resolver_por_clave(&self, _: &str) -> AppResult<bool> {
            Ok(false)
        }
    }

    #[tokio::test]
    async fn escanear_emite_por_cada_condicion_con_clave_de_dedupe() {
        let scan = FakeScan {
            tareas: vec![TareaVencida { id_tarea: "t1".into(), titulo: "Limpiar".into() }],
            reservas: vec![ReservaProxima {
                id_reserva: "r1".into(),
                nombre_cliente: "Ana".into(),
                dia_ymd: "2026-07-25".into(),
                hora: "20:30".into(),
            }],
        };
        let notifier = FakeNotifier::default();
        escanear(&scan, &notifier, 30).await.unwrap();

        let e = notifier.emitidas.lock().unwrap();
        assert_eq!(e.len(), 2);
        assert!(e.iter().all(|n| n.destino == Destino::Rol(ADMIN_ROL_ID.to_string())));
        assert!(e.iter().any(|n| n.clave_dedupe.as_deref() == Some("tarea_vencida:t1")));
        assert!(e.iter().any(|n| n.clave_dedupe.as_deref() == Some("reserva_proxima:r1")));
    }

    #[tokio::test]
    async fn escanear_sin_condiciones_no_emite() {
        let scan = FakeScan { tareas: vec![], reservas: vec![] };
        let notifier = FakeNotifier::default();
        escanear(&scan, &notifier, 30).await.unwrap();
        assert!(notifier.emitidas.lock().unwrap().is_empty());
    }
}
