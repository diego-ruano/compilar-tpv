// src/features/configuracion/ui/Inputs.tsx
import React from "react";
import { cn } from "../utils";

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
	return (
		<input
			{...props}
			className={cn(
				"w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-fg outline-none",
				"placeholder:text-fg-subtle focus:border-border",
				props.className
			)}
		/>
	);
}

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
	return (
		<textarea
			{...props}
			className={cn(
				"w-full min-h-[88px] resize-none rounded-xl border border-border bg-surface px-3 py-2 text-sm text-fg outline-none",
				"placeholder:text-fg-subtle focus:border-border",
				props.className
			)}
		/>
	);
}