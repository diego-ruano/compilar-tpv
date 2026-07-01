# Lista de tecnologías e implementación

**Release de nuevas versiones del programa (relacionado con la base de datos)**
RESUELTO: ya existe un sistema de migraciones. El esquema ya NO es un `schema.sql` con
`CREATE TABLE IF NOT EXISTS` (que no aplicaba cambios sobre tablas existentes). La fuente única de
verdad son los ficheros `.sql` de `packages/database/migrations/`, aplicados en orden y controlados
por una tabla `_migrations (name, hash, applied_at)`: cada BD (escritorio y tenant Turso) aplica solo
las migraciones que le falten, así que añadir un campo se hace con una migración nueva y aditiva
(`ALTER TABLE ... ADD COLUMN`) que se aplica sobre instalaciones existentes. Detalle en
`crates/tpv-infra-sqlite/src/migrations.rs` y `apps/cloud-worker-licensing/src/server/tenantMigrations.ts`.

**Impresión de los tickets**
Tauri tiene un plugin para poder mandar cosas a la impresora, tenemos que hacer un diseño del ticket con html y con html2canvas hacemos una captura de pantalla del ticket, la convertimos a un string base64 y se imprime eso. Hay que testear cuando tarda en sacar el ticket porque es una imagen, si tarda yo que se 10 segundos pues no me parece viable, habría que mandar instrucciones crudas a la impresora para que imprima texto puro y no una imagen, pero bueno probamos lo otro primero que es más sencillo

**Problema de no tener la app verificada**
Las licencias para las aplicaciones valen entre 200 y 400 euros al año según el gemini, si se intenta instalar una aplicación que no tiene la licencia esta pues te salta lo de windows protegió su pc porque la aplicación es de origen desconocido, aunque si que se puede instalar igualmente. Supongo que si vamos nosotros personalmente a instalar el programa pues simplemente aceptas y fuera, pero si lo instala alguien desde su casa pues si le salta el aviso y no tiene ni idea va a decir esto es un virus. HAY QUE PROBAR SI SUBIÉNDOLA A LA MICROSOFT STORE NO HAGA FALTA TENER LA LICENCIA, NO SE SI ES CIERTO HAY QUE VERIFICAR

**Actualizaciones de la app**
Necesitamos un sistema para poder implementar las actualizaciones de la app, porque no es viable que alguien se tenga que descargar otra vez el exe desde internet y pierda sus datos y eso. Para solucionar esto tenemos que tener lo primero un bucket en la nube que contenga los .exe que vamos sacando con las actualizaciones. En este bucket tenemos que tener un latest.json que tenga las versiones del programa con en enlace donde se encuentra. El programa luego tiene que abrir un enlace que le lleve al bucket que tenemos para que lea el json y compruebe la firma, y si ve que está desactualizado el programa lo tiene que notificar y si se acepta pues el programa tiene que reinstalar el exe encima de lo que ya hay (no se pierden los datos porque tenemos una carpeta appdata con todo lo que tiene que cargar la app). La opción más fácil para hacer esto es usar las releases de github, que te da urls públicas para descargar las versiones del programa