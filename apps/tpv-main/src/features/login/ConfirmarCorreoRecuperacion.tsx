// src/features/login/ConfirmarCorreoRecuperacion.tsx
//
// LOGIN-08: confirmar, en la pantalla del PIN inicial, el correo de recuperación que se acaba de
// escribir en ella.
//
// El código se manda solo al llegar, porque se llega pulsando «Enviar código». Hasta confirmarlo,
// los códigos siguen yendo al correo de la compra; y si no se confirma nunca —se salta, o se cierra
// la app— no cambia nada. Por eso «Saltar» no es un fallo: es la opción segura.

import { useEffect, useRef, useState } from "react";
import { Mail } from "lucide-react";
import { toAppError } from "@tpv/client";

import { Button, Input } from "../../shared/ui";
import { conAviso } from "../../shared/lib/conAviso";
import { formatoCuentaAtras, useCuentaAtras } from "../../shared/lib/useCuentaAtras";
import {
    correoRecuperacionConfirmar,
    correoRecuperacionSolicitar,
} from "../configuracion/api/correoRecuperacionApis";

type Props = {
    correo: string;
    /**
     * `true` si los códigos ya van a `correo`: confirmado, o no hacía falta (ya lo era). `false` si
     * se saltó y siguen yendo al de la compra.
     */
    onResuelto: (confirmado: boolean) => void;
};

export default function ConfirmarCorreoRecuperacion({ correo, onResuelto }: Props) {
    const [enviado, setEnviado] = useState<{ emailHint: string; minutos: number } | null>(null);
    const [reenvioHasta, setReenvioHasta] = useState<number | null>(null);
    const [codigo, setCodigo] = useState("");
    const [ocupado, setOcupado] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const espera = useCuentaAtras(reenvioHasta);

    const enviar = async () => {
        setOcupado(true);
        setError(null);
        try {
            const r = await correoRecuperacionSolicitar(correo);
            if (r.sinCambios) {
                onResuelto(true);
                return;
            }
            setEnviado(r);
            setReenvioHasta(Date.now() + r.reenvioSegundos * 1000);
            setCodigo("");
        } catch (e) {
            setError(toAppError(e).message);
        } finally {
            setOcupado(false);
        }
    };

    // Una sola vez al montar (el ref aguanta el doble montaje de StrictMode). Los errores los
    // recoge `enviar` y se enseñan aquí mismo.
    const yaEnviado = useRef(false);
    useEffect(() => {
        if (yaEnviado.current) return;
        yaEnviado.current = true;
        void enviar();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const confirmar = async () => {
        setOcupado(true);
        setError(null);
        try {
            await correoRecuperacionConfirmar(codigo);
            onResuelto(true);
        } catch (e) {
            setError(toAppError(e).message);
            setOcupado(false);
        }
    };

    return (
        <div className="rounded-2xl border border-accent bg-accent-soft px-4 py-4">
            <div className="flex items-start gap-2">
                <Mail className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
                <div className="min-w-0">
                    <p className="text-sm font-semibold text-fg">Confirma el correo de recuperación</p>
                    <p className="mt-1 text-xs leading-relaxed text-fg-muted">
                        {enviado ? (
                            <>
                                Te hemos enviado un código a{" "}
                                <span className="font-semibold text-fg">{correo}</span>. Caduca en{" "}
                                {enviado.minutos} minutos.
                            </>
                        ) : ocupado ? (
                            <>
                                Enviando un código a <span className="font-semibold text-fg">{correo}</span>…
                            </>
                        ) : (
                            <>
                                Los códigos para recuperar el PIN llegarán a{" "}
                                <span className="font-semibold text-fg">{correo}</span> cuando lo confirmes.
                            </>
                        )}
                    </p>
                </div>
            </div>

            {enviado ? (
                <Input
                    id="setup-codigo-correo"
                    value={codigo}
                    onChange={(e) => setCodigo(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder="000000"
                    disabled={ocupado}
                    className="mt-3 h-12 text-center font-mono text-lg tracking-[0.35em]"
                />
            ) : null}

            {error ? (
                <p className="mt-3 text-xs font-medium text-danger" role="alert">
                    {error}
                </p>
            ) : null}

            <div className="mt-3 flex flex-wrap gap-2">
                {enviado ? (
                    <Button
                        size="sm"
                        loading={ocupado}
                        disabled={codigo.length !== 6}
                        onClick={conAviso(confirmar)}
                    >
                        Confirmar
                    </Button>
                ) : null}
                <Button
                    size="sm"
                    variant="secondary"
                    disabled={ocupado || espera > 0}
                    onClick={conAviso(enviar)}
                >
                    {espera > 0
                        ? `Enviar otro código (${formatoCuentaAtras(espera)})`
                        : enviado
                            ? "Enviar otro código"
                            : "Enviar código"}
                </Button>
                <Button size="sm" variant="secondary" disabled={ocupado} onClick={() => onResuelto(false)}>
                    Saltar
                </Button>
            </div>

            <p className="mt-3 text-xs leading-relaxed text-fg-muted">
                ¿No tienes acceso a ese correo ahora? Salta este paso: se usará el correo de la compra
                y podrás cambiarlo en Configuración → Negocio.
            </p>
        </div>
    );
}
