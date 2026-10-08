import { commands } from "@tpv/client";
// src/features/clientes/clientesApis.ts
//
// API de clientes: una función por comando Tauri, con los tipos que genera Specta desde Rust. Sin
// tipos propios ni mappers a otros nombres (RI-53): el gasto acumulado llega como `Dinero`.


import type {
    ClienteForm,
    ClienteOverview,
    CreateClienteInput,
    Dinero,
    UpdateClienteInput,
} from "@tpv/contracts";

export type { ClienteOverview };

export type FiltroRanking = "todos" | "reservas" | "gasto";

export const clientesGetOverview = commands.clientesGetOverview;

export function clientesGetClienteForm(idCliente: string): Promise<ClienteForm | null> {
    return commands.clientesGetClienteForm({ id_cliente: idCliente });
}

/**
 * Rehace el gasto acumulado del cliente desde sus pagos (DB-14) y devuelve el valor resultante,
 * o `null` si el cliente ya no existe.
 *
 * El job de reconciliación solo AVISA de los descuadres; corregirlos es una decisión de quien
 * lleva el negocio, y esta es la llamada que la ejecuta.
 */
export const clientesRecalcularGasto = commands.clientesRecalcularGasto;
