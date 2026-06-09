// src/shared/ui/SectionHeader.tsx
import React from "react";
import { cn } from "../lib/cn";

export interface SectionHeaderProps
    extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
    title: React.ReactNode;
    subtitle?: React.ReactNode;
    /** Contenido alineado a la derecha (acciones, botones, etc.). */
    actions?: React.ReactNode;
}

function SectionHeader({
    title,
    subtitle,
    actions,
    className,
    ...rest
}: SectionHeaderProps) {
    return (
        <div
            className={cn(
                "flex items-start justify-between gap-3",
                className,
            )}
            {...rest}
        >
            <div className="min-w-0">
                <h2 className="text-lg font-semibold text-fg truncate">{title}</h2>
                {subtitle && (
                    <p className="mt-0.5 text-sm text-fg-muted truncate">{subtitle}</p>
                )}
            </div>
            {actions && (
                <div className="flex items-center gap-2 shrink-0">{actions}</div>
            )}
        </div>
    );
}

export default SectionHeader;
