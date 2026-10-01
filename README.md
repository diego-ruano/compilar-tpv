# TPV

Terminal punto de venta para hostelería. Una aplicación de escritorio para Windows (la **Main**, la caja
de la barra) que vende contra su propia base de datos aunque no haya internet, una aplicación Android para
los camareros (la **Handy**) que trabaja contra la nube, y un servicio en Cloudflare que replica los datos
entre las dos y gestiona las licencias. Cada cobro es una factura con su registro Veri\*factu, que la Main
remite a la AEAT con el certificado del bar.

| Pieza | Tecnología | Dónde |
|---|---|---|
| Aplicación (Main y Handy) | Tauri 2, React 19, TypeScript, Vite | `apps/tpv-main/` |
| Backend local | Rust, arquitectura hexagonal, SQLite (libsql) | `crates/*`, `apps/tpv-main/src-tauri/` |
| Nube | Cloudflare Worker (Hono), Durable Objects, Turso, R2 | `apps/cloud-worker-licensing/` (desplegado como `tpv-api`) |
| Código compartido | Esquema SQL, tipos generados, cliente de invoke | `packages/*` |

Dominios: mesas y comandas, venta rápida de barra, inventario con lotes, caja y cierre de caja, clientes,
reservas, proveedores y pedidos, tareas, personal y fichajes, estadísticas, configuración, licencias,
emparejamiento de dispositivos y registro de facturación.

## Empezar

Requisitos: Node 22 con **pnpm** (nunca npm), Rust 1.91, las herramientas de compilación de Windows y,
para los tests de Rust, `cargo install cargo-nextest --locked`.

```bash
pnpm install
pnpm tauri dev                # la aplicación de escritorio
cargo nextest run             # tests de Rust
pnpm --filter @tpv/main test  # tests del frontend
pnpm --filter tpv-api test    # tests del worker
```

El worker se despliega desde `apps/cloud-worker-licensing/` con `pnpm exec wrangler deploy`.

## Documentación

- [docs/README.md](docs/README.md): índice de la documentación y qué va en cada sitio.
- [CLAUDE.md](CLAUDE.md): las reglas para trabajar en el código (pensado para el agente y válido para
  cualquiera).
- [docs/pendientes.md](docs/pendientes.md): lo que queda por hacer.
