// La confirmación de borrar una categoría, que se lleva sus productos.
import Modal from "./Modal";
import { useBorrarCategoria } from "../inventarioQueries";
import { conAviso } from "../../../shared/lib/conAviso";

export default function BorrarCategoriaModal({
    categoria,
    numProductos,
    onClose,
    onBorrada,
}: {
    /** La categoría a borrar; sin ella, el modal está cerrado. */
    categoria: { ID_Categoria: string; Nombre: string } | null;
    numProductos: number;
    onClose: () => void;
    onBorrada: () => void;
}) {
    const borrar = useBorrarCategoria();

    const confirmar = conAviso(async () => {
        if (!categoria) return;
        await borrar.mutateAsync(categoria.ID_Categoria);
        onBorrada();
    }, "No se pudo eliminar la categoría");

    return (
        <Modal open={categoria != null} onClose={onClose} title="Eliminar categoría" maxWidthClass="max-w-[520px]">
            <p className="text-center text-fg">
                ¿Seguro que quieres eliminar «{categoria?.Nombre}»?
            </p>
            {numProductos > 0 && (
                <p className="mt-2 text-center text-fg-muted">
                    {numProductos === 1
                        ? "Tiene 1 producto y se eliminará también."
                        : `Tiene ${numProductos} productos y se eliminarán también.`}{" "}
                    Las ventas de los que ya se han vendido siguen contando en las estadísticas.
                </p>
            )}

            <div className="mt-5 grid grid-cols-1 gap-2 sm:grid-cols-2">
                <button
                    type="button"
                    onClick={onClose}
                    disabled={borrar.isPending}
                    className="w-full cursor-pointer rounded-xl border border-border px-4 py-2 font-semibold transition hover:bg-surface-2 disabled:opacity-60"
                >
                    Cancelar
                </button>
                <button
                    type="button"
                    onClick={confirmar}
                    disabled={borrar.isPending}
                    className="w-full cursor-pointer rounded-xl bg-danger px-4 py-2 font-extrabold text-danger-fg shadow-sm transition hover:opacity-90 disabled:opacity-60"
                >
                    {borrar.isPending ? "Eliminando..." : "Eliminar"}
                </button>
            </div>
        </Modal>
    );
}
