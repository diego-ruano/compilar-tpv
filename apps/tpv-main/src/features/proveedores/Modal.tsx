import React, { useEffect, useRef } from "react";
import { X } from "lucide-react";

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
			className="fixed inset-0 flex items-center justify-center overflow-y-auto p-2 sm:p-4"
			aria-modal="true"
			role="dialog"
		>
			{/* Backdrop: click fuera cierra SOLO esta modal */}
			<button
				type="button"
				aria-label="Cerrar"
				onClick={() => onCloseRef.current()}
				className="absolute inset-0 h-full w-full cursor-pointer bg-black/50"
			/>

			{/* Panel */}
			<div
				ref={panelRef}
				tabIndex={-1}
				className={`relative flex max-h-[calc(100dvh-1rem)] w-full ${widthClass} flex-col overflow-hidden rounded-2xl border border-border bg-surface p-3 text-fg shadow-xl outline-none sm:max-h-[calc(100dvh-2rem)] sm:p-5`}
				onClick={(e) => e.stopPropagation()}
			>
				<div className="mb-4 flex shrink-0 items-center justify-between gap-3">
					<h3 className="min-w-0 break-words text-lg font-bold text-fg sm:text-xl">{title ?? ""}</h3>
					<button
						type="button"
						onClick={() => onCloseRef.current()}
						aria-label="Cerrar"
						className="grid size-9 cursor-pointer place-items-center rounded-xl border border-border text-fg-muted transition hover:bg-surface-2 hover:text-fg"
					>
						<X className="size-4" aria-hidden />
					</button>
				</div>

				<div className="min-h-0 overflow-y-auto overscroll-contain pr-1 [scrollbar-gutter:stable]">
					{children}
				</div>
			</div>
		</div>
	);
}
