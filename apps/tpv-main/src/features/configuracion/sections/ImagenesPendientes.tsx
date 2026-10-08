import { commands } from "@tpv/client";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { toAppError } from "@tpv/client";
import type { EstadoColaImagenes, ImagenApartada, ReintentarImagenArgs } from "@tpv/contracts";
import { useMode } from "../../../shared/stores/useMode";
import { useImageUrl } from "../../../shared/lib/useImageUrl";
import { triggerImageUploadDrain } from "../../../shared/lib/imageUrl";
import { captureException } from "../../../shared/observability/sentry";
import { GhostButton } from "../ui/Buttons";
import { Panel } from "../ui/Panel";

function ImagenRechazada({ imagen, reintentar, ocupada }: {
	imagen: ImagenApartada; reintentar: (ruta: string) => void; ocupada: boolean;
}) {
	const url = useImageUrl(imagen.rel_path);
	return <li className="flex flex-wrap items-center gap-3 rounded-xl border border-warning/40 p-3">
		{url && <img src={url} alt="Imagen pendiente" className="h-14 w-14 rounded-lg object-contain" onError={(e) => { e.currentTarget.hidden = true; }} />}
		<div className="min-w-0 flex-1 text-sm">
			<p>No se ha podido subir esta imagen. Las demás continúan subiendo.</p>
			<details className="mt-1 text-xs text-fg-muted">
				<summary>Ver el motivo y la referencia del archivo</summary>
				<p className="break-all">{imagen.rel_path}</p>
				<p className="break-words">{imagen.motivo}</p>
			</details>
		</div>
		<GhostButton disabled={ocupada} onClick={() => reintentar(imagen.rel_path)}>Reintentar</GhostButton>
	</li>;
}

export function ImagenesPendientes() {
	const modo = useMode((s) => s.mode);
	const cliente = useQueryClient();
	const [ocupada, setOcupada] = useState(false);
	const [errorAccion, setErrorAccion] = useState("");
	const estado = useQuery({
		queryKey: ["images", "uploads", modo],
		queryFn: () => commands.imagesUploadStatus(),
		retry: false,
	});
	useEffect(() => {
		let vivo = true;
		let dejar: (() => void) | undefined;
		listen("images:queue_changed", () => { void cliente.invalidateQueries({ queryKey: ["images", "uploads"] }); })
			.then((fn) => { if (vivo) dejar = fn; else fn(); })
			.catch((error) => captureException(error, { fase: "images_queue_listener" }));
		return () => { vivo = false; dejar?.(); };
	}, [cliente]);

	async function reintentar(ruta: string) {
		setOcupada(true);
		setErrorAccion("");
		try {
			const args: ReintentarImagenArgs = { rel_path: ruta };
			await commands.imagesRetryUpload(args);
			triggerImageUploadDrain();
			await estado.refetch();
		} catch (error) {
			setErrorAccion(toAppError(error).message);
			captureException(error, { fase: "images_retry_upload" });
		} finally { setOcupada(false); }
	}

	return <Panel title="Subida de imágenes" subtitle="Las imágenes pendientes se suben automáticamente cuando hay conexión."
		right={<GhostButton onClick={() => { void estado.refetch(); }} disabled={estado.isFetching}>Actualizar</GhostButton>}>
		{estado.isPending && <p className="text-sm text-fg-muted">Consultando las imágenes…</p>}
		{(estado.error || errorAccion) && <p role="alert" className="text-sm text-danger">{errorAccion || toAppError(estado.error).message}</p>}
		{estado.data && <div className="grid gap-3 text-sm">
			<p>{estado.data.pendientes} pendientes · {estado.data.total_apartadas} requieren atención</p>
			{estado.data.total_apartadas > 0 && <>
				<p>Si el archivo no es válido o ya no existe, sustituye la imagen desde su ficha. Puedes reintentar su subida después de corregir el problema.</p>
				<ul className="grid gap-2">{estado.data.apartadas.map((imagen) => <ImagenRechazada key={imagen.rel_path} imagen={imagen} ocupada={ocupada} reintentar={(ruta) => { void reintentar(ruta); }} />)}</ul>
				{estado.data.total_apartadas > estado.data.apartadas.length && <p className="text-fg-muted">Se muestran las primeras {estado.data.apartadas.length}. Al resolverlas aparecerán las siguientes.</p>}
			</>}
		</div>}
	</Panel>;
}
