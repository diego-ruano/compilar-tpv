export default function Campo({
	label,
	value,
	onChange,
	placeholder,
	type = "text",
}: {
	label: string;
	value: string;
	onChange: (v: string) => void;
	placeholder?: string;
	type?: string;
}) {
	return (
		<div className="flex flex-col gap-1">
			<label className="text-sm font-semibold text-fg">{label}</label>
			<input
				value={value}
				onChange={(e) => onChange(e.target.value)}
				className="h-10 rounded-xl border border-border bg-surface-2 px-3 text-fg outline-none transition placeholder:text-fg-subtle focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-ring"
				placeholder={placeholder}
				type={type}
			/>
		</div>
	);
}
