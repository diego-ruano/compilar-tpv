//! La validación de entrada del dominio contra la tabla que comparte con el worker (RI-78).
//!
//! El arnés de contrato compara el **efecto** de un comando, y entra por debajo de la validación:
//! lo que cada lado acepta o rechaza no lo miraba nadie, y habían divergido (un 31 de febrero, una
//! caducidad «31/12/2026», un IVA del 210 %). `validacion_casos.json` lo fija: la misma entrada
//! tiene que pasar o no pasar en los dos lados, y normalizarse al mismo valor. El espejo está en
//! `apps/cloud-worker-licensing/test/validacionCasos.test.ts`.

use serde_json::{json, Map, Value};

use crate::configuracion::validate_iva_percent;
use crate::dinero::Dinero;
use crate::inventario::{
    LoteEdicionEntrada, LoteEntrada, LoteNuevo, LoteUpdate, ProductoEntrada, ProductoUpsert,
};
use crate::reservas::{ReservaEntrada, ReservaValidada};

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
        estado: texto_opcional(e, "estado"),
        id_mesa: texto_opcional(e, "id_mesa"),
        id_cliente: texto_opcional(e, "id_cliente"),
        nombre_cliente: texto_opcional(e, "nombre_cliente"),
        telefono: texto_opcional(e, "telefono"),
        email: texto_opcional(e, "email"),
    })?;
    Ok(json!({ "dia_ymd": r.dia_ymd, "hora": r.hora }))
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

fn negocio(e: &Value) -> Result<Value, String> {
    Ok(json!({ "iva_percent": iva_opcional(e)? }))
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
    })?;
    Ok(json!({ "iva_percent": p.iva_percent }))
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
        otro => panic!("validacion_casos.json trae el dominio «{otro}» y este test no sabe validarlo"),
    }
}

/// Los números se comparan como números: para `serde_json`, el `21` del JSON y un `21.0` no son
/// iguales.
fn mismo_valor(a: &Value, b: &Value) -> bool {
    match (a.as_f64(), b.as_f64()) {
        (Some(x), Some(y)) => x == y,
        _ => a == b,
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
