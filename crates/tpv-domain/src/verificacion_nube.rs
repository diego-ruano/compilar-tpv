//! VERIF-02 · Cuándo se contrasta la base local con la nube.
//!
//! El contraste (`verificar_nube`) compara la base local con la de la nube por resúmenes: la
//! ventana de la fase 1 del negocio (30 días, o lo que quepa de ellos) resumida por cubos, y los
//! conteos de cada tabla entera. Corría a hora fija desde la última
//! pasada, que en un bar que enciende el TPV al abrir es justo la apertura: a la vez que la copia
//! diaria y la reconciliación, con el primer café en la barra. La regla es otra:
//!
//! - **Hay un motivo**: se ha cerrado la caja después de la última pasada buena (y el cierre lleva
//!   cinco minutos hecho), o han pasado veinte horas desde ella.
//! - **Es un momento tranquilo**: la Main está operativa, no queda histórico por bajar, no hay nada
//!   pendiente de subir ni un cambio de la nube detenido, la aplicación lleva diez minutos
//!   arrancada y hace un cuarto de hora que no se escribe nada.
//! - **No se queda sin correr**: a las 48 h de la última pasada buena basta con cinco minutos sin
//!   escribir. Lo demás no se relaja nunca: comparar con algo pendiente de subir o con el histórico
//!   a medias no es una comprobación, es ruido (o, peor, un borrado: VERIF-01).
//! - **Un intento que falla espera lo suyo**: 30 min, 1 h, 2 h, 4 h y 6 h. Uno que no llegó a
//!   comparar porque no era el momento (la nube estaba escribiendo o iba por delante de lo que ha
//!   bajado esta Main, o una de las dos bases se movió durante la pasada), 10 min.
//!
//! Es una función pura: quien la llama (el job, cada 15 min) le trae lo que hay y la hora.

const MIN: i64 = 60 * 1000;
const HORA: i64 = 60 * MIN;

/// Lo que tiene que llevar hecho un cierre de caja para contar como motivo: que la pasada no
/// arranque mientras todavía se está recogiendo.
pub const CIERRE_REPOSADO_MS: i64 = 5 * MIN;

/// DO-SUBIDA: lo que tiene que llevar entregada una subida completa para contar como motivo.
pub const SUBIDA_REPOSADA_MS: i64 = 5 * MIN;

/// Sin cierre de caja de por medio, cada cuánto se contrasta.
pub const PERIODO_MS: i64 = 20 * HORA;

/// A partir de aquí la calma exigida baja a [`CALMA_RELAJADA_MS`].
pub const MAXIMO_SIN_VERIFICAR_MS: i64 = 48 * HORA;

/// Lo que tiene que llevar arrancada la aplicación: el catch-up del arranque todavía está
/// aplicando lo que llegó con el equipo apagado.
pub const MARGEN_DE_ARRANQUE_MS: i64 = 10 * MIN;

/// Cuánto hace falta sin escribir nada para dar el momento por tranquilo.
pub const CALMA_MS: i64 = 15 * MIN;

/// Lo mismo, pasado [`MAXIMO_SIN_VERIFICAR_MS`].
pub const CALMA_RELAJADA_MS: i64 = 5 * MIN;

/// Lo que se espera tras un intento que no llegó a comparar porque no era el momento.
pub const ESPERA_TRAS_APLAZAR_MS: i64 = 10 * MIN;

/// Hasta cuánto por delante de la hora se cree la marca de la última escritura (una escritura
/// que entra mientras se decide, un reloj que se ajusta unos segundos). Más allá es de un reloj
/// que estuvo adelantado: no se cree, porque con ella el contraste esperaría hasta que el reloj la
/// alcanzase, y eso pueden ser días. Quien lee la base trae la última escritura que no pasa de aquí.
pub const MARCA_FUTURA_CREIBLE_MS: i64 = 5 * MIN;

/// Primera espera tras un fallo; se dobla con cada fallo seguido hasta [`ESPERA_FALLO_TECHO_MS`].
pub const ESPERA_FALLO_BASE_MS: i64 = 30 * MIN;
pub const ESPERA_FALLO_TECHO_MS: i64 = 6 * HORA;

/// Lo que la regla mira. Las horas son milisegundos de reloj de pared (época Unix).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EntradaVerificacion {
    /// La última pasada que llegó a comparar. `None` = nunca.
    pub ultima_ok_ms: Option<i64>,
    /// El último intento, acabara como acabara.
    pub ultimo_intento_ms: Option<i64>,
    /// Intentos fallidos seguidos desde la última vez que la nube contestó.
    pub fallos: i64,
    /// El último cierre de caja que sigue en pie (sin reabrir).
    pub ultimo_cierre_ms: Option<i64>,
    /// Main con datos sanos y sin una recuperación en curso.
    pub main_operativa: bool,
    /// Queda histórico por bajar tras una recuperación (VERIF-01).
    pub historico_pendiente: bool,
    /// Operaciones que todavía tienen que subir (sin las apartadas, que no van a subir solas).
    pub outbox_pendiente: i64,
    /// Hay un cambio de la nube detenido, reintentándose.
    pub bajada_detenida: bool,
    /// Lo que lleva arrancada la aplicación, en reloj monótono.
    pub desde_el_arranque_ms: i64,
    /// La última escritura en la base: una operación de aquí o un cambio aplicado de la nube.
    pub ultima_escritura_ms: Option<i64>,
    /// DO-SUBIDA: la Main está subiendo su base entera a una nube devuelta: hasta que acabe, la
    /// nube no está para compararla.
    pub subida_en_curso: bool,
    /// DO-SUBIDA: la subida completa se entregó a la nube en este instante y espera que una pasada
    /// la confirme. Es motivo, como un cierre de caja.
    pub subida_por_confirmar_ms: Option<i64>,
}

/// Por qué no toca todavía.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Espera {
    /// La Main no está operativa.
    NoOperativa,
    /// Queda histórico por bajar.
    HistoricoPendiente,
    /// DO-SUBIDA: la Main está subiendo su base entera a la nube.
    SubidaEnCurso,
    /// El último intento falló o se aplazó hace poco.
    Reintento,
    /// Ni un cierre de caja nuevo ni veinte horas desde la última pasada.
    SinMotivo,
    /// Hay operaciones pendientes de subir.
    SubidaPendiente,
    /// Hay un cambio de la nube detenido.
    BajadaDetenida,
    /// La aplicación acaba de arrancar.
    ArranqueReciente,
    /// Se ha escrito hace poco.
    ActividadReciente,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Ahora,
    Esperar(Espera),
}

/// Lo que se espera tras `fallos` intentos fallidos seguidos.
pub fn espera_tras_fallar_ms(fallos: i64) -> i64 {
    let doblar = fallos.saturating_sub(1).clamp(0, 16) as u32;
    ESPERA_FALLO_BASE_MS
        .saturating_mul(2i64.saturating_pow(doblar))
        .min(ESPERA_FALLO_TECHO_MS)
}

/// ¿Toca contrastar ahora?
///
/// Una marca guardada que cae en el futuro (alguien ha movido el reloj del equipo) no se cree:
/// la de una pasada o un intento cuenta como si no existiera, y lo peor que pasa es una pasada de
/// más. La de la última escritura cuenta como recién hecha si va hasta
/// [`MARCA_FUTURA_CREIBLE_MS`] por delante, y lo peor es esperar esos minutos; más allá no cuenta.
pub fn cuando_verificar(e: &EntradaVerificacion, ahora_ms: i64) -> Decision {
    use Decision::{Ahora, Esperar};

    // Lo que no depende de la hora y no se relaja nunca.
    if !e.main_operativa {
        return Esperar(Espera::NoOperativa);
    }
    if e.historico_pendiente {
        return Esperar(Espera::HistoricoPendiente);
    }
    if e.subida_en_curso {
        return Esperar(Espera::SubidaEnCurso);
    }

    let pasada = |marca: Option<i64>| marca.filter(|m| *m <= ahora_ms);
    let ultima_ok = pasada(e.ultima_ok_ms);
    let ultimo_intento = pasada(e.ultimo_intento_ms);

    // El último intento no acabó en una pasada buena: se espera lo que le toque.
    if let Some(intento) = ultimo_intento {
        if ultima_ok.is_none_or(|ok| intento > ok) {
            let espera = if e.fallos > 0 {
                espera_tras_fallar_ms(e.fallos)
            } else {
                ESPERA_TRAS_APLAZAR_MS
            };
            if ahora_ms - intento < espera {
                return Esperar(Espera::Reintento);
            }
        }
    }

    // El motivo.
    let sin_verificar = ultima_ok.map(|ok| ahora_ms - ok);
    let por_tiempo = sin_verificar.is_none_or(|t| t >= PERIODO_MS);
    let por_cierre = e.ultimo_cierre_ms.is_some_and(|cierre| {
        ultima_ok.is_none_or(|ok| cierre > ok) && ahora_ms - cierre >= CIERRE_REPOSADO_MS
    });
    // DO-SUBIDA: una subida completa entregada a la nube se confirma con una pasada, a los cinco
    // minutos (lo que la nube aplica de lo último sale en su log y lo baja esta Main), y se vuelve
    // a intentar mientras no salga limpia.
    let por_subida = e.subida_por_confirmar_ms.is_some_and(|fin| ahora_ms - fin >= SUBIDA_REPOSADA_MS);
    if !por_tiempo && !por_cierre && !por_subida {
        return Esperar(Espera::SinMotivo);
    }

    // El momento.
    if e.outbox_pendiente > 0 {
        return Esperar(Espera::SubidaPendiente);
    }
    if e.bajada_detenida {
        return Esperar(Espera::BajadaDetenida);
    }
    if e.desde_el_arranque_ms < MARGEN_DE_ARRANQUE_MS {
        return Esperar(Espera::ArranqueReciente);
    }
    let calma = if sin_verificar.is_none_or(|t| t >= MAXIMO_SIN_VERIFICAR_MS) {
        CALMA_RELAJADA_MS
    } else {
        CALMA_MS
    };
    let escritura = e
        .ultima_escritura_ms
        .filter(|m| *m <= ahora_ms.saturating_add(MARCA_FUTURA_CREIBLE_MS));
    if escritura.is_some_and(|m| ahora_ms - m < calma) {
        return Esperar(Espera::ActividadReciente);
    }

    Ahora
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Las 12:00 de un día cualquiera.
    const AHORA: i64 = 1_800_000_000_000;

    /// Una Main en calma que se contrastó hace `horas`: sin cierre, sin nada pendiente, arrancada
    /// hace una hora y sin escrituras desde hace una hora.
    fn hace(horas: i64) -> EntradaVerificacion {
        EntradaVerificacion {
            ultima_ok_ms: Some(AHORA - horas * HORA),
            ultimo_intento_ms: Some(AHORA - horas * HORA),
            fallos: 0,
            ultimo_cierre_ms: None,
            main_operativa: true,
            historico_pendiente: false,
            outbox_pendiente: 0,
            bajada_detenida: false,
            desde_el_arranque_ms: HORA,
            ultima_escritura_ms: Some(AHORA - HORA),
            subida_en_curso: false,
            subida_por_confirmar_ms: None,
        }
    }

    /// Lo mismo, con un cierre de caja hecho hace `minutos`.
    fn con_cierre_hace(horas: i64, minutos: i64) -> EntradaVerificacion {
        EntradaVerificacion { ultimo_cierre_ms: Some(AHORA - minutos * MIN), ..hace(horas) }
    }

    fn esperar(e: Espera) -> Decision {
        Decision::Esperar(e)
    }

    // DO-SUBIDA: con la subida completa en curso no se contrasta nunca; entregada, es motivo a los
    // cinco minutos, pero sin relajar la calma.
    #[test]
    fn la_subida_completa_espera_y_despues_es_motivo() {
        let subiendo = EntradaVerificacion { subida_en_curso: true, ..hace(30) };
        assert_eq!(cuando_verificar(&subiendo, AHORA), esperar(Espera::SubidaEnCurso));
        let recien = EntradaVerificacion { subida_por_confirmar_ms: Some(AHORA - 4 * MIN), ..hace(3) };
        assert_eq!(cuando_verificar(&recien, AHORA), esperar(Espera::SinMotivo));
        let reposada = EntradaVerificacion { subida_por_confirmar_ms: Some(AHORA - 5 * MIN), ..hace(3) };
        assert_eq!(cuando_verificar(&reposada, AHORA), Decision::Ahora);
        let con_prisa = EntradaVerificacion { ultima_escritura_ms: Some(AHORA - MIN), ..reposada.clone() };
        assert_eq!(cuando_verificar(&con_prisa, AHORA), esperar(Espera::ActividadReciente));
        let historico = EntradaVerificacion { historico_pendiente: true, ..reposada };
        assert_eq!(cuando_verificar(&historico, AHORA), esperar(Espera::HistoricoPendiente));
    }

    #[test]
    fn la_tabla_de_la_regla() {
        let casos: Vec<(&str, EntradaVerificacion, Decision)> = vec![
            // ── El motivo ────────────────────────────────────────────────────────────────────
            ("contrastada hace 3 h y sin cierre: no hay motivo", hace(3), esperar(Espera::SinMotivo)),
            ("a las 19 h 59 min todavía no", EntradaVerificacion {
                ultima_ok_ms: Some(AHORA - 20 * HORA + MIN), ..hace(3)
            }, esperar(Espera::SinMotivo)),
            ("a las 20 h, sí", hace(20), Decision::Ahora),
            ("nunca se ha contrastado: toca", EntradaVerificacion {
                ultima_ok_ms: None, ultimo_intento_ms: None, ..hace(3)
            }, Decision::Ahora),
            ("un cierre de caja posterior a la última pasada, hecho hace 20 min", con_cierre_hace(3, 20), Decision::Ahora),
            ("un cierre de hace 4 min todavía se está recogiendo", EntradaVerificacion {
                ultima_escritura_ms: Some(AHORA - 4 * MIN), ..con_cierre_hace(3, 4)
            }, esperar(Espera::SinMotivo)),
            ("a los 5 min del cierre hay motivo, pero aún no hay calma", EntradaVerificacion {
                ultima_escritura_ms: Some(AHORA - 5 * MIN), ..con_cierre_hace(3, 5)
            }, esperar(Espera::ActividadReciente)),
            ("un cierre anterior a la última pasada ya se contrastó", con_cierre_hace(3, 4 * 60), esperar(Espera::SinMotivo)),
            ("un cierre reabierto no llega aquí: sin cierre no hay motivo", EntradaVerificacion {
                ultimo_cierre_ms: None, ..hace(3)
            }, esperar(Espera::SinMotivo)),

            // ── El momento ───────────────────────────────────────────────────────────────────
            ("con algo pendiente de subir, espera", EntradaVerificacion { outbox_pendiente: 1, ..hace(20) }, esperar(Espera::SubidaPendiente)),
            ("con un cambio de la nube detenido, espera", EntradaVerificacion { bajada_detenida: true, ..hace(20) }, esperar(Espera::BajadaDetenida)),
            ("recién arrancada (9 min), espera", EntradaVerificacion { desde_el_arranque_ms: 9 * MIN, ..hace(20) }, esperar(Espera::ArranqueReciente)),
            ("a los 10 min del arranque, ya", EntradaVerificacion { desde_el_arranque_ms: 10 * MIN, ..hace(20) }, Decision::Ahora),
            ("una escritura hace 14 min: no es un momento tranquilo", EntradaVerificacion {
                ultima_escritura_ms: Some(AHORA - 14 * MIN), ..hace(20)
            }, esperar(Espera::ActividadReciente)),
            ("una escritura hace 15 min: sí", EntradaVerificacion {
                ultima_escritura_ms: Some(AHORA - 15 * MIN), ..hace(20)
            }, Decision::Ahora),
            ("sin ninguna escritura registrada hay calma", EntradaVerificacion { ultima_escritura_ms: None, ..hace(20) }, Decision::Ahora),

            // ── El máximo de 48 h ────────────────────────────────────────────────────────────
            ("a las 47 h, 6 min sin escribir no bastan", EntradaVerificacion {
                ultima_escritura_ms: Some(AHORA - 6 * MIN), ..hace(47)
            }, esperar(Espera::ActividadReciente)),
            ("a las 48 h, 5 min sin escribir bastan", EntradaVerificacion {
                ultima_escritura_ms: Some(AHORA - 5 * MIN), ..hace(48)
            }, Decision::Ahora),
            ("a las 48 h, 4 min sin escribir no", EntradaVerificacion {
                ultima_escritura_ms: Some(AHORA - 4 * MIN), ..hace(48)
            }, esperar(Espera::ActividadReciente)),
            ("nunca contrastada cuenta como pasada de las 48 h", EntradaVerificacion {
                ultima_ok_ms: None, ultimo_intento_ms: None, ultima_escritura_ms: Some(AHORA - 5 * MIN), ..hace(3)
            }, Decision::Ahora),
            ("ni a los 30 días se contrasta con algo pendiente de subir", EntradaVerificacion {
                outbox_pendiente: 3, ..hace(30 * 24)
            }, esperar(Espera::SubidaPendiente)),
            ("ni con un cambio detenido", EntradaVerificacion { bajada_detenida: true, ..hace(30 * 24) }, esperar(Espera::BajadaDetenida)),
            ("ni recién arrancada", EntradaVerificacion { desde_el_arranque_ms: MIN, ..hace(30 * 24) }, esperar(Espera::ArranqueReciente)),

            // ── Lo que no se relaja nunca ────────────────────────────────────────────────────
            ("con el histórico a medias no se contrasta, ni a los 30 días (VERIF-01)", EntradaVerificacion {
                historico_pendiente: true, ..hace(30 * 24)
            }, esperar(Espera::HistoricoPendiente)),
            ("una Main que no está operativa no contrasta", EntradaVerificacion {
                main_operativa: false, ..hace(30 * 24)
            }, esperar(Espera::NoOperativa)),

            // ── Tras un intento que no acabó en una pasada buena ─────────────────────────────
            ("un fallo hace 29 min: espera", EntradaVerificacion {
                ultimo_intento_ms: Some(AHORA - 29 * MIN), fallos: 1, ..hace(20)
            }, esperar(Espera::Reintento)),
            ("un fallo hace 30 min: se reintenta", EntradaVerificacion {
                ultimo_intento_ms: Some(AHORA - 30 * MIN), fallos: 1, ..hace(20)
            }, Decision::Ahora),
            ("dos fallos seguidos: una hora", EntradaVerificacion {
                ultimo_intento_ms: Some(AHORA - 59 * MIN), fallos: 2, ..hace(20)
            }, esperar(Espera::Reintento)),
            ("cinco fallos: seis horas, no ocho", EntradaVerificacion {
                ultimo_intento_ms: Some(AHORA - 6 * HORA), fallos: 5, ..hace(40)
            }, Decision::Ahora),
            ("cincuenta fallos: seis horas", EntradaVerificacion {
                ultimo_intento_ms: Some(AHORA - 6 * HORA + MIN), fallos: 50, ..hace(40)
            }, esperar(Espera::Reintento)),
            ("el fallo manda sobre las 48 h: no se martillea a una nube caída", EntradaVerificacion {
                ultimo_intento_ms: Some(AHORA - 10 * MIN), fallos: 1, ..hace(72)
            }, esperar(Espera::Reintento)),
            ("la foto iba por delante hace 9 min: espera", EntradaVerificacion {
                ultimo_intento_ms: Some(AHORA - 9 * MIN), ..hace(20)
            }, esperar(Espera::Reintento)),
            ("la foto iba por delante hace 10 min: se reintenta", EntradaVerificacion {
                ultimo_intento_ms: Some(AHORA - 10 * MIN), ..hace(20)
            }, Decision::Ahora),
            ("un intento anterior a la última pasada buena no hace esperar", EntradaVerificacion {
                ultimo_intento_ms: Some(AHORA - 21 * HORA), fallos: 3, ..hace(20)
            }, Decision::Ahora),

            // ── Un reloj que se atrasa ───────────────────────────────────────────────────────
            ("una pasada «del futuro» no se cree: toca", EntradaVerificacion {
                ultima_ok_ms: Some(AHORA + 5 * HORA), ultimo_intento_ms: Some(AHORA + 5 * HORA), ..hace(3)
            }, Decision::Ahora),
            ("un fallo «del futuro» no hace esperar", EntradaVerificacion {
                ultimo_intento_ms: Some(AHORA + HORA), fallos: 4, ..hace(20)
            }, Decision::Ahora),
            ("una escritura fechada un minuto por delante cuenta como recién hecha", EntradaVerificacion {
                ultima_escritura_ms: Some(AHORA + MIN), ..hace(20)
            }, esperar(Espera::ActividadReciente)),
            ("una fechada una semana por delante es de un reloj que estuvo adelantado: no hace esperar", EntradaVerificacion {
                ultima_escritura_ms: Some(AHORA + 7 * 24 * HORA), ..hace(20)
            }, Decision::Ahora),
            ("un cierre «del futuro» no es motivo", EntradaVerificacion {
                ultimo_cierre_ms: Some(AHORA + HORA), ..hace(3)
            }, esperar(Espera::SinMotivo)),
        ];

        for (caso, entrada, esperado) in casos {
            assert_eq!(cuando_verificar(&entrada, AHORA), esperado, "{caso}");
        }
    }

    #[test]
    fn la_escalera_de_los_fallos() {
        let minutos: Vec<i64> = (1..=7).map(|f| espera_tras_fallar_ms(f) / MIN).collect();
        assert_eq!(minutos, [30, 60, 120, 240, 360, 360, 360]);
        assert_eq!(espera_tras_fallar_ms(0), ESPERA_FALLO_BASE_MS);
        assert_eq!(espera_tras_fallar_ms(i64::MAX), ESPERA_FALLO_TECHO_MS);
    }

    /// Lo que la regla promete, sobre todas las combinaciones de una rejilla: nunca corre en un
    /// momento que no es tranquilo, y pasado el máximo corre en cuanto lo es.
    #[test]
    fn nunca_en_un_momento_ocupado_y_nunca_sin_correr_si_hay_calma() {
        let horas_sin_verificar = [None, Some(1), Some(19), Some(20), Some(47), Some(48), Some(200)];
        let min_sin_escribir = [None, Some(0), Some(4), Some(5), Some(14), Some(15), Some(600)];
        let min_del_cierre = [None, Some(1), Some(5), Some(90)];
        let min_arrancada = [0, 9, 10, 600];
        let pendientes = [0, 1];
        let si_no = [false, true];

        for ok in horas_sin_verificar {
            for escritura in min_sin_escribir {
                for cierre in min_del_cierre {
                    for arranque in min_arrancada {
                        for outbox in pendientes {
                            for detenida in si_no {
                                for historico in si_no {
                                    for operativa in si_no {
                                        let e = EntradaVerificacion {
                                            ultima_ok_ms: ok.map(|h| AHORA - h * HORA),
                                            ultimo_intento_ms: ok.map(|h| AHORA - h * HORA),
                                            fallos: 0,
                                            ultimo_cierre_ms: cierre.map(|m| AHORA - m * MIN),
                                            main_operativa: operativa,
                                            historico_pendiente: historico,
                                            outbox_pendiente: outbox,
                                            bajada_detenida: detenida,
                                            desde_el_arranque_ms: arranque * MIN,
                                            ultima_escritura_ms: escritura.map(|m| AHORA - m * MIN),
                                            subida_en_curso: false,
                                            subida_por_confirmar_ms: None,
                                        };
                                        let decision = cuando_verificar(&e, AHORA);

                                        // Lo que hace falta siempre para dar el momento por bueno.
                                        let limpio = operativa && !historico && outbox == 0 && !detenida && arranque >= 10;
                                        let calma_de = |min: i64| escritura.is_none_or(|m| m >= min);

                                        if decision == Decision::Ahora {
                                            assert!(limpio, "corre sin estar limpio: {e:?}");
                                            assert!(calma_de(5), "corre con una escritura de hace menos de 5 min: {e:?}");
                                            if ok.is_some_and(|h| h < 48) {
                                                assert!(calma_de(15), "corre sin el cuarto de hora de calma: {e:?}");
                                            }
                                        }
                                        // Pasado el máximo, con todo limpio y 5 min de calma, corre.
                                        if ok.is_none_or(|h| h >= 48) && limpio && calma_de(5) {
                                            assert_eq!(decision, Decision::Ahora, "se queda sin correr: {e:?}");
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
