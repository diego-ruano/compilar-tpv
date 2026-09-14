import { useEffect, useState } from "react";
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
  usePedidosPage,
  useCrearPedido,
  useActualizarPedido,
  useCancelarPedido,
  useEnviarPedido,
} from "./pedidosQueries";
import { conAviso } from "../../shared/lib/conAviso";

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

  // Búsqueda server-side con debounce (PROV-03): el texto viaja al backend, no filtra en
  // cliente (que solo vería la página cargada).
  const [busquedaDebounced, setBusquedaDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setBusquedaDebounced(busqueda.trim()), 300);
    return () => clearTimeout(t);
  }, [busqueda]);

  const query = usePedidosPage(busquedaDebounced);
  const crearMutation = useCrearPedido();
  const actualizarMutation = useActualizarPedido();
  const cancelarMutation = useCancelarPedido();
  const enviarMutation = useEnviarPedido();

  const pedidos = query.data?.pages.flatMap((p) => p.pedidos) ?? [];
  const total = query.data?.pages[0]?.total ?? 0;

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
    // Condiciones para enviar un pedido:
    //   · correo destino (es a donde va);
    //   · y ALGO que comunicar: al menos una línea, o unas notas.
    // El proveedor no es condición: solo sirve para autorrellenar el correo, y si falta se manda
    // igual con un nombre genérico.
    //
    // Antes esto era un único flag mal llamado `tieneEmail` (= email Y líneas) que, al no cumplirse,
    // SE SALTABA EL ENVÍO EN SILENCIO y marcaba el pedido como enviado igualmente: creabas un pedido
    // con correo y notas, te decía "Pedido enviado" y no salía ningún correo.
    const notas = (updated.notas ?? "").trim();
    const tieneContenido = updated.lineas.length > 0 || notas.length > 0;

    if (!updated.emailDestino) {
      toast.error("Falta el correo", "Indica el correo del proveedor para enviar el pedido.");
      return;
    }
    if (!tieneContenido) {
      toast.error(
        "El pedido está vacío",
        "Añade al menos una línea o escribe algo en las notas antes de enviarlo.",
      );
      return;
    }

    try {
      // Email primero: si falla aquí, la DB no se toca
      {
        await emailEnviarPedido({
          email_destino: updated.emailDestino!,
          nombre_proveedor: updated.nombreProveedor ?? "Proveedor",
          notas: updated.notas,
          lineas: updated.lineas.map((l) => ({
            nombre_producto: l.nombreProducto,
            cantidad: l.cantidad,
            precio_unitario: l.precioUnitario,
            unidad: l.unidad,
          })),
        });
      }

      // Solo llegamos aquí si el correo salió de verdad.
      if (isNewPedido) {
        await crearMutation.mutateAsync(toCrearInput(updated));
      } else {
        await actualizarMutation.mutateAsync(toActualizarInput(updated));
      }
      const fecha = new Date().toLocaleString("es-ES", { dateStyle: "short", timeStyle: "short" });
      await enviarMutation.mutateAsync({ idPedido: updated.id, estado: "enviado", fechaEnvio: fecha });

      toast.success("Pedido enviado", `Correo enviado a ${updated.emailDestino}`);

      cerrarModal();
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      // El worker solo envía a correos de proveedores dados de alta (FABLE-C). El código que
      // devuelve es estable pero no se le puede enseñar a un hostelero tal cual.
      if (msg.includes("email_destino_no_autorizado")) {
        toast.error(
          "Ese correo no está dado de alta",
          `Para enviar pedidos a ${updated.emailDestino} primero tienes que guardarlo como correo de un proveedor en la pestaña Proveedores.`,
        );
        return;
      }
      toast.error("Error", msg);
    }
  }

  const isBusy =
    crearMutation.isPending ||
    actualizarMutation.isPending ||
    cancelarMutation.isPending ||
    enviarMutation.isPending;

  return (
    <>
      <div className="flex w-full min-w-0 flex-col gap-3 rounded-2xl border border-border bg-surface p-3 shadow-sm sm:p-4">
        {/* Header igual al de proveedores */}
        <div className="flex flex-col items-stretch gap-3 xs:grid xs:grid-cols-[minmax(0,1fr)_auto] xs:items-center sm:flex sm:flex-row">
          <div className="flex min-w-0 items-center gap-3">
            <div className="grid size-11 shrink-0 place-items-center rounded-2xl bg-accent-soft text-accent">
              <ShoppingCart className="size-6" aria-hidden />
            </div>
            <div className="min-w-0">
              <h2 className="text-xl font-bold text-fg sm:text-2xl">Pedidos</h2>
              <p className="text-sm text-fg-muted">
                {total} {total === 1 ? "pedido" : "pedidos"}
              </p>
            </div>
          </div>

          <div className="order-3 flex min-w-0 justify-center xs:col-span-2 sm:order-none sm:col-span-1 sm:flex-1">
            <SearchInput
              value={busqueda}
              onValueChange={setBusqueda}
              placeholder="Buscar pedido..."
              className="w-full sm:max-w-xs"
            />
          </div>

          <button
            type="button"
            onClick={abrirNuevoPedido}
            className="inline-flex w-full min-w-0 cursor-pointer items-center justify-center gap-1.5 whitespace-normal break-words rounded-xl bg-accent px-3 py-2 text-center text-sm font-semibold leading-tight text-accent-fg shadow-sm transition hover:bg-accent-hover active:scale-[0.98] xs:w-auto xs:shrink-0"
          >
            <Plus className="size-4" aria-hidden />
            <span>Nuevo pedido</span>
          </button>
        </div>

        {/* Lista con scroll */}
        {query.isLoading ? (
          <div className="flex items-center justify-center py-6">
            <p className="text-sm text-fg-muted">Cargando pedidos…</p>
          </div>
        ) : pedidos.length === 0 ? (
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
          <div className="max-h-90 overflow-y-auto overscroll-contain rounded-xl border border-border [scrollbar-gutter:stable]">
            {pedidos.map((p, i) => (
              <button
                key={p.id}
                type="button"
                onClick={() => abrirPedido(p)}
                className={cn(
                  "grid w-full cursor-pointer grid-cols-[auto_1fr_auto] items-center gap-x-2 gap-y-1 px-3 py-2.5 text-left transition hover:bg-surface-2 sm:flex sm:gap-3",
                  i < pedidos.length - 1 && "border-b border-border",
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

                <span className="col-span-2 min-w-0 text-xs text-fg-muted sm:col-span-1 sm:shrink-0">{p.fechaCreacion}</span>

                <span className="min-w-0 text-right text-xs text-fg-muted sm:shrink-0 sm:text-left">
                  {p.lineas.length} {p.lineas.length === 1 ? "línea" : "líneas"}
                </span>

                <ChevronRight className="col-start-3 row-start-1 size-4 shrink-0 text-fg-subtle sm:col-auto sm:row-auto" aria-hidden />
              </button>
            ))}

            {query.hasNextPage && (
              <button
                type="button"
                onClick={() => void query.fetchNextPage()}
                disabled={query.isFetchingNextPage}
                className="flex w-full cursor-pointer items-center justify-center border-t border-border px-3 py-2.5 text-sm font-medium text-accent transition hover:bg-surface-2 disabled:cursor-default disabled:opacity-60"
              >
                {query.isFetchingNextPage ? "Cargando…" : "Cargar más"}
              </button>
            )}
          </div>
        )}
      </div>

      <PedidoModal
        open={modalOpen}
        onClose={cerrarModal}
        pedido={pedidoAbierto}
        proveedores={proveedores}
        onSave={conAviso(handleSave)}
        onCancelarPedido={conAviso(handleCancelar)}
        onMandarPedido={conAviso(handleMandar)}
        isBusy={isBusy}
      />
    </>
  );
}
