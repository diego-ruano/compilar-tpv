//! AUD-27: lo que identifica a una persona, y cualquier texto que escriba alguien, no viaja en la
//! URL de una petición al worker.
//!
//! Cloudflare guarda el método y la URL de cada petición (Workers Logs), y Logpush puede
//! exportarlos, sin pasar por el filtro de datos personales. El cuerpo no se registra. Por eso el
//! teléfono y el correo de un cliente, o lo que se escribe en un buscador, van en el cuerpo de un
//! `post_lectura`, y en la query sólo queda lo de la lista de abajo.
//!
//! Se lee el fuente de los repositorios porque sus llamadas no se pueden ejecutar aquí: firmarían
//! con la identidad del equipo. El fuente se parte en piezas (nombres, textos y signos), sin
//! comentarios ni espacios, así que una llamada partida en varias líneas se lee igual que en una.
//!
//! **Falla cerrado.** Sólo da por buena una query que sabe leer entera:
//!
//! - la ruta de cada llamada al transporte es un literal `"/v1/…"`, suelto o en un `format!`;
//! - los pares de `get_query` son una lista escrita ahí mismo, o un `Vec` de la misma función
//!   hecho con `vec![…]` o `Vec::new()` y al que sólo se le hacen `push` de pares, siempre con el
//!   nombre entre comillas.
//!
//! Lo demás —un nombre que no es un literal, una query que monta otra función, cualquier otro uso
//! del `Vec` (`q[0] = …`, `extend`, `&mut q`), una ruta que llega en una variable— sale en
//! `ilegibles` y el test falla. Los pares que no llegan a la URL (los de un cuerpo) no cuentan. Los
//! últimos tests se lo comprueban al propio barrido.
//!
//! Lo que no es, y por eso no es la protección de fondo: un analizador de Rust. No sigue tipos ni
//! macros, y un `Vec` se reconoce por su nombre dentro de su función. La de fondo son los tests de
//! cada llamada (`cuentas::tests`, `reservas::tests`, `client::tests_lectura_por_post`), que miran lo
//! que sale de verdad.

use std::collections::BTreeSet;

/// Cada módulo de la crate que habla con el worker.
const REPOSITORIOS: &[(&str, &str)] = &[
    ("cierre_caja", include_str!("cierre_caja.rs")),
    ("clientes", include_str!("clientes.rs")),
    ("configuracion", include_str!("configuracion.rs")),
    ("cuentas", include_str!("cuentas.rs")),
    ("inventario", include_str!("inventario.rs")),
    ("login", include_str!("login.rs")),
    ("mesas", include_str!("mesas.rs")),
    ("notificaciones", include_str!("notificaciones.rs")),
    ("permisos", include_str!("permisos.rs")),
    ("proveedores", include_str!("proveedores.rs")),
    ("reservas", include_str!("reservas.rs")),
    ("stats", include_str!("stats.rs")),
    ("tareas", include_str!("tareas.rs")),
    ("trabajadores", include_str!("trabajadores.rs")),
    ("venta_rapida", include_str!("venta_rapida.rs")),
];

/// Los módulos que no son repositorios: el transporte y el WebSocket (su ticket de un solo uso).
const NO_SON_REPOSITORIOS: &[&str] = &["client", "websocket"];

/// Lo único que puede ir en la query: identificadores, fechas, filtros cerrados y paginación.
///
/// **Antes de añadir un nombre aquí**: ¿puede llevar el nombre, el teléfono, el correo o el
/// documento de alguien, una nota, o lo que se escribe en un buscador? Entonces no va en la query:
/// va en el cuerpo, con `CloudClient::post_lectura`.
const EN_LA_QUERY: &[&str] = &[
    // identificadores
    "categoria",
    "categoria_top_id",
    "categoria_worst_id",
    "trabajador",
    "usuario",
    // fechas
    "desde",
    "fecha_lunes",
    "hasta",
    // filtros cerrados
    "include_pagadas",
    "range",
    "ranking",
    "solo_no_leidas",
    "turno",
    // paginación
    "limit",
    "limite",
];

/// Los `{}` sin nombre del camino de una ruta, por módulo. No dicen qué llevan, así que se
/// cuentan: hoy son tres identificadores que salen de un campo (`cliente.id`, `ajuste.id_lote`,
/// `ajuste.id_producto`). Uno nuevo se escribe con su nombre (`{id_cosa}`) o, si de verdad es un
/// identificador, se apunta aquí.
const SIN_NOMBRE_EN_LA_RUTA: &[(&str, usize)] = &[("clientes", 1), ("inventario", 2)];

/// Las llamadas al transporte. Todas llevan la ruta como primer argumento.
const LLAMADAS: &[&str] = &[
    "get_json",
    "get_query",
    "post_lectura",
    "post_json",
    "post_json_creando",
    "put_json",
    "patch_json",
    "delete_json",
];

/// Una pieza del fuente.
#[derive(Debug, Clone, PartialEq)]
enum Pieza {
    /// Un nombre, una palabra clave o un número.
    Nombre(String),
    /// Lo de dentro de un texto entre comillas.
    Texto(String),
    /// Cualquier otro signo, de uno en uno.
    Signo(char),
}

use Pieza::{Nombre, Signo, Texto};

/// Lo que un fuente pone en la URL de sus peticiones.
#[derive(Debug, Default)]
struct Analisis {
    /// Los nombres de los parámetros de query.
    parametros: BTreeSet<String>,
    /// Lo que se interpola en el camino de cada ruta (vacío si es un `{}` sin nombre).
    interpolado: Vec<String>,
    /// Cada llamada al transporte, con su ruta.
    llamadas: Vec<(String, String)>,
    /// Lo que el barrido no ha sabido leer: con algo aquí, no se da nada por bueno.
    ilegibles: Vec<String>,
}

fn es_de_nombre(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Lo de dentro de un texto que empieza en `c[i]` (la comilla), y dónde acaba.
fn texto(c: &[char], i: usize) -> (String, usize) {
    let mut j = i + 1;
    let mut s = String::new();
    while j < c.len() && c[j] != '"' {
        if c[j] == '\\' {
            s.extend(c.get(j..j + 2).unwrap_or_default());
            j += 2;
        } else {
            s.push(c[j]);
            j += 1;
        }
    }
    (s, (j + 1).min(c.len()))
}

/// Lo de dentro de un texto crudo (`r"…"`, `r#"…"#`) que empieza en `c[i]`, y dónde acaba.
fn crudo(c: &[char], i: usize) -> (String, usize) {
    let mut j = i;
    let mut almohadillas = 0;
    while c.get(j) == Some(&'#') {
        almohadillas += 1;
        j += 1;
    }
    let ini = j + 1;
    let mut k = ini;
    while k < c.len() {
        if c[k] == '"' && (1..=almohadillas).all(|n| c.get(k + n) == Some(&'#')) {
            return (c[ini..k].iter().collect(), k + 1 + almohadillas);
        }
        k += 1;
    }
    (c[ini.min(c.len())..].iter().collect(), c.len())
}

/// El fuente en piezas, sin comentarios ni espacios.
fn piezas(fuente: &str) -> Vec<Pieza> {
    let c: Vec<char> = fuente.chars().collect();
    let mut p = Vec::new();
    let mut i = 0;
    while i < c.len() {
        let x = c[i];
        let sig = c.get(i + 1).copied();
        if x.is_whitespace() {
            i += 1;
        } else if x == '/' && sig == Some('/') {
            while i < c.len() && c[i] != '\n' {
                i += 1;
            }
        } else if x == '/' && sig == Some('*') {
            let mut hondo = 0;
            while i < c.len() {
                if c[i] == '/' && c.get(i + 1) == Some(&'*') {
                    hondo += 1;
                    i += 2;
                } else if c[i] == '*' && c.get(i + 1) == Some(&'/') {
                    hondo -= 1;
                    i += 2;
                    if hondo == 0 {
                        break;
                    }
                } else {
                    i += 1;
                }
            }
        } else if x == '"' {
            let (s, fin) = texto(&c, i);
            p.push(Texto(s));
            i = fin;
        } else if x == '\'' {
            // Un carácter (`'a'`, `'\n'`) o el nombre de una vida (`'static`).
            if sig == Some('\\') {
                i += 3;
                while i < c.len() && c[i] != '\'' {
                    i += 1;
                }
                i += 1;
            } else if c.get(i + 2) == Some(&'\'') {
                i += 3;
            } else {
                p.push(Signo('\''));
                i += 1;
            }
        } else if es_de_nombre(x) {
            let ini = i;
            while i < c.len() && es_de_nombre(c[i]) {
                i += 1;
            }
            let nombre: String = c[ini..i].iter().collect();
            match (nombre.as_str(), c.get(i)) {
                ("b", Some('"')) => {
                    let (s, fin) = texto(&c, i);
                    p.push(Texto(s));
                    i = fin;
                }
                ("r" | "br", Some('"' | '#')) => {
                    let (s, fin) = crudo(&c, i);
                    p.push(Texto(s));
                    i = fin;
                }
                _ => p.push(Nombre(nombre)),
            }
        } else {
            p.push(Signo(x));
            i += 1;
        }
    }
    p
}

fn nombre(s: &str) -> Pieza {
    Nombre(s.to_string())
}

/// Dónde se cierra lo que se abre en `p[i]` (`(`, `[` o `{`).
fn cierre(p: &[Pieza], i: usize) -> Option<usize> {
    let mut hondo = 0usize;
    for (j, x) in p.iter().enumerate().skip(i) {
        match x {
            Signo('(' | '[' | '{') => hondo += 1,
            Signo(')' | ']' | '}') => {
                hondo = hondo.checked_sub(1)?;
                if hondo == 0 {
                    return Some(j);
                }
            }
            _ => {}
        }
    }
    None
}

/// El cuerpo de cada función: de su `{` a su `}`.
fn cuerpos(p: &[Pieza]) -> Vec<(usize, usize)> {
    let mut v = Vec::new();
    for i in p.iter().enumerate().filter(|(_, x)| **x == nombre("fn")).map(|(i, _)| i) {
        let mut hondo = 0i32;
        for (j, x) in p.iter().enumerate().skip(i + 1) {
            match x {
                Signo('(' | '[') => hondo += 1,
                Signo(')' | ']') => hondo -= 1,
                Signo(';') if hondo == 0 => break,
                Signo('{') if hondo == 0 => {
                    if let Some(fin) = cierre(p, j) {
                        v.push((j, fin));
                    }
                    break;
                }
                _ => {}
            }
        }
    }
    v
}

/// Donde vive la pieza `i`: el cuerpo de la función más interna que la contiene, o todo el fuente.
fn ambito(cuerpos: &[(usize, usize)], i: usize, total: usize) -> (usize, usize) {
    cuerpos
        .iter()
        .copied()
        .filter(|&(a, b)| a < i && i < b)
        .min_by_key(|&(a, b)| b - a)
        .unwrap_or((0, total))
}

/// Un par `("nombre", valor)` que empieza en `p[i]`: su nombre y dónde sigue.
fn par(p: &[Pieza], i: usize) -> Option<(String, usize)> {
    if p.get(i)? != &Signo('(') {
        return None;
    }
    let Texto(nombre) = p.get(i + 1)? else {
        return None;
    };
    if nombre.is_empty() || !nombre.chars().all(es_de_nombre) || p.get(i + 2)? != &Signo(',') {
        return None;
    }
    Some((nombre.clone(), cierre(p, i)? + 1))
}

/// Los nombres de una lista de pares que empieza en `p[i]` (el `[`), y dónde sigue tras el `]`.
fn lista(p: &[Pieza], i: usize) -> Option<(Vec<String>, usize)> {
    if p.get(i)? != &Signo('[') {
        return None;
    }
    let fin = cierre(p, i)?;
    let mut nombres = Vec::new();
    let mut j = i + 1;
    while j < fin {
        let (nombre, tras) = par(p, j)?;
        nombres.push(nombre);
        j = tras + usize::from(p.get(tras) == Some(&Signo(',')));
    }
    (j == fin).then_some((nombres, fin + 1))
}

/// La ruta del primer argumento de una llamada que empieza en `p[i]`, si es un literal `"/v1/…"`
/// (suelto o en un `format!`), y dónde acaba ese argumento.
fn ruta(p: &[Pieza], i: usize) -> Option<(String, usize)> {
    let es_ruta = |x: Option<&Pieza>| match x {
        Some(Texto(s)) if s.starts_with("/v1/") => Some(s.clone()),
        _ => None,
    };
    if let Some(s) = es_ruta(p.get(i)) {
        return Some((s, i + 1));
    }
    let formato = [Signo('&'), nombre("format"), Signo('!'), Signo('(')];
    if p.get(i..i + 4)? == formato {
        return Some((es_ruta(p.get(i + 4))?, cierre(p, i + 3)? + 1));
    }
    None
}

/// Los pares de un `Vec` que se le pasa a `get_query` desde la pieza `uso`: los de su `vec![…]` y
/// los de cada `push`, dentro de su función. Cualquier otro uso no se entiende.
fn pares_del_vec(p: &[Pieza], (ini, fin): (usize, usize), var: &str, uso: usize, a: &mut Analisis) {
    let mut definiciones = 0;
    let raro = |a: &mut Analisis, que: &str, j: usize| {
        let resto: Vec<String> = p[j..(j + 6).min(p.len())].iter().map(|x| format!("{x:?}")).collect();
        a.ilegibles.push(format!("`{var}`: {que} ({})", resto.join(" ")));
    };
    for (j, x) in p.iter().enumerate().take(fin).skip(ini) {
        // Un campo que se llama igual (`filtro.q`) es otra cosa.
        if *x != Nombre(var.to_string()) || j == uso || p.get(j.wrapping_sub(1)) == Some(&Signo('.')) {
            continue;
        }
        let tras_let = p.get(j.wrapping_sub(1)) == Some(&nombre("let"))
            || (p.get(j.wrapping_sub(1)) == Some(&nombre("mut")) && p.get(j.wrapping_sub(2)) == Some(&nombre("let")));
        if tras_let {
            definiciones += 1;
            let es_vec = p.get(j + 1..j + 5) == Some(&[Signo('='), nombre("vec"), Signo('!'), Signo('[')][..]);
            let vacio = [Signo('='), nombre("Vec"), Signo(':'), Signo(':'), nombre("new"), Signo('('), Signo(')'), Signo(';')];
            if es_vec {
                match lista(p, j + 4) {
                    Some((nombres, tras)) if p.get(tras) == Some(&Signo(';')) => a.parametros.extend(nombres),
                    _ => raro(a, "su `vec![…]` lleva algo que no es un par con nombre", j),
                }
            } else if p.get(j + 1..j + 9) != Some(&vacio[..]) {
                raro(a, "no se construye con `vec![…]` ni con `Vec::new()`", j);
            }
            continue;
        }
        if p.get(j + 1..j + 4) == Some(&[Signo('.'), nombre("push"), Signo('(')][..]) {
            match par(p, j + 4) {
                Some((nombre, tras)) if p.get(tras) == Some(&Signo(')')) => {
                    a.parametros.insert(nombre);
                }
                _ => raro(a, "un `push` de algo que no es un par con nombre", j),
            }
            continue;
        }
        raro(a, "se usa de una forma que no es un `push` de un par", j);
    }
    if definiciones != 1 {
        raro(a, "no se ve una y sólo una definición suya en la función", uso);
    }
}

/// Lo que una ruta lleva escrito: lo interpolado en su camino y, si trae query, sus nombres.
fn analizar_ruta(ruta: &str, a: &mut Analisis) {
    let (camino, query) = match ruta.split_once('?') {
        Some((camino, query)) => (camino, Some(query)),
        None => (ruta, None),
    };
    for (i, _) in camino.match_indices('{') {
        let dentro = &camino[i + 1..];
        if let Some(fin) = dentro.find('}') {
            a.interpolado.push(dentro[..fin].to_string());
        }
    }
    for pieza in query.into_iter().flat_map(|q| q.split('&')) {
        match pieza.split_once('=') {
            Some((nombre, _)) if !nombre.is_empty() && nombre.chars().all(es_de_nombre) => {
                a.parametros.insert(nombre.to_string());
            }
            _ => a.ilegibles.push(format!("la query escrita en `{ruta}` no es `nombre=valor`")),
        }
    }
}

/// Lo que un fuente pone en la URL de sus peticiones.
fn analizar(fuente: &str) -> Analisis {
    let p = piezas(fuente);
    let cuerpos = cuerpos(&p);
    let mut a = Analisis::default();

    // Cada llamada al transporte: su ruta es un literal y, en `get_query`, sus pares se leen.
    for i in 1..p.len() {
        let Nombre(metodo) = &p[i] else { continue };
        if p[i - 1] != Signo('.') || p.get(i + 1) != Some(&Signo('(')) || !LLAMADAS.contains(&metodo.as_str()) {
            continue;
        }
        let trozo: Vec<String> = p[i..(i + 8).min(p.len())].iter().map(|x| format!("{x:?}")).collect();
        let (Some(fin), Some((ruta, tras))) = (cierre(&p, i + 1), ruta(&p, i + 2)) else {
            a.ilegibles.push(format!("`{metodo}` con una ruta que no es un literal `\"/v1/…\"`: {}", trozo.join(" ")));
            continue;
        };
        a.llamadas.push((metodo.clone(), ruta));
        if metodo != "get_query" {
            continue;
        }
        let segundo = tras + 1;
        let cierra = |j: usize| j == fin || (p.get(j) == Some(&Signo(',')) && j + 1 == fin);
        let leida = match (p.get(tras), p.get(segundo), p.get(segundo + 1)) {
            (Some(Signo(',')), Some(Signo('&')), Some(Signo('['))) => match lista(&p, segundo + 1) {
                Some((nombres, despues)) if cierra(despues) => {
                    a.parametros.extend(nombres);
                    true
                }
                _ => false,
            },
            (Some(Signo(',')), Some(Signo('&')), Some(Nombre(var))) if cierra(segundo + 2) => {
                pares_del_vec(&p, ambito(&cuerpos, i, p.len()), var, segundo + 1, &mut a);
                true
            }
            _ => false,
        };
        if !leida {
            a.ilegibles.push(format!(
                "`get_query` con una query que no es una lista de pares ni un `Vec` de la función: {}",
                trozo.join(" ")
            ));
        }
    }

    // Toda ruta escrita en el fuente, también la que se guarde antes de usarla.
    for x in &p {
        if let Texto(s) = x {
            if s.starts_with("/v1/") {
                analizar_ruta(s, &mut a);
            }
        }
    }

    a
}

fn nombres(a: &Analisis) -> Vec<&str> {
    a.parametros.iter().map(String::as_str).collect()
}

#[test]
fn ningun_repositorio_pone_en_la_query_algo_que_no_este_en_la_lista() {
    let mut vistos = 0;
    let mut fuera = Vec::new();
    let mut ilegibles = Vec::new();
    for (modulo, fuente) in REPOSITORIOS {
        let a = analizar(fuente);
        ilegibles.extend(a.ilegibles.iter().map(|que| format!("{modulo}.rs: {que}")));
        for nombre in &a.parametros {
            vistos += 1;
            if !EN_LA_QUERY.contains(&nombre.as_str()) {
                fuera.push(format!("{modulo}.rs: {nombre}"));
            }
        }
    }

    assert!(
        ilegibles.is_empty() && fuera.is_empty(),
        "parámetros de query que no están en EN_LA_QUERY (si son de una persona o texto libre, \
         van en el cuerpo de un `post_lectura`): {fuera:#?}\ny lo que el barrido no sabe leer: \
         {ilegibles:#?}"
    );
    // Si el barrido dejara de reconocer las llamadas, lo de arriba pasaría sin mirar nada.
    assert!(vistos >= 10, "el barrido sólo ha visto {vistos} parámetros");
}

#[test]
fn lo_que_se_interpola_en_el_camino_de_una_ruta_es_un_identificador() {
    let mut con_nombre = 0;
    let mut fuera = Vec::new();
    for (modulo, fuente) in REPOSITORIOS {
        let a = analizar(fuente);
        for nombre in a.interpolado.iter().filter(|n| !n.is_empty()) {
            con_nombre += 1;
            if nombre != "id" && !nombre.starts_with("id_") {
                fuera.push(format!("{modulo}.rs: {{{nombre}}}"));
            }
        }

        let sin_nombre = a.interpolado.iter().filter(|n| n.is_empty()).count();
        let previstos = SIN_NOMBRE_EN_LA_RUTA
            .iter()
            .find(|(m, _)| m == modulo)
            .map_or(0, |(_, n)| *n);
        assert_eq!(
            sin_nombre, previstos,
            "{modulo}.rs: los `{{}}` sin nombre de sus rutas no son los de SIN_NOMBRE_EN_LA_RUTA"
        );
    }

    assert!(
        fuera.is_empty(),
        "en el camino de una ruta sólo se interpolan identificadores (`{{id_…}}`); lo que sea de \
         una persona o texto libre va en el cuerpo: {fuera:?}"
    );
    assert!(con_nombre >= 30, "el barrido sólo ha visto {con_nombre} identificadores en rutas");
}

#[test]
fn el_cliente_de_una_reserva_y_las_busquedas_van_por_post_lectura() {
    let esperadas = [
        ("reservas", "/v1/reservas/buscar-cliente"),
        ("cuentas", "/v1/cuentas/entradas"),
        ("cuentas", "/v1/cuentas/salidas"),
        ("cuentas", "/v1/cuentas/resumen"),
        ("mesas", "/v1/mesas/productos/search"),
        ("venta_rapida", "/v1/venta-rapida/productos/search"),
        ("venta_rapida", "/v1/venta-rapida/index-rows"),
    ];
    for (modulo, ruta) in esperadas {
        let fuente = REPOSITORIOS.iter().find(|(m, _)| *m == modulo).unwrap().1;
        let a = analizar(fuente);
        assert!(
            a.llamadas.iter().any(|(metodo, r)| metodo == "post_lectura" && r == ruta),
            "{modulo}.rs ya no pide {ruta} con `post_lectura`"
        );
    }
}

#[test]
fn la_lista_de_repositorios_esta_completa() {
    // Un módulo nuevo que no se apunte arriba quedaría fuera del barrido sin que nadie lo note.
    let declarados: Vec<&str> = include_str!("lib.rs")
        .lines()
        .map(str::trim)
        .filter(|l| !l.starts_with("//"))
        .filter_map(|l| l.strip_prefix("pub mod ").or_else(|| l.strip_prefix("mod ")))
        .filter_map(|l| l.strip_suffix(';'))
        .collect();

    assert!(declarados.len() >= REPOSITORIOS.len(), "no he sabido leer los módulos de lib.rs");
    for modulo in declarados {
        assert!(
            REPOSITORIOS.iter().any(|(m, _)| *m == modulo)
                || NO_SON_REPOSITORIOS.contains(&modulo)
                || modulo.starts_with("tests_"),
            "el módulo `{modulo}` no está en REPOSITORIOS: apúntalo para que el barrido lo mire"
        );
    }
}

// ── El barrido, puesto a prueba ───────────────────────────────────────────────────────────────

#[test]
fn el_barrido_entiende_las_formas_de_siempre() {
    let a = analizar(
        r#"
        async fn mes(&self, desde: &str, hasta: &str) -> AppResult<Vec<ReservaDto>> {
            self.client
                .get_query(
                    "/v1/reservas/mes",
                    &[("desde", desde.to_string()), ("hasta", hasta.to_string())],
                )
                .await
        }
        async fn productos(&self, args: Args) -> AppResult<Respuesta> {
            let mut q = vec![("range", enum_str(&args.range)?)];
            if let Some(t) = args.categoria_top_id {
                q.push(("categoria_top_id", t.to_string()));
            }
            self.client.get_query("/v1/stats/productos", &q).await
        }
        async fn overview(&self, r: Ranking) -> AppResult<Vec<ClienteOverview>> {
            self.client.get_json(&format!("/v1/clientes/overview?ranking={}", ranking_arg(r))).await
        }
        async fn form(&self, id_cliente: &str) -> AppResult<Option<ClienteForm>> {
            self.client.get_json(&format!("/v1/clientes/{id_cliente}/form")).await
        }
        async fn update(&self, cliente: Cliente, filtro: Filtro) -> AppResult<bool> {
            let body = json!({ "email": cliente.email, "q": filtro.q });
            self.client.put_json(&format!("/v1/clientes/{}", cliente.id), &body).await
        }
        // .get_query("/v1/comentado", &[("q", s.clone())])
        fn otra_cosa<'a>(x: &'a str) -> char { repo.complete_initial_setup("admin", "4321"); '{' }
        "#,
    );
    assert!(a.ilegibles.is_empty(), "{:#?}", a.ilegibles);
    assert_eq!(nombres(&a), ["categoria_top_id", "desde", "hasta", "range", "ranking"]);
    assert_eq!(a.interpolado, ["id_cliente", ""]);
}

#[test]
fn el_barrido_ve_un_par_escrito_en_varias_lineas() {
    // Lo que dio pie a AUD-27, escrito como lo dejaría un formateador.
    let a = analizar(
        r#"
        self.client
            .get_query(
                "/v1/cuentas/entradas",
                &[(
                    "q",
                    valor,
                )],
            )
            .await
        "#,
    );
    assert!(a.ilegibles.is_empty(), "{:#?}", a.ilegibles);
    assert_eq!(nombres(&a), ["q"]);

    let a = analizar(
        r#"
        async fn buscar_cliente(&self, telefono: Option<&str>) -> AppResult<Option<Cliente>> {
            let mut query = Vec::new();
            if let Some(t) = telefono {
                query.push((
                    "telefono",
                    t.to_string(),
                ));
            }
            self.client.get_query("/v1/reservas/buscar-cliente", &query).await
        }
        "#,
    );
    assert!(a.ilegibles.is_empty(), "{:#?}", a.ilegibles);
    assert_eq!(nombres(&a), ["telefono"]);
}

#[test]
fn lo_que_va_en_el_cuerpo_no_cuenta_como_query() {
    // Un par con un nombre que no puede ir en la query, pero que va al cuerpo de un POST.
    let a = analizar(
        r#"
        fn cuerpo(email: &str) -> Vec<(&'static str, String)> {
            vec![("email", email.to_string())]
        }
        async fn buscar(&self, email: &str, telefono: &str) -> AppResult<Option<Cliente>> {
            let pares = vec![("telefono", telefono.to_string())];
            let _: JsonValue = self.client.post_lectura("/v1/reservas/buscar-cliente", &pares).await?;
            self.client.post_lectura("/v1/reservas/buscar-cliente", &cuerpo(email)).await
        }
        "#,
    );
    assert!(a.ilegibles.is_empty(), "{:#?}", a.ilegibles);
    assert!(a.parametros.is_empty(), "{:?}", a.parametros);
}

#[test]
fn cada_vec_se_mira_en_su_funcion() {
    // Uno bueno en una función no da por bueno otro con el mismo nombre en otra.
    let a = analizar(
        r#"
        async fn una(&self, l: i64) -> AppResult<X> {
            let mut q = vec![("limit", l.to_string())];
            q.push(("limit", l.to_string()));
            self.client.get_query("/v1/x", &q).await
        }
        async fn otra(&self, filtro: Filtro) -> AppResult<X> {
            let q = filtro.pares();
            self.client.get_query("/v1/y", &q).await
        }
        "#,
    );
    assert_eq!(a.ilegibles.len(), 1, "{:#?}", a.ilegibles);
    assert!(a.ilegibles[0].contains("`q`"), "{:#?}", a.ilegibles);
}

#[test]
fn el_barrido_no_deja_pasar_lo_que_no_sabe_leer() {
    let casos = [
        ("un nombre que no es un literal", r#"self.client.get_query("/v1/x", &[(CLAVE, valor)]).await"#),
        ("un nombre que no es un literal, tras uno que sí", r#"self.client.get_query("/v1/x", &[("limit", l), (clave, valor)]).await"#),
        ("una query que monta otra función", r#"self.client.get_query("/v1/x", &rango(del, al)).await"#),
        (
            "un `Vec` que sale de otra función",
            r#"fn f() { let mut params = rango(del, al);
               self.client.get_query("/v1/x", &params).await }"#,
        ),
        ("un `Vec` que llega de fuera", r#"fn f(q: Vec<(&str, String)>) { self.client.get_query("/v1/x", &q).await }"#),
        ("una query que llega en un campo", r#"self.client.get_query("/v1/x", &filtro.pares).await"#),
        ("una query sin `&`", r#"self.client.get_query("/v1/x", pares).await"#),
        (
            "un `push` de algo que no es un par con nombre",
            r#"fn f() { let mut q = vec![("limit", l)];
               q.push(par);
               self.client.get_query("/v1/x", &q).await }"#,
        ),
        (
            "un elemento cambiado a mano",
            r#"fn f() { let mut q = vec![("limit", l)];
               q[0] = (CLAVE, email);
               self.client.get_query("/v1/x", &q).await }"#,
        ),
        (
            "un `extend`",
            r#"fn f() { let mut q = vec![("limit", l)];
               q.extend(otros);
               self.client.get_query("/v1/x", &q).await }"#,
        ),
        (
            "el `Vec` prestado para cambiarlo",
            r#"fn f() { let mut q = vec![("limit", l)];
               anadir(&mut q, email);
               self.client.get_query("/v1/x", &q).await }"#,
        ),
        (
            "el `Vec` definido dos veces",
            r#"fn f() { let q = vec![("limit", l)];
               let q = otra(q);
               self.client.get_query("/v1/x", &q).await }"#,
        ),
        (
            "el `Vec` con su tipo escrito",
            r#"fn f() { let mut q: Vec<(&str, String)> = rango();
               self.client.get_query("/v1/x", &q).await }"#,
        ),
        ("una ruta que llega en una variable", r#"self.client.get_json(&ruta).await"#),
        ("una ruta que es una constante", r#"self.client.get_query(RUTA, &[("limit", l)]).await"#),
        ("una ruta que no empieza por un literal", r#"self.client.get_json(&format!("{base}/x?q={q}")).await"#),
        ("una query con el nombre interpolado", r#"self.client.get_json(&format!("/v1/x?{clave}={valor}")).await"#),
        ("una query sin nombre", r#"self.client.get_json(&format!("/v1/x?{q}")).await"#),
        ("un cuerpo por POST con la ruta en una variable", r#"self.client.post_lectura(&ruta, &cuerpo).await"#),
    ];
    for (que, fuente) in casos {
        let a = analizar(fuente);
        assert!(!a.ilegibles.is_empty(), "el barrido deja pasar {que}: {fuente}");
    }
}

#[test]
fn y_lo_que_si_sabe_leer_lo_cuenta_aunque_no_pueda_ir_en_la_query() {
    let a = analizar(r#"self.client.get_query("/v1/x", &[("email", e), ("limit", l)]).await"#);
    assert!(a.ilegibles.is_empty(), "{:#?}", a.ilegibles);
    assert_eq!(nombres(&a), ["email", "limit"]);

    let a = analizar(r#"self.client.get_json(&format!("/v1/x/{nombre}?telefono={t}&limit=5")).await"#);
    assert!(a.ilegibles.is_empty(), "{:#?}", a.ilegibles);
    assert_eq!(nombres(&a), ["limit", "telefono"]);
    assert_eq!(a.interpolado, ["nombre"]);
}
