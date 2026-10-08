import { expect, it } from "vitest";
import { enElHub } from "./helpers/hub";
import { setTurnoPartido } from "../src/domains/login/login.commands";

it("impide desmarcar una segunda parte abierta o cerrada dentro de la escritura SQL", async () => {
    await enElHub("ri83-fichaje-partido", async hub => {
        const sql = hub.state.storage.sql;
        sql.exec("CREATE TABLE Fichaje_Dia (ID_Usuario TEXT, Fecha TEXT, Turno_Partido INTEGER, PRIMARY KEY(ID_Usuario,Fecha));");
        sql.exec("CREATE TABLE Fichajes (ID_Usuario TEXT, Fecha TEXT, Parte INTEGER, Estado TEXT);");
        const ejecutar = (partido: boolean) => {
            const p = setTurnoPartido({ id_usuario: "u", fecha: "2026-10-08", turno_partido: partido }).command.payload;
            return sql.exec(p.sql, ...p.args).rowsWritten;
        };
        expect(ejecutar(true)).toBeGreaterThan(0);
        sql.exec("INSERT INTO Fichajes VALUES ('u','2026-10-08',2,'ABIERTO');");
        expect(ejecutar(false)).toBe(0);
        sql.exec("UPDATE Fichajes SET Estado='CERRADO';");
        expect(ejecutar(false)).toBe(0);
        expect(sql.exec("SELECT Turno_Partido AS partido FROM Fichaje_Dia;").one().partido).toBe(1);
    });
});
