// src/shared/ui/SearchInput.tsx
import React from "react";
import { Search, X } from "lucide-react";
import { cn } from "../lib/cn";

export interface SearchInputProps
    extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange"> {
    value: string;
    onValueChange: (value: string) => void;
    /** Muestra botón de limpiar cuando hay texto (default: true). */
    clearable?: boolean;
    onClear?: () => void;
}

const SearchInput = React.forwardRef<HTMLInputElement, SearchInputProps>(
    (
        {
            value,
            onValueChange,
            clearable = true,
            onClear,
            placeholder = "Buscar...",
            className,
            ...rest
        },
        ref,
    ) => {
        const showClear = clearable && value.length > 0;

        const handleClear = () => {
            onValueChange("");
            onClear?.();
        };

        return (
            <div className={cn("relative", className)}>
                <Search
                    className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle"
                    aria-hidden
                />
                <input
                    ref={ref}
                    type="text"
                    value={value}
                    onChange={(e) => onValueChange(e.target.value)}
                    placeholder={placeholder}
                    className={cn(
                        "h-10 w-full rounded-xl pl-9 pr-9 text-sm",
                        "bg-surface-2 text-fg placeholder:text-fg-subtle",
                        "border border-border outline-none transition",
                        "focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-ring",
                        "disabled:opacity-50 disabled:pointer-events-none",
                    )}
                    {...rest}
                />
                {showClear && (
                    <button
                        type="button"
                        onClick={handleClear}
                        aria-label="Limpiar búsqueda"
                        title="Limpiar"
                        className="absolute right-2 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-md text-fg-subtle transition hover:bg-surface-3 hover:text-fg cursor-pointer"
                    >
                        <X className="size-4" aria-hidden />
                    </button>
                )}
            </div>
        );
    },
);

SearchInput.displayName = "SearchInput";

export default SearchInput;
