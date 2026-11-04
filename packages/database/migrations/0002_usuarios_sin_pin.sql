-- Usuarios que entran sin PIN: 1 = el login y el fichaje no se lo piden, basta con elegir su nombre.
-- 0 = como siempre. Lo marca un administrador en la ficha del trabajador. El usuario conserva su
-- Password_Hash: si se le quita la opcion, vuelve a entrar con PIN.
ALTER TABLE Usuarios ADD COLUMN Sin_PIN INTEGER NOT NULL DEFAULT 0 CHECK (Sin_PIN IN (0, 1));
