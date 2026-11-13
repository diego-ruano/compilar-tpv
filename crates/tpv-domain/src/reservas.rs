//! Dominio de **reservas**: normalización de fecha/hora/turno/estado y validación pura.

/// Lo que se dice de un día o una hora que no valen. Los mismos textos en el worker
/// (`reservas.schemas.ts`, `reservasWeb.schemas.ts`) y en el widget (VALID-03).
pub const MSG_DIA: &str = "Formato de día inválido. Esperado YYYY-MM-DD.";
pub const MSG_HORA: &str = "Hora inválida. Esperado HH:MM.";

/// Normaliza un día a `YYYY-MM-DD` (acepta sufijos tras `T`/espacio). Los diez primeros caracteres
/// tienen que ser una fecha real (`fechas::normalizar_dia`): un mes o un día fuera de rango entraba
/// tal cual en la BD y rompía el orden por fecha.
pub fn normalize_dia_ymd(raw: &str) -> Result<String, String> {
    crate::fechas::normalizar_dia(raw).ok_or_else(|| MSG_DIA.to_string())
}

/// Normaliza una hora a `HH:MM` validando rangos.
pub fn normalize_hora_hhmm(raw: &str) -> Result<String, String> {
    let s = raw.trim();
    if let Some(hhmm) = s.get(..5) {
        let b = hhmm.as_bytes();
        if b[2] != b':' {
            return Err(MSG_HORA.into());
        }
        if !b[0].is_ascii_digit()
            || !b[1].is_ascii_digit()
            || !b[3].is_ascii_digit()
            || !b[4].is_ascii_digit()
        {
            return Err(MSG_HORA.into());
        }
        let hh: i64 = hhmm[0..2].parse().unwrap_or(-1);
        let mm: i64 = hhmm[3..5].parse().unwrap_or(-1);
        if !(0..=23).contains(&hh) || !(0..=59).contains(&mm) {
            return Err(MSG_HORA.into());
        }
        return Ok(hhmm.to_string());
    }
    Err(MSG_HORA.into())
}

fn turno_por_hora(hhmm: &str) -> String {
    let parts: Vec<&str> = hhmm.trim().split(':').collect();
    let hh: i64 = parts.first().and_then(|v| v.parse().ok()).unwrap_or(0);
    let mm: i64 = parts.get(1).and_then(|v| v.parse().ok()).unwrap_or(0);
    let mins = hh * 60 + mm;
    if mins < 13 * 60 {
        "DESAYUNO"
    } else if mins < 16 * 60 {
        "COMIDA"
    } else if mins < 19 * 60 {
        "CAFE"
    } else {
        "CENA"
    }
    .to_string()
}

/// Normaliza el turno: usa el valor dado si es válido, si no lo deriva de la hora.
pub fn normalize_turno(raw: Option<String>, hora_hhmm: &str) -> String {
    let maybe = raw.map(|s| s.trim().to_uppercase()).filter(|s| !s.is_empty());
    match maybe.as_deref() {
        Some("DESAYUNO") => "DESAYUNO".to_string(),
        Some("COMIDA") => "COMIDA".to_string(),
        Some("CAFE") => "CAFE".to_string(),
        Some("CENA") => "CENA".to_string(),
        _ => turno_por_hora(hora_hhmm),
    }
}

use crate::texto::limpiar_opcional as limpia;

/// Igual que `limpia` pero **pasando a minúsculas**: el email identifica al cliente y la unicidad
/// es case-insensitive (índice `ux_clientes_email` sobre `lower(Email)`, y el dominio de clientes
/// normaliza igual). Sin esto, reservar con `Juan@Mail.com` no encontraba al cliente guardado como
/// `juan@mail.com` y el alta chocaba contra ese índice.
///
/// Nota: aquí NO se valida el formato del email (a diferencia de `tpv_domain::clientes`). Una
/// reserva se toma a menudo por teléfono y con datos incompletos; rechazarla por un email mal
/// escrito sería peor que aceptarlo.
fn limpia_email(o: Option<String>) -> Option<String> {
    o.map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty())
}

/// El cliente de una reserva (RI-61).
///
/// Una reserva **puede no tener cliente**: no se obliga al negocio a dar de alta a nadie para
/// apuntar una mesa. Y aquí ya no se casa nada por detrás: antes, un teléfono o un email que ya
/// eran de otro cliente le asignaban la reserva sin decir nada (Luis reservaba con el teléfono de
/// Ana y el calendario decía «Ana»). Ahora la pantalla pregunta antes (`buscar_cliente`) y lo que
/// llega aquí es la respuesta: asignarla a ese cliente, crear uno nuevo o dejarla sin cliente.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClienteReserva {
    /// Sin ficha de cliente.
    Ninguno,
    /// Un cliente que ya existe. Lo escrito sólo rellena sus huecos (RES-01): no lo renombra ni
    /// le cambia un dato que ya tenga.
    ///
    /// RI-84: ninguna de las dos variantes lleva notas. La nota de la reserva es de esa noche
    /// («cumpleaños, trae tarta») y antes se copiaba también a la ficha, donde se quedaba para
    /// siempre. Las notas del cliente se escriben sólo desde su ficha.
    Existente {
        id: String,
        telefono: Option<String>,
        email: Option<String>,
    },
    /// Una ficha nueva, aunque haya otra con el mismo teléfono (dos personas pueden compartirlo).
    /// El email sí identifica: si ya es de otro cliente, el repositorio lo rechaza.
    Nuevo {
        nombre: String,
        telefono: Option<String>,
        email: Option<String>,
    },
}

/// Mismo texto en el worker (`reservas.schemas.ts`).
pub const MSG_CLIENTE_SIN_NOMBRE: &str = "Para dar de alta al cliente hace falta su nombre. Si no \
     quieres ficha de cliente, deja vacíos el teléfono y el email.";

impl ClienteReserva {
    /// Decide el cliente a partir de lo que trae la pantalla: un `id_cliente` es asignar uno que ya
    /// existe; un nombre sin id, crear uno; y nada, ninguno. Un teléfono o un email sin nombre no
    /// bastan para dar de alta a nadie, y tirarlos en silencio sería peor que decirlo.
    pub fn desde(
        id_cliente: Option<String>,
        nombre: Option<String>,
        telefono: Option<String>,
        email: Option<String>,
    ) -> Result<Self, String> {
        let telefono = limpia(telefono);
        let email = limpia_email(email);
        if let Some(id) = limpia(id_cliente) {
            return Ok(ClienteReserva::Existente { id, telefono, email });
        }
        if let Some(nombre) = limpia(nombre) {
            return Ok(ClienteReserva::Nuevo { nombre, telefono, email });
        }
        if telefono.is_some() || email.is_some() {
            return Err(MSG_CLIENTE_SIN_NOMBRE.into());
        }
        Ok(ClienteReserva::Ninguno)
    }
}

/// RI-61: lo que dura una reserva que no elige su duración, si el negocio no lo ha cambiado
/// (`Business_Settings.Reserva_Duracion_Min`, el mismo valor por defecto).
pub const DURACION_POR_DEFECTO_MIN: i64 = 120;

/// Lo más que puede durar una reserva: un día entero. Más es una errata (horas por minutos).
pub const DURACION_MAXIMA_MIN: i64 = 24 * 60;

/// La duración propia de una reserva, en minutos: `None` es «la del negocio».
pub fn duracion_valida(minutos: Option<i64>) -> Result<Option<i64>, String> {
    match minutos {
        None => Ok(None),
        Some(m) if (1..=DURACION_MAXIMA_MIN).contains(&m) => Ok(Some(m)),
        Some(_) => Err("La duración de la reserva tiene que estar entre 1 minuto y 24 horas".into()),
    }
}

/// RI-61: qué pasa cuando una reserva se pisa con otra de la misma mesa (o con una comanda abierta
/// en ella). Lo elige cada negocio en Configuración; por defecto, avisar.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModoSolape {
    /// Se avisa, y se guarda si quien reserva lo confirma.
    Avisar,
    /// No se guarda.
    Prohibir,
}

impl ModoSolape {
    /// Lo guardado en `Business_Settings.Reserva_Solape`. Cualquier otra cosa es avisar: es lo que
    /// no le quita nada a nadie.
    pub fn desde(s: &str) -> Self {
        if s.trim().eq_ignore_ascii_case("prohibir") {
            ModoSolape::Prohibir
        } else {
            ModoSolape::Avisar
        }
    }

    pub fn como_texto(self) -> &'static str {
        match self {
            ModoSolape::Avisar => "avisar",
            ModoSolape::Prohibir => "prohibir",
        }
    }
}

/// Reserva ya normalizada y validada, lista para persistir.
/// `id = Some` => upsert por id; `None` => alta nueva, con UUIDv7 generado por la
/// persistencia antes del INSERT. El dominio sólo valida y normaliza el identificador.
///
/// El estado no va aquí: una reserva nueva nace `PROXIMA` y una que se edita conserva el suyo. Lo
/// cambian sólo sus acciones (llegar, irse, cancelar, no vino). Antes el formulario mandaba el que
/// tenía en su caché, y una reserva cancelada o sentada mientras tanto volvía a estar por venir.
#[derive(Debug, Clone)]
pub struct ReservaValidada {
    pub id: Option<String>,
    pub id_mesa: Option<String>,
    pub dia_ymd: String,
    pub hora: String,
    pub turno: String,
    pub comensales: i64,
    /// Minutos que ocupa la mesa; `None` = la duración por defecto del negocio (RI-61).
    pub duracion_min: Option<i64>,
    pub nota: Option<String>,
    pub cliente: ClienteReserva,
}

/// Datos crudos con campos nombrados (RI-48); validar produce el objeto de dominio.
#[derive(Debug, Clone)]
pub struct ReservaEntrada<'a> {
    pub id_reserva: Option<String>,
    pub dia_ymd: &'a str,
    pub hora: &'a str,
    pub turno: Option<String>,
    pub comensales: i64,
    pub duracion_min: Option<i64>,
    pub nota: Option<String>,
    pub id_mesa: Option<String>,
    pub id_cliente: Option<String>,
    pub nombre_cliente: Option<String>,
    pub telefono: Option<String>,
    pub email: Option<String>,
}

impl ReservaValidada {
    pub fn validar(input: ReservaEntrada<'_>) -> Result<Self, String> {
        let ReservaEntrada {
            id_reserva,
            dia_ymd,
            hora,
            turno,
            comensales,
            duracion_min,
            nota,
            id_mesa,
            id_cliente,
            nombre_cliente,
            telefono,
            email,
        } = input;
        let dia = normalize_dia_ymd(dia_ymd)?;
        let hora = normalize_hora_hhmm(hora)?;

        let cliente =
            ClienteReserva::desde(id_cliente, nombre_cliente, telefono, email)?;
        if comensales <= 0 {
            return Err("Comensales inválidos".into());
        }
        let duracion_min = duracion_valida(duracion_min)?;
        // Sin mesa es un estado válido: la reserva existe y ya se le asignará una.
        let id_mesa = limpia(id_mesa);

        let id = id_reserva.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        let turno = normalize_turno(turno, &hora);

        Ok(ReservaValidada {
            id,
            id_mesa,
            dia_ymd: dia,
            hora,
            turno,
            comensales,
            duracion_min,
            nota: limpia(nota),
            cliente,
        })
    }
}

/// Mismo texto en el worker (`mesas.schemas.ts`).
pub const MSG_ESTADO_DESDE_LA_MESA: &str =
    "Desde la mesa sólo se marca que el cliente ha llegado o que se ha ido";
/// Mismo texto en el worker (`reserva_cambiada`, `lib/errorCodes.ts`).
pub const MSG_RESERVA_CAMBIADA: &str = "Esa reserva ha cambiado mientras tanto: se ha cancelado, se ha \
     marcado «No vino» o ya se ha cerrado. Cierra la mesa y vuelve a abrirla.";

/// Lo que se marca desde la mesa: que el cliente ha llegado (`ACTIVA`) o que se ha ido
/// (`FINALIZADA`). Cancelar tiene su acción (`reservas_cancelar`) y «No vino» lo pone el job.
pub fn estado_desde_la_mesa(raw: &str) -> Result<crate::estados::EstadoReserva, String> {
    use crate::estados::EstadoReserva;
    match EstadoReserva::desde_texto(raw).map_err(|_| MSG_ESTADO_DESDE_LA_MESA.to_string())? {
        e @ (EstadoReserva::Activa | EstadoReserva::Finalizada) => Ok(e),
        _ => Err(MSG_ESTADO_DESDE_LA_MESA.into()),
    }
}

/// ¿Se escribe lo que pide la mesa sobre la reserva tal como está ahora (`actual`; `None` si ya no
/// existe)? Llegar, sólo la que aún no ha llegado; irse, sólo la sentada. Pedir el estado que ya
/// tiene no escribe nada (`Ok(false)`). Lo demás es que la reserva ha cambiado con la mesa abierta
/// (la canceló el cliente, pasó a «No vino»): no se pisa, que si no la resucitaría.
pub fn cambio_desde_la_mesa(
    actual: Option<&str>,
    nuevo: crate::estados::EstadoReserva,
) -> Result<bool, String> {
    use crate::estados::EstadoReserva;
    let nuevo_txt = nuevo.como_texto();
    match (actual, nuevo) {
        (Some(a), _) if a == nuevo_txt => Ok(false),
        (Some("PROXIMA"), EstadoReserva::Activa) | (Some("ACTIVA"), EstadoReserva::Finalizada) => Ok(true),
        _ => Err(MSG_RESERVA_CAMBIADA.into()),
    }
}

/// Mismo texto en el worker (`configuracion.schemas.ts`).
pub const MSG_NO_VINO: &str =
    "«No vino» se marca entre 0 (nunca) y 24 horas después de la hora de la reserva";

/// A los cuántos minutos de su hora se marca «No vino» una reserva a la que no ha llegado nadie
/// (`Business_Settings.Reserva_No_Vino_Min`): de 0, que es nunca, a un día.
pub fn no_vino_valido(minutos: i64) -> Result<i64, String> {
    if (0..=24 * 60).contains(&minutos) {
        Ok(minutos)
    } else {
        Err(MSG_NO_VINO.into())
    }
}

/// Cuántos minutos antes de su hora sale una reserva en el plano de Mesas.
pub const PLANO_ANTELACION_MIN: i64 = 60;

/// Si una reserva sale en el plano de Mesas y con qué estado, según los minutos que faltan para su
/// hora (`minutos_para`, negativo si ya ha pasado) y los que dura. Una sentada (`ACTIVA`) sale hasta
/// que se va. Una que aún no ha llegado (`PROXIMA`), desde una hora antes hasta que acaba su hueco, y
/// sigue siendo «por llegar»: con retraso, y con su «Ha llegado ya el cliente». Antes, pasada su hora
/// se pintaba como sentada y se quedaba en la mesa para siempre, aunque nadie hubiera llegado.
pub fn estado_en_el_plano(estado: &str, minutos_para: i64, duracion_min: i64) -> Option<&'static str> {
    let estado = estado.trim();
    if estado.eq_ignore_ascii_case("ACTIVA") {
        return Some("ACTIVA");
    }
    let en_su_hueco = minutos_para <= PLANO_ANTELACION_MIN && minutos_para > -duracion_min;
    (estado.eq_ignore_ascii_case("PROXIMA") && en_su_hueco).then_some("PROXIMA")
}

/// Una reserva viva con mesa, tal como la leen los dos planos: el de la Main (`mesas_meta_all`) y el
/// de la Handy (`mesasMetaAll` en el worker).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReservaDeMesa {
    pub id_mesa: String,
    pub id_reserva: String,
    pub cliente: String,
    pub dia_ymd: String,
    pub hora: String,
    pub estado: String,
    /// La suya o, si no tiene, la del negocio. Sin un valor positivo, la de por defecto.
    pub duracion_min: Option<i64>,
}

/// La reserva que enseña una mesa en el plano, con su estado y los minutos que faltan para su hora.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReservaEnElPlano {
    pub reserva: ReservaDeMesa,
    pub estado: &'static str,
    pub minutos_para: i64,
}

/// `HH:MM` o `HH:MM:SS`, entero.
fn hora_del_dia(hora: &str) -> Option<chrono::NaiveTime> {
    let b = hora.as_bytes();
    let dos = |i: usize| -> Option<u32> {
        (b[i].is_ascii_digit() && b[i + 1].is_ascii_digit())
            .then(|| u32::from(b[i] - b'0') * 10 + u32::from(b[i + 1] - b'0'))
    };
    let (h, m, s) = match b.len() {
        5 if b[2] == b':' => (dos(0)?, dos(3)?, 0),
        8 if b[2] == b':' && b[5] == b':' => (dos(0)?, dos(3)?, dos(6)?),
        _ => return None,
    };
    chrono::NaiveTime::from_hms_opt(h, m, s)
}

/// Los minutos que faltan para la hora de una reserva (negativos si ya ha pasado), truncados hacia
/// cero. `None` si el día o la hora no son válidos, o si esa hora no existe en la zona (la que se
/// salta al adelantar el reloj).
fn minutos_para(
    dia_ymd: &str,
    hora: &str,
    ahora: i64,
    instante: &impl Fn(chrono::NaiveDateTime) -> Option<i64>,
) -> Option<i64> {
    let dia = crate::fechas::fecha_ymd(dia_ymd.trim())?;
    let hora = hora_del_dia(hora.trim())?;
    Some((instante(dia.and_time(hora))? - ahora) / 60)
}

/// MESAS-02: qué reserva enseña cada mesa del plano. Una mesa enseña una: la sentada antes que
/// ninguna y, si no, la más cercana a ahora (la que llega tarde, o la siguiente), de las que salen
/// en el plano (`estado_en_el_plano`). A la misma distancia, la de identificador menor: el orden
/// en que llegan de la base no es el mismo en la Main que en Turso. Espejo de
/// `domains/mesas/reservaEnElPlano.ts` en el worker, con sus casos en `plano_reservas_casos.json`.
///
/// `ahora` es un instante, en segundos desde 1970, e `instante` convierte a uno la hora local de una
/// reserva: con la zona, para que una noche de cambio de hora falte el tiempo de verdad. Si esa hora
/// se repite al retrasar el reloj, la primera; si no existe, `None` y la reserva no sale.
pub fn reserva_de_cada_mesa(
    reservas: Vec<ReservaDeMesa>,
    ahora: i64,
    instante: impl Fn(chrono::NaiveDateTime) -> Option<i64>,
) -> std::collections::HashMap<String, ReservaEnElPlano> {
    let orden = |r: &ReservaEnElPlano| (r.estado != "ACTIVA", r.minutos_para.abs(), r.reserva.id_reserva.clone());
    let mut por_mesa: std::collections::HashMap<String, ReservaEnElPlano> = std::collections::HashMap::new();
    for reserva in reservas {
        if reserva.id_mesa.is_empty() || reserva.id_reserva.is_empty() {
            continue;
        }
        let Some(minutos) = minutos_para(&reserva.dia_ymd, &reserva.hora, ahora, &instante) else {
            continue;
        };
        let duracion = reserva.duracion_min.filter(|m| *m > 0).unwrap_or(DURACION_POR_DEFECTO_MIN);
        let Some(estado) = estado_en_el_plano(&reserva.estado, minutos, duracion) else {
            continue;
        };
        let candidata = ReservaEnElPlano { reserva, estado, minutos_para: minutos };
        let gana = por_mesa
            .get(&candidata.reserva.id_mesa)
            .is_none_or(|actual| orden(&candidata) < orden(actual));
        if gana {
            por_mesa.insert(candidata.reserva.id_mesa.clone(), candidata);
        }
    }
    por_mesa
}

/// MESAS-02 · Cuántos segundos faltan para que el plano cambie solo, con la hora: `None` si nada de
/// lo que hay va a cambiar. Con esto la pantalla relee la meta entonces y no cada minuto (en la
/// Handy, cada relectura es una petición al worker). Espejo de `segundosHastaElProximoCambio` en
/// el worker, con sus casos en `plano_reservas_casos.json`.
///
/// Cambia con la hora una reserva por llegar: la que ya sale en el plano cambia sus minutos (y se va
/// al acabar su hueco), y la que aún no sale aparece cuando le falta una hora. Una sentada no
/// cambia con la hora, y una mesa con una sentada no enseña ninguna otra, así que las por llegar de
/// esa mesa no cuentan. `ahora` e `instante`, como en [`reserva_de_cada_mesa`].
pub fn segundos_hasta_el_proximo_cambio(
    reservas: &[ReservaDeMesa],
    ahora: i64,
    instante: impl Fn(chrono::NaiveDateTime) -> Option<i64>,
) -> Option<i64> {
    let instante_de = |r: &ReservaDeMesa| -> Option<i64> {
        if r.id_mesa.is_empty() || r.id_reserva.is_empty() {
            return None;
        }
        let dia = crate::fechas::fecha_ymd(r.dia_ymd.trim())?;
        instante(dia.and_time(hora_del_dia(r.hora.trim())?))
    };
    let con_sentada: std::collections::HashSet<&str> = reservas
        .iter()
        .filter(|r| r.estado.trim().eq_ignore_ascii_case("ACTIVA") && instante_de(r).is_some())
        .map(|r| r.id_mesa.as_str())
        .collect();
    reservas
        .iter()
        .filter(|r| r.estado.trim().eq_ignore_ascii_case("PROXIMA") && !con_sentada.contains(r.id_mesa.as_str()))
        .filter_map(|r| {
            let d = instante_de(r)? - ahora;
            let minutos = d / 60;
            let duracion = r.duracion_min.filter(|m| *m > 0).unwrap_or(DURACION_POR_DEFECTO_MIN);
            if minutos > PLANO_ANTELACION_MIN {
                // Sale cuando los minutos que faltan, truncados, llegan a la hora de antelación.
                Some(d - ((PLANO_ANTELACION_MIN + 1) * 60 - 1))
            } else if minutos > -duracion {
                // Sale ya: cambia en cuanto cambian sus minutos, hacia cero o lejos de él.
                Some(if d > 0 { d % 60 + 1 } else { 60 - (-d) % 60 })
            } else {
                None
            }
        })
        .min()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desde_la_mesa_se_llega_a_una_por_llegar_y_se_va_de_una_sentada() {
        use crate::estados::EstadoReserva::{Activa, Finalizada};
        assert_eq!(cambio_desde_la_mesa(Some("PROXIMA"), Activa), Ok(true));
        assert_eq!(cambio_desde_la_mesa(Some("ACTIVA"), Finalizada), Ok(true));
        // Lo que ya está así no se vuelve a escribir.
        assert_eq!(cambio_desde_la_mesa(Some("ACTIVA"), Activa), Ok(false));
        assert_eq!(cambio_desde_la_mesa(Some("FINALIZADA"), Finalizada), Ok(false));
        // Cambiada con la mesa abierta: no se pisa.
        for actual in [Some("CANCELADA"), Some("NO_SHOW"), Some("FINALIZADA"), None] {
            assert_eq!(cambio_desde_la_mesa(actual, Activa), Err(MSG_RESERVA_CAMBIADA.into()), "{actual:?}");
        }
        assert_eq!(cambio_desde_la_mesa(Some("PROXIMA"), Finalizada), Err(MSG_RESERVA_CAMBIADA.into()));
        // Sólo llegar o irse.
        assert!(estado_desde_la_mesa(" activa ").is_ok());
        for raw in ["CANCELADA", "NO_SHOW", "PROXIMA", "otro"] {
            assert_eq!(estado_desde_la_mesa(raw), Err(MSG_ESTADO_DESDE_LA_MESA.into()), "{raw}");
        }
    }

    #[test]
    fn en_el_plano_una_sentada_siempre_y_una_por_llegar_en_su_hueco() {
        // Sentada: hasta que se va, sea la hora que sea.
        assert_eq!(estado_en_el_plano("ACTIVA", 300, 120), Some("ACTIVA"));
        assert_eq!(estado_en_el_plano("ACTIVA", -500, 120), Some("ACTIVA"));
        // Por llegar: una hora antes…
        assert_eq!(estado_en_el_plano("PROXIMA", 61, 120), None);
        assert_eq!(estado_en_el_plano("PROXIMA", 60, 120), Some("PROXIMA"));
        // …y pasada su hora sigue por llegar (con retraso), no sentada…
        assert_eq!(estado_en_el_plano("PROXIMA", 0, 120), Some("PROXIMA"));
        assert_eq!(estado_en_el_plano("PROXIMA", -119, 120), Some("PROXIMA"));
        // …hasta que acaba su hueco.
        assert_eq!(estado_en_el_plano("PROXIMA", -120, 120), None);
        assert_eq!(estado_en_el_plano("PROXIMA", -30, 30), None);
        // Las cerradas no salen.
        for estado in ["FINALIZADA", "CANCELADA", "NO_SHOW"] {
            assert_eq!(estado_en_el_plano(estado, 10, 120), None, "{estado}");
        }
    }

    #[test]
    fn la_reserva_de_cada_mesa_cuadra_con_la_tabla_compartida() {
        let tabla: serde_json::Value =
            serde_json::from_str(include_str!("plano_reservas_casos.json")).expect("plano_reservas_casos.json no es JSON");
        for caso in tabla["casos"].as_array().expect("faltan los «casos»") {
            let nombre = caso["nombre"].as_str().unwrap();
            let texto = |r: &serde_json::Value, campo: &str| r[campo].as_str().unwrap().to_string();
            let reservas = caso["reservas"].as_array().unwrap().iter().map(|r| ReservaDeMesa {
                id_mesa: texto(r, "id_mesa"),
                id_reserva: texto(r, "id_reserva"),
                cliente: String::new(),
                dia_ymd: texto(r, "dia_ymd"),
                hora: texto(r, "hora"),
                estado: texto(r, "estado"),
                duracion_min: r["duracion_min"].as_i64(),
            });
            let local = |s: &str| chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S").unwrap();
            // La zona del caso: sin cambio de hora, la hora local es la UTC. Con uno, el desfase es
            // `antes_min` hasta la hora local `local` y `despues_min` desde ahí.
            let cambio = &caso["cambio_de_hora"];
            let instante = |hora: chrono::NaiveDateTime| -> Option<i64> {
                let sin_zona = hora.and_utc().timestamp();
                if cambio.is_null() {
                    return Some(sin_zona);
                }
                let (antes, despues) = (cambio["antes_min"].as_i64().unwrap() * 60, cambio["despues_min"].as_i64().unwrap() * 60);
                let en = local(cambio["local"].as_str().unwrap()).and_utc().timestamp() - antes;
                [(sin_zona - antes, sin_zona - antes < en), (sin_zona - despues, sin_zona - despues >= en)]
                    .into_iter()
                    .filter_map(|(t, vale)| vale.then_some(t))
                    .min()
            };
            let ahora = match caso["ahora_utc"].as_str() {
                Some(utc) => local(utc).and_utc().timestamp(),
                None => instante(local(caso["ahora"].as_str().unwrap())).unwrap(),
            };
            let reservas: Vec<ReservaDeMesa> = reservas.collect();
            assert_eq!(
                segundos_hasta_el_proximo_cambio(&reservas, ahora, instante),
                caso["proximo_cambio_s"].as_i64(),
                "{nombre}: próximo cambio"
            );
            assert!(caso.get("proximo_cambio_s").is_some(), "{nombre}: falta «proximo_cambio_s» (null si nada cambia)");
            let ensena: std::collections::BTreeMap<String, serde_json::Value> = reserva_de_cada_mesa(reservas, ahora, instante)
                .into_iter()
                .map(|(mesa, r)| {
                    (mesa, serde_json::json!({ "id_reserva": r.reserva.id_reserva, "estado": r.estado, "minutos_para": r.minutos_para }))
                })
                .collect();
            let esperado: std::collections::BTreeMap<String, serde_json::Value> =
                serde_json::from_value(caso["ensena"].clone()).unwrap();
            assert_eq!(ensena, esperado, "{nombre}");
        }
    }

    #[test]
    fn texto_unicode_invalido_devuelve_error_sin_panico() {
        for dia in ["2026-01-0é", "2026-01-€T12:00", "🦀🦀🦀"] {
            assert!(normalize_dia_ymd(dia).is_err());
        }
        for hora in ["12:0é", "12:€", "🦀🦀"] {
            assert!(normalize_hora_hhmm(hora).is_err());
        }
    }

    #[test]
    fn dia_acepta_iso_y_timestamp() {
        assert_eq!(normalize_dia_ymd(" 2026-07-22 ").unwrap(), "2026-07-22");
        assert_eq!(normalize_dia_ymd("2026-07-22T18:30:00Z").unwrap(), "2026-07-22");
        assert_eq!(normalize_dia_ymd("2026-07-22 18:30:00").unwrap(), "2026-07-22");
    }

    #[test]
    fn dia_rechaza_formato_y_fechas_calendario_imposibles() {
        for valor in ["", "22/07/2026", "2026-7-2", "2026-13-01", "2026-02-30"] {
            assert!(normalize_dia_ymd(valor).is_err(), "deberia rechazar {valor}");
        }
    }

    #[test]
    fn hora_acepta_limites_y_elimina_segundos() {
        assert_eq!(normalize_hora_hhmm("00:00").unwrap(), "00:00");
        assert_eq!(normalize_hora_hhmm("23:59").unwrap(), "23:59");
        assert_eq!(normalize_hora_hhmm(" 14:35:59 ").unwrap(), "14:35");
    }

    #[test]
    fn hora_rechaza_formato_y_rangos_invalidos() {
        for valor in ["", "9:30", "0930", "24:00", "23:60", "aa:bb", "-1:00"] {
            assert!(normalize_hora_hhmm(valor).is_err(), "deberia rechazar {valor}");
        }
    }

    #[test]
    fn turno_se_deriva_en_todos_los_limites_horarios() {
        for (hora, esperado) in [("00:00", "DESAYUNO"), ("12:59", "DESAYUNO"), ("13:00", "COMIDA"), ("15:59", "COMIDA"), ("16:00", "CAFE"), ("18:59", "CAFE"), ("19:00", "CENA"), ("23:59", "CENA")] {
            assert_eq!(normalize_turno(None, hora), esperado);
        }
    }

    #[test]
    fn turno_explicito_valido_prevalece_y_desconocido_se_deriva() {
        assert_eq!(normalize_turno(Some(" cena ".into()), "09:00"), "CENA");
        assert_eq!(normalize_turno(Some("otro".into()), "14:00"), "COMIDA");
    }

    fn reserva_base(id: Option<String>, comensales: i64, mesa: Option<&str>, nombre: &str) -> Result<ReservaValidada, String> {
        ReservaValidada::validar(crate::reservas::ReservaEntrada {
            id_reserva: id,
            dia_ymd: "2026-07-22",
            hora: "14:30",
            turno: None,
            comensales,
            duracion_min: None,
            nota: Some(" terraza ".into()),
            id_mesa: mesa.map(str::to_string),
            id_cliente: None,
            nombre_cliente: Some(nombre.into()),
            telefono: Some(" 600 ".into()),
            email: Some(" a@b.es ".into()),
        })
    }

    fn email_de(r: &ReservaValidada) -> Option<String> {
        match &r.cliente {
            ClienteReserva::Nuevo { email, .. } | ClienteReserva::Existente { email, .. } => {
                email.clone()
            }
            ClienteReserva::Ninguno => None,
        }
    }

    /// El email del cliente identifica de forma única (índice `ux_clientes_email` sobre
    /// `lower(Email)`), así que tiene que llegar en minúsculas: si no, reservar con `Juan@Mail.com`
    /// no encuentra al cliente guardado como `juan@mail.com` y el alta choca contra el índice.
    #[test]
    fn email_del_cliente_se_normaliza_a_minusculas() {
        let r = ReservaValidada::validar(crate::reservas::ReservaEntrada {
            id_reserva: None,
            dia_ymd: "2026-07-22",
            hora: "14:30",
            turno: None,
            comensales: 2,
            duracion_min: None,
            nota: None,
            id_mesa: Some("m1".into()),
            id_cliente: None,
            nombre_cliente: Some("Ana".into()),
            telefono: None,
            email: Some("  Juan@Mail.COM  ".into()),
        })
        .unwrap();
        assert_eq!(email_de(&r).as_deref(), Some("juan@mail.com"));
    }

    #[test]
    fn email_vacio_o_ausente_queda_en_none() {
        for valor in [None, Some("".to_string()), Some("   ".to_string())] {
            let r = ReservaValidada::validar(crate::reservas::ReservaEntrada {
                id_reserva: None,
                dia_ymd: "2026-07-22",
                hora: "14:30",
                turno: None,
                comensales: 2,
                duracion_min: None,
                nota: None,
                id_mesa: Some("m1".into()),
                id_cliente: None,
                nombre_cliente: Some("Ana".into()),
                telefono: None,
                email: valor,
            })
            .unwrap();
            assert_eq!(email_de(&r), None);
        }
    }

    #[test]
    fn reserva_nueva_se_normaliza() {
        let r = reserva_base(None, 4, Some(" m1 "), " Ana ").unwrap();
        assert!(r.id.is_none());
        assert_eq!(r.id_mesa.as_deref(), Some("m1"));
        assert_eq!(r.turno, "COMIDA");
        assert_eq!(r.nota.as_deref(), Some("terraza"));
        assert_eq!(
            r.cliente,
            ClienteReserva::Nuevo {
                nombre: "Ana".into(),
                telefono: Some("600".into()),
                email: Some("a@b.es".into()),
            }
        );
    }

    #[test]
    fn reserva_editada_conserva_su_id_normalizado() {
        let r = reserva_base(Some(" r1 ".into()), 2, Some("m1"), "Ana").unwrap();
        assert_eq!(r.id.as_deref(), Some("r1"));
    }

    #[test]
    fn reserva_rechaza_comensales_invalidos() {
        assert!(reserva_base(None, 0, Some("m1"), "Ana").is_err());
        assert!(reserva_base(None, -1, Some("m1"), "Ana").is_err());
    }

    /// RI-61: no se obliga a dar de alta a nadie. Sin id, sin nombre, sin teléfono y sin email, la
    /// reserva va sin cliente; con id, se asigna a ese; con nombre, se crea uno nuevo.
    #[test]
    fn el_cliente_de_una_reserva_es_opcional_y_explicito() {
        let s = |v: &str| Some(v.to_string());
        assert_eq!(ClienteReserva::desde(None, None, None, None), Ok(ClienteReserva::Ninguno));
        assert_eq!(
            ClienteReserva::desde(None, s("  "), s(""), s(" ")),
            Ok(ClienteReserva::Ninguno)
        );
        assert_eq!(
            ClienteReserva::desde(s(" c1 "), s("Luis"), s("600"), None),
            Ok(ClienteReserva::Existente {
                id: "c1".into(),
                telefono: s("600"),
                email: None,
            })
        );
        assert!(matches!(
            ClienteReserva::desde(None, s("Luis"), s("600"), None),
            Ok(ClienteReserva::Nuevo { .. })
        ));
    }

    #[test]
    fn un_telefono_o_email_sin_nombre_no_da_de_alta_a_nadie() {
        let s = |v: &str| Some(v.to_string());
        assert!(ClienteReserva::desde(None, None, s("600"), None).is_err());
        assert!(ClienteReserva::desde(None, s(" "), None, s("a@b.es")).is_err());
    }

    /// Apuntar la reserva y decidir la mesa después es un caso normal: una mesa en blanco es lo
    /// mismo que no traerla, y ninguna de las dos cosas es un error.
    #[test]
    fn reserva_sin_mesa_es_valida() {
        assert_eq!(reserva_base(None, 2, None, "Ana").unwrap().id_mesa, None);
        assert_eq!(reserva_base(None, 2, Some("   "), "Ana").unwrap().id_mesa, None);
    }

    /// RI-61: la duración propia de una reserva. Ninguna es «la del negocio»; una absurda (cero,
    /// negativa o más de un día, que suele ser horas escritas como minutos) se rechaza.
    #[test]
    fn la_duracion_de_una_reserva_es_opcional_y_razonable() {
        assert_eq!(duracion_valida(None), Ok(None));
        assert_eq!(duracion_valida(Some(90)), Ok(Some(90)));
        assert_eq!(duracion_valida(Some(DURACION_MAXIMA_MIN)), Ok(Some(DURACION_MAXIMA_MIN)));
        for mala in [0, -30, DURACION_MAXIMA_MIN + 1] {
            assert!(duracion_valida(Some(mala)).is_err(), "{mala} no debería valer");
        }
    }

    #[test]
    fn el_modo_de_solape_por_defecto_es_avisar() {
        assert_eq!(ModoSolape::desde(" Prohibir "), ModoSolape::Prohibir);
        for otro in ["avisar", "", "lo que sea"] {
            assert_eq!(ModoSolape::desde(otro), ModoSolape::Avisar);
        }
        assert_eq!(ModoSolape::desde(ModoSolape::Prohibir.como_texto()), ModoSolape::Prohibir);
    }
}
