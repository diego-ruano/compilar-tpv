// Las piezas de interfaz del widget, con las mismas formas que la app (docs/estudios/reservas-web.md
// §7.1): tarjetas `bg-surface` redondeadas, botón principal en el acento, texto secundario apagado.

import { Component, type ComponentProps, type ReactNode } from "react";

export function Tarjeta({ children }: { children: ReactNode }) {
	return <div className="w-full rounded-2xl border border-border bg-surface p-4 text-fg shadow-sm sm:p-5">{children}</div>;
}

export function Boton({
	variante = "principal",
	className = "",
	...props
}: ComponentProps<"button"> & { variante?: "principal" | "secundario" | "peligro" }) {
	const estilos = {
		principal: "bg-accent text-accent-fg hover:bg-accent-hover",
		secundario: "border border-border bg-surface-2 text-fg hover:bg-surface-3",
		peligro: "bg-danger text-danger-fg hover:opacity-90",
	}[variante];
	return (
		<button
			type="button"
			{...props}
			className={`inline-flex min-h-11 cursor-pointer items-center justify-center rounded-xl px-4 py-2 text-sm font-bold transition disabled:cursor-not-allowed disabled:opacity-50 ${estilos} ${className}`}
		/>
	);
}

export function Aviso({ tono = "danger", children }: { tono?: "danger" | "warning" | "success"; children: ReactNode }) {
	const estilos = {
		danger: "border-danger/30 bg-danger-soft text-danger",
		warning: "border-warning/30 bg-warning-soft text-fg",
		success: "border-success/30 bg-success-soft text-fg",
	}[tono];
	return (
		<div role={tono === "danger" ? "alert" : "status"} className={`rounded-xl border px-3 py-2 text-sm ${estilos}`}>
			{children}
		</div>
	);
}

export function Cargando({ texto = "Cargando…" }: { texto?: string }) {
	return <div className="py-8 text-center text-sm text-fg-muted">{texto}</div>;
}

/** Si lo de dentro falla al pintarse (el plano, que se descarga aparte, con mala cobertura), un aviso con
 * «Reintentar» en su sitio: sin esto, React desmonta el widget entero y queda en blanco. */
export class SiFalla extends Component<{ aviso: string; onReintentar: () => void; children: ReactNode }, { fallo: boolean }> {
	state = { fallo: false };

	static getDerivedStateFromError() {
		return { fallo: true };
	}

	render() {
		if (!this.state.fallo) return this.props.children;
		return (
			<div className="space-y-2">
				<Aviso>{this.props.aviso}</Aviso>
				<Boton
					variante="secundario"
					onClick={() => {
						this.props.onReintentar();
						this.setState({ fallo: false });
					}}
				>
					Reintentar
				</Boton>
			</div>
		);
	}
}
