import { useMemo, useState } from "react";
import { ShoppingCart, Plus, ChevronRight } from "lucide-react";
import { SearchInput } from "../../shared/ui";
import { cn } from "../../shared/lib/cn";
import { useToast } from "../../shared/toast";
import PedidoModal from "./PedidoModal";
import type { PedidoEstado, PedidoRow } from "./pedidosApis";
import type { ProveedorRow } from "./proveedoresApis";

type Props = {
  proveedores: ProveedorRow[];
};

const ESTADO_LABEL: Record<PedidoEstado, string> = {
  borrador: "Borrador",
  enviado: "Enviado",
  cancelado: "Cancelado",
};

const ESTADO_CLASS: Record<PedidoEstado, string> = {
  borrador: "bg-surface-2 text-fg-muted",
  enviado: "bg-accent-soft text-accent",
  cancelado: "bg-danger-soft text-danger",
};

function nuevoPedido(): PedidoRow {
  return {
    id: crypto.randomUUID(),
    idProveedor: null,
    nombreProveedor: null,
    emailDestino: null,
    estado: "borrador",
    fechaCreacion: new Date().toLocaleDateString("es-ES"),
    fechaEnvio: null,
    notas: null,
    lineas: [],
  };
}

export default function PedidosSection({ proveedores }: Props) {
  const toast = useToast();
  const [pedidos, setPedidos] = useState<PedidoRow[]>([]);
  const [busqueda, setBusqueda] = useState("");
  const [pedidoAbierto, setPedidoAbierto] = useState<PedidoRow | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  const pedidosFiltrados = useMemo(() => {
    const s = busqueda.trim().toLowerCase();
    if (!s) return pedidos;
    return pedidos.filter(
      (p) =>
        (p.nombreProveedor ?? "").toLowerCase().includes(s) ||
        (p.emailDestino ?? "").toLowerCase().includes(s) ||
        (p.notas ?? "").toLowerCase().includes(s) ||
        ESTADO_LABEL[p.estado].toLowerCase().includes(s),
    );
  }, [pedidos, busqueda]);

  function abrirNuevoPedido() {
    const p = nuevoPedido();
    setPedidos((prev) => [p, ...prev]);
    setPedidoAbierto(p);
    setModalOpen(true);
  }

  function abrirPedido(p: PedidoRow) {
    setPedidoAbierto(p);
    setModalOpen(true);
  }

  function handleSave(updated: PedidoRow) {
    setPedidos((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
    setModalOpen(false);
  }

  function handleCancelar(id: string) {
    setPedidos((prev) =>
      prev.map((p) => (p.id === id ? { ...p, estado: "cancelado" } : p)),
    );
    setModalOpen(false);
  }

  function handleMandar(updated: PedidoRow) {
    const enviado: PedidoRow = {
      ...updated,
      estado: "enviado",
      fechaEnvio: new Date().toLocaleDateString("es-ES"),
    };
    setPedidos((prev) => prev.map((p) => (p.id === enviado.id ? enviado : p)));
    setModalOpen(false);
    const dest = enviado.emailDestino;
    toast.success("Pedido enviado", dest ? `Enviado a ${dest}` : "Sin correo destino configurado");
  }

  return (
    <>
      <div className="flex w-full flex-col gap-3 rounded-2xl border border-border bg-surface p-4 shadow-sm">
        {/* Header igual al de proveedores */}
        <div className="flex items-center gap-3">
          <div className="flex min-w-0 shrink-0 items-center gap-3">
            <div className="grid size-11 shrink-0 place-items-center rounded-2xl bg-accent-soft text-accent">
              <ShoppingCart className="size-6" aria-hidden />
            </div>
            <div className="min-w-0">
              <h2 className="text-xl font-bold text-fg sm:text-2xl">Pedidos</h2>
              <p className="text-sm text-fg-muted">
                {pedidosFiltrados.length}{" "}
                {pedidosFiltrados.length === 1 ? "pedido" : "pedidos"}
              </p>
            </div>
          </div>

          <div className="flex flex-1 justify-center">
            <SearchInput
              value={busqueda}
              onValueChange={setBusqueda}
              placeholder="Buscar pedido..."
              className="w-full max-w-xs"
            />
          </div>

          <button
            type="button"
            onClick={abrirNuevoPedido}
            className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-xl bg-accent px-3 py-2 text-sm font-semibold text-accent-fg shadow-sm transition hover:bg-accent-hover active:scale-[0.98]"
          >
            <Plus className="size-4" aria-hidden />
            <span className="hidden xs:inline">Nuevo pedido</span>
          </button>
        </div>

        {/* Lista */}
        {pedidosFiltrados.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-border bg-surface-2 py-8 text-center">
            <ShoppingCart className="size-7 text-fg-subtle" aria-hidden />
            <p className="text-sm font-medium text-fg">Sin pedidos</p>
            <p className="text-xs text-fg-muted">
              {busqueda
                ? "No hay pedidos con ese filtro."
                : "Crea un pedido con el botón de arriba."}
            </p>
          </div>
        ) : (
          <div className="flex flex-col overflow-hidden rounded-xl border border-border">
            {pedidosFiltrados.map((p, i) => (
              <button
                key={p.id}
                type="button"
                onClick={() => abrirPedido(p)}
                className={cn(
                  "flex w-full cursor-pointer items-center gap-3 px-3 py-2.5 text-left transition hover:bg-surface-2",
                  i < pedidosFiltrados.length - 1 && "border-b border-border",
                )}
              >
                <span
                  className={cn(
                    "inline-flex shrink-0 items-center rounded-md px-2 py-0.5 text-xs font-semibold",
                    ESTADO_CLASS[p.estado],
                  )}
                >
                  {ESTADO_LABEL[p.estado]}
                </span>

                <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
                  {p.nombreProveedor ?? (
                    <span className="italic text-fg-muted">Sin proveedor</span>
                  )}
                </span>

                <span className="shrink-0 text-xs text-fg-muted">{p.fechaCreacion}</span>

                <span className="shrink-0 text-xs text-fg-muted">
                  {p.lineas.length} {p.lineas.length === 1 ? "línea" : "líneas"}
                </span>

                <ChevronRight className="size-4 shrink-0 text-fg-subtle" aria-hidden />
              </button>
            ))}
          </div>
        )}
      </div>

      <PedidoModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        pedido={pedidoAbierto}
        proveedores={proveedores}
        onSave={handleSave}
        onCancelarPedido={handleCancelar}
        onMandarPedido={handleMandar}
      />
    </>
  );
}
