import { commands } from "@tpv/client";
import type { DestinatarioInput, VrCobrarFraccionadoInput } from "@tpv/contracts";
import { deCentimos } from "../../shared/lib/dinero";

const prefijo = "tpv:ventaRapida:pendingCobros:v1:";
/** AUD-06 · Donde se apartan los que no consta que sean de esta base. Detrás va la clave que tenían. */
const prefijoDesconocidos = "tpv:ventaRapida:pendingCobros:desconocidos:";

/** Única lectura del antiguo formato. Un dato incompleto se conserva para poder recuperarlo. */
export function leerCobroLegado(valor: unknown): VrCobrarFraccionadoInput {
    if (!valor || typeof valor !== "object") throw new Error("Cobro antiguo sin datos");
    const v = valor as Record<string, unknown>;
    const id_pago = typeof v.idPago === "string" ? v.idPago : "";
    const id_comanda = typeof v.idComanda === "string" ? v.idComanda : "";
    const detalles = Array.isArray(v.detalleIds) && v.detalleIds.every(d => typeof d === "string" && d.length > 0)
        ? v.detalleIds as string[]
        : Array.isArray(v.ticketItemIds) ? v.ticketItemIds.map(d => typeof d === "string" && d.startsWith("detalle-") ? d.slice(8) : "") : [];
    if (!id_pago || !id_comanda || !detalles.length || detalles.some(d => !d) ||
        (v.metodo !== "tarjeta" && v.metodo !== "efectivo") || typeof v.importeTotal !== "number" ||
        !Number.isSafeInteger(v.importeTotal) || v.importeTotal < 0) throw new Error("Cobro antiguo incompleto; se ha conservado su copia");
    let destinatario: DestinatarioInput | null = null;
    if (v.destinatario != null) {
        const d = v.destinatario as Record<string, unknown>;
        if (typeof d.nombre_razon !== "string" || !d.nombre_razon.trim() || typeof d.nif !== "string" || !d.nif.trim() ||
            (d.domicilio != null && typeof d.domicilio !== "string")) throw new Error("Factura antigua incompleta; se ha conservado su copia");
        destinatario = { nombre_razon: d.nombre_razon, nif: d.nif, domicilio: d.domicilio as string | null | undefined };
    }
    return { id_pago, id_comanda, metodo: v.metodo === "tarjeta" ? "Tarjeta" : "Efectivo", detalles,
        importe_total: deCentimos(v.importeTotal), destinatario };
}

/**
 * AUD-06 · ¿Es de esta base? La clave antigua no dice de qué negocio era el cobro, y el navegador
 * se queda aunque la licencia del equipo pase a otro negocio. Lo dice su ticket: tiene que estar en
 * esta base con todas las líneas que cobra (los identificadores son únicos: los de otro negocio no
 * están).
 */
async function esDeEstaBase(cobro: VrCobrarFraccionadoInput): Promise<boolean> {
    const lineas = await commands.vrGetLineasComanda({ id_comanda: cobro.id_comanda });
    const aqui = new Set(lineas.map((l) => l.ID_Detalle));
    return cobro.detalles.every((d) => aqui.has(d));
}

/** Lo aparta, sin borrarlo, junto a los demás desconocidos de la misma clave. */
function apartarDesconocido(almacen: Storage, clave: string, valor: unknown): void {
    const destino = prefijoDesconocidos + clave;
    let apartados: unknown[] = [];
    try {
        const ya: unknown = JSON.parse(almacen.getItem(destino) ?? "[]");
        if (Array.isArray(ya)) apartados = ya;
    } catch { /* uno ilegible se sustituye: lo que había ya no se podía leer */ }
    almacen.setItem(destino, JSON.stringify([...apartados, valor]));
}

/**
 * Pasa a SQLite los cobros antiguos de esta base. Los que no se puede comprobar que lo sean se
 * apartan como desconocidos en el propio `localStorage`, sin importarlos ni borrarlos (AUD-06).
 */
export async function importarCobrosLegados(almacen: Storage = window.localStorage): Promise<void> {
    const claves = Array.from({ length: almacen.length }, (_, i) => almacen.key(i)).filter((k): k is string => !!k?.startsWith(prefijo));
    let primerError: unknown;
    for (const clave of claves) {
        let valor: unknown;
        try {
            valor = JSON.parse(almacen.getItem(clave) ?? "[]");
            if (!Array.isArray(valor)) throw new Error("La copia antigua de cobros no se puede leer");
        } catch (e) { primerError ??= e; continue; }
        if (!Array.isArray(valor)) continue;
        const restantes = [...valor];
        let indice = 0;
        while (indice < restantes.length) {
            try {
                const cobro = leerCobroLegado(restantes[indice]);
                if (await esDeEstaBase(cobro)) await commands.vrGuardarCobroPendiente(cobro);
                // Primero se escribe aparte y después se quita: si falla, sobra una copia, no falta.
                else apartarDesconocido(almacen, clave, restantes[indice]);
            }
            catch (e) { primerError ??= e; ++indice; continue; }
            restantes.splice(indice, 1);
            // Se borra únicamente después de la confirmación duradera de SQLite.
            try {
                if (restantes.length) almacen.setItem(clave, JSON.stringify(restantes));
                else almacen.removeItem(clave);
            } catch (e) { primerError ??= e; break; }
        }
    }
    if (primerError !== undefined) throw primerError;
}
