import { ArrowRight, ImageOff } from "lucide-react";
import type { ProveedorDto } from "@tpv/contracts";

import ImageWithFallback from "../../shared/ui/ImageWithFallback";

type ProveedorUI = Pick<ProveedorDto, "id_proveedor" | "nombre_empresa" | "email"> & {
	urlImagen: string;
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
			className="group w-full min-w-0 text-left"
		>
			<div className="rounded-2xl border border-border bg-surface p-3 shadow-sm transition hover:-translate-y-0.5 hover:border-border-strong hover:shadow-md">
				{/* IMAGEN */}
				<div className="flex h-20 w-full items-center justify-center overflow-hidden rounded-xl border border-border bg-surface-2">
					<ImageWithFallback
						src={proveedor.urlImagen}
						alt={proveedor.nombre_empresa}
						className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
						fallback={
							<div className="flex h-full w-full flex-col items-center justify-center gap-1 text-fg-subtle">
								<ImageOff className="size-5" aria-hidden />
								<span className="px-2 text-center text-xs font-semibold">
									{proveedor.nombre_empresa}
								</span>
							</div>
						}
					/>
				</div>

				{/* NOMBRE + VER DETALLE */}
				<div className="mt-2 flex items-center justify-between gap-1">
					<h5 className="min-w-0 truncate text-base font-semibold tracking-tight text-fg">
						{proveedor.nombre_empresa}
					</h5>
					<div className="flex shrink-0 items-center gap-0.5 text-xs font-medium text-fg-muted transition group-hover:text-accent">
						<span>Ver detalle</span>
						<ArrowRight
							className="size-3.5 transition group-hover:translate-x-0.5"
							aria-hidden
						/>
					</div>
				</div>

				{/* EMAIL */}
				<p className="truncate text-xs text-fg-muted">
					{proveedor.email ?? "Sin email"}
				</p>
			</div>
		</button>
	);
}
