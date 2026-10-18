// El encaje del plano vive en el paquete compartido (`@tpv/plano`), el mismo del widget de reservas
// web. Se reexporta aquí para quien lo importa de siempre (la sala y los E2E, que calculan con él
// dónde pulsar una mesa: por eso de `@tpv/plano/geometria`, sin arrastrar los componentes de Konva).
export { fitTransform } from "@tpv/plano/geometria";
