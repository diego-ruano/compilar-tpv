// test/helpers/sinRed.node.setup.ts
//
// Lo que Vitest carga antes de cada fichero del proyecto `node` (`setupFiles` en
// `vitest.config.ts`): pone la guarda de red de Node y hace fallar al test que haya intentado salir.
// El porqué y el cómo, en `sinRed.node.ts`.

import { afterAll, afterEach } from "vitest";

import { exigirQueNadaHayaSalidoEnNode, ponerGuardaDeRedEnNode } from "./sinRed.node";

ponerGuardaDeRedEnNode();

afterEach(exigirQueNadaHayaSalidoEnNode);
afterAll(exigirQueNadaHayaSalidoEnNode);
