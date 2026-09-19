//! Corregir un apunte de caja que pertenece a un cierre ya hecho (CAJA-01).
//!
//! **No se bloquea nada.** Hasta CAJA-01 un cierre bloqueaba su periodo: editar, anular o borrar un
//! apunte de antes del corte se negaba, y para tocarlo había que reabrir el cierre. Se decidió lo
//! contrario: cada uno usa el programa como quiera, y lo que hace el programa es que un cambio sobre
//! el pasado no pase desapercibido. Son tres piezas:
//!
//! 1. **Aviso antes** (`previsualizar`): la pantalla pregunta a qué cierres ya hechos afecta el
//!    cambio y cómo quedarían, y lo enseña antes de confirmar.
//! 2. **Motivo si cambia un descuadre**: es la corrección que explica —o crea— un descuadre de otra
//!    noche, y quien la hace es el único que sabe por qué.
//! 3. **Rectificación después** (`rectificar`): el cierre guarda lo que marca ahora sin tocar la foto
//!    de esa noche, y deja una fila que dice qué se tocó, quién, cuándo y por qué.
//!
//! **Por qué rectificar un cierre no mueve a los siguientes.** Cada cierre arranca con lo que se
//! *dejó* en el cajón, que es dinero contado a mano, no con el esperado del anterior. Corregir un
//! cobro de anteayer cambia lo que anteayer *debería* haber habido, no lo que se contó ni lo que se
//! dejó.
//!
//! **Se rectifica sumando el cambio a lo que el cierre ya dice, no volviendo a sumar el periodo.**
//! Lo que el cierre dice es la foto de esa noche o su última rectificación; a eso se le quita lo que
//! aportaba el apunte y se le pone lo que va a aportar. Volver a sumar el periodo desde la BD parece
//! más exacto y no lo es: tras recuperar un equipo, el histórico baja por partes (SYNC-19, fase 2),
//! y un cierre de hace dos meses sumado a mitad de descarga saldría descuadrado por cobros que todavía
//! no han llegado — y la rectificación grabaría ese descuadre falso para siempre. De paso, la
//! previsualización y la rectificación hacen la misma cuenta: lo que se enseña al confirmar es lo
//! que se guarda.

use tpv_contracts::cierre_caja::{CambioCajaInput, CierreDto, ImpactoCajaDto, ImpactoCierreDto};
use tpv_contracts::cuentas::{
    AnularPagoInput, CreateGastoInput, DeleteGastoInput, UpdateGastoInput, UpdatePagoInput,
};
use tpv_domain::cierre_caja::{
    calcular, centimos_distintos, fecha_de_apunte, momento_de_gasto, TotalesCaja,
};
use tpv_domain::cuentas::normalize_metodo;

use crate::error::{AppError, AppResult};
use crate::ports::cierre_caja::{
    ApunteCaja, ApunteGuardado, CierreCajaRepository, RectificacionNueva,
};
use crate::ports::cuentas::CuentasRepository;
use crate::use_cases::cuentas as cuentas_uc;

const FECHA_DE_COBRO_NO_VALIDA: &str = "La fecha no es válida: escríbela como AAAA-MM-DD HH:MM.";
const FECHA_DE_GASTO_NO_VALIDA: &str = "La fecha no es válida: escríbela como AAAA-MM-DD.";
const FALTA_MOTIVO: &str =
    "Este cambio mueve el descuadre de un cierre de caja ya hecho: escribe el motivo.";

/// Dónde cae un apunte y qué le aporta al cajón, antes o después del cambio.
struct Posicion {
    momento: String,
    aporte: TotalesCaja,
}

/// Un cierre ya hecho al que le toca el cambio: lo que el apunte le quita y lo que le pone.
struct Afectado {
    cierre: CierreDto,
    quita: TotalesCaja,
    pone: TotalesCaja,
}

/// ¿Esta baja es una devolución? (REV-08)
///
/// Ausente es `ERROR`, igual que en `AnularPagoInput`: es lo que hacía este comando antes de
/// FISCAL-01, y es el lado que sí rectifica — equivocarse hacia rectificar deja un aviso de más,
/// no un arqueo mudo.
fn es_devolucion(clase: Option<&str>) -> bool {
    clase.map(str::trim).map(str::to_uppercase).as_deref() == Some("DEVOLUCION")
}

/// Dónde cae un apunte tal como está guardado. `None` si su fecha no se reconoce: entonces tampoco
/// lo cuenta el SQL que suma los periodos, así que no hay cierre al que quitarle nada.
fn posicion_guardada(a: &ApunteGuardado) -> Option<Posicion> {
    match a {
        ApunteGuardado::Cobro {
            fecha_hora,
            importe,
            metodo,
            activo,
            ..
        } => Some(Posicion {
            momento: fecha_de_apunte(fecha_hora)?,
            aporte: TotalesCaja::de_cobro(*activo, metodo, *importe),
        }),
        ApunteGuardado::Gasto {
            fecha,
            importe,
            pagado_con_caja,
            ..
        } => Some(Posicion {
            momento: momento_de_gasto(fecha)?,
            aporte: TotalesCaja::de_gasto(*pagado_con_caja, *importe),
        }),
    }
}

/// Lo que el arqueo de un cierre dice HOY: lo rectificado si lo hay, la foto de esa noche si no.
fn vigente(c: &CierreDto) -> (f64, f64) {
    (
        c.rect_esperado.unwrap_or(c.esperado),
        c.rect_descuadre.unwrap_or(c.descuadre),
    )
}

/// Esperado y descuadre de `c` con estos totales. El fondo y el recuento son los de esa noche.
fn arqueo_con(c: &CierreDto, t: TotalesCaja) -> (f64, f64) {
    let k = calcular(
        c.fondo_inicial,
        t.ventas_efectivo,
        t.gastos_caja,
        c.contado,
        c.dejado,
    );
    (k.esperado, k.descuadre)
}

/// Lo que entró y salió del cajón según el cierre: su última rectificación, o la foto de esa noche.
fn totales_vigentes(c: &CierreDto) -> TotalesCaja {
    TotalesCaja {
        ventas_efectivo: c.rect_ventas_efectivo.unwrap_or(c.ventas_efectivo),
        gastos_caja: c.rect_gastos_caja.unwrap_or(c.gastos_caja),
    }
}

/// Los totales del cierre con el cambio hecho.
fn totales_con_el_cambio(a: &Afectado) -> TotalesCaja {
    totales_vigentes(&a.cierre).menos(a.quita).mas(a.pone)
}

async fn afectados(
    repo: &dyn CierreCajaRepository,
    antes: Option<Posicion>,
    despues: Option<Posicion>,
) -> AppResult<Vec<Afectado>> {
    let mut out: Vec<Afectado> = Vec::new();
    if let Some(p) = antes {
        if let Some(cierre) = repo.cierre_de_momento(&p.momento).await? {
            out.push(Afectado {
                cierre,
                quita: p.aporte,
                pone: TotalesCaja::default(),
            });
        }
    }
    if let Some(p) = despues {
        if let Some(cierre) = repo.cierre_de_momento(&p.momento).await? {
            match out
                .iter_mut()
                .find(|a| a.cierre.id_cierre == cierre.id_cierre)
            {
                Some(a) => a.pone = p.aporte,
                None => out.push(Afectado {
                    cierre,
                    quita: TotalesCaja::default(),
                    pone: p.aporte,
                }),
            }
        }
    }
    Ok(out)
}

/// A qué cierres toca el cambio, sin hacerlo. Devuelve también el apunte tal como está, que es con lo
/// que se escribe la frase de la rectificación.
async fn planificar(
    repo: &dyn CierreCajaRepository,
    cambio: &CambioCajaInput,
) -> AppResult<(Vec<Afectado>, Option<ApunteGuardado>)> {
    match cambio {
        CambioCajaInput::EditarPago {
            id_pago,
            fecha_hora,
            metodo,
        } => {
            let momento = fecha_de_apunte(fecha_hora)
                .ok_or_else(|| AppError::validation(FECHA_DE_COBRO_NO_VALIDA))?;
            let guardado = repo.apunte(ApunteCaja::Pago, id_pago.trim()).await?;
            let datos = match guardado.as_ref() {
                Some(ApunteGuardado::Cobro {
                    importe, activo, ..
                }) => Some((*importe, *activo)),
                _ => None,
            };
            let Some((importe, activo)) = datos else {
                return Ok((Vec::new(), guardado));
            };
            let antes = guardado.as_ref().and_then(posicion_guardada);
            let despues = Posicion {
                momento,
                aporte: TotalesCaja::de_cobro(activo, &normalize_metodo(metodo), importe),
            };
            Ok((afectados(repo, antes, Some(despues)).await?, guardado))
        }
        CambioCajaInput::AnularPago { id_pago, clase } => {
            let guardado = repo.apunte(ApunteCaja::Pago, id_pago.trim()).await?;
            if !matches!(guardado, Some(ApunteGuardado::Cobro { .. })) {
                return Ok((Vec::new(), guardado));
            }

            // REV-08: una DEVOLUCIÓN no toca el cierre de la venta, y es la diferencia entera.
            //
            // Anular por ERROR dice que aquel cobro no debió existir: la noche que se cerró, el
            // esperado contaba un dinero que no estaba, o sea que aquel arqueo estaba mal y hay que
            // rectificarlo. Devolver dice lo contrario: la venta fue real y el dinero SÍ estaba en
            // el cajón esa noche. Lo que pasa es que hoy sale. Rectificar entonces el cierre de
            // aquel día le inventa un sobrante que nunca hubo —y, con la salida de hoy sin contar,
            // el de hoy salía además con una falta—: dos arqueos descuadrados por una operación
            // normal. La salida de hoy la recoge `totales_desde`, en el periodo abierto, que es
            // donde el dinero se ha ido de verdad.
            if es_devolucion(clase.as_deref()) {
                return Ok((Vec::new(), guardado));
            }

            let antes = guardado.as_ref().and_then(posicion_guardada);
            // Anular deja el cobro donde estaba, pero ya sin aportar nada al cajón.
            let despues = antes.as_ref().map(|p| Posicion {
                momento: p.momento.clone(),
                aporte: TotalesCaja::default(),
            });
            Ok((afectados(repo, antes, despues).await?, guardado))
        }
        CambioCajaInput::CrearGasto {
            fecha,
            importe,
            pagado_con_caja,
        } => {
            let momento = momento_de_gasto(fecha)
                .ok_or_else(|| AppError::validation(FECHA_DE_GASTO_NO_VALIDA))?;
            let despues = Posicion {
                momento,
                aporte: TotalesCaja::de_gasto(*pagado_con_caja, *importe),
            };
            Ok((afectados(repo, None, Some(despues)).await?, None))
        }
        CambioCajaInput::EditarGasto {
            id_gasto,
            fecha,
            importe,
            pagado_con_caja,
        } => {
            let momento = momento_de_gasto(fecha)
                .ok_or_else(|| AppError::validation(FECHA_DE_GASTO_NO_VALIDA))?;
            let guardado = repo.apunte(ApunteCaja::Gasto, id_gasto.trim()).await?;
            if !matches!(guardado, Some(ApunteGuardado::Gasto { .. })) {
                return Ok((Vec::new(), guardado));
            }
            let antes = guardado.as_ref().and_then(posicion_guardada);
            let despues = Posicion {
                momento,
                aporte: TotalesCaja::de_gasto(*pagado_con_caja, *importe),
            };
            Ok((afectados(repo, antes, Some(despues)).await?, guardado))
        }
        CambioCajaInput::BorrarGasto { id_gasto } => {
            let guardado = repo.apunte(ApunteCaja::Gasto, id_gasto.trim()).await?;
            if !matches!(guardado, Some(ApunteGuardado::Gasto { .. })) {
                return Ok((Vec::new(), guardado));
            }
            let antes = guardado.as_ref().and_then(posicion_guardada);
            Ok((afectados(repo, antes, None).await?, guardado))
        }
    }
}

fn impacto(afectados: &[Afectado]) -> ImpactoCajaDto {
    let mut cierres = Vec::with_capacity(afectados.len());
    for a in afectados {
        let (esperado_despues, descuadre_despues) = arqueo_con(&a.cierre, totales_con_el_cambio(a));
        let (esperado_antes, descuadre_antes) = vigente(&a.cierre);
        cierres.push(ImpactoCierreDto {
            id_cierre: a.cierre.id_cierre.clone(),
            fecha_hora: a.cierre.fecha_hora.clone(),
            esperado_antes,
            esperado_despues,
            descuadre_antes,
            descuadre_despues,
        });
    }
    let requiere_motivo = cierres
        .iter()
        .any(|c| centimos_distintos(c.descuadre_antes, c.descuadre_despues));
    ImpactoCajaDto {
        cierres,
        requiere_motivo,
    }
}

fn limpio(motivo: Option<String>) -> Option<String> {
    motivo
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty())
}

fn exigir_motivo(afectados: &[Afectado], motivo: &Option<String>) -> AppResult<()> {
    if afectados.is_empty() || motivo.is_some() {
        return Ok(());
    }
    if impacto(afectados).requiere_motivo {
        return Err(AppError::validation(FALTA_MOTIVO));
    }
    Ok(())
}

/// Tras hacer el cambio: cada cierre afectado guarda lo que marca ahora, si ha cambiado.
///
/// No se anota lo que no cambia. Un gasto pagado por banco que se mueve dentro de un cierre ya hecho
/// no toca su arqueo, y una fila que diga «rectificado: igual que antes» sólo enseñaría a no mirar la
/// lista de rectificaciones.
async fn rectificar(
    repo: &dyn CierreCajaRepository,
    afectados: Vec<Afectado>,
    id_usuario: &str,
    descripcion: &str,
    motivo: Option<String>,
) -> AppResult<()> {
    for a in afectados {
        let totales = totales_con_el_cambio(&a);
        let (esperado, descuadre) = arqueo_con(&a.cierre, totales);
        let (esperado_antes, descuadre_antes) = vigente(&a.cierre);
        if !centimos_distintos(esperado_antes, esperado) {
            continue;
        }
        let cuando = a.cierre.fecha_hora.clone();
        repo.guardar_rectificacion(RectificacionNueva {
            id_cierre: a.cierre.id_cierre,
            id_usuario: Some(id_usuario.to_string()),
            descripcion: descripcion.to_string(),
            motivo: motivo.clone(),
            totales,
            esperado_antes,
            esperado,
            descuadre_antes,
            descuadre,
        })
        .await
        // El cambio ya está hecho. Decirlo así evita que alguien lo repita creyendo que no se guardó.
        .map_err(|e| {
            AppError::repository(format!(
                "El cambio se ha guardado, pero no se pudo rectificar el cierre del {cuando}: {e}"
            ))
        })?;
    }
    Ok(())
}

fn euros(v: f64) -> String {
    format!("{v:.2} €").replace('.', ",")
}

fn nombre_de_cobro(numero: Option<&str>) -> String {
    match numero.map(str::trim).filter(|n| !n.is_empty()) {
        Some(n) => format!("Cobro {n}"),
        None => "Cobro sin número".to_string(),
    }
}

fn describir_edicion_de_cobro(guardado: Option<&ApunteGuardado>, input: &UpdatePagoInput) -> String {
    let Some(ApunteGuardado::Cobro {
        fecha_hora,
        importe,
        metodo,
        numero_ticket,
        ..
    }) = guardado
    else {
        return "Cobro editado".to_string();
    };
    let metodo_nuevo = normalize_metodo(&input.metodo);
    let mut cambios = Vec::new();
    if metodo_nuevo != *metodo {
        cambios.push(format!("{metodo} → {metodo_nuevo}"));
    }
    if fecha_de_apunte(fecha_hora) != fecha_de_apunte(&input.fecha_hora) {
        cambios.push(format!(
            "fecha {} → {}",
            fecha_hora.trim(),
            input.fecha_hora.trim()
        ));
    }
    let que = if cambios.is_empty() {
        "editado".to_string()
    } else {
        cambios.join(", ")
    };
    format!(
        "{} de {}: {que}",
        nombre_de_cobro(numero_ticket.as_deref()),
        euros(*importe)
    )
}

fn describir_edicion_de_gasto(guardado: Option<&ApunteGuardado>, input: &UpdateGastoInput) -> String {
    let concepto = input.concepto.trim();
    let Some(ApunteGuardado::Gasto {
        fecha,
        importe,
        pagado_con_caja,
        ..
    }) = guardado
    else {
        return format!("Gasto «{concepto}» editado");
    };
    let mut cambios = Vec::new();
    if centimos_distintos(*importe, input.importe) {
        cambios.push(format!("{} → {}", euros(*importe), euros(input.importe)));
    }
    if momento_de_gasto(fecha) != momento_de_gasto(&input.fecha) {
        cambios.push(format!("fecha {} → {}", fecha.trim(), input.fecha.trim()));
    }
    let pagado_nuevo = input.pagado_con_caja.unwrap_or(false);
    if *pagado_con_caja != pagado_nuevo {
        cambios.push(
            if pagado_nuevo {
                "ahora pagado con dinero del cajón"
            } else {
                "ya no pagado con dinero del cajón"
            }
            .to_string(),
        );
    }
    let que = if cambios.is_empty() {
        "editado".to_string()
    } else {
        cambios.join(", ")
    };
    format!("Gasto «{concepto}»: {que}")
}

/// Lo que va a pasar si se hace este cambio, sin hacerlo.
pub async fn previsualizar(
    cierres: &dyn CierreCajaRepository,
    cambio: &CambioCajaInput,
) -> AppResult<ImpactoCajaDto> {
    let (afectados, _) = planificar(cierres, cambio).await?;
    Ok(impacto(&afectados))
}

pub async fn editar_pago(
    cuentas: &dyn CuentasRepository,
    cierres: &dyn CierreCajaRepository,
    id_usuario: &str,
    input: UpdatePagoInput,
    motivo: Option<String>,
) -> AppResult<bool> {
    let cambio = CambioCajaInput::EditarPago {
        id_pago: input.id_pago.clone(),
        fecha_hora: input.fecha_hora.clone(),
        metodo: input.metodo.clone(),
    };
    let (afectados, guardado) = planificar(cierres, &cambio).await?;
    let motivo = limpio(motivo);
    exigir_motivo(&afectados, &motivo)?;
    let descripcion = describir_edicion_de_cobro(guardado.as_ref(), &input);

    let ok = cuentas_uc::update_pago(cuentas, input).await?;
    if ok {
        rectificar(cierres, afectados, id_usuario, &descripcion, motivo).await?;
    }
    Ok(ok)
}

/// Anular (o devolver) un cobro de un cierre ya hecho baja lo que ese cierre debería haber tenido.
///
/// El motivo de la anulación es obligatorio siempre (CUENTA-07) y lo valida `cuentas::anular_pago`,
/// así que es también el de la rectificación: no se pide dos veces.
pub async fn anular_pago(
    cuentas: &dyn CuentasRepository,
    cierres: &dyn CierreCajaRepository,
    id_usuario: &str,
    input: AnularPagoInput,
) -> AppResult<bool> {
    let cambio = CambioCajaInput::AnularPago {
        id_pago: input.id_pago.clone(),
        // REV-08: la clase decide a qué cierre le toca el cambio. Una devolución no toca el de la
        // venta —el dinero sí estuvo en el cajón esa noche—, sale del periodo abierto.
        clase: input.clase.clone(),
    };
    let (afectados, guardado) = planificar(cierres, &cambio).await?;
    let motivo = limpio(input.motivo.clone());
    let devolucion = es_devolucion(input.clase.as_deref());
    let descripcion = match guardado.as_ref() {
        Some(ApunteGuardado::Cobro {
            importe,
            numero_ticket,
            ..
        }) => format!(
            "{} de {} {}",
            nombre_de_cobro(numero_ticket.as_deref()),
            euros(*importe),
            if devolucion { "devuelto" } else { "anulado" }
        ),
        _ => "Cobro anulado".to_string(),
    };

    let ok = cuentas_uc::anular_pago(cuentas, id_usuario, input).await?;
    if ok {
        rectificar(cierres, afectados, id_usuario, &descripcion, motivo).await?;
    }
    Ok(ok)
}

pub async fn crear_gasto(
    cuentas: &dyn CuentasRepository,
    cierres: &dyn CierreCajaRepository,
    id_usuario: &str,
    input: CreateGastoInput,
    motivo: Option<String>,
) -> AppResult<bool> {
    let cambio = CambioCajaInput::CrearGasto {
        fecha: input.fecha.clone(),
        importe: input.importe,
        pagado_con_caja: input.pagado_con_caja.unwrap_or(false),
    };
    let (afectados, _) = planificar(cierres, &cambio).await?;
    let motivo = limpio(motivo);
    exigir_motivo(&afectados, &motivo)?;
    let descripcion = format!(
        "Gasto «{}» de {} añadido",
        input.concepto.trim(),
        euros(input.importe)
    );

    let ok = cuentas_uc::create_gasto(cuentas, Some(id_usuario), input).await?;
    if ok {
        rectificar(cierres, afectados, id_usuario, &descripcion, motivo).await?;
    }
    Ok(ok)
}

pub async fn editar_gasto(
    cuentas: &dyn CuentasRepository,
    cierres: &dyn CierreCajaRepository,
    id_usuario: &str,
    input: UpdateGastoInput,
    motivo: Option<String>,
) -> AppResult<bool> {
    let cambio = CambioCajaInput::EditarGasto {
        id_gasto: input.id_gasto.clone(),
        fecha: input.fecha.clone(),
        importe: input.importe,
        pagado_con_caja: input.pagado_con_caja.unwrap_or(false),
    };
    let (afectados, guardado) = planificar(cierres, &cambio).await?;
    let motivo = limpio(motivo);
    exigir_motivo(&afectados, &motivo)?;
    let descripcion = describir_edicion_de_gasto(guardado.as_ref(), &input);

    let ok = cuentas_uc::update_gasto(cuentas, input).await?;
    if ok {
        rectificar(cierres, afectados, id_usuario, &descripcion, motivo).await?;
    }
    Ok(ok)
}

pub async fn borrar_gasto(
    cuentas: &dyn CuentasRepository,
    cierres: &dyn CierreCajaRepository,
    id_usuario: &str,
    input: DeleteGastoInput,
    motivo: Option<String>,
) -> AppResult<bool> {
    let cambio = CambioCajaInput::BorrarGasto {
        id_gasto: input.id_gasto.clone(),
    };
    let (afectados, guardado) = planificar(cierres, &cambio).await?;
    let motivo = limpio(motivo);
    exigir_motivo(&afectados, &motivo)?;
    let descripcion = match guardado.as_ref() {
        Some(ApunteGuardado::Gasto {
            importe, concepto, ..
        }) => format!("Gasto «{}» de {} borrado", concepto.trim(), euros(*importe)),
        _ => "Gasto borrado".to_string(),
    };

    let ok = cuentas_uc::delete_gasto(cuentas, Some(id_usuario), input).await?;
    if ok {
        rectificar(cierres, afectados, id_usuario, &descripcion, motivo).await?;
    }
    Ok(ok)
}
