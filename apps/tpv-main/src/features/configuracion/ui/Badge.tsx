// src/features/configuracion/ui/Badge.tsx
import React from "react";
import { cn } from "../utils";

export function Badge({
	children,
	tone = "default",
}: {
	children: React.ReactNode;
	tone?: "default" | "good" | "warn" | "bad";
}) {
	const toneCls =
		tone === "good"
			? "border-emerald-200 bg-emerald-50 text-emerald-800"
			: tone === "warn"
				? "border-amber-200 bg-amber-50 text-amber-900"
				: tone === "bad"
					? "border-rose-200 bg-rose-50 text-rose-900"
					: "border-slate-200 bg-white text-slate-700";

	return (
		<span
			className={cn(
				"inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium",
				toneCls
			)}
		>
			{children}
		</span>
	);
}