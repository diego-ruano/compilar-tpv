import React from "react";
import { useBusinessSettings } from "../../shared/stores/useBusinessSettings";
import { useTicketSettings } from "../../shared/stores/useTicketSettings";
import TicketPaper from "./TicketPaper";

type TicketItemLike = {
	id: string;
	productoId: number;
	nombre: string;
	precio: number;
	pagado?: boolean;
};

function cn(...classes: Array<string | false | undefined | null>) {
	return classes.filter(Boolean).join(" ");
}

function Modal({
	open,
	onClose,
	children,
	title,
	maxWidthClass = "max-w-[980px]",
}: {
	open: boolean;
	onClose: () => void;
	title?: string;
	maxWidthClass?: string;
	children: React.ReactNode;
}) {
	if (!open) return null;

	return (
		<div
			className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-3"
			onMouseDown={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<div className={cn("bg-blanco w-full", maxWidthClass, "rounded-2xl shadow-xl border border-black/10 relative")}>
				<button
					type="button"
					onClick={onClose}
					className="absolute top-3 right-3 px-3 py-1 rounded-xl border border-negro/20 hover:bg-gris transition"
				>
					✕
				</button>

				{title ? (
					<div className="px-5 pt-5 pb-3 border-b border-black/10">
						<h2 className="text-lg font-extrabold text-center">{title}</h2>
					</div>
				) : null}

				<div className="p-5">{children}</div>
			</div>
		</div>
	);
}

export default function TicketPreviewModal({
	open,
	onClose,
	items,
	titulo = "Previsualización del ticket",
	onPrint,
	width = 384,
}: {
	open: boolean;
	onClose: () => void;
	items: TicketItemLike[];
	titulo?: string;
	onPrint?: () => void;
	width?: 384 | 576;
}) {
	const { ivaPercent } = useBusinessSettings();
	const { settings } = useTicketSettings();

	const empty = items.length === 0;
	const showItems = settings.showLineItems;

	return (
		<Modal open={open} onClose={onClose} title={titulo} maxWidthClass="max-w-[980px]">
			<div className="grid grid-cols-1 lg:grid-cols-[1fr,320px] gap-4">
				<div className="flex justify-center">
					<TicketPaper items={items} width={width} />
				</div>

				<div className="rounded-2xl border border-black/10 bg-white p-4 flex flex-col gap-3">
					<button
						type="button"
						className={cn(
							"px-4 py-3 rounded-xl font-bold transition",
							empty || !showItems ? "bg-black/10 text-black/40 cursor-not-allowed" : "bg-black text-white hover:bg-black/90",
						)}
						disabled={empty || !showItems}
						onClick={() => onPrint?.()}
					>
						Imprimir
					</button>

					<button
						type="button"
						className="px-4 py-3 rounded-xl border border-black/10 bg-white hover:bg-black/5 font-semibold"
						onClick={onClose}
					>
						Cerrar
					</button>

					<div className="text-xs text-black/50">
						Ancho: {width === 384 ? "58mm" : "80mm"} · IVA: {ivaPercent}%
					</div>
				</div>
			</div>
		</Modal>
	);
}
