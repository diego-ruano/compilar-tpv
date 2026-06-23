import { useEffect, useState } from "react";
import { Trash2, Plus, Send, XCircle, Mail } from "lucide-react";
import Modal from "./Modal";
import { cn } from "../../shared/lib/cn";
import type { PedidoRow, LineaPedido, PedidoEstado } from "./pedidosApis";
import type { ProveedorRow } from "./proveedoresApis";

type Props = {
  open: boolean;
  onClose: () => void;
  pedido: PedidoRow | null;
  proveedores: ProveedorRow[];
  onSave: (pedido: PedidoRow) => void;
  onCancelarPedido: (pedidoId: string) => void;
  onMandarPedido: (pedido: PedidoRow) => void;
  isBusy?: boolean;
};

const ESTADO_LABEL: Record<PedidoEstado, string> = {
  borrador: "Borrador",
  enviado: "Enviado",
  cancelado: "Cancelado",
};

const ESTADO_CLASS: Record<PedidoEstado, string> = {
  borrador: "bg-surface-2 text-fg-muted border border-border",
  enviado: "bg-accent-soft text-accent border border-accent/30",
  cancelado: "bg-danger-soft text-danger border border-danger/30",
};

export default function PedidoModal({
  open,
  onClose,
  pedido,
  proveedores,
  onSave,
  onCancelarPedido,
  onMandarPedido,
  isBusy = false,
}: Props) {
  const [idProveedor, setIdProveedor] = useState("");
  const [emailDestino, setEmailDestino] = useState("");
  const [notas, setNotas] = useState("");
  const [lineas, setLineas] = useState<LineaPedido[]>([]);

  useEffect(() => {
    if (!pedido) return;
    setIdProveedor(pedido.idProveedor ?? "");
    setEmailDestino(pedido.emailDestino ?? "");
    setNotas(pedido.notas ?? "");
    setLineas(pedido.lineas ?? []);
  }, [pedido]);

  if (!pedido) return null;

  const esEditable = pedido.estado === "borrador";
  const proveedorActual = proveedores.find((p) => p.ID_Proveedor === idProveedor);

  function handleProveedorChange(newId: string) {
    setIdProveedor(newId);
    const prov = proveedores.find((p) => p.ID_Proveedor === newId);
    if (prov?.Email) setEmailDestino(prov.Email);
    else if (!newId) setEmailDestino("");
  }

  function addLinea() {
    setLineas((prev) => [
      ...prev,
      { id: crypto.randomUUID(), nombreProducto: "", cantidad: 1, precioUnitario: null, unidad: null },
    ]);
  }

  function updateLinea(id: string, field: keyof LineaPedido, value: unknown) {
    setLineas((prev) => prev.map((l) => (l.id === id ? { ...l, [field]: value } : l)));
  }

  function removeLinea(id: string) {
    setLineas((prev) => prev.filter((l) => l.id !== id));
  }

  function buildPedido(): PedidoRow {
    const prov = proveedores.find((p) => p.ID_Proveedor === idProveedor);
    return {
      ...pedido!,
      idProveedor: idProveedor || null,
      nombreProveedor: prov?.Nombre_Empresa ?? null,
      emailDestino: emailDestino || null,
      notas: notas || null,
      lineas,
    };
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Pedido · ${pedido.fechaCreacion}`}
      zIndex={70}
      widthClass="max-w-[860px]"
    >
      {/* Estado */}
      <div className="mb-4 flex items-center gap-3">
        <span
          className={cn(
            "inline-flex items-center rounded-lg px-3 py-1 text-sm font-semibold",
            ESTADO_CLASS[pedido.estado],
          )}
        >
          {ESTADO_LABEL[pedido.estado]}
        </span>
        {pedido.estado === "enviado" && pedido.fechaEnvio && (
          <span className="text-sm text-fg-muted">Enviado el {pedido.fechaEnvio}</span>
        )}
      </div>

      {/* Proveedor + Email */}
      <div className="mb-4 grid grid-cols-2 gap-4">
        <div>
          <label className="text-sm font-semibold text-fg">Proveedor</label>
          <select
            value={idProveedor}
            onChange={(e) => handleProveedorChange(e.target.value)}
            disabled={!esEditable}
            className="mt-1 h-10 w-full rounded-xl border border-border bg-surface-2 px-3 text-fg outline-none transition focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
          >
            <option value="">Sin proveedor</option>
            {proveedores.map((p) => (
              <option key={p.ID_Proveedor} value={p.ID_Proveedor}>
                {p.Nombre_Empresa}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="flex items-center gap-1.5 text-sm font-semibold text-fg">
            <Mail className="size-3.5 text-fg-muted" />
            Correo destino
          </label>
          <input
            type="email"
            value={emailDestino}
            onChange={(e) => setEmailDestino(e.target.value)}
            disabled={!esEditable}
            placeholder={proveedorActual?.Email ?? "correo@proveedor.com"}
            className="mt-1 h-10 w-full rounded-xl border border-border bg-surface-2 px-3 text-sm text-fg placeholder:text-fg-subtle outline-none transition focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
          />
        </div>
      </div>

      {/* Notas */}
      <div className="mb-4">
        <label className="text-sm font-semibold text-fg">Notas del pedido</label>
        <textarea
          value={notas}
          onChange={(e) => setNotas(e.target.value)}
          disabled={!esEditable}
          placeholder="Observaciones, condiciones especiales..."
          className="mt-1 min-h-[72px] w-full resize-none rounded-xl border border-border bg-surface-2 px-3 py-2 text-sm text-fg placeholder:text-fg-subtle outline-none transition focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
        />
      </div>

      {/* Líneas */}
      <div className="mb-4">
        <div className="mb-2 flex items-center justify-between">
          <label className="text-sm font-semibold text-fg">Líneas del pedido</label>
          {esEditable && (
            <button
              type="button"
              onClick={addLinea}
              className="inline-flex cursor-pointer items-center gap-1 rounded-lg bg-accent px-2.5 py-1 text-xs font-semibold text-accent-fg shadow-sm transition hover:bg-accent-hover"
            >
              <Plus className="size-3.5" />
              Añadir línea
            </button>
          )}
        </div>

        {lineas.length === 0 ? (
          <div className="rounded-xl border border-border bg-surface-2 px-4 py-3 text-sm text-fg-muted">
            Sin líneas.{esEditable && " Añade productos al pedido."}
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-border">
            <div className="grid grid-cols-[1fr_80px_96px_72px_32px] gap-2 border-b border-border bg-surface-2 px-3 py-1.5 text-xs font-semibold text-fg-muted">
              <div>Producto</div>
              <div>Cantidad</div>
              <div>Precio unit.</div>
              <div>Unidad</div>
              <div />
            </div>

            {lineas.map((l, i) => (
              <div
                key={l.id}
                className={cn(
                  "grid grid-cols-[1fr_80px_96px_72px_32px] items-center gap-2 px-3 py-2",
                  i < lineas.length - 1 && "border-b border-border",
                )}
              >
                <input
                  type="text"
                  value={l.nombreProducto}
                  onChange={(e) => updateLinea(l.id, "nombreProducto", e.target.value)}
                  disabled={!esEditable}
                  placeholder="Nombre producto"
                  className="h-8 w-full rounded-lg border border-border bg-surface-2 px-2 text-sm text-fg placeholder:text-fg-subtle outline-none focus-visible:border-accent disabled:opacity-60"
                />
                <input
                  type="number"
                  value={l.cantidad}
                  onChange={(e) =>
                    updateLinea(l.id, "cantidad", Number(e.target.value) || 0)
                  }
                  disabled={!esEditable}
                  min={0}
                  className="h-8 w-full rounded-lg border border-border bg-surface-2 px-2 text-sm text-fg outline-none focus-visible:border-accent disabled:opacity-60"
                />
                <input
                  type="number"
                  value={l.precioUnitario ?? ""}
                  onChange={(e) =>
                    updateLinea(
                      l.id,
                      "precioUnitario",
                      e.target.value ? Number(e.target.value) : null,
                    )
                  }
                  disabled={!esEditable}
                  placeholder="—"
                  min={0}
                  step="0.01"
                  className="h-8 w-full rounded-lg border border-border bg-surface-2 px-2 text-sm text-fg placeholder:text-fg-subtle outline-none focus-visible:border-accent disabled:opacity-60"
                />
                <input
                  type="text"
                  value={l.unidad ?? ""}
                  onChange={(e) =>
                    updateLinea(l.id, "unidad", e.target.value || null)
                  }
                  disabled={!esEditable}
                  placeholder="ud"
                  className="h-8 w-full rounded-lg border border-border bg-surface-2 px-2 text-sm text-fg placeholder:text-fg-subtle outline-none focus-visible:border-accent disabled:opacity-60"
                />
                {esEditable ? (
                  <button
                    type="button"
                    onClick={() => removeLinea(l.id)}
                    className="grid size-7 cursor-pointer place-items-center rounded-lg text-danger/60 transition hover:bg-danger-soft hover:text-danger"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                ) : (
                  <div />
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Acciones */}
      <div className="mt-6 flex items-center justify-between gap-3">
        <div>
          {pedido.estado === "borrador" && (
            <button
              type="button"
              onClick={() => onCancelarPedido(pedido.id)}
              disabled={isBusy}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-sm font-semibold text-danger transition hover:opacity-90 disabled:opacity-50"
            >
              <XCircle className="size-4" />
              Cancelar pedido
            </button>
          )}
        </div>

        <div className="flex gap-3">
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded-xl border border-border bg-surface px-4 py-2 font-semibold text-fg transition hover:bg-surface-2"
          >
            Cerrar
          </button>

          {esEditable && (
            <>
              <button
                type="button"
                onClick={() => onSave(buildPedido())}
                disabled={isBusy}
                className="cursor-pointer rounded-xl border border-border bg-surface-2 px-4 py-2 font-semibold text-fg transition hover:bg-surface-2 disabled:opacity-50"
              >
                {isBusy ? "Guardando…" : "Guardar"}
              </button>

              <button
                type="button"
                onClick={() => onMandarPedido(buildPedido())}
                disabled={isBusy}
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl bg-accent px-4 py-2 font-semibold text-accent-fg shadow-sm transition hover:bg-accent-hover active:scale-[0.98] disabled:opacity-50"
              >
                <Send className="size-4" />
                {isBusy ? "Enviando…" : "Mandar pedido"}
              </button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
