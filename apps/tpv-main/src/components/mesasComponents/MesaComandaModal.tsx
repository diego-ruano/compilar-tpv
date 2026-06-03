// components/mesasComponents/MesaComandaModal.tsx
import React, { useEffect, useMemo, useState } from "react";
import { appDataDir, join } from "@tauri-apps/api/path";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useAuth } from "../../shared/stores/useAuth";
import type { MesaMeta } from "./types";

import ProductDetailModal from "../InventaryComponents/ProductDetailModal";

import {
    mesasEnsureOpenComanda,
    mesasLoadTicket,
    mesasAddDetalle,
    mesasRemoveOnePendingDetalle,
    mesasDeleteDetalle,
    mesasUpdateDetalleNota,
    mesasCobrarDetalles,
    productosListCategoriasVendibles,
    productosListByCategoria,
    productosSearchByNombre,
    reservaMarcarActivaAhora,
    reservaFinalizar,
    type CategoriaDTO,
    type ProductoDTO,
} from "./mesasApi";

/* =========================
   Tipos
========================= */
type Categoria = CategoriaDTO;
type CategoriaDisplay = Categoria & { urlImagen: string };

type Producto = ProductoDTO;
type ProductoDisplay = Producto & { urlImagen: string };

type TicketItem = {
    id: number; // ID_Detalle
    productoId: number;
    nombre: string;
    precio: number;
    pagado: boolean;
    seleccionado: boolean;
    estadoCocina: "PENDIENTE" | "PREPARADO" | string;
    pasaCocina: boolean;
    notas: string | null;
};

type Paso = "categorias" | "productos" | "metodo" | "efectivo";

function cn(...classes: Array<string | false | undefined | null>) {
    return classes.filter(Boolean).join(" ");
}

function pick(obj: any, keys: string[]) {
    for (const k of keys) {
        if (obj && obj[k] != null) return obj[k];
    }
    return undefined;
}

function eur(n: number) {
    return new Intl.NumberFormat("es-ES", {
        style: "currency",
        currency: "EUR",
    }).format(n);
}

const DENOMS = [
    { label: "200€", value: 200 },
    { label: "100€", value: 100 },
    { label: "50€", value: 50 },
    { label: "20€", value: 20 },
    { label: "10€", value: 10 },
    { label: "5€", value: 5 },
    { label: "2€", value: 2 },
    { label: "1€", value: 1 },
    { label: "0,50€", value: 0.5 },
    { label: "0,20€", value: 0.2 },
    { label: "0,10€", value: 0.1 },
    { label: "0,05€", value: 0.05 },
];

function Modal({
    open,
    title,
    children,
    onClose,
}: {
    open: boolean;
    title: string;
    children: React.ReactNode;
    onClose: () => void;
}) {
    if (!open) return null;
    return (
        <div className="fixed inset-0 z-[9999] bg-black/40 p-4 grid place-items-center">
            <div className="w-full max-w-[1200px] h-[86vh] rounded-2xl border border-slate-200 bg-white shadow-xl overflow-hidden flex flex-col">
                <div className="flex items-center justify-between gap-3 p-4 border-b border-slate-100">
                    <div className="text-lg font-extrabold text-slate-900">
                        {title}
                    </div>
                    <button
                        onClick={onClose}
                        className="h-10 w-10 rounded-xl border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                    >
                        ✕
                    </button>
                </div>

                <div className="p-4 flex-1 min-h-0">{children}</div>
            </div>
        </div>
    );
}

/* =========================
   Modal para nota por línea
========================= */
function NotaLineaModal({
    open,
    productoNombre,
    initialValue,
    onCancel,
    onSave,
}: {
    open: boolean;
    productoNombre: string;
    initialValue: string;
    onCancel: () => void;
    onSave: (nota: string) => void | Promise<void>;
}) {
    const [value, setValue] = useState(initialValue);

    useEffect(() => {
        if (open) setValue(initialValue);
    }, [open, initialValue]);

    if (!open) return null;

    return (
        <div className="fixed inset-0 z-[10000] bg-black/50 p-4 grid place-items-center">
            <div className="w-full max-w-[520px] rounded-2xl border border-black/10 bg-white shadow-xl overflow-hidden">
                <div className="p-4 border-b border-black/10 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                        <p className="text-sm text-black/50 font-semibold">
                            Nota de producto
                        </p>
                        <p className="text-lg font-extrabold text-negro truncate">
                            {productoNombre}
                        </p>
                    </div>

                    <button
                        type="button"
                        onClick={onCancel}
                        className="h-10 w-10 rounded-xl border border-black/10 bg-white text-black/60 hover:bg-black/5"
                        title="Cerrar"
                    >
                        ✕
                    </button>
                </div>

                <div className="p-4">
                    <textarea
                        value={value}
                        onChange={(e) => setValue(e.target.value)}
                        onKeyDown={(e) => {
                            const isEnter = e.key === "Enter";
                            const isModifier = e.ctrlKey || e.metaKey;
                            if (isEnter && isModifier) {
                                e.preventDefault();
                                onSave(value);
                            }
                        }}
                        placeholder='Ej: "Sin queso", "Muy hecho", "Sin sal"...'
                        className="w-full min-h-[140px] resize-none rounded-xl border border-black/10 bg-white px-3 py-3 outline-none focus:ring-2 focus:ring-black/10"
                    />
                    <p className="mt-2 text-xs text-black/50">
                        Tip: pulsa <span className="font-semibold">Ctrl + Enter</span> para
                        guardar rápidamente
                    </p>

                    <div className="mt-4 flex items-center justify-end gap-2">
                        <button
                            type="button"
                            onClick={onCancel}
                            className="px-4 py-2 rounded-xl border border-black/10 bg-white hover:bg-black/5 text-sm font-semibold"
                        >
                            Cancelar
                        </button>

                        <button
                            type="button"
                            onClick={() => onSave(value)}
                            className="px-4 py-2 rounded-xl bg-black text-white hover:bg-black/90 text-sm font-semibold"
                        >
                            Guardar
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}

/* =========================
   Helpers ticket (sin SQL)
========================= */

async function ensureOpenComanda(
    idMesa: number,
    idUsuario: number | null,
    reservaActiva?: { idReserva: number } | null,
): Promise<number> {
    return await mesasEnsureOpenComanda({
        idMesa,
        idUsuario,
        idReserva: reservaActiva?.idReserva ?? null,
    });
}

async function loadTicketForComanda(idComanda: number): Promise<TicketItem[]> {
    const rows = await mesasLoadTicket(idComanda);

    const mapped: TicketItem[] = (rows ?? []).map((r: any) => {
        const idDetalle = Number(pick(r, ["id", "ID_Detalle", "idDetalle"]));
        const idProducto = Number(
            pick(r, ["productoId", "ID_Producto", "idProducto"]),
        );

        const nombre = String(
            pick(r, ["nombre", "Nombre_Producto", "Nombre"]) ?? "",
        );

        const precio = Number(
            pick(r, ["precio", "Precio_Unitario", "precioUnitario"]) ?? 0,
        );

        const pagadoNum = Number(pick(r, ["pagado", "Pagado"]) ?? 0);
        const pagado = pagadoNum === 1;

        const pasaNum = Number(
            pick(r, ["pasaCocina", "Pasa_Cocina", "pasa_cocina"]) ?? 0,
        );
        const pasa = pasaNum === 1;

        const estadoDb = String(
            pick(r, ["estadoCocina", "Estado_Cocina", "estado_cocina"]) ??
            "PENDIENTE",
        );

        const estadoCocina = pasa ? estadoDb || "PENDIENTE" : "NO_COCINA";
        const notas = (pick(r, ["notas", "Notas"]) ?? null) as string | null;

        return {
            id: idDetalle,
            productoId: idProducto,
            nombre,
            precio,
            pagado,
            seleccionado: false,
            estadoCocina,
            pasaCocina: pasa,
            notas: notas ? String(notas) : null,
        };
    });

    const hayPendientes = mapped.some((t) => !t.pagado);
    if (!hayPendientes) return [];

    return mapped;
}

async function addDetalle(
    idComanda: number,
    p: ProductoDisplay,
    operadorId: number | null,
) {
    await mesasAddDetalle({
        idComanda,
        idProducto: p.ID_Producto,
        cantidad: 1,
        precio: Number(p.Precio_Venta ?? 0),
        idUsuario: operadorId,
    });
}

async function removeOnePendingDetalle(idComanda: number, productoId: number) {
    await mesasRemoveOnePendingDetalle({ idComanda, idProducto: productoId });
}

async function deleteDetalleById(idDetalle: number) {
    await mesasDeleteDetalle(idDetalle);
}

function fmtReserva(res: NonNullable<MesaMeta["reserva"]>) {
    const min = res.minutosPara;
    if (res.estado === "ACTIVA") {
        if (min < 0) return `Reserva activa · llegó hace ${Math.abs(min)} min`;
        return `Reserva activa · es ahora`;
    }
    return `Reserva en ${Math.max(0, min)} min`;
}

export default function MesaComandaModal({
    open,
    onClose,
    mesaId,
    mesaNombre,
    mesaMeta,
    onChanged,
}: {
    open: boolean;
    onClose: () => void;
    mesaId: number;
    mesaNombre: string;
    mesaMeta?: MesaMeta | null;
    onChanged?: () => void;
}) {
    const [categorias, setCategorias] = useState<CategoriaDisplay[]>([]);
    const [categoriaSeleccionada, setCategoriaSeleccionada] =
        useState<CategoriaDisplay | null>(null);

    const [productos, setProductos] = useState<ProductoDisplay[]>([]);
    const [loadingProductos, setLoadingProductos] = useState(false);

    const [query, setQuery] = useState("");
    const q = query.trim();
    const [busqueda, setBusqueda] = useState<ProductoDisplay[]>([]);
    const [loadingBusqueda, setLoadingBusqueda] = useState(false);

    const [idComanda, setIdComanda] = useState<number | null>(null);
    const [ticket, setTicket] = useState<TicketItem[]>([]);
    const [loadingTicket, setLoadingTicket] = useState(false);

    const [paso, setPaso] = useState<Paso>("categorias");
    const [cashCount, setCashCount] = useState<Record<string, number>>({});

    const { idUsuario, idTrabajador, role } = useAuth();
    const isAdmin = (role || "").toLowerCase().includes("admin");
    const operador = isAdmin ? null : (idTrabajador ?? idUsuario ?? null);
    const reserva = mesaMeta?.reserva ?? null;

    const notifyChanged = () => {
        try {
            onChanged?.();
        } finally {
            window.dispatchEvent(new CustomEvent("mesas:changed"));
        }
    };

    const [openNota, setOpenNota] = useState(false);
    const [notaTarget, setNotaTarget] = useState<TicketItem | null>(null);

    const abrirNota = (linea: TicketItem) => {
        setNotaTarget(linea);
        setOpenNota(true);
    };

    const cerrarNota = () => {
        setOpenNota(false);
        setNotaTarget(null);
    };

    const guardarNotaLinea = async (idDetalle: number, nota: string) => {
        const clean = nota.trim();
        await mesasUpdateDetalleNota({
            idDetalle,
            nota: clean ? clean : null,
        });

        setTicket((prev) =>
            prev.map((t) =>
                t.id === idDetalle ? { ...t, notas: clean || null } : t,
            ),
        );

        notifyChanged();
    };

    const [openProductDetail, setOpenProductDetail] = useState(false);
    const [productDetailTarget, setProductDetailTarget] =
        useState<ProductoDisplay | null>(null);

    const abrirDetalleProducto = (p: ProductoDisplay) => {
        setProductDetailTarget(p);
        setOpenProductDetail(true);
    };

    const cerrarDetalleProducto = () => {
        setOpenProductDetail(false);
        setProductDetailTarget(null);
    };

    useEffect(() => {
        if (!open) return;

        const cargarCategorias = async () => {
            try {
                const baseDir = await appDataDir();
                const rows = await productosListCategoriasVendibles();

                const procesadas: CategoriaDisplay[] = await Promise.all(
                    (rows ?? []).map(async (cat) => ({
                        ...cat,
                        urlImagen: convertFileSrc(
                            await join(baseDir, cat.Ruta_Imagen || ""),
                        ),
                    })),
                );

                setCategorias(procesadas);
            } catch (e) {
                console.error("Fallo al cargar categorías", e);
                setCategorias([]);
            }
        };

        cargarCategorias();
    }, [open]);

    useEffect(() => {
        if (!open) return;

        (async () => {
            try {
                setLoadingTicket(true);

                const reservaActiva =
                    reserva?.estado === "ACTIVA"
                        ? { idReserva: reserva.idReserva }
                        : null;

                const cId = await ensureOpenComanda(
                    mesaId,
                    operador,
                    reservaActiva,
                );
                setIdComanda(cId);

                const t = await loadTicketForComanda(cId);
                setTicket(t);

                notifyChanged();
            } catch (e) {
                console.error(e);
                setIdComanda(null);
                setTicket([]);
            } finally {
                setLoadingTicket(false);
            }
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, mesaId, idUsuario, reserva?.estado, reserva?.idReserva]);

    async function reloadTicket() {
        if (!idComanda) return;
        setLoadingTicket(true);
        try {
            const t = await loadTicketForComanda(idComanda);
            setTicket(t);
            notifyChanged();
        } finally {
            setLoadingTicket(false);
        }
    }

    useEffect(() => {
        const cargarProductos = async () => {
            if (!open) return;
            if (!categoriaSeleccionada) return;

            setLoadingProductos(true);
            try {
                const baseDir = await appDataDir();
                const idCat = Number(categoriaSeleccionada.ID_Categoria);

                const rows = await productosListByCategoria(idCat);

                const procesados: ProductoDisplay[] = await Promise.all(
                    (rows ?? []).map(async (p) => ({
                        ...p,
                        urlImagen: convertFileSrc(
                            await join(baseDir, p.Ruta_Imagen || ""),
                        ),
                    })),
                );

                setProductos(procesados);
            } catch (e) {
                console.error("Fallo al cargar productos", e);
                setProductos([]);
            } finally {
                setLoadingProductos(false);
            }
        };

        cargarProductos();
    }, [open, categoriaSeleccionada]);

    useEffect(() => {
        if (!open) return;

        const run = async () => {
            if (!q) {
                setBusqueda([]);
                return;
            }
            setLoadingBusqueda(true);
            try {
                const baseDir = await appDataDir();
                const rows = await productosSearchByNombre(q);

                const procesados: ProductoDisplay[] = await Promise.all(
                    (rows ?? []).map(async (p) => ({
                        ...p,
                        urlImagen: convertFileSrc(
                            await join(baseDir, p.Ruta_Imagen || ""),
                        ),
                    })),
                );

                setBusqueda(procesados);
            } catch (e) {
                console.error("Fallo búsqueda", e);
                setBusqueda([]);
            } finally {
                setLoadingBusqueda(false);
            }
        };

        const t = window.setTimeout(run, 180);
        return () => window.clearTimeout(t);
    }, [open, q]);

    const addProductoToTicket = async (p: ProductoDisplay) => {
        if (!idComanda) return;
        if (!isAdmin && operador == null) return;

        await addDetalle(idComanda, p, operador);
        await reloadTicket();
    };

    const removeProductoFromTicket = async (productoId: number) => {
        if (!idComanda) return;
        await removeOnePendingDetalle(idComanda, productoId);
        await reloadTicket();
    };

    const countEnTicket = (productoId: number) =>
        ticket.filter((t) => t.productoId === productoId && !t.pagado).length;

    const totalPendiente = useMemo(
        () =>
            ticket
                .filter((t) => !t.pagado)
                .reduce((acc, t) => acc + t.precio, 0),
        [ticket],
    );

    const totalSeleccionado = useMemo(
        () =>
            ticket
                .filter((t) => !t.pagado && t.seleccionado)
                .reduce((acc, t) => acc + t.precio, 0),
        [ticket],
    );

    const haySeleccion = useMemo(
        () => ticket.some((t) => !t.pagado && t.seleccionado),
        [ticket],
    );

    const seleccionaTodoPendiente = () => {
        setTicket((prev) =>
            prev.map((t) => (t.pagado ? t : { ...t, seleccionado: true })),
        );
    };

    const limpiarSeleccion = () => {
        setTicket((prev) =>
            prev.map((t) => (t.pagado ? t : { ...t, seleccionado: false })),
        );
    };

    const toggleSeleccion = (idDetalle: number) => {
        setTicket((prev) =>
            prev.map((t) =>
                t.id === idDetalle && !t.pagado
                    ? { ...t, seleccionado: !t.seleccionado }
                    : t,
            ),
        );
    };

    const eliminarLineaTicket = async (idDetalle: number) => {
        const line = ticket.find((t) => t.id === idDetalle);
        if (!line) return;
        if (line.pagado) return;
        await deleteDetalleById(idDetalle);
        await reloadTicket();
    };

    const cobrar = async (metodo: "tarjeta" | "efectivo") => {
        if (!idComanda) return;

        const ids = ticket
            .filter((t) => !t.pagado && t.seleccionado)
            .map((t) => t.id);

        if (!ids.length) return;

        try {
            console.log("Cobrando detalles:", {
                idComanda,
                ids,
                metodo,
                operador,
            });

            await mesasCobrarDetalles({
                idComanda,
                metodo: metodo === "tarjeta" ? "Tarjeta" : "Efectivo",
                tipo:
                    ids.length === ticket.filter((t) => !t.pagado).length
                        ? "TOTAL"
                        : "FRACCIONADO",
                detalleIds: ids,
                idUsuario: operador,
            });

            const t = await loadTicketForComanda(idComanda);
            console.log("Ticket tras cobrar:", t);

            setCashCount({});
            setPaso("categorias");
            setCategoriaSeleccionada(null);
            setQuery("");
            setBusqueda([]);
            setTicket(t);
            window.dispatchEvent(new CustomEvent("mesas:changed"));
            notifyChanged();
        } catch (e) {
            console.error("Error cobrando:", e);
        }
    };

    const totalEfectivo = useMemo(() => {
        let sum = 0;
        for (const d of DENOMS) {
            const c = cashCount[d.label] || 0;
            sum += d.value * c;
        }
        return Math.round(sum * 100) / 100;
    }, [cashCount]);

    const totalACobrar = useMemo(
        () => (haySeleccion ? totalSeleccionado : 0),
        [haySeleccion, totalSeleccionado],
    );

    const diferencia = useMemo(() => {
        const diff = totalEfectivo - totalACobrar;
        return Math.round(diff * 100) / 100;
    }, [totalEfectivo, totalACobrar]);

    const addCash = (label: string) =>
        setCashCount((p) => ({ ...p, [label]: (p[label] || 0) + 1 }));

    const removeCash = (label: string) => {
        setCashCount((prev) => {
            const cur = prev[label] || 0;
            const next = Math.max(0, cur - 1);
            const out = { ...prev, [label]: next };
            if (next === 0) delete out[label];
            return out;
        });
    };

    const resetCash = () => setCashCount({});

    const showingSearch = q.length > 0;

    const leftTitle = useMemo(() => {
        if (paso === "efectivo") return "Cobro en efectivo";
        if (showingSearch) return `Productos · "${q}"`;
        if (categoriaSeleccionada)
            return `Productos · ${categoriaSeleccionada.Nombre}`;
        return "Categorías";
    }, [paso, showingSearch, q, categoriaSeleccionada]);

    const leftSubtitle = useMemo(() => {
        if (paso === "efectivo")
            return "Selecciona billetes/monedas y verás el cambio.";
        if (showingSearch) return "Resultados del buscador (con + / −).";
        if (categoriaSeleccionada)
            return "Usa +/− o pulsa la tarjeta para añadir.";
        return "Elige una categoría para ver sus productos.";
    }, [paso, showingSearch, categoriaSeleccionada]);

    useEffect(() => {
        if (categoriaSeleccionada && !showingSearch && paso !== "efectivo")
            setPaso("productos");
        if (!categoriaSeleccionada && !showingSearch && paso === "productos")
            setPaso("categorias");
    }, [categoriaSeleccionada, showingSearch]);

    const ProductCard = ({ p }: { p: ProductoDisplay }) => {
        const qty = countEnTicket(p.ID_Producto);

        return (
            <div className="rounded-xl border border-black/10 bg-white p-3 text-left">
                <div
                    role="button"
                    tabIndex={0}
                    onClick={() => addProductoToTicket(p)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            addProductoToTicket(p);
                        }
                    }}
                    className="w-full text-left hover:opacity-95 transition cursor-pointer outline-none"
                >
                    <div className="relative">
                        <img
                            src={p.urlImagen}
                            alt={p.Nombre}
                            className="w-full h-28 object-cover rounded-lg border border-black/5"
                        />

                        <button
                            type="button"
                            onClick={(e) => {
                                e.stopPropagation();
                                abrirDetalleProducto(p);
                            }}
                            className="absolute top-2 right-2 w-8 h-8 rounded-full bg-white/90 border border-black/10 shadow-sm flex items-center justify-center text-black/70 hover:bg-white transition"
                            title="Info"
                            aria-label={`Info de ${p.Nombre}`}
                        >
                            ℹ️
                        </button>

                        {qty > 0 ? (
                            <div className="absolute -top-2 -left-2 w-8 h-8 rounded-full bg-black text-white flex items-center justify-center text-sm font-bold border-2 border-white">
                                {qty}
                            </div>
                        ) : null}
                    </div>

                    <div className="mt-2 flex items-start justify-between gap-2">
                        <p className="font-semibold leading-tight">{p.Nombre}</p>
                        <span className="text-sm font-bold">
                            {eur(Number(p.Precio_Venta || 0))}
                        </span>
                    </div>
                </div>

                <div className="mt-3 flex items-center justify-between gap-2">
                    <button
                        type="button"
                        onClick={() => removeProductoFromTicket(p.ID_Producto)}
                        className={cn(
                            "w-11 h-11 rounded-xl border border-black/10 bg-white hover:bg-black/5 font-bold",
                            qty === 0 && "opacity-40 cursor-not-allowed",
                        )}
                        disabled={qty === 0}
                    >
                        −
                    </button>

                    <div className="flex-1 text-center rounded-xl border border-black/10 bg-black/5 py-2">
                        <p className="text-xs text-black/60">Cantidad</p>
                        <p className="text-lg font-bold">{qty}</p>
                    </div>

                    <button
                        type="button"
                        onClick={() => addProductoToTicket(p)}
                        className="w-11 h-11 rounded-xl border border-black/10 bg-white hover:bg-black/5 font-bold"
                    >
                        +
                    </button>
                </div>
            </div>
        );
    };

    const modalTitle = useMemo(() => {
        if (reserva?.estado === "ACTIVA")
            return `Mesa: ${mesaNombre} · Reserva ${reserva.clienteNombre}`;
        return `Mesa: ${mesaNombre}`;
    }, [mesaNombre, reserva?.estado, reserva?.clienteNombre]);

    return (
        <Modal
            open={open}
            title={modalTitle}
            onClose={() => {
                setPaso("categorias");
                setCategoriaSeleccionada(null);
                setQuery("");
                setBusqueda([]);
                setCashCount({});
                limpiarSeleccion();
                cerrarNota();
                cerrarDetalleProducto();
                onClose();
            }}
        >
            <NotaLineaModal
                open={openNota}
                productoNombre={notaTarget?.nombre ?? ""}
                initialValue={notaTarget?.notas ?? ""}
                onCancel={cerrarNota}
                onSave={async (nota) => {
                    if (!notaTarget) return;
                    await guardarNotaLinea(notaTarget.id, nota);
                    cerrarNota();
                }}
            />

            <ProductDetailModal
                open={openProductDetail}
                onClose={cerrarDetalleProducto}
                productId={productDetailTarget?.ID_Producto ?? 0}
            />

            <div className="w-full h-full flex flex-col min-h-0">
                {reserva ? (
                    <div
                        className={cn(
                            "mb-4 rounded-2xl border p-4 flex items-start justify-between gap-3",
                            reserva.estado === "ACTIVA"
                                ? "border-blue-200 bg-blue-50"
                                : "border-blue-200/70 bg-blue-50/60",
                        )}
                    >
                        <div className="min-w-0">
                            <p className={cn("font-extrabold", "text-blue-900")}>
                                {reserva.estado === "ACTIVA"
                                    ? "🔵 Reserva activa"
                                    : "🔷 Reserva próxima"}
                            </p>

                            <p className="text-sm text-blue-900/80 mt-1">
                                {reserva.clienteNombre} · {reserva.diaYMD} {reserva.hora} ·{" "}
                                {fmtReserva(reserva)}
                            </p>

                            {reserva.estado === "PROXIMA" ? (
                                <p className="text-xs text-blue-900/60 mt-2">
                                    Pulsa “Ha llegado ya el cliente” cuando esté en el local
                                    para imputar comandas a la reserva.
                                </p>
                            ) : null}
                        </div>

                        {reserva.estado === "PROXIMA" ? (
                            <button
                                type="button"
                                className="shrink-0 px-4 py-2 rounded-xl font-semibold border-2 border-blue-600 text-blue-700 bg-white hover:bg-blue-600 hover:text-white transition"
                                onClick={async () => {
                                    try {
                                        await reservaMarcarActivaAhora(reserva.idReserva);
                                        notifyChanged();

                                        setLoadingTicket(true);

                                        const cId = await ensureOpenComanda(
                                            mesaId,
                                            operador,
                                            { idReserva: reserva.idReserva },
                                        );

                                        setIdComanda(cId);
                                        const t = await loadTicketForComanda(cId);
                                        setTicket(t);

                                        notifyChanged();
                                    } catch (e) {
                                        console.error(e);
                                    } finally {
                                        setLoadingTicket(false);
                                    }
                                }}
                            >
                                ✅ Ha llegado ya el cliente
                            </button>
                        ) : null}

                        {reserva.estado === "ACTIVA" ? (
                            <button
                                type="button"
                                className="shrink-0 px-4 py-2 rounded-xl font-semibold border-2 border-rose-600 text-rose-700 bg-white hover:bg-rose-600 hover:text-white transition"
                                onClick={async () => {
                                    try {
                                        await reservaFinalizar(reserva.idReserva);
                                        notifyChanged();
                                    } catch (e) {
                                        console.error(e);
                                    }
                                }}
                            >
                                🧾 El cliente abandona la mesa
                            </button>
                        ) : null}
                    </div>
                ) : null}

                <div className="flex items-center justify-between gap-3 mb-4">
                    <div className="text-sm text-slate-600">
                        {loadingTicket
                            ? "Cargando ticket…"
                            : idComanda
                                ? `Comanda #${idComanda}`
                                : "Sin comanda"}
                    </div>

                    <button
                        className="px-3 py-2 rounded-xl border border-black/10 bg-white hover:bg-black/5 text-sm font-semibold"
                        onClick={reloadTicket}
                        type="button"
                    >
                        Recargar
                    </button>
                </div>

                <div className="flex flex-1 min-h-0 gap-4">
                    <div className="flex-1 min-h-0 bg-white rounded-xl border border-black/10 p-4 flex flex-col">
                        <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                                <h3 className="text-lg font-bold text-negro">
                                    {leftTitle}
                                </h3>
                                <p className="text-sm text-negro/60">
                                    {leftSubtitle}
                                </p>
                            </div>

                            {categoriaSeleccionada &&
                                !showingSearch &&
                                paso !== "efectivo" ? (
                                <button
                                    className="px-3 py-2 rounded-xl border border-black/10 bg-white hover:bg-black/5 text-sm font-semibold"
                                    onClick={() => setCategoriaSeleccionada(null)}
                                    type="button"
                                >
                                    Ver categorías
                                </button>
                            ) : null}
                        </div>

                        <div className="mt-3">
                            <input
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                placeholder="Buscar producto por nombre…"
                                className="w-full rounded-xl border border-black/10 bg-white px-4 py-3 outline-none focus:ring-2 focus:ring-black/10"
                                disabled={paso === "efectivo"}
                            />
                            {paso === "efectivo" ? (
                                <p className="mt-2 text-xs text-black/50">
                                    Estás en modo efectivo. Termina el cobro o pulsa
                                    “Cancelar”.
                                </p>
                            ) : null}
                        </div>

                        <div
                            className={cn(
                                "mt-4 flex-1 min-h-0",
                                paso === "efectivo" && "overflow-y-auto pr-1",
                            )}
                        >
                            {paso === "efectivo" ? (
                                <div className="flex flex-col gap-4">
                                    <div className="rounded-xl border border-black/10 bg-white p-4">
                                        <div className="flex items-center justify-between">
                                            <p className="text-sm text-black/60">Total a cobrar</p>
                                            <p className="text-xl font-bold">
                                                {eur(totalACobrar)}
                                            </p>
                                        </div>

                                        <div className="mt-2 flex items-center justify-between">
                                            <p className="text-sm text-black/60">Te han dado</p>
                                            <p className="text-xl font-bold">
                                                {eur(totalEfectivo)}
                                            </p>
                                        </div>

                                        <div className="mt-3 rounded-xl p-3 border border-black/10 bg-black/5">
                                            {diferencia >= 0 ? (
                                                <div className="flex items-center justify-between">
                                                    <p className="text-sm font-semibold text-emerald-700">
                                                        Cambio
                                                    </p>
                                                    <p className="text-lg font-bold text-emerald-700">
                                                        {eur(diferencia)}
                                                    </p>
                                                </div>
                                            ) : (
                                                <div className="flex items-center justify-between">
                                                    <p className="text-sm font-semibold text-rose-700">
                                                        Falta
                                                    </p>
                                                    <p className="text-lg font-bold text-rose-700">
                                                        {eur(Math.abs(diferencia))}
                                                    </p>
                                                </div>
                                            )}
                                        </div>

                                        <div className="mt-3 flex gap-2">
                                            <button
                                                className="flex-1 px-3 py-3 rounded-xl border border-black/10 bg-white hover:bg-black/5 text-sm font-semibold"
                                                onClick={resetCash}
                                                type="button"
                                            >
                                                Reset
                                            </button>

                                            <button
                                                className={cn(
                                                    "flex-1 px-3 py-3 rounded-xl text-sm font-semibold transition",
                                                    diferencia >= 0
                                                        ? "bg-black text-white hover:bg-black/90"
                                                        : "bg-black/10 text-black/40 cursor-not-allowed",
                                                )}
                                                disabled={diferencia < 0}
                                                onClick={() => cobrar("efectivo")}
                                                type="button"
                                                title={
                                                    diferencia < 0
                                                        ? "Falta dinero"
                                                        : "Confirmar cobro en efectivo"
                                                }
                                            >
                                                Confirmar cobro
                                            </button>

                                            <button
                                                className="flex-1 px-3 py-3 rounded-xl border border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100 text-sm font-semibold"
                                                onClick={() => {
                                                    setPaso("metodo");
                                                    setCashCount({});
                                                }}
                                                type="button"
                                            >
                                                Cancelar
                                            </button>
                                        </div>
                                    </div>

                                    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                                        {DENOMS.map((d) => {
                                            const count = cashCount[d.label] || 0;
                                            return (
                                                <div
                                                    key={d.label}
                                                    className="rounded-xl border border-black/10 bg-white p-3 flex flex-col gap-2"
                                                >
                                                    <div className="flex items-center justify-between">
                                                        <p className="font-bold">{d.label}</p>
                                                        <span className="text-xs text-black/50">
                                                            {eur(d.value)}
                                                        </span>
                                                    </div>

                                                    <div className="flex items-center justify-between gap-2">
                                                        <button
                                                            className={cn(
                                                                "w-10 h-10 rounded-xl border border-black/10 bg-white hover:bg-black/5 font-bold",
                                                                count === 0 &&
                                                                "opacity-40 cursor-not-allowed",
                                                            )}
                                                            disabled={count === 0}
                                                            onClick={() => removeCash(d.label)}
                                                            type="button"
                                                        >
                                                            −
                                                        </button>

                                                        <div className="flex-1 text-center">
                                                            <p className="text-xs text-black/50">
                                                                Cantidad
                                                            </p>
                                                            <p className="text-lg font-bold">
                                                                {count}
                                                            </p>
                                                        </div>

                                                        <button
                                                            className="w-10 h-10 rounded-xl border border-black/10 bg-white hover:bg-black/5 font-bold"
                                                            onClick={() => addCash(d.label)}
                                                            type="button"
                                                        >
                                                            +
                                                        </button>
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            ) : (
                                <div className="h-full overflow-y-auto pr-1">
                                    {showingSearch ? (
                                        loadingBusqueda ? (
                                            <p className="text-sm text-black/60">Buscando…</p>
                                        ) : busqueda.length === 0 ? (
                                            <p className="text-sm text-black/60">
                                                No hay resultados.
                                            </p>
                                        ) : (
                                            <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(200px,1fr))]">
                                                {busqueda.map((p) => (
                                                    <ProductCard
                                                        key={p.ID_Producto}
                                                        p={p}
                                                    />
                                                ))}
                                            </div>
                                        )
                                    ) : !categoriaSeleccionada ? (
                                        <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(170px,1fr))]">
                                            {categorias.map((c) => (
                                                <button
                                                    key={c.ID_Categoria}
                                                    onClick={() => setCategoriaSeleccionada(c)}
                                                    className="rounded-xl border border-black/10 bg-white hover:bg-black/5 p-3 text-left transition"
                                                    type="button"
                                                >
                                                    <img
                                                        src={c.urlImagen}
                                                        alt={c.Nombre}
                                                        className="w-full h-28 object-cover rounded-lg border border-black/5"
                                                    />
                                                    <p className="mt-2 font-bold">{c.Nombre}</p>
                                                </button>
                                            ))}
                                        </div>
                                    ) : loadingProductos ? (
                                        <p className="text-sm text-black/60">
                                            Cargando productos…
                                        </p>
                                    ) : productos.length === 0 ? (
                                        <p className="text-sm text-black/60">
                                            No hay productos en esta categoría.
                                        </p>
                                    ) : (
                                        <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(200px,1fr))]">
                                            {productos.map((p) => (
                                                <ProductCard
                                                    key={p.ID_Producto}
                                                    p={p}
                                                />
                                            ))}
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>

                    <div className="w-[420px] shrink-0 bg-white rounded-xl border border-black/10 p-4 flex flex-col min-h-0">
                        <div className="flex items-center justify-between">
                            <h3 className="text-lg font-bold text-negro">Ticket</h3>
                            <div className="text-sm font-semibold text-black/70">
                                Total pendiente:{" "}
                                <span className="text-black">{eur(totalPendiente)}</span>
                            </div>
                        </div>

                        <div className="mt-3 flex items-center gap-2">
                            <button
                                className={cn(
                                    "flex-1 px-3 py-2 rounded-xl text-sm font-semibold transition",
                                    ticket.some((t) => !t.pagado)
                                        ? "bg-black text-white hover:bg-black/90"
                                        : "bg-black/10 text-black/40 cursor-not-allowed",
                                )}
                                disabled={!ticket.some((t) => !t.pagado)}
                                onClick={() => {
                                    seleccionaTodoPendiente();
                                    setPaso("metodo");
                                }}
                                type="button"
                            >
                                Cobrar todo
                            </button>

                            <button
                                className={cn(
                                    "flex-1 px-3 py-2 rounded-xl text-sm font-semibold transition",
                                    haySeleccion
                                        ? "bg-white border border-black/10 hover:bg-black/5"
                                        : "bg-black/10 text-black/40 cursor-not-allowed",
                                )}
                                disabled={!haySeleccion}
                                onClick={() => setPaso("metodo")}
                                type="button"
                            >
                                Cobrar fraccionado
                            </button>
                        </div>

                        <div className="mt-4 flex-1 min-h-0 overflow-y-auto pr-1 rounded-xl border border-black/10 bg-white">
                            {loadingTicket ? (
                                <div className="p-4 text-sm text-black/60">Cargando…</div>
                            ) : ticket.length === 0 ? (
                                <div className="p-4 text-sm text-black/60">
                                    Añade productos para empezar.
                                </div>
                            ) : (
                                <div className="p-3 flex flex-col gap-2">
                                    {ticket.map((t) => {
                                        const checked = t.seleccionado && !t.pagado;
                                        const hasNota = Boolean((t.notas ?? "").trim());

                                        return (
                                            <div
                                                key={t.id}
                                                role="button"
                                                tabIndex={t.pagado ? -1 : 0}
                                                onClick={() => {
                                                    if (!t.pagado) toggleSeleccion(t.id);
                                                }}
                                                onKeyDown={(e) => {
                                                    if (t.pagado) return;
                                                    if (
                                                        e.key === "Enter" ||
                                                        e.key === " "
                                                    ) {
                                                        e.preventDefault();
                                                        toggleSeleccion(t.id);
                                                    }
                                                }}
                                                className={cn(
                                                    "w-full rounded-xl border p-3 text-left transition flex items-center justify-between gap-3",
                                                    "border-black/10 hover:bg-black/5",
                                                    t.pagado && "opacity-70",
                                                )}
                                                aria-disabled={t.pagado}
                                            >
                                                <div className="flex items-center gap-3 min-w-0">
                                                    <div
                                                        className={cn(
                                                            "w-6 h-6 rounded-full border flex items-center justify-center shrink-0",
                                                            checked
                                                                ? "border-emerald-500 bg-emerald-500"
                                                                : "border-black/20 bg-white",
                                                            t.pagado &&
                                                            "border-black/10 bg-black/5",
                                                        )}
                                                    >
                                                        {checked ? (
                                                            <div className="w-2.5 h-2.5 rounded-full bg-white" />
                                                        ) : null}
                                                    </div>

                                                    <div className="min-w-0">
                                                        <p
                                                            className={cn(
                                                                "font-semibold truncate",
                                                                t.pagado &&
                                                                "line-through text-black/50",
                                                            )}
                                                        >
                                                            {t.nombre}
                                                        </p>

                                                        <p
                                                            className={cn(
                                                                "text-xs",
                                                                t.pagado
                                                                    ? "text-black/50"
                                                                    : !t.pasaCocina
                                                                        ? "text-slate-600 font-semibold"
                                                                        : t.estadoCocina ===
                                                                            "PREPARADO"
                                                                            ? "text-emerald-700 font-semibold"
                                                                            : "text-black/50",
                                                            )}
                                                        >
                                                            {t.pagado
                                                                ? "Cobrado"
                                                                : !t.pasaCocina
                                                                    ? "No cocina"
                                                                    : t.estadoCocina ===
                                                                        "PREPARADO"
                                                                        ? "Preparado"
                                                                        : "Pendiente"}
                                                        </p>

                                                        {hasNota ? (
                                                            <p className="mt-1 text-[11px] text-black/60 truncate">
                                                                📝 {t.notas}
                                                            </p>
                                                        ) : null}
                                                    </div>
                                                </div>

                                                <div className="flex items-center gap-2">
                                                    <span
                                                        className={cn(
                                                            "font-bold",
                                                            t.pagado &&
                                                            "line-through text-black/40",
                                                        )}
                                                    >
                                                        {eur(t.precio)}
                                                    </span>

                                                    {!t.pagado ? (
                                                        <button
                                                            type="button"
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                abrirNota(t);
                                                            }}
                                                            className={cn(
                                                                "w-8 h-8 flex items-center justify-center rounded-lg border transition",
                                                                hasNota
                                                                    ? "border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100"
                                                                    : "border-black/10 text-black/50 hover:bg-black/5",
                                                            )}
                                                            title={
                                                                hasNota
                                                                    ? "Editar nota"
                                                                    : "Añadir nota"
                                                            }
                                                        >
                                                            ✏️
                                                        </button>
                                                    ) : null}

                                                    {!t.pagado ? (
                                                        <button
                                                            type="button"
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                eliminarLineaTicket(t.id);
                                                            }}
                                                            className="w-8 h-8 flex items-center justify-center rounded-lg border border-black/10 text-black/50 hover:bg-rose-50 hover:text-rose-600 hover:border-rose-200 transition"
                                                            title="Eliminar producto"
                                                        >
                                                            🗑️
                                                        </button>
                                                    ) : null}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>

                        <div className="mt-4 rounded-xl border border-black/10 bg-white p-3">
                            <div className="flex items-center justify-between">
                                <p className="text-sm text-black/60">Seleccionado</p>
                                <p className="font-bold">{eur(totalSeleccionado)}</p>
                            </div>

                            {paso === "metodo" ? (
                                <div className="mt-3 grid grid-cols-2 gap-2">
                                    <button
                                        className={cn(
                                            "px-3 py-3 rounded-xl text-sm font-semibold transition",
                                            haySeleccion
                                                ? "bg-black text-white hover:bg-black/90"
                                                : "bg-black/10 text-black/40 cursor-not-allowed",
                                        )}
                                        disabled={!haySeleccion}
                                        onClick={() => cobrar("tarjeta")}
                                        type="button"
                                    >
                                        Cobrar con tarjeta
                                    </button>

                                    <button
                                        className={cn(
                                            "px-3 py-3 rounded-xl text-sm font-semibold transition",
                                            haySeleccion
                                                ? "bg-white border border-black/10 hover:bg-black/5"
                                                : "bg-black/10 text-black/40 cursor-not-allowed",
                                        )}
                                        disabled={!haySeleccion}
                                        onClick={() => {
                                            setPaso("efectivo");
                                            setCashCount({});
                                        }}
                                        type="button"
                                    >
                                        Cobrar en efectivo
                                    </button>

                                    <button
                                        className="col-span-2 px-3 py-2 rounded-xl border border-black/10 bg-white hover:bg-black/5 text-sm font-semibold"
                                        onClick={() => {
                                            setPaso("categorias");
                                            limpiarSeleccion();
                                        }}
                                        type="button"
                                    >
                                        Cancelar cobro
                                    </button>
                                </div>
                            ) : (
                                <p className="mt-2 text-xs text-black/50">
                                    Selecciona productos pendientes y pulsa “Cobrar
                                    fraccionado”, o pulsa “Cobrar todo”.
                                </p>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </Modal>
    );
}