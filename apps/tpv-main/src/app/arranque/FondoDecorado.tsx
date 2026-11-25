// src/app/arranque/FondoDecorado.tsx
//
// Los dos halos de color de fondo que llevan las pantallas de arranque (selector de modo, activación y
// vinculación del Handy). El contenedor tiene que ser `relative` y `overflow-hidden`.

export default function FondoDecorado() {
	return (
		<>
			<div
				className="pointer-events-none absolute -left-24 -top-24 size-80 rounded-full bg-accent-soft blur-3xl"
				aria-hidden
			/>
			<div
				className="pointer-events-none absolute -bottom-32 -right-16 size-96 rounded-full bg-accent-soft opacity-70 blur-3xl"
				aria-hidden
			/>
		</>
	);
}
