import React from "react";
import { useBusinessSettings } from "../../shared/stores/useBusinessSettings";
import { useTicketSettings } from "../../shared/stores/useTicketSettings";
import TicketPaper from "./TicketPaper";
import { payloadDePrecuenta } from "../../features/configuracion/api/printerApis";
import type { Dinero } from "@tpv/contracts";

type TicketItemLike = {
	id: string;
	productoId: number;
	nombre: string;
	precio: Dinero;
	pagado?: boolean;
};

function cn(...classes: Array<string | false | undefined | null>) {
	return classes.filter(Boolean).join(" ");
}

// El marco sigue el tema; el papel (`TicketPaper`) es siempre blanco, como el que sale impreso.
// El ancho lo fija la medida común de las modales (Global.css); ésta la amplía.
function Modal({
	open,
	onClose,
	children,
	title,
}: {
	open: boolean;
	onClose: () => void;
	title?: string;
	children: React.ReactNode;
}) {
	if (!open) return null;

	return (
		<div
			className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-3"
			onMouseDown={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<div className="relative flex w-full flex-col rounded-2xl border border-border bg-surface text-fg shadow-xl [--modal-width:980px]">
				<button
					type="button"
					onClick={onClose}
					aria-label="Cerrar"
					className="absolute top-3 right-3 px-3 py-1 rounded-xl border border-border text-fg-muted hover:bg-surface-2 hover:text-fg transition"
				>
					✕
				</button>

				{title ? (
					<div className="px-5 pt-5 pb-3 border-b border-border">
						<h2 className="text-lg font-extrabold text-center text-fg">{title}</h2>
					</div>
				) : null}

				<div className="min-h-0 overflow-y-auto p-5">{children}</div>
			</div>
		</div>
	);
}

export default function TicketPreviewModal({
	open,
	onClose,
	items,
	onPrint,
}: {
	open: boolean;
	onClose: () => void;
	items: TicketItemLike[];
	onPrint?: () => void;
}) {
	const { iva_percent } = useBusinessSettings();
	const { settings } = useTicketSettings();
	// Se recompone en cada render: los dos hooks de arriba suscriben el modal a los stores, así que
	// tocar una casilla repinta la previa al momento. Es una precuenta: lo que imprime «Imprimir».
	const payload = payloadDePrecuenta(items);

	const empty = items.length === 0;

	return (
		<Modal open={open} onClose={onClose} title="Previsualización del ticket">
			<div className="grid grid-cols-1 lg:grid-cols-[1fr,320px] gap-4">
				<div className="flex justify-center">
					<TicketPaper payload={payload} />
				</div>

				<div className="rounded-2xl border border-border bg-surface-2 p-4 flex flex-col gap-3">
					<button
						type="button"
						className={cn(
							"px-4 py-3 rounded-xl font-bold transition",
							empty
								? "bg-surface text-fg-subtle cursor-not-allowed"
								: "bg-accent text-accent-fg hover:bg-accent-hover",
						)}
						disabled={empty}
						onClick={() => onPrint?.()}
					>
						Imprimir
					</button>

					<button
						type="button"
						className="px-4 py-3 rounded-xl border border-border bg-surface text-fg hover:bg-surface-2 font-semibold"
						onClick={onClose}
					>
						Cerrar
					</button>

					<div className="text-xs text-fg-muted">
						Ancho: {settings.paper_width_mm}mm · IVA: {iva_percent}%
					</div>
				</div>
			</div>
		</Modal>
	);
}
