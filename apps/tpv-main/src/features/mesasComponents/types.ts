import type { RoomPoly as RoomDto, SalonOut, TableOut } from "@tpv/contracts";

// El lienzo trabaja con coordenadas finitas. El resto de la forma es el contrato generado.
export type RoomPoly = Omit<RoomDto, "points"> & { points: NonNullable<RoomDto["points"][number]>[] };
export type TableShape = TableOut["shape"];
export type Table = TableOut;
export type Salon = Omit<SalonOut, "room"> & { room: RoomPoly };
