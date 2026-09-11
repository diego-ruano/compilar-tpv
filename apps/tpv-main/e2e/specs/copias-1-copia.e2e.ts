// Copias de seguridad · primer tramo: dejar el equipo con una copia y todo subido.
//
// Va en dos ficheros porque en medio hay que **apagar la aplicación y romperle la base**, que es la
// avería que la pantalla de recuperación existe para resolver. Eso no se puede hacer con la app
// abierta (en Windows SQLite tiene el fichero cogido) ni desde dentro del propio recorrido: lo hace
// `beforeSession` del segundo tramo, que corre con la app cerrada. Reiniciar el equipo es además lo
// que pasa de verdad.
//
// Este tramo corre con la NUBE ENCENDIDA y con una licencia recién emitida (ver la receta en
// `wdio.conf.ts`). Las dos cosas son necesarias:
//
//   · la nube, porque lo que desbloquea el login después de restaurar es la reconciliación, y esa
//     necesita que la nube confirme que los dos lados coinciden;
//   · una licencia nueva —o sea un tenant limpio— porque el catch-up desde `Last_Seq = 0`
//     reproduciría lo que dejaron las tandas anteriores contra tablas con `UNIQUE` en el nombre, y
//     eso acaba en cuarentena; y `recovery_complete` se niega a desbloquear con cuarentenas.
//
// Lo que NO se prueba aquí, a propósito: exportar a un USB y volver a importar. Ese viaje ya lo
// cubre `una_copia_sale_del_equipo_y_vuelve` en Rust, y por la interfaz pasa por un diálogo nativo
// de Windows que WebDriver no puede tocar.

import { $, expect } from "@wdio/globals";

import { estrenarEquipo } from "../helpers/arranque.js";
import { CATEGORIA, NEGOCIO, NIF, PIN, RAZON_SOCIAL } from "../helpers/copias.js";
import { declararDatosFiscales } from "../helpers/fiscal.js";
import { cargarDotEnv } from "../helpers/entorno.js";
import { esperarNubeAlDia } from "../helpers/nube.js";
import { conTexto, irA, leerDeLaApp, pulsar } from "../helpers/ui.js";

cargarDotEnv();

describe("Copias de seguridad · antes de la avería", () => {
    it("1 · estrena el equipo con la nube encendida", async () => {
        await estrenarEquipo(NEGOCIO, PIN);

        // Y declara quién factura. No es andamiaje: desde FIS-01 un equipo que no lo sabe no puede
        // cobrar, y lo avisa al entrar con un modal a pantalla completa que tapa el menú entero.
        //
        // Este paso es además el que CAZÓ SYNC-20: ese `UPDATE Business_Settings … Razon_Social`
        // atascaba el outbox contra un worker cuyo esquema embebido era anterior a FISCAL-01, y con
        // la cola ordenada eso paraba toda la replicación posterior en silencio. Que este recorrido
        // lo escriba y luego espere a que la nube se ponga al día es lo que vuelve a detectarlo si
        // el esquema del worker se queda atrás otra vez.
        await declararDatosFiscales(RAZON_SOCIAL, NIF);
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
        const salud = await esperarNubeAlDia();
        expect(salud.outbox_pending).toBe(0);
    });

    it("4 · guarda una copia de seguridad desde Configuración", async () => {
        await irA("/Configuracion");
        await pulsar("Conectividad");

        await conTexto("div", "Copias de seguridad").waitForDisplayed({ timeout: 30_000 });
        await pulsar("Crear copia ahora");

        // La copia aparece en la lista del panel. Comprobarlo por la interfaz —y no leyendo la
        // carpeta— es lo que prueba que el panel llama a quien tiene que llamar.
        await conTexto("button", "Guardar fuera…").waitForDisplayed({ timeout: 60_000 });

        const copias = await leerDeLaApp<Array<{ id: string }>>("recovery_list_backups");
        expect(copias.length).toBeGreaterThan(0);
    });
});
