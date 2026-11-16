-- Ingredientes de los productos, sin cantidades ni stock: sirven para decir que lleva cada producto
-- y para pedirlo con algo de menos o con algo de mas. Nada de esto toca el precio, el cobro ni el
-- inventario.
--
-- Se agrupan por categorias (Pan, Salsas, Quesos...) para que un bar con muchos no tenga una
-- lista interminable. Un ingrediente es de una sola categoria y su nombre no se repite dentro de
-- ella, pero si en otra: "Integral" puede ser un pan y tambien una pasta.
--
-- Borrar una categoria o un ingrediente lo hace la aplicacion a mano y en orden (primero lo que
-- cuelga de el), en las dos implementaciones: lo que viaja a la nube son esas sentencias, como en
-- SQL_QUITAR_PRODUCTO. Las FK con ON DELETE CASCADE son la red, no el camino.
CREATE TABLE IF NOT EXISTS Categorias_Ingrediente (
  ID_Categoria_Ingrediente TEXT NOT NULL PRIMARY KEY,
  Nombre TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS Ingredientes (
  ID_Ingrediente TEXT NOT NULL PRIMARY KEY,
  ID_Categoria_Ingrediente TEXT NOT NULL,
  Nombre TEXT NOT NULL,
  FOREIGN KEY (ID_Categoria_Ingrediente) REFERENCES Categorias_Ingrediente(ID_Categoria_Ingrediente) ON DELETE CASCADE,
  UNIQUE (ID_Categoria_Ingrediente, Nombre)
);

-- Que ingredientes lleva cada producto: las casillas de su ficha.
CREATE TABLE IF NOT EXISTS Producto_Ingredientes (
  ID_Producto TEXT NOT NULL,
  ID_Ingrediente TEXT NOT NULL,
  PRIMARY KEY (ID_Producto, ID_Ingrediente),
  FOREIGN KEY (ID_Producto) REFERENCES Productos(ID_Producto) ON DELETE CASCADE,
  FOREIGN KEY (ID_Ingrediente) REFERENCES Ingredientes(ID_Ingrediente) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_prod_ingr_ingrediente
ON Producto_Ingredientes(ID_Ingrediente);

-- Lo que se pidio distinto en una linea: un array JSON, en el orden en que se marco, de
-- {"id": ID_Ingrediente, "nombre": nombre del ingrediente al pedirlo, "tipo": "SIN" | "EXTRA"}.
-- NULL si la linea va como el producto. Guarda el nombre y no solo el id por lo mismo que
-- Nombre_Producto: si el ingrediente se renombra o se borra, la comanda sigue diciendo lo que se
-- pidio. Lo escriben igual la Main (tpv_domain::ingredientes) y el worker, y no cambia el precio.
ALTER TABLE Detalle_Comanda ADD COLUMN Cambios_Ingredientes TEXT;
