// src/server/central/migraciones.ts
//
// El registro de migraciones de la base central. Las aplica su propio objeto al arrancar, si ya está
// aprovisionado, y al aprovisionarlo (`durableObjects/baseCentral.ts`), con el mismo runner y el
// mismo control que la base de cada negocio (`migrarBase`, en `durableObjects/sqliteDelObjeto.ts`):
// la tabla `_migrations` con el nombre y el hash de cada una.
//
// El bundler del worker no recoge una carpeta entera: cada migración se importa y se añade aquí, EN
// ORDEN. `scripts/check-migration-registry.mjs` comprueba que la lista y la carpeta `migraciones/`
// coinciden.
//
// ⚠️ Una migración de la central es aditiva y entra en un despliegue ANTERIOR al del código que la
// usa: durante un despliegue, un Worker nuevo puede hablar unos minutos con el objeto de antes, que
// todavía no la tiene.

import type { Migracion } from "../../durableObjects/sqliteDelObjeto";
import m0001 from "./migraciones/0001_inicial.sql";

export const MIGRACIONES_DE_LA_CENTRAL: readonly Migracion[] = [{ name: "0001_inicial.sql", sql: m0001 }];
