// src/features/configuracion/ui/Panel.tsx
import React from "react";

export function Panel({
	title,
	subtitle,
	right,
	children,
	id,
}: {
	title: string;
	subtitle?: string;
	right?: React.ReactNode;
	children: React.ReactNode;
	id?: string;
}) {
	return (
		<section id={id} className="rounded-2xl border border-border bg-surface scroll-mt-24">
			<div className="px-5 py-4 border-b border-border">
				<div className="flex items-start justify-between gap-3">
					<div className="min-w-0">
						<h2 className="text-base font-semibold text-fg truncate">{title}</h2>
						{subtitle ? <p className="text-sm text-fg-muted mt-0.5">{subtitle}</p> : null}
					</div>
					{right ? <div className="shrink-0">{right}</div> : null}
				</div>
			</div>
			<div className="px-5 py-5">{children}</div>
		</section>
	);
}