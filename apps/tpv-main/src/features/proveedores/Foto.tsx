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
			<label className="text-sm font-semibold text-fg">{label}</label>

			<div className="flex items-start gap-4">
				<div className="flex h-[130px] w-[130px] shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border bg-surface-2">
					{shownUrl ? (
						<img
							src={shownUrl}
							alt="Foto proveedor"
							className="h-full w-full object-cover"
							draggable={false}
						/>
					) : (
						<span className="text-sm font-semibold text-fg-subtle">Sin foto</span>
					)}
				</div>

				<div className="flex flex-col gap-2">
					<div className="flex flex-wrap gap-2">
						<button
							type="button"
							onClick={pickFile}
							className="min-w-0 cursor-pointer whitespace-normal break-words rounded-xl bg-accent px-3 py-2 text-center font-semibold leading-tight text-accent-fg shadow-sm transition hover:bg-accent-hover"
						>
							{shownUrl ? "Cambiar foto" : "Añadir foto"}
						</button>

						{(shownUrl || (!removeCurrent && currentUrl) || file) && (
							<button
								type="button"
								onClick={eliminarFoto}
								className="cursor-pointer rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 font-semibold text-danger transition hover:opacity-90"
							>
								Eliminar
							</button>
						)}
					</div>

					<p className="max-w-[380px] text-xs text-fg-muted">
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
