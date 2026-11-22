// src/features/clientes/fichaFiscal.ts
//
// FISCAL-02 · La ficha del cliente en el formulario de la factura completa: qué fichas casan con lo
// que se teclea, con qué datos se rellena, y qué se guarda en la ficha después de facturar.
//
// Es lógica sin pantalla a propósito: el formulario (`DatosFiscalesModal`) la usa y
// `test/fichaFiscal.test.ts` la prueba sin montar nada. Lo que se guarda se decide aquí, pero se
// guarda DESPUÉS de cobrar o de emitir la factura (`trasFacturar`), y si falla sólo se avisa: nada
// de lo que rodea a la factura puede impedir el cobro ni deshacerlo.

import type { ClienteParaFactura, DestinatarioInput, GuardarDatosFiscalesInput } from "@tpv/contracts";

import { contiene, textoABuscar } from "../../shared/lib/busqueda";
import { nifValido } from "../../shared/ticket/nif";

export type { ClienteParaFactura };

/** Cuántas fichas se ofrecen como mucho en el buscador y en las sugerencias. */
const MAX_FICHAS_OFRECIDAS = 6;

/**
 * El NIF como lo guarda el backend (`normalizar_nif`): sin blancos en los extremos, las letras ASCII
 * en mayúsculas y sin guiones ni espacios. Es lo que se compara para saber si es el de una ficha.
 */
export function normalizarNif(nif: string | null | undefined): string {
    return (nif ?? "")
        .trim()
        .replace(/[a-z]/g, (c) => c.toUpperCase())
        .replace(/[- ]/g, "");
}

/** Un texto de la ficha para comparar: sin blancos en los extremos ni espacios repetidos. */
function comparable(t: string | null | undefined): string {
    return (t ?? "").trim().replace(/\s+/g, " ");
}

/** Lo que se busca de una ficha: su nombre, su razón social y su NIF. */
function textosDe(f: ClienteParaFactura): (string | null)[] {
    return [f.nombre, f.razon_social, f.nif];
}

/** El orden en que se ofrecen: primero las que ya tienen NIF (se puede facturar con ellas). */
function primeroConNif(a: ClienteParaFactura, b: ClienteParaFactura): number {
    return Number(!a.nif) - Number(!b.nif);
}

/**
 * «Elegir cliente»: las fichas cuyo nombre, razón social o NIF contienen lo tecleado, sin acentos
 * ni mayúsculas (`textoABuscar`/`contiene`). Vacío, ninguna.
 */
export function buscarFichas(
    fichas: readonly ClienteParaFactura[],
    texto: string,
    max = MAX_FICHAS_OFRECIDAS,
): ClienteParaFactura[] {
    const s = textoABuscar(texto);
    if (!s) return [];
    // El NIF se busca también sin guiones ni espacios: «b-1234» encuentra «B12345674».
    const nif = normalizarNif(texto).toLowerCase();
    return fichas
        .filter((f) => contiene(s, ...textosDe(f)) || (nif.length > 0 && contiene(nif, f.nif)))
        .sort(primeroConNif)
        .slice(0, max);
}

/** La ficha cuyo NIF es éste, si el NIF está completo y es válido. La más reciente no se sabe aquí: la primera. */
export function fichaConNif(
    fichas: readonly ClienteParaFactura[],
    nif: string,
): ClienteParaFactura | null {
    if (!nifValido(nif)) return null;
    const n = normalizarNif(nif);
    return fichas.find((f) => f.nif != null && normalizarNif(f.nif) === n) ?? null;
}

/**
 * Las fichas que se sugieren mientras se teclea el nombre: las que lo contienen en el nombre o en la
 * razón social. Hacen falta tres letras, para no sugerir media lista con la primera.
 */
export function sugerenciasPorNombre(
    fichas: readonly ClienteParaFactura[],
    nombre: string,
    excepto: string | null = null,
    max = 3,
): ClienteParaFactura[] {
    const s = textoABuscar(nombre);
    if (!s || [...s].length < 3) return [];
    return fichas
        .filter((f) => f.id_cliente !== excepto && contiene(s, f.nombre, f.razon_social))
        .sort(primeroConNif)
        .slice(0, max);
}

/** Con qué se rellena el formulario al elegir una ficha. Sin razón social, su nombre. */
export function datosDeFicha(f: ClienteParaFactura): DestinatarioInput {
    return {
        nombre_razon: f.razon_social ?? f.nombre,
        nif: f.nif ?? "",
        domicilio: f.direccion_fiscal ?? undefined,
    };
}

/** Lo que hay escrito en el formulario. */
export type CamposFiscales = { nombre: string; nif: string; domicilio: string };

/**
 * Con qué queda el formulario al elegir una ficha. La primera vez, sobre lo escrito a mano, lo que
 * la ficha no tiene se deja como estaba (se ha tecleado el NIF y se elige la ficha sin él para
 * ponérselo). Si ya había otra ficha elegida, se sustituye todo: lo que la ficha no tiene se vacía,
 * para no facturar con el nombre de una y el NIF de otra.
 */
export function rellenoConFicha(
    actual: CamposFiscales,
    f: ClienteParaFactura,
    habiaOtra: boolean,
): CamposFiscales {
    const d = datosDeFicha(f);
    const domicilio = d.domicilio ?? "";
    if (habiaOtra) return { nombre: d.nombre_razon, nif: d.nif, domicilio };
    return {
        nombre: d.nombre_razon,
        nif: d.nif || actual.nif,
        domicilio: domicilio || actual.domicilio,
    };
}

/**
 * En qué ficha se guardan los datos con los que se factura: la elegida, salvo que el NIF sea el de
 * otra ficha (entonces, ésa) o distinto del que la elegida ya tenía (entonces, ninguna: se da de
 * alta otra). Es la comida de empresa reservada por una persona: se factura a la empresa, y la ficha
 * de quien reservó no puede quedarse con el NIF de la empresa.
 */
export function fichaDestino(
    elegida: ClienteParaFactura | null,
    coincidente: ClienteParaFactura | null,
    nif: string,
): ClienteParaFactura | null {
    if (elegida == null) return coincidente;
    if (coincidente != null && coincidente.id_cliente !== elegida.id_cliente) return coincidente;
    const suyo = normalizarNif(elegida.nif);
    if (suyo && suyo !== normalizarNif(nif)) return null;
    return elegida;
}

/** ¿Tiene la ficha lo necesario para empezar el formulario con ella? (el NIF y un nombre) */
export function sirveParaFacturar(f: ClienteParaFactura | null | undefined): f is ClienteParaFactura {
    return f != null && f.nif != null && nifValido(f.nif);
}

/**
 * ¿Son éstos los datos que ya tiene la ficha? El nombre se compara con el que da la ficha al
 * rellenar (`datosDeFicha`): su razón social o, si no tiene, su nombre. Si no, una ficha sin razón
 * social nunca tendría «los mismos datos» que ella misma.
 */
export function mismosDatos(d: DestinatarioInput, f: ClienteParaFactura): boolean {
    return (
        normalizarNif(d.nif) === normalizarNif(f.nif) &&
        comparable(d.nombre_razon) === comparable(datosDeFicha(f).nombre_razon) &&
        comparable(d.domicilio) === comparable(f.direccion_fiscal)
    );
}

/**
 * La casilla «Guardar en la ficha del cliente» sale marcada si los datos son nuevos (no hay ficha)
 * o distintos de los que tiene.
 */
export function guardarPorDefecto(d: DestinatarioInput, ficha: ClienteParaFactura | null): boolean {
    return ficha == null || !mismosDatos(d, ficha);
}

/**
 * Qué se guarda en la ficha: con la ficha elegida (o la que tiene ese NIF), sus tres datos fiscales;
 * sin ninguna, el backend busca la del NIF y, si no la hay, da de alta una con la razón social de
 * nombre (`guardar_datos_fiscales`).
 */
export function planDeGuardado(
    d: DestinatarioInput,
    ficha: ClienteParaFactura | null,
): GuardarDatosFiscalesInput {
    const domicilio = (d.domicilio ?? "").trim();
    return {
        id_cliente: ficha?.id_cliente ?? null,
        nif: normalizarNif(d.nif),
        razon_social: d.nombre_razon.trim(),
        direccion_fiscal: domicilio || null,
    };
}

/**
 * Factura y, SÓLO si ha salido bien, guarda los datos en la ficha. `facturar` devuelve si el cobro o
 * la emisión han entrado; su resultado no depende del guardado, que va después, sin esperarlo, y que
 * no puede tirar el cobro aunque lance (`guardar` avisa él mismo de su fallo).
 */
export async function trasFacturar(
    facturar: () => Promise<boolean>,
    plan: GuardarDatosFiscalesInput | null,
    guardar: (plan: GuardarDatosFiscalesInput) => void,
): Promise<boolean> {
    const ok = await facturar();
    if (ok && plan) {
        try {
            guardar(plan);
        } catch {
            // `guardar` avisa de su propio fallo; aquí sólo se protege el resultado del cobro.
        }
    }
    return ok;
}
