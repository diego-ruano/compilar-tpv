// src/features/configuracion/ui/Inputs.tsx
import React from "react";
import { cn } from "../utils";

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
	return (
		<input
			{...props}
			className={cn(
				"w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none",
				"placeholder:text-slate-400 focus:border-slate-300",
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
				"w-full min-h-[88px] resize-none rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none",
				"placeholder:text-slate-400 focus:border-slate-300",
				props.className
			)}
		/>
	);
}