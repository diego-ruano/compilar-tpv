// src/domains/stats/stats.schemas.ts

import { z } from "zod";

export const rangeSchema = z.enum(["hoy", "semana", "mes", "anio"]).default("hoy");
export const turnoSchema = z.enum(["COMIDA", "CENA", "TODOS"]).default("TODOS");

export type StatsRange = z.infer<typeof rangeSchema>;
export type StatsTurno = z.infer<typeof turnoSchema>;
