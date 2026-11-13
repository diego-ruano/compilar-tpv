// Los ajustes viven en tres stores de Zustand, no en React Query: cuando otro equipo cambia una de
// sus tablas se relee el store de esa tabla, no los tres. En una Handy cada relectura es una
// petición a la nube.
import { useBusinessSettings } from "../stores/useBusinessSettings";
import { useContactSettings } from "../stores/useContactSettings";
import { useTicketSettings } from "../stores/useTicketSettings";
import { ajustesPorTablas, type TablaDeAjustes } from "./syncStatements";

const STORE_DE: Record<TablaDeAjustes, { getState: () => { init: () => Promise<void> } }> = {
	business_settings: useBusinessSettings,
	ticket_settings: useTicketSettings,
	contact_settings: useContactSettings,
};

/**
 * Relee los ajustes de las tablas que han cambiado. `null` es «no se sabe qué ha cambiado» —una
 * conexión nueva de la Handy, un cambio que Rust no ha podido clasificar—, y entonces los tres.
 */
export function recargarAjustes(tablas: string[] | null): void {
	for (const tabla of ajustesPorTablas(tablas)) void STORE_DE[tabla].getState().init();
}
