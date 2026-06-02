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
			<label className="font-semibold text-negro">{label}</label>
			<input
				value={value}
				onChange={(e) => onChange(e.target.value)}
				className="border border-negro rounded-lg px-3 py-2 text-negro outline-none bg-white"
				placeholder={placeholder}
				type={type}
			/>
		</div>
	);
}
