import { useMemo } from "react";

export type Categoria = {
	ID_Categoria: number;
	Nombre: string;
	Nombre_Imagen: string | null;
	Ruta_Imagen: string | null;
};

export type ProductoMin = {
	ID_Producto: number;
	ID_Categoria: number | null;
};

export default function CategoriesColumn({
	categorias,
	productos,
	categoriaActivaId,
	setCategoriaActivaId,
}: {
	categorias: Categoria[];
	productos: ProductoMin[];
	categoriaActivaId: number | null;
	setCategoriaActivaId: (id: number | null) => void;
}) {
	const countAll = productos.length;

	const countByCat = useMemo(() => {
		const map = new Map<number, number>();
		for (const p of productos) {
			const id = p.ID_Categoria;
			if (id == null) continue;
			map.set(id, (map.get(id) ?? 0) + 1);
		}
		return map;
	}, [productos]);

	return (
		<div className="w-[280px] shrink-0">
			<div className="border border-negro/10 rounded-xl overflow-hidden bg-white">
				<div className="px-3 py-2 border-b border-negro/10 font-semibold text-negro">Categorías</div>

				<div className="max-h-[55vh] overflow-auto">
					<button
						type="button"
						onClick={() => setCategoriaActivaId(null)}
						className={`w-full text-left px-3 py-2 border-b border-negro/10 transition ${categoriaActivaId === null ? "bg-verde/10 border-l-4 border-l-verde" : "hover:bg-gris/40"
							}`}
					>
						<div className="font-semibold text-negro">Todas</div>
						<div className="text-xs text-negro/60">{countAll} productos</div>
					</button>

					{categorias.length === 0 ? (
						<div className="p-3 text-sm text-negro/60">No hay categorías creadas.</div>
					) : (
						categorias.map((c) => {
							const active = Number(categoriaActivaId) === Number(c.ID_Categoria);
							const count = countByCat.get(c.ID_Categoria) ?? 0;

							return (
								<button
									key={c.ID_Categoria}
									type="button"
									onClick={() => setCategoriaActivaId(Number(c.ID_Categoria))}
									className={`w-full text-left px-3 py-2 border-b border-negro/10 transition ${active ? "bg-verde/10 border-l-4 border-l-verde" : "hover:bg-gris/40"
										}`}
								>
									<div className="font-semibold text-negro truncate">{c.Nombre}</div>
									<div className="text-xs text-negro/60">{count} productos</div>
								</button>
							);
						})
					)}
				</div>
			</div>
		</div>
	);
}
