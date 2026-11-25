// test/helpers/mainVigente.ts
//
// AUD-02 · Quién es la Main, para las pruebas que fabrican su sesión sin saludar.
//
// El hub sólo deja actuar como Main a la sesión `tpv` del dispositivo que nombra su tabla
// `_Main_Vigente` (`tenantHub.main.ts`), y la tabla la pone al día una lectura de la base central.
// Una prueba que adosa a mano el attachment de una Main autenticada no ha pasado por esa lectura:
// esto la hace como si acabara de volver, y deja dicho lo mismo en la licencia de la base central de
// verdad que tiene puesta el hub, para que lo que el hub le pregunte después (al saludar una Main,
// cada minuto, el `last_seen`) lea lo mismo. Lo que pasa cuando la licencia cambia está en
// `mainDesplazadaSocket.test.ts`.

import { centralDePrueba, filasDe, negocioEnLaCentral, type CentralDePrueba } from "./central";
import { ponerLaCentral } from "./hub";
import { aplicarLectura, empezarLectura } from "../../src/durableObjects/tenantHub.main";

/** La tabla del hub dice que `deviceId` es la Main, como una lectura de la central que acaba de volver. */
export function laTablaDiceQueLaMainEs(hub: any, deviceId: string): void {
	const storage = hub.state.storage;
	aplicarLectura(storage, empezarLectura(storage), deviceId);
}

/**
 * La licencia del negocio `tenantId` en la central `central` (que el negocio ya tiene que tener:
 * `negocioEnLaCentral`) pasa a `deviceId`, como un traslado. La tabla del hub no se entera.
 */
export async function laLicenciaDiceQueLaMainEs(
	central: Pick<CentralDePrueba, "stub">,
	tenantId: string,
	deviceId: string,
): Promise<void> {
	const cambiadas = await filasDe(
		central,
		`UPDATE licenses SET main_device_id = ?, updated_at_ms = ? WHERE tenant_id = ? RETURNING license_id;`,
		deviceId,
		Date.now(),
		tenantId,
	);
	if (cambiadas.length === 0) throw new Error(`El negocio ${tenantId} no tiene licencia en la central de la prueba.`);
}

/** `deviceId` pasa a ser la Main del negocio `tenantId`: en su licencia de la central `central` y en la tabla del hub. */
export async function laMainEs(
	hub: any,
	central: Pick<CentralDePrueba, "stub">,
	tenantId: string,
	deviceId: string,
): Promise<void> {
	await laLicenciaDiceQueLaMainEs(central, tenantId, deviceId);
	laTablaDiceQueLaMainEs(hub, deviceId);
}

/**
 * Una base central nueva para el hub, con el negocio `tenantId` dado de alta, `main` como su Main y
 * sus `dispositivos`, y la tabla del hub diciendo lo mismo. Se la deja puesta (`ponerLaCentral`) para
 * lo que le quede de vida a esta instancia: el hub de una prueba es sólo suyo.
 */
export async function centralConLaMain(
	hub: any,
	tenantId: string,
	main: string,
	dispositivos: { deviceId: string; rol: "tpv" | "handy" }[] = [{ deviceId: main, rol: "tpv" }],
): Promise<CentralDePrueba> {
	const central = await centralDePrueba();
	await negocioEnLaCentral(central, { tenantId, main, dispositivos });
	ponerLaCentral(hub, central);
	laTablaDiceQueLaMainEs(hub, main);
	return central;
}
