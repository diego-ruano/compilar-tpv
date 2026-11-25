// src/shared/ui/Badge.tsx
import React from "react";
import { cn } from "../lib/cn";

type BadgeTone =
    | "neutral"
    | "accent"
    | "success"
    | "danger"
    | "warning";

const TONES: Record<BadgeTone, string> = {
    neutral: "bg-surface-2 text-fg-muted border border-border",
    accent: "bg-accent-soft text-accent",
    success: "bg-success-soft text-success",
    danger: "bg-danger-soft text-danger",
    warning: "bg-warning-soft text-warning",
};

interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
    tone?: BadgeTone;
}

function Badge({ tone = "neutral", className, children, ...rest }: BadgeProps) {
    return (
        <span
            className={cn(
                "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap",
                TONES[tone],
                className,
            )}
            {...rest}
        >
            {children}
        </span>
    );
}

export default Badge;
