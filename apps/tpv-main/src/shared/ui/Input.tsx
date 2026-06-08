// src/shared/ui/Input.tsx
import React from "react";
import { cn } from "../lib/cn";

export interface InputProps
    extends React.InputHTMLAttributes<HTMLInputElement> {
    /** Estado de error (borde rojo). */
    invalid?: boolean;
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
    ({ invalid = false, className, ...rest }, ref) => {
        return (
            <input
                ref={ref}
                className={cn(
                    "h-10 w-full rounded-xl px-3 text-sm",
                    "bg-surface-2 text-fg placeholder:text-fg-subtle",
                    "border outline-none transition",
                    invalid
                        ? "border-danger focus-visible:ring-2 focus-visible:ring-danger"
                        : "border-border focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-ring",
                    "disabled:opacity-50 disabled:pointer-events-none",
                    className,
                )}
                {...rest}
            />
        );
    },
);

Input.displayName = "Input";

export default Input;
