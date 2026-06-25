// src/features/configuracion/sections/EmailConfig.tsx
import React, { useEffect, useState } from "react";
import { Panel } from "../ui/Panel";
import { cn } from "../utils";
import {
  emailConfigGet,
  emailConfigPatch,
  type EmailConfigData,
  type EmailModo,
} from "../api/emailConfigApis";

const MODOS: { value: EmailModo; title: string; desc: string }[] = [
  {
    value: "managed",
    title: "Nuestro servicio (recomendado)",
    desc: "Enviamos el correo por ti a través de nuestra infraestructura. Sin configuración adicional.",
  },
  {
    value: "smtp",
    title: "Tu propio SMTP",
    desc: "Usa el servidor de correo saliente de tu empresa o proveedor. Necesitarás los datos de conexión.",
  },
];

const DEFAULT_DATA: EmailConfigData = {
  modo: "managed",
  smtp_host: "",
  smtp_port: 587,
  smtp_user: "",
  smtp_password: "",
  smtp_from_email: "",
  smtp_from_name: "",
  smtp_use_tls: true,
};

export function EmailConfig({ darkMode }: { darkMode: boolean }) {
  const [data, setData] = useState<EmailConfigData>(DEFAULT_DATA);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    emailConfigGet()
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch((e) => {
        setError(String(e?.message ?? e));
        setLoading(false);
      });
  }, []);

  function set<K extends keyof EmailConfigData>(key: K, value: EmailConfigData[K]) {
    setData((d) => ({ ...d, [key]: value }));
    setDirty(true);
    setSuccess(false);
  }

  async function handleSave() {
    setError(null);
    setSaving(true);
    try {
      await emailConfigPatch(data);
      setDirty(false);
      setSuccess(true);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setSaving(false);
    }
  }

  const inputCls = cn(
    "mt-1 h-10 w-full rounded-xl border border-border bg-surface-2 px-3 text-sm text-fg placeholder:text-fg-subtle outline-none transition focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
  );

  const labelCls = "block text-sm font-medium text-fg";

  if (loading) {
    return (
      <div className="flex items-center justify-center py-10 text-sm text-fg-muted">
        Cargando configuración…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Selector de modo */}
      <Panel
        title="Método de envío"
        subtitle="Elige cómo quieres que se envíen los correos de pedido a proveedores."
      >
        <div className="flex flex-col gap-3">
          {MODOS.map((opt) => {
            const selected = data.modo === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => set("modo", opt.value)}
                className={cn(
                  "text-left rounded-2xl border p-4 transition",
                  selected
                    ? "border-accent bg-accent-soft"
                    : darkMode
                      ? "border-border bg-surface-2 hover:bg-surface"
                      : "border-border bg-surface hover:bg-surface-2",
                )}
              >
                <div className="flex items-start gap-3">
                  <span
                    className={cn(
                      "mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border",
                      selected ? "border-accent" : "border-border",
                    )}
                  >
                    {selected ? (
                      <span className="size-2.5 rounded-full bg-accent" />
                    ) : null}
                  </span>
                  <div className="min-w-0">
                    <div
                      className={cn(
                        "text-sm font-semibold",
                        darkMode ? "text-white" : "text-fg",
                      )}
                    >
                      {opt.title}
                    </div>
                    <div className="text-xs text-fg-muted mt-1">{opt.desc}</div>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </Panel>

      {/* Formulario SMTP (solo visible si modo = smtp) */}
      {data.modo === "smtp" ? (
        <Panel
          title="Datos de tu servidor SMTP"
          subtitle="Credenciales de tu servidor de correo saliente."
        >
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label className={labelCls}>Servidor SMTP (host)</label>
                <input
                  type="text"
                  className={inputCls}
                  value={data.smtp_host}
                  onChange={(e) => set("smtp_host", e.target.value)}
                  placeholder="smtp.gmail.com"
                  autoComplete="off"
                />
              </div>
              <div>
                <label className={labelCls}>Puerto</label>
                <input
                  type="number"
                  className={inputCls}
                  value={data.smtp_port}
                  onChange={(e) => set("smtp_port", Number(e.target.value) || 587)}
                  placeholder="587"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label className={labelCls}>Usuario</label>
                <input
                  type="text"
                  className={inputCls}
                  value={data.smtp_user}
                  onChange={(e) => set("smtp_user", e.target.value)}
                  placeholder="tu@email.com"
                  autoComplete="username"
                />
              </div>
              <div>
                <label className={labelCls}>Contraseña</label>
                <input
                  type="password"
                  className={inputCls}
                  value={data.smtp_password}
                  onChange={(e) => set("smtp_password", e.target.value)}
                  placeholder="••••••••"
                  autoComplete="current-password"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label className={labelCls}>Nombre del remitente</label>
                <input
                  type="text"
                  className={inputCls}
                  value={data.smtp_from_name}
                  onChange={(e) => set("smtp_from_name", e.target.value)}
                  placeholder="Mi Restaurante"
                />
              </div>
              <div>
                <label className={labelCls}>Email del remitente</label>
                <input
                  type="email"
                  className={inputCls}
                  value={data.smtp_from_email}
                  onChange={(e) => set("smtp_from_email", e.target.value)}
                  placeholder="pedidos@mirestaurante.com"
                />
              </div>
            </div>

            <div className="flex items-center gap-3 pt-1">
              <button
                type="button"
                role="switch"
                aria-checked={data.smtp_use_tls}
                onClick={() => set("smtp_use_tls", !data.smtp_use_tls)}
                className={cn(
                  "relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  data.smtp_use_tls ? "bg-accent" : "bg-border",
                )}
              >
                <span
                  className={cn(
                    "pointer-events-none inline-block size-5 rounded-full bg-white shadow-lg transform transition-transform",
                    data.smtp_use_tls ? "translate-x-5" : "translate-x-0",
                  )}
                />
              </button>
              <div>
                <div className={cn("text-sm font-medium", darkMode ? "text-white" : "text-fg")}>
                  STARTTLS / TLS
                </div>
                <div className="text-xs text-fg-muted">
                  Actívalo si tu servidor requiere conexión cifrada (recomendado, puerto 587).
                </div>
              </div>
            </div>

            <div className="mt-2 rounded-xl border border-border bg-surface-2 p-3 text-xs text-fg-muted">
              <strong>Gmail:</strong> usa <code>smtp.gmail.com</code>, puerto <code>587</code>, TLS
              activado, y una{" "}
              <em>contraseña de aplicación</em> (no tu contraseña de Google).
              <br />
              <strong>Outlook / Office 365:</strong> <code>smtp.office365.com</code>, puerto{" "}
              <code>587</code>, TLS activado.
            </div>
          </div>
        </Panel>
      ) : null}

      {/* Feedback y guardar */}
      {error ? (
        <div className="rounded-xl border border-danger/40 bg-danger/10 p-3 text-xs text-danger">
          {error}
        </div>
      ) : null}

      {success && !dirty ? (
        <div className="rounded-xl border border-accent/40 bg-accent-soft p-3 text-xs text-accent">
          Configuración guardada correctamente.
        </div>
      ) : null}

      <div className="flex justify-end">
        <button
          type="button"
          disabled={!dirty || saving}
          onClick={handleSave}
          className={cn(
            "inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold shadow-sm transition",
            dirty && !saving
              ? "bg-accent text-accent-fg hover:bg-accent-hover active:scale-[0.98] cursor-pointer"
              : "bg-surface-2 text-fg-muted cursor-not-allowed",
          )}
        >
          {saving ? "Guardando…" : "Guardar cambios"}
        </button>
      </div>
    </div>
  );
}
