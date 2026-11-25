// src/features/configuracion/ui/Buttons.tsx
import React from "react";
import { cn } from "../utils";

export function PrimaryButton({
	children,
	onClick,
	disabled,
	title,
}: {
	children: React.ReactNode;
	onClick?: () => void;
	disabled?: boolean;
	/** Lo que sale al pasar por encima; con el botón apagado, por qué lo está. */
	title?: string;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			title={title}
			className={cn(
				"h-10 px-4 rounded-xl border border-accent bg-accent text-sm font-bold text-white shadow-sm transition",
				"hover:bg-accent-hover active:scale-[0.98]",
				disabled ? "opacity-50 cursor-not-allowed hover:bg-accent active:scale-100" : ""
			)}
		>
			{children}
		</button>
	);
}

export function GhostButton({
	children,
	onClick,
	disabled,
	title,
}: {
	children: React.ReactNode;
	onClick?: () => void;
	disabled?: boolean;
	/** Lo que sale al pasar por encima; con el botón apagado, por qué lo está. */
	title?: string;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			title={title}
			className={cn(
				"h-10 px-4 rounded-xl border border-border bg-surface text-sm font-semibold text-fg shadow-sm transition",
				"hover:bg-surface-2 active:scale-[0.98]",
				disabled ? "opacity-50 cursor-not-allowed hover:bg-surface active:scale-100" : ""
			)}
		>
			{children}
		</button>
	);
}