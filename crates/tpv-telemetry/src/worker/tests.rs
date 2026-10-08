use super::*;
use crate::context::Context;
use crate::test_support::{event, TestDir};
use crate::config::IngestSigner;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

struct Signer;
impl IngestSigner for Signer {
    fn sign(&self, _: &str, _: &str, _: &[u8]) -> Option<Vec<(String, String)>> { Some(Vec::new()) }
}
async fn receive_request(socket: &mut tokio::net::TcpStream) -> Vec<u8> {
    let mut bytes = Vec::new();
    let header_end = loop {
        assert!(socket.read_buf(&mut bytes).await.unwrap() > 0);
        if let Some(i) = bytes.windows(4).position(|w| w == b"\r\n\r\n") { break i + 4; }
    };
    let headers = String::from_utf8_lossy(&bytes[..header_end]);
    let size: usize = headers.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.eq_ignore_ascii_case("content-length").then(|| value.trim().parse().unwrap())
    }).unwrap();
    while bytes.len() < header_end + size { assert!(socket.read_buf(&mut bytes).await.unwrap() > 0); }
    bytes[header_end..header_end + size].to_vec()
}
fn state() -> Arc<TelemetryState> {
    Arc::new(TelemetryState::new(Context::new("test".into(), "dev".into()), 20_000))
}

#[tokio::test(start_paused = true)]
async fn persiste_al_segundo_y_sella_a_los_sesenta_sin_archivos_por_evento() {
    let dir = TestDir::new();
    let state = state();
    let task = tokio::spawn(loop_forever(WorkerConfig {
        spool_dir: dir.0.clone(), ingest: IngestConfig::default(), state: state.clone(),
    }));
    tokio::task::yield_now().await;
    for _ in 0..12 { state.push(event("goteo")); }
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_secs(1)).await;
    tokio::task::yield_now().await;
    assert!(state.drain().is_empty());
    let paths: Vec<_> = std::fs::read_dir(&dir.0).unwrap().map(|e| e.unwrap().path()).collect();
    assert_eq!(paths.len(), 1);
    assert!(paths[0].to_string_lossy().ends_with(".jsonl.tmp"));
    tokio::time::advance(Duration::from_secs(60)).await;
    tokio::task::yield_now().await;
    assert_eq!(std::fs::read_dir(&dir.0).unwrap().next().unwrap().unwrap().path().extension().unwrap(), "jsonl");
    task.abort();
    let _ = task.await;
}

#[tokio::test]
async fn un_post_lento_no_detiene_el_drenado_a_disco() {
    let dir = TestDir::new();
    let state = state();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/v1/telemetry", listener.local_addr().unwrap());
    let (received, waiting) = tokio::sync::oneshot::channel();
    let (release, held) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let body = receive_request(&mut socket).await;
        assert_eq!(serde_json::from_slice::<serde_json::Value>(&body).unwrap()["events"].as_array().unwrap().len(), 500);
        received.send(()).unwrap();
        held.await.unwrap();
        socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
    });
    let task = tokio::spawn(loop_forever(WorkerConfig {
        spool_dir: dir.0.clone(), state: state.clone(),
        ingest: IngestConfig { url, enabled: true, signer: Some(Arc::new(Signer)), ..Default::default() },
    }));
    for _ in 0..500 { state.push(event("lote lleno")); }
    tokio::time::timeout(Duration::from_secs(5), waiting).await.unwrap().unwrap();
    state.push(event("durante el POST"));
    tokio::time::sleep(Duration::from_millis(1200)).await;
    assert!(state.drain().is_empty());
    let active = std::fs::read_dir(&dir.0).unwrap().map(|e| e.unwrap().path())
        .find(|p| p.to_string_lossy().ends_with(".jsonl.tmp")).unwrap();
    assert!(std::fs::read_to_string(active).unwrap().contains("durante el POST"));
    release.send(()).unwrap();
    server.await.unwrap();
    task.abort();
    let _ = task.await;
}

#[test]
fn handy_tiene_su_presupuesto_incluso_en_escritorio() {
    let state = state();
    state.context.write().unwrap().device_mode = "handy".into();
    assert_eq!(spool_limit(&state), 64 * 1024 * 1024);
}

#[tokio::test(start_paused = true)]
async fn reintenta_una_escritura_fallida_con_eventos_nuevos_sin_perder_el_orden() {
    let dir = TestDir::new();
    let state = state();
    let task = tokio::spawn(loop_forever(WorkerConfig {
        spool_dir: dir.0.clone(), ingest: IngestConfig::default(), state: state.clone(),
    }));
    tokio::task::yield_now().await;
    let moved = dir.0.with_extension("moved");
    std::fs::rename(&dir.0, &moved).unwrap();
    state.push(event("primero"));
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_secs(1)).await;
    tokio::task::yield_now().await;
    let pending_after_error = state.pending_len();
    state.push(event("segundo"));
    std::fs::rename(moved, &dir.0).unwrap();
    assert_eq!(pending_after_error, 1);
    tokio::time::advance(BACKOFF_MIN).await;
    tokio::task::yield_now().await;
    assert_eq!(state.pending_len(), 0);
    let active = std::fs::read_dir(&dir.0).unwrap().next().unwrap().unwrap().path();
    let events: Vec<serde_json::Value> = std::fs::read_to_string(active).unwrap().lines()
        .map(|line| serde_json::from_str(line).unwrap()).collect();
    assert_eq!(events.iter().map(|e| e["message"].as_str().unwrap()).collect::<Vec<_>>(), ["primero", "segundo"]);
    task.abort();
    let _ = task.await;
}

#[tokio::test]
async fn solo_los_rechazos_del_cuerpo_son_permanentes_y_se_envian_los_bytes_firmados() {
    struct ExactSigner;
    impl IngestSigner for ExactSigner {
        fn sign(&self, method: &str, path: &str, body: &[u8]) -> Option<Vec<(String, String)>> {
            assert_eq!(method, "POST");
            assert_eq!(path, "/v1/telemetry");
            assert_eq!(body, b"{\"events\":[]}");
            Some(Vec::new())
        }
    }
    for (status, expected) in [
        (200, UploadOutcome::Sent), (400, UploadOutcome::Rejected), (413, UploadOutcome::Rejected),
        (422, UploadOutcome::Rejected), (401, UploadOutcome::Failed), (403, UploadOutcome::Failed),
        (429, UploadOutcome::Failed), (502, UploadOutcome::Failed),
    ] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/v1/telemetry", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(receive_request(&mut socket).await, b"{\"events\":[]}");
            let response = format!("HTTP/1.1 {status} Result\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            socket.write_all(response.as_bytes()).await.unwrap();
        });
        let config = IngestConfig { url, enabled: true, signer: Some(Arc::new(ExactSigner)), ..Default::default() };
        assert_eq!(upload(reqwest::Client::new(), config, b"{\"events\":[]}".to_vec()).await, expected);
        server.await.unwrap();
    }
}
