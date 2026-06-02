import {
    applyTenantHubTransaction,
    deriveChildOpId,
    sqlRef,
} from "./tenantHubWrites";

type BarraWriteParams = {
    env: any;
    tenantId: string;
    opId: string;
    commandName: string;
    deviceId?: string | null;
};

const COMMAND_MESA_BARRA = "mesas.getOrCreateMesaBarra";
const COMMAND_COMANDA_BARRA = "comandas.getOrCreateBarra";

function asNumber(value: unknown, fallback = 0): number {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

export async function ensureMesaBarraThroughTenantHub(
    params: BarraWriteParams,
): Promise<number> {
    const opId = deriveChildOpId(params.opId, "ensureMesaBarra");

    const domainArgs = {
        numero_mesa: "BARRA",
    };

    const cloudPayload = {
        op_id: opId,
        command_name: COMMAND_MESA_BARRA,
        args: domainArgs,
    };

    const mesaId = asNumber(
        await applyTenantHubTransaction<number>({
            env: params.env,
            tenantId: params.tenantId,
            opId,
            commandName: COMMAND_MESA_BARRA,
            deviceId: params.deviceId,
            beginMode: "immediate",
            steps: [
                {
                    kind: "value",
                    saveAs: "existing_mesa",
                    sql: `
                        SELECT ID_Mesa
                        FROM Mesas
                        WHERE Numero_Mesa = 'BARRA'
                        LIMIT 1;
                    `,
                    args: [],
                },
                {
                    kind: "value",
                    saveAs: "first_zone",
                    sql: `
                        SELECT ID_Zona
                        FROM Zonas
                        ORDER BY ID_Zona ASC
                        LIMIT 1;
                    `,
                    args: [],
                },
                {
                    kind: "execute",
                    sql: `
                        INSERT INTO Zonas (Nombre_Zona, Room_Points, Updated_At)
                        SELECT 'Salon', '[]', datetime('now','localtime')
                        WHERE COALESCE(?1, 0) <= 0;
                    `,
                    args: [sqlRef("first_zone")],
                },
                {
                    kind: "value",
                    saveAs: "zone_id_final",
                    sql: `
                        SELECT ID_Zona
                        FROM Zonas
                        ORDER BY ID_Zona ASC
                        LIMIT 1;
                    `,
                    args: [],
                },
                {
                    kind: "execute",
                    sql: `
                        INSERT INTO Mesas (
                          ID_Zona,
                          Numero_Mesa,
                          Capacidad,
                          Ubicacion_X,
                          Ubicacion_Y,
                          Shape,
                          Width,
                          Height,
                          Radius,
                          Updated_At,
                          Es_Sistema
                        )
                        SELECT
                          ?2,
                          'BARRA',
                          0,
                          0,
                          0,
                          'rect',
                          80,
                          50,
                          NULL,
                          datetime('now','localtime'),
                          1
                        WHERE COALESCE(?1, 0) <= 0;
                    `,
                    args: [sqlRef("existing_mesa"), sqlRef("zone_id_final")],
                },
                {
                    kind: "value",
                    saveAs: "mesa_id_final",
                    sql: `
                        SELECT ID_Mesa
                        FROM Mesas
                        WHERE Numero_Mesa = 'BARRA'
                        LIMIT 1;
                    `,
                    args: [],
                },
                {
                    kind: "value",
                    saveAs: "result_mesa_id",
                    sql: `SELECT ?1;`,
                    args: [sqlRef("mesa_id_final")],
                },
            ],
            resultKey: "result_mesa_id",
            cloudPayload,
            requestPayload: cloudPayload,
        }),
        0,
    );

    if (!(mesaId > 0)) {
        throw new Error("No se pudo crear/encontrar la mesa BARRA.");
    }

    return mesaId;
}

export async function getOrCreateComandaBarraThroughTenantHub(
    params: BarraWriteParams & { idTrabajador?: number | null },
): Promise<number> {
    const idMesaBarra = await ensureMesaBarraThroughTenantHub(params);
    const opId = deriveChildOpId(params.opId, "getOrCreateComandaBarra");

    const idTrabajador =
        params.idTrabajador != null && Number(params.idTrabajador) > 0
            ? Number(params.idTrabajador)
            : null;

    const domainArgs = {
        id_trabajador: idTrabajador,
    };

    const cloudPayload = {
        op_id: opId,
        command_name: COMMAND_COMANDA_BARRA,
        args: domainArgs,
    };

    const idComanda = asNumber(
        await applyTenantHubTransaction<number>({
            env: params.env,
            tenantId: params.tenantId,
            opId,
            commandName: COMMAND_COMANDA_BARRA,
            deviceId: params.deviceId,
            beginMode: "immediate",
            steps: [
                {
                    kind: "value",
                    saveAs: "existing_id",
                    sql: `
                        SELECT ID_Comanda
                        FROM Comandas
                        WHERE ID_Mesa = ?1
                          AND Estado = 'Abierta'
                        ORDER BY ID_Comanda DESC
                        LIMIT 1;
                    `,
                    args: [idMesaBarra],
                },
                {
                    kind: "execute",
                    sql: `
                        UPDATE Comandas
                        SET ID_Trabajador = COALESCE(ID_Trabajador, ?2)
                        WHERE ID_Comanda = ?1
                          AND COALESCE(?1, 0) > 0;
                    `,
                    args: [sqlRef("existing_id"), idTrabajador],
                },
                {
                    kind: "execute",
                    sql: `
                        INSERT INTO Comandas (
                          ID_Mesa,
                          ID_Trabajador,
                          Fecha_Hora_Apertura,
                          Total_Comanda,
                          Estado
                        )
                        SELECT
                          ?1,
                          ?2,
                          datetime('now','localtime'),
                          0,
                          'Abierta'
                        WHERE COALESCE(?3, 0) <= 0;
                    `,
                    args: [
                        idMesaBarra,
                        idTrabajador,
                        sqlRef("existing_id"),
                    ],
                },
                {
                    kind: "value",
                    saveAs: "final_id",
                    sql: `
                        SELECT CASE
                            WHEN COALESCE(?1, 0) > 0 THEN ?1
                            ELSE last_insert_rowid()
                        END;
                    `,
                    args: [sqlRef("existing_id")],
                },
                {
                    kind: "value",
                    saveAs: "result_id_comanda",
                    sql: `SELECT ?1;`,
                    args: [sqlRef("final_id")],
                },
            ],
            resultKey: "result_id_comanda",
            cloudPayload,
            requestPayload: cloudPayload,
        }),
        0,
    );

    if (!(idComanda > 0)) {
        throw new Error("No se pudo abrir comanda para BARRA.");
    }

    return idComanda;
}