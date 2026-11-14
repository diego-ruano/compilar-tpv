//! Escenarios del motor nativo con transporte y persistencia deterministas.
use super::*;
use async_trait::async_trait;
use std::{collections::{HashMap, VecDeque}, sync::{Arc, Mutex}};
use crate::ports::{replicacion::{RitmoDeSubida, LOTE_MAX_OPS}, sync::{BajadaAplicada, CambioDetenido, SyncRepository}};
use tpv_contracts::{licensing::*,sync::*};
use serde_json::Value as JsonValue;

#[derive(Default)]
struct FakeRepo {
    limits: Mutex<Vec<i64>>, checkpoints: Mutex<usize>,
    pending: Mutex<Vec<OutboxEntry>>, cursor:Mutex<i64>,
    // AUD-18: cuántas veces más falla cada cambio, los intentos que lleva, el detenido (lo que en
    // el repositorio real es `_Sync_Failed`), lo aplicado en orden y lo apartado a la cuarentena.
    fallos: Mutex<HashMap<String, i64>>, intentos: Mutex<HashMap<String, i64>>,
    detenido: Mutex<Option<SyncChange>>, aplicados: Mutex<Vec<i64>>, cuarentena: Mutex<Vec<String>>,
    // Los `Seq` que se le han pedido aplicar, llamada a llamada.
    llamadas: Mutex<Vec<Vec<i64>>>,
    // La subida: lo que se ha confirmado en cada llamada (cada una es una transacción), las
    // apartadas (`Cuarentena = 1`: siguen en el outbox, fuera de lo pendiente) y los rechazos
    // contados de cada operación.
    confirmaciones: Mutex<Vec<Vec<(String, i64)>>>, apartadas: Mutex<Vec<String>>, rechazos: Mutex<HashMap<String, i64>>,
    // SYNC-32: si se ha marcado la base como anterior a la nube.
    anterior_a_la_nube: Mutex<bool>,
    // SYNC-29: lo que contesta cada vuelta de la convergencia y lo que había por subir en cada una.
    convergencias: Mutex<VecDeque<crate::ports::sync::Convergencia>>, al_converger: Mutex<Vec<usize>>,
}
    #[async_trait]
    impl SyncRepository for FakeRepo {
        /// El mismo contrato que el repositorio real (AUD-18): en orden, lo procesado se salta,
        /// nada pasa por delante del detenido y a los cinco intentos se aparta.
        async fn apply_changes(&self, changes: Vec<SyncChange>) -> AppResult<BajadaAplicada> {
            self.llamadas.lock().unwrap().push(changes.iter().map(|c| c.seq).collect());
            let mut applied = Vec::new();
            let mut detenida = None;
            let mut outbox = self.pending.lock().unwrap();
            for change in changes {
                if change.seq <= *self.cursor.lock().unwrap() { continue; }
                let antes = self.detenido.lock().unwrap().clone().filter(|d| d.seq < change.seq);
                if let Some(d) = antes {
                    let intentos = self.intentos.lock().unwrap().get(&d.op_id).copied().unwrap_or(0);
                    detenida = Some(CambioDetenido { op_id: d.op_id, seq: d.seq, intentos });
                    break;
                }
                let own = outbox.iter().any(|e| e.op_id == change.op_id);
                outbox.retain(|e| e.op_id != change.op_id);
                let falla = self.fallos.lock().unwrap().get_mut(&change.op_id).map(|n| { *n -= 1; *n >= 0 }).unwrap_or(false);
                if falla {
                    let intentos = { let mut i = self.intentos.lock().unwrap(); let n = i.entry(change.op_id.clone()).or_insert(0); *n += 1; *n };
                    if intentos >= 5 {
                        self.cuarentena.lock().unwrap().push(change.op_id.clone());
                        *self.detenido.lock().unwrap() = None;
                        *self.cursor.lock().unwrap() = change.seq;
                        continue;
                    }
                    detenida = Some(CambioDetenido { op_id: change.op_id.clone(), seq: change.seq, intentos });
                    *self.detenido.lock().unwrap() = Some(change);
                    break;
                }
                *self.detenido.lock().unwrap() = None;
                *self.cursor.lock().unwrap() = change.seq;
                self.aplicados.lock().unwrap().push(change.seq);
                if !own { applied.push(change.op_id); }
            }
            Ok(BajadaAplicada { aplicadas:applied, last_seq:*self.cursor.lock().unwrap(), detenida })
        }
        async fn cambio_detenido(&self) -> AppResult<Option<SyncChange>> {
            Ok(self.detenido.lock().unwrap().clone())
        }
        async fn get_checkpoint(&self) -> AppResult<i64> {
            *self.checkpoints.lock().unwrap() += 1;
            Ok(*self.cursor.lock().unwrap())
        }
        async fn outbox_pending(&self, limit: i64) -> AppResult<Vec<OutboxEntry>> {
            self.limits.lock().unwrap().push(limit);
            let fuera = |id: &String| self.apartadas.lock().unwrap().contains(id);
            Ok(self.pending.lock().unwrap().iter().filter(|e| !fuera(&e.op_id)).take(limit as usize).cloned().collect())
        }
        async fn outbox_confirmar_lote(&self, confirmadas: &[(String, i64)]) -> AppResult<()> {
            self.confirmaciones.lock().unwrap().push(confirmadas.to_vec());
            self.pending.lock().unwrap().retain(|e| !confirmadas.iter().any(|(id, _)| *id == e.op_id));
            Ok(())
        }
        /// El mismo contrato que el real: repetible, aparta al rechazo permanente o a los 20 y
        /// encola la reparación, salvo de una reparación.
        async fn outbox_mark_failed(&self, id: &str, _: &str, permanente: bool) -> AppResult<OutboxFallo> {
            if self.apartadas.lock().unwrap().iter().any(|a| a == id) { return Ok(OutboxFallo::default()); }
            let Some(command_name) = self.pending.lock().unwrap().iter().find(|e| e.op_id == id).map(|e| e.command_name.clone()) else {
                return Ok(OutboxFallo::default());
            };
            let intentos = { let mut r = self.rechazos.lock().unwrap(); let n = r.entry(id.to_string()).or_insert(0); *n += 1; *n };
            let apartada = permanente || intentos >= 20;
            let mut reparadas = 0;
            if apartada {
                self.apartadas.lock().unwrap().push(id.to_string());
                if command_name != "main_reparacion" {
                    let mut reparacion = op(&format!("repara-{id}"));
                    reparacion.command_name = "main_reparacion".into();
                    self.pending.lock().unwrap().push(reparacion);
                    reparadas = 1;
                }
            }
            Ok(OutboxFallo { intentos, apartada, command_name, reparadas })
        }
        async fn contraste_marca(&self) -> AppResult<crate::ports::sync::MarcaLocal> {
            Ok(crate::ports::sync::MarcaLocal::default())
        }
        async fn contrastar_con_la_nube(
            &self,
            _: ResumenNube,
            _: crate::ports::sync::MarcaLocal,
            _: &dyn crate::ports::sync::PaginasDelContraste,
            _: bool,
        ) -> AppResult<crate::ports::sync::ContrasteLocal> {
            Ok(crate::ports::sync::ContrasteLocal::Hecho(ResultadoVerificacion::default()))
        }
        /// La de verdad pide las filas a la nube por clave: aquí se pide una cuando trae algo.
        async fn converger_con_la_nube(&self, nube: &dyn crate::ports::sync::PaginasDelContraste) -> AppResult<crate::ports::sync::Convergencia> {
            let por_subir = { let apartadas = self.apartadas.lock().unwrap(); self.pending.lock().unwrap().iter().filter(|e| !apartadas.contains(&e.op_id)).count() };
            self.al_converger.lock().unwrap().push(por_subir);
            let r = self.convergencias.lock().unwrap().pop_front().unwrap_or_default();
            if matches!(r, crate::ports::sync::Convergencia::Hecha { .. }) {
                nube.por_clave(crate::ports::sync::PedidoPorClave { tabla: "Reservas".into(), claves: vec![vec![json!("r1")]] }).await?;
            }
            Ok(r)
        }
        async fn purge_applied_ops(&self) -> AppResult<()> {
            Ok(())
        }
        async fn marcar_anterior_a_la_nube(&self) -> AppResult<()> {
            *self.anterior_a_la_nube.lock().unwrap() = true;
            Ok(())
        }
        async fn health(&self) -> AppResult<SyncHealth> {
            let apartadas = self.apartadas.lock().unwrap().len() as i64;
            Ok(SyncHealth {outbox_pending:self.pending.lock().unwrap().len() as i64 - apartadas,last_seq:*self.cursor.lock().unwrap(),quarantined:0,failing:0,subida_fallando:0,subida_en_cuarentena:apartadas,bajada_atascada:0})
        }
        async fn bootstrap_restaurar(
            &self,
            _: tpv_contracts::sync::BootstrapSnapshot,
            _: &str,
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
        async fn ultima_escritura_ms(&self, _: i64) -> AppResult<Option<i64>> {
            panic!("no usado")
        }
    }

struct Nube { responses:Mutex<VecDeque<Value>>, calls:Mutex<Vec<String>>, cuerpos:Mutex<Vec<JsonValue>> }
#[async_trait]
impl PairingService for Nube {
fn device_identity(&self) -> AppResult<DeviceIdentity> { panic!("Capacidad ajena a esta prueba") }
fn firmar_hello(&self, _mode: &str, _nonce_b64: &str) -> AppResult<FirmaDispositivo> { panic!("Capacidad ajena a esta prueba") }
fn firmar_emparejamiento(&self, _args: DeviceFirmarEmparejamientoArgs) -> AppResult<FirmaDispositivo> { panic!("Capacidad ajena a esta prueba") }
fn hora_para_firmar(&self) -> i64 { panic!("Capacidad ajena a esta prueba") }
fn handy_set_token(&self, _token: &str, _tenant_id: &str) -> AppResult<()> { panic!("Capacidad ajena a esta prueba") }
fn handy_clear_token(&self) -> AppResult<()> { panic!("Capacidad ajena a esta prueba") }
fn handy_get_tenant(&self) -> AppResult<Option<String>> { panic!("Capacidad ajena a esta prueba") }
fn negocio_de_la_licencia(&self) -> AppResult<Option<String>> {
    Ok(Some("negocio-de-prueba".into()))
}
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
        body: JsonValue,
    ) -> AppResult<JsonValue> {
            self.calls.lock().unwrap().push(path.to_string());
            self.cuerpos.lock().unwrap().push(body);
            self.responses.lock().unwrap().pop_front().ok_or_else(|| AppError::external("Respuesta no prevista"))
        }
async fn pair_create(&self) -> AppResult<PairCreateResult> { panic!("Capacidad ajena a esta prueba") }
async fn upload_image(
        &self,
        _mode: &str,
        _path: &str,
        _content_type: &str,
        _bytes: Vec<u8>,
        _negocio: &str,
    ) -> AppResult<crate::ports::licensing::ResultadoSubidaImagen> { panic!("Capacidad ajena a esta prueba") }
async fn delete_image(&self, _mode: &str, _path: &str) -> AppResult<()> { panic!("Capacidad ajena a esta prueba") }
async fn download_image(&self, _mode: &str, _rel_path: &str) -> AppResult<Option<Vec<u8>>> { panic!("Capacidad ajena a esta prueba") }
}
struct Contexto { repo: Arc<FakeRepo>, fases:Mutex<Vec<String>>, avisos:Mutex<usize>, completa:Mutex<Option<i64>>, recogidas:Mutex<usize>, sigue:Mutex<bool>, ritmo:Arc<RitmoDeSubida>, comprobaciones:Mutex<usize> }
#[async_trait]
impl ContextoReplicacion for Contexto {
    async fn repositorio(&self) -> AppResult<Arc<dyn SyncRepository>> { Ok(self.repo.clone()) }
    fn cambios(&self, _: &[SqlStatement]) { *self.avisos.lock().unwrap() += 1; }
    fn fase_recuperacion(&self, fase:&str) { self.fases.lock().unwrap().push(fase.into()); }
    fn solicitud_emparejamiento(&self) {}
    fn reservas_web(&self) { *self.recogidas.lock().unwrap() += 1; }
    fn fallo_subida(&self, _: &str, _: &OutboxFallo) {}
    async fn completar_recuperacion(&self, h:i64)->AppResult<()> { *self.completa.lock().unwrap()=Some(h);Ok(()) }
    async fn sigue_disponible(&self,_:bool)->AppResult<bool> { *self.comprobaciones.lock().unwrap()+=1; Ok(*self.sigue.lock().unwrap()) }
    fn ritmo_de_subida(&self)->Arc<RitmoDeSubida> { self.ritmo.clone() }
}
/// El acuse de un lote preparado sin `loteId` es el del último lote que ha salido: así los guiones
/// no dependen de cómo nombra la Main sus lotes.
fn con_su_lote(mut m:Value,enviados:&[Value])->Value {
    if m["type"]=="apply_lote_ack" && m.get("loteId").is_none() {
        if let Some(id)=enviados.iter().rev().find(|e|e["type"]=="apply_lote").map(|e|e["loteId"].clone()) { m["loteId"]=id; }
    }
    m
}
struct Canal { respuestas:VecDeque<Value>, enviados:Vec<Value> }
#[async_trait]
impl CanalReplicacion for Canal {
    async fn enviar(&mut self,m:Value)->AppResult<()> {self.enviados.push(m);Ok(())}
    async fn recibir(&mut self,_:Duration)->AppResult<Option<Value>> {
        let m=self.respuestas.pop_front().ok_or_else(||AppError::external("Sin conexión"))?;
        Ok(Some(con_su_lote(m,&self.enviados)))
    }
}
fn contexto(ops:Vec<OutboxEntry>)->Contexto {
    let repo=Arc::new(FakeRepo::default());*repo.pending.lock().unwrap()=ops;
    Contexto{repo,fases:Mutex::new(vec![]),avisos:Mutex::new(0),completa:Mutex::new(None),recogidas:Mutex::new(0),sigue:Mutex::new(false),ritmo:Arc::default(),comprobaciones:Mutex::new(0)}
}
fn op(id:&str)->OutboxEntry {OutboxEntry{seq:1,op_id:id.into(),command_name:"venta".into(),statements:vec![SqlStatement{sql:"INSERT INTO Productos (Nombre) VALUES (?1)".into(),args:vec![json!("Producto")]}]}}
fn nube(respuestas:Vec<Value>)->Nube {Nube{responses:Mutex::new(respuestas.into()),calls:Mutex::new(vec![]),cuerpos:Mutex::new(vec![])}}
fn pagina(items:Vec<Value>,high:i64)->Value {json!({"items":items,"nextSince":high,"highWater":high,"purgadoHasta":0})}
fn canal(respuestas:Vec<Value>)->Canal {Canal{respuestas:respuestas.into(),enviados:vec![]}}

// Lo que la nube dice de cada operación de un lote (`VeredictoDeLote`, en `tenantHub.types.ts`).
fn ok(op:&str,seq:i64)->Value {json!({"opId":op,"ok":true,"seq":seq})}
fn ya_estaba(op:&str,seq:i64)->Value {json!({"opId":op,"ok":true,"seq":seq,"yaEstaba":true})}
fn permanente(op:&str)->Value {json!({"opId":op,"ok":false,"error":"no such column: X","permanente":true,"transitorio":false})}
fn pasajera(op:&str)->Value {json!({"opId":op,"ok":false,"error":"database is locked","permanente":false,"transitorio":true})}
fn rara(op:&str)->Value {json!({"opId":op,"ok":false,"error":"algo que nadie ha visto","permanente":false,"transitorio":false})}
fn sin_intentar(op:&str)->Value {json!({"opId":op,"ok":false,"noIntentada":true})}
fn acuse(resultados:Vec<Value>)->Value {json!({"type":"apply_lote_ack","ok":true,"resultados":resultados})}
fn ids_del_lote(m:&Value)->Vec<String> {m["ops"].as_array().unwrap().iter().map(|o|o["opId"].as_str().unwrap().to_string()).collect()}
fn lotes(enviados:&[Value])->Vec<Vec<String>> {enviados.iter().filter(|m|m["type"]=="apply_lote").map(ids_del_lote).collect()}
fn pendientes(ctx:&Contexto)->Vec<String> {ctx.repo.pending.lock().unwrap().iter().map(|e|e.op_id.clone()).collect()}
fn confirmadas(ctx:&Contexto)->Vec<Vec<(String,i64)>> {ctx.repo.confirmaciones.lock().unwrap().clone()}
fn par(op:&str,seq:i64)->(String,i64) {(op.to_string(),seq)}

// ── La subida: un lote en vuelo, su acuse y el veredicto de cada operación ───

#[tokio::test]
async fn el_lote_lleva_las_operaciones_en_orden_y_su_acuse_las_confirma_en_una_transaccion() {
    let ctx=contexto(vec![op("a"),op("b"),op("c")]);
    // La segunda ya estaba: es el reenvío de un lote del que no llegó el acuse.
    let mut c=canal(vec![acuse(vec![ok("a",11),ya_estaba("b",7),ok("c",12)])]);
    assert!(subir_pendientes(&ctx,&mut c,&mut Sesion::default(),false).await.unwrap());
    assert_eq!(c.enviados.len(),1);
    assert_eq!(c.enviados[0]["type"],"apply_lote");
    assert!(c.enviados[0]["loteId"].as_str().is_some_and(|id|!id.is_empty()));
    assert_eq!(ids_del_lote(&c.enviados[0]),["a","b","c"]);
    // Cada operación viaja con su comando y su identidad.
    assert_eq!(c.enviados[0]["ops"][0],operacion(&op("a")));
    assert_eq!(confirmadas(&ctx),vec![vec![par("a",11),par("b",7),par("c",12)]]);
    assert!(pendientes(&ctx).is_empty());
    assert_eq!(*ctx.repo.limits.lock().unwrap(),vec![LOTE_MAX_OPS as i64,LOTE_MAX_OPS as i64]);
}
#[tokio::test]
async fn solo_el_acuse_de_su_lote_lo_confirma() {
    let ctx=contexto(vec![op("a")]);let mut c=canal(vec![json!({"type":"apply_lote_ack","loteId":"de-otro-lote","ok":true,"resultados":[ok("a",1)]})]);
    assert!(subir_pendientes(&ctx,&mut c,&mut Sesion::default(),false).await.is_err());
    assert_eq!(pendientes(&ctx),["a"]);assert!(confirmadas(&ctx).is_empty());
}
#[tokio::test]
async fn un_corte_sin_acuse_conserva_las_operaciones_y_no_les_cuenta_nada() {
    let ctx=contexto(vec![op("a"),op("b")]);let mut c=canal(vec![]);
    assert!(subir_pendientes(&ctx,&mut c,&mut Sesion::default(),false).await.is_err());
    assert_eq!(pendientes(&ctx),["a","b"]);
    assert!(ctx.repo.rechazos.lock().unwrap().is_empty(),"el transporte no cuenta como intento");
}
#[tokio::test]
async fn dos_lotes_sin_respuesta_y_el_siguiente_va_de_una_en_una() {
    let ctx=contexto(vec![op("a"),op("b"),op("c")]);
    // Dos sesiones que se caen esperando el acuse: puede ser un lote que la nube no consigue atender.
    for _ in 0..2 {
        let mut c=canal(vec![]);
        assert!(subir_pendientes(&ctx,&mut c,&mut Sesion::default(),false).await.is_err());
        assert_eq!(lotes(&c.enviados),vec![vec!["a","b","c"]]);
    }
    assert!(ctx.repo.rechazos.lock().unwrap().is_empty());
    // La tercera manda la primera sola. Contestada, el siguiente lote lleva el doble.
    let mut c=canal(vec![acuse(vec![ok("a",1)]),acuse(vec![ok("b",2),ok("c",3)])]);
    assert!(subir_pendientes(&ctx,&mut c,&mut Sesion::default(),false).await.unwrap());
    assert_eq!(lotes(&c.enviados),vec![vec!["a"],vec!["b","c"]]);
    assert_eq!(*ctx.repo.limits.lock().unwrap(),vec![200,200,1,2,4]);
}
#[tokio::test]
async fn un_lote_lleva_256_kb_de_sentencias_como_mucho_y_una_operacion_mayor_va_sola() {
    let gorda=|id:&str,kb:usize|{let mut o=op(id);o.statements[0].args=vec![json!("x".repeat(kb*1024))];o};
    let ctx=contexto(vec![gorda("a",100),gorda("b",100),gorda("c",100),gorda("d",300),op("e")]);
    let mut c=canal(vec![acuse(vec![ok("a",1),ok("b",2)]),acuse(vec![ok("c",3)]),acuse(vec![ok("d",4)]),acuse(vec![ok("e",5)])]);
    assert!(subir_pendientes(&ctx,&mut c,&mut Sesion::default(),false).await.unwrap());
    assert_eq!(lotes(&c.enviados),vec![vec!["a","b"],vec!["c"],vec!["d"],vec!["e"]]);
}
#[tokio::test]
async fn se_aplica_lo_vivo_mientras_se_espera_el_acuse() {
    let ctx=contexto(vec![op("a")]);let mut c=canal(vec![json!({"type":"change","opId":"remota","seq":2,"statements":[{"sql":"UPDATE Productos SET Nombre=?1","args":["Otro"]}]}),acuse(vec![ok("a",3)])]);
    assert!(subir_pendientes(&ctx,&mut c,&mut Sesion::default(),false).await.unwrap());
    assert!(pendientes(&ctx).is_empty());assert_eq!(*ctx.avisos.lock().unwrap(),1);
}
#[tokio::test]
async fn lo_que_la_nube_no_intento_sale_en_el_lote_siguiente_sin_contarle_nada() {
    // El trabajo de un turno tiene tope en la nube: lo que no cabe vuelve tal cual.
    let ctx=contexto(vec![op("a"),op("b"),op("c")]);
    let mut c=canal(vec![acuse(vec![ok("a",1),sin_intentar("b"),sin_intentar("c")]),acuse(vec![ok("b",2),ok("c",3)])]);
    assert!(subir_pendientes(&ctx,&mut c,&mut Sesion::default(),false).await.unwrap());
    assert_eq!(lotes(&c.enviados),vec![vec!["a","b","c"],vec!["b","c"]]);
    assert_eq!(confirmadas(&ctx),vec![vec![par("a",1)],vec![par("b",2),par("c",3)]]);
    assert!(ctx.repo.rechazos.lock().unwrap().is_empty());
}
#[tokio::test]
async fn un_acuse_que_no_dice_nada_de_una_operacion_la_deja_como_sin_intentar() {
    let ctx=contexto(vec![op("a"),op("b")]);
    let mut c=canal(vec![acuse(vec![ok("a",1)]),acuse(vec![ok("b",2)])]);
    assert!(subir_pendientes(&ctx,&mut c,&mut Sesion::default(),false).await.unwrap());
    assert_eq!(lotes(&c.enviados),vec![vec!["a","b"],vec!["b"]]);
}
#[tokio::test]
async fn un_lote_que_no_mueve_nada_no_se_repite_en_caliente() {
    let ctx=contexto(vec![op("a")]);let mut c=canal(vec![acuse(vec![sin_intentar("a")])]);
    assert!(!subir_pendientes(&ctx,&mut c,&mut Sesion::default(),false).await.unwrap());
    assert_eq!(c.enviados.len(),1);assert_eq!(pendientes(&ctx),["a"]);
}
#[tokio::test]
async fn un_rechazo_pasajero_para_la_subida_sin_gastar_intentos() {
    let ctx=contexto(vec![op("a"),op("b"),op("c")]);
    let mut c=canal(vec![acuse(vec![ok("a",1),pasajera("b"),sin_intentar("c")])]);
    assert!(!subir_pendientes(&ctx,&mut c,&mut Sesion::default(),false).await.unwrap());
    assert_eq!(confirmadas(&ctx),vec![vec![par("a",1)]]);
    assert_eq!(pendientes(&ctx),["b","c"]);
    assert!(ctx.repo.rechazos.lock().unwrap().is_empty());
}
#[tokio::test]
async fn un_rechazo_permanente_se_aparta_se_repara_y_la_subida_sigue() {
    // La nube ha seguido aplicando lo de detrás: «c» entra en el mismo lote.
    let ctx=contexto(vec![op("a"),op("b"),op("c")]);
    let mut c=canal(vec![acuse(vec![ok("a",1),permanente("b"),ok("c",2)]),acuse(vec![ok("repara-b",3)])]);
    assert!(subir_pendientes(&ctx,&mut c,&mut Sesion::default(),false).await.unwrap());
    assert_eq!(lotes(&c.enviados),vec![vec!["a","b","c"],vec!["repara-b"]]);
    assert_eq!(confirmadas(&ctx),vec![vec![par("a",1),par("c",2)],vec![par("repara-b",3)]]);
    assert_eq!(*ctx.repo.apartadas.lock().unwrap(),vec!["b".to_string()]);
    // La apartada sigue en el outbox, fuera de lo pendiente: es lo que queda de ella.
    assert_eq!(pendientes(&ctx),["b"]);
}
#[tokio::test]
async fn un_rechazo_sin_clasificar_cuenta_un_intento_y_para_la_subida() {
    let ctx=contexto(vec![op("a"),op("b"),op("c")]);
    let mut c=canal(vec![acuse(vec![ok("a",1),rara("b"),sin_intentar("c")])]);
    assert!(!subir_pendientes(&ctx,&mut c,&mut Sesion::default(),false).await.unwrap());
    assert_eq!(ctx.repo.rechazos.lock().unwrap().get("b"),Some(&1));
    assert_eq!(pendientes(&ctx),["b","c"]);
    assert!(ctx.repo.apartadas.lock().unwrap().is_empty());
}
#[tokio::test]
async fn al_vigesimo_rechazo_se_aparta_y_la_subida_sigue_con_lo_de_detras() {
    let ctx=contexto(vec![op("b"),op("c")]);ctx.repo.rechazos.lock().unwrap().insert("b".into(),19);
    let mut c=canal(vec![acuse(vec![rara("b"),sin_intentar("c")]),acuse(vec![ok("c",1),ok("repara-b",2)])]);
    assert!(subir_pendientes(&ctx,&mut c,&mut Sesion::default(),false).await.unwrap());
    assert_eq!(*ctx.repo.apartadas.lock().unwrap(),vec!["b".to_string()]);
    assert_eq!(lotes(&c.enviados),vec![vec!["b","c"],vec!["c","repara-b"]]);
}
#[tokio::test]
async fn en_la_recuperacion_un_rechazo_es_un_error_y_lo_aplicado_antes_queda_confirmado() {
    let ctx=contexto(vec![op("a"),op("b"),op("c")]);
    let mut c=canal(vec![acuse(vec![ok("a",1),permanente("b"),ok("c",3)])]);
    let e=subir_pendientes(&ctx,&mut c,&mut Sesion::default(),true).await.unwrap_err();
    assert!(e.to_string().contains("rechazó la operación b"),"{e}");
    assert_eq!(confirmadas(&ctx),vec![vec![par("a",1)]]);
    assert!(ctx.repo.apartadas.lock().unwrap().is_empty()&&ctx.repo.rechazos.lock().unwrap().is_empty());
    // Y lo que no se llegó a intentar no lo es: se sigue subiendo.
    let ctx=contexto(vec![op("a"),op("b")]);
    let mut c=canal(vec![acuse(vec![ok("a",1),sin_intentar("b")]),acuse(vec![ok("b",2)])]);
    assert!(subir_pendientes(&ctx,&mut c,&mut Sesion::default(),true).await.unwrap());
}
#[tokio::test]
async fn un_lote_rechazado_entero_por_como_esta_la_nube_no_le_cuenta_nada_a_nadie() {
    let ctx=contexto(vec![op("a"),op("b")]);
    let mut c=canal(vec![json!({"type":"apply_lote_ack","ok":false,"error":"not_authenticated","transitorio":true})]);
    assert!(!subir_pendientes(&ctx,&mut c,&mut Sesion::default(),false).await.unwrap());
    assert_eq!(pendientes(&ctx),["a","b"]);
    assert!(ctx.repo.rechazos.lock().unwrap().is_empty());
    assert_eq!(ctx.ritmo.tamano_del_lote(),LOTE_MAX_OPS);
    // En la recuperación, un lote rechazado es un error.
    let mut c=canal(vec![json!({"type":"apply_lote_ack","ok":false,"error":"not_authenticated","transitorio":true})]);
    assert!(subir_pendientes(&ctx,&mut c,&mut Sesion::default(),true).await.is_err());
}
#[tokio::test]
async fn un_lote_rechazado_entero_sin_decir_por_cual_se_repite_de_una_en_una_y_a_la_que_va_sola_se_le_cuenta() {
    let ctx=contexto(vec![op("a"),op("b")]);
    let rechazo=||json!({"type":"apply_lote_ack","ok":false,"error":"missing_apply_fields"});
    let mut c=canal(vec![rechazo()]);
    assert!(!subir_pendientes(&ctx,&mut c,&mut Sesion::default(),false).await.unwrap());
    assert!(ctx.repo.rechazos.lock().unwrap().is_empty(),"con dos en el lote no se sabe de cuál es");
    let mut c=canal(vec![rechazo()]);
    assert!(!subir_pendientes(&ctx,&mut c,&mut Sesion::default(),false).await.unwrap());
    assert_eq!(lotes(&c.enviados),vec![vec!["a"]]);
    assert_eq!(ctx.repo.rechazos.lock().unwrap().get("a"),Some(&1));
}
#[tokio::test]
async fn una_operacion_que_no_cabe_en_un_mensaje_se_aparta_y_se_repara() {
    let ctx=contexto(vec![op("a"),op("b")]);ctx.ritmo.de_una_en_una();
    let mut c=canal(vec![json!({"type":"error","error":"payload_too_large"}),acuse(vec![ok("b",1)]),acuse(vec![ok("repara-a",2)])]);
    assert!(subir_pendientes(&ctx,&mut c,&mut Sesion::default(),false).await.unwrap());
    assert_eq!(*ctx.repo.apartadas.lock().unwrap(),vec!["a".to_string()]);
    assert_eq!(lotes(&c.enviados),vec![vec!["a"],vec!["b"],vec!["repara-a"]]);
}
#[tokio::test]
async fn un_error_suelto_que_no_responde_al_lote_no_lo_confirma_ni_le_cuenta_nada() {
    // La nube sube por `apply_lote` y sólo por ahí: un `unknown_type` (u otro error suelto) no es el
    // acuse del lote. Sin acuse es el transporte: la sesión acaba sin confirmar ni contar nada, y lo
    // que vuelve a salir es el mismo lote.
    let ctx=contexto(vec![op("a"),op("b")]);
    let mut c=canal(vec![json!({"type":"error","error":"unknown_type"})]);
    assert!(subir_pendientes(&ctx,&mut c,&mut Sesion::default(),false).await.is_err());
    assert_eq!(c.enviados.iter().map(|m|m["type"].as_str().unwrap()).collect::<Vec<_>>(),["apply_lote"]);
    assert_eq!(pendientes(&ctx),["a","b"]);
    assert!(confirmadas(&ctx).is_empty()&&ctx.repo.rechazos.lock().unwrap().is_empty());
}
#[tokio::test]
async fn un_eco_confirmado_no_refresca_la_interfaz() {
    let ctx=contexto(vec![op("a")]);
    aplicar(&ctx,vec![SyncChange{op_id:"a".into(),seq:1,statements:op("a").statements}]).await.unwrap();
    assert_eq!(*ctx.avisos.lock().unwrap(),0);assert!(pendientes(&ctx).is_empty());
}
#[tokio::test]
async fn recuperar_descarga_sube_y_verifica_antes_de_desbloquear() {
    let ctx=contexto(vec![op("a")]);let n=nube(vec![pagina(vec![],0),pagina(vec![],0)]);let mut c=canal(vec![acuse(vec![ok("a",1)])]);
    ejecutar(&ctx,&n,&mut c,true).await.unwrap();
    assert_eq!(ctx.fases.lock().unwrap().as_slice(),["descargando","subiendo","verificando","completada"]);
    assert_eq!(*ctx.completa.lock().unwrap(),Some(0));assert_eq!(c.enviados.last().unwrap()["type"],"recovery_ready");
}
#[tokio::test]
async fn sin_high_water_la_recuperacion_falla_cerrada() {
    let ctx=contexto(vec![]);let n=nube(vec![json!({"items":[],"nextSince":0})]);let mut c=canal(vec![]);
    assert!(ejecutar(&ctx,&n,&mut c,true).await.is_err());assert!(ctx.completa.lock().unwrap().is_none());
}
// Reservas desde la web (docs/estudios/reservas-web.md §5.4): cuándo pide el motor que se recojan.
#[tokio::test]
async fn al_conectar_se_recogen_las_reservas_web() {
    let ctx=contexto(vec![]);let n=nube(vec![pagina(vec![],0)]);let mut c=canal(vec![]);
    ejecutar(&ctx,&n,&mut c,false).await.unwrap();
    assert_eq!(*ctx.recogidas.lock().unwrap(),1);
}
#[tokio::test]
async fn al_terminar_una_recuperacion_se_recogen_las_reservas_web() {
    let ctx=contexto(vec![]);let n=nube(vec![pagina(vec![],0),pagina(vec![],0)]);let mut c=canal(vec![]);
    ejecutar(&ctx,&n,&mut c,true).await.unwrap();
    assert_eq!(*ctx.recogidas.lock().unwrap(),1);
}
#[tokio::test]
async fn el_aviso_de_la_agenda_pide_recogerlas_aunque_llegue_esperando_una_confirmacion() {
    let ctx=contexto(vec![op("a")]);let mut c=canal(vec![json!({"type":"reservas_web"}),acuse(vec![ok("a",3)])]);
    assert!(subir_pendientes(&ctx,&mut c,&mut Sesion::default(),false).await.unwrap());
    assert_eq!(*ctx.recogidas.lock().unwrap(),1);
}

// ── AUD-18 · la bajada estrictamente en orden ────────────────────────────────

/// Un socket que entrega lo preparado en orden; `None` es una espera que vence. Apunta cuánto le
/// piden esperar en cada `recibir`, y agotado se cierra (que es como el motor ve una caída).
struct Socket { entrantes:VecDeque<Option<Value>>, esperas:Vec<Duration>, enviados:Vec<Value> }
#[async_trait]
impl CanalReplicacion for Socket {
    async fn enviar(&mut self,m:Value)->AppResult<()> {self.enviados.push(m);Ok(())}
    async fn recibir(&mut self,espera:Duration)->AppResult<Option<Value>> {
        self.esperas.push(espera);
        self.entrantes.pop_front().ok_or_else(||AppError::external("Socket cerrado"))
    }
}
fn socket(entrantes:Vec<Option<Value>>)->Socket {Socket{entrantes:entrantes.into(),esperas:vec![],enviados:vec![]}}
fn item(op:&str,seq:i64)->Value {json!({"opId":op,"seq":seq,"statements":[{"sql":"UPDATE Zonas SET Nombre_Zona=?1","args":[op]}]})}
fn vivo(op:&str,seq:i64)->Value {let mut m=item(op,seq);m["type"]=json!("change");m}
fn pagina_hasta(items:Vec<Value>,next:i64,high:i64)->Value {json!({"items":items,"nextSince":next,"highWater":high,"purgadoHasta":0})}
fn since_pedidos(n:&Nube)->Vec<i64> {
    let cuerpos=n.cuerpos.lock().unwrap();
    // Cada página pide lo que admite el worker: sin `limit` daba 500.
    assert!(cuerpos.iter().all(|c|c["limit"].as_i64()==Some(CAMBIOS_POR_PAGINA)),"cada página pide {CAMBIOS_POR_PAGINA}: {cuerpos:?}");
    cuerpos.iter().map(|c|c["since"].as_i64().unwrap()).collect()
}

#[tokio::test]
async fn el_catch_up_no_pide_la_pagina_siguiente_si_el_checkpoint_no_llego_al_final() {
    let ctx=contexto(vec![]);ctx.repo.fallos.lock().unwrap().insert("op-2".into(),1);
    let n=nube(vec![pagina_hasta(vec![item("op-1",1),item("op-2",2),item("op-3",3)],3,5)]);
    let r=catch_up(&ctx,&n,false).await.unwrap();
    assert_eq!(r.detenida.map(|d|(d.op_id,d.seq,d.intentos)),Some(("op-2".to_string(),2,1)));
    assert_eq!(since_pedidos(&n),vec![0],"no se pide la página siguiente");
    assert_eq!(*ctx.repo.cursor.lock().unwrap(),1,"el checkpoint no pasa por encima del que falla");
    assert_eq!(*ctx.repo.aplicados.lock().unwrap(),vec![1],"ni se aplica lo de detrás");

    // La pasada siguiente empieza por el detenido (con lo que se guardó al fallar) y sigue desde él.
    n.responses.lock().unwrap().extend([pagina_hasta(vec![item("op-3",3),item("op-4",4),item("op-5",5)],5,5),pagina(vec![],5)]);
    let r=catch_up(&ctx,&n,false).await.unwrap();
    assert_eq!((r.high_water,r.detenida),(5,None));
    assert_eq!(since_pedidos(&n),vec![0,2,5]);
    assert_eq!(*ctx.repo.aplicados.lock().unwrap(),vec![1,2,3,4,5],"todo, y en orden de Seq");
}

#[tokio::test]
async fn un_cambio_que_no_entra_se_reintenta_con_esperas_cortas_y_pasa_a_cuarentena() {
    let ctx=contexto(vec![]);ctx.repo.fallos.lock().unwrap().insert("op-2".into(),99);
    let n=nube(vec![pagina_hasta(vec![item("op-1",1),item("op-2",2),item("op-3",3)],3,3),pagina_hasta(vec![item("op-3",3)],3,3),pagina(vec![],3)]);
    let mut s=socket(vec![None,None,None,None]);
    ejecutar(&ctx,&n,&mut s,false).await.unwrap();
    // Cinco intentos en la sesión, con 1, 2, 4 y 8 s de espera entre ellos, y a la cuarentena.
    let esperas=s.esperas.iter().map(|d|d.as_secs_f64().round() as u64).collect::<Vec<_>>();
    assert_eq!(esperas,vec![1,2,4,8]);
    assert_eq!(*ctx.repo.cuarentena.lock().unwrap(),vec!["op-2".to_string()]);
    // El checkpoint pasa por encima del apartado y la bajada sigue en orden desde ahí.
    assert_eq!(since_pedidos(&n),vec![0,2,3]);
    assert_eq!(*ctx.repo.aplicados.lock().unwrap(),vec![1,3]);
    assert_eq!(*ctx.repo.cursor.lock().unwrap(),3);
}

#[tokio::test]
async fn un_cambio_en_vivo_que_falla_detiene_la_bajada_y_lo_de_detras_llega_por_el_catch_up() {
    let ctx=contexto(vec![]);*ctx.sigue.lock().unwrap()=true;*ctx.repo.cursor.lock().unwrap()=9;
    ctx.repo.fallos.lock().unwrap().insert("op-10".into(),1);
    let n=nube(vec![pagina(vec![],9),pagina_hasta(vec![item("op-11",11),item("op-12",12)],12,12),pagina(vec![],12)]);
    // Llegan el 10 (que falla), el 11 y el 12 mientras se espera para reintentarlo, y vence la espera.
    let mut s=socket(vec![Some(vivo("op-10",10)),Some(vivo("op-11",11)),Some(vivo("op-12",12)),None]);
    assert!(ejecutar(&ctx,&n,&mut s,false).await.is_err(),"acaba al cerrarse el socket");

    // Lo que llegó en vivo con la bajada detenida no se aplicó: ni siquiera se le pidió al
    // repositorio. Se reintentó el 10 tras su espera y el resto vino por el catch-up desde él.
    assert_eq!(*ctx.repo.llamadas.lock().unwrap(),vec![vec![10],vec![10],vec![11,12]]);
    assert_eq!(*ctx.repo.aplicados.lock().unwrap(),vec![10,11,12]);
    assert_eq!(since_pedidos(&n),vec![9,10,12]);
    assert!(s.esperas[1]<=Duration::from_secs(1)&&s.esperas[1]>Duration::from_millis(500),"{:?}",s.esperas);
    assert!(ctx.repo.cuarentena.lock().unwrap().is_empty());
}
#[tokio::test]
async fn con_la_bajada_detenida_el_socket_se_sigue_atendiendo() {
    // Mientras se espera para reintentar, lo que no es un cambio se atiende como siempre: aquí, el
    // aviso de que la agenda de la web tiene algo que recoger.
    let ctx=contexto(vec![]);ctx.repo.fallos.lock().unwrap().insert("op-1".into(),1);
    let n=nube(vec![pagina_hasta(vec![item("op-1",1)],1,1),pagina_hasta(vec![item("op-2",2)],2,2),pagina(vec![],2)]);
    let mut s=socket(vec![Some(json!({"type":"reservas_web"})),Some(vivo("op-2",2)),None]);
    ejecutar(&ctx,&n,&mut s,false).await.unwrap();
    // La recogida del aviso, y la de después de conectar.
    assert_eq!(*ctx.recogidas.lock().unwrap(),2);
    // El 2 que llegó en vivo no se aplicó entonces: vino después, por el catch-up.
    assert_eq!(*ctx.repo.llamadas.lock().unwrap(),vec![vec![1],vec![1],vec![2]]);
    assert_eq!(*ctx.repo.aplicados.lock().unwrap(),vec![1,2]);
}

// ── AUD-15 · la Main congela a las Handy hasta ponerse al día ───────────────

fn firma(_:&str)->AppResult<FirmaDispositivo> {Ok(FirmaDispositivo{ts:10,sig_b64:"firma".into()})}
/// Lo último que manda el DO al saludar: si hay Main y si las Handy esperan.
fn estado()->Option<Value> {Some(json!({"type":"main_status","online":true,"volcando":true}))}
fn disponible(ctx:Contexto)->Contexto {*ctx.sigue.lock().unwrap()=true;ctx}

/// Un socket que apunta en orden lo que sale («>») y lo que entra («<»). `None` es una espera que
/// vence, y agotado se cierra. Puede dejar una venta en el outbox al mandar el saludo: la que se
/// confirma mientras la Main se autentica.
struct Conversacion { entrantes:VecDeque<Option<Value>>, log:Vec<String>, enviados:Vec<Value>, al_saludar:Option<(Arc<FakeRepo>,OutboxEntry)> }
#[async_trait]
impl CanalReplicacion for Conversacion {
    async fn enviar(&mut self,m:Value)->AppResult<()> {
        if m["type"]=="helloSigned" { if let Some((repo,venta))=self.al_saludar.take() { repo.pending.lock().unwrap().push(venta); } }
        self.log.push(format!(">{}",m["type"].as_str().unwrap_or("?")));
        self.enviados.push(m);
        Ok(())
    }
    async fn recibir(&mut self,_:Duration)->AppResult<Option<Value>> {
        let m=self.entrantes.pop_front().ok_or_else(||AppError::external("Socket cerrado"))?;
        if let Some(m)=&m { self.log.push(format!("<{}",m["type"].as_str().unwrap_or("?"))); }
        Ok(m.map(|m|con_su_lote(m,&self.enviados)))
    }
}
fn conversacion(entrantes:Vec<Option<Value>>)->Conversacion {Conversacion{entrantes:entrantes.into(),log:vec![],enviados:vec![],al_saludar:None}}

#[tokio::test]
async fn toda_sesion_de_la_main_saluda_congelando_a_las_handy() {
    let mut c=conversacion(vec![Some(json!({"type":"challenge","nonceB64":"reto"})),Some(json!({"type":"hello_ok","role":"tpv","authed":true}))]);
    saludar(&mut c,firma).await.unwrap();
    assert_eq!((c.enviados[0]["type"].as_str(),c.enviados[0]["recovering"].as_bool()),(Some("helloSigned"),Some(true)));
}

#[tokio::test]
async fn una_venta_confirmada_durante_el_saludo_sube_antes_de_soltarlas() {
    // El outbox estaba vacío al conectar; la venta entra después, antes de `hello_ok`.
    let ctx=disponible(contexto(vec![]));
    let mut c=conversacion(vec![Some(json!({"type":"challenge","nonceB64":"reto"})),Some(json!({"type":"hello_ok","role":"tpv","authed":true})),estado(),Some(acuse(vec![ok("venta",1)]))]);
    c.al_saludar=Some((ctx.repo.clone(),op("venta")));
    saludar(&mut c,firma).await.unwrap();
    let n=nube(vec![pagina(vec![],0)]);
    assert!(ejecutar(&ctx,&n,&mut c,false).await.is_err(),"acaba al cerrarse el socket");
    assert_eq!(c.log,["<challenge",">helloSigned","<hello_ok",">apply_lote","<main_status","<apply_lote_ack",">recovery_ready"]);
    assert_eq!(c.enviados[0]["recovering"],true);
    assert!(pendientes(&ctx).is_empty());
}

#[tokio::test]
async fn el_atraso_sube_en_lotes_de_doscientas_y_al_vaciarse_suelta_a_las_handy() {
    // Un día sin conexión: 450 operaciones. Un lote en vuelo cada vez, y el siguiente no sale hasta
    // que el anterior tiene su acuse.
    let ctx=contexto((0..450).map(|i|op(&i.to_string())).collect());
    let n=nube(vec![pagina(vec![],0)]);
    let lote=|desde:i64,hasta:i64|Some(acuse((desde..hasta).map(|i|ok(&i.to_string(),i+1)).collect()));
    let mut c=conversacion(vec![estado(),lote(0,200),lote(200,400),lote(400,450)]);
    ejecutar(&ctx,&n,&mut c,false).await.unwrap();
    assert_eq!(c.log,[">apply_lote","<main_status","<apply_lote_ack",">apply_lote","<apply_lote_ack",">apply_lote","<apply_lote_ack",">recovery_ready"]);
    assert_eq!(lotes(&c.enviados).iter().map(Vec::len).collect::<Vec<_>>(),vec![200,200,50]);
    assert_eq!(confirmadas(&ctx).iter().map(Vec::len).collect::<Vec<_>>(),vec![200,200,50],"una transacción por lote");
    assert!(pendientes(&ctx).is_empty());
}

#[tokio::test]
async fn no_las_suelta_hasta_que_el_atraso_ha_subido_entero() {
    let ctx=disponible(contexto(vec![op("a")]));
    let n=nube(vec![pagina(vec![],0)]);
    // La nube no la acepta a la primera (un fallo pasajero) y sí en la vuelta siguiente.
    let mut c=conversacion(vec![
        estado(),
        Some(acuse(vec![pasajera("a")])),
        Some(json!({"type":"despertar"})),
        Some(acuse(vec![ok("a",1)])),
    ]);
    assert!(ejecutar(&ctx,&n,&mut c,false).await.is_err(),"acaba al cerrarse el socket");
    assert_eq!(c.log,[">apply_lote","<main_status","<apply_lote_ack","<despertar",">apply_lote","<apply_lote_ack",">recovery_ready"]);
}

#[tokio::test]
async fn sin_atraso_las_suelta_al_conectar() {
    // También limpia el congelado que dejara una sesión anterior cortada a medias.
    let ctx=disponible(contexto(vec![]));let n=nube(vec![pagina(vec![],0)]);
    let mut c=conversacion(vec![estado()]);
    assert!(ejecutar(&ctx,&n,&mut c,false).await.is_err());
    assert_eq!(c.log,[">recovery_ready","<main_status"]);
}

// ── Si sigue disponible se mira con un reloj, no con cada mensaje ───────────

#[tokio::test]
async fn con_el_socket_ocupado_no_se_relee_la_disponibilidad_en_cada_mensaje() {
    // Leer `device_config.json` y el estado de la recuperación en cada mensaje es lo que hacía
    // antes: con las Handy trabajando, varias veces por segundo.
    let ctx=disponible(contexto(vec![]));let n=nube(vec![pagina(vec![],0)]);
    let mut entrantes=vec![estado()];
    entrantes.extend((0..50).map(|_|Some(json!({"type":"main_online"}))));
    let mut c=conversacion(entrantes);
    assert!(ejecutar(&ctx,&n,&mut c,false).await.is_err(),"acaba al cerrarse el socket");
    assert_eq!(*ctx.comprobaciones.lock().unwrap(),1,"una al empezar y ninguna más dentro del plazo");
}

/// Un socket que, al entregar el `despertar`, deja el equipo como no disponible: es lo que pasa al
/// cambiar el modo o la palanca con la sesión abierta.
struct ApagaAlDespertar<'a> { entrantes:VecDeque<Option<Value>>, sigue:&'a Mutex<bool> }
#[async_trait]
impl CanalReplicacion for ApagaAlDespertar<'_> {
    async fn enviar(&mut self,_:Value)->AppResult<()> {Ok(())}
    async fn recibir(&mut self,_:Duration)->AppResult<Option<Value>> {
        let m=self.entrantes.pop_front().ok_or_else(||AppError::external("Socket cerrado"))?;
        if m.as_ref().is_some_and(|m|m["type"]=="despertar") { *self.sigue.lock().unwrap()=false; }
        Ok(m)
    }
}

#[tokio::test]
async fn un_despertar_la_mira_en_el_momento_y_si_ya_no_esta_disponible_acaba_ahi() {
    // No se espera al plazo para enterarse: la sesión acaba en el mensaje siguiente.
    let ctx=disponible(contexto(vec![]));let n=nube(vec![pagina(vec![],0)]);
    let entrantes=vec![estado(),Some(json!({"type":"main_online"})),Some(json!({"type":"despertar"})),Some(json!({"type":"main_online"}))];
    let mut c=ApagaAlDespertar{entrantes:entrantes.into(),sigue:&ctx.sigue};
    assert_eq!(ejecutar(&ctx,&n,&mut c,false).await.unwrap(),FinDeSesion::NoDisponible);
    assert_eq!(*ctx.comprobaciones.lock().unwrap(),2,"la de empezar y la del despertar");
    assert_eq!(c.entrantes.len(),1,"no se queda escuchando hasta que venza el plazo");
}

#[tokio::test]
async fn un_lote_con_una_apartada_no_las_suelta_hasta_subir_su_reparacion() {
    let ctx=disponible(contexto(vec![op("a"),op("b"),op("c")]));
    let n=nube(vec![pagina(vec![],0)]);
    let mut c=conversacion(vec![Some(acuse(vec![ok("a",1),permanente("b"),ok("c",2)])),Some(acuse(vec![ok("repara-b",3)]))]);
    assert!(ejecutar(&ctx,&n,&mut c,false).await.is_err());
    assert_eq!(c.log,[">apply_lote","<apply_lote_ack",">apply_lote","<apply_lote_ack",">recovery_ready"]);
    assert_eq!(lotes(&c.enviados)[1],["repara-b"]);
}

#[tokio::test]
/// Decisión del responsable, no un descuido: una operación que ni su reparación consigue subir no
/// congela a las Handy para siempre, que sería bloquear al personal por algo que no va a cambiar.
/// Se sueltan con lo apartado en cuarentena y su aviso, y lo repara el contraste diario.
async fn una_reparacion_irreparable_suelta_a_las_handy_para_no_bloquear_al_personal() {
    let ctx=disponible(contexto(vec![op("a")]));
    let n=nube(vec![pagina(vec![],0)]);
    let mut c=conversacion(vec![Some(acuse(vec![permanente("a")])),Some(acuse(vec![permanente("repara-a")]))]);
    assert!(ejecutar(&ctx,&n,&mut c,false).await.is_err());
    assert_eq!(c.log,[">apply_lote","<apply_lote_ack",">apply_lote","<apply_lote_ack",">recovery_ready"]);
    // Las dos quedan en cuarentena, con su rastro: ni se borran ni se reintentan.
    assert_eq!(*ctx.repo.apartadas.lock().unwrap(),vec!["a".to_string(),"repara-a".to_string()]);
    assert_eq!(pendientes(&ctx).len(),2);
}

#[tokio::test]
async fn en_la_recuperacion_las_suelta_su_desbloqueo_una_sola_vez() {
    let ctx=contexto(vec![]);let n=nube(vec![pagina(vec![],0),pagina(vec![],0)]);let mut c=canal(vec![]);
    ejecutar(&ctx,&n,&mut c,true).await.unwrap();
    assert_eq!(c.enviados,vec![json!({"type":"recovery_ready"})]);
    assert_eq!(*ctx.completa.lock().unwrap(),Some(0));
}

// ── AUD-19 · un cursor por debajo de lo que la nube ya purgó ────────────────

/// Lo que devuelve la nube a un cursor en 10 cuando ya purgó hasta el 700 (`test/huecoDelLog`).
fn purgado_hasta_700()->Value {json!({"ok":true,"items":[item("op-701",701),item("op-1700",1700)],"nextSince":1700,"highWater":1700,"purgadoHasta":700})}

#[tokio::test]
async fn una_copia_anterior_a_lo_purgado_no_se_da_por_reconciliada() {
    let ctx=contexto(vec![op("de-la-copia")]);*ctx.repo.cursor.lock().unwrap()=10;
    let n=nube(vec![purgado_hasta_700()]);let mut c=canal(vec![]);
    let e=ejecutar(&ctx,&n,&mut c,true).await.unwrap_err();
    assert_eq!(e.to_string(),"Esta copia es anterior a lo que guarda la nube: recupera el estado actual de la nube.");
    // Se para antes de aplicar, de subir y de mover el checkpoint: no se desbloquea nada.
    assert!(ctx.repo.llamadas.lock().unwrap().is_empty());
    assert_eq!(*ctx.repo.cursor.lock().unwrap(),10);
    assert!(c.enviados.is_empty(),"ni sube lo de la copia ni suelta a las Handy");
    assert_eq!(ctx.repo.pending.lock().unwrap().len(),1);
    assert!(ctx.completa.lock().unwrap().is_none());
    assert_eq!(ctx.fases.lock().unwrap().as_slice(),["descargando"]);
    // Ya está recuperándose: la salida la ofrece su pantalla, no hace falta marcar nada (SYNC-32).
    assert!(!*ctx.repo.anterior_a_la_nube.lock().unwrap());
}

#[tokio::test]
async fn en_la_sesion_normal_se_detiene_sin_error_y_sin_tocar_nada() {
    // Una base cambiada por fuera de la aplicación. No es un fallo que se arregle reconectando:
    // la sesión acaba con su resultado propio y el motor deja de reintentar.
    let ctx=disponible(contexto(vec![op("venta-de-hoy")]));*ctx.repo.cursor.lock().unwrap()=10;
    let n=nube(vec![purgado_hasta_700()]);let mut c=conversacion(vec![estado()]);
    assert_eq!(ejecutar(&ctx,&n,&mut c,false).await.unwrap(),FinDeSesion::AnteriorAlLog);
    assert!(ctx.repo.llamadas.lock().unwrap().is_empty());
    assert_eq!(*ctx.repo.cursor.lock().unwrap(),10);
    assert!(c.enviados.is_empty(),"ni sube nada ni suelta a las Handy");
    assert_eq!(ctx.repo.pending.lock().unwrap().len(),1,"lo vendido se queda en el outbox");
    // SYNC-32: y la base pasa a recuperarse de la nube, como tras un traslado.
    assert!(*ctx.repo.anterior_a_la_nube.lock().unwrap());
    assert!(MOTIVO_ANTERIOR_AL_LOG.contains("recupera el estado actual de la nube"));
}

#[tokio::test]
async fn una_purga_que_se_lleva_el_12_y_deja_el_11_no_se_cuela() {
    // La purga mira también la antigüedad: el 11, más joven, se queda. El principio del log (11)
    // diría que a un cursor en el 10 no le falta nada; lo purgado (12) dice que sí.
    let ctx=contexto(vec![]);*ctx.repo.cursor.lock().unwrap()=10;
    let n=nube(vec![json!({"items":[item("op-11",11),item("op-13",13)],"nextSince":13,"highWater":13,"purgadoHasta":12})]);
    assert!(catch_up(&ctx,&n,true).await.is_err());
    assert!(ctx.repo.aplicados.lock().unwrap().is_empty(),"ni el 11 entra");
    let n=nube(vec![json!({"items":[item("op-11",11),item("op-13",13)],"nextSince":13,"highWater":13,"purgadoHasta":12})]);
    assert!(catch_up(&ctx,&n,false).await.unwrap().anterior_al_log);
    assert!(ctx.repo.aplicados.lock().unwrap().is_empty());
}

#[tokio::test]
async fn lo_purgado_se_mira_en_cada_pagina() {
    // La purga corre entre una página y la siguiente: lo de la primera entra, la segunda no.
    let ctx=contexto(vec![]);*ctx.repo.cursor.lock().unwrap()=10;
    let n=nube(vec![
        json!({"items":[item("op-11",11),item("op-12",12)],"nextSince":12,"highWater":1700,"purgadoHasta":0}),
        json!({"items":[item("op-701",701)],"nextSince":701,"highWater":1700,"purgadoHasta":700}),
    ]);
    assert!(catch_up(&ctx,&n,true).await.is_err());
    assert_eq!(*ctx.repo.aplicados.lock().unwrap(),vec![11,12]);
    assert_eq!(*ctx.repo.cursor.lock().unwrap(),12);
}

#[tokio::test]
async fn en_el_borde_se_pone_al_dia_y_sin_purgado_hasta_solo_falla_la_recuperacion() {
    // Lo purgado llega justo hasta el cursor: no falta nada.
    let ctx=contexto(vec![]);*ctx.repo.cursor.lock().unwrap()=700;
    let n=nube(vec![purgado_hasta_700(),pagina(vec![],1700)]);
    assert_eq!(catch_up(&ctx,&n,true).await.unwrap().high_water,1700);
    assert_eq!(*ctx.repo.aplicados.lock().unwrap(),vec![701,1700]);
    // Un worker anterior no lo dice: la recuperación no puede comprobar la copia y falla cerrada;
    // la sesión normal sigue como antes.
    let sin_marca=||json!({"items":[item("op-11",11)],"nextSince":11,"highWater":11});
    let ctx=contexto(vec![]);*ctx.repo.cursor.lock().unwrap()=10;
    let n=nube(vec![sin_marca()]);
    let e=catch_up(&ctx,&n,true).await.unwrap_err();
    assert!(e.to_string().ends_with("recupera el estado actual de la nube."),"{e}");
    assert!(ctx.repo.aplicados.lock().unwrap().is_empty());
    let n=nube(vec![sin_marca(),json!({"items":[],"nextSince":11,"highWater":11})]);
    assert_eq!(catch_up(&ctx,&n,false).await.unwrap().high_water,11);
    assert_eq!(*ctx.repo.aplicados.lock().unwrap(),vec![11]);
}

// ── SYNC-29 · lo que la nube ordenó de otra forma se trae de ella ───────────

fn traida()->crate::ports::sync::Convergencia {
    crate::ports::sync::Convergencia::Hecha{escritas:vec![SqlStatement{sql:"INSERT INTO \"Reservas\" (\"ID_Reserva\", \"Estado\") VALUES (?1, ?2) ON CONFLICT(\"ID_Reserva\") DO UPDATE SET \"Estado\" = excluded.\"Estado\";".into(),args:vec![json!("r1"),json!("CANCELADA")]}],quedan:false}
}
/// Lo que contesta `/v1/sync/verificar/por-clave` (`verificar.ts::filasPorClave`).
fn por_clave()->Value {json!({"ok":true,"tabla":"Reservas","columnas":["ID_Reserva","Estado"],"filas":[["r1","CANCELADA"]],"cortada":false,"hasta_seq":1})}

#[tokio::test]
async fn con_todo_subido_se_trae_de_la_nube_lo_que_su_orden_dejo_distinto_y_se_avisa_a_la_interfaz() {
    let ctx=disponible(contexto(vec![op("a")]));ctx.repo.convergencias.lock().unwrap().push_back(traida());
    let n=nube(vec![pagina(vec![],0),por_clave()]);
    let mut c=conversacion(vec![Some(acuse(vec![ok("a",1)]))]);
    assert!(ejecutar(&ctx,&n,&mut c,false).await.is_err(),"acaba al cerrarse el socket");
    // Una vez, con lo de aquí ya subido; se pide por clave a la nube por REST y lo escrito refresca
    // la interfaz.
    assert_eq!(*ctx.repo.al_converger.lock().unwrap(),vec![0]);
    assert_eq!(*n.calls.lock().unwrap(),["/v1/sync/changes","/v1/sync/verificar/por-clave"]);
    assert_eq!(*ctx.avisos.lock().unwrap(),1);
    // Por el socket no sale nada más: nunca se escribe en la nube desde aquí.
    assert_eq!(c.log,[">apply_lote","<apply_lote_ack",">recovery_ready"]);
}

#[tokio::test]
async fn con_algo_por_subir_no_se_mira() {
    // La nube no tiene todavía lo de aquí: lo que traiga no lo lleva.
    let ctx=disponible(contexto(vec![op("a")]));
    let n=nube(vec![pagina(vec![],0)]);
    let mut c=conversacion(vec![Some(acuse(vec![pasajera("a")])),Some(json!({"type":"main_online"}))]);
    assert!(ejecutar(&ctx,&n,&mut c,false).await.is_err());
    assert!(ctx.repo.al_converger.lock().unwrap().is_empty());
}

#[tokio::test]
async fn una_vuelta_aplazada_no_se_repite_en_cada_mensaje_y_vuelve_a_su_hora() {
    let ctx=disponible(contexto(vec![]));ctx.repo.convergencias.lock().unwrap().push_back(crate::ports::sync::Convergencia::Aplazada);
    let n=nube(vec![pagina(vec![],0)]);
    let mut entrantes=vec![estado()];
    entrantes.extend((0..20).map(|_|Some(json!({"type":"main_online"}))));
    let mut s=socket(entrantes);
    assert!(ejecutar(&ctx,&n,&mut s,false).await.is_err());
    assert_eq!(ctx.repo.al_converger.lock().unwrap().len(),1,"una, no una por mensaje");
    // Sin mensajes, el socket no se espera los 30 s: la vuelta aplazada se repite a los 2.
    assert!(s.esperas[0]<=Duration::from_secs(2)&&s.esperas[0]>Duration::from_secs(1),"{:?}",s.esperas);
}

#[tokio::test]
async fn si_la_nube_no_contesta_la_sesion_sigue() {
    // Pedir por clave falla (la nube no tiene respuesta preparada): se vuelve a intentar luego y lo
    // demás del socket se sigue atendiendo.
    let ctx=disponible(contexto(vec![]));ctx.repo.convergencias.lock().unwrap().push_back(traida());
    let n=nube(vec![pagina(vec![],0)]);
    let mut c=conversacion(vec![estado(),Some(json!({"type":"reservas_web"}))]);
    assert!(ejecutar(&ctx,&n,&mut c,false).await.is_err(),"acaba al cerrarse el socket, no por la nube");
    assert_eq!(*ctx.avisos.lock().unwrap(),0);
    assert_eq!(*ctx.recogidas.lock().unwrap(),2,"la de conectar y la del aviso");
}
