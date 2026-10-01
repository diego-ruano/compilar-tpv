// src/lib/ids.ts
//
// RI-59 — los identificadores de negocio que genera el worker son **UUIDv7**, como los de la Main
// (`tpv_infra_sqlite::util::new_id`, `Uuid::now_v7()`) y como promete la cabecera de
// `0001_inicial.sql`.
//
// No es estética: hay consultas que ordenan por la clave como «lo más reciente» (`Detalle_Comanda`
// no tiene otra columna que lo diga, y «quitar una unidad» borra la última línea por su id). Con el
// `crypto.randomUUID()` de antes —v4, aleatorio— una fila creada desde una Handy caía en cualquier
// sitio de ese orden.
//
// Formato (RFC 9562 §5.7): 48 bits de milisegundos Unix, la versión (7), 12 bits que aquí son un
// contador, la variante (10) y 62 bits aleatorios. El texto sale en minúsculas con guiones, igual que
// el `to_string()` de Rust, para que los dos ordenen igual como TEXT.
//
// ## Por qué hay un contador
//
// En workerd `Date.now()` no avanza mientras el código no hace E/S, así que dos ids pedidos en la
// misma petición comparten milisegundo casi siempre. Con 12 bits aleatorios su orden sería otra vez
// el azar. El contador (método 1 del §6.2 de la RFC) los mantiene crecientes: arranca en un valor
// aleatorio con el bit alto a 0 en cada milisegundo nuevo y sube en cada id del mismo milisegundo; si
// se desborda, se toma prestado el siguiente milisegundo.
//
// Es estado de módulo, y eso se evita en este worker porque se comparte entre tenants. Aquí da igual:
// lo único que guarda es «el último milisegundo usado», que no dice nada de nadie, y perderlo (al
// reciclarse el isolate) sólo significa volver a empezar desde el reloj.

let ultimoMs = 0;
let contador = 0;

const HEX: string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

/** Un UUIDv7 nuevo, creciente respecto a los anteriores de este isolate. */
export function nuevoId(): string {
	const ahora = Date.now();
	if (ahora > ultimoMs) {
		ultimoMs = ahora;
		contador = Math.floor(Math.random() * 0x800);
	} else if (contador < 0xfff) {
		contador += 1;
	} else {
		ultimoMs += 1;
		contador = 0;
	}

	const b = new Uint8Array(16);
	crypto.getRandomValues(b.subarray(8));

	// 48 bits de milisegundos, big-endian. No caben en las operaciones de bits de 32 de JS: se
	// parten en la mitad alta (16 bits) y la baja (32).
	const alto = Math.floor(ultimoMs / 0x1_0000_0000);
	const bajo = ultimoMs >>> 0;
	b[0] = (alto >>> 8) & 0xff;
	b[1] = alto & 0xff;
	b[2] = (bajo >>> 24) & 0xff;
	b[3] = (bajo >>> 16) & 0xff;
	b[4] = (bajo >>> 8) & 0xff;
	b[5] = bajo & 0xff;
	b[6] = 0x70 | (contador >>> 8);
	b[7] = contador & 0xff;
	b[8] = (b[8] & 0x3f) | 0x80;

	let s = "";
	for (let i = 0; i < 16; i++) {
		if (i === 4 || i === 6 || i === 8 || i === 10) s += "-";
		s += HEX[b[i]];
	}
	return s;
}
