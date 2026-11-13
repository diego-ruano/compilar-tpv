//! Escenarios del motor nativo con transporte y persistencia deterministas.
use super::*;
use async_trait::async_trait;
use std::{collections::{HashMap, VecDeque}, sync::{Arc, Mutex}};
use crate::ports::sync::{BajadaAplicada, CambioDetenido, SyncRepository};
use tpv_contracts::{licensing::*,sync::*};
use serde_json::Value as JsonValue;

#[derive(Default)]
struct FakeRepo {
    limits: Mutex<Vec<i64>>, checkpoints: Mutex<usize>,
    pending: Mutex<Vec<OutboxEntry>>, encoladas:Mutex<Vec<String>>, cursor:Mutex<i64>,
    // AUD-18: cuántas veces más falla cada cambio, los intentos que lleva, el detenido (lo que en
    // el repositorio real es `_Sync_Failed`), lo aplicado en orden y lo apartado a la cuarentena.
    fallos: Mutex<HashMap<String, i64>>, intentos: Mutex<HashMap<String, i64>>,
    detenido: Mutex<Option<SyncChange>>, aplicados: Mutex<Vec<i64>>, cuarentena: Mutex<Vec<String>>,
    // Los `Seq` que se le han pedido aplicar, llamada a llamada.
    llamadas: Mutex<Vec<Vec<i64>>>,
    // AUD-15: las encoladas cuya marca ya caducó (`liberar_encoladas_caducadas` las suelta), las
    // apartadas de la subida (`Cuarentena = 1`: siguen en el outbox, fuera de lo pendiente) y los
    // rechazos contados de cada operación.
    caducadas: Mutex<Vec<String>>, apartadas: Mutex<Vec<String>>, rechazos: Mutex<HashMap<String, i64>>,
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
            let fuera = |id: &String| self.encoladas.lock().unwrap().contains(id) || self.apartadas.lock().unwrap().contains(id);
            Ok(self.pending.lock().unwrap().iter().filter(|e| !fuera(&e.op_id)).take(limit as usize).cloned().collect())
        }
        async fn outbox_mark_sent(&self, id: &str, _: i64) -> AppResult<()> {
            self.pending.lock().unwrap().retain(|e| e.op_id != id);
            Ok(())
        }
        /// El mismo contrato que el real: repetible, aparta al rechazo permanente o a los 20,
        /// suelta la marca de encolada y encola la reparación, salvo de una reparación.
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
                self.encoladas.lock().unwrap().retain(|e| e != id);
                if command_name != "main_reparacion" {
                    let mut reparacion = op(&format!("repara-{id}"));
                    reparacion.command_name = "main_reparacion".into();
                    self.pending.lock().unwrap().push(reparacion);
                    reparadas = 1;
                }
            }
            Ok(OutboxFallo { intentos, apartada, command_name, reparadas })
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
        async fn liberar_encoladas_caducadas(&self, antiguedad: i64) -> AppResult<i64> {
            let mut encoladas = self.encoladas.lock().unwrap();
            let antes = encoladas.len();
            if antiguedad <= 0 { encoladas.clear(); } else {
                let caducadas = self.caducadas.lock().unwrap();
                encoladas.retain(|e| !caducadas.contains(e));
            }
            Ok((antes - encoladas.len()) as i64)
        }
        async fn purge_applied_ops(&self) -> AppResult<()> {
            Ok(())
        }
        async fn health(&self) -> AppResult<SyncHealth> {
            let apartadas = self.apartadas.lock().unwrap().len() as i64;
            Ok(SyncHealth {outbox_pending:self.pending.lock().unwrap().len() as i64 - apartadas,last_seq:*self.cursor.lock().unwrap(),quarantined:0,failing:0,subida_fallando:0,subida_en_cuarentena:apartadas})
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
struct Contexto { repo: Arc<FakeRepo>, fases:Mutex<Vec<String>>, avisos:Mutex<usize>, completa:Mutex<Option<i64>>, recogidas:Mutex<usize>, sigue:Mutex<bool> }
#[async_trait]
impl ContextoReplicacion for Contexto {
    async fn repositorio(&self) -> AppResult<Arc<dyn SyncRepository>> { Ok(self.repo.clone()) }
    fn cambios(&self, _: &[SqlStatement]) { *self.avisos.lock().unwrap() += 1; }
    fn fase_recuperacion(&self, fase:&str) { self.fases.lock().unwrap().push(fase.into()); }
    fn solicitud_emparejamiento(&self) {}
    fn reservas_web(&self) { *self.recogidas.lock().unwrap() += 1; }
    fn fallo_subida(&self, _: &str, _: &OutboxFallo) {}
    async fn completar_recuperacion(&self, h:i64)->AppResult<()> { *self.completa.lock().unwrap()=Some(h);Ok(()) }
    async fn sigue_disponible(&self,_:bool)->AppResult<bool> { Ok(*self.sigue.lock().unwrap()) }
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
    Contexto{repo,fases:Mutex::new(vec![]),avisos:Mutex::new(0),completa:Mutex::new(None),recogidas:Mutex::new(0),sigue:Mutex::new(false)}
}
fn op(id:&str)->OutboxEntry {OutboxEntry{seq:1,op_id:id.into(),command_name:"venta".into(),statements:vec![SqlStatement{sql:"INSERT INTO Productos (Nombre) VALUES (?1)".into(),args:vec![json!("Producto")]}]}}
fn nube(respuestas:Vec<Value>)->Nube {Nube{responses:Mutex::new(respuestas.into()),calls:Mutex::new(vec![]),cuerpos:Mutex::new(vec![])}}
fn pagina(items:Vec<Value>,high:i64)->Value {json!({"items":items,"nextSince":high,"highWater":high,"purgadoHasta":0})}
fn canal(respuestas:Vec<Value>)->Canal {Canal{respuestas:respuestas.into(),enviados:vec![]}}

#[tokio::test]
async fn solo_el_ack_de_la_operacion_enviada_la_confirma() {
    let ctx=contexto(vec![op("a")]);let mut c=canal(vec![json!({"type":"apply_ack","opId":"otra","ok":true})]);
    assert!(subir_pendientes(&ctx,&mut c,&mut Sesion::default(),false,false).await.is_err());
    assert_eq!(ctx.repo.pending.lock().unwrap().len(),1);
}
#[tokio::test]
async fn un_corte_sin_ack_conserva_la_operacion() {
    let ctx=contexto(vec![op("a")]);let mut c=canal(vec![]);
    assert!(subir_pendientes(&ctx,&mut c,&mut Sesion::default(),false,false).await.is_err());
    assert_eq!(ctx.repo.pending.lock().unwrap().len(),1);
}
#[tokio::test]
async fn se_aplica_lo_vivo_mientras_se_espera_una_confirmacion() {
    let ctx=contexto(vec![op("a")]);let mut c=canal(vec![json!({"type":"change","opId":"remota","seq":2,"statements":[{"sql":"UPDATE Productos SET Nombre=?1","args":["Otro"]}]}),json!({"type":"apply_ack","opId":"a","seq":3,"ok":true})]);
    assert!(subir_pendientes(&ctx,&mut c,&mut Sesion::default(),false,false).await.unwrap());
    assert!(ctx.repo.pending.lock().unwrap().is_empty());assert_eq!(*ctx.avisos.lock().unwrap(),1);
}
#[tokio::test]
async fn encolada_no_se_considera_aplicada() {
    let ctx=contexto(vec![op("a")]);let mut c=canal(vec![json!({"type":"apply_ack","opId":"a","ok":true,"encolada":true})]);
    assert!(subir_pendientes(&ctx,&mut c,&mut Sesion::default(),false,false).await.unwrap());
    assert_eq!(ctx.repo.pending.lock().unwrap().len(),1);assert_eq!(ctx.repo.encoladas.lock().unwrap().as_slice(),["a"]);
}
#[tokio::test]
async fn el_volcado_conserva_las_filas_hasta_verlas_volver() {
    let ctx=contexto((0..101).map(|i|op(&i.to_string())).collect());let mut c=canal(vec![json!({"type":"bulk_ack","ok":true})]);
    assert!(subir_pendientes(&ctx,&mut c,&mut Sesion::default(),true,false).await.unwrap());
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
    let ctx=contexto(vec![op("a")]);let mut c=canal(vec![json!({"type":"reservas_web"}),json!({"type":"apply_ack","opId":"a","seq":3,"ok":true})]);
    assert!(subir_pendientes(&ctx,&mut c,&mut Sesion::default(),false,false).await.unwrap());
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
fn since_pedidos(n:&Nube)->Vec<i64> {n.cuerpos.lock().unwrap().iter().map(|c|c["since"].as_i64().unwrap()).collect()}

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
    // acuse de lo que la nube apartó de la cola.
    let ctx=contexto(vec![]);ctx.repo.fallos.lock().unwrap().insert("op-1".into(),1);
    let n=nube(vec![pagina_hasta(vec![item("op-1",1)],1,1),pagina_hasta(vec![item("op-2",2)],2,2),pagina(vec![],2)]);
    let mut s=socket(vec![Some(json!({"type":"cola_apartada","ops":[{"opId":"op-x"}]})),Some(vivo("op-2",2)),None]);
    ejecutar(&ctx,&n,&mut s,false).await.unwrap();
    assert_eq!(s.enviados[0]["type"],"cola_apartada_ack");
    // El 2 que llegó en vivo no se aplicó entonces: vino después, por el catch-up.
    assert_eq!(*ctx.repo.llamadas.lock().unwrap(),vec![vec![1],vec![1],vec![2]]);
    assert_eq!(*ctx.repo.aplicados.lock().unwrap(),vec![1,2]);
}

// ── AUD-15 · la Main congela a las Handy hasta ponerse al día ───────────────

fn firma(_:&str)->AppResult<FirmaDispositivo> {Ok(FirmaDispositivo{ts:10,sig_b64:"firma".into()})}
/// Lo último que manda el DO al saludar a la Main, con lo que tiene en su cola.
fn estado(cola:i64)->Option<Value> {Some(json!({"type":"main_status","online":true,"volcando":true,"cola":cola}))}
fn ack(op:&str,seq:i64)->Option<Value> {Some(json!({"type":"apply_ack","opId":op,"ok":true,"seq":seq}))}
fn apartada(op:&str)->Option<Value> {Some(json!({"type":"cola_apartada","ops":[{"opId":op}]}))}
fn cola_vacia()->Option<Value> {Some(json!({"type":"main_volcando","volcando":true,"cola":0}))}
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
        Ok(m)
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
    let mut c=conversacion(vec![Some(json!({"type":"challenge","nonceB64":"reto"})),Some(json!({"type":"hello_ok","role":"tpv","authed":true})),estado(0),ack("venta",1)]);
    c.al_saludar=Some((ctx.repo.clone(),op("venta")));
    saludar(&mut c,firma).await.unwrap();
    let n=nube(vec![pagina(vec![],0)]);
    assert!(ejecutar(&ctx,&n,&mut c,false).await.is_err(),"acaba al cerrarse el socket");
    assert_eq!(c.log,["<challenge",">helloSigned","<hello_ok",">apply","<main_status","<apply_ack",">recovery_ready"]);
    assert_eq!(c.enviados[0]["recovering"],true);
    assert!(ctx.repo.pending.lock().unwrap().is_empty());
}

#[tokio::test]
async fn el_atraso_sube_en_vivo_y_al_vaciarse_suelta_a_las_handy() {
    // Cien operaciones: no llegan al volcado, así que suben en vivo de una en una.
    let ctx=contexto((0..100).map(|i|op(&i.to_string())).collect());
    let n=nube(vec![pagina(vec![],0)]);
    let mut entrantes=vec![estado(0)];
    entrantes.extend((0..100i64).map(|i|ack(&i.to_string(),i+1)));
    let mut c=conversacion(entrantes);
    ejecutar(&ctx,&n,&mut c,false).await.unwrap();
    assert_eq!(c.enviados.len(),101);
    assert!(c.enviados[..100].iter().all(|m|m["type"]=="apply"));
    assert_eq!(c.log.last().map(String::as_str),Some(">recovery_ready"),"después de la última confirmación");
    assert!(ctx.repo.pending.lock().unwrap().is_empty());
}

#[tokio::test]
async fn no_las_suelta_hasta_que_el_atraso_ha_subido_entero() {
    let ctx=disponible(contexto(vec![op("a")]));
    let n=nube(vec![pagina(vec![],0)]);
    // La nube no la acepta a la primera (un fallo pasajero) y sí en la vuelta siguiente.
    let mut c=conversacion(vec![
        estado(0),
        Some(json!({"type":"apply_ack","opId":"a","ok":false,"transitorio":true})),
        Some(json!({"type":"despertar"})),
        ack("a",1),
    ]);
    assert!(ejecutar(&ctx,&n,&mut c,false).await.is_err(),"acaba al cerrarse el socket");
    assert_eq!(c.log,[">apply","<main_status","<apply_ack","<despertar",">apply","<apply_ack",">recovery_ready"]);
}

#[tokio::test]
async fn sin_atraso_las_suelta_al_cerrarse_el_saludo() {
    // También limpia el congelado que dejara una sesión anterior cortada a medias.
    let ctx=disponible(contexto(vec![]));let n=nube(vec![pagina(vec![],0)]);
    let mut c=conversacion(vec![estado(0)]);
    assert!(ejecutar(&ctx,&n,&mut c,false).await.is_err());
    assert_eq!(c.log,["<main_status",">recovery_ready"]);
}

#[tokio::test]
async fn lo_que_la_nube_aparto_mientras_no_estaba_se_repara_antes_de_soltarlas() {
    // La Main vuelve antes de una hora: «a» sigue marcada como encolada, pero el DO la apartó y lo
    // avisa en el saludo, antes de `main_status`. El outbox no tiene nada que subir.
    let ctx=disponible(contexto(vec![op("a")]));ctx.repo.encoladas.lock().unwrap().push("a".into());
    let n=nube(vec![pagina(vec![],0)]);
    let mut c=conversacion(vec![apartada("a"),estado(0),ack("repara-a",1)]);
    assert!(ejecutar(&ctx,&n,&mut c,false).await.is_err());
    assert_eq!(c.log,["<cola_apartada",">cola_apartada_ack","<main_status",">apply","<apply_ack",">recovery_ready"]);
    assert_eq!(c.enviados[1]["opId"],"repara-a");
    assert_eq!(*ctx.repo.apartadas.lock().unwrap(),vec!["a".to_string()]);
    assert!(ctx.repo.encoladas.lock().unwrap().is_empty(),"la apartada deja de estar encolada");
}

#[tokio::test]
async fn el_volcado_que_aparta_una_no_las_suelta_hasta_subir_su_reparacion() {
    let ctx=disponible(contexto((0..101).map(|i|op(&i.to_string())).collect()));
    let n=nube(vec![pagina(vec![],0)]);
    let mut c=conversacion(vec![
        estado(0),
        Some(json!({"type":"main_volcando","volcando":true,"cola":101})),
        Some(json!({"type":"bulk_ack","ok":true})),
        // El DO drena: aparta la «7», lo avisa y después avisa de que la cola está vacía.
        None,
        apartada("7"),
        cola_vacia(),
        ack("repara-7",200),
    ]);
    assert!(ejecutar(&ctx,&n,&mut c,false).await.is_err());
    assert_eq!(c.log,[">bulk_apply","<main_status","<main_volcando","<bulk_ack","<cola_apartada",">cola_apartada_ack","<main_volcando",">apply","<apply_ack",">recovery_ready"]);
    assert_eq!(c.enviados[2]["opId"],"repara-7");
}

#[tokio::test]
async fn con_algo_en_la_cola_de_la_nube_espera_a_que_se_vacie() {
    let ctx=disponible(contexto(vec![]));let n=nube(vec![pagina(vec![],0)]);
    let mut c=conversacion(vec![estado(3),None,cola_vacia()]);
    assert!(ejecutar(&ctx,&n,&mut c,false).await.is_err());
    assert_eq!(c.log,["<main_status","<main_volcando",">recovery_ready"]);
}

#[tokio::test]
/// Decisión del responsable, no un descuido: una operación que ni su reparación consigue subir no
/// congela a las Handy para siempre, que sería bloquear al personal por algo que no va a cambiar.
/// Se sueltan con lo apartado en cuarentena y su aviso, y lo repara el contraste diario.
async fn una_reparacion_irreparable_suelta_a_las_handy_para_no_bloquear_al_personal() {
    let ctx=disponible(contexto(vec![op("a")]));ctx.repo.encoladas.lock().unwrap().push("a".into());
    let n=nube(vec![pagina(vec![],0)]);
    let mut c=conversacion(vec![apartada("a"),estado(0),Some(json!({"type":"apply_ack","opId":"repara-a","ok":false,"permanente":true}))]);
    assert!(ejecutar(&ctx,&n,&mut c,false).await.is_err());
    assert_eq!(c.log,["<cola_apartada",">cola_apartada_ack","<main_status",">apply","<apply_ack",">recovery_ready"]);
    // Las dos quedan en cuarentena, con su rastro: ni se borran ni se reintentan.
    assert_eq!(*ctx.repo.apartadas.lock().unwrap(),vec!["a".to_string(),"repara-a".to_string()]);
    assert_eq!(ctx.repo.pending.lock().unwrap().len(),2);
}

#[tokio::test]
async fn una_encolada_caducada_vuelve_a_subir_antes_de_soltarlas() {
    // Lleva más de una hora sin volver por el catch-up: se ofrece otra vez.
    let ctx=disponible(contexto(vec![op("a")]));
    ctx.repo.encoladas.lock().unwrap().push("a".into());ctx.repo.caducadas.lock().unwrap().push("a".into());
    let n=nube(vec![pagina(vec![],0)]);
    let mut c=conversacion(vec![estado(0),ack("a",9)]);
    assert!(ejecutar(&ctx,&n,&mut c,false).await.is_err());
    assert_eq!(c.log,[">apply","<main_status","<apply_ack",">recovery_ready"]);
    assert!(ctx.repo.encoladas.lock().unwrap().is_empty() && ctx.repo.pending.lock().unwrap().is_empty());
}

#[tokio::test]
async fn un_do_que_no_dice_su_cola_no_las_retiene() {
    // Un worker anterior: `main_status` sin `cola`. Se sueltan como antes, al subir lo pendiente.
    let ctx=disponible(contexto((0..101).map(|i|op(&i.to_string())).collect()));
    let n=nube(vec![pagina(vec![],0)]);
    let mut c=conversacion(vec![Some(json!({"type":"main_status","online":true,"volcando":true})),Some(json!({"type":"bulk_ack","ok":true}))]);
    assert!(ejecutar(&ctx,&n,&mut c,false).await.is_err());
    assert_eq!(c.log,[">bulk_apply","<main_status","<bulk_ack",">recovery_ready"]);
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
}

#[tokio::test]
async fn en_la_sesion_normal_se_detiene_sin_error_y_sin_tocar_nada() {
    // Una base cambiada por fuera de la aplicación. No es un fallo que se arregle reconectando:
    // la sesión acaba con su resultado propio y el motor deja de reintentar.
    let ctx=disponible(contexto(vec![op("venta-de-hoy")]));*ctx.repo.cursor.lock().unwrap()=10;
    let n=nube(vec![purgado_hasta_700()]);let mut c=conversacion(vec![estado(0)]);
    assert_eq!(ejecutar(&ctx,&n,&mut c,false).await.unwrap(),FinDeSesion::AnteriorAlLog);
    assert!(ctx.repo.llamadas.lock().unwrap().is_empty());
    assert_eq!(*ctx.repo.cursor.lock().unwrap(),10);
    assert!(c.enviados.is_empty(),"ni sube nada ni suelta a las Handy");
    assert_eq!(ctx.repo.pending.lock().unwrap().len(),1,"lo vendido se queda en el outbox");
    assert!(MOTIVO_ANTERIOR_AL_LOG.contains("Contacta con soporte"));
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
