// El registro de una tanda: cada petición HTTP, cada saludo de socket y cada operación de la Main,
// con su tiempo, su resultado y lo que pesó. Se escribe a la vez en memoria y en `peticiones.jsonl`,
// así que una tanda que se corta deja su rastro hasta el último paso.
//
// También lleva los frenos: un generador mal hecho no puede quedarse martilleando. Cada 401/403 manda
// un evento a Axiom y cada 5xx otro a Sentry, así que se para enseguida. La limpieza queda fuera de
// los frenos y del tope: retirar el negocio de pruebas no puede quedarse a medias por ellos.

import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export class FrenoDeSeguridad extends Error {}

/** Ctrl+C: la tanda deja de avanzar y pasa directa a limpiar. */
export class Cancelado extends Error {
  constructor() {
    super("cancelada con Ctrl+C");
  }
}

export class Registro {
  /**
   * @param {object} o
   * @param {string} o.carpeta  dónde se escribe `peticiones.jsonl`
   * @param {number} o.tope     máximo de peticiones (HTTP + mensajes de socket) antes de la limpieza
   */
  constructor({ carpeta, tope }) {
    this.fichero = join(carpeta, "peticiones.jsonl");
    writeFileSync(this.fichero, "");
    this.tope = tope;
    this.entradas = [];
    this.fase = "preparacion";
    /** El paso en curso: el proxy local le atribuye las filas de Turso que se lean o escriban. */
    this.etapa = "arranque";
    this.http = 0;
    this.errores5xx = 0;
    this.socket = { enviados: 0, pings: 0, recibidos: {} };
    this.avisos = [];
    this.sinDisco = false;
  }

  get enLimpieza() {
    return this.fase === "limpieza";
  }

  /** Apunta una petición o una operación terminada y aplica los frenos. */
  anotar(entrada) {
    const e = { n: this.entradas.length + 1, fase: this.fase, etapa: this.etapa, ...entrada };
    this.entradas.push(e);
    try {
      appendFileSync(this.fichero, JSON.stringify(e) + "\n");
    } catch (error) {
      // Sin disco se sigue: lo que importa es llegar a retirar el negocio.
      if (!this.sinDisco) this.avisar(`No se pudo escribir ${this.fichero}: ${error.message}`);
      this.sinDisco = true;
    }
    if (e.http) this.http += 1;
    if (this.enLimpieza) return e;
    // `seReintenta`: un reloj desfasado se corrige con la cabecera `Date` y se repite una vez,
    // como hace la app (`reloj.rs`); sólo frena si vuelve a fallar.
    if ((e.status === 401 || e.status === 403) && !e.seReintenta) {
      throw new FrenoDeSeguridad(
        `${e.metodo} ${e.ruta} respondió ${e.status} (${e.error ?? "sin código"}): se para la tanda para no repetir el fallo.`,
      );
    }
    if (e.status >= 500) {
      this.errores5xx += 1;
      // En la preparación nada puede fallar; en la carga se tolera uno para ver si es puntual.
      const limite = this.fase === "carga" ? 2 : 1;
      if (this.errores5xx >= limite) {
        throw new FrenoDeSeguridad(`${e.metodo} ${e.ruta} respondió ${e.status} (${e.error ?? "sin código"}): demasiados errores del servidor.`);
      }
    }
    return e;
  }

  /** Cuenta un mensaje enviado por un socket. El ping exacto lo contesta el edge y no se factura. */
  mensajeEnviado(esPing) {
    if (esPing) {
      this.socket.pings += 1;
      return;
    }
    this.comprobarTope();
    this.socket.enviados += 1;
  }

  mensajeRecibido(tipo) {
    this.socket.recibidos[tipo] = (this.socket.recibidos[tipo] ?? 0) + 1;
  }

  /** Antes de cada envío: nada sale si la tanda ya ha gastado lo que se le permite. */
  comprobarTope() {
    if (this.enLimpieza) return;
    if (this.http + this.socket.enviados >= this.tope) {
      throw new FrenoDeSeguridad(`Se ha llegado al tope de ${this.tope} peticiones de la tanda.`);
    }
  }

  avisar(texto) {
    this.avisos.push(texto);
    console.log(`  ⚠ ${texto}`);
  }
}
