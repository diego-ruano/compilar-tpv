// src/app/arranque/escanearQr.ts
//
// Leer con la cámara el QR que enseña la Main en Configuración → Vincular Handy (plugin oficial
// `barcode-scanner` de Tauri). Sólo existe en móvil: en escritorio el plugin ni se compila
// (`src-tauri/Cargo.toml`), y la pantalla no ofrece el botón.
//
// Se escanea en modo «ventana»: el plugin pone la cámara DETRÁS de la webview y la vuelve
// transparente, y la pantalla pinta encima sólo el visor, con su «Cancelar». Sin ventana, en
// Android la cámara tapa la aplicación entera y no hay forma de salir sin leer un código.

/** ¿Se puede escanear en este equipo? Lo fija Tauri al compilar el frontend. */
export function puedeEscanear(): boolean {
	const plataforma = import.meta.env.TAURI_ENV_PLATFORM;
	return plataforma === "android" || plataforma === "ios";
}

export type ResultadoEscaneo =
	| { tipo: "leido"; contenido: string }
	/** El sistema no deja usar la cámara (denegado ahora o antes). */
	| { tipo: "sin_permiso" }
	/** Quien escaneaba pulsó «Cancelar». */
	| { tipo: "cancelado" }
	| { tipo: "error"; motivo: string };

type Escaner = Pick<
	typeof import("@tauri-apps/plugin-barcode-scanner"),
	"scan" | "cancel" | "checkPermissions" | "requestPermissions" | "Format"
>;

/** La clase que deja ver la cámara a través de la aplicación mientras se escanea (`Global.css`). */
const CLASE_ESCANEANDO = "escaneando-qr";

/**
 * Un escaneo: pide el permiso de la cámara si hace falta, lee un QR y devuelve lo leído. No lanza:
 * lo que salga mal se devuelve para que la pantalla lo cuente y sigan las otras vías (pegar el
 * contenido o escribir el código).
 */
export class EscaneoQr {
	private cancelado = false;

	constructor(private readonly cargar: () => Promise<Escaner> = () => import("@tauri-apps/plugin-barcode-scanner")) {}

	async leer(alEmpezar: () => void): Promise<ResultadoEscaneo> {
		// Al principio, no después de pedir el permiso: si la pantalla se cierra mientras el sistema
		// pregunta, su «cancelar» llega antes que la respuesta y no puede perderse.
		this.cancelado = false;
		let escaner: Escaner;
		try {
			escaner = await this.cargar();
			let permiso = await escaner.checkPermissions();
			if (permiso !== "granted") permiso = await escaner.requestPermissions();
			if (permiso !== "granted") return { tipo: "sin_permiso" };
		} catch (e) {
			return { tipo: "error", motivo: motivoDe(e) };
		}

		// Cancelado mientras se pedía el permiso: la cámara no se abre. Abierta, quedaría detrás de una
		// aplicación transparente (`escaneando-qr`) y sin visor ni «Cancelar».
		if (this.cancelado) return { tipo: "cancelado" };
		alEmpezar();
		document.documentElement.classList.add(CLASE_ESCANEANDO);
		try {
			const leido = await escaner.scan({ windowed: true, formats: [escaner.Format.QRCode] });
			return { tipo: "leido", contenido: leido.content };
		} catch (e) {
			// El plugin rechaza el escaneo cuando se cancela; se sabe porque lo ha pedido esta pantalla,
			// sin mirar el texto del rechazo.
			return this.cancelado ? { tipo: "cancelado" } : { tipo: "error", motivo: motivoDe(e) };
		} finally {
			document.documentElement.classList.remove(CLASE_ESCANEANDO);
		}
	}

	/** «Cancelar» en el visor, o la pantalla que se cierra a mitad. */
	async cancelar(): Promise<void> {
		this.cancelado = true;
		document.documentElement.classList.remove(CLASE_ESCANEANDO);
		const escaner = await this.cargar();
		await escaner.cancel();
	}
}

function motivoDe(e: unknown): string {
	if (e instanceof Error) return e.message;
	return String(e);
}

/** Lo que se le dice a quien escaneaba, o `null` si no hay nada que decir. */
export function avisoDelEscaneo(r: ResultadoEscaneo): string | null {
	switch (r.tipo) {
		case "leido":
			return null;
		case "sin_permiso":
			return "Sin permiso para usar la cámara no se puede escanear. Puedes darlo en los ajustes del teléfono, o pegar el contenido del QR o escribir el código.";
		case "cancelado":
			return "No se ha escaneado ningún QR. Puedes volver a intentarlo, pegar su contenido o escribir el código.";
		case "error":
			return `No se ha podido usar la cámara (${r.motivo}). Pega el contenido del QR o escribe el código.`;
	}
}
