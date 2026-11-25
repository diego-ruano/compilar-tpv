// src/shared/ui/Card.tsx
import React from "react";
import { cn } from "../lib/cn";

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
    /** Padding interno por defecto (p-4). Desactívalo para controlarlo tú. */
    padded?: boolean;
    /** Añade hover/cursor para tarjetas clicables. */
    interactive?: boolean;
}

/**
 * Contenedor base (tarjeta / panel) sobre tokens.
 * Sirve tanto para cards pequeñas como para paneles grandes (usa className).
 */
const Card = React.forwardRef<HTMLDivElement, CardProps>(
    ({ padded = true, interactive = false, className, children, ...rest }, ref) => {
        return (
            <div
                ref={ref}
                className={cn(
                    "rounded-2xl border border-border bg-surface text-fg shadow-sm",
                    padded && "p-4",
                    interactive &&
                        "cursor-pointer transition hover:bg-surface-2 hover:border-border-strong active:scale-[0.99]",
                    className,
                )}
                {...rest}
            >
                {children}
            </div>
        );
    },
);

Card.displayName = "Card";

export default Card;
