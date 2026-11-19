// src/features/ventaRapida/ui/VolverCard.tsx
import { ArrowLeft } from "lucide-react";

/** Primera tarjeta dentro de una categoría: vuelve a la lista de categorías. */
export default function VolverCard({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="
        group flex min-w-0 flex-col rounded-2xl border border-border bg-surface p-2 text-left shadow-sm
        transition hover:border-accent hover:bg-accent-soft active:scale-[0.99]
        cursor-pointer sm:p-3
      "
    >
      <div className="flex h-20 w-full items-center justify-center rounded-xl border border-border bg-surface-2 sm:h-28">
        <div className="grid size-10 place-items-center rounded-full bg-accent-soft text-accent transition group-hover:bg-accent group-hover:text-accent-fg sm:size-14">
          <ArrowLeft className="size-6 sm:size-7" aria-hidden />
        </div>
      </div>

      <p className="mt-1.5 text-xs font-bold text-fg sm:mt-2 sm:text-base">Volver a categorías</p>
    </button>
  );
}
