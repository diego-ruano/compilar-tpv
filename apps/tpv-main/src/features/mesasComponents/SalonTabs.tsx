import type { Salon } from "./types";
import { cn } from "./cn";

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
        <div className="flex flex-wrap gap-2">
            {salons.map((s) => (
                <button
                    key={s.id}
                    type="button"
                    onClick={() => onChangeSalon(s.id)}
                    className={cn(
                        "cursor-pointer rounded-xl border px-3 py-2 text-sm font-semibold transition",
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
