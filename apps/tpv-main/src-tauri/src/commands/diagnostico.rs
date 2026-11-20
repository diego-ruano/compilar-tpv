//! OPS-02 · El **paquete de diagnóstico** para soporte (capa fina).
//!
//! Lo compone `crate::diagnostico` con el caso de uso `tpv_application::use_cases::diagnostico`; la
//! pantalla lo guarda donde elija la persona (diálogo de guardado y `writeFile`, como los PDF).
//!
//! Sin sesión a propósito: es para cuando algo va mal, y lo que va mal puede ser no poder entrar
//! (la pantalla de recuperación, la licencia rechazada, una Handy sin red, que no puede comprobar
//! los permisos de nadie). No escribe nada, y lo que lee es lo mismo que enseñan sin gate
//! `sync_health`, `jobs_status` e `interruptores_apagados`, pasado por el filtro de datos personales.

use tauri::AppHandle;

use tpv_contracts::diagnostico::PaqueteDiagnostico;
use tpv_contracts::errors::AppErrorDto;

#[tauri::command]
#[specta::specta]
pub async fn diagnostico_generar_paquete(app: AppHandle) -> Result<PaqueteDiagnostico, AppErrorDto> {
    Ok(crate::diagnostico::generar(&app).await)
}
