// src/shared/ui/CampoDinero.tsx
//
// **El campo de dinero de la interfaz.** Todo formulario que pida un precio, un coste o un importe
// usa éste, y ninguno convierte nada por su cuenta (RI-53).
//
// ## Por qué existe
//
// ARQ-01 llevó los céntimos hasta la pantalla, pero cada formulario seguía leyendo su cuadro de
// texto a mano, y ninguno se enteró: un café dado de alta a «3» se guardaba a 3 céntimos, uno a
// «2,50» no se podía guardar y editar un gasto sin tocar el importe lo multiplicaba por 100. El
// fallo no era de un formulario, era que la conversión estaba en diez sitios. Aquí está en uno:
//
// - Hacia fuera sólo hay `Dinero | null`. El texto no sale nunca del componente, así que un
//   formulario no puede equivocarse de unidad: no tiene nada que convertir.
// - Por dentro rellena con `aTexto` y lee con `deTexto`, el único lector (`shared/lib/dinero.ts`).
// - Distingue «sin rellenar» (`valor` null, `legible` true) de «no se entiende» (`legible` false):
//   guardar un producto sin precio es legítimo, guardarlo porque el precio no se entendió no lo es.
//
// Es un campo de texto con teclado decimal y no un `type="number"`: éste deja la coma en manos de
// la configuración regional de la webview, y en un TPV español la coma es la tecla que se pulsa.

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { Dinero } from "@tpv/contracts";

import { cn } from "../lib/cn";
import { aTexto, deTexto, esVacio } from "../lib/dinero";

export type CampoDineroProps = {
    /** Lo que vale ahora. `null` = sin rellenar (o, con `legible` false, sin entender). */
    valor: Dinero | null;
    /** Cada pulsación: el importe leído y si el texto se entiende. */
    onCambio: (valor: Dinero | null, legible: boolean) => void;
    /**
     * Cambia para volver a pintar `valor` aunque sea el mismo que ya tenía (p. ej. al reabrir un
     * formulario que se quedó con un texto que no se entendía). Lo pone `useImporte`.
     */
    reinicio?: number;
    id?: string;
    placeholder?: string;
    disabled?: boolean;
    readOnly?: boolean;
    required?: boolean;
    autoFocus?: boolean;
    "aria-label"?: string;
    /** Clases del `<input>`. Sin ellas lleva el aspecto de `Input`; con ellas, sólo las suyas. */
    className?: string;
};

const ASPECTO_BASE =
    "h-10 w-full rounded-xl px-3 text-sm bg-surface-2 text-fg placeholder:text-fg-subtle " +
    "border border-border outline-none transition focus-visible:border-accent " +
    "focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

export function CampoDinero({
    valor,
    onCambio,
    reinicio = 0,
    id,
    placeholder = "0,00",
    disabled,
    readOnly,
    required,
    autoFocus,
    className,
    "aria-label": ariaLabel,
}: CampoDineroProps) {
    const [texto, setTexto] = useState(() => (valor == null ? "" : aTexto(valor)));
    const idError = useId();
    // Lo último que este campo ha mandado hacia fuera.
    const emitido = useRef<Dinero | null>(valor);

    // Un cambio que viene de fuera (rellenar al editar, vaciar al abrir) se pinta; el eco de lo
    // que se está tecleando, no: reescribir «2,5» como «2,50» a mitad de escribir movería el
    // cursor, y un texto que aún no se entiende (vale `null`) se borraría.
    useEffect(() => {
        if (valor === emitido.current) return;
        emitido.current = valor;
        setTexto(valor == null ? "" : aTexto(valor));
    }, [valor]);

    useEffect(() => {
        if (reinicio === 0) return;
        emitido.current = valor;
        setTexto(valor == null ? "" : aTexto(valor));
        // Sólo el reinicio: `valor` ya tiene su propio efecto.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [reinicio]);

    const legible = esVacio(texto) || deTexto(texto) !== null;

    return (
        <div className="relative w-full">
            <input
                id={id}
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={texto}
                onChange={(e) => {
                    const t = e.target.value;
                    const leido = deTexto(t);
                    setTexto(t);
                    emitido.current = leido;
                    onCambio(leido, esVacio(t) || leido !== null);
                }}
                placeholder={placeholder}
                disabled={disabled}
                readOnly={readOnly}
                required={required}
                autoFocus={autoFocus}
                aria-label={ariaLabel}
                aria-invalid={!legible}
                aria-describedby={legible ? undefined : idError}
                className={cn(className ?? ASPECTO_BASE, "pr-8", !legible && "border-danger")}
            />
            <span
                aria-hidden
                className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-fg-muted"
            >
                €
            </span>
            {!legible && (
                <p id={idError} className="mt-1 text-xs text-danger">
                    No se entiende «{texto.trim()}» como importe. Escríbelo así: 1.250,50
                </p>
            )}
        </div>
    );
}

/**
 * El estado de un `<CampoDinero>`, para no repetir dos `useState` en cada formulario.
 *
 * ```tsx
 * const precio = useImporte();
 * precio.poner(detalle.Precio_Venta);        // al abrir para editar
 * <CampoDinero id="…" {...precio.campo} />
 * if (!precio.legible) return aviso(…);       // al guardar
 * guardar({ precio_venta: precio.valor ?? undefined });
 * ```
 */
export function useImporte(inicial: Dinero | null = null) {
    const [valor, setValor] = useState<Dinero | null>(inicial);
    const [legible, setLegible] = useState(true);
    const [reinicio, setReinicio] = useState(0);

    // Estables, para poder ir en las dependencias de un efecto sin volver a dispararlo.
    const poner = useCallback((d: Dinero | null) => {
        setValor(d);
        setLegible(true);
        setReinicio((n) => n + 1);
    }, []);
    const onCambio = useCallback((v: Dinero | null, ok: boolean) => {
        setValor(v);
        setLegible(ok);
    }, []);

    return {
        /** El importe leído; `null` si no hay nada escrito o no se entiende. */
        valor,
        /** `false` si hay algo escrito que no es un importe: no se debe guardar. */
        legible,
        /** Rellena el campo desde fuera (abrir, editar, vaciar). Estable. */
        poner,
        /** Lo que se esparce en `<CampoDinero {...x.campo} />`. */
        campo: { valor, reinicio, onCambio },
    };
}

export default CampoDinero;
