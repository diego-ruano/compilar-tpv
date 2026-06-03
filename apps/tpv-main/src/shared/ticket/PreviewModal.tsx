import React, { useMemo } from "react";
import { useBusinessSettings } from "../../shared/stores/useBusinessSettings";
import { useTicketSettings } from "../../shared/stores/useTicketSettings";

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

function eur(n: number) {
	return new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" }).format(n);
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
	const {
		businessName,
		logoDataUrl,
		direccion,
		telefono,
		cif,
		mensajeFooter,
		ivaPercent,
	} = useBusinessSettings();

	const { settings } = useTicketSettings();

	const grouped = useMemo(() => {
		const map = new Map<string, { nombre: string; precio: number; qty: number }>();
		for (const it of items) {
			const key = `${it.productoId}__${it.precio}`;
			const cur = map.get(key);
			if (!cur) map.set(key, { nombre: it.nombre, precio: it.precio, qty: 1 });
			else cur.qty += 1;
		}
		return Array.from(map.values());
	}, [items]);

	const total = useMemo(() => grouped.reduce((acc, g) => acc + g.qty * g.precio, 0), [grouped]);

	const base = useMemo(() => {
		const divisor = 1 + (ivaPercent ?? 0) / 100;
		return divisor === 0 ? total : total / divisor;
	}, [total, ivaPercent]);

	const iva = useMemo(() => total - base, [total, base]);

	const fechaStr = useMemo(() => new Date().toLocaleString("es-ES"), []);

	const empty = grouped.length === 0;

	const showHeaderLogo = settings.showLogo && !!logoDataUrl;
	const showHeaderName = settings.showBusinessName;
	const showAddress = settings.showAddress && !!direccion;
	const showPhone = settings.showPhone && !!telefono;
	const showCif = settings.showCif && !!cif;
	const showDateTime = settings.showDateTime;
	const showItems = settings.showLineItems;
	const showBaseIva = settings.showBaseAndIva;
	const showTotalLine = settings.showTotal;
	const showFooter = settings.showFooterMessage;

	return (
		<Modal open={open} onClose={onClose} title={titulo} maxWidthClass="max-w-[980px]">
			<div className="grid grid-cols-1 lg:grid-cols-[1fr,320px] gap-4">
				<div className="flex justify-center">
					<div className="bg-white text-black rounded-xl border border-black/10 shadow-sm overflow-hidden" style={{ width }}>
						<div style={{ fontFamily: "monospace", fontSize: 12, padding: 14 }}>
							<div style={{ textAlign: "center" }}>
								{showHeaderLogo ? (
									<div style={{ display: "flex", justifyContent: "center", marginBottom: 8 }}>
										<img
											src={logoDataUrl!}
											alt="logo"
											style={{ maxHeight: 48, maxWidth: "70%", objectFit: "contain" }}
										/>
									</div>
								) : null}

								{showHeaderName ? (
									<div style={{ fontWeight: 800, fontSize: 16, letterSpacing: 0.2 }}>
										{businessName || "TPV"}
									</div>
								) : null}

								{showAddress ? <div style={{ marginTop: 2 }}>{direccion}</div> : null}
								{showPhone ? <div>Tel: {telefono}</div> : null}
								{showCif ? <div>CIF: {cif}</div> : null}
							</div>

							<div style={{ borderTop: "1px dashed #000", margin: "10px 0" }} />

							{showDateTime ? (
								<>
									<div style={{ display: "flex", justifyContent: "space-between" }}>
										<span>{fechaStr}</span>
										<span>VENTA</span>
									</div>
									<div style={{ borderTop: "1px dashed #000", margin: "10px 0" }} />
								</>
							) : (
								<>
									<div style={{ display: "flex", justifyContent: "flex-end" }}>
										<span>VENTA</span>
									</div>
									<div style={{ borderTop: "1px dashed #000", margin: "10px 0" }} />
								</>
							)}

							{!showItems ? (
								<div style={{ textAlign: "center", opacity: 0.7, padding: "8px 0" }}>
									(Líneas de productos ocultas)
								</div>
							) : empty ? (
								<div style={{ textAlign: "center", opacity: 0.65, padding: "10px 0" }}>
									No hay productos en el ticket.
								</div>
							) : (
								<div>
									{grouped.map((g, idx) => {
										const lineTotal = g.qty * g.precio;
										return (
											<div key={idx} style={{ marginBottom: 8 }}>
												<div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
													<span style={{ maxWidth: "70%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
														{g.nombre}
													</span>
													<span style={{ fontWeight: 700 }}>{eur(lineTotal)}</span>
												</div>
												<div style={{ display: "flex", justifyContent: "space-between", opacity: 0.8 }}>
													<span>
														{g.qty} x {eur(g.precio)}
													</span>
													<span />
												</div>
											</div>
										);
									})}
								</div>
							)}

							<div style={{ borderTop: "1px dashed #000", margin: "10px 0" }} />

							{showBaseIva ? (
								<>
									<div style={{ display: "flex", justifyContent: "space-between" }}>
										<span>BASE</span>
										<span>{eur(base)}</span>
									</div>
									<div style={{ display: "flex", justifyContent: "space-between" }}>
										<span>IVA ({ivaPercent}%)</span>
										<span>{eur(iva)}</span>
									</div>
								</>
							) : null}

							{showTotalLine ? (
								<>
									<div style={{ borderTop: "1px solid #000", margin: "10px 0" }} />
									<div style={{ display: "flex", justifyContent: "space-between", fontWeight: 900, fontSize: 14 }}>
										<span>TOTAL</span>
										<span>{eur(total)}</span>
									</div>
								</>
							) : null}

							{showFooter ? (
								<>
									<div style={{ borderTop: "1px dashed #000", margin: "12px 0" }} />
									<div style={{ textAlign: "center", fontSize: 11, opacity: 0.9 }}>
										{mensajeFooter || "¡Gracias por su visita!"}
									</div>
								</>
							) : null}
						</div>
					</div>
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
