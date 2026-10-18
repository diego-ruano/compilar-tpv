// El plano de un salón tal como se dibuja: la Main lo saca de su base y el widget de reservas web
// de `GET /v1/publico/reservas/:clave/plano`. Sólo la forma; el estado de cada mesa (ocupada,
// libre, elegida…) lo decide quien dibuja y llega como `AspectoMesa`.

export type FormaMesa = "rect" | "rounded" | "circle" | string;

export type MesaPlano = {
    id: string;
    name: string;
    x: number;
    y: number;
    width: number;
    height: number;
    radius: number | null;
    seats: number;
    shape: FormaMesa;
};

export type SalonPlano = {
    id: string;
    name: string;
    room: { points: number[] };
    tables: MesaPlano[];
};

/** Cómo se pinta una mesa. Konva necesita colores literales: nada de variables CSS. */
export type AspectoMesa = {
    relleno: string;
    borde: string;
    grosorBorde: number;
    texto: string;
    subtexto: string;
    etiqueta: string;
    subetiqueta: string;
    /** Se puede pulsar. Sin esto, la mesa no responde. */
    pulsable: boolean;
};

export type Vista = { x: number; y: number; scale: number };
