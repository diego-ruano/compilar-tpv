import { useReducer } from "react";
import type { Table } from "./geometria";
// `web`: pulsar una mesa abre su configuración de reservas desde la web (docs/estudios/reservas-web.md).
type Modo = { tipo: "editar" | "vertice" | "borrar" | "web" } | { tipo: "colocar"; mesa: Table };
type Accion = { tipo: "cancelar" | "vertice" | "alternar_borrado" | "alternar_web" } | { tipo: "colocar"; mesa: Table };
export function reducirModo(modo: Modo, accion: Accion): Modo {
    switch (accion.tipo) {
        case "cancelar": return { tipo: "editar" };
        case "vertice": return { tipo: "vertice" };
        case "alternar_borrado": return { tipo: modo.tipo === "borrar" ? "editar" : "borrar" };
        case "alternar_web": return { tipo: modo.tipo === "web" ? "editar" : "web" };
        case "colocar": return accion;
    }
}
export function useModoEditor() {
    const [modo, dispatch] = useReducer(reducirModo, { tipo: "editar" });
    return { dispatch, addPointArmed: modo.tipo === "vertice", deleteTableArmed: modo.tipo === "borrar",
        webTableArmed: modo.tipo === "web",
        placeTableByClick: modo.tipo === "colocar", pendingTableDraft: modo.tipo === "colocar" ? modo.mesa : null };
}
