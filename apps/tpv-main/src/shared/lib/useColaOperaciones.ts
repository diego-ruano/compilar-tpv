import { useEffect, useRef, useState } from "react";
import { crearColaOperaciones } from "./colaOperaciones";

export function useColaOperaciones() {
    const montado = useRef(true);
    const [pendientes, setPendientes] = useState(0);
    const [cola] = useState(() => crearColaOperaciones(n => { if (montado.current) setPendientes(n); }));
    useEffect(() => {
        montado.current = true;
        return () => { montado.current = false; };
    }, []);
    return { cola, pendientes };
}
