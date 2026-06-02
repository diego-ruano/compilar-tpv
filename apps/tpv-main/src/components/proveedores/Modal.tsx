import React, { useEffect, useRef } from "react";

export default function Modal({
	open,
	onClose,
	title,
	zIndex = 50,
	children,
	widthClass = "max-w-[820px]",
}: {
	open: boolean;
	onClose: () => void;
	title?: string;
	zIndex?: number;
	children: React.ReactNode;
	widthClass?: string;
}) {
	const panelRef = useRef<HTMLDivElement | null>(null);

	// ✅ Mantener siempre el último onClose sin re-disparar efectos
	const onCloseRef = useRef(onClose);
	useEffect(() => {
		onCloseRef.current = onClose;
	}, [onClose]);

	// ✅ Solo enfocar al ABRIR (no en cada render)
	const wasOpenRef = useRef(false);
	useEffect(() => {
		if (open && !wasOpenRef.current) {
			wasOpenRef.current = true;

			// OJO: si prefieres no forzar foco nunca, borra estas 2 líneas.
			setTimeout(() => panelRef.current?.focus(), 0);
		}

		if (!open) {
			wasOpenRef.current = false;
		}
	}, [open]);

	// ✅ Escape: listener estable, usando ref
	useEffect(() => {
		if (!open) return;

		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onCloseRef.current();
		};

		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open]);

	if (!open) return null;

	return (
		<div
			style={{ zIndex }}
			className="fixed inset-0 flex items-center justify-center"
			aria-modal="true"
			role="dialog"
		>
			{/* Backdrop: click fuera cierra SOLO esta modal */}
			<button
				type="button"
				aria-label="Cerrar"
				onClick={() => onCloseRef.current()}
				className="absolute inset-0 w-full h-full bg-black/40 cursor-pointer"
			/>

			{/* Panel */}
			<div
				ref={panelRef}
				tabIndex={-1}
				className={`relative w-[92vw] ${widthClass} bg-blanco rounded-xl shadow-xl border border-negro/10 p-5 outline-none`}
				onClick={(e) => e.stopPropagation()}
			>
				<div className="flex items-center justify-between gap-3 mb-4">
					<h3 className="text-xl font-bold text-negro">{title ?? ""}</h3>
					<button
						type="button"
						onClick={() => onCloseRef.current()}
						className="border-2 border-negro rounded-xl px-3 py-1 hover:bg-negro hover:text-white transition"
					>
						Cerrar
					</button>
				</div>

				{children}
			</div>
		</div>
	);
}
