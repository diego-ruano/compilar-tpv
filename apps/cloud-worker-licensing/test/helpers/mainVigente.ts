// test/helpers/mainVigente.ts
//
// AUD-02 · Quién es la Main, para las pruebas que fabrican su sesión sin saludar.
//
// El hub sólo deja actuar como Main a la sesión `tpv` del dispositivo que nombra su tabla
// `_Main_Vigente` (`tenantHub.main.ts`), y la tabla la pone al día una lectura de la base central.
// Una prueba que adosa a mano el attachment de una Main autenticada no ha pasado por esa lectura:
// esto la hace, con un doble de la base central que contesta lo mismo, para que ninguna
// comprobación posterior salga a la red. Lo que pasa cuando la licencia cambia está en
// `mainDesplazadaSocket.test.ts`.

import { aplicarLectura, empezarLectura } from "../../src/durableObjects/tenantHub.main";

export function laMainEs(hub: any, deviceId: string): void {
	hub.mainEnCentral = async () => deviceId;
	const storage = hub.state.storage;
	aplicarLectura(storage, empezarLectura(storage), deviceId);
}
