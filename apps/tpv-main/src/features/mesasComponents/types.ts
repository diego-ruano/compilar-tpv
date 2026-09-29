// types.ts

export type RoomPoly = { type: "poly"; points: number[] };
export type TableShape = "rect" | "rounded" | "circle";

export type Table = {
    id: string; // ej: db-mesa-12
    name: string;
    x: number;
    y: number;
    width: number;
    height: number;
    radius?: number;
    seats: number;
    shape: TableShape;
};

export type Salon = {
    id: string;
    name: string;
    room: RoomPoly;
    tables: Table[];
};
