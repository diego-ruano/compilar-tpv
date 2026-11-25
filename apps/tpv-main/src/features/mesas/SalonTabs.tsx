import type { Salon } from "./types";
import { cn } from "../../shared/lib/cn";

export default function SalonTabs({
    salons,
    activeSalonId,
    onChangeSalon,
}: {
    salons: Salon[];
    activeSalonId: string;
    onChangeSalon: (id: string) => void;
}) {
    return (
        <div className="flex min-w-0 max-w-full flex-1 gap-1.5 overflow-x-auto pb-1 [scrollbar-gutter:stable] sm:gap-2">
            {salons.map((s) => (
                <button
                    key={s.id}
                    type="button"
                    onClick={() => onChangeSalon(s.id)}
                    className={cn(
                        "shrink-0 cursor-pointer whitespace-nowrap rounded-xl border px-2.5 py-1.5 text-xs font-semibold transition sm:px-3 sm:py-2 sm:text-sm",
                        s.id === activeSalonId
                            ? "border-accent bg-accent text-white shadow-sm"
                            : "border-border bg-surface text-fg-muted hover:bg-surface-2 hover:text-fg",
                    )}
                >
                    {s.name}
                </button>
            ))}
        </div>
    );
}
