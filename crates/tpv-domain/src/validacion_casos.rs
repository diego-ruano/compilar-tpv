//! La validación de entrada del dominio contra la tabla que comparte con el worker (RI-78).
//!
//! El arnés de contrato compara el **efecto** de un comando, y entra por debajo de la validación:
//! lo que cada lado acepta o rechaza no lo miraba nadie, y habían divergido (un 31 de febrero, una
//! caducidad «31/12/2026», un IVA del 210 %). `validacion_casos.json` lo fija: la misma entrada
//! tiene que pasar o no pasar en los dos lados, y normalizarse al mismo valor. El espejo está en
//! `apps/cloud-worker-licensing/test/validacionCasos.test.ts`.

use serde_json::{json, Map, Value};

use crate::configuracion::validate_iva_percent;
use crate::ingredientes::{cambios_de_linea, forma_guardada, CategoriaIngredienteGuardar, IngredienteGuardar};
use crate::dinero::Dinero;
use crate::inventario::{
    LoteEdicionEntrada, LoteEntrada, LoteNuevo, LoteUpdate, ProductoEntrada, ProductoUpsert,
};
use crate::reservas::{ReservaEntrada, ReservaValidada};
use crate::reservas_web::{AltaWebEntrada, AltaWebValidada};
use crate::trabajadores::{
    dia_de_horario, validar_contrato, MSG_DIA_DEL_TURNO, MSG_SEMANA, MSG_SEMANA_DESTINO, MSG_SEMANA_ORIGEN,
};

fn texto(e: &Value, campo: &str) -> String {
    e[campo].as_str().unwrap_or_default().to_string()
}

fn texto_opcional(e: &Value, campo: &str) -> Option<String> {
    e[campo].as_str().map(str::to_string)
}

fn reserva(e: &Value) -> Result<Value, String> {
    let (dia, hora) = (texto(e, "dia_ymd"), texto(e, "hora"));
    let r = ReservaValidada::validar(ReservaEntrada {
        id_reserva: texto_opcional(e, "id_reserva"),
        dia_ymd: &dia,
        hora: &hora,
        turno: texto_opcional(e, "turno"),
        comensales: e["comensales"].as_i64().unwrap_or(0),
        duracion_min: e["duracion_min"].as_i64(),
        nota: texto_opcional(e, "nota"),
        id_mesa: texto_opcional(e, "id_mesa"),
        id_cliente: texto_opcional(e, "id_cliente"),
        nombre_cliente: texto_opcional(e, "nombre_cliente"),
        telefono: texto_opcional(e, "telefono"),
        email: texto_opcional(e, "email"),
    })?;
    Ok(json!({ "dia_ymd": r.dia_ymd, "hora": r.hora }))
}

/// Reservas desde la web: el alta que manda el widget (docs/estudios/reservas-web.md).
fn reserva_web(e: &Value) -> Result<Value, String> {
    let a = AltaWebValidada::validar(AltaWebEntrada {
        dia_ymd: texto(e, "dia_ymd"),
        hora: texto(e, "hora"),
        personas: e["personas"].as_i64().unwrap_or(0),
        id_mesa: texto(e, "id_mesa"),
        nombre: texto(e, "nombre"),
        email: texto(e, "email"),
        telefono: texto(e, "telefono"),
        nota: texto_opcional(e, "nota"),
    })?;
    Ok(json!({
        "dia_ymd": a.dia_ymd, "hora": a.hora, "nombre": a.nombre,
        "email": a.email, "telefono": a.telefono, "nota": a.nota,
    }))
}

fn dinero_opcional(e: &Value, campo: &str) -> Option<Dinero> {
    e[campo].as_i64().map(Dinero::de_centimos)
}

fn lote(e: &Value) -> Result<Value, String> {
    let l = LoteNuevo::validar(LoteEntrada {
        id_lote: texto_opcional(e, "id_lote"),
        id_producto: texto(e, "id_producto"),
        codigo_lote: texto(e, "codigo_lote"),
        caducidad: texto_opcional(e, "caducidad"),
        stock_disponible: e["stock_disponible"].as_f64().unwrap_or(f64::NAN),
        fecha_entrada: texto_opcional(e, "fecha_entrada"),
        coste_unitario: dinero_opcional(e, "coste_unitario"),
        id_proveedor: texto_opcional(e, "id_proveedor"),
        notas: texto_opcional(e, "notas"),
    })?;
    Ok(json!({ "caducidad": l.caducidad, "fecha_entrada": l.fecha_entrada }))
}

fn lote_edicion(e: &Value) -> Result<Value, String> {
    let l = LoteUpdate::validar(LoteEdicionEntrada {
        id_lote: texto(e, "id_lote"),
        id_producto: texto(e, "id_producto"),
        codigo_lote: texto(e, "codigo_lote"),
        caducidad: texto_opcional(e, "caducidad"),
        fecha_entrada: texto_opcional(e, "fecha_entrada"),
        coste_unitario: dinero_opcional(e, "coste_unitario"),
        id_proveedor: texto_opcional(e, "id_proveedor"),
        notas: texto_opcional(e, "notas"),
    })?;
    Ok(json!({ "caducidad": l.caducidad, "fecha_entrada": l.fecha_entrada }))
}

/// El IVA de un parche del negocio: ausente es «no se toca».
fn iva_opcional(e: &Value) -> Result<Option<f64>, String> {
    match e.get("iva_percent") {
        None | Some(Value::Null) => Ok(None),
        Some(v) => {
            let iva = v.as_f64().ok_or("el IVA no es un número")?;
            validate_iva_percent(iva)?;
            Ok(Some(iva))
        }
    }
}

/// A los cuántos minutos se marca «No vino»: ausente es «no se toca».
fn no_vino_opcional(e: &Value) -> Result<Option<i64>, String> {
    match e.get("reserva_no_vino_min") {
        None | Some(Value::Null) => Ok(None),
        Some(v) => {
            let m = v.as_i64().ok_or(crate::reservas::MSG_NO_VINO)?;
            crate::reservas::no_vino_valido(m).map(Some)
        }
    }
}

fn negocio(e: &Value) -> Result<Value, String> {
    Ok(json!({ "iva_percent": iva_opcional(e)?, "reserva_no_vino_min": no_vino_opcional(e)? }))
}

fn producto(e: &Value) -> Result<Value, String> {
    let p = ProductoUpsert::validar(ProductoEntrada {
        id_producto: texto_opcional(e, "id_producto"),
        id_categoria: texto(e, "id_categoria"),
        id_proveedor: texto_opcional(e, "id_proveedor"),
        nombre: texto(e, "nombre"),
        precio_venta: dinero_opcional(e, "precio_venta"),
        stock_minimo: e["stock_minimo"].as_f64(),
        unidad_medida: texto_opcional(e, "unidad_medida"),
        nombre_imagen: texto_opcional(e, "nombre_imagen"),
        ruta_imagen: texto_opcional(e, "ruta_imagen"),
        cantidad_pedido_esperada: e["cantidad_pedido_esperada"].as_f64(),
        stock_suelto: e["stock_suelto"].as_f64(),
        iva_percent: e["iva_percent"].as_f64(),
        ids_alergenos: Vec::new(),
        ids_ingredientes: e.get("ids_ingredientes").and_then(Value::as_array).map(|v| {
            v.iter().map(|x| x.as_str().unwrap_or_default().to_string()).collect()
        }),
    })?;
    Ok(json!({ "iva_percent": p.iva_percent, "nombre": p.nombre, "ids_ingredientes": p.ids_ingredientes }))
}

fn categoria_ingrediente(e: &Value) -> Result<Value, String> {
    let c = CategoriaIngredienteGuardar::validar(texto_opcional(e, "id_categoria_ingrediente"), &texto(e, "nombre"))?;
    Ok(json!({ "nombre": c.nombre }))
}

fn ingrediente(e: &Value) -> Result<Value, String> {
    let i = IngredienteGuardar::validar(
        texto_opcional(e, "id_ingrediente"),
        &texto(e, "id_categoria_ingrediente"),
        &texto(e, "nombre"),
    )?;
    Ok(json!({ "nombre": i.nombre, "id_categoria_ingrediente": i.id_categoria }))
}

fn cambios_ingredientes(e: &Value) -> Result<Value, String> {
    let lista = e["cambios"].as_array().cloned().unwrap_or_default();
    let cambios = cambios_de_linea(
        lista.iter().map(|c| (texto(c, "id_ingrediente"), texto(c, "nombre"), texto(c, "tipo"))),
    )?;
    Ok(json!({ "cambios": forma_guardada(&cambios) }))
}

/// Un pedido a un proveedor, al crearlo y al editarlo: la cabecera y después sus líneas.
fn pedido(e: &Value) -> Result<Value, String> {
    use crate::pedidos_proveedor::{validar_lineas, LineaPedidoNueva, PedidoProveedorNuevo};
    let p = PedidoProveedorNuevo::validar(
        texto(e, "id_pedido"),
        texto_opcional(e, "id_proveedor"),
        texto_opcional(e, "email_destino"),
        texto_opcional(e, "notas"),
    )?;
    let lineas = validar_lineas(
        e["lineas"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|l| LineaPedidoNueva {
                id_linea: texto(l, "id_linea"),
                nombre_producto: texto(l, "nombre_producto"),
                cantidad: l["cantidad"].as_f64().unwrap_or(f64::NAN),
                precio_unitario: l["precio_unitario"].as_i64().map(Dinero::de_centimos),
                unidad: texto_opcional(l, "unidad"),
            })
            .collect(),
    )?;
    let lineas: Vec<Value> = lineas
        .into_iter()
        .map(|l| {
            json!({
                "id_linea": l.id_linea,
                "nombre_producto": l.nombre_producto,
                "cantidad": l.cantidad,
                "precio_unitario": l.precio_unitario.map(|d| d.centimos()),
                "unidad": l.unidad,
            })
        })
        .collect();
    Ok(json!({
        "id_pedido": p.id_pedido,
        "id_proveedor": p.id_proveedor,
        "email_destino": p.email_destino,
        "notas": p.notas,
        "lineas": lineas,
    }))
}

/// El estado al que pasa un pedido, y su fecha de envío recortada.
fn pedido_estado(e: &Value) -> Result<Value, String> {
    let estado = crate::pedidos_proveedor::estado_nuevo(&texto(e, "estado"))?;
    let fecha_envio = crate::texto::limpiar_opcional(texto_opcional(e, "fecha_envio"));
    Ok(json!({ "estado": estado, "fecha_envio": fecha_envio }))
}

/// Los días de un horario: cada campo pasa por `dia_de_horario` con la frase que le da su caso de
/// uso de trabajadores.
fn dias_de_horario(e: &Value, campos: &[(&str, &str)]) -> Result<Value, String> {
    let mut normalizado = Map::new();
    for (campo, mensaje) in campos {
        normalizado.insert((*campo).into(), dia_de_horario(&texto(e, campo), mensaje)?.into());
    }
    Ok(Value::Object(normalizado))
}

/// La ficha de un trabajador: las fechas del contrato (TRA-INC-01). El resto de la ficha lo valida
/// el caso de uso; la base trae lo que el schema del worker exige para llegar hasta ellas.
fn trabajador(e: &Value) -> Result<Value, String> {
    let (inicio, fin) = validar_contrato(
        texto_opcional(e, "fecha_inicio_contrato"),
        texto_opcional(e, "fecha_fin_contrato"),
    )?;
    Ok(json!({ "fecha_inicio_contrato": inicio, "fecha_fin_contrato": fin }))
}

/// El plano que se guarda (MESAS-01): sus zonas y los nombres de sus mesas, recortados como se guardan.
fn plano(e: &Value) -> Result<Value, String> {
    let vistas: Vec<crate::mesas::ZonaDelPlano<'_>> = e["salons"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|z| crate::mesas::ZonaDelPlano {
            nombre: z["name"].as_str().unwrap_or_default(),
            mesas: z["tables"].as_array().into_iter().flatten().map(|t| t["name"].as_str().unwrap_or_default()).collect(),
        })
        .collect();
    crate::mesas::validar_plano(&vistas)?;
    let salons: Vec<Value> = vistas
        .iter()
        .map(|z| json!({ "name": z.nombre.trim(), "tables": z.mesas.iter().map(|m| json!({ "name": m.trim() })).collect::<Vec<_>>() }))
        .collect();
    Ok(json!({ "salons": salons }))
}

/// El validador de cada dominio de la tabla: devuelve los campos que normaliza, o el motivo del
/// rechazo. Un dominio que no esté aquí hace fallar el test: no se queda sin comprobar en silencio.
fn validar(dominio: &str, entrada: &Value) -> Result<Value, String> {
    match dominio {
        "reserva" => reserva(entrada),
        "lote" => lote(entrada),
        "lote_edicion" => lote_edicion(entrada),
        "negocio" => negocio(entrada),
        "producto" => producto(entrada),
        "horario_alta" => dias_de_horario(entrada, &[("fecha", MSG_DIA_DEL_TURNO)]),
        "horario_copia" => dias_de_horario(
            entrada,
            &[("from_monday", MSG_SEMANA_ORIGEN), ("to_monday", MSG_SEMANA_DESTINO)],
        ),
        "horario_semana" => dias_de_horario(entrada, &[("fecha_lunes", MSG_SEMANA)]),
        "reserva_web" => reserva_web(entrada),
        "reserva_estado_mesa" => crate::reservas::estado_desde_la_mesa(&texto(entrada, "estado"))
            .map(|e| json!({ "estado": e.como_texto() })),
        "plano" => plano(entrada),
        "categoria_ingrediente" => categoria_ingrediente(entrada),
        "ingrediente" => ingrediente(entrada),
        "cambios_ingredientes" => cambios_ingredientes(entrada),
        "pedido" => pedido(entrada),
        "pedido_estado" => pedido_estado(entrada),
        "trabajador" => trabajador(entrada),
        otro => panic!("validacion_casos.json trae el dominio «{otro}» y este test no sabe validarlo"),
    }
}

/// Los números se comparan como números: para `serde_json`, el `21` del JSON y un `21.0` no son
/// iguales.
fn mismo_valor(a: &Value, b: &Value) -> bool {
    match (a, b) {
        // También dentro de una lista o de un objeto (las líneas de un pedido).
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| mismo_valor(p, q)),
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| mismo_valor(v, w)))
        }
        _ => match (a.as_f64(), b.as_f64()) {
            (Some(x), Some(y)) => x == y,
            _ => a == b,
        },
    }
}

#[test]
fn la_validacion_cuadra_con_la_tabla_compartida() {
    let tabla: Map<String, Value> = serde_json::from_str(include_str!("validacion_casos.json"))
        .expect("validacion_casos.json no es JSON valido");

    for (dominio, bloque) in tabla.iter().filter(|(clave, _)| clave.as_str() != "//") {
        let base = bloque["base"].as_object().expect("falta «base»");
        for caso in bloque["casos"].as_array().expect("faltan los «casos»") {
            let nombre = caso["nombre"].as_str().expect("un caso sin «nombre»");
            let mut entrada = base.clone();
            for (campo, valor) in caso["cambios"].as_object().expect("un caso sin «cambios»") {
                entrada.insert(campo.clone(), valor.clone());
            }

            let resultado = validar(dominio, &Value::Object(entrada));
            let acepta = caso["acepta"].as_bool().expect("un caso sin «acepta»");
            assert_eq!(resultado.is_ok(), acepta, "{dominio} · {nombre}: {resultado:?}");

            // VALID-03: lo que se le dice a quien está delante, el mismo texto en los dos lados.
            if let Err(motivo) = &resultado {
                let mensaje = caso["mensaje"].as_str().unwrap_or_else(|| panic!("{dominio} · {nombre}: un rechazo sin «mensaje»"));
                assert_eq!(motivo, mensaje, "{dominio} · {nombre}: el mensaje");
            }

            if let (Ok(normalizado), Some(queda)) = (&resultado, caso["queda"].as_object()) {
                for (campo, esperado) in queda {
                    assert!(
                        mismo_valor(&normalizado[campo], esperado),
                        "{dominio} · {nombre} · {campo}: queda {} y se esperaba {esperado}",
                        normalizado[campo]
                    );
                }
            }
        }
    }
}
