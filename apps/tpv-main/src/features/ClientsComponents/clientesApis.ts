// src/features/ClientsComponents/clientesApis.ts
//
// API de clientes: una función por comando Tauri, con los tipos que genera ts-rs desde Rust. Sin
// tipos propios ni mappers a otros nombres (RI-53): el gasto acumulado llega como `Dinero`.

import { invokeClient } from "@tpv/client";
import type {
    ClienteForm,
    ClienteOverview,
    CreateClienteInput,
    Dinero,
    UpdateClienteInput,
} from "@tpv/contracts";

export type { ClienteOverview };

export type FiltroRanking = "todos" | "reservas" | "gasto";

export function clientesGetOverview(params: { ranking: FiltroRanking }): Promise<ClienteOverview[]> {
    return invokeClient<ClienteOverview[]>("clientes_get_overview", {
        args: { ranking: params.ranking },
    });
}

export function clientesGetClienteForm(idCliente: string): Promise<ClienteForm | null> {
    return invokeClient<ClienteForm | null>("clientes_get_cliente_form", {
        args: { id_cliente: idCliente },
    });
}

export function clientesCreateCliente(args: CreateClienteInput): Promise<boolean> {
    return invokeClient<boolean>("clientes_create_cliente", { args });
}

/**
 * Rehace el gasto acumulado del cliente desde sus pagos (DB-14) y devuelve el valor resultante,
 * o `null` si el cliente ya no existe.
 *
 * El job de reconciliación solo AVISA de los descuadres; corregirlos es una decisión de quien
 * lleva el negocio, y esta es la llamada que la ejecuta.
 */
export function clientesRecalcularGasto(params: { idCliente: string }): Promise<Dinero | null> {
    return invokeClient<Dinero | null>("clientes_recalcular_gasto", {
        args: { id_cliente: params.idCliente },
    });
}

export function clientesUpdateCliente(args: UpdateClienteInput): Promise<boolean> {
    return invokeClient<boolean>("clientes_update_cliente", { args });
}
