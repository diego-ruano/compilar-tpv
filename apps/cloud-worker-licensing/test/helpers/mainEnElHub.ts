// test/helpers/mainEnElHub.ts
//
// Una Main y una Handy conectadas a un TenantHub de verdad, para probar lo que la Main sube por el
// socket (`apply`, `apply_lote`) contra el motor real: la base del negocio aprovisionada como en
// producción (sus migraciones, sus claves foráneas), la sesión de la Main en su attachment y la
// tabla de quién es la Main puesta al día. La base central no existe: lo que la toca se sustituye.
//
// Todo corre dentro de la invocación del DO que lo monta (`enElHub`): los sockets viven lo que ella.

import { laMainEs } from "./mainVigente";

export type OpDelOutbox = {
	opId: string;
	commandName: string;
	command: { type: string; payload: { steps: { kind: string; sql: string; args: unknown[] }[] } };
	clientNow?: string;
};

/** Una operación tal como la manda la Main (`replicacion.rs::operacion`): sus sentencias, en orden. */
export function opDelOutbox(
	opId: string,
	sentencias: { sql: string; args?: unknown[] }[],
	commandName = "main_op",
): OpDelOutbox {
	return {
		opId,
		commandName,
		command: {
			type: "tenantDb.transaction",
			payload: { steps: sentencias.map((s) => ({ kind: "execute", sql: s.sql, args: s.args ?? [] })) },
		},
	};
}

type Extremo = {
	/** El lado del DO: el que se le pasa a `webSocketMessage`. */
	servidor: WebSocket;
	/** Todo lo que el DO le ha mandado, en orden. */
	recibidos: any[];
	/** El primer mensaje que llegue a partir de ahora y cumpla `casa`. */
	esperar: (casa: (m: any) => boolean, ms?: number) => Promise<any>;
};

export type MainEnElHub = {
	sql: any;
	main: Extremo;
	handy: Extremo;
	/** Los eventos de salud que habrían ido a Axiom. */
	eventos: { name: string; [campo: string]: unknown }[];
	/** Manda un `apply_lote` por el socket de la Main y devuelve su acuse. */
	mandarLote: (ops: OpDelOutbox[], extra?: Record<string, unknown>) => Promise<any>;
	/** Manda un `apply` suelto y devuelve su acuse. */
	mandarApply: (op: OpDelOutbox) => Promise<any>;
	/** Los `change` que el hub ha difundido, en orden. */
	difundidos: () => { opId: string; seq: number }[];
	/** El log de la nube, en orden de `Seq`. */
	log: () => { opId: string; seq: number }[];
};

function abrir(hub: any, tenant: string, deviceId: string, role: "tpv" | "handy", recovering: boolean): Extremo {
	const par = new WebSocketPair();
	hub.state.acceptWebSocket(par[1], [deviceId]);
	par[1].serializeAttachment({
		tenantId: tenant,
		deviceId,
		role,
		authed: true,
		pubkeyB64: null,
		challenge: null,
		recovering,
	});
	const recibidos: any[] = [];
	const esperando: { casa: (m: any) => boolean; entregar: (m: any) => void }[] = [];
	par[0].accept();
	par[0].addEventListener("message", (ev: MessageEvent) => {
		const m = JSON.parse(String(ev.data));
		recibidos.push(m);
		const i = esperando.findIndex((e) => e.casa(m));
		if (i >= 0) esperando.splice(i, 1)[0].entregar(m);
	});
	const esperar = (casa: (m: any) => boolean, ms = 5_000) =>
		new Promise<any>((resolver, rechazar) => {
			const plazo = setTimeout(() => rechazar(new Error("no llegó el mensaje esperado")), ms);
			esperando.push({
				casa,
				entregar: (m) => {
					clearTimeout(plazo);
					resolver(m);
				},
			});
		});
	return { servidor: par[1], recibidos, esperar };
}

let lotes = 0;

/**
 * Aprovisiona el negocio y conecta su Main (saludando con `recovering`, como toda sesión de la Main)
 * y una Handy, que es quien ve lo que se difunde.
 */
export async function montarMainEnElHub(
	hub: any,
	tenant: string,
	opciones: { main?: string; recovering?: boolean } = {},
): Promise<MainEnElHub> {
	const idMain = opciones.main ?? "main-lote";
	await hub.aprovisionar(tenant);
	// `last_seen` va contra la base central, que aquí no existe y tampoco es lo que se prueba.
	hub.touchLastSeen = async () => {};
	const eventos: MainEnElHub["eventos"] = [];
	hub.emitSyncEvent = (name: string, campos: Record<string, unknown>) => void eventos.push({ name, ...campos });
	laMainEs(hub, idMain);

	// Lo difundido se apunta al salir del hub, no al llegar a la Handy: cada socket entrega a su
	// ritmo, y lo que importa es el orden en que el hub lo manda.
	const difundidos: { opId: string; seq: number }[] = [];
	const difundir = hub.broadcastAuthed.bind(hub);
	hub.broadcastAuthed = (obj: any, salvo?: string) => {
		if (obj?.type === "change") difundidos.push({ opId: String(obj.opId), seq: Number(obj.seq) });
		return difundir(obj, salvo);
	};

	const sql = hub.state.storage.sql;
	const main = abrir(hub, tenant, idMain, "tpv", opciones.recovering ?? true);
	const handy = abrir(hub, tenant, "handy-lote", "handy", false);

	const mandarLote = async (ops: OpDelOutbox[], extra: Record<string, unknown> = {}) => {
		const loteId = `lote-${++lotes}`;
		const acuse = main.esperar((m) => m.type === "apply_lote_ack" && m.loteId === loteId);
		await hub.webSocketMessage(main.servidor, JSON.stringify({ type: "apply_lote", loteId, ops, ...extra }));
		return acuse;
	};
	const mandarApply = async (op: OpDelOutbox) => {
		const acuse = main.esperar((m) => m.type === "apply_ack" && m.opId === op.opId);
		await hub.webSocketMessage(main.servidor, JSON.stringify({ type: "apply", ...op }));
		return acuse;
	};

	return {
		sql,
		main,
		handy,
		eventos,
		mandarLote,
		mandarApply,
		difundidos: () => [...difundidos],
		log: () =>
			sql
				.exec("SELECT Op_Id, Seq FROM Sync_Changes ORDER BY Seq;")
				.toArray()
				.map((f: any) => ({ opId: String(f.Op_Id), seq: Number(f.Seq) })),
	};
}
