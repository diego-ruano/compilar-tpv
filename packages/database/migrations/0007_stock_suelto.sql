-- 0007_stock_suelto.sql
-- VR-04: stock "suelto" fuera de lotes. Contador simple por producto, OPCIONAL (NULL = el producto
-- no usa stock suelto y se vende sin descontar de aqui). A diferencia de los lotes (que nunca bajan
-- de 0), este contador SI puede quedar negativo: es la senal honesta de sobreventa. El stock total
-- mostrado de un producto pasa a ser SUM(lotes) + COALESCE(Stock_Suelto, 0).
ALTER TABLE Productos ADD COLUMN Stock_Suelto REAL;
