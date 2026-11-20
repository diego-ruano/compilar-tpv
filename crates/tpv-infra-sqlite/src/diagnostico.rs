//! OPS-02 · Adaptador SQLite del puerto `DiagnosticoDeLaBase`: lo que el paquete de diagnóstico
//! cuenta de la base local de la Main.
//!
//! Sólo `PRAGMA` y la tabla `_migrations`: **ninguna tabla de negocio**, ni el outbox (de él basta
//! cuántas operaciones hay, y eso lo dice `SyncRepository::health`). Lo que devuelve no puede llevar
//! un dato de nadie porque no lee ninguno.

use std::sync::Arc;

use async_trait::async_trait;

use tpv_application::error::AppResult;
use tpv_application::ports::diagnostico::{DiagnosticoDeLaBase, EstadoDeLaBase};

use crate::consultas::db_err;
use crate::db::{Db, Reader};
use crate::ejecutor::Value;
use crate::mapping::{v_i64, v_string};

/// Cuántos problemas cuenta como mucho la comprobación de integridad: con uno ya hay que
/// restaurar, y una base muy rota daría miles.
const PROBLEMAS_DE_INTEGRIDAD: i64 = 20;

pub struct SqliteDiagnosticoDeLaBase {
    db: Arc<Db>,
}

impl SqliteDiagnosticoDeLaBase {
    pub fn new(db: Arc<Db>) -> Self {
        Self { db }
    }
}

async fn columna(r: &impl Reader, sql: &str) -> AppResult<Vec<Value>> {
    let mut filas = r.query(sql, Vec::<Value>::new()).await.map_err(db_err)?;
    let mut out = Vec::new();
    while let Some(fila) = filas.next().await.map_err(db_err)? {
        out.push(fila.get_value(0).map_err(db_err)?);
    }
    Ok(out)
}

async fn entero(r: &impl Reader, sql: &str) -> AppResult<i64> {
    Ok(columna(r, sql).await?.into_iter().next().and_then(v_i64).unwrap_or(0))
}

async fn texto(r: &impl Reader, sql: &str) -> AppResult<Option<String>> {
    Ok(columna(r, sql).await?.into_iter().next().and_then(v_string))
}

#[async_trait]
impl DiagnosticoDeLaBase for SqliteDiagnosticoDeLaBase {
    async fn estado(&self) -> AppResult<EstadoDeLaBase> {
        let r = self.db.read().await;
        // `quick_check` y no `integrity_check`: no compara cada índice con su tabla, y así recorre
        // la base una vez. Basta para saber si el fichero está roto.
        let integridad = columna(&r, &format!("PRAGMA quick_check({PROBLEMAS_DE_INTEGRIDAD})"))
            .await?
            .into_iter()
            .filter_map(v_string)
            .collect();
        let paginas = entero(&r, "PRAGMA page_count").await?;
        let tamano_de_pagina = entero(&r, "PRAGMA page_size").await?;
        Ok(EstadoDeLaBase {
            integridad,
            bytes: paginas.saturating_mul(tamano_de_pagina),
            paginas_libres: entero(&r, "PRAGMA freelist_count").await?,
            modo_del_diario: texto(&r, "PRAGMA journal_mode").await?.unwrap_or_default(),
            version_sqlite: texto(&r, "SELECT sqlite_version()").await?.unwrap_or_default(),
            migraciones_aplicadas: entero(&r, "SELECT COUNT(*) FROM _migrations").await?,
            ultima_migracion: texto(&r, "SELECT name FROM _migrations ORDER BY applied_at DESC, name DESC LIMIT 1")
                .await?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Writer;

    async fn db_temporal() -> (Arc<Db>, std::path::PathBuf) {
        let dir = crate::test_temp::dir_temporal("diagnostico");
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        (db, dir)
    }

    #[tokio::test]
    async fn cuenta_la_base_sin_leer_lo_que_hay_dentro() {
        let (db, _dir) = db_temporal().await;
        // Un cliente con todos sus datos, por el camino de una escritura de negocio: queda también
        // en el outbox, con sus argumentos.
        {
            let w = db.write().await;
            w.execute(
                "INSERT INTO Clientes (ID_Cliente, Nombre, Telefono, Email, Notas) VALUES (?1, ?2, ?3, ?4, ?5)",
                vec![
                    Value::Text("0193a0b0-0000-7000-8000-000000000001".into()),
                    Value::Text("Remedios Cifuentes".into()),
                    Value::Text("612345678".into()),
                    Value::Text("remedios@example.com".into()),
                    Value::Text("Alérgica al marisco".into()),
                ],
            )
            .await
            .unwrap();
        }

        let estado = SqliteDiagnosticoDeLaBase::new(db.clone()).estado().await.unwrap();
        assert_eq!(estado.integridad, vec!["ok".to_string()]);
        assert!(estado.bytes > 0);
        assert_eq!(estado.modo_del_diario.to_lowercase(), "wal");
        assert!(!estado.version_sqlite.is_empty());
        assert!(estado.migraciones_aplicadas >= 1);
        assert!(estado.ultima_migracion.as_deref().is_some_and(|m| m.ends_with(".sql")));

        let texto = serde_json::to_string(&estado).unwrap();
        for dato in ["Remedios", "612345678", "remedios@example.com", "marisco"] {
            assert!(!texto.contains(dato), "{dato} en {texto}");
        }
    }
}
