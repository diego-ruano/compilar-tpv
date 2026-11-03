import { useEffect, useState } from "react";
import { ShoppingCart, Plus, ChevronRight } from "lucide-react";
import { SearchInput } from "../../shared/ui";
import { cn } from "../../shared/lib/cn";
import { useToast } from "../../shared/toast";
import PedidoModal from "./PedidoModal";
import type {
  LineaPedidoDto,
  LineaPedidoInput,
  PedidoProveedorDto,
  PedidosActualizarInput,
  PedidosCrearInput,
  ProveedorDto,
} from "@tpv/contracts";
import { estadoDelPedido, type PedidoEstado } from "./pedidosApis";
import { configGetBusinessSettings, configGetContactSettings } from "../configuracion/api/configApis";
import { emailEnviarPedido } from "../configuracion/api/emailConfigApis";
import {
  usePedidosPage,
  useCrearPedido,
  useActualizarPedido,
  useCancelarPedido,
  useEnviarPedido,
} from "./pedidosQueries";
import { conAviso } from "../../shared/lib/conAviso";
import { toAppError } from "@tpv/client";

type Props = {
  proveedores: ProveedorDto[];
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

function buildPedidoVacio(): PedidoProveedorDto {
  return {
    id_pedido: crypto.randomUUID(),
    id_proveedor: null,
    nombre_proveedor: null,
    email_destino: null,
    estado: "borrador",
    fecha_creacion: new Date().toLocaleString("es-ES", { dateStyle: "short", timeStyle: "short" }),
    fecha_envio: null,
    notas: null,
    lineas: [],
  };
}

function toLineasInput(lineas: LineaPedidoDto[]): LineaPedidoInput[] {
  return lineas.map((l) => ({
    id_linea: l.id_linea || crypto.randomUUID(),
    nombre_producto: l.nombre_producto,
    cantidad: l.cantidad,
    precio_unitario: l.precio_unitario ?? undefined,
    unidad: l.unidad ?? undefined,
  }));
}

/** Crear y actualizar llevan la misma forma. */
function toInput(p: PedidoProveedorDto): PedidosCrearInput & PedidosActualizarInput {
  return {
    id_pedido: p.id_pedido,
    id_proveedor: p.id_proveedor ?? undefined,
    email_destino: p.email_destino ?? undefined,
    notas: p.notas ?? undefined,
    lineas: toLineasInput(p.lineas),
  };
}

export default function PedidosSection({ proveedores }: Props) {
  const toast = useToast();
  const [busqueda, setBusqueda] = useState("");
  const [pedidoAbierto, setPedidoAbierto] = useState<PedidoProveedorDto | null>(null);
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

  function abrirPedido(p: PedidoProveedorDto) {
    setPedidoAbierto(p);
    setIsNewPedido(false);
    setModalOpen(true);
  }

  function cerrarModal() {
    setModalOpen(false);
    setIsNewPedido(false);
  }

  async function handleSave(updated: PedidoProveedorDto) {
    try {
      if (isNewPedido) {
        await crearMutation.mutateAsync(toInput(updated));
      } else {
        await actualizarMutation.mutateAsync(toInput(updated));
      }
      cerrarModal();
    } catch (e) {
      toast.error("No se pudo guardar el pedido", toAppError(e).message);
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
    } catch (e) {
      toast.error("No se pudo cancelar el pedido", toAppError(e).message);
    }
  }

  async function handleMandar(updated: PedidoProveedorDto) {
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

    if (!updated.email_destino) {
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
      // RI-60: aviso previo; el Worker también valida su copia del contacto comercial.
      const [negocio, contacto] = await Promise.all([configGetBusinessSettings(), configGetContactSettings()]);
      if (!negocio.business_name.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contacto.contact_email.trim())) {
        toast.error("Faltan datos del negocio", "Completa el nombre y un correo de contacto válido en Configuración → Negocio antes de enviar pedidos.");
        return;
      }
      {
        await emailEnviarPedido({
          email_destino: updated.email_destino!,
          nombre_proveedor: updated.nombre_proveedor ?? "Proveedor",
          notas: updated.notas ?? undefined,
          lineas: updated.lineas.map((l) => ({
            nombre_producto: l.nombre_producto,
            cantidad: l.cantidad,
            precio_unitario: l.precio_unitario ?? undefined,
            unidad: l.unidad ?? undefined,
          })),
        });
      }

      // Solo llegamos aquí si el correo salió de verdad.
      if (isNewPedido) {
        await crearMutation.mutateAsync(toInput(updated));
      } else {
        await actualizarMutation.mutateAsync(toInput(updated));
      }
      const fecha = new Date().toLocaleString("es-ES", { dateStyle: "short", timeStyle: "short" });
      await enviarMutation.mutateAsync({ id_pedido: updated.id_pedido, estado: "enviado", fecha_envio: fecha });

      toast.success("Pedido enviado", `Correo enviado a ${updated.email_destino}`);

      cerrarModal();
    } catch (e) {
      // RI-52: el message ya viene escrito para la persona. Un correo que no es de ningún
      // proveedor (FABLE-C) lo completa el worker con su frase de `MENSAJES`; antes se buscaba su
      // identificador dentro del texto.
      toast.error("No se pudo enviar el pedido", toAppError(e).message);
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
                key={p.id_pedido}
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
                    ESTADO_CLASS[estadoDelPedido(p)],
                  )}
                >
                  {ESTADO_LABEL[estadoDelPedido(p)]}
                </span>

                <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
                  {p.nombre_proveedor ?? (
                    <span className="italic text-fg-muted">Sin proveedor</span>
                  )}
                </span>

                <span className="col-span-2 min-w-0 text-xs text-fg-muted sm:col-span-1 sm:shrink-0">{p.fecha_creacion}</span>

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
