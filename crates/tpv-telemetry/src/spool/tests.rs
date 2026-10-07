use super::*;
use crate::test_support::{event, TestDir};

fn messages(batch: &UploadBatch) -> Vec<String> {
    let value: serde_json::Value = serde_json::from_slice(&batch.body).unwrap();
    value["events"].as_array().unwrap().iter().map(|e| e["message"].as_str().unwrap().to_owned()).collect()
}

#[test]
fn el_goteo_comparte_segmento_y_se_recupera_sin_sellarlo() {
    let dir = TestDir::new();
    let mut spool = Spool::open(&dir.0).unwrap();
    for _ in 0..60 { spool.append(&event("goteo")).unwrap(); }
    assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 1);
    assert!(!spool.has_pending());
    assert!(spool.deadline().unwrap() > Instant::now() + Duration::from_secs(59));
    drop(spool);
    let mut recovered = Spool::open(&dir.0).unwrap();
    let batch = recovered.prepare(500).unwrap().unwrap();
    assert_eq!(batch.events, 60);
    recovered.acknowledge(&batch).unwrap();
    assert!(!recovered.has_pending());
}

#[test]
fn junta_ficheros_antiguos_y_respeta_el_maximo_de_eventos() {
    let dir = TestDir::new();
    for i in 0..510 {
        fs::write(dir.0.join(format!("{i:013}.jsonl")), encode_event(&event(&format!("evento {i}"))).unwrap()).unwrap();
    }
    let mut spool = Spool::open(&dir.0).unwrap();
    let batch = spool.prepare(500).unwrap().unwrap();
    assert_eq!(batch.events, 500);
    assert_eq!(messages(&batch)[0], "evento 0");
    assert_eq!(spool.pending.len(), 510); // Preparar no borra nada.
    spool.acknowledge(&batch).unwrap();
    assert_eq!(spool.prepare(500).unwrap().unwrap().events, 10);
}

#[test]
fn el_cursor_parcial_sobrevive_al_reinicio_y_se_actualiza_dos_veces() {
    let dir = TestDir::new();
    let path = dir.0.join("0000000000001.jsonl");
    let data: Vec<u8> = (0..6).flat_map(|i| encode_event(&event(&format!("evento {i}"))).unwrap()).collect();
    fs::write(path, data).unwrap();
    let mut spool = Spool::open(&dir.0).unwrap();
    for _ in 0..2 {
        let batch = spool.prepare(2).unwrap().unwrap();
        spool.acknowledge(&batch).unwrap();
    }
    drop(spool);
    let mut recovered = Spool::open(&dir.0).unwrap();
    let batch = recovered.prepare(500).unwrap().unwrap();
    assert_eq!(messages(&batch), ["evento 4", "evento 5"]);
    recovered.acknowledge(&batch).unwrap();
    assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 0);
}

#[test]
fn recupera_temporales_y_descarta_solo_la_ultima_linea_incompleta() {
    let dir = TestDir::new();
    let mut data = encode_event(&event("completo")).unwrap();
    data.extend_from_slice(b"{\"message\":\"cortado");
    fs::write(dir.0.join("0000000000001.jsonl.tmp"), data).unwrap();
    let mut spool = Spool::open(&dir.0).unwrap();
    assert_eq!(messages(&spool.prepare(500).unwrap().unwrap()), ["completo"]);
}

#[test]
fn lineas_corruptas_no_bloquean_los_eventos_validos() {
    let dir = TestDir::new();
    let mut data = b"no es json\n".to_vec();
    data.extend(encode_event(&event("válido")).unwrap());
    fs::write(dir.0.join("0000000000001.jsonl"), data).unwrap();
    let mut spool = Spool::open(&dir.0).unwrap();
    let batch = spool.prepare(500).unwrap().unwrap();
    assert_eq!(messages(&batch), ["válido"]);
    spool.acknowledge(&batch).unwrap();
    assert!(!spool.has_pending());
}

#[test]
fn los_lotes_se_acotan_por_bytes_y_los_campos_enormes_no_bloquean() {
    let dir = TestDir::new();
    let mut spool = Spool::open(&dir.0).unwrap();
    let mut large = event(&"💶".repeat(4000));
    large.fields.insert("detalle".into(), "x".repeat(110_000).into());
    for _ in 0..20 { spool.append(&large).unwrap(); }
    let mut huge = event("enorme");
    huge.fields.insert("detalle".into(), "x".repeat(MAX_EVENT_BYTES * 2).into());
    spool.append(&huge).unwrap();
    spool.seal().unwrap();
    let mut n = 0;
    while let Some(batch) = spool.prepare(500).unwrap() {
        assert!(batch.body.len() <= MAX_BODY_BYTES);
        let value: serde_json::Value = serde_json::from_slice(&batch.body).unwrap();
        for e in value["events"].as_array().unwrap() { assert!(e["message"].as_str().unwrap().encode_utf16().count() <= 4000); }
        n += batch.events;
        spool.acknowledge(&batch).unwrap();
    }
    assert_eq!(n, 21);
}

#[test]
fn poda_los_mas_antiguos_por_bytes_y_protege_la_subida_en_vuelo() {
    let dir = TestDir::new();
    let mut spool = Spool::open(&dir.0).unwrap();
    for message in ["antiguo", "intermedio", "reciente"] {
        spool.append(&event(message)).unwrap();
        spool.seal().unwrap();
    }
    let batch = spool.prepare(1).unwrap().unwrap();
    let limit = spool.pending.values().next().unwrap().bytes;
    assert!(spool.prune(limit, Some(&batch)).unwrap() > 0);
    assert_eq!(messages(&spool.prepare(500).unwrap().unwrap()), ["antiguo"]);
    spool.acknowledge(&batch).unwrap();
    assert!(!spool.has_pending());
}

#[test]
fn una_lectura_fallida_conserva_el_fichero_y_su_inventario() {
    let dir = TestDir::new();
    let mut spool = Spool::open(&dir.0).unwrap();
    spool.append(&event("conservar")).unwrap();
    spool.seal().unwrap();
    let path = spool.pending.keys().next().unwrap().clone();
    let hidden = path.with_extension("hidden");
    fs::rename(&path, &hidden).unwrap();
    assert!(spool.prepare(500).is_err());
    assert!(spool.has_pending());
    fs::rename(hidden, path).unwrap();
    assert_eq!(messages(&spool.prepare(500).unwrap().unwrap()), ["conservar"]);
}

#[test]
fn una_escritura_fallida_no_da_el_evento_por_persistido() {
    let dir = TestDir::new();
    let mut spool = Spool::open(&dir.0).unwrap();
    let moved = dir.0.with_extension("moved");
    fs::rename(&dir.0, &moved).unwrap();
    assert!(spool.append(&event("reintentar")).is_err());
    fs::rename(moved, &dir.0).unwrap();
    spool.append(&event("reintentar")).unwrap();
    spool.seal().unwrap();
    assert_eq!(messages(&spool.prepare(500).unwrap().unwrap()), ["reintentar"]);
}
