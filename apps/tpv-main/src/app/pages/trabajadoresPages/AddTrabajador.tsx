import { commands } from "@tpv/client";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { UserPlus, ArrowLeft, KeyRound, IdCard, FileText, Save } from "lucide-react";
import type { RolRow as Rol, TrabajadorDetailRow as TrabajadorDetail } from "@tpv/contracts";
import { toAppError } from "@tpv/client";
import { conAviso } from "../../../shared/lib/conAviso";
import { ROL_ADMIN } from "../../../shared/lib/permisos";
import CasillaSinPin from "./CasillaSinPin";

function normalizeNullable(v: string) {
  const s = String(v ?? "").trim();
  return s ? s : null;
}

/**
 * Un PIN de 6 cifras que no sabe nadie, para quien entra sin PIN y no ha escrito uno. La cuenta
 * guarda siempre un PIN: si algún día se le quita «Entra sin PIN», la edición pide uno nuevo.
 */
function pinAlAzar(): string {
  const n = new Uint32Array(1);
  crypto.getRandomValues(n);
  return String(n[0] % 1_000_000).padStart(6, "0");
}

const getRolesLocal = commands.trabajadoresGetRoles;

function getErrorMessage(e: unknown) {
  const msg = String((e as any)?.message ?? e ?? "").toLowerCase();

  if (msg.includes("email_already_exists") || msg.includes("usuarios.email") || msg.includes("email")) {
    return "Ese email ya existe";
  }

  // Lo que el backend rechaza a propósito (una validación, un conflicto) llega con su frase y se
  // enseña tal cual, por código; antes caía en el «Error al guardar el trabajador» de abajo. Lo de
  // arriba es el choque del UNIQUE, que llega con el texto de SQLite.
  const { code, message } = toAppError(e);
  if (code === "validation" || code === "conflict" || code === "not_found") {
    return message;
  }

  if (msg.includes("role_not_found")) {
    return "No se encontró el rol seleccionado";
  }

  if (msg.includes("invalid_remote_response")) {
    return "La respuesta del servidor no es válida";
  }

  if (msg.includes("local_disabled")) {
    return "Esta operación todavía requiere conexión con el servidor";
  }

  if (msg.includes("trabajadores_get_roles") || msg.includes("roles")) {
    return "No se pudieron cargar los roles";
  }

  if (msg.includes("timeout") || msg.includes("failed to fetch") || msg.includes("network")) {
    return "No se pudo conectar con el servidor";
  }

  return "Error al guardar el trabajador";
}

/**
 * Local-First: alta de trabajador contra el comando Tauri `trabajadores_create`
 * (crea Usuario + Trabajador en el SQLite local de forma atómica).
 */
async function createTrabajadorRemote(payload: {
  idRol: string;
  email: string;
  pin: string;
  nombre: string;
  apellido?: string | null;
  estado: "Activo" | "Inactivo";
  telefono?: string | null;
  puesto?: string | null;
  fechaInicioContrato?: string | null;
  fechaFinContrato?: string | null;
  sinPin: boolean;
}): Promise<boolean> {
  const body = {
    idRol: payload.idRol,
    id_rol: payload.idRol,

    email: payload.email,
    pin: payload.pin,

    nombre: payload.nombre,
    apellido: payload.apellido ?? null,
    estado: payload.estado,

    telefono: payload.telefono ?? null,
    puesto: payload.puesto ?? null,

    fechaInicioContrato: payload.fechaInicioContrato ?? null,
    fecha_inicio_contrato: payload.fechaInicioContrato ?? null,

    fechaFinContrato: payload.fechaFinContrato ?? null,
    fecha_fin_contrato: payload.fechaFinContrato ?? null,
  };

  const ok = await commands.trabajadoresCreate({
      id_rol: body.id_rol,
      email: body.email,
      // RI-63: el PIN, no su hash: lo hashea el backend, que así exige la política del PIN.
      pin: body.pin,
      nombre: body.nombre,
      apellido: body.apellido,
      estado: body.estado,
      telefono: body.telefono,
      puesto: body.puesto,
      fecha_inicio_contrato: body.fecha_inicio_contrato,
      fecha_fin_contrato: body.fecha_fin_contrato,
      sin_pin: payload.sinPin,
    });

  if (typeof ok !== "boolean") {
    throw new Error("invalid_remote_response");
  }

  return ok;
}

function AddTrabajador() {
  const navigate = useNavigate();

  const [roles, setRoles] = useState<Rol[]>([]);
  const [idRol, setIdRol] = useState<string>("");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [nombre, setNombre] = useState("");
  const [apellido, setApellido] = useState("");
  const [estado, setEstado] = useState<"Activo" | "Inactivo">("Activo");
  const [sinPin, setSinPin] = useState(false);

  const [telefono, setTelefono] = useState("");
  const [puesto, setPuesto] = useState("");

  const [fechaInicioContrato, setFechaInicioContrato] = useState("");
  const [fechaFinContrato, setFechaFinContrato] = useState("");
  const [indefinido, setIndefinido] = useState(true);

  const [saving, setSaving] = useState(false);
  const [loadingRoles, setLoadingRoles] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const cargarRoles = async () => {
      try {
        setLoadingRoles(true);
        const rows = await getRolesLocal();
        setRoles(rows);
        if (rows.length === 1) setIdRol(rows[0].ID_Rol);
      } catch (e) {
        setError(`No se pudieron cargar los roles: ${toAppError(e).message}`);
      } finally {
        setLoadingRoles(false);
      }
    };

    void cargarRoles();
  }, []);

  const rolActual = useMemo(() => {
    if (!idRol) return null;
    return roles.find((r) => r.ID_Rol === idRol) ?? null;
  }, [idRol, roles]);

  useEffect(() => {
    if (indefinido) setFechaFinContrato("");
  }, [indefinido]);

  const guardar = async () => {
    setError(null);

    if (!idRol) return setError("Selecciona un rol");
    if (!email.trim()) return setError("El email es obligatorio");
    // Quien entra sin PIN puede dejarlo vacío: se le pone uno al azar.
    const pin = password.trim() || (sinPin ? pinAlAzar() : "");
    if (!pin) return setError("El PIN es obligatorio");
    // RI-63: el teclado del login sólo admite de 4 a 6 cifras (el backend lo exige igual).
    if (!/^\d{4,6}$/.test(pin)) {
      return setError("El PIN tiene que tener entre 4 y 6 cifras");
    }
    if (!nombre.trim()) return setError("El nombre es obligatorio");

    setSaving(true);

    try {
      const ok = await createTrabajadorRemote({
        idRol: idRol,
        email: email.trim(),
        pin,
        nombre: nombre.trim(),
        apellido: normalizeNullable(apellido),
        estado,
        telefono: normalizeNullable(telefono),
        puesto: normalizeNullable(puesto),
        fechaInicioContrato: normalizeNullable(fechaInicioContrato),
        fechaFinContrato: indefinido ? null : normalizeNullable(fechaFinContrato),
        sinPin,
      });

      if (!ok) {
        setError("No se pudo guardar el trabajador");
        return;
      }

      void navigate("/Trabajadores");
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-h-full w-full touch-pan-y flex-col items-center gap-3 bg-bg p-2 pt-3 sm:gap-4 sm:p-4 lg:p-6 lg:pt-5">
      <div className="flex w-full flex-col gap-3 sm:gap-4">
        {/* HEADER */}
        <div className="flex flex-col items-stretch gap-3 rounded-2xl border border-border bg-surface p-3 shadow-sm xs:flex-row xs:items-center xs:justify-between sm:p-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="grid size-11 shrink-0 place-items-center rounded-2xl bg-accent-soft text-accent">
              <UserPlus className="size-6" aria-hidden />
            </div>
            <div className="min-w-0">
              <h2 className="text-xl font-bold text-fg sm:text-2xl">Añadir trabajador</h2>
              <p className="text-sm text-fg-muted">
                Crea el acceso al TPV y los datos del trabajador.
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => void navigate(-1)}
            className="inline-flex w-full shrink-0 cursor-pointer items-center justify-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 text-sm font-semibold text-fg transition hover:bg-surface-2 xs:w-auto"
          >
            <ArrowLeft className="size-4" aria-hidden />
            <span className="hidden xs:inline">Volver</span>
          </button>
        </div>

        {error && (
          <div className="w-full rounded-2xl border border-danger/30 bg-danger-soft p-3 text-sm text-danger">
            {error}
          </div>
        )}

        {/* BODY: Acceso (1 col) + Datos (2 cols) */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-4 shadow-sm lg:col-span-1">
            <div className="flex items-center justify-between gap-2">
              <p className="flex items-center gap-2 font-bold text-fg">
                <KeyRound className="size-4 text-accent" aria-hidden />
                Acceso TPV
              </p>
              <span className="text-xs text-fg-muted">
                {loadingRoles
                  ? "Cargando roles..."
                  : rolActual
                    ? rolActual.Nombre_Rol
                    : "Sin rol"}
              </span>
            </div>

          <div className="grid grid-cols-1 gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium">Rol *</label>
              <select
                value={idRol}
                onChange={(e) => setIdRol(e.target.value)}
                disabled={loadingRoles}
                className="border border-border rounded-xl px-3 py-2 bg-surface outline-none focus:border-accent disabled:opacity-60 disabled:cursor-not-allowed"
              >
                <option value="">Selecciona un rol</option>
                {roles.map((r) => (
                  <option key={r.ID_Rol} value={r.ID_Rol}>
                    {r.Nombre_Rol}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium">Estado</label>
              <select
                value={estado}
                onChange={(e) => setEstado(e.target.value as "Activo" | "Inactivo")}
                className="border border-border rounded-xl px-3 py-2 bg-surface outline-none focus:border-accent"
              >
                <option value="Activo">Activo</option>
                <option value="Inactivo">Inactivo</option>
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium">Email *</label>
              <input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="border border-border rounded-xl px-3 py-2 outline-none focus:border-accent"
                placeholder="correo@empresa.com"
                autoComplete="off"
              />
              <p className="text-xs text-fg-subtle">Debe ser único.</p>
            </div>

            <CasillaSinPin
              checked={sinPin}
              onChange={setSinPin}
              esAdministrador={rolActual?.Nombre_Rol === ROL_ADMIN}
            />

            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium">
                {sinPin ? "PIN (opcional)" : "PIN (solo números) *"}
              </label>
              <input
                value={password}
                onChange={(e) => setPassword(e.target.value.replace(/\D/g, "").slice(0, 6))}
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                className="border border-border rounded-xl px-3 py-2 outline-none focus:border-accent"
                placeholder="1234"
                autoComplete="off"
              />
              <p className="text-xs text-fg-subtle">
                {sinPin
                  ? "No se le pedirá. Sirve si algún día le quitas «Entra sin PIN»; si lo dejas vacío, se le pone uno al azar."
                  : "De 4 a 6 cifras: es lo que admite el teclado del fichaje."}
              </p>
            </div>
          </div>
          </div>

          <div className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-4 shadow-sm lg:col-span-2">
            <p className="flex items-center gap-2 font-bold text-fg">
              <IdCard className="size-4 text-accent" aria-hidden />
              Datos del trabajador
            </p>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium">Nombre *</label>
              <input
                value={nombre}
                onChange={(e) => setNombre(e.target.value)}
                className="border border-border rounded-xl px-3 py-2 outline-none focus:border-accent"
                placeholder="Nombre"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium">Apellido</label>
              <input
                value={apellido}
                onChange={(e) => setApellido(e.target.value)}
                className="border border-border rounded-xl px-3 py-2 outline-none focus:border-accent"
                placeholder="Apellido"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium">Teléfono</label>
              <input
                value={telefono}
                onChange={(e) => setTelefono(e.target.value)}
                className="border border-border rounded-xl px-3 py-2 outline-none focus:border-accent"
                placeholder="600 000 000"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium">Puesto (opcional)</label>
              <input
                value={puesto}
                onChange={(e) => setPuesto(e.target.value)}
                className="border border-border rounded-xl px-3 py-2 outline-none focus:border-accent"
                placeholder="Camarero / Limpieza / Cocina..."
              />
            </div>
          </div>
          </div>
        </div>

        <div className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-4 shadow-sm">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="flex items-center gap-2 font-bold text-fg">
              <FileText className="size-4 text-accent" aria-hidden />
              Contrato
            </p>

            <label className="flex cursor-pointer select-none items-center gap-2 text-sm text-fg-muted">
              <input
                type="checkbox"
                className="accent-accent"
                checked={indefinido}
                onChange={(e) => setIndefinido(e.target.checked)}
              />
              Indefinido (sin fecha fin)
            </label>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium">Fecha inicio contrato</label>
              <input
                type="date"
                value={fechaInicioContrato}
                onChange={(e) => setFechaInicioContrato(e.target.value)}
                className="border border-border rounded-xl px-3 py-2 outline-none focus:border-accent"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium">Fecha fin contrato</label>
              <input
                type="date"
                value={fechaFinContrato}
                disabled={indefinido}
                onChange={(e) => setFechaFinContrato(e.target.value)}
                className="border border-border rounded-xl px-3 py-2 outline-none focus:border-accent disabled:opacity-50 disabled:cursor-not-allowed"
              />
              <p className="text-xs text-fg-subtle">Si es indefinido, se guarda como NULL.</p>
            </div>
          </div>
        </div>

        <div className="flex w-full flex-col-reverse items-stretch justify-end gap-3 pt-1 sm:flex-row sm:items-center">
          <button
            type="button"
            onClick={() => void navigate(-1)}
            className="w-full cursor-pointer rounded-xl border border-border bg-surface px-4 py-2 font-semibold text-fg transition hover:bg-surface-2 sm:w-auto"
          >
            Cancelar
          </button>

          <button
            type="button"
            disabled={saving || loadingRoles}
            onClick={conAviso(guardar)}
            className="inline-flex w-full cursor-pointer items-center justify-center gap-2 rounded-xl bg-accent px-4 py-2 font-semibold text-white shadow-sm transition hover:bg-accent-hover active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
          >
            <Save className="size-4" aria-hidden />
            {saving ? "Guardando..." : "Guardar trabajador"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default AddTrabajador;
