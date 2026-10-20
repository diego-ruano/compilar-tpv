// @tpv/plano · El plano de las mesas, uno solo para la sala de la Main y el widget de reservas web
// (docs/estudios/reservas-web.md §7.1). Sólo dibuja y encaja; los colores y el estado de cada mesa
// llegan de quien lo usa. Sin clases de Tailwind: cada app pone el marco con las suyas.

export { default as Lienzo } from "./Lienzo";
export { default as NodoMesa } from "./NodoMesa";
export { fitTransform, tamanoDelContenido, type OpcionesEncaje } from "./geometria";
export { useElementSize } from "./useTamano";
export type { AspectoMesa, FormaMesa, MesaPlano, SalonPlano, Vista } from "./tipos";
