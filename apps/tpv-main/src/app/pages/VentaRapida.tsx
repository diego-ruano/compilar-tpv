import { commands } from "@tpv/client";
import { ArrowLeft, Plus, ReceiptText } from "lucide-react";
import ProductDetailModal from "../../features/inventario/ProductDetailModal";
import AddProductModal from "../../features/ventaRapida/ui/AddProductModal";
import CashPanel from "../../features/ventaRapida/ui/CashPanel";
import CatalogGrid from "../../features/ventaRapida/ui/CatalogGrid";
import CobrosPendientesModal from "../../features/ventaRapida/ui/CobrosPendientesModal";
import TicketPanel from "../../features/ventaRapida/ui/TicketPanel";
import VerTicketsModal from "../../features/ventaRapida/ui/VerTicketsModal";
import { useVentaRapida } from "../../features/ventaRapida/useVentaRapida";
import { cn } from "../../features/ventaRapida/utils";
import { conAviso } from "../../shared/lib/conAviso";
import { CERO } from "../../shared/lib/dinero";
import {
DENOMS_COBRO
} from "../../shared/lib/efectivo";
import DatosFiscalesModal from "../../shared/ticket/DatosFiscalesModal";
import { SearchInput } from "../../shared/ui";

export default function VentaRapida() {
  const {
    nuevoTicket, abrirVerTickets, loadingComandas, escriturasPendientes, cobrando, recuperacion,
    setOpenPendientes, leftTitle, leftSubtitle, categoriaSeleccionada, paso, setCategoriaSeleccionada,
    query, setQuery, cashCount, totalACobrar, totalEfectivo, diferencia,
    addCash, removeCash, resetCash, cobrar, setPaso, setCashCount,
    variant, categorias, productos, busqueda, loadingBusqueda, loadingProductos,
    getQtyZero, getQty, onSelectCategoriaCb, onAddProductoCb, onRemoveProductoCb, onOpenProductDetailCb,
    puede, onOpenAddProductCb, ultimoCobro, ticketForPanel, totalPendiente, totalSeleccionado,
    haySeleccion, seleccionaTodoPendiente, toggleSeleccion, eliminarLineaTicket, limpiarSeleccion, setQuiereFactura,
    quiereFactura, onGuardarNota, openAddProduct, setOpenAddProduct, onProductoGuardado, openProductDetail,
    cerrarDetalleProducto, productDetailId, pideFactura, cancelarFactura, confirmarFactura, limite_simplif,
    errorFactura, openPendientes, setErrorFactura, setPideFactura, resolverPendiente, openVerTickets,
    setOpenVerTickets, comandasBarra, abrirTicketDesdeModal, eliminarTicketDesdeModal, cobrarTicketDesdeModal,
  } = useVentaRapida();
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-bg text-fg">
      <div className="flex shrink-0 flex-col gap-3 border-b border-border bg-surface py-3 pl-16 pr-3 sm:flex-row sm:items-center sm:justify-between sm:pl-16 sm:pr-4 lg:px-4">
        <div className="min-w-0">
          <h1 className="truncate text-lg font-extrabold text-fg sm:text-xl">Venta rápida</h1>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center">
          <button
            type="button"
            onClick={conAviso(nuevoTicket)}
            className="inline-flex min-w-0 items-center justify-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 text-sm font-semibold text-fg transition hover:bg-surface-2 active:scale-[0.98] cursor-pointer"
          >
            <Plus className="size-4" aria-hidden />
            Nuevo ticket
          </button>

          <button
            type="button"
            onClick={conAviso(abrirVerTickets)}
            className={cn(
              "inline-flex min-w-0 items-center justify-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 text-sm font-semibold text-fg transition hover:bg-surface-2 active:scale-[0.98] cursor-pointer",
              loadingComandas && "opacity-60",
            )}
          >
            <ReceiptText className="size-4" aria-hidden />
            Ver tickets
          </button>
        </div>
      </div>

      {escriturasPendientes > 0 || cobrando ? <p role="status" className="px-4 text-sm text-fg-muted">{cobrando ? "Confirmando cobro…" : "Guardando ticket…"}</p> : null}
      {recuperacion.main && (recuperacion.pendientes.length > 0 || recuperacion.error) ? <button onClick={() => setOpenPendientes(true)} className="px-4 py-2 text-left text-sm text-danger">Cobros pendientes ({recuperacion.pendientes.length}){recuperacion.error ? ` · ${recuperacion.error}` : ""}</button> : null}
      <div className="grid min-h-0 flex-1 touch-pan-y auto-rows-max grid-cols-1 content-start gap-3 overflow-y-scroll overscroll-contain p-3 [scrollbar-gutter:stable] lg:auto-rows-auto lg:content-stretch lg:grid-cols-[minmax(0,1fr)_minmax(360px,38vw)] lg:overflow-hidden xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="flex h-[clamp(20rem,58dvh,44rem)] min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-surface md:h-[clamp(24rem,62dvh,44rem)] lg:h-auto">
          <div className="border-b border-border bg-surface p-3">
            <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-center">
              <div className="min-w-0">
                <h2 className="truncate text-base font-bold text-fg sm:text-lg">{leftTitle}</h2>
                <p className="text-xs text-fg-muted sm:text-sm">{leftSubtitle}</p>
              </div>

              <div className="flex min-w-0 flex-col gap-2 xs:flex-row xs:items-center">
                {categoriaSeleccionada && paso !== "efectivo" && (
                  <button
                    type="button"
                    onClick={() => setCategoriaSeleccionada(null)}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-border bg-surface px-3 py-2 text-sm font-semibold text-fg transition hover:bg-surface-2 cursor-pointer"
                  >
                    <ArrowLeft className="size-4" aria-hidden />
                    Categorías
                  </button>
                )}

                <SearchInput
                  value={query}
                  onValueChange={setQuery}
                  placeholder="Buscar producto..."
                  className="w-full xs:w-48 sm:w-64"
                />
              </div>
            </div>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto p-3">
            {paso === "efectivo" ? (
              <CashPanel
                ocupado={cobrando}
                denoms={DENOMS_COBRO}
                cashCount={cashCount}
                totalACobrar={totalACobrar}
                totalEfectivo={totalEfectivo}
                diferencia={diferencia}
                onAddCash={addCash}
                onRemoveCash={removeCash}
                onReset={resetCash}
                onConfirm={() => void cobrar("efectivo")}
                onCancel={() => {
                  setPaso("metodo");
                  setCashCount({});
                }}
              />
            ) : (
              <CatalogGrid
                variant={variant}
                categorias={categorias}
                productos={productos}
                busqueda={busqueda}
                loading={variant === "search" ? loadingBusqueda : loadingProductos}
                getQty={variant === "categories" ? getQtyZero : getQty}
                onSelectCategoria={onSelectCategoriaCb}
                onAddProducto={onAddProductoCb}
                onRemoveProducto={onRemoveProductoCb}
                onOpenProductDetail={onOpenProductDetailCb}
                onOpenAddProduct={puede("catalogo.editar") && puede("catalogo.precios") ? onOpenAddProductCb : undefined}
              />
            )}
          </div>
        </div>

        <div className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-surface">
          <TicketPanel
            ocupado={cobrando || escriturasPendientes > 0}
            ultimoCobro={ultimoCobro}
            ticket={ticketForPanel}
            paso={paso}
            totalPendiente={totalPendiente}
            totalSeleccionado={totalSeleccionado}
            haySeleccion={haySeleccion}
            onCobrarTodo={() => {
              seleccionaTodoPendiente();
              setPaso("metodo");
            }}
            onCobrarFraccionado={() => {
              setPaso("metodo");
            }}
            onToggleSeleccion={(id) => toggleSeleccion(id)}
            onEliminarLinea={(id) => void eliminarLineaTicket(id)}
            onCobrarTarjeta={async () => {
              await cobrar("tarjeta");
            }}
            onStartEfectivo={() => {
              setPaso("efectivo");
              setCashCount({});
            }}
            onCancelarCobro={() => {
              setPaso("categorias");
              limpiarSeleccion();
              setQuiereFactura(false);
            }}
            quiereFactura={quiereFactura}
            onQuiereFacturaChange={setQuiereFactura}
            onGuardarNota={onGuardarNota}
          />
        </div>
      </div>

      <AddProductModal
        open={openAddProduct}
        onClose={() => setOpenAddProduct(false)}
        categoriaPreseleccionadaId={
          categoriaSeleccionada ? categoriaSeleccionada.ID_Categoria : null
        }
        onSaved={conAviso(async () => {
          await onProductoGuardado();
        })}
      />

      <ProductDetailModal
        open={openProductDetail}
        onClose={cerrarDetalleProducto}
        productId={productDetailId}
      />

      <DatosFiscalesModal
        open={pideFactura !== null}
        onClose={cancelarFactura}
        onConfirmar={confirmarFactura}
        importe={pideFactura?.importe ?? CERO}
        limite={limite_simplif}
        obligatorio={pideFactura?.clase === "obligatorio"}
        error={errorFactura}
        guardando={cobrando}
        inicial={pideFactura?.clase === "obligatorio" ? recuperacion.pendientes.find(p => p.cobro.id_pago === pideFactura.idPago)?.cobro.destinatario : null}
      />

      <CobrosPendientesModal open={openPendientes} onClose={() => setOpenPendientes(false)} pendientes={recuperacion.pendientes} ocupado={cobrando}
        onEditarFactura={p => { setOpenPendientes(false); setErrorFactura(null); setPideFactura({ clase: "obligatorio", idPago: p.cobro.id_pago, importe: p.cobro.importe_total }); }}
        onResolver={resolverPendiente} onCancelar={async p => { await commands.vrCancelarCobroPendiente(p.cobro.id_pago); await recuperacion.recargar(); }} />
      <VerTicketsModal
        open={openVerTickets}
        onClose={() => {
          setOpenVerTickets(false);
        }}
        comandas={comandasBarra}
        onOpenTicket={(id) => void abrirTicketDesdeModal(id)}
        onDeleteTicket={(id) => void eliminarTicketDesdeModal(id)}
        onCobrarTicket={(id) => void cobrarTicketDesdeModal(id)}
      />
    </div>
  );
}
