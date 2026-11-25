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
			? "border-success/30 bg-success-soft text-success"
			: tone === "warn"
				? "border-warning/30 bg-warning-soft text-warning"
				: tone === "bad"
					? "border-danger/30 bg-danger-soft text-danger"
					: "border-border bg-surface text-fg-muted";

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