// Reservar (docs/estudios/reservas-web.md §7.2): cuándo, mesa, tus datos y hecho. Lo que vale o no
// lo dice el worker; aquí sólo se ofrece lo que él dice que se puede elegir.

import { lazy, Suspense, useEffect, useRef, useState } from "react";

import type { Api, Confirmada, Disponibles, InfoNegocio, MesaPublica, PlanoPublico } from "./api";
import { ErrorApi } from "./api";
import Calendario from "./Calendario";
import { diaCorto, diaLargo, horaEnTramos, horaInicial, personasTexto, textoDeTramos, type Tramo } from "./logica";
import Turnstile, { type ControlTurnstile } from "./Turnstile";
import { recargarPagina } from "./pagina";
import { Aviso, Boton, Cargando, SiFalla } from "./ui";

// El plano (React Konva) es lo que más pesa: se carga al llegar al paso 2, no al abrir el widget. Si
// esa descarga falla, volver a pedirla no sirve: el navegador guarda el fallo de un `import()` y lo
// devuelve igual a cada intento. Lo que lo arregla es cargar otra vez la página del widget.
const PlanoWidget = lazy(() => import("./PlanoWidget"));

type Paso = "cuando" | "mesa" | "datos" | "hecho";

const CAMPO = "w-full rounded-xl border border-border bg-surface-2 px-3 py-2 text-sm text-fg outline-none focus:ring-2 focus:ring-ring";

export default function Reservar({ api, info }: { api: Api; info: InfoNegocio }) {
	const [paso, setPaso] = useState<Paso>("cuando");
	// Al cambiar de paso desaparece el botón que tenía el foco: se lleva al título del paso nuevo, para
	// que quien va con teclado o lector de pantalla sepa dónde está (y oiga «Reserva confirmada»). Al
	// abrir el widget no: le quitaría el foco a la web donde va incrustado.
	const titulo = useRef<HTMLHeadingElement | null>(null);
	const pasoEnfocado = useRef(paso);
	useEffect(() => {
		if (pasoEnfocado.current === paso) return;
		pasoEnfocado.current = paso;
		titulo.current?.focus();
	}, [paso]);
	const [error, setError] = useState<string | null>(null);
	const [ocupado, setOcupado] = useState(false);

	// Paso 1
	const [dia, setDia] = useState<string | null>(null);
	const [tramos, setTramos] = useState<Tramo[] | null>(null);
	// Sin horario no se puede seguir: su fallo se enseña junto a las horas, con su «Reintentar».
	const [errorDia, setErrorDia] = useState<string | null>(null);
	// Cada vez que se elige un día se pide su horario; si llega tarde la respuesta de un día que ya
	// no es el elegido, se tira (si no, se le pondrían a un día las horas de otro).
	const peticionDia = useRef(0);
	// Lo mismo con la búsqueda de mesas: si mientras busca cambia el día, la hora o las personas, lo
	// que llegue es de otra pregunta y no se aplica.
	const peticionMesas = useRef(0);
	const olvidarBusqueda = () => {
		peticionMesas.current++;
		setOcupado(false);
	};
	const [hora, setHora] = useState<string>("");
	const maxPersonas = Math.max(1, info.max_personas);
	const [personas, setPersonas] = useState(Math.min(2, maxPersonas));

	// Paso 2
	const [plano, setPlano] = useState<PlanoPublico | null>(null);
	const [disponibles, setDisponibles] = useState<Disponibles | null>(null);
	const [mesa, setMesa] = useState<MesaPublica | null>(null);

	// Paso 3
	const [nombre, setNombre] = useState("");
	const [email, setEmail] = useState("");
	const [telefono, setTelefono] = useState("");
	const [nota, setNota] = useState("");
	const [privacidad, setPrivacidad] = useState(false);
	const [token, setToken] = useState<string | null>(null);
	const [sinTurnstile, setSinTurnstile] = useState(false);
	const turnstile = useRef<ControlTurnstile | null>(null);
	// Una clave para todos los envíos de esta reserva: si el alta se guardó pero no llegó la respuesta,
	// al repetirla el worker contesta la misma reserva en vez de dar otra (o de decir que la mesa, que
	// ocupa ella, ya no está libre).
	const [intento] = useState(() => crypto.randomUUID());

	// Paso 4
	const [hecha, setHecha] = useState<Confirmada | null>(null);

	const mensajeDe = (e: unknown) => (e instanceof ErrorApi ? e.message : "Algo ha fallado. Vuelve a intentarlo.");
	const fallo = (e: unknown) => setError(mensajeDe(e));

	async function elegirDia(d: string) {
		const esta = ++peticionDia.current;
		olvidarBusqueda();
		setDia(d);
		setTramos(null);
		setErrorDia(null);
		setError(null);
		try {
			const r = await api.dia(d);
			if (esta !== peticionDia.current) return;
			setTramos(r.tramos);
			setHora((h) => horaInicial(r.tramos, h));
		} catch (e) {
			if (esta === peticionDia.current) setErrorDia(mensajeDe(e));
		}
	}

	// El plano se pide una vez por visita. Si lo libre trae una mesa que no está en él, el restaurante ha
	// cambiado la sala desde entonces: se pide otra vez, sin caché. Lo que siga sin estar (un plano que
	// pasa del techo, `completo: false`) no se ofrece: no tendría botón, y «Continuar» no se podría pulsar.
	async function alDia(p: PlanoPublico, d: Disponibles): Promise<[PlanoPublico, Disponibles]> {
		const ids = (q: PlanoPublico) => new Set(q.mesas.map((m) => m.id));
		if (d.mesas.every((id) => ids(p).has(id))) return [p, d];
		const nuevo = await api.plano(true);
		const conocidas = ids(nuevo);
		return [nuevo, { ...d, mesas: d.mesas.filter((id) => conocidas.has(id)) }];
	}

	async function buscarMesas(h = hora) {
		if (!dia || !h) return;
		const esta = ++peticionMesas.current;
		setOcupado(true);
		setError(null);
		try {
			const [guardado, libres] = await Promise.all([plano ? Promise.resolve(plano) : api.plano(), api.disponibles(dia, h, personas)]);
			const [p, d] = await alDia(guardado, libres);
			if (esta !== peticionMesas.current) return;
			setPlano(p);
			setDisponibles(d);
			setHora(h);
			setMesa(null);
			setPaso("mesa");
		} catch (e) {
			if (esta === peticionMesas.current) fallo(e);
		} finally {
			if (esta === peticionMesas.current) setOcupado(false);
		}
	}

	async function confirmar() {
		if (!dia || !mesa || !token || !plano) return;
		// Un token de Turnstile vale para un intento: se da por gastado al enviarlo, pase lo que pase.
		const gastado = token;
		setToken(null);
		setOcupado(true);
		setError(null);
		try {
			const r = await api.reservar(
				{ dia_ymd: dia, hora, personas, id_mesa: mesa.id, nombre, email, telefono, nota: nota.trim() ? nota : null },
				gastado,
				intento,
			);
			setHecha(r);
			setPaso("hecho");
		} catch (e) {
			// El token de Turnstile ya se ha gastado: hace falta otro para volver a intentarlo.
			turnstile.current?.reiniciar();
			if (e instanceof ErrorApi && e.codigo === "mesa_no_disponible") {
				// Se la han quitado mientras rellenaba: vuelta al plano con lo que queda libre.
				try {
					const [p, d] = await alDia(plano, await api.disponibles(dia, hora, personas));
					setPlano(p);
					setDisponibles(d);
				} catch {
					// Se ve el plano con lo de antes; al elegir, el worker volverá a decir.
				}
				setMesa(null);
				setPaso("mesa");
			}
			fallo(e);
		} finally {
			setOcupado(false);
		}
	}

	const resumen = dia ? `${diaCorto(dia)} · ${hora} · ${personasTexto(personas)}` : "";
	// Sólo vale una hora de los tramos de ESE día, ya cargados: hasta entonces no hay mesas que ver.
	const horaValida = !!tramos && horaEnTramos(tramos, hora);

	return (
		<div className="space-y-4">
			{error ? <Aviso>{error}</Aviso> : null}

			{paso === "cuando" ? (
				<section aria-label="Cuándo" className="space-y-4">
					<h2 ref={titulo} tabIndex={-1} className="text-base font-bold outline-none">
						¿Qué día?
					</h2>
					{info.dias_abiertos.length === 0 ? (
						<Aviso tono="warning">No quedan días para reservar por internet. Llama al restaurante.</Aviso>
					) : (
						<Calendario
							abiertos={info.dias_abiertos}
							primerDia={info.primer_dia}
							ultimoDia={info.ultimo_dia}
							elegido={dia}
							onElegir={(d) => void elegirDia(d)}
						/>
					)}

					<div className="flex items-center justify-between gap-3">
						<span className="text-sm font-semibold">Personas</span>
						<div className="flex items-center gap-2">
							<Boton variante="secundario" aria-label="Una persona menos" disabled={personas <= 1} onClick={() => {
									olvidarBusqueda();
									setPersonas(personas - 1);
								}}>
								−
							</Boton>
							<span aria-live="polite" className="w-8 text-center text-base font-bold">
								{personas}
							</span>
							<Boton
								variante="secundario"
								aria-label="Una persona más"
								disabled={personas >= maxPersonas}
								onClick={() => {
									olvidarBusqueda();
									setPersonas(personas + 1);
								}}
							>
								+
							</Boton>
						</div>
					</div>

					{dia && tramos === null && errorDia ? (
						<div className="space-y-2">
							<Aviso>{errorDia}</Aviso>
							<Boton variante="secundario" onClick={() => void elegirDia(dia)}>
								Reintentar
							</Boton>
						</div>
					) : dia ? (
						<label className="block space-y-1">
							<span className="text-sm font-semibold">Hora de llegada</span>
							{tramos === null ? (
								<Cargando texto="Buscando horas…" />
							) : tramos.length === 0 ? (
								<Aviso tono="warning">Ese día no quedan horas para reservar.</Aviso>
							) : (
								<>
									<input
										type="time"
										step={60}
										className={CAMPO}
										value={hora}
										aria-invalid={!horaValida}
										onChange={(e) => {
											olvidarBusqueda();
											setHora(e.target.value);
										}}
									/>
									<span className={`block text-xs ${horaValida ? "text-fg-muted" : "text-danger"}`}>
										{horaValida ? "Se puede llegar " : "A esa hora no se puede. Se puede llegar "}
										{textoDeTramos(tramos)}.
									</span>
								</>
							)}
						</label>
					) : null}

					<div className="flex justify-end">
						<Boton disabled={!dia || !horaValida || ocupado} onClick={() => void buscarMesas()}>
							{ocupado ? "Buscando…" : "Ver mesas"}
						</Boton>
					</div>
				</section>
			) : null}

			{paso === "mesa" && plano && disponibles ? (
				<section aria-label="Mesa" className="space-y-4">
					<h2 ref={titulo} tabIndex={-1} className="text-sm font-bold outline-none">
						{resumen}
					</h2>
					{disponibles.mesas.length === 0 ? (
						<div className="space-y-3">
							<Aviso tono="warning">
								No quedan mesas para {personasTexto(personas)} a las {hora}.
							</Aviso>
							{disponibles.alternativas.length ? (
								<div>
									<div className="mb-2 text-sm text-fg-muted">Hay sitio a estas horas:</div>
									<div className="flex flex-wrap gap-2">
										{disponibles.alternativas.map((h) => (
											<Boton key={h} variante="secundario" disabled={ocupado} onClick={() => void buscarMesas(h)}>
												{h}
											</Boton>
										))}
									</div>
								</div>
							) : null}
						</div>
					) : (
						<SiFalla
							aviso="No se ha podido cargar el plano. Comprueba la conexión y vuelve a empezar."
							boton="Volver a empezar"
							onPulsar={recargarPagina}
						>
							<Suspense fallback={<Cargando texto="Cargando el plano…" />}>
								<PlanoWidget plano={plano} libres={disponibles.mesas} elegida={mesa?.id ?? null} onElegir={setMesa} />
							</Suspense>
						</SiFalla>
					)}
					{mesa ? (
						<div className="text-sm">
							Mesa {mesa.numero} · {mesa.capacidad} plazas
						</div>
					) : null}
					<div className="flex justify-between gap-3">
						<Boton variante="secundario" onClick={() => setPaso("cuando")}>
							Atrás
						</Boton>
						<Boton
							disabled={!mesa}
							onClick={() => {
								setError(null);
								setPaso("datos");
							}}
						>
							Continuar
						</Boton>
					</div>
				</section>
			) : null}

			{paso === "datos" && mesa && dia ? (
				<section aria-label="Tus datos" className="space-y-3">
					<h2 ref={titulo} tabIndex={-1} className="text-sm font-bold outline-none">
						{diaCorto(dia)} · {hora} · Mesa {mesa.numero} · {personasTexto(personas)}
					</h2>
					<label className="block space-y-1">
						<span className="text-sm font-semibold">Nombre</span>
						<input className={CAMPO} value={nombre} maxLength={80} autoComplete="name" onChange={(e) => setNombre(e.target.value)} />
					</label>
					<label className="block space-y-1">
						<span className="text-sm font-semibold">Correo</span>
						<input
							className={CAMPO}
							type="email"
							value={email}
							maxLength={254}
							autoComplete="email"
							onChange={(e) => setEmail(e.target.value)}
						/>
					</label>
					<label className="block space-y-1">
						<span className="text-sm font-semibold">Teléfono</span>
						<input
							className={CAMPO}
							type="tel"
							value={telefono}
							maxLength={25}
							autoComplete="tel"
							onChange={(e) => setTelefono(e.target.value)}
						/>
					</label>
					<label className="block space-y-1">
						<span className="text-sm font-semibold">Nota (opcional)</span>
						<textarea className={CAMPO} value={nota} maxLength={200} rows={2} onChange={(e) => setNota(e.target.value)} />
					</label>
					<p className="text-xs text-fg-muted">
						Tus datos los trata {info.negocio.razon_social || info.negocio.nombre}
						{info.negocio.cif ? ` (${info.negocio.cif})` : ""} sólo para gestionar esta reserva.
					</p>
					<label className="flex items-start gap-2 text-sm">
						<input type="checkbox" className="mt-1" checked={privacidad} onChange={(e) => setPrivacidad(e.target.checked)} />
						<span>He leído la información sobre privacidad</span>
					</label>
					{info.turnstile ? (
						<Turnstile
							ref={turnstile}
							clave={info.turnstile}
							onToken={setToken}
							onFallo={() => setSinTurnstile(true)}
						/>
					) : null}
					{sinTurnstile ? (
						<Aviso tono="warning">No se ha podido comprobar que no eres un robot. Recarga la página y vuelve a intentarlo.</Aviso>
					) : null}
					<div className="flex justify-between gap-3">
						<Boton variante="secundario" disabled={ocupado} onClick={() => setPaso("mesa")}>
							Atrás
						</Boton>
						<Boton
							disabled={!nombre.trim() || !email.trim() || !telefono.trim() || !privacidad || !token || ocupado}
							onClick={() => void confirmar()}
						>
							{ocupado ? "Reservando…" : "Confirmar"}
						</Boton>
					</div>
				</section>
			) : null}

			{paso === "hecho" && hecha ? (
				<section aria-label="Hecho" className="space-y-2 text-center">
					<h2 ref={titulo} tabIndex={-1} className="text-lg font-bold text-success outline-none">
						✓ Reserva confirmada
					</h2>
					<div className="text-sm font-semibold capitalize">
						{diaLargo(hecha.dia)} · {hecha.hora}
					</div>
					<div className="text-sm">
						{personasTexto(hecha.personas)} · Mesa {hecha.mesa}
					</div>
					<div className="text-sm text-fg-muted">
						Tu código de reserva: <strong className="text-fg">{hecha.codigo}</strong>
					</div>
				</section>
			) : null}
		</div>
	);
}
