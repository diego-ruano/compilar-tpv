import { commands } from "@tpv/client";
// src/app/AppBoot.tsx
//
// El arranque: decide qué pantalla se enseña hasta que la aplicación puede trabajar, y pone en marcha
// lo que tiene que correr desde el primer momento (sockets, ajustes, subida de imágenes, sesión).
//
// Antes lo hacía todo aquí dentro —selector de modo, activación de la licencia, vinculación del Handy,
// pantallas de bloqueo y de espera, y la decisión de cuál enseñar— en un componente de casi 1.800
// líneas. Cada pieza vive ahora en `app/arranque/`. Lo que hay que proteger de la decisión (un Handy
// sin Main no trabaja, una Main no enseña nada sin licencia) está en `pantallaDeArranque.ts`, con sus
// tests en `test/arranque.test.ts`.

import React, { useEffect } from "react";
import { RouterProvider } from "react-router-dom";


import { cn } from "../shared/lib/cn";
import { conAviso } from "../shared/lib/conAviso";
import { useHandySocket } from "../shared/lib/useHandySocket";
import { useImageUrl } from "../shared/lib/useImageUrl";
import { useMainSocket } from "../shared/lib/useMainSocket";
import { useBusinessSettings } from "../shared/stores/useBusinessSettings";
import { useContactSettings } from "../shared/stores/useContactSettings";
import { useEstadoSync } from "../shared/stores/useEstadoSync";
import { useMainPresence } from "../shared/stores/useMainPresence";
import { useMode } from "../shared/stores/useMode";
import { useTicketSettings } from "../shared/stores/useTicketSettings";
import UpdateBanner from "../shared/ui/UpdateBanner";
import ActivacionLicencia from "./arranque/ActivacionLicencia";
import AvisoCaducidad from "./arranque/AvisoCaducidad";
import EmparejarHandy from "./arranque/EmparejarHandy";
import HandyEsperandoMain from "./arranque/HandyEsperandoMain";
import LicenciaBloqueada from "./arranque/LicenciaBloqueada";
import { decidirArranque } from "./arranque/pantallaDeArranque";
import SelectorModo from "./arranque/SelectorModo";
import { useEmparejamientoHandy } from "./arranque/useEmparejamientoHandy";
import { useLicencia } from "./arranque/useLicencia";
import { useModoDispositivo } from "./arranque/useModoDispositivo";
import Titlebar from "./layoutComponent/Titlebar";

export default function AppBoot({ router }: { router: any }) {
	const business_name = useBusinessSettings((s) => s.business_name);
	const logo_data_url = useBusinessSettings((s) => s.logo_data_url);
	// Ruta relativa → URL utilizable (ver `useImageUrl`).
	const logoSrc = useImageUrl(logo_data_url);

	const modo = useMode((s) => s.mode);
	const licencia = useLicencia(modo);
	const dispositivo = useModoDispositivo({ alElegir: licencia.refrescarLicencia });
	const emparejamiento = useEmparejamientoHandy(modo);

	// Presencia de la Main vista por el Handy: sin Main activa, el Handy se bloquea entero
	// (login incluido). null = aún conectando/sin confirmar (fail-closed).
	const mainOnline = useMainPresence((s) => s.mainOnline);
	const rechazoHandy = useMainPresence((s) => s.rechazo);
	// SYNC-18: la Main está subiendo su atraso. Cuenta como "no disponible todavía" para el Handy.
	const mainVolcando = useMainPresence((s) => s.volcando);

	// SYNC-17: palanca de conectividad (auto/off) persistida en AppData. No es un ajuste de
	// usuario: se lee al arrancar y solo existe como salida de emergencia.
	const hidratarSync = useEstadoSync((s) => s.hidratar);
	useEffect(() => {
		void hidratarSync();
	}, [hidratarSync]);

	// WebSocket de la Main: lo intenta siempre mientras este dispositivo sea la Main. Su estado
	// real (conectado / reintentando / rechazado…) se publica en `useEstadoSync`.
	useMainSocket();

	// Observa el servicio nativo del Handy: presencia y avisos para refrescar React Query
	// y el ticket abierto. Rust mantiene la conexión y el protocolo.
	useHandySocket();

	// SEC-01: barrer la sesión del backend al arrancar el webview.
	//
	// Hace falta porque las dos sesiones no mueren juntas. Si alguien recarga (F5), el store de
	// Zustand se vacía y la UI vuelve al login, pero `AppState::sesion` sigue puesta: quedaría
	// una sesión de administrador viva detrás de una pantalla que pide PIN. Aquí no hay nada
	// que perder —al arrancar SIEMPRE se pide PIN, no hay sesión persistente que respetar—, así
	// que cerrar es lo correcto aunque no venga de un F5.
	useEffect(() => {
		void commands.logout().catch((e: unknown) => {
			console.warn("[AppBoot] no se pudo limpiar la sesión del backend:", e);
		});
	}, []);

	// Los `init` no fallan: el error lo cuenta cada store.
	useEffect(() => {
		if (modo !== "tpv") return;
		void useBusinessSettings.getState().init();
		void useTicketSettings.getState().init();
		void useContactSettings.getState().init();
	}, [modo]);

	// Imágenes → R2: una sola vez, encolar las imágenes locales pre-existentes (Mains anteriores
	// a R2) y drenar la cola. El backfill se auto-protege con un marcador; el drenado es no-op si
	// no hay nada o si está offline (se reintentará por el WebSocket cuando haya conexión).
	useEffect(() => {
		if (modo !== "tpv") return;
		void commands.imagesBackfill()
			.then(() => commands.imagesDrainPending())
			.catch((e: unknown) => {
				console.warn("[AppBoot] images_drain_pending falló:", e);
			});
	}, [modo]);

	const arranque = decidirArranque({
		modo,
		licenciaCargando: licencia.lic === "loading",
		gate: licencia.gate === "loading" ? null : licencia.gate,
		handyEmparejado: emparejamiento.estado.step === "paired",
		mainOnline,
		mainVolcando,
		rechazoHandy,
	});

	// SYNC-17: en cuanto la licencia deja pasar (activación recién hecha, licencia renovada, o el
	// pulso periódico del job `licencia`), le decimos al WebSocket que lo intente YA. Sin esto, un
	// TPV recién activado se quedaría esperando a que venciera la espera larga de `sin_identidad`.
	// Es un booleano: el efecto solo corre en la transición, no en cada repintado.
	const reintentarSync = useEstadoSync((s) => s.reintentar);
	useEffect(() => {
		if (arranque.mainLista) reintentarSync();
	}, [arranque.mainLista, reintentarSync]);

	function contenido() {
		const p = arranque.pantalla;
		switch (p.tipo) {
			case "cargando":
				return <div className="min-h-full w-full bg-bg p-6 font-sans" />;

			case "elegir_modo":
				return (
					<SelectorModo
						logoSrc={logoSrc}
						business_name={business_name}
						ocupado={dispositivo.ocupado}
						error={dispositivo.error}
						onElegir={dispositivo.elegir}
					/>
				);

			case "handy_vincular":
				return (
					<EmparejarHandy
						emparejamiento={emparejamiento}
						volviendo={dispositivo.ocupado}
						onVolver={dispositivo.volverAlSelector}
					/>
				);

			case "handy_esperando_main":
				// Emparejado pero sin Main activa: bloqueo total (login incluido).
				return (
					<HandyEsperandoMain
						conectando={p.conectando}
						volcando={p.volcando}
						rechazo={p.rechazo}
						onReintentar={() => useMainPresence.getState().requestReconnect()}
						onIrAVinculacion={emparejamiento.volverAVincular}
					/>
				);

			case "handy_app":
				// En modo Handy mostramos siempre un botón flotante para volver a la zona de
				// vinculación (re-emparejar / cambiar de TPV). Solo se renderiza aquí, en la rama
				// Handy: en modo TPV este botón no existe.
				return (
					<div className="relative h-full w-full">
						<RouterProvider router={router} />

						<button
							type="button"
							onClick={emparejamiento.volverAVincular}
							className="absolute bottom-3 left-3 z-50 rounded-xl border border-slate-300 bg-white/95 px-3 py-2 text-sm font-semibold text-slate-800 shadow-md backdrop-blur transition hover:bg-white active:scale-[0.98]"
						>
							← Vinculación
						</button>
					</div>
				);

			case "tpv_activar":
				return (
					<ActivacionLicencia
						rechazoPrevio={p.rechazoPrevio}
						volviendo={dispositivo.ocupado}
						errorAlVolver={dispositivo.error}
						onVolver={dispositivo.volverAlSelector}
						onActivada={async () => {
							await licencia.refrescarLicencia();
							await licencia.refrescarGate(true);
						}}
					/>
				);

			case "tpv_bloqueada":
				return (
					<LicenciaBloqueada
						motivo={p.motivo}
						error={licencia.errorAlBorrar}
						onReintentar={conAviso(() => licencia.refrescarGate(true))}
						onBorrar={licencia.borrarYVolverAActivar}
					/>
				);

			case "tpv_app":
				return <RouterProvider router={router} />;
		}
	}

	return (
		<div className="w-screen h-screen flex flex-col overflow-hidden">
			<UpdateBanner />
			{arranque.avisoCaducidad ? <AvisoCaducidad aviso={arranque.avisoCaducidad} /> : null}
			{/* El layout de la Main y el del Handy traen su propia barra de título (Titlebar, con el
			    toggle claro/oscuro). La del arranque sólo se enseña mientras no hay aplicación. */}
			{arranque.conBarraDeArranque ? <Titlebar /> : null}

			<div
				className={cn(
					"flex-1 min-h-0 bg-bg",
					arranque.conBarraDeArranque ? "overflow-y-auto" : "overflow-hidden",
				)}
			>
				{contenido()}
			</div>
		</div>
	);
}
