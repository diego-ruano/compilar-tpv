// src/features/configuracion/ui/Buttons.tsx
import React from "react";
import { cn } from "../utils";

export function PrimaryButton({
	children,
	onClick,
	disabled,
}: {
	children: React.ReactNode;
	onClick?: () => void;
	disabled?: boolean;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			className={cn(
				"h-10 px-4 rounded-xl border border-slate-900 bg-slate-900 text-sm font-bold text-white shadow-sm transition",
				"hover:bg-slate-800 active:scale-[0.98]",
				disabled ? "opacity-50 cursor-not-allowed hover:bg-slate-900 active:scale-100" : ""
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
}: {
	children: React.ReactNode;
	onClick?: () => void;
	disabled?: boolean;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			className={cn(
				"h-10 px-4 rounded-xl border border-slate-200 bg-white text-sm font-semibold text-slate-800 shadow-sm transition",
				"hover:bg-slate-50 active:scale-[0.98]",
				disabled ? "opacity-50 cursor-not-allowed hover:bg-white active:scale-100" : ""
			)}
		>
			{children}
		</button>
	);
}