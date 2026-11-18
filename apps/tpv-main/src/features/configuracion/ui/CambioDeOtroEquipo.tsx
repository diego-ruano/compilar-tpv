// src/features/configuracion/ui/CambioDeOtroEquipo.tsx
//
// CFG-INC-01: el aviso junto a un campo que aquí se ha cambiado y que otro equipo también ha cambiado
// mientras tanto. Guardar deja lo de aquí; descartar los cambios, lo del otro equipo.

/** `valor` es lo que puso el otro equipo; sin él (`undefined`) no hay aviso. `texto` lo sustituye. */
export function CambioDeOtroEquipo({ valor, texto }: { valor: string | number | null | undefined; texto?: string }) {
    if (valor === undefined) return null;
    const que =
        texto ??
        (valor === null || String(valor).trim() === ""
            ? "En otro equipo lo han dejado en blanco."
            : `En otro equipo lo han cambiado a «${String(valor)}».`);
    return (
        <p role="status" className="mt-1 text-xs text-warning">
            {que} Si guardas, se queda lo que has escrito aquí.
        </p>
    );
}
