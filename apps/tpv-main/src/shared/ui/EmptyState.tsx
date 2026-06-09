// src/shared/ui/EmptyState.tsx
import React from "react";
import { cn } from "../lib/cn";

export interface EmptyStateProps extends React.HTMLAttributes<HTMLDivElement> {
    icon?: React.ReactNode;
    title: string;
    description?: string;
    /** Acción opcional (p. ej. un <Button/>). */
    action?: React.ReactNode;
}

function EmptyState({
    icon,
    title,
    description,
    action,
    className,
    ...rest
}: EmptyStateProps) {
    return (
        <div
            className={cn(
                "flex flex-col items-center justify-center text-center gap-3 p-8",
                className,
            )}
            {...rest}
        >
            {icon && (
                <div className="grid size-14 place-items-center rounded-2xl bg-surface-2 text-fg-subtle">
                    {icon}
                </div>
            )}
            <div className="space-y-1">
                <p className="text-base font-semibold text-fg">{title}</p>
                {description && (
                    <p className="text-sm text-fg-muted max-w-xs">{description}</p>
                )}
            </div>
            {action}
        </div>
    );
}

export default EmptyState;
