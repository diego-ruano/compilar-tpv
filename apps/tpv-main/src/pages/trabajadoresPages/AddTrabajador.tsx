import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { invokeClient } from "@tpv/client";

type Rol = {
  ID_Rol: number;
  Nombre_Rol: string;
};

function normalizeNullable(v: string) {
  const s = String(v ?? "").trim();
  return s ? s : null;
}

function unwrapMaybeOkEnvelope<T>(x: any): T {
  if (!x || typeof x !== "object") return x as T;
  if (!("ok" in x)) return x as T;

  const ok = !!x.ok;
  if (!ok) {
    const msg = String(x.error ?? x.message ?? "remote_ok_false");
    throw new Error(msg);
  }

  if ("result" in x) return x.result as T;
  if ("user" in x) return x.user as T;
  if ("status" in x) return x.status as T;
  if ("data" in x) return x.data as T;

  return x as T;
}

async function invokeLocalSmart<T>(
  cmd: string,
  payloadDirect?: Record<string, any>,
  payloadArgsWrapper?: Record<string, any>,
): Promise<T> {
  if (payloadArgsWrapper) {
    try {
      return await invoke<T>(cmd, payloadArgsWrapper);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (
        !msg.includes("missing required key args") &&
        !msg.includes("invalid args") &&
        !msg.includes("unknown field")
      ) {
        throw e;
      }
    }
  }

  return await invoke<T>(cmd, payloadDirect ?? {});
}

async function getRolesLocal(): Promise<Rol[]> {
  const raw = await invokeLocalSmart<Rol[]>(
    "trabajadores_get_roles",
    {},
    { args: {} },
  );

  const data = unwrapMaybeOkEnvelope<any>(raw);
  return Array.isArray(data) ? data : [];
}

function getErrorMessage(e: unknown) {
  const msg = String((e as any)?.message ?? e ?? "").toLowerCase();

  if (msg.includes("email_already_exists") || msg.includes("usuarios.email") || msg.includes("email")) {
    return "Ese email ya existe";
  }

  if (msg.includes("trabajadores.dni") || msg.includes(" dni") || msg.endsWith("dni")) {
    return "Ese DNI ya existe";
  }

  if (
    msg.includes("numero_seguridad_social") ||
    msg.includes("seguridad social") ||
    msg.includes("seguridad") ||
    msg.includes("nss")
  ) {
    return "Ese Nº de Seguridad Social ya existe";
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
  idRol: number;
  email: string;
  passwordHash: string;
  nombre: string;
  apellido?: string | null;
  estado: "Activo" | "Inactivo";
  dni?: string | null;
  telefono?: string | null;
  puesto?: string | null;
  iban?: string | null;
  numeroSeguridadSocial?: string | null;
  fechaInicioContrato?: string | null;
  fechaFinContrato?: string | null;
}): Promise<boolean> {
  const body = {
    idRol: payload.idRol,
    id_rol: payload.idRol,

    email: payload.email,
    passwordHash: payload.passwordHash,
    password_hash: payload.passwordHash,

    nombre: payload.nombre,
    apellido: payload.apellido ?? null,
    estado: payload.estado,

    dni: payload.dni ?? null,
    telefono: payload.telefono ?? null,
    puesto: payload.puesto ?? null,
    iban: payload.iban ?? null,

    numeroSeguridadSocial: payload.numeroSeguridadSocial ?? null,
    numero_seguridad_social: payload.numeroSeguridadSocial ?? null,

    fechaInicioContrato: payload.fechaInicioContrato ?? null,
    fecha_inicio_contrato: payload.fechaInicioContrato ?? null,

    fechaFinContrato: payload.fechaFinContrato ?? null,
    fecha_fin_contrato: payload.fechaFinContrato ?? null,
  };

  const ok = await invokeClient<boolean>("trabajadores_create", {
    args: {
      id_rol: body.id_rol,
      email: body.email,
      password_hash: body.password_hash,
      nombre: body.nombre,
      apellido: body.apellido,
      estado: body.estado,
      dni: body.dni,
      telefono: body.telefono,
      puesto: body.puesto,
      iban: body.iban,
      numero_seguridad_social: body.numero_seguridad_social,
      fecha_inicio_contrato: body.fecha_inicio_contrato,
      fecha_fin_contrato: body.fecha_fin_contrato,
    },
  });

  if (typeof ok !== "boolean") {
    throw new Error("invalid_remote_response");
  }

  return ok;
}

function AddTrabajador() {
  const navigate = useNavigate();

  const [roles, setRoles] = useState<Rol[]>([]);
  const [idRol, setIdRol] = useState<number | "">("");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [nombre, setNombre] = useState("");
  const [apellido, setApellido] = useState("");
  const [estado, setEstado] = useState<"Activo" | "Inactivo">("Activo");

  const [dni, setDni] = useState("");
  const [telefono, setTelefono] = useState("");
  const [puesto, setPuesto] = useState("");

  const [iban, setIban] = useState("");
  const [numeroSS, setNumeroSS] = useState("");

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
        console.error(e);
        setError("No se pudieron cargar los roles.");
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
    if (!password.trim()) return setError("El PIN es obligatorio");
    if (password.trim().length < 4) {
      return setError("El PIN debe tener al menos 4 dígitos");
    }
    if (!nombre.trim()) return setError("El nombre es obligatorio");

    setSaving(true);

    try {
      const passwordHash = await invoke<string>("hash_password", {
        pin: password.trim(),
      });

      const ok = await createTrabajadorRemote({
        idRol: Number(idRol),
        email: email.trim(),
        passwordHash,
        nombre: nombre.trim(),
        apellido: normalizeNullable(apellido),
        estado,
        dni: normalizeNullable(dni),
        telefono: normalizeNullable(telefono),
        puesto: normalizeNullable(puesto),
        iban: normalizeNullable(iban),
        numeroSeguridadSocial: normalizeNullable(numeroSS),
        fechaInicioContrato: normalizeNullable(fechaInicioContrato),
        fechaFinContrato: indefinido ? null : normalizeNullable(fechaFinContrato),
      });

      if (!ok) {
        setError("No se pudo guardar el trabajador");
        return;
      }

      navigate("/Trabajadores");
    } catch (e) {
      console.error(e);
      setError(getErrorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="w-full min-h-full mb-10 mt-5 bg-gris flex flex-col p-4 sm:p-6 lg:p-10 pt-5 gap-4 items-center">
      <div className="bg-blanco w-full max-w-3xl p-4 sm:p-6 rounded-xl shadow-xs flex flex-col gap-5">
        <div className="w-full flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex flex-col">
            <h2 className="text-2xl font-bold">AÑADIR TRABAJADOR</h2>
            <p className="text-sm text-negro/60">
              Crea el acceso al TPV y los datos del trabajador.
            </p>
          </div>

          <button
            type="button"
            onClick={() => navigate(-1)}
            className="w-full sm:w-auto border-2 border-negro rounded-xl px-3 py-2 text-negro transition-all duration-300 ease-out hover:bg-negro hover:text-white hover:shadow-md"
          >
            Volver
          </button>
        </div>

        {error && (
          <div className="w-full rounded-xl border border-rojo/30 bg-rojo/10 p-3 text-sm text-rojo">
            {error}
          </div>
        )}

        <div className="rounded-xl border border-negro/10 p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <p className="font-bold">Acceso TPV</p>
            <span className="text-xs text-negro/60">
              {loadingRoles
                ? "Cargando roles..."
                : rolActual
                  ? rolActual.Nombre_Rol
                  : "Sin rol"}
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium">Rol *</label>
              <select
                value={idRol}
                onChange={(e) => setIdRol(e.target.value ? Number(e.target.value) : "")}
                disabled={loadingRoles}
                className="border border-negro/15 rounded-xl px-3 py-2 bg-blanco outline-none focus:border-negro/30 disabled:opacity-60 disabled:cursor-not-allowed"
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
                className="border border-negro/15 rounded-xl px-3 py-2 bg-blanco outline-none focus:border-negro/30"
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
                className="border border-negro/15 rounded-xl px-3 py-2 outline-none focus:border-negro/30"
                placeholder="correo@empresa.com"
                autoComplete="off"
              />
              <p className="text-xs text-negro/50">Debe ser único.</p>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium">PIN (solo números) *</label>
              <input
                value={password}
                onChange={(e) => setPassword(e.target.value.replace(/\D/g, ""))}
                inputMode="numeric"
                pattern="[0-9]*"
                className="border border-negro/15 rounded-xl px-3 py-2 outline-none focus:border-negro/30"
                placeholder="1234"
                autoComplete="off"
              />
              <p className="text-xs text-negro/50">Recomendado 4–6 dígitos.</p>
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-negro/10 p-4 flex flex-col gap-3">
          <p className="font-bold">Datos del trabajador</p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium">Nombre *</label>
              <input
                value={nombre}
                onChange={(e) => setNombre(e.target.value)}
                className="border border-negro/15 rounded-xl px-3 py-2 outline-none focus:border-negro/30"
                placeholder="Nombre"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium">Apellido</label>
              <input
                value={apellido}
                onChange={(e) => setApellido(e.target.value)}
                className="border border-negro/15 rounded-xl px-3 py-2 outline-none focus:border-negro/30"
                placeholder="Apellido"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium">DNI</label>
              <input
                value={dni}
                onChange={(e) => setDni(e.target.value)}
                className="border border-negro/15 rounded-xl px-3 py-2 outline-none focus:border-negro/30"
                placeholder="12345678X"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium">Teléfono</label>
              <input
                value={telefono}
                onChange={(e) => setTelefono(e.target.value)}
                className="border border-negro/15 rounded-xl px-3 py-2 outline-none focus:border-negro/30"
                placeholder="600 000 000"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium">Puesto (opcional)</label>
              <input
                value={puesto}
                onChange={(e) => setPuesto(e.target.value)}
                className="border border-negro/15 rounded-xl px-3 py-2 outline-none focus:border-negro/30"
                placeholder="Camarero / Limpieza / Cocina..."
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium">IBAN</label>
              <input
                value={iban}
                onChange={(e) => setIban(e.target.value)}
                className="border border-negro/15 rounded-xl px-3 py-2 outline-none focus:border-negro/30"
                placeholder="ES00 0000 0000 0000 0000 0000"
                autoComplete="off"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium">Nº Seguridad Social</label>
              <input
                value={numeroSS}
                onChange={(e) => setNumeroSS(e.target.value)}
                className="border border-negro/15 rounded-xl px-3 py-2 outline-none focus:border-negro/30"
                placeholder="00/0000000000"
                autoComplete="off"
              />
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-negro/10 p-4 flex flex-col gap-3">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <p className="font-bold">Contrato</p>

            <label className="flex items-center gap-2 text-sm text-negro/70 select-none cursor-pointer">
              <input
                type="checkbox"
                checked={indefinido}
                onChange={(e) => setIndefinido(e.target.checked)}
              />
              Indefinido (sin fecha fin)
            </label>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium">Fecha inicio contrato</label>
              <input
                type="date"
                value={fechaInicioContrato}
                onChange={(e) => setFechaInicioContrato(e.target.value)}
                className="border border-negro/15 rounded-xl px-3 py-2 outline-none focus:border-negro/30"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium">Fecha fin contrato</label>
              <input
                type="date"
                value={fechaFinContrato}
                disabled={indefinido}
                onChange={(e) => setFechaFinContrato(e.target.value)}
                className="border border-negro/15 rounded-xl px-3 py-2 outline-none focus:border-negro/30 disabled:opacity-50 disabled:cursor-not-allowed"
              />
              <p className="text-xs text-negro/50">Si es indefinido, se guarda como NULL.</p>
            </div>
          </div>
        </div>

        <div className="w-full flex flex-col-reverse sm:flex-row items-stretch sm:items-center justify-end gap-3 pt-1">
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="w-full sm:w-auto border-2 border-negro rounded-xl px-4 py-2 text-negro transition-all duration-300 hover:bg-negro hover:text-white"
          >
            Cancelar
          </button>

          <button
            type="button"
            disabled={saving || loadingRoles}
            onClick={guardar}
            className="w-full sm:w-auto border-2 border-verde text-verde rounded-xl px-4 py-2 font-medium transition-all duration-300 hover:bg-verde hover:text-white disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {saving ? "Guardando..." : "Guardar trabajador"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default AddTrabajador;