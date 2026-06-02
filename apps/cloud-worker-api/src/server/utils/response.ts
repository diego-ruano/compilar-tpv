// src/server/utils/response.ts

export type HeaderBag = Record<string, string>;

export function corsHeaders(req?: Request): HeaderBag {
	const origin = req?.headers.get("origin") || "";

	const allowed = new Set([
		"http://localhost:1420",
		"tauri://localhost",
		"http://tauri.localhost",
	]);

	if (!origin || !allowed.has(origin)) {
		return { Vary: "Origin" };
	}

	return {
		"Access-Control-Allow-Origin": origin,
		"Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
		"Access-Control-Allow-Headers":
			"content-type,authorization,x-device-ts,x-device-sig,x-idempotency-key,x-command-name",
		"Access-Control-Allow-Credentials": "true",
		"Access-Control-Max-Age": "86400",
		Vary: "Origin",
	};
}

export function json(data: any, status = 200, req?: Request) {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
			...corsHeaders(req),
		},
	});
}

export function unauthorized(req: Request, error: string, details?: any) {
	return json({ ok: false, error, details }, 401, req);
}

export function forbidden(req: Request, error: string, details?: any) {
	return json({ ok: false, error, details }, 403, req);
}

export function serverError(req: Request, error: string, details?: any) {
	const d =
		details && typeof details === "object"
			? details
			: { message: String(details ?? "") };

	return json(
		{
			ok: false,
			error,
			details: d,
		},
		500,
		req,
	);
}