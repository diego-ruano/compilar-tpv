import { json } from "../../utils/response";

export function handleHealth() {
	return json({ ok: true, service: "tpv-server", ts: Date.now() });
}