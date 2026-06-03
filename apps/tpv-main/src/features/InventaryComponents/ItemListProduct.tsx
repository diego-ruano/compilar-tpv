function ItemListProduct({
  className,
  cantidad,
  nombre,
  caducidad,
  lote,
  precio,
}: {
  className?: string;
  cantidad: string;
  nombre: string;
  caducidad: string;
  lote: string;
  precio: string;
}) {
  return (
    <div
      className={`
        w-full
        px-4
        py-3
        flex
        justify-between
        items-center
        text-base
        leading-6
        ${className}
      `}
    >
      <p className="w-[18%] font-semibold">{cantidad}</p>
      <p className="w-[28%] font-medium truncate">{nombre}</p>
      <p className="w-[18%]">{caducidad}</p>
      <p className="w-[18%] truncate">{lote}</p>
      <p className="w-[10%] text-right font-semibold">{precio}</p>
    </div>
  );
}

export default ItemListProduct;
