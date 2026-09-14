// src/server/tablasDeNube.ts
//
// Tablas que la NUBE añade a la BD del tenant y que la Main no tiene: el log de cambios que
// alimenta el catch-up y el checkpoint por Main que hace de suelo de la purga. Por eso no están en
// las migraciones compartidas de packages/database.
//
// Son esquema del tenant como cualquier otro, y se crean por el mismo camino: una migración con
// nombre y hash en `_migrations` (ver `tenantMigrations.ts`). Antes las creaba el Durable Object al
// abrir su conexión, así que un tenant recién aprovisionado no las tenía hasta la primera escritura
// por el DO, y la primera lectura por REST —el catch-up de una Main recién activada— reventaba con
// `no such table: Sync_Changes` (SYNC-28). Siendo migración, nacen al aprovisionar y cualquier
// camino que abra el tenant las garantiza.
//
// ⚠️ Mismas reglas que una migración compartida: su hash queda grabado en el tenant, así que
// editar este texto hace que `runTenantMigrations` rechace el tenant (`migration_altered`).
// Mientras no haya clientes se resetean los tenants de desarrollo; desde el lanzamiento, un cambio
// va en una migración de nube NUEVA.
//
// Vive en su propio módulo, y no en el DO, para que los tests levanten exactamente este esquema.

export const DDL_TABLAS_DE_NUBE: string[] = [
	`CREATE TABLE IF NOT EXISTS Sync_Changes (
		Seq INTEGER PRIMARY KEY AUTOINCREMENT,
		Op_Id TEXT NOT NULL,
		Command_Name TEXT,
		Statements_Json TEXT NOT NULL,
		Device_Id TEXT,
		Created_At_Ms INTEGER NOT NULL
	);`,
	`CREATE TABLE IF NOT EXISTS Sync_Main_Checkpoints (
		Device_Id TEXT PRIMARY KEY,
		Last_Seq INTEGER NOT NULL,
		Updated_At_Ms INTEGER NOT NULL
	);`,
];
