import { useMemo, useState } from "react";
import { ShoppingCart, Plus, ChevronRight } from "lucide-react";
import { SearchInput } from "../../shared/ui";
import { cn } from "../../shared/lib/cn";
import { useToast } from "../../shared/toast";
import PedidoModal from "./PedidoModal";
import type { PedidoEstado, PedidoRow, PedidoCrearInput, PedidoActualizarInput, LineaPedido } from "./pedidosApis";
import type { LineaPedidoInput } from "./pedidosApis";
import { emailEnviarPedido } from "../configuracion/api/emailConfigApis";
import type { ProveedorRow } from "./proveedoresApis";
import {
  usePedidosAll,
  useCrearPedido,
  useActualizarPedido,
  useCancelarPedido,
  useEnviarPedido,
} from "./pedidosQueries";

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

function buildPedidoVacio(): PedidoRow {
  return {
    id: crypto.randomUUID(),
    idProveedor: null,
    nombreProveedor: null,
    emailDestino: null,
    estado: "borrador",
    fechaCreacion: new Date().toLocaleString("es-ES", { dateStyle: "short", timeStyle: "short" }),
    fechaEnvio: null,
    notas: null,
    lineas: [],
  };
}

function toLineasInput(lineas: LineaPedido[]): LineaPedidoInput[] {
  return lineas.map((l) => ({
    idLinea: l.id || crypto.randomUUID(),
    nombreProducto: l.nombreProducto,
    cantidad: l.cantidad,
    precioUnitario: l.precioUnitario,
    unidad: l.unidad,
  }));
}

function toCrearInput(p: PedidoRow): PedidoCrearInput {
  return {
    idPedido: p.id,
    idProveedor: p.idProveedor,
    emailDestino: p.emailDestino,
    notas: p.notas,
    lineas: toLineasInput(p.lineas),
  };
}

function toActualizarInput(p: PedidoRow): PedidoActualizarInput {
  return {
    idPedido: p.id,
    idProveedor: p.idProveedor,
    emailDestino: p.emailDestino,
    notas: p.notas,
    lineas: toLineasInput(p.lineas),
  };
}

export default function PedidosSection({ proveedores }: Props) {
  const toast = useToast();
  const [busqueda, setBusqueda] = useState("");
  const [pedidoAbierto, setPedidoAbierto] = useState<PedidoRow | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [isNewPedido, setIsNewPedido] = useState(false);

  const query = usePedidosAll();
  const crearMutation = useCrearPedido();
  const actualizarMutation = useActualizarPedido();
  const cancelarMutation = useCancelarPedido();
  const enviarMutation = useEnviarPedido();

  const pedidos = query.data ?? [];

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
    const p = buildPedidoVacio();
    setPedidoAbierto(p);
    setIsNewPedido(true);
    setModalOpen(true);
  }

  function abrirPedido(p: PedidoRow) {
    setPedidoAbierto(p);
    setIsNewPedido(false);
    setModalOpen(true);
  }

  function cerrarModal() {
    setModalOpen(false);
    setIsNewPedido(false);
  }

  async function handleSave(updated: PedidoRow) {
    try {
      if (isNewPedido) {
        await crearMutation.mutateAsync(toCrearInput(updated));
      } else {
        await actualizarMutation.mutateAsync(toActualizarInput(updated));
      }
      cerrarModal();
    } catch (e: any) {
      toast.error("Error", String(e?.message ?? e));
    }
  }

  async function handleCancelar(id: string) {
    if (isNewPedido) {
      cerrarModal();
      return;
    }
    try {
      await cancelarMutation.mutateAsync(id);
      cerrarModal();
    } catch (e: any) {
      toast.error("Error", String(e?.message ?? e));
    }
  }

  async function handleMandar(updated: PedidoRow) {
    try {
      if (isNewPedido) {
        await crearMutation.mutateAsync(toCrearInput(updated));
      } else {
        await actualizarMutation.mutateAsync(toActualizarInput(updated));
      }
      const fecha = new Date().toLocaleString("es-ES", { dateStyle: "short", timeStyle: "short" });
      await enviarMutation.mutateAsync({ idPedido: updated.id, estado: "enviado", fechaEnvio: fecha });

      if (updated.emailDestino && updated.lineas.length > 0) {
        await emailEnviarPedido({
          email_destino: updated.emailDestino,
          nombre_proveedor: updated.nombreProveedor ?? "Proveedor",
          notas: updated.notas,
          lineas: updated.lineas.map((l) => ({
            nombre_producto: l.nombreProducto,
            cantidad: l.cantidad,
            precio_unitario: l.precioUnitario,
            unidad: l.unidad,
          })),
        });
        toast.success("Pedido enviado", `Correo enviado a ${updated.emailDestino}`);
      } else {
        toast.success("Pedido enviado", updated.emailDestino ? "Marcado como enviado" : "Sin correo destino — pedido marcado como enviado");
      }

      cerrarModal();
    } catch (e: any) {
      toast.error("Error", String(e?.message ?? e));
    }
  }

  const isBusy =
    crearMutation.isPending ||
    actualizarMutation.isPending ||
    cancelarMutation.isPending ||
    enviarMutation.isPending;

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

        {/* Lista con scroll */}
        {query.isLoading ? (
          <div className="flex items-center justify-center py-6">
            <p className="text-sm text-fg-muted">Cargando pedidos…</p>
          </div>
        ) : pedidosFiltrados.length === 0 ? (
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
          <div className="max-h-90 overflow-y-auto rounded-xl border border-border">
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
        onClose={cerrarModal}
        pedido={pedidoAbierto}
        proveedores={proveedores}
        onSave={handleSave}
        onCancelarPedido={handleCancelar}
        onMandarPedido={handleMandar}
        isBusy={isBusy}
      />
    </>
  );
}
