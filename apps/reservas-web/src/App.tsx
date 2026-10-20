// El widget de reservas web: de qué negocio es (la clave del camino) y qué pantalla, reservar o
// cancelar. Sin router ni estado global (docs/estudios/reservas-web.md §7.1).

import { useCallback, useEffect, useMemo, useState } from "react";

import { apiDe, ErrorApi, type InfoNegocio } from "./api";
import { useAvisarAltura } from "./altura";
import Cancelar from "./Cancelar";
import type { Ruta } from "./logica";
import Reservar from "./Reservar";
import { Aviso, Boton, Cargando, Tarjeta } from "./ui";

type Carga =
	| { estado: "cargando" }
	| { estado: "lista"; info: InfoNegocio }
	/** Reservas cerradas por el restaurante: se dice a quién llamar. */
	| { estado: "cerrada"; nombre: string; telefono: string }
	| { estado: "no_disponible" }
	| { estado: "error"; mensaje: string };

export default function App({ ruta }: { ruta: Ruta | null }) {
	useAvisarAltura();
	const api = useMemo(() => (ruta ? apiDe(ruta.clave) : null), [ruta]);
	const [carga, setCarga] = useState<Carga>({ estado: "cargando" });

	const cargar = useCallback(async () => {
		if (!api) {
			setCarga({ estado: "no_disponible" });
			return;
		}
		setCarga({ estado: "cargando" });
		try {
			setCarga({ estado: "lista", info: await api.negocio() });
		} catch (e) {
			if (e instanceof ErrorApi && e.codigo === "reserva_web_cerrada") {
				setCarga({ estado: "cerrada", nombre: e.cuerpo?.negocio?.nombre ?? "", telefono: e.cuerpo?.negocio?.telefono ?? "" });
			} else if (e instanceof ErrorApi && e.estado === 404) {
				setCarga({ estado: "no_disponible" });
			} else {
				setCarga({ estado: "error", mensaje: e instanceof ErrorApi ? e.message : "Algo ha fallado." });
			}
		}
	}, [api]);

	useEffect(() => {
		void cargar();
	}, [cargar]);

	const nombre = carga.estado === "lista" ? carga.info.negocio.nombre : carga.estado === "cerrada" ? carga.nombre : "";
	const logo = carga.estado === "lista" ? carga.info.negocio.logo : null;

	// Todo el ancho del iframe, que es el del hueco de la web (embed.js): el tamaño lo decide ella.
	return (
		<main className="w-full p-2">
			<Tarjeta>
				{nombre ? (
					<header className="mb-4 flex items-center gap-3">
						{logo ? <img src={logo} alt="" className="size-10 rounded-lg object-contain" /> : null}
						<h1 className="text-lg font-bold">{nombre}</h1>
					</header>
				) : null}

				{carga.estado === "cargando" ? <Cargando /> : null}

				{carga.estado === "no_disponible" ? <Aviso tono="warning">Reservas no disponibles.</Aviso> : null}

				{carga.estado === "error" ? (
					<div className="space-y-3">
						<Aviso>{carga.mensaje}</Aviso>
						<Boton onClick={() => void cargar()}>Reintentar</Boton>
					</div>
				) : null}

				{/* Con las reservas cerradas, el enlace de cancelar del correo tiene que seguir valiendo. */}
				{carga.estado === "cerrada" && ruta?.vista === "cancelar" && api ? (
					<Cancelar api={api} token={ruta.token} negocio={carga.nombre} />
				) : carga.estado === "cerrada" ? (
					<Aviso tono="warning">
						Ahora no se pueden hacer reservas online.
						{carga.telefono ? ` Llama al ${carga.telefono}.` : ""}
					</Aviso>
				) : null}

				{carga.estado === "lista" && api && ruta ? (
					ruta.vista === "cancelar" ? (
						<Cancelar api={api} token={ruta.token} negocio={carga.info.negocio.nombre} />
					) : (
						<Reservar api={api} info={carga.info} />
					)
				) : null}
			</Tarjeta>
		</main>
	);
}
