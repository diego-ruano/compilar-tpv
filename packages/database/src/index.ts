// @tpv/database
//
// Este paquete no exporta código. Lo que contiene es el esquema único de la base de cada tenant
// (`migrations/*.sql`) y su foto anti-deriva (`schema.snapshot.sql`), que consumen el runner de la
// Main (`crates/tpv-infra-sqlite/src/migrations.rs`, con `include_dir!`) y el del worker
// (`apps/cloud-worker-licensing/src/server/tenantMigrations.ts`). Ver docs/arquitectura/esquema.md.

export {};
