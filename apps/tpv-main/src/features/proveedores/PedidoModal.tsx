import { useEffect, useState } from "react";
import { Trash2, Plus, Send, XCircle, Mail } from "lucide-react";
import Modal from "./Modal";
import { cn } from "../../shared/lib/cn";
import type { Dinero, LineaPedidoDto, PedidoProveedorDto, ProveedorDto } from "@tpv/contracts";
import { estadoDelPedido, type PedidoEstado } from "./pedidosApis";
import { CampoDinero } from "../../shared/ui/CampoDinero";

type Props = {
  open: boolean;
  onClose: () => void;
  pedido: PedidoProveedorDto | null;
  proveedores: ProveedorDto[];
  onSave: (pedido: PedidoProveedorDto) => void;
  onCancelarPedido: (pedidoId: string) => void;
  onMandarPedido: (pedido: PedidoProveedorDto) => void;
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
  const [lineas, setLineas] = useState<LineaPedidoDto[]>([]);
  // Líneas cuyo precio escrito no se entiende como importe: mientras haya alguna no se guarda ni
  // se manda, porque el precio llegaría vacío sin que nadie lo viera.
  const [preciosIlegibles, setPreciosIlegibles] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (!pedido) return;
    setIdProveedor(pedido.id_proveedor ?? "");
    setEmailDestino(pedido.email_destino ?? "");
    setNotas(pedido.notas ?? "");
    setLineas(pedido.lineas ?? []);
    setPreciosIlegibles(new Set());
  }, [pedido]);

  if (!pedido) return null;

  const estado = estadoDelPedido(pedido);
  const esEditable = estado === "borrador";
  const puedeGuardar = preciosIlegibles.size === 0;
  const proveedorActual = proveedores.find((p) => p.id_proveedor === idProveedor);

  function handleProveedorChange(newId: string) {
    setIdProveedor(newId);
    const prov = proveedores.find((p) => p.id_proveedor === newId);
    if (prov?.email) setEmailDestino(prov.email);
    else if (!newId) setEmailDestino("");
  }

  function addLinea() {
    setLineas((prev) => [
      ...prev,
      { id_linea: crypto.randomUUID(), nombre_producto: "", cantidad: 1, precio_unitario: null, unidad: null },
    ]);
  }

  function updateLinea<K extends keyof LineaPedidoDto>(id: string, field: K, value: LineaPedidoDto[K]) {
    setLineas((prev) => prev.map((l) => (l.id_linea === id ? { ...l, [field]: value } : l)));
  }

  function cambiarPrecio(id: string, valor: Dinero | null, legible: boolean) {
    updateLinea(id, "precio_unitario", valor);
    setPreciosIlegibles((prev) => {
      const next = new Set(prev);
      if (legible) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function removeLinea(id: string) {
    setLineas((prev) => prev.filter((l) => l.id_linea !== id));
    setPreciosIlegibles((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  function buildPedido(): PedidoProveedorDto {
    const prov = proveedores.find((p) => p.id_proveedor === idProveedor);
    return {
      ...pedido!,
      id_proveedor: idProveedor || null,
      nombre_proveedor: prov?.nombre_empresa ?? null,
      email_destino: emailDestino || null,
      notas: notas || null,
      lineas,
    };
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Pedido · ${pedido.fecha_creacion}`}
      zIndex={70}
      widthClass="max-w-[860px]"
    >
      {/* Estado */}
      <div className="mb-4 flex flex-wrap items-center gap-2 sm:gap-3">
        <span
          className={cn(
            "inline-flex items-center rounded-lg px-3 py-1 text-sm font-semibold",
            ESTADO_CLASS[estado],
          )}
        >
          {ESTADO_LABEL[estado]}
        </span>
        {estado === "enviado" && pedido.fecha_envio && (
          <span className="text-sm text-fg-muted">Enviado el {pedido.fecha_envio}</span>
        )}
      </div>

      {/* Proveedor + Email */}
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4">
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
              <option key={p.id_proveedor} value={p.id_proveedor}>
                {p.nombre_empresa}
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
            placeholder={proveedorActual?.email ?? "correo@proveedor.com"}
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
        <div className="mb-2 flex flex-col items-stretch gap-2 xs:flex-row xs:items-center xs:justify-between">
          <label className="text-sm font-semibold text-fg">Líneas del pedido</label>
          {esEditable && (
            <button
              type="button"
              onClick={addLinea}
              className="inline-flex w-full min-w-0 cursor-pointer items-center justify-center gap-1 whitespace-normal break-words rounded-lg bg-accent px-2.5 py-1.5 text-center text-xs font-semibold leading-tight text-accent-fg shadow-sm transition hover:bg-accent-hover xs:w-auto"
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
          <div className="touch-pan-x overflow-x-auto overscroll-x-contain rounded-xl border border-border pb-1 [scrollbar-gutter:stable]">
            <div className="grid min-w-[620px] grid-cols-[1fr_80px_96px_72px_32px] gap-2 border-b border-border bg-surface-2 px-3 py-1.5 text-xs font-semibold text-fg-muted">
              <div>Producto</div>
              <div>Cantidad</div>
              <div>Precio unit.</div>
              <div>Unidad</div>
              <div />
            </div>

            {lineas.map((l, i) => (
              <div
                key={l.id_linea}
                className={cn(
                  "grid min-w-[620px] grid-cols-[1fr_80px_96px_72px_32px] items-center gap-2 px-3 py-2",
                  i < lineas.length - 1 && "border-b border-border",
                )}
              >
                <input
                  type="text"
                  value={l.nombre_producto}
                  onChange={(e) => updateLinea(l.id_linea, "nombre_producto", e.target.value)}
                  disabled={!esEditable}
                  placeholder="Nombre producto"
                  className="h-8 w-full rounded-lg border border-border bg-surface-2 px-2 text-sm text-fg placeholder:text-fg-subtle outline-none focus-visible:border-accent disabled:opacity-60"
                />
                <input
                  type="number"
                  value={l.cantidad ?? ""}
                  onChange={(e) =>
                    updateLinea(l.id_linea, "cantidad", Number(e.target.value) || 0)
                  }
                  disabled={!esEditable}
                  min={0}
                  className="h-8 w-full rounded-lg border border-border bg-surface-2 px-2 text-sm text-fg outline-none focus-visible:border-accent disabled:opacity-60"
                />
                <CampoDinero
                  valor={l.precio_unitario}
                  onCambio={(v, legible) => cambiarPrecio(l.id_linea, v, legible)}
                  disabled={!esEditable}
                  placeholder="—"
                  aria-label="Precio unitario"
                  className="h-8 w-full rounded-lg border border-border bg-surface-2 px-2 text-sm text-fg placeholder:text-fg-subtle outline-none focus-visible:border-accent disabled:opacity-60"
                />
                <input
                  type="text"
                  value={l.unidad ?? ""}
                  onChange={(e) =>
                    updateLinea(l.id_linea, "unidad", e.target.value || null)
                  }
                  disabled={!esEditable}
                  placeholder="ud"
                  className="h-8 w-full rounded-lg border border-border bg-surface-2 px-2 text-sm text-fg placeholder:text-fg-subtle outline-none focus-visible:border-accent disabled:opacity-60"
                />
                {esEditable ? (
                  <button
                    type="button"
                    onClick={() => removeLinea(l.id_linea)}
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
      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="w-full sm:w-auto">
          {estado === "borrador" && (
            <button
              type="button"
              onClick={() => onCancelarPedido(pedido.id_pedido)}
              disabled={isBusy}
              className="inline-flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-sm font-semibold text-danger transition hover:opacity-90 disabled:opacity-50 sm:w-auto"
            >
              <XCircle className="size-4" />
              Cancelar pedido
            </button>
          )}
        </div>

        <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:gap-3">
          <button
            type="button"
            onClick={onClose}
            className="min-w-0 cursor-pointer whitespace-normal break-words rounded-xl border border-border bg-surface px-3 py-2 text-center font-semibold leading-tight text-fg transition hover:bg-surface-2 sm:px-4"
          >
            Cerrar
          </button>

          {esEditable && (
            <>
              <button
                type="button"
                onClick={() => onSave(buildPedido())}
                disabled={isBusy || !puedeGuardar}
                className="min-w-0 cursor-pointer whitespace-normal break-words rounded-xl border border-border bg-surface-2 px-3 py-2 text-center font-semibold leading-tight text-fg transition hover:bg-surface-2 disabled:opacity-50 sm:px-4"
              >
                {isBusy ? "Guardando…" : "Guardar"}
              </button>

              <button
                type="button"
                onClick={() => onMandarPedido(buildPedido())}
                disabled={isBusy || !puedeGuardar}
                className="col-span-2 inline-flex min-w-0 cursor-pointer items-center justify-center gap-1.5 whitespace-normal break-words rounded-xl bg-accent px-3 py-2 text-center font-semibold leading-tight text-accent-fg shadow-sm transition hover:bg-accent-hover active:scale-[0.98] disabled:opacity-50 sm:col-span-1 sm:px-4"
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
