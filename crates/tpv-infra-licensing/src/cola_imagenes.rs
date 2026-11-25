//! RI-67: cola local para Main y Handy. Nunca se sostiene el bloqueo durante una petición HTTP.
use std::{fs, io::Write, path::{Path, PathBuf}, sync::Mutex};
use serde::{Deserialize, Serialize};
use tpv_contracts::imagenes::{EstadoColaImagenes, ImagenApartada};

static ACCESO: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImagenPendiente {
    pub rel_path: String,
    pub content_type: String,
    /// La pone `encolar` (y la renueva `reintentar`): una confirmación sólo quita la entrada si es
    /// la misma revisión que se subió. Obligatoria (M-084).
    revision: String,
    #[serde(default)]
    pub apartada: Option<String>,
}

pub struct ColaImagenes { carpeta: PathBuf }

impl ColaImagenes {
    pub fn new(carpeta: &Path) -> Self { Self { carpeta: carpeta.to_path_buf() } }

    fn editar<T>(&self, cambiar: impl FnOnce(&mut Vec<ImagenPendiente>) -> (T, bool)) -> Result<T, String> {
        let _guard = ACCESO.lock().map_err(|_| "No se pudo bloquear la cola de imágenes".to_string())?;
        let ruta = self.carpeta.join("image_uploads.json");
        let mut cola: Vec<ImagenPendiente> = match fs::read(&ruta) {
            // AUD-28: la clase y la posición, sin el texto de serde, que cita lo que hay en el fichero
            // (el nombre de una imagen). Este mensaje sale del equipo con el fallo del comando.
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!(
                "La cola de imágenes no se puede leer ({:?}, línea {}, columna {})",
                e.classify(), e.line(), e.column()
            ))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(format!("No se pudo leer la cola de imágenes: {e}")),
        };
        let (resultado, cambiada) = cambiar(&mut cola);
        if cambiada {
            let bytes = serde_json::to_vec(&cola).map_err(|e| e.to_string())?;
            let temporal = self.carpeta.join("image_uploads.json.tmp");
            let mut fichero = fs::File::create(&temporal).map_err(|e| e.to_string())?;
            fichero.write_all(&bytes).and_then(|_| fichero.sync_all()).map_err(|e| e.to_string())?;
            drop(fichero);
            // Mismo directorio y volumen: una interrupción deja la versión antigua o la nueva.
            fs::rename(temporal, ruta).map_err(|e| format!("No se pudo guardar la cola de imágenes: {e}"))?;
        }
        Ok(resultado)
    }

    pub fn encolar(&self, rel_path: &str, content_type: &str) -> Result<(), String> {
        self.editar(|cola| {
            if cola.iter().any(|i| i.rel_path == rel_path) { return ((), false); }
            cola.push(ImagenPendiente { rel_path: rel_path.into(), content_type: content_type.into(),
                revision: uuid::Uuid::new_v4().to_string(), apartada: None });
            ((), true)
        })
    }

    pub fn pendientes(&self) -> Result<Vec<ImagenPendiente>, String> {
        self.editar(|cola| (cola.iter().filter(|i| i.apartada.is_none()).cloned().collect(), false))
    }

    /// Confirma solo la revisión que se subió. Una eliminación/reintento posterior tiene prioridad.
    pub fn terminar(&self, imagen: &ImagenPendiente, rechazo: Option<&str>) -> Result<bool, String> {
        self.editar(|cola| {
            let Some(pos) = cola.iter().position(|i| i.rel_path == imagen.rel_path && i.revision == imagen.revision) else {
                return (false, false);
            };
            if let Some(motivo) = rechazo {
                if cola[pos].apartada.is_some() { return (false, false); }
                cola[pos].apartada = Some(motivo.chars().take(500).collect());
            } else { cola.remove(pos); }
            (true, true)
        })
    }

    pub fn reintentar(&self, rel_path: &str) -> Result<(), String> {
        self.editar(|cola| {
            let Some(imagen) = cola.iter_mut().find(|i| i.rel_path == rel_path && i.apartada.is_some()) else {
                return ((), false);
            };
            imagen.apartada = None;
            imagen.revision = uuid::Uuid::new_v4().to_string();
            ((), true)
        })
    }

    pub fn descartar(&self, rel_path: &str) -> Result<(), String> {
        self.editar(|cola| {
            let anterior = cola.len();
            cola.retain(|i| i.rel_path != rel_path);
            ((), anterior != cola.len())
        })
    }

    pub fn estado(&self) -> Result<EstadoColaImagenes, String> {
        self.editar(|cola| {
            let pendientes = cola.iter().filter(|i| i.apartada.is_none()).count() as u32;
            let total_apartadas = cola.len() as u32 - pendientes;
            let apartadas = cola.iter().filter_map(|i| i.apartada.as_ref().map(|motivo|
                ImagenApartada { rel_path: i.rel_path.clone(), motivo: motivo.clone() })).take(100).collect();
            (EstadoColaImagenes { pendientes, total_apartadas, apartadas }, false)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Directorio(PathBuf);
    impl Directorio {
        fn new() -> Self {
            let ruta = std::env::temp_dir().join(format!("tpv-cola-imagenes-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&ruta).unwrap(); Self(ruta)
        }
        fn cola(&self) -> ColaImagenes { ColaImagenes::new(&self.0) }
    }
    impl Drop for Directorio { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }

    #[test]
    fn confirmar_no_pierde_una_imagen_encolada_durante_la_subida() {
        let dir = Directorio::new(); let cola = dir.cola();
        cola.encolar("a", "image/jpeg").unwrap();
        let snapshot = cola.pendientes().unwrap();
        cola.encolar("b", "image/png").unwrap();
        cola.terminar(&snapshot[0], None).unwrap();
        assert_eq!(cola.pendientes().unwrap()[0].rel_path, "b");
    }

    #[test]
    fn rechazada_no_bloquea_las_demas_y_sobrevive_al_reinicio() {
        let dir = Directorio::new(); let cola = dir.cola();
        cola.encolar("a", "image/jpeg").unwrap(); cola.encolar("b", "image/png").unwrap();
        cola.terminar(&cola.pendientes().unwrap()[0], Some("413")).unwrap();
        assert_eq!(dir.cola().pendientes().unwrap()[0].rel_path, "b");
        assert_eq!(dir.cola().estado().unwrap().apartadas[0].motivo, "413");
        cola.encolar("a", "image/jpeg").unwrap(); // Backfill no reactiva un rechazo.
        assert_eq!(cola.estado().unwrap().total_apartadas, 1);
    }

    #[test]
    fn reintento_no_se_elimina_por_una_confirmacion_antigua() {
        let dir = Directorio::new(); let cola = dir.cola();
        cola.encolar("a", "image/jpeg").unwrap(); let imagen = cola.pendientes().unwrap().remove(0);
        cola.terminar(&imagen, Some("400")).unwrap(); cola.reintentar("a").unwrap();
        assert!(!cola.terminar(&imagen, None).unwrap());
        assert_eq!(cola.pendientes().unwrap().len(), 1);
    }

    #[test]
    fn corrupcion_no_se_convierte_en_cola_vacia_ni_se_sobrescribe() {
        let dir = Directorio::new(); let ruta = dir.0.join("image_uploads.json");
        fs::write(&ruta, b"JSON roto").unwrap();
        assert!(dir.cola().pendientes().is_err()); assert!(dir.cola().encolar("a", "image/jpeg").is_err());
        assert_eq!(fs::read(ruta).unwrap(), b"JSON roto");
    }

    /// AUD-28: una cola con otro formato no se lee, y el mensaje no repite lo que hay en ella.
    #[test]
    fn una_cola_incompatible_no_cita_su_contenido() {
        const COLA: &[u8] = br#"["images/productos/Tarta de Ana Prueba.jpg"]"#;
        // El control: el texto de serde sí lleva el nombre del fichero.
        let de_serde = serde_json::from_slice::<Vec<ImagenPendiente>>(COLA).unwrap_err().to_string();
        assert!(de_serde.contains("Tarta de Ana Prueba"), "{de_serde}");

        let dir = Directorio::new(); let ruta = dir.0.join("image_uploads.json");
        fs::write(&ruta, COLA).unwrap();
        let error = dir.cola().pendientes().unwrap_err();
        assert!(error.starts_with("La cola de imágenes no se puede leer (Data, línea 1, columna "), "{error}");
        assert!(!error.contains("Tarta") && !error.contains("Ana Prueba") && !error.contains("images/"), "{error}");
        assert_eq!(fs::read(ruta).unwrap(), COLA);
    }

    /// M-084: toda entrada lleva su revisión desde que la escribe `encolar`; una sin ella no es una
    /// cola de esta versión, y se trata como una cola que no se puede leer: no se toca.
    #[test]
    fn una_entrada_sin_revision_no_es_una_cola_valida() {
        const COLA: &[u8] = br#"[{"rel_path":"a","content_type":"image/jpeg"}]"#;
        let dir = Directorio::new(); let ruta = dir.0.join("image_uploads.json");
        fs::write(&ruta, COLA).unwrap();
        let error = dir.cola().pendientes().unwrap_err();
        assert!(error.starts_with("La cola de imágenes no se puede leer"), "{error}");
        assert_eq!(fs::read(ruta).unwrap(), COLA);
    }

    #[test]
    fn un_temporal_interrumpido_no_sustituye_la_cola_confirmada() {
        let dir = Directorio::new(); let cola = dir.cola();
        cola.encolar("a", "image/jpeg").unwrap();
        fs::write(dir.0.join("image_uploads.json.tmp"), b"escritura incompleta").unwrap();
        assert_eq!(dir.cola().pendientes().unwrap()[0].rel_path, "a");
        cola.encolar("b", "image/png").unwrap();
        assert_eq!(dir.cola().pendientes().unwrap().len(), 2);
    }
}
