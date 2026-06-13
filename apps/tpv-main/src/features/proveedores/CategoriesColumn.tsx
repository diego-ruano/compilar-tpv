import { useMemo } from "react";
import { cn } from "../../shared/lib/cn";

export type Categoria = {
	ID_Categoria: string;
	Nombre: string;
	Nombre_Imagen: string | null;
	Ruta_Imagen: string | null;
};

export type ProductoMin = {
	ID_Producto: string;
	ID_Categoria: string | null;
};

export default function CategoriesColumn({
	categorias,
	productos,
	categoriaActivaId,
	setCategoriaActivaId,
}: {
	categorias: Categoria[];
	productos: ProductoMin[];
	categoriaActivaId: string | null;
	setCategoriaActivaId: (id: string | null) => void;
}) {
	const countAll = productos.length;

	const countByCat = useMemo(() => {
		const map = new Map<string, number>();
		for (const p of productos) {
			const id = p.ID_Categoria;
			if (id == null) continue;
			map.set(id, (map.get(id) ?? 0) + 1);
		}
		return map;
	}, [productos]);

	const itemClass = (active: boolean) =>
		cn(
			"w-full border-b border-border px-3 py-2 text-left transition cursor-pointer",
			active
				? "border-l-4 border-l-accent bg-accent-soft"
				: "hover:bg-surface-2",
		);

	return (
		<div className="w-[280px] shrink-0">
			<div className="overflow-hidden rounded-2xl border border-border bg-surface">
				<div className="border-b border-border px-3 py-2 font-semibold text-fg">
					Categorías
				</div>

				<div className="max-h-[55vh] overflow-auto">
					<button
						type="button"
						onClick={() => setCategoriaActivaId(null)}
						className={itemClass(categoriaActivaId === null)}
					>
						<div className="font-semibold text-fg">Todas</div>
						<div className="text-xs text-fg-muted">{countAll} productos</div>
					</button>

					{categorias.length === 0 ? (
						<div className="p-3 text-sm text-fg-muted">No hay categorías creadas.</div>
					) : (
						categorias.map((c) => {
							const active = c.ID_Categoria === categoriaActivaId;
							const count = countByCat.get(c.ID_Categoria) ?? 0;

							return (
								<button
									key={c.ID_Categoria}
									type="button"
									onClick={() => setCategoriaActivaId(c.ID_Categoria)}
									className={itemClass(active)}
								>
									<div className="truncate font-semibold text-fg">{c.Nombre}</div>
									<div className="text-xs text-fg-muted">{count} productos</div>
								</button>
							);
						})
					)}
				</div>
			</div>
		</div>
	);
}
