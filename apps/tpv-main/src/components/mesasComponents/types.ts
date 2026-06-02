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

// ──────────────────────────────────────────────────────────────
// Metas de mesa + reservas (para mapa y MesaComandaModal)
// ──────────────────────────────────────────────────────────────

export type MesaEstado = "LIBRE" | "PENDIENTE";

export type ReservaEstado = "PROXIMA" | "ACTIVA";
export type ReservaMesaMeta = {
    estado: ReservaEstado;
    idReserva: number;
    clienteNombre: string;
    diaYMD: string;
    hora: string;
    minutosPara: number; // puede ser negativo si ya pasó la hora
};

export type MesaMeta =
    | {
          estado: MesaEstado;
          reserva: null;
      }
    | {
          estado: MesaEstado;
          reserva: ReservaMesaMeta;
      };
