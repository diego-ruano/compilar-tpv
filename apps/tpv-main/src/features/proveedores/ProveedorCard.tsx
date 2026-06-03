type ProveedorUI = {
	ID_Proveedor: number;
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
			className="w-fit text-left"
		>
			<div className="bg-blanco p-6 rounded-xl shadow-md w-[200px] border border-negro/10 hover:shadow-lg transition">

				{/* IMAGEN */}
				<div className="w-full h-[110px] rounded-base bg-gris flex items-center justify-center overflow-hidden border border-negro/10">
					{proveedor.urlImagen ? (
						<img
							src={proveedor.urlImagen}
							alt={proveedor.Nombre_Empresa}
							className="w-full h-full object-cover"
							draggable={false}
						/>
					) : (
						<span className="text-negro/50 font-semibold text-sm text-center px-2">
							{proveedor.Nombre_Empresa}
						</span>
					)}
				</div>

				{/* NOMBRE */}
				<h5 className="mt-6 mb-1 text-xl font-semibold tracking-tight text-negro truncate">
					{proveedor.Nombre_Empresa}
				</h5>

				{/* EMAIL */}
				<p className="text-sm text-negro/70 truncate">
					{proveedor.Email ?? "Sin email"}
				</p>

				{/* CTA */}
				<div className="flex items-center mt-3 text-negro">
					<p className="text-sm">Ver detalle</p>
					<svg
						className="w-4 h-4 ms-1.5 rtl:rotate-180 -me-0.5"
						aria-hidden="true"
						xmlns="http://www.w3.org/2000/svg"
						viewBox="0 0 24 24"
						fill="none"
					>
						<path
							stroke="currentColor"
							strokeLinecap="round"
							strokeLinejoin="round"
							strokeWidth="2"
							d="M19 12H5m14 0-4 4m4-4-4-4"
						/>
					</svg>
				</div>

			</div>
		</button>
	);
}
