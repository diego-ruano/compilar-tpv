// src/shared/ui/IconButton.tsx
import React from "react";
import { cn } from "../lib/cn";

type IconButtonVariant = "secondary" | "ghost" | "danger";
type IconButtonSize = "sm" | "md" | "lg";

const VARIANTS: Record<IconButtonVariant, string> = {
    secondary:
        "bg-surface text-fg border border-border hover:bg-surface-2 shadow-sm",
    ghost: "bg-transparent text-fg-muted hover:bg-surface-2 hover:text-fg",
    danger: "bg-transparent text-danger hover:bg-danger-soft",
};

const SIZES: Record<IconButtonSize, string> = {
    sm: "size-8 rounded-lg",
    md: "size-10 rounded-xl",
    lg: "size-12 rounded-xl",
};

export interface IconButtonProps
    extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: IconButtonVariant;
    size?: IconButtonSize;
    /** Texto accesible obligatorio (botón solo-icono). */
    label: string;
}

const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
    (
        {
            variant = "ghost",
            size = "md",
            label,
            className,
            children,
            type = "button",
            ...rest
        },
        ref,
    ) => {
        return (
            <button
                ref={ref}
                type={type}
                aria-label={label}
                title={label}
                className={cn(
                    "inline-flex items-center justify-center cursor-pointer select-none",
                    "transition active:scale-[0.95]",
                    "disabled:opacity-50 disabled:pointer-events-none disabled:active:scale-100",
                    VARIANTS[variant],
                    SIZES[size],
                    className,
                )}
                {...rest}
            >
                {children}
            </button>
        );
    },
);

IconButton.displayName = "IconButton";

export default IconButton;
