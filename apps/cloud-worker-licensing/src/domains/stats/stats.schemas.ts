// src/domains/stats/stats.schemas.ts

import * as z from "zod";
import type { StatsRange, StatsTurno } from "@tpv/contracts";

export const rangeSchema = z.enum(["hoy", "semana", "mes", "anio"]).default("hoy");
export const turnoSchema = z.enum(["COMIDA", "CENA", "TODOS"]).default("TODOS");

export type { StatsRange, StatsTurno };
