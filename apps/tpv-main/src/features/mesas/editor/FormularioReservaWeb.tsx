// src/features/mesas/editor/FormularioReservaWeb.tsx
//
// Reservas desde la web (docs/estudios/reservas-web.md): si una mesa se puede reservar desde la web
// y cuándo. Se guarda al aceptar, aparte del «Guardar layout»: no es la forma del plano, y una mesa
// nueva sólo se puede configurar cuando el plano ya la ha guardado (antes no tiene id).
import { useState } from "react";
import { commands, toAppError } from "@tpv/client";
import type { ReservaWebMesaDto } from "@tpv/contracts";
import { Chip, IconButton, Modal } from "./ControlesEditor";
import { CampoHora } from "../../../shared/ui/CampoHora";

/** Lunes primero, como en el calendario: el bit de cada día en `Dias_Semana`. */
const DIAS: { letra: string; nombre: string; bit: number }[] = [
    { letra: "L", nombre: "Lunes", bit: 1 },
    { letra: "M", nombre: "Martes", bit: 2 },
    { letra: "X", nombre: "Miércoles", bit: 4 },
    { letra: "J", nombre: "Jueves", bit: 8 },
    { letra: "V", nombre: "Viernes", bit: 16 },
    { letra: "S", nombre: "Sábado", bit: 32 },
    { letra: "D", nombre: "Domingo", bit: 64 },
];

const TODOS_LOS_DIAS = 127;

const campo = "w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-fg outline-none";

export default function FormularioReservaWeb({
    nombreMesa,
    idMesa,
    actual,
    onCerrar,
    onGuardada,
}: {
    nombreMesa: string;
    /** `null` si la mesa todavía no se ha guardado en el plano. */
    idMesa: string | null;
    actual: ReservaWebMesaDto | undefined;
    onCerrar: () => void;
    onGuardada: (mesa: ReservaWebMesaDto) => void;
}) {
    const [activa, setActiva] = useState(actual?.activa ?? false);
    const [dias, setDias] = useState(actual?.dias_semana ?? TODOS_LOS_DIAS);
    const [fechaDesde, setFechaDesde] = useState(actual?.fecha_desde ?? "");
    const [fechaHasta, setFechaHasta] = useState(actual?.fecha_hasta ?? "");
    const [horaDesde, setHoraDesde] = useState(actual?.hora_desde ?? "");
    const [horaHasta, setHoraHasta] = useState(actual?.hora_hasta ?? "");
    const [error, setError] = useState("");
    const [guardando, setGuardando] = useState(false);

    async function guardar() {
        if (!idMesa) return;
        const mesa: ReservaWebMesaDto = {
            id_mesa: idMesa,
            activa,
            dias_semana: dias,
            fecha_desde: fechaDesde || null,
            fecha_hasta: fechaHasta || null,
            hora_desde: horaDesde.trim() || null,
            hora_hasta: horaHasta.trim() || null,
        };
        setGuardando(true);
        setError("");
        try {
            await commands.reservaWebGuardarMesa(mesa);
            onGuardada(mesa);
        } catch (e) {
            // La validación es la del backend (`MesaWebValidada`): su frase dice qué falta.
            setError(toAppError(e).message);
        } finally {
            setGuardando(false);
        }
    }

    return (
        <Modal open title={`${nombreMesa} · Reservas desde la web`} onClose={onCerrar}>
            {!idMesa ? (
                <div className="space-y-3 text-sm text-fg">
                    <p>Guarda el plano antes de configurar esta mesa para la web.</p>
                    <IconButton onClick={onCerrar}>Entendido</IconButton>
                </div>
            ) : (
                <div className="space-y-4">
                    <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3">
                        <input
                            type="checkbox"
                            checked={activa}
                            onChange={(e) => setActiva(e.target.checked)}
                            className="h-5 w-5 accent-accent"
                        />
                        <span className="text-sm font-semibold text-fg">Se puede reservar desde la web</span>
                    </label>

                    <div>
                        <div className="text-xs font-semibold text-fg-muted mb-1">Días</div>
                        <div className="flex flex-wrap gap-2">
                            {DIAS.map((d) => (
                                <span key={d.bit} title={d.nombre}>
                                    <Chip active={(dias & d.bit) !== 0} onClick={() => setDias(dias ^ d.bit)}>
                                        {d.letra}
                                    </Chip>
                                </span>
                            ))}
                        </div>
                    </div>

                    <div>
                        <div className="text-xs font-semibold text-fg-muted mb-1">
                            Fechas <span className="font-normal">(vacías: todo el año)</span>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                            <input
                                type="date"
                                aria-label="Desde"
                                value={fechaDesde}
                                max={fechaHasta || undefined}
                                onChange={(e) => setFechaDesde(e.target.value)}
                                className={campo}
                            />
                            <input
                                type="date"
                                aria-label="Hasta"
                                value={fechaHasta}
                                min={fechaDesde || undefined}
                                onChange={(e) => setFechaHasta(e.target.value)}
                                className={campo}
                            />
                        </div>
                    </div>

                    <div>
                        <div className="text-xs font-semibold text-fg-muted mb-1">Horario</div>
                        <div className="flex items-center gap-2">
                            <CampoHora aria-label="Desde" valor={horaDesde} onCambio={setHoraDesde} className="w-full bg-surface text-sm text-fg" />
                            <span className="text-sm text-fg-muted">a</span>
                            <CampoHora aria-label="Hasta" valor={horaHasta} onCambio={setHoraHasta} className="w-full bg-surface text-sm text-fg" />
                        </div>
                        <p className="mt-1 text-xs text-fg-muted">
                            La reserva entera tiene que caber en el horario, con unos minutos de margen.
                        </p>
                    </div>

                    {error ? <p className="text-sm text-danger">{error}</p> : null}

                    <div className="flex justify-end gap-2">
                        <IconButton onClick={onCerrar}>Cancelar</IconButton>
                        <IconButton
                            variant="primary"
                            disabled={guardando}
                            onClick={() => void guardar()}
                        >
                            {guardando ? "Guardando…" : "Guardar"}
                        </IconButton>
                    </div>
                </div>
            )}
        </Modal>
    );
}
