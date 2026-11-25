// src/app/pages/Inventario.tsx
import { useEffect, useState } from "react";
import { toAppError } from "@tpv/client";
import { useToast } from "../../shared/toast";

import { useInventario } from "../../features/inventario/hooks/useInventario";

import InventoryHeader from "../../features/inventario/ui/InventoryHeader";
import CategoriesSection from "../../features/inventario/ui/CategoriesSection";
import SummarySection from "../../features/inventario/ui/SummarySection";
import ProductsSection from "../../features/inventario/ui/ProductsSection";

import AddCategoryModal from "../../features/inventario/ui/AddCategoryModal";
import { AddProductModal } from "../../features/inventario/ui/AddProductModal";
import ProductDetailModal from "../../features/inventario/ProductDetailModal";
import IngredientesModal from "../../features/inventario/ui/IngredientesModal";
import BorrarCategoriaModal from "../../features/inventario/ui/BorrarCategoriaModal";

import { useDeleteProducto } from "../../features/inventario/inventarioQueries";
import { conAviso } from "../../shared/lib/conAviso";

export default function Inventario() {
    const toast = useToast();

    const {
        categorias,
        categoriaSeleccionada,
        productos,
        loadingProductos,
        proximosCaducar,
        menosCantidad,
        titulo,
        setCategoriaSeleccionada,
        cargarCategorias,
        cargarProductos,
        cargarResumenInventario,
    } = useInventario();

    const deleteProducto = useDeleteProducto();

    const [openAddCategory, setOpenAddCategory] = useState(false);
    const [openEditCategory, setOpenEditCategory] = useState(false);
    const [openAddProduct, setOpenAddProduct] = useState(false);
    const [openIngredientes, setOpenIngredientes] = useState(false);
    const [openBorrarCategoria, setOpenBorrarCategoria] = useState(false);

    const [openProductDetail, setOpenProductDetail] = useState(false);
    const [productDetailId, setProductDetailId] = useState<string | null>(null);

    const [productIdToEdit, setProductIdToEdit] = useState<string | null>(null);

    // Sin categoría abierta (se ha vuelto atrás, o la ha borrado otro equipo) no hay nada que editar
    // ni borrar: si se quedaran abiertos, saltarían al entrar en otra.
    useEffect(() => {
        if (categoriaSeleccionada) return;
        setOpenEditCategory(false);
        setOpenBorrarCategoria(false);
    }, [categoriaSeleccionada]);

    const deleteProduct = async (id: string) => {
        try {
            // La invalidación de onSuccess recachea productos y resumen automáticamente.
            await deleteProducto.mutateAsync(id);
        } catch (e) {
            // El motivo viene del caso de uso y dice qué hacer ("está en una comanda abierta:
            // cóbrala o quita la línea"). Tragárselo por un genérico deja al usuario delante de un
            // botón que no funciona y sin saber por qué.
            toast.error("No se pudo eliminar el producto", toAppError(e).message);
        }
    };

    const startEditProduct = (id: string) => {
        setProductIdToEdit(id);
        setOpenAddProduct(true);
    };

    return (
        <div className="flex min-h-full w-full touch-pan-y flex-col items-center gap-3 bg-bg p-2 pt-3 sm:gap-4 sm:p-4 lg:p-6 lg:pt-5">
            <div className="flex w-full min-w-0 flex-col gap-3 sm:gap-4">
                <InventoryHeader
                    titulo={titulo}
                    categoriaSeleccionada={categoriaSeleccionada}
                    onBack={() => setCategoriaSeleccionada(null)}
                    onNewCategory={() => setOpenAddCategory(true)}
                    onIngredientes={() => setOpenIngredientes(true)}
                    onEditCategory={() => setOpenEditCategory(true)}
                    onNewProduct={() => {
                        setProductIdToEdit(null);
                        setOpenAddProduct(true);
                    }}
                />

                {!categoriaSeleccionada ? (
                    <>
                        <CategoriesSection categorias={categorias} onSelect={(c) => setCategoriaSeleccionada(c)} />

                        <SummarySection proximosCaducar={proximosCaducar} menosCantidad={menosCantidad} />
                    </>
                ) : (
                    <ProductsSection
                        loading={loadingProductos}
                        productos={productos}
                        onOpenDetail={(id) => {
                            setProductDetailId(id);
                            setOpenProductDetail(true);
                        }}
                    />
                )}

                <IngredientesModal open={openIngredientes} onClose={() => setOpenIngredientes(false)} />

                <AddCategoryModal
                    open={openAddCategory}
                    onClose={() => setOpenAddCategory(false)}
                    onSaved={async () => {
                        await cargarCategorias();
                    }}
                />

                <AddCategoryModal
                    open={openEditCategory && categoriaSeleccionada != null}
                    categoria={categoriaSeleccionada}
                    onClose={() => setOpenEditCategory(false)}
                    onSaved={async () => {
                        await cargarCategorias();
                    }}
                    onEliminar={() => setOpenBorrarCategoria(true)}
                />

                {/* Después de la edición, para quedar encima: si se cancela, se vuelve a ella. */}
                <BorrarCategoriaModal
                    categoria={openBorrarCategoria ? categoriaSeleccionada : null}
                    numProductos={productos.length}
                    onClose={() => setOpenBorrarCategoria(false)}
                    onBorrada={() => {
                        setOpenBorrarCategoria(false);
                        setOpenEditCategory(false);
                        setCategoriaSeleccionada(null);
                    }}
                />

                <AddProductModal
                    open={openAddProduct}
                    onClose={() => {
                        setOpenAddProduct(false);
                        setProductIdToEdit(null);
                    }}
                    categoriaPreseleccionadaId={categoriaSeleccionada ? categoriaSeleccionada.ID_Categoria : null}
                    productIdToEdit={productIdToEdit}
                    onSaved={conAviso(async () => {
                        if (categoriaSeleccionada) {
                            await cargarProductos(categoriaSeleccionada.ID_Categoria);
                        } else {
                            await cargarResumenInventario();
                        }
                    })}
                />

                <ProductDetailModal
                    open={openProductDetail}
                    onClose={() => setOpenProductDetail(false)}
                    productId={productDetailId}
                    onEdit={(id) => {
                        setOpenProductDetail(false);
                        startEditProduct(id);
                    }}
                    onDeleted={async (id) => {
                        await deleteProduct(id);
                    }}
                />
            </div>
        </div>
    );
}
