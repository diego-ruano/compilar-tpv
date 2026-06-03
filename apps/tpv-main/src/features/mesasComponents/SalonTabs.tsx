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
                        "px-3 py-2 rounded-xl border text-sm font-semibold transition",
                        s.id === activeSalonId
                            ? "border-black bg-black text-white"
                            : "border-black/10 bg-white hover:bg-black/5",
                    )}
                >
                    {s.name}
                </button>
            ))}
        </div>
    );
}
