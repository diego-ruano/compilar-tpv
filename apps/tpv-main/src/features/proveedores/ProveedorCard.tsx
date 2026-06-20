import { ArrowRight, ImageOff } from "lucide-react";
import ImageWithFallback from "../../shared/ui/ImageWithFallback";

type ProveedorUI = {
	ID_Proveedor: string;
	Nombre_Empresa: string;
	Email: string | null;
	urlImagen: string; // ← lo que ya calculas con convertFileSrc
};

export default function ProveedorCard({
	proveedor,
	onClick,
}: {
	proveedor: ProveedorUI;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="group w-full max-w-[240px] text-left"
		>
			<div className="rounded-2xl border border-border bg-surface p-4 shadow-sm transition hover:-translate-y-0.5 hover:border-border-strong hover:shadow-md">
				{/* IMAGEN */}
				<div className="flex h-[120px] w-full items-center justify-center overflow-hidden rounded-xl border border-border bg-surface-2">
					<ImageWithFallback
						src={proveedor.urlImagen}
						alt={proveedor.Nombre_Empresa}
						className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
						fallback={
							<div className="flex h-full w-full flex-col items-center justify-center gap-1 text-fg-subtle">
								<ImageOff className="size-6" aria-hidden />
								<span className="px-2 text-center text-xs font-semibold">
									{proveedor.Nombre_Empresa}
								</span>
							</div>
						}
					/>
				</div>

				{/* NOMBRE */}
				<h5 className="mt-4 mb-0.5 truncate text-lg font-semibold tracking-tight text-fg">
					{proveedor.Nombre_Empresa}
				</h5>

				{/* EMAIL */}
				<p className="truncate text-sm text-fg-muted">
					{proveedor.Email ?? "Sin email"}
				</p>

				{/* CTA */}
				<div className="mt-3 flex items-center gap-1.5 text-sm font-medium text-fg-muted transition group-hover:text-accent">
					<span>Ver detalle</span>
					<ArrowRight
						className="size-4 transition group-hover:translate-x-0.5"
						aria-hidden
					/>
				</div>
			</div>
		</button>
	);
}
