//! Escenarios del motor nativo con transporte y persistencia deterministas.
use super::*;
use async_trait::async_trait;
use std::{collections::VecDeque, sync::{Arc, Mutex}};
use crate::ports::sync::SyncRepository;
use tpv_contracts::{licensing::*,sync::*};
use serde_json::Value as JsonValue;

#[derive(Default)]
struct FakeRepo {
    limits: Mutex<Vec<i64>>, checkpoints: Mutex<usize>,
    pending: Mutex<Vec<OutboxEntry>>, encoladas:Mutex<Vec<String>>, cursor:Mutex<i64>,
}
    #[async_trait]
    impl SyncRepository for FakeRepo {
        async fn apply_changes(&self, changes: Vec<SyncChange>) -> AppResult<AplicacionSync> {
            let mut applied = Vec::new();
            let mut outbox = self.pending.lock().unwrap();
            for change in changes {
                let own = outbox.iter().any(|e| e.op_id == change.op_id);
                outbox.retain(|e| e.op_id != change.op_id);
                *self.cursor.lock().unwrap() = change.seq;
                if !own { applied.push(change.op_id); }
            }
            Ok(AplicacionSync { aplicadas:applied, last_seq:*self.cursor.lock().unwrap() })
        }
        async fn get_checkpoint(&self) -> AppResult<i64> {
            *self.checkpoints.lock().unwrap() += 1;
            Ok(*self.cursor.lock().unwrap())
        }
        async fn outbox_pending(&self, limit: i64) -> AppResult<Vec<OutboxEntry>> {
            self.limits.lock().unwrap().push(limit);
            Ok(self.pending.lock().unwrap().iter().filter(|e| !self.encoladas.lock().unwrap().contains(&e.op_id)).take(limit as usize).cloned().collect())
        }
        async fn outbox_mark_sent(&self, id: &str, _: i64) -> AppResult<()> {
            self.pending.lock().unwrap().retain(|e| e.op_id != id);
            Ok(())
        }
        async fn outbox_mark_failed(&self, _: &str, _: &str, _: bool) -> AppResult<OutboxFallo> {
            Ok(OutboxFallo::default())
        }
        async fn contrastar_con_la_nube(
            &self,
            _: VerificacionNube,
            _: bool,
        ) -> AppResult<ResultadoVerificacion> {
            Ok(ResultadoVerificacion::default())
        }
        async fn contrastar_claves(
            &self,
            _: VerificacionClaves,
            _: i64,
            _: bool,
        ) -> AppResult<(Vec<tpv_contracts::sync::DescuadreTabla>, i64, i64, bool)> {
            Ok((Vec::new(), 0, 0, false))
        }
        async fn outbox_mark_encolada(&self, ids: &[String]) -> AppResult<()> {
            self.encoladas.lock().unwrap().extend_from_slice(ids);
            Ok(())
        }
        async fn liberar_encoladas_caducadas(&self, _: i64) -> AppResult<i64> {
            Ok(0)
        }
        async fn purge_applied_ops(&self) -> AppResult<()> {
            Ok(())
        }
        async fn health(&self) -> AppResult<SyncHealth> {
            Ok(SyncHealth {outbox_pending:self.pending.lock().unwrap().len() as i64,last_seq:*self.cursor.lock().unwrap(),quarantined:0,failing:0,subida_fallando:0,subida_en_cuarentena:0})
        }
        async fn bootstrap_restaurar(
            &self,
            _: tpv_contracts::sync::BootstrapSnapshot,
        ) -> AppResult<tpv_contracts::sync::BootstrapResultado> {
            panic!("no se debe llegar a restaurar en estas pruebas")
        }
        async fn backfill_siguiente(&self) -> AppResult<Option<(String, i64)>> {
            Ok(None)
        }
        async fn backfill_aplicar_pagina(&self, _: HistoricoPagina) -> AppResult<i64> {
            panic!("no usado")
        }
        async fn backfill_marcar_error(&self, _: &str, _: &str) -> AppResult<()> {
            Ok(())
        }
        async fn backfill_estado(&self) -> AppResult<BackfillEstado> {
            panic!("no usado")
        }
    }


struct Nube { responses:Mutex<VecDeque<Value>>, calls:Mutex<Vec<String>> }
#[async_trait]
impl PairingService for Nube {
fn device_identity(&self) -> AppResult<DeviceIdentity> { panic!("Capacidad ajena a esta prueba") }
fn firmar_hello(&self, _mode: &str, _nonce_b64: &str) -> AppResult<FirmaDispositivo> { panic!("Capacidad ajena a esta prueba") }
fn firmar_emparejamiento(&self, _args: DeviceFirmarEmparejamientoArgs) -> AppResult<FirmaDispositivo> { panic!("Capacidad ajena a esta prueba") }
fn hora_para_firmar(&self) -> i64 { panic!("Capacidad ajena a esta prueba") }
fn handy_set_token(&self, _token: &str, _tenant_id: &str) -> AppResult<()> { panic!("Capacidad ajena a esta prueba") }
fn handy_clear_token(&self) -> AppResult<()> { panic!("Capacidad ajena a esta prueba") }
fn handy_get_tenant(&self) -> AppResult<Option<String>> { panic!("Capacidad ajena a esta prueba") }
fn tpv_server_signed_headers(
        &self,
        _mode: &str,
        _method: &str,
        _path: &str,
        _body: &[u8],
    ) -> AppResult<ApiSignedHeaders> { panic!("Capacidad ajena a esta prueba") }
async fn tpv_server_post_json(
        &self,
        _mode: &str,
        path: &str,
        _body: JsonValue,
    ) -> AppResult<JsonValue> {
            self.calls.lock().unwrap().push(path.to_string());
            self.responses.lock().unwrap().pop_front().ok_or_else(|| AppError::external("Respuesta no prevista"))
        }
async fn pair_create(&self) -> AppResult<PairCreateResult> { panic!("Capacidad ajena a esta prueba") }
async fn upload_image(
        &self,
        _mode: &str,
        _path: &str,
        _content_type: &str,
        _bytes: Vec<u8>,
    ) -> AppResult<()> { panic!("Capacidad ajena a esta prueba") }
async fn delete_image(&self, _mode: &str, _path: &str) -> AppResult<()> { panic!("Capacidad ajena a esta prueba") }
async fn download_image(&self, _mode: &str, _rel_path: &str) -> AppResult<Option<Vec<u8>>> { panic!("Capacidad ajena a esta prueba") }
}
struct Contexto { repo: Arc<FakeRepo>, fases:Mutex<Vec<String>>, avisos:Mutex<usize>, completa:Mutex<Option<i64>> }
#[async_trait]
impl ContextoReplicacion for Contexto {
    async fn repositorio(&self) -> AppResult<Arc<dyn SyncRepository>> { Ok(self.repo.clone()) }
    fn cambios(&self, _: &[SqlStatement]) { *self.avisos.lock().unwrap() += 1; }
    fn fase_recuperacion(&self, fase:&str) { self.fases.lock().unwrap().push(fase.into()); }
    fn solicitud_emparejamiento(&self) {}
    fn fallo_subida(&self, _: &str, _: &OutboxFallo) {}
    async fn completar_recuperacion(&self, h:i64)->AppResult<()> { *self.completa.lock().unwrap()=Some(h);Ok(()) }
    async fn sigue_disponible(&self,_:bool)->AppResult<bool> { Ok(false) }
    fn volcado_permitido(&self)->bool {true}
}
struct Canal { respuestas:VecDeque<Value>, enviados:Vec<Value> }
#[async_trait]
impl CanalReplicacion for Canal {
    async fn enviar(&mut self,m:Value)->AppResult<()> {self.enviados.push(m);Ok(())}
    async fn recibir(&mut self,_:Duration)->AppResult<Option<Value>> {self.respuestas.pop_front().map(Some).ok_or_else(||AppError::external("Sin conexión"))}
}
fn contexto(ops:Vec<OutboxEntry>)->Contexto {
    let repo=Arc::new(FakeRepo::default());*repo.pending.lock().unwrap()=ops;
    Contexto{repo,fases:Mutex::new(vec![]),avisos:Mutex::new(0),completa:Mutex::new(None)}
}
fn op(id:&str)->OutboxEntry {OutboxEntry{seq:1,op_id:id.into(),command_name:"venta".into(),statements:vec![SqlStatement{sql:"INSERT INTO Productos (Nombre) VALUES (?1)".into(),args:vec![json!("Producto")]}]}}
fn nube(respuestas:Vec<Value>)->Nube {Nube{responses:Mutex::new(respuestas.into()),calls:Mutex::new(vec![])}}
fn pagina(items:Vec<Value>,high:i64)->Value {json!({"items":items,"nextSince":high,"highWater":high})}
fn canal(respuestas:Vec<Value>)->Canal {Canal{respuestas:respuestas.into(),enviados:vec![]}}

#[tokio::test]
async fn solo_el_ack_de_la_operacion_enviada_la_confirma() {
    let ctx=contexto(vec![op("a")]);let mut c=canal(vec![json!({"type":"apply_ack","opId":"otra","ok":true})]);
    assert!(subir_pendientes(&ctx,&mut c,false,false).await.is_err());
    assert_eq!(ctx.repo.pending.lock().unwrap().len(),1);
}
#[tokio::test]
async fn un_corte_sin_ack_conserva_la_operacion() {
    let ctx=contexto(vec![op("a")]);let mut c=canal(vec![]);
    assert!(subir_pendientes(&ctx,&mut c,false,false).await.is_err());
    assert_eq!(ctx.repo.pending.lock().unwrap().len(),1);
}
#[tokio::test]
async fn se_aplica_lo_vivo_mientras_se_espera_una_confirmacion() {
    let ctx=contexto(vec![op("a")]);let mut c=canal(vec![json!({"type":"change","opId":"remota","seq":2,"statements":[{"sql":"UPDATE Productos SET Nombre=?1","args":["Otro"]}]}),json!({"type":"apply_ack","opId":"a","seq":3,"ok":true})]);
    assert!(subir_pendientes(&ctx,&mut c,false,false).await.unwrap());
    assert!(ctx.repo.pending.lock().unwrap().is_empty());assert_eq!(*ctx.avisos.lock().unwrap(),1);
}
#[tokio::test]
async fn encolada_no_se_considera_aplicada() {
    let ctx=contexto(vec![op("a")]);let mut c=canal(vec![json!({"type":"apply_ack","opId":"a","ok":true,"encolada":true})]);
    assert!(subir_pendientes(&ctx,&mut c,false,false).await.unwrap());
    assert_eq!(ctx.repo.pending.lock().unwrap().len(),1);assert_eq!(ctx.repo.encoladas.lock().unwrap().as_slice(),["a"]);
}
#[tokio::test]
async fn el_volcado_conserva_las_filas_hasta_verlas_volver() {
    let ctx=contexto((0..101).map(|i|op(&i.to_string())).collect());let mut c=canal(vec![json!({"type":"bulk_ack","ok":true})]);
    assert!(subir_pendientes(&ctx,&mut c,true,false).await.unwrap());
    assert_eq!(ctx.repo.pending.lock().unwrap().len(),101);assert_eq!(ctx.repo.encoladas.lock().unwrap().len(),101);
    assert_eq!(c.enviados[0]["type"],"bulk_apply");
}
#[tokio::test]
async fn un_eco_confirmado_no_refresca_la_interfaz() {
    let ctx=contexto(vec![op("a")]);
    aplicar(&ctx,vec![SyncChange{op_id:"a".into(),seq:1,statements:op("a").statements}]).await.unwrap();
    assert_eq!(*ctx.avisos.lock().unwrap(),0);assert!(ctx.repo.pending.lock().unwrap().is_empty());
}
#[tokio::test]
async fn recuperar_descarga_sube_y_verifica_antes_de_desbloquear() {
    let ctx=contexto(vec![op("a")]);let n=nube(vec![pagina(vec![],0),pagina(vec![],0)]);let mut c=canal(vec![json!({"type":"apply_ack","opId":"a","ok":true,"seq":1})]);
    ejecutar(&ctx,&n,&mut c,true).await.unwrap();
    assert_eq!(ctx.fases.lock().unwrap().as_slice(),["descargando","subiendo","verificando","completada"]);
    assert_eq!(*ctx.completa.lock().unwrap(),Some(0));assert_eq!(c.enviados.last().unwrap()["type"],"recovery_ready");
}
#[tokio::test]
async fn sin_high_water_la_recuperacion_falla_cerrada() {
    let ctx=contexto(vec![]);let n=nube(vec![json!({"items":[],"nextSince":0})]);let mut c=canal(vec![]);
    assert!(ejecutar(&ctx,&n,&mut c,true).await.is_err());assert!(ctx.completa.lock().unwrap().is_none());
}
