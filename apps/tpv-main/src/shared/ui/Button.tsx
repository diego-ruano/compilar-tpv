// src/shared/ui/Button.tsx
import React from "react";
import { Loader2 } from "lucide-react";
import { cn } from "../lib/cn";

export type ButtonVariant =
    | "primary"
    | "secondary"
    | "ghost"
    | "danger"
    | "success";

export type ButtonSize = "sm" | "md" | "lg";

const VARIANTS: Record<ButtonVariant, string> = {
    primary:
        "bg-accent text-accent-fg hover:bg-accent-hover shadow-sm",
    secondary:
        "bg-surface text-fg border border-border hover:bg-surface-2 shadow-sm",
    ghost:
        "bg-transparent text-fg hover:bg-surface-2",
    danger:
        "bg-danger text-danger-fg hover:opacity-90 shadow-sm",
    success:
        "bg-success text-success-fg hover:opacity-90 shadow-sm",
};

const SIZES: Record<ButtonSize, string> = {
    sm: "h-8 px-3 text-xs rounded-lg gap-1.5",
    md: "h-10 px-4 text-sm rounded-xl gap-2",
    lg: "h-12 px-5 text-base rounded-xl gap-2",
};

export interface ButtonProps
    extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: ButtonVariant;
    size?: ButtonSize;
    loading?: boolean;
    fullWidth?: boolean;
    leftIcon?: React.ReactNode;
    rightIcon?: React.ReactNode;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
    (
        {
            variant = "primary",
            size = "md",
            loading = false,
            fullWidth = false,
            leftIcon,
            rightIcon,
            disabled,
            className,
            children,
            type = "button",
            ...rest
        },
        ref,
    ) => {
        const isDisabled = disabled || loading;

        return (
            <button
                ref={ref}
                type={type}
                disabled={isDisabled}
                className={cn(
                    "inline-flex items-center justify-center font-semibold whitespace-nowrap select-none cursor-pointer",
                    "transition active:scale-[0.98]",
                    "disabled:opacity-50 disabled:pointer-events-none disabled:active:scale-100",
                    VARIANTS[variant],
                    SIZES[size],
                    fullWidth && "w-full",
                    className,
                )}
                {...rest}
            >
                {loading ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                    leftIcon
                )}
                {children}
                {!loading && rightIcon}
            </button>
        );
    },
);

Button.displayName = "Button";

export default Button;
