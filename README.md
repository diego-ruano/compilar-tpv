# TPV

Terminal punto de venta para hostelería. Una aplicación de escritorio para Windows (la **Main**, la caja
de la barra) que vende contra su propia base de datos aunque no haya internet, una aplicación Android para
los camareros (la **Handy**) que trabaja contra la nube, y un servicio en Cloudflare que replica los datos
entre las dos y gestiona las licencias. Cada cobro es una factura con su registro de facturación
encadenado. Esta rama no remite a la AEAT: Veri\*factu está en las ramas `con-verifactu` y
`con-verifactu-windows-7`.

| Pieza | Tecnología | Dónde |
|---|---|---|
| Aplicación (Main y Handy) | Tauri 2, React 19, TypeScript, Vite | `apps/tpv-main/` |
| Backend local | Rust, arquitectura hexagonal, SQLite (rusqlite) | `crates/*`, `apps/tpv-main/src-tauri/` |
| Nube | Cloudflare Worker (Hono), Durable Objects (la base de cada negocio en su `TenantHub` y la base central en `BaseCentral`), R2 | `apps/cloud-worker-licensing/` (desplegado como `tpv-api`) |
| Widget de reservas web | React 19, Vite, servido por el worker | `apps/reservas-web/` |
| Código compartido | Esquema SQL, tipos y funciones de los comandos generados desde Rust (`@tpv/contracts`, `@tpv/client`), colores, plano de mesas y el SDK de las reservas web | `packages/*` |

Dominios: mesas y comandas, venta rápida de barra, inventario con lotes, caja y cierre de caja, clientes,
reservas, proveedores y pedidos, tareas, personal y fichajes, estadísticas, configuración, licencias,
emparejamiento de dispositivos y registro de facturación.

## Empezar

Requisitos: Node 22.12 o posterior con **pnpm** (nunca npm), Rust (la versión que fija
`rust-toolchain.toml`), las herramientas de compilación de Windows y, para los tests de Rust,
`cargo install cargo-nextest --locked`.

```bash
pnpm install
pnpm tauri dev                # la aplicación de escritorio
cargo nextest run             # tests de Rust
pnpm --filter @tpv/main test  # tests del frontend
pnpm --filter tpv-api test    # tests del worker
```

El worker de producción se despliega desde GitHub con un tag `v<versión>`
([publicar-version.md](docs/guias/publicar-version.md)); a mano, `pnpm --filter tpv-api desplegar`, que
compila antes el widget de las reservas web.

## Documentación

- [docs/README.md](docs/README.md): índice de la documentación y qué va en cada sitio.
- [CLAUDE.md](CLAUDE.md): las reglas para trabajar en el código (pensado para el agente y válido para
  cualquiera).
- [docs/pendientes.md](docs/pendientes.md): lo que queda por hacer.
