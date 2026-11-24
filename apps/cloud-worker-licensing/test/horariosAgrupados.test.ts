import { expect, it } from "vitest";
import casos from "../../../crates/tpv-domain/src/horarios_casos.json";
import { asignacionGuardarSchema } from "../src/domains/trabajadores/trabajadores.schemas";
import { validarConMensaje } from "../src/lib/validacion";
import { guardarAsignacion, deleteAsignacion, copySemana } from "../src/domains/trabajadores/trabajadores.commands";
import { grupoAsignacion, filasSemana } from "../src/domains/trabajadores/trabajadores.queries";
import { buildApplyBatch } from "../src/durableObjects/tenantHub.lote";
import { enElHub } from "./helpers/hub";
import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { clienteSobre } from "./helpers/clienteSql";
import type { AsignacionGuardarInput } from "@tpv/contracts";

const entrada = (tramos = [["09:00", "14:00"], ["17:00", "22:00"]]): AsignacionGuardarInput => ({
    id_trabajador: "t", fecha: "2026-10-09", id_turno: "00000000-0000-7000-8000-000000000102", area: "Sala",
    tramos: tramos.map(([hora_inicio, hora_fin]) => ({ hora_inicio, hora_fin })),
});
function preparar(hub: any) {
    const sql = hub.state.storage.sql;
    crearEsquemaTenant(sql);
    sql.exec("INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre, Estado) SELECT 'u', ID_Rol, 'u@bar.test', 'h', 'Ana', 'Activo' FROM Roles WHERE Nombre_Rol = 'Administrador'; INSERT INTO Trabajadores (ID_Trabajador, ID_Usuario) VALUES ('t', 'u');");
    const db = clienteSobre(sql, hub.state.storage);
    const aplicar = async (comando: ReturnType<typeof guardarAsignacion>) => {
        const lote = buildApplyBatch(comando.command);
        const resultados = await db.batch(lote.middle);
        return { resultado: lote.resolveResult(resultados, 0), replica: lote.replicated };
    };
    const filas = () => sql.exec("SELECT * FROM Asignacion_Turnos ORDER BY Fecha, Hora_Inicio, ID_Asignacion;").toArray();
    return { sql, db, aplicar, filas };
}

it("valida los mismos casos de horarios que el dominio Rust, y dice lo mismo al rechazar", async () => {
    for (const caso of casos) {
        const datos = { ...entrada(caso.tramos), fecha: caso.fecha };
        const r = await validarConMensaje(asignacionGuardarSchema, datos);
        expect(r.success, caso.nombre).toBe(caso.valido);
        // VALID-03: el `message` de la respuesta, el mismo texto que la Main.
        if (!r.success) expect((r as { mensaje?: string }).mensaje, caso.nombre).toBe((caso as { mensaje?: string }).mensaje);
    }
});

it("crea, edita, copia y borra los dos tramos como un conjunto", async () => {
    await enElHub("horarios-grupo", async (hub: any) => {
        const { aplicar, filas, db } = preparar(hub);
        await aplicar(guardarAsignacion(entrada()));
        expect(filas()).toHaveLength(2);
        const grupo = filas()[0].ID_Grupo;
        expect(filas()[1].ID_Grupo).toBe(grupo);
        const id = String(filas()[0].ID_Asignacion);
        await aplicar(guardarAsignacion({ ...entrada([["10:00", "15:00"], ["18:00", "23:00"]]), id_asignacion: id }, await grupoAsignacion(db as any, id)));
        expect(filas().map((f: any) => f.Hora_Inicio)).toEqual(["10:00", "18:00"]);
        await aplicar(copySemana({ from_monday: "2026-10-05", to_monday: "2026-10-12", overwrite: false }, await filasSemana(db as any, "2026-10-05")));
        const copia = filas().filter((f: any) => f.Fecha === "2026-10-16");
        expect(copia).toHaveLength(2);
        expect(copia[0].ID_Grupo).toBe(copia[1].ID_Grupo);
        expect(copia[0].ID_Grupo).not.toBe(grupo);
        await aplicar(deleteAsignacion(id));
        expect(filas()).toHaveLength(2);
        expect(filas().every((f: any) => f.Fecha === "2026-10-16")).toBe(true);
    });
});

it("deshace el primer tramo si el segundo falla y rechaza el solape a medianoche", async () => {
    await enElHub("horarios-rollback", async (hub: any) => {
        const { aplicar, filas } = preparar(hub);
        await aplicar(guardarAsignacion(entrada([["13:00", "14:00"]])));
        const antes = filas();
        await expect(aplicar(guardarAsignacion(entrada([["09:00", "12:00"], ["13:00", "15:00"]])))).rejects.toThrow("horario_solapado");
        expect(filas()).toEqual(antes);
        await aplicar(guardarAsignacion(entrada([["22:00", "02:00"]])));
        await expect(aplicar(guardarAsignacion({ ...entrada([["01:00", "03:00"]]), fecha: "2026-10-10" }))).rejects.toThrow("horario_solapado");
        await aplicar(guardarAsignacion({ ...entrada([["02:00", "03:00"]]), fecha: "2026-10-10" }));
        expect(filas()).toHaveLength(3);
    });
});

it("no recrea un grupo que desapareció después de la lectura de edición", async () => {
    await enElHub("horarios-no-resucita", async (hub: any) => {
        const { aplicar, filas, db } = preparar(hub);
        await aplicar(guardarAsignacion(entrada()));
        const id = String(filas()[0].ID_Asignacion);
        const grupo = await grupoAsignacion(db as any, id);
        await aplicar(deleteAsignacion(id));
        const resultado = await aplicar(guardarAsignacion({ ...entrada(), id_asignacion: id }, grupo));
        expect(resultado.resultado).toBe(0);
        expect(filas()).toEqual([]);
    });
});

it("captura para la réplica los mismos identificadores del conjunto confirmado", async () => {
    await enElHub("horarios-replica", async (hub: any) => {
        const { aplicar, filas } = preparar(hub);
        const { replica } = await aplicar(guardarAsignacion(entrada()));
        const confirmadas = filas();
        await enElHub("horarios-replica-destino", async (destino: any) => {
            const { db, filas: recibidas } = preparar(destino);
            await db.batch(replica);
            expect(recibidas()).toEqual(confirmadas);
        });
    });
});
