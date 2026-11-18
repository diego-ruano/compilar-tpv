import { commands } from "@tpv/client";
// src/features/mesas/mesasApi.ts
//
// API de mesas / comandas / ticket / cocina: una función por comando Tauri, con los tipos que genera
// Specta desde Rust. Aquí no se redeclaran tipos ni se normaliza lo que vuelve (RI-53): el precio de
// una línea y el pendiente de una mesa llegan como `Dinero`.
//
// El plano (`Salon`/`Table`, en `./types`) sigue con su tipo de la pantalla: es la geometría del
// editor, no un dato de negocio. Pasa a los generados con RI-87.
//
// UUIDv7: todos los IDs de negocio son `string` (idénticos en local y nube).


import type {
    CambioIngredienteInput,
    CategoriaVendibleOut,
    ComandaConLineasOut,
    ComandaRow,
    DestinatarioInput,
    KitchenRow,
    MesaLineaComandaRow,
    MesaMetaOut,
    MesasAbrirComandaInput,
    MesasAddLineaComandaInput,
    MesasCobrarDetallesInput,
    ProductoVendibleOut,
} from "@tpv/contracts";

import type { Salon } from "./types";

export type { CategoriaVendibleOut, KitchenRow, MesaLineaComandaRow, MesaMetaOut, ProductoVendibleOut };

// Acepta el id crudo (UUID) o la clave de UI `db-mesa-<uuid>`. Devuelve el id o null.
function parseAnyMesaId(k: string): string | null {
    const s = String(k ?? "").trim();
    if (!s) return null;

    const m = s.match(/^db-mesa-(.+)$/);
    if (m) return m[1].trim() || null;

    return s;
}

/* =========================
   Layout / Meta mesas
========================= */

export async function mesasLoadLayout(): Promise<Salon[]> {
    const rows = await commands.loadLayout();
    return rows.map(salon => ({ ...salon, room: { ...salon.room, points: salon.room.points.map(punto => {
        if (punto == null || !Number.isFinite(punto)) throw new Error("El plano contiene una coordenada inválida");
        return punto;
    }) } }));
}

export async function mesasSaveLayout(salons: Salon[]): Promise<void> {
    // El contrato Rust (TableInput) tipa x/y/width/height/radius como i64. El editor
    // produce coordenadas de mundo fraccionarias al arrastrar con zoom ≠ 100 %, así que
    // redondeamos a entero aquí (chokepoint único de guardado) para no romper la
    // deserialización serde en la frontera Tauri.
    const list = Array.isArray(salons) ? salons : [];
    const safe = list.map((s) => ({
        ...s,
        tables: (s.tables ?? []).map((t) => ({
            ...t,
            x: Math.round(t.x),
            y: Math.round(t.y),
            width: Math.round(t.width),
            height: Math.round(t.height),
            radius: t.radius == null ? null : Math.round(t.radius),
        })),
    }));

    await commands.saveLayout({ salons: safe });
}

/** El estado del plano: lo de cada mesa y en cuántos segundos cambiará solo, con la hora. */
export type PlanoDeMesas = {
    porMesa: Record<string, MesaMetaOut>;
    /** `null`: nada va a cambiar con la hora (MESAS-02). */
    proximoCambioS: number | null;
};

/**
 * Estado de cada mesa del plano, indexado por el id de la mesa, y cuándo cambiará solo. Si falla,
 * falla: antes caía a `get_mesas_ocupadas`, una compatibilidad de antes de que existiera el
 * detalle, y era lo único que mantenía vivo ese comando (RI-52). React Query reintenta y la
 * pantalla enseña el error.
 */
export async function mesasLoadPlano(): Promise<PlanoDeMesas> {
    const porMesa: Record<string, MesaMetaOut> = {};
    const raw = await commands.mesasMetaAll();
    for (const [k, v] of Object.entries(raw.mesas)) {
        const idMesa = parseAnyMesaId(k);
        // `parseAnyMesaId` normaliza la clave a UUID puro, que es la que usan los lookups
        // (TableNode/Mesas vía `parseMesaId`). Una sola clave.
        if (idMesa && v) porMesa[idMesa] = v;
    }
    return { porMesa, proximoCambioS: raw.proximo_cambio_s };
}

/** Sólo lo de cada mesa (`mesasLoadPlano`). */
export async function mesasLoadMesaMeta(): Promise<Record<string, MesaMetaOut>> {
    return (await mesasLoadPlano()).porMesa;
}

/* =========================
   Reservas
========================= */

async function reservaSetEstado(
    idReserva: string,
    estado: "ACTIVA" | "FINALIZADA",
): Promise<void> {
    const id = idReserva.trim();
    if (!id) throw new Error("id_reserva inválido");

    await commands.setReservaEstado({ id_reserva: id, estado });
}

export async function reservaMarcarActivaAhora(
    idReserva: string,
): Promise<void> {
    await reservaSetEstado(idReserva, "ACTIVA");
}

export async function reservaFinalizar(idReserva: string): Promise<void> {
    await reservaSetEstado(idReserva, "FINALIZADA");
}

/* =========================
   Comandas / Ticket
========================= */

/** La comanda abierta de la mesa, si la hay. No crea ninguna. */
export async function mesasComandaAbierta(idMesa: string) {
    return await commands.getComandaAbiertaByMesa({ id_mesa: idMesa.trim() });
}

/**
 * Abrir o retomar la mesa en un paso: su comanda abierta (creada si no hay ninguna, con el
 * trabajador de la sesión si le faltaba) y sus líneas. Es lo que se pide al abrir la mesa; en la
 * Handy, un viaje en vez de cuatro.
 */
export async function mesasAbrirORetomar(params: {
    idMesa: string;
    idReserva: string | null;
}): Promise<ComandaConLineasOut> {
    const idMesa = params.idMesa.trim();
    if (!idMesa) throw new Error("Falta la mesa.");
    return commands.mesasAbrirORetomar({ id_mesa: idMesa, id_reserva: params.idReserva?.trim() || undefined });
}

/** INC-20261030-007: la reserva pasa a la comanda abierta, si aún no tiene ninguna. */
export async function mesasComandaSetReservaIfNull(idComanda: string, idReserva: string): Promise<boolean> {
    return await commands.comandaSetReservaIfNull({ id_comanda: idComanda, id_reserva: idReserva });
}

export async function mesasEnsureOpenComanda(params: {
    idMesa: string;
    idUsuario: string | null;
    idReserva: string | null;
}): Promise<string> {
    const idMesa = params.idMesa.trim();
    if (!idMesa) throw new Error("id_mesa inválido");
    const idUsuario = params.idUsuario?.trim() || undefined;

    const abierta = await commands.getComandaAbiertaByMesa({ id_mesa: idMesa });

    if (abierta?.id_comanda) {
        // Sólo si le falta: con trabajador no cambiaría nada, y aun así sería un viaje más (y en la
        // Main, una escritura que se replica).
        if (idUsuario && !abierta.id_trabajador) {
            try {
                await commands.comandaSetTrabajadorIfNull({ id_comanda: abierta.id_comanda, id_usuario: idUsuario });
            } catch {
                // No bloqueamos cargar/abrir la comanda por esto.
            }
        }
        return abierta.id_comanda;
    }

    const args: MesasAbrirComandaInput = {
        id_mesa: idMesa,
        id_usuario: idUsuario,
        id_reserva: params.idReserva?.trim() || undefined,
    };
    const creada = await commands.abrirComanda(args);

    if (!creada?.id_comanda) throw new Error("ID_Comanda inválido");
    return creada.id_comanda;
}

export async function mesasLoadTicket(idComanda: string): Promise<MesaLineaComandaRow[]> {
    const id = idComanda.trim();
    if (!id) return [];

    return commands.getLineasComanda({ id_comanda: id });
}

/**
 * Añade una línea y devuelve todas las de la comanda. Sin precio: lo pone el backend desde el
 * catálogo (RI-27), y llega en las filas que devuelve.
 */
export async function mesasAddDetalle(params: {
    idComanda: string;
    idProducto: string;
    cantidad?: number;
    idUsuario?: string | null;
}): Promise<MesaLineaComandaRow[]> {
    const args: MesasAddLineaComandaInput = {
        id_comanda: params.idComanda.trim(),
        id_producto: params.idProducto.trim(),
        cantidad: params.cantidad ?? 1,
        id_usuario: params.idUsuario?.trim() || undefined,
    };
    if (!args.id_comanda) throw new Error("id_comanda inválido");
    if (!args.id_producto) throw new Error("id_producto inválido");

    return commands.addLineaComanda(args);
}

/* =========================
   Productos / Catálogo vendible
========================= */

export async function productosListByCategoria(idCategoria: string): Promise<ProductoVendibleOut[]> {
    const idCat = idCategoria.trim();
    if (!idCat) throw new Error("id_categoria inválido");

    return commands.listProductosByCategoria({ id_categoria: idCat });
}

export async function productosSearchByNombre(q: string): Promise<ProductoVendibleOut[]> {
    const query = q.trim();
    if (!query) return [];

    return commands.searchProductosByNombre({ query });
}

/* =========================
   Ticket / MesaComandaModal
========================= */

export async function mesasRemoveOnePendingDetalle(params: {
    idComanda: string;
    idProducto: string;
}): Promise<void> {
    const idComanda = params.idComanda.trim();
    const idProducto = params.idProducto.trim();
    if (!idComanda || !idProducto) return;

    await commands.removeOnePendingDetalle({ id_comanda: idComanda, id_producto: idProducto });
}

export async function mesasDeleteDetalle(idDetalle: string): Promise<void> {
    const id = idDetalle.trim();
    if (!id) return;

    await commands.deleteDetalle({ id_detalle: id });
}

export async function mesasUpdateDetalleNota(params: {
    idDetalle: string;
    nota: string | null;
}): Promise<void> {
    const id = params.idDetalle.trim();
    if (!id) return;

    await commands.updateDetalleNota({ id_detalle: id, nota: params.nota ?? undefined });
}

/** Lo que se pide distinto en la línea; vacío la deja como el producto. Vale también para barra. */
export async function mesasUpdateDetalleIngredientes(params: {
    idDetalle: string;
    cambios: CambioIngredienteInput[];
}): Promise<void> {
    const id = params.idDetalle.trim();
    if (!id) return;

    await commands.updateDetalleIngredientes({ id_detalle: id, cambios: params.cambios });
}

export async function mesasCobrarDetalles(params: {
    idComanda: string;
    metodo: "Tarjeta" | "Efectivo";
    tipo: "TOTAL" | "FRACCIONADO";
    detalleIds: string[];
    /**
     * FISCAL-02: datos del cliente cuando pide **factura completa** (`F1`), o cuando el importe pasa
     * del límite de la simplificada y entonces no hay alternativa.
     *
     * Ausente = ticket normal (`F2`). Si el importe pasa del límite y no va, el backend rechaza el
     * cobro con `factura_completa_requerida` y la pantalla abre `DatosFiscalesModal`.
     */
    destinatario?: DestinatarioInput;
    /** SYN-INC-05: «Cobrar todo»: no entra si queda algo por cobrar fuera de `detalleIds`. */
    todo?: boolean;
    /** Devuelve el id del pago (cadena vacía si no había nada que cobrar): con él se pide su ticket. */
}): Promise<string> {
    const idComanda = params.idComanda.trim();
    const detalleIds = params.detalleIds.map((x) => x.trim()).filter((s) => s.length > 0);

    if (!idComanda || !detalleIds.length) return "";

    const args: MesasCobrarDetallesInput = {
        id_comanda: idComanda,
        metodo: params.metodo,
        tipo: params.tipo,
        detalle_ids: detalleIds,
        // REV-17: quién cobra lo pone el backend desde la sesión (SEC-01).
        destinatario: params.destinatario,
        todo: params.todo ?? false,
    };
    return commands.cobrarDetalles(args);
}

/* =========================
   Cocina / KitchenBoard
========================= */

export async function cocinaSetLineaEstado(params: {
    idDetalle: string;
    idUsuarioCocinero: string | null;
    estado: "PENDIENTE" | "PREPARADO";
}): Promise<void> {
    const idDetalle = params.idDetalle.trim();
    const idUsuarioCocinero = params.idUsuarioCocinero?.trim() ?? "";

    if (!idDetalle || !idUsuarioCocinero) return;

    await commands.kitchenSetLineState({
            id_detalle: idDetalle,
            estado: params.estado,
            id_usuario_cocinero: idUsuarioCocinero,
        });
}
