// src/features/configuracion/hooks/useBorrador.ts
//
// Un borrador de ajustes sobre lo guardado (`actual`), con la regla de CFG-INC-01: lo que llega de
// otro equipo entra en los campos que no se han tocado, y al guardar se manda sólo lo cambiado
// (`../borrador.ts`). El de Negocio tiene el suyo (`useBusinessDraft`), por el texto del IVA.
import { useState } from "react";

import { cambiosDe, camposDistintos, rebasarBorrador, type Choques } from "../borrador";

type Estado<T> = { base: T; borrador: T; choques: Choques<T> };

export function useBorrador<T extends object>(actual: T, campos: readonly (keyof T)[]) {
	const [estado, setEstado] = useState<Estado<T>>(() => ({ base: actual, borrador: actual, choques: {} }));

	let e = estado;
	if (camposDistintos(estado.base, actual, campos).length > 0) {
		const r = rebasarBorrador(estado.borrador, estado.base, actual, campos, estado.choques);
		e = { base: actual, borrador: r.borrador, choques: r.choques };
		setEstado(e);
	}

	const tocados = camposDistintos(e.borrador, e.base, campos);
	const choques: Choques<T> = {};
	for (const k of tocados) if (k in e.choques) choques[k] = e.choques[k];

	return {
		borrador: e.borrador,
		base: e.base,
		dirty: tocados.length > 0,
		cambios: cambiosDe(e.borrador, e.base, campos),
		choques,
		cambiar: (parche: Partial<T>) => setEstado((s) => ({ ...s, borrador: { ...s.borrador, ...parche } })),
		descartar: () => setEstado({ base: actual, borrador: actual, choques: {} }),
	};
}
