// src/features/configuracion/ui/Field.tsx
import React from "react";

export function Field({
	label,
	hint,
	children,
}: {
	label: string;
	hint?: string;
	children: React.ReactNode;
}) {
	return (
		<label className="block">
			<div className="flex items-center justify-between gap-3">
				<span className="text-sm font-semibold text-fg">{label}</span>
				{hint ? <span className="text-xs font-medium text-fg-subtle">{hint}</span> : null}
			</div>
			<div className="mt-2">{children}</div>
		</label>
	);
}