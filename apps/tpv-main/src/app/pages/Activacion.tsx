// src/pages/MainActivation.tsx
import React, { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

function normalizeKey(input: string) {
	return input.trim().toUpperCase();
}

function looksLikeLicenseKey(k: string) {
	const t = normalizeKey(k);
	return t.length >= 10;
}

export default function Activacion({
	initialKey,
	onActivated,
}: {
	initialKey?: string | null;
	onActivated: () => void;
}) {
	const [key, setKey] = useState(initialKey ?? "");
	const [restaurantName, setRestaurantName] = useState("");
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);

	async function submit() {
		const k = normalizeKey(key);
		if (!looksLikeLicenseKey(k)) {
			setErr("Introduce una clave válida.");
			return;
		}
		if (!restaurantName.trim()) {
			setErr("Introduce el nombre del restaurante.");
			return;
		}

		setBusy(true);
		setErr(null);
		try {
			await invoke("license_activate", {
				activationKey: k,
				restaurantName: restaurantName.trim(),
			});
			onActivated();
		} catch (e: any) {
			setErr(String(e));
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="min-h-screen w-full bg-slate-100 flex items-center justify-center p-6">
			<div className="w-full max-w-lg rounded-2xl bg-white shadow-sm border border-slate-200 p-6">
				<div className="mb-5">
					<h1 className="text-2xl font-semibold text-slate-900">
						Activar TPV (principal)
					</h1>
					<p className="text-sm text-slate-600 mt-1">
						Introduce tu clave y el nombre del restaurante.
					</p>
				</div>

				<label className="block text-sm font-medium text-slate-700 mb-2">
					Clave de licencia
				</label>
				<input
					value={key}
					onChange={(e) => setKey(e.target.value)}
					placeholder="XXXX-XXXX-XXXX-XXXX"
					className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-base focus:outline-none focus:ring-2 focus:ring-indigo-500"
					autoFocus
					disabled={busy}
				/>

				<label className="block text-sm font-medium text-slate-700 mb-2 mt-4">
					Nombre del restaurante
				</label>
				<input
					value={restaurantName}
					onChange={(e) => setRestaurantName(e.target.value)}
					placeholder="Ej: Bar Altaria"
					className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-base focus:outline-none focus:ring-2 focus:ring-indigo-500"
					disabled={busy}
				/>

				{err && (
					<div className="mt-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-xl p-3 whitespace-pre-wrap">
						{err}
					</div>
				)}

				<div className="mt-5 flex gap-3">
					<button
						onClick={submit}
						disabled={busy}
						className="flex-1 rounded-xl bg-indigo-600 text-white py-3 font-semibold hover:bg-indigo-700 disabled:opacity-50"
					>
						{busy ? "Activando..." : "Activar"}
					</button>

					<button
						onClick={() => {
							setKey("");
							setRestaurantName("");
							setErr(null);
							invoke("license_clear_state").catch(() => { });
						}}
						disabled={busy}
						className="rounded-xl border border-slate-300 bg-white py-3 px-4 font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
					>
						Limpiar
					</button>
				</div>
			</div>
		</div>
	);
}
