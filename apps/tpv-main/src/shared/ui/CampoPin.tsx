// src/shared/ui/CampoPin.tsx
//
// **El campo de PIN de la interfaz** (TRA-INC-03): oculto mientras se escribe, con teclado
// numérico y el ojo del login para verlo a propósito. El alta y la edición de un trabajador lo
// tenían en claro, a la vista de quien estuviera al lado. Sólo admite cifras, como el teclado del
// fichaje.

import { Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import { cn } from "../lib/cn";
import IconButton from "./IconButton";
import Input, { type InputProps } from "./Input";

/** El fichaje admite de 4 a 6 cifras. */
const MAX_CIFRAS = 6;

type CampoPinProps = Omit<
    InputProps,
    "type" | "value" | "onChange" | "inputMode" | "autoComplete" | "pattern" | "maxLength"
> & {
    valor: string;
    onCambio: (valor: string) => void;
    /** Clases del contenedor (el margen va aquí, para que el ojo quede centrado en el campo). */
    claseContenedor?: string;
};

export function CampoPin({
    valor,
    onCambio,
    className,
    claseContenedor,
    disabled,
    ...resto
}: CampoPinProps) {
    const [visible, setVisible] = useState(false);
    return (
        <div className={cn("relative", claseContenedor)}>
            <Input
                {...resto}
                disabled={disabled}
                type={visible ? "text" : "password"}
                inputMode="numeric"
                pattern="[0-9]*"
                // Un PIN que se elige, no uno que se recuerda: que el navegador no lo rellene ni
                // ofrezca guardarlo.
                autoComplete="new-password"
                maxLength={MAX_CIFRAS}
                value={valor}
                onChange={(e) => onCambio(e.target.value.replace(/\D/g, "").slice(0, MAX_CIFRAS))}
                className={cn("pr-11", className)}
            />
            <IconButton
                size="sm"
                variant="ghost"
                label={visible ? "Ocultar PIN" : "Mostrar PIN"}
                aria-pressed={visible}
                disabled={disabled}
                onClick={() => setVisible((v) => !v)}
                className="absolute right-1.5 top-1/2 -translate-y-1/2"
            >
                {visible ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
            </IconButton>
        </div>
    );
}
