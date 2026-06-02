// src/components/configuracion/ui/Toggles.tsx
import React from "react";
import { cn } from "../utils";

export function Switch({
	checked,
	onChange,
	label,
	description,
}: {
	checked: boolean;
	onChange: (v: boolean) => void;
	label: string;
	description?: string;
}) {
	return (
		<div className="flex items-start justify-between gap-4 rounded-xl border border-slate-200 bg-white px-4 py-3">
			<div className="min-w-0">
				<div className="text-sm font-semibold text-slate-900">{label}</div>
				{description ? <div className="text-xs text-slate-600 mt-0.5">{description}</div> : null}
			</div>

			<button
				type="button"
				onClick={() => onChange(!checked)}
				className={cn(
					"relative h-7 w-12 rounded-full border transition shrink-0",
					checked ? "bg-slate-900 border-slate-900" : "bg-slate-100 border-slate-200"
				)}
				aria-pressed={checked}
			>
				<span
					className={cn(
						"absolute top-1/2 -translate-y-1/2 h-5 w-5 rounded-full bg-white shadow-sm transition",
						checked ? "left-6" : "left-1"
					)}
				/>
			</button>
		</div>
	);
}

export function Checkbox({
	checked,
	onChange,
	label,
	description,
}: {
	checked: boolean;
	onChange: (v: boolean) => void;
	label: string;
	description?: string;
}) {
	return (
		<button
			type="button"
			onClick={() => onChange(!checked)}
			className={cn(
				"w-full text-left rounded-xl border border-slate-200 bg-white px-4 py-3",
				"hover:bg-slate-50 transition"
			)}
			aria-pressed={checked}
		>
			<div className="flex items-start gap-3">
				<div
					className={cn(
						"mt-0.5 h-5 w-5 rounded-md border grid place-items-center text-white text-xs font-black shrink-0",
						checked ? "bg-slate-900 border-slate-900" : "bg-white border-slate-300"
					)}
				>
					{checked ? "✓" : ""}
				</div>

				<div className="min-w-0">
					<div className="text-sm font-semibold text-slate-900">{label}</div>
					{description ? <div className="text-xs text-slate-600 mt-0.5">{description}</div> : null}
				</div>
			</div>
		</button>
	);
}