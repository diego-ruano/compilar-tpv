// Copias de seguridad · primer tramo: dejar el equipo con una copia y todo subido.
//
// Va en varios ficheros porque entre tramo y tramo hay que **apagar la aplicación y romperle la
// base**, que es la avería que la pantalla de recuperación existe para resolver. Eso no se puede
// hacer con la app abierta (en Windows SQLite tiene el fichero cogido) ni desde dentro del propio
// recorrido: lo hace `beforeSession` del tramo siguiente, que corre con la app cerrada. Reiniciar
// el equipo es además lo que pasa de verdad.
//
// Arranca sobre el equipo que dejó la venta —estrenado, con la carta, dos cobros facturados y un
// cierre de caja— y con la nube encendida, que es lo que este recorrido necesita por dos motivos:
//
//   · lo que desbloquea el login después de restaurar es la reconciliación, y esa necesita que la
//     nube confirme que los dos lados coinciden;
//   · el tenant es el de la tanda, recién estrenado, así que un catch-up no tiene nada de otras
//     tandas que reproducir contra tablas con `UNIQUE` en el nombre. Eso acabaría en cuarentena, y
//     el desbloqueo (`completar`) se niega con cuarentenas.
//
// Que el equipo llegue con ventas dentro no es un atajo: es lo que tiene un bar el día de la avería,
// y la reconciliación tiene que converger con las tablas del dinero dentro, no sólo con una
// categoría.
//
// Lo que NO se prueba aquí, a propósito: exportar a un USB y volver a importar. Ese viaje ya lo
// cubre `una_copia_sale_del_equipo_y_vuelve` en Rust, y por la interfaz pasa por un diálogo nativo
// de Windows que WebDriver no puede tocar.

import { $, expect } from "@wdio/globals";

import { ficharYEntrar } from "../helpers/arranque.js";
import { CATEGORIA } from "../helpers/copias.js";
import { cargarDotEnv } from "../helpers/entorno.js";
import { PIN } from "../helpers/equipo.js";
import { esperarNubeAlDia } from "../helpers/nube.js";
import { conTexto, irA, leerDeLaApp, pulsar } from "../helpers/ui.js";

cargarDotEnv();

describe("Copias de seguridad · antes de la avería", () => {
    it("1 · vuelve a entrar en el equipo que dejó la venta", async () => {
        await ficharYEntrar(PIN);
    });

    it("2 · crea algo que merezca la pena recuperar", async () => {
        await irA("/Inventario");
        await pulsar("Nueva categoría");

        const nombre = $('//label[contains(., "Nombre")]/following-sibling::input');
        await nombre.waitForDisplayed({ timeout: 20_000 });
        await nombre.setValue(CATEGORIA);
        await pulsar("Guardar categoría");

        await conTexto("p", CATEGORIA).waitForDisplayed({ timeout: 30_000 });
    });

    it("3 · espera a que la nube tenga todo lo de este equipo", async () => {
        // Si se hace la copia con el outbox a medias, lo que se restaura después no coincide con lo
        // que la nube conoce y la reconciliación no converge. Esperar aquí es lo que hace que el
        // segundo tramo sea determinista y no una carrera.
        //
        // Es además lo que CAZÓ SYNC-20: el `UPDATE Business_Settings … Razon_Social` del estreno
        // atascaba el outbox contra un worker cuyo esquema embebido era anterior a FISCAL-01, y con
        // la cola ordenada eso paraba toda la replicación posterior en silencio. Esta espera exige
        // que haya subido TODO lo del equipo —los cobros, las facturas y el arqueo incluidos—, así
        // que vuelve a detectarlo si el esquema del worker desplegado se queda atrás otra vez.
        const salud = await esperarNubeAlDia();
        expect(salud.outbox_pending).toBe(0);
    });

    it("4 · guarda una copia de seguridad desde Configuración", async () => {
        await irA("/Configuracion");
        await pulsar("Licencia");

        await conTexto("div", "Copias de seguridad").waitForDisplayed({ timeout: 30_000 });
        await pulsar("Crear copia ahora");

        // La copia aparece en la lista del panel. Comprobarlo por la interfaz —y no leyendo la
        // carpeta— es lo que prueba que el panel llama a quien tiene que llamar.
        await conTexto("button", "Guardar fuera…").waitForDisplayed({ timeout: 60_000 });

        const copias = await leerDeLaApp("recovery_list_backups");
        expect(copias.length).toBeGreaterThan(0);
    });
});
