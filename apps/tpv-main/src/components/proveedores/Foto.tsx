import { useEffect, useRef, useState } from "react";

type Props = {
	label?: string;

	// URL de la foto actual (ya guardada en DB)
	currentUrl?: string | null;

	// Estado controlado desde el padre
	file: File | null;
	setFile: (f: File | null) => void;

	// Marcar si el usuario quiere eliminar la foto existente
	removeCurrent: boolean;
	setRemoveCurrent: (v: boolean) => void;
};

export default function ProveedorFotoField({
	label = "Foto",
	currentUrl,
	file,
	setFile,
	removeCurrent,
	setRemoveCurrent,
}: Props) {
	const inputRef = useRef<HTMLInputElement | null>(null);
	const [previewUrl, setPreviewUrl] = useState<string | null>(null);

	// Preview cuando hay file seleccionado
	useEffect(() => {
		if (!file) {
			setPreviewUrl(null);
			return;
		}
		const url = URL.createObjectURL(file);
		setPreviewUrl(url);
		return () => URL.revokeObjectURL(url);
	}, [file]);

	const shownUrl = file ? previewUrl : removeCurrent ? null : currentUrl ?? null;

	function pickFile() {
		inputRef.current?.click();
	}

	function onChangeFile(e: React.ChangeEvent<HTMLInputElement>) {
		const f = e.target.files?.[0] ?? null;
		if (!f) return;

		// si eliges una foto, ya no estás eliminando la actual
		setRemoveCurrent(false);
		setFile(f);

		// importante: permitir volver a elegir el mismo archivo si luego lo borras
		// (cuando borres, resetearemos value="")
	}

	function eliminarFoto() {
		// Eliminar = dejar sin foto (ni actual ni nueva)
		setFile(null);
		setRemoveCurrent(true);

		// ✅ reset del input para poder elegir otra vez (incluso el mismo archivo)
		if (inputRef.current) inputRef.current.value = "";
	}

	return (
		<div className="flex flex-col gap-2">
			<label className="font-semibold text-negro">{label}</label>

			<div className="flex items-start gap-4">
				<div className="w-[130px] h-[130px] rounded-xl border-2 border-negro bg-gris overflow-hidden flex items-center justify-center shrink-0">
					{shownUrl ? (
						<img
							src={shownUrl}
							alt="Foto proveedor"
							className="w-full h-full object-cover"
							draggable={false}
						/>
					) : (
						<span className="text-negro/50 font-semibold text-sm">Sin foto</span>
					)}
				</div>

				<div className="flex flex-col gap-2">
					<div className="flex gap-2 flex-wrap">
						<button
							type="button"
							onClick={pickFile}
							className="border-2 border-verde text-verde rounded-xl px-3 py-2 hover:bg-verde hover:text-white transition font-semibold"
						>
							{shownUrl ? "Cambiar foto" : "Añadir foto"}
						</button>

						{(shownUrl || (!removeCurrent && currentUrl) || file) && (
							<button
								type="button"
								onClick={eliminarFoto}
								className="border-2 border-rojo text-rojo rounded-xl px-3 py-2 hover:bg-rojo hover:text-white transition font-semibold"
							>
								Eliminar
							</button>
						)}
					</div>

					<p className="text-xs text-negro/60 max-w-[380px]">
						PNG/JPG. La imagen se recorta para encajar. (No es redimensionable con el ratón)
					</p>

					<input
						ref={inputRef}
						type="file"
						accept="image/*"
						onChange={onChangeFile}
						className="hidden"
					/>
				</div>
			</div>
		</div>
	);
}
