import { useReducer } from "react";
import type { Table } from "./geometria";
type Modo = { tipo: "editar" | "vertice" | "borrar" } | { tipo: "colocar"; mesa: Table };
type Accion = { tipo: "cancelar" | "vertice" | "alternar_borrado" } | { tipo: "colocar"; mesa: Table };
export function reducirModo(modo: Modo, accion: Accion): Modo {
    switch (accion.tipo) {
        case "cancelar": return { tipo: "editar" };
        case "vertice": return { tipo: "vertice" };
        case "alternar_borrado": return { tipo: modo.tipo === "borrar" ? "editar" : "borrar" };
        case "colocar": return accion;
    }
}
export function useModoEditor() {
    const [modo, dispatch] = useReducer(reducirModo, { tipo: "editar" });
    return { dispatch, addPointArmed: modo.tipo === "vertice", deleteTableArmed: modo.tipo === "borrar",
        placeTableByClick: modo.tipo === "colocar", pendingTableDraft: modo.tipo === "colocar" ? modo.mesa : null };
}
