//! El resumen por cubos con el que la Main y la nube comparan sus filas sin mandárselas.
//!
//! El contraste diario (`verificar_nube`) tiene que decir si las filas de la ventana son las mismas
//! en los dos sitios. Bajarlas enteras no escala: la ventana de un bar con mucho movimiento no cabe
//! en una respuesta. Así que cada lado **resume** las suyas y sólo se comparan los resúmenes:
//!
//! - cada fila va a un **cubo**, que sale del hash de su clave primaria ([`cubo_de`]): la misma fila
//!   cae en el mismo cubo en los dos lados aunque cambie su contenido;
//! - de cada cubo se guarda cuántas filas tiene y la **suma** (módulo 2⁶⁴) del hash de cada una.
//!
//! Dos cubos con la misma cuenta y la misma suma tienen las mismas filas; uno que no cuadra dice
//! en qué puñado de filas está la diferencia, y sólo ésas se bajan para compararlas una a una
//! (`tpv-infra-sqlite/src/contraste.rs`). El resumen es un filtro: quien decide si una fila es
//! distinta es la comparación fila a fila, con su tolerancia.
//!
//! Lo que hace que esto funcione es que los dos lados escriban **la misma fila con los mismos
//! bytes**, y eso es este módulo y su gemelo del worker (`domains/sync/resumenCubos.ts`). No pueden
//! compartir código, así que comparten la tabla de casos `verificacion_casos.json`: un criterio
//! nuevo es un caso nuevo ahí.
//!
//! # La forma canónica
//!
//! | Valor | Bytes |
//! |---|---|
//! | `NULL` | `00` |
//! | un número (`INTEGER` o `REAL`) | `01` + sus 8 bytes IEEE-754 de doble, en big-endian; `-0` es `+0` |
//! | un texto | `02` + su longitud en bytes (u32 big-endian) + su UTF-8 |
//! | un blob | `03` + su longitud (u32 big-endian) + sus bytes |
//!
//! Una fila es la concatenación de sus valores, en el orden de sus columnas.
//!
//! **Un entero es su doble.** El SQLite del Durable Object entrega a JavaScript un `INTEGER` y un
//! `REAL` como el mismo `number`: allí un 4 y un 4.0 no se distinguen, y un entero de más de 53
//! bits llega ya redondeado. Aquí se hace lo mismo (`n as f64`, que redondea igual), y por eso un
//! 4 guardado como entero en un lado y como real en el otro resume igual: es la misma cifra.
//!
//! **Un texto es un texto.** `"2.50"` y `2.5` no resumen igual, ni `"007"` y `"7"`. Si una columna
//! guardara en un lado el número y en el otro su texto, el cubo no cuadraría, sus filas se bajarían
//! y la comparación fila a fila, que sí tolera las dos formas de escribir un número, diría que son
//! la misma: cuesta una descarga, no una reparación de más. Lo contrario (dar por iguales dos
//! textos que parecen el mismo número) escondería una diferencia de verdad.
//!
//! # El hash
//!
//! FNV-1a de 64 bits. No es criptográfico ni hace falta: aquí no hay adversario, hay dos copias de
//! una base que deberían ser iguales. Se eligió porque se escribe igual en los dos lados con
//! aritmética de 32 bits (el DO no tiene enteros de 64 y `crypto.subtle` es asíncrono, y el
//! resumen tiene que calcularse sin soltar el hilo para ser una foto) y porque tiene vectores
//! publicados.
//!
//! Para el **cubo** no basta: FNV-1a apenas lleva a sus bits altos lo que cambia en los últimos
//! bytes, y dos claves que sólo se diferencian al final (`d-0001`, `d-0002`; una clave compuesta
//! cuya última parte es una fecha) caerían casi todas en el mismo cubo, y un cubo que no cuadra
//! obligaría a bajar media tabla. Así que el hash de la clave se mezcla antes: sus dos mitades de
//! 32 bits juntas con XOR y pasadas por el `fmix32` de MurmurHash3, que con multiplicaciones de 32
//! bits (`Math.imul` en el worker) reparte cualquier diferencia por todos los bits.

/// El máximo de cubos de una tabla. Con 256, una fila distinta en una tabla de 200.000 obliga a
/// bajar unas 800, y el resumen entero de un negocio ocupa del orden de 100 KB.
pub const MAX_CUBOS: u32 = 256;

/// Las filas que se buscan por cubo: de ahí sale cuántos cubos lleva cada tabla.
pub const FILAS_POR_CUBO: u64 = 32;

/// Cuántos cubos lleva una tabla de `filas` filas: la menor potencia de dos que deja unas 32 por
/// cubo, hasta [`MAX_CUBOS`]. Una maestra de veinte filas va en uno; cualquiera de más de 4.096, en
/// 256.
///
/// Lo decide la nube (`cubosPara` en `resumenCubos.ts`) y viaja en el resumen: la Main usa el número
/// que le llega. Está aquí para que los dos lados lo fijen con la misma tabla de casos.
pub fn cubos_para(filas: u64) -> u32 {
    let mut cubos = 1u32;
    while cubos < MAX_CUBOS && u64::from(cubos) * FILAS_POR_CUBO < filas {
        cubos *= 2;
    }
    cubos
}

const FNV_BASE: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIMO: u64 = 0x0000_0100_0000_01b3;

/// FNV-1a de 64 bits, por partes.
#[derive(Debug, Clone, Copy)]
pub struct Fnv64(u64);

impl Default for Fnv64 {
    fn default() -> Self {
        Self::nuevo()
    }
}

impl Fnv64 {
    pub const fn nuevo() -> Self {
        Self(FNV_BASE)
    }

    pub fn bytes(&mut self, bytes: &[u8]) {
        let mut h = self.0;
        for b in bytes {
            h = (h ^ u64::from(*b)).wrapping_mul(FNV_PRIMO);
        }
        self.0 = h;
    }

    pub const fn fin(self) -> u64 {
        self.0
    }
}

/// FNV-1a de 64 bits de `bytes`.
pub fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut h = Fnv64::nuevo();
    h.bytes(bytes);
    h.fin()
}

/// El valor de una celda, tal como lo guarda SQLite. El texto va en sus bytes UTF-8.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Celda<'a> {
    Nulo,
    Numero(f64),
    Texto(&'a [u8]),
    Blob(&'a [u8]),
}

impl Celda<'_> {
    /// Un `INTEGER` de SQLite: su doble, que es lo que el Durable Object entrega a JavaScript.
    pub fn entero(n: i64) -> Self {
        Celda::Numero(n as f64)
    }
}

/// Lo más que puede medir un texto o un blob: su longitud viaja en 32 bits. SQLite no guarda
/// valores de más de 2 GiB, así que no se alcanza; si se alcanzara, la longitud se satura y esa
/// fila deja de cuadrar, que es fallar del lado que no esconde nada.
fn longitud(bytes: &[u8]) -> [u8; 4] {
    u32::try_from(bytes.len()).unwrap_or(u32::MAX).to_be_bytes()
}

/// Añade a `salida` la forma canónica de `celda`.
pub fn escribir_canonico(celda: &Celda<'_>, salida: &mut Vec<u8>) {
    match celda {
        Celda::Nulo => salida.push(0),
        Celda::Numero(x) => {
            salida.push(1);
            // `-0.0 == 0.0`: los dos se escriben como `+0`. SQLite no guarda un NaN (lo deja en
            // `NULL`), así que aquí no llega.
            let x = if *x == 0.0 { 0.0 } else { *x };
            salida.extend_from_slice(&x.to_bits().to_be_bytes());
        }
        Celda::Texto(t) => {
            salida.push(2);
            salida.extend_from_slice(&longitud(t));
            salida.extend_from_slice(t);
        }
        Celda::Blob(b) => {
            salida.push(3);
            salida.extend_from_slice(&longitud(b));
            salida.extend_from_slice(b);
        }
    }
}

/// ¿Es un número de cubos que se puede usar? Una potencia de dos entre 1 y [`MAX_CUBOS`].
pub fn cubos_validos(cubos: u32) -> bool {
    (1..=MAX_CUBOS).contains(&cubos) && cubos.is_power_of_two()
}

/// El hash de una clave, mezclado para repartir las filas por igual entre los cubos: sus dos mitades
/// juntas con XOR y pasadas por el `fmix32` de MurmurHash3 (ver la cabecera del módulo).
pub fn mezclar(hash_clave: u64) -> u32 {
    let mut h = ((hash_clave >> 32) as u32) ^ (hash_clave as u32);
    h ^= h >> 16;
    h = h.wrapping_mul(0x85eb_ca6b);
    h ^= h >> 13;
    h = h.wrapping_mul(0xc2b2_ae35);
    h ^= h >> 16;
    h
}

/// El cubo de una fila entre `cubos`, a partir del hash de su clave primaria: los bits altos de su
/// mezcla ([`mezclar`]). Con menos cubos, menos bits: el cubo entre N es el cubo entre 256 sin sus
/// bits bajos, y por eso el worker resume con 256 y pliega al final.
///
/// `cubos` tiene que ser válido ([`cubos_validos`]); con otra cosa devuelve 0.
pub fn cubo_de(hash_clave: u64, cubos: u32) -> u32 {
    if !cubos_validos(cubos) || cubos == 1 {
        return 0;
    }
    mezclar(hash_clave) >> (32 - cubos.trailing_zeros())
}

/// El resumen de las filas de una tabla: por cubo, cuántas hay y la suma de sus hashes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResumenCubos {
    pub cuentas: Vec<u64>,
    pub sumas: Vec<u64>,
}

impl ResumenCubos {
    /// Un resumen vacío de `cubos` cubos. `None` si `cubos` no es válido.
    pub fn nuevo(cubos: u32) -> Option<Self> {
        cubos_validos(cubos).then(|| Self {
            cuentas: vec![0; cubos as usize],
            sumas: vec![0; cubos as usize],
        })
    }

    pub fn cubos(&self) -> u32 {
        self.cuentas.len() as u32
    }

    /// Apunta una fila: el hash de su clave decide el cubo, y el de la fila entera se suma a él.
    /// Devuelve el cubo.
    pub fn anadir(&mut self, hash_clave: u64, hash_fila: u64) -> u32 {
        let cubo = cubo_de(hash_clave, self.cubos());
        let i = cubo as usize;
        self.cuentas[i] += 1;
        self.sumas[i] = self.sumas[i].wrapping_add(hash_fila);
        cubo
    }

    /// Los cubos que no cuadran con los de `otro`. Con otro número de cubos no hay nada que
    /// comparar: `None`.
    pub fn distintos(&self, otro: &ResumenCubos) -> Option<Vec<u32>> {
        if self.cubos() != otro.cubos() {
            return None;
        }
        Some(
            (0..self.cubos())
                .filter(|c| {
                    let i = *c as usize;
                    self.cuentas[i] != otro.cuentas[i] || self.sumas[i] != otro.sumas[i]
                })
                .collect(),
        )
    }
}

/// Resume filas de una en una: escribe la forma canónica de la clave y de la fila, y apunta sus
/// hashes. Reutiliza sus dos búferes, así que una tabla entera no reserva memoria por fila.
#[derive(Debug)]
pub struct Resumidor {
    resumen: ResumenCubos,
    clave: Vec<u8>,
    fila: Vec<u8>,
}

impl Resumidor {
    pub fn nuevo(cubos: u32) -> Option<Self> {
        Some(Self { resumen: ResumenCubos::nuevo(cubos)?, clave: Vec::new(), fila: Vec::new() })
    }

    /// Apunta una fila. `claves` son las posiciones, dentro de la fila, de las columnas de su clave
    /// primaria, en el orden de la clave. Devuelve el cubo y el hash de la clave, o `None` si una
    /// de esas posiciones no existe en la fila (entonces no apunta nada).
    pub fn fila(&mut self, celdas: &[Celda<'_>], claves: &[usize]) -> Option<(u32, u64)> {
        self.clave.clear();
        for i in claves {
            escribir_canonico(celdas.get(*i)?, &mut self.clave);
        }
        self.fila.clear();
        for celda in celdas {
            escribir_canonico(celda, &mut self.fila);
        }
        let hash_clave = fnv1a64(&self.clave);
        let cubo = self.resumen.anadir(hash_clave, fnv1a64(&self.fila));
        Some((cubo, hash_clave))
    }

    pub fn fin(self) -> ResumenCubos {
        self.resumen
    }
}

/// Una suma de 64 bits como viaja: dieciséis cifras hexadecimales.
pub fn hex64(n: u64) -> String {
    format!("{n:016x}")
}

/// Lo contrario de [`hex64`]. `None` si no son exactamente dieciséis cifras hexadecimales.
pub fn de_hex64(texto: &str) -> Option<u64> {
    if texto.len() != 16 || !texto.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    u64::from_str_radix(texto, 16).ok()
}

/// DO-SUBIDA · La huella de una fila: el FNV-1a de la forma canónica de sus valores, en su orden. Es
/// el hash de fila de [`Resumidor::fila`], suelto.
pub fn huella_de_fila(celdas: &[Celda<'_>]) -> u64 {
    let mut bytes = Vec::with_capacity(128);
    for c in celdas {
        escribir_canonico(c, &mut bytes);
    }
    fnv1a64(&bytes)
}

/// DO-SUBIDA · La suma de un tramo de filas: la de sus huellas, módulo 2⁶⁴. No depende del orden. El
/// worker la calcula igual (`resumenCubos.ts::sumaDeTramo`); los dos leen `tramos` en
/// `verificacion_casos.json`.
pub fn suma_de_huellas(huellas: impl IntoIterator<Item = u64>) -> u64 {
    huellas.into_iter().fold(0u64, u64::wrapping_add)
}

#[cfg(test)]
mod tests {
    //! Contra la tabla que comparte con el worker (`verificacion_casos.json`): la forma canónica,
    //! el hash, el cubo y el resumen de una tabla entera.

    use super::*;
    use serde_json::Value;

    fn casos() -> Value {
        serde_json::from_str(include_str!("verificacion_casos.json")).unwrap()
    }

    fn de_hex(texto: &str) -> Vec<u8> {
        (0..texto.len()).step_by(2).map(|i| u8::from_str_radix(&texto[i..i + 2], 16).unwrap()).collect()
    }

    fn en_hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    /// Un valor del fichero de casos, con lo que hace falta tener vivo para prestarlo como celda.
    enum Valor {
        Nulo,
        Numero(f64),
        Entero(i64),
        Texto(String),
        Blob(Vec<u8>),
    }

    impl Valor {
        fn leer(v: &Value) -> Valor {
            match v {
                Value::Null => Valor::Nulo,
                Value::Number(n) => Valor::Numero(n.as_f64().unwrap()),
                Value::String(s) => Valor::Texto(s.clone()),
                Value::Object(o) => {
                    if let Some(e) = o.get("entero") {
                        Valor::Entero(e.as_str().unwrap().parse().unwrap())
                    } else if let Some(r) = o.get("real") {
                        Valor::Numero(match r.as_str().unwrap() {
                            "inf" => f64::INFINITY,
                            "-inf" => f64::NEG_INFINITY,
                            "-0" => -0.0,
                            otro => otro.parse().unwrap(),
                        })
                    } else {
                        Valor::Blob(de_hex(o["blob"].as_str().unwrap()))
                    }
                }
                otro => panic!("valor que la tabla no contempla: {otro}"),
            }
        }

        fn celda(&self) -> Celda<'_> {
            match self {
                Valor::Nulo => Celda::Nulo,
                Valor::Numero(x) => Celda::Numero(*x),
                Valor::Entero(n) => Celda::entero(*n),
                Valor::Texto(s) => Celda::Texto(s.as_bytes()),
                Valor::Blob(b) => Celda::Blob(b),
            }
        }
    }

    fn fila(v: &Value) -> Vec<Valor> {
        v.as_array().unwrap().iter().map(Valor::leer).collect()
    }

    fn canonica(valores: &[Valor]) -> Vec<u8> {
        let mut salida = Vec::new();
        for v in valores {
            escribir_canonico(&v.celda(), &mut salida);
        }
        salida
    }

    // DO-SUBIDA: el número de filas y la suma de sus huellas, igual que el worker.
    #[test]
    fn la_suma_de_un_tramo_es_la_de_la_tabla_compartida() {
        for caso in casos()["tramos"].as_array().unwrap() {
            let filas: Vec<Vec<Valor>> = caso["filas"].as_array().unwrap().iter().map(fila).collect();
            let suma = suma_de_huellas(filas.iter().map(|f| {
                let celdas: Vec<Celda<'_>> = f.iter().map(Valor::celda).collect();
                huella_de_fila(&celdas)
            }));
            assert_eq!(filas.len() as u64, caso["n"].as_u64().unwrap(), "{}", caso["descripcion"]);
            assert_eq!(hex64(suma), caso["suma"].as_str().unwrap(), "{}", caso["descripcion"]);
        }
    }

    #[test]
    fn el_hash_es_fnv1a_de_64_bits() {
        for caso in casos()["fnv1a64"].as_array().unwrap() {
            let texto = caso["texto"].as_str().unwrap();
            assert_eq!(hex64(fnv1a64(texto.as_bytes())), caso["hash"].as_str().unwrap(), "{texto:?}");
        }
        // Por partes da lo mismo que de una vez.
        let mut h = Fnv64::nuevo();
        h.bytes(b"foo");
        h.bytes(b"");
        h.bytes(b"bar");
        assert_eq!(h.fin(), fnv1a64(b"foobar"));
    }

    #[test]
    fn cada_valor_tiene_una_sola_forma_de_escribirse() {
        for caso in casos()["valores"].as_array().unwrap() {
            let valor = Valor::leer(&caso["valor"]);
            assert_eq!(en_hex(&canonica(&[valor])), caso["bytes"].as_str().unwrap(), "{}", caso["valor"]);
        }
    }

    #[test]
    fn una_fila_es_la_concatenacion_de_sus_valores() {
        for caso in casos()["filas"].as_array().unwrap() {
            let bytes = canonica(&fila(&caso["fila"]));
            assert_eq!(en_hex(&bytes), caso["bytes"].as_str().unwrap(), "{}", caso["fila"]);
            assert_eq!(hex64(fnv1a64(&bytes)), caso["hash"].as_str().unwrap(), "{}", caso["fila"]);
        }
    }

    #[test]
    fn el_cubo_sale_de_los_bits_altos_de_la_mezcla_del_hash_de_la_clave() {
        for caso in casos()["cubos"].as_array().unwrap() {
            let hash = fnv1a64(&canonica(&fila(&caso["clave"])));
            assert_eq!(hex64(hash), caso["hash"].as_str().unwrap(), "{}", caso["clave"]);
            for (cubos, cubo) in caso["cubo"].as_object().unwrap() {
                let cubos: u32 = cubos.parse().unwrap();
                assert_eq!(u64::from(cubo_de(hash, cubos)), cubo.as_u64().unwrap(), "{} en {cubos}", caso["clave"]);
            }
        }
    }

    #[test]
    fn el_resumen_de_una_tabla_es_el_de_la_tabla_compartida() {
        for caso in casos()["resumenes"].as_array().unwrap() {
            let nombre = caso["descripcion"].as_str().unwrap();
            let claves: Vec<usize> =
                caso["claves"].as_array().unwrap().iter().map(|c| c.as_u64().unwrap() as usize).collect();
            let mut resumidor = Resumidor::nuevo(caso["cubos"].as_u64().unwrap() as u32).unwrap();
            for f in caso["filas"].as_array().unwrap() {
                let valores = fila(f);
                let celdas: Vec<Celda<'_>> = valores.iter().map(Valor::celda).collect();
                resumidor.fila(&celdas, &claves).unwrap();
            }
            let resumen = resumidor.fin();
            let cuentas: Vec<u64> = caso["cuentas"].as_array().unwrap().iter().map(|c| c.as_u64().unwrap()).collect();
            let sumas: Vec<u64> =
                caso["sumas"].as_array().unwrap().iter().map(|s| de_hex64(s.as_str().unwrap()).unwrap()).collect();
            assert_eq!(resumen.cuentas, cuentas, "{nombre}");
            assert_eq!(resumen.sumas, sumas, "{nombre}");
        }
    }

    #[test]
    fn el_orden_de_las_filas_no_cambia_el_resumen() {
        let caso = &casos()["resumenes"][3];
        let claves = [0usize, 1];
        let filas: Vec<Vec<Valor>> = caso["filas"].as_array().unwrap().iter().map(fila).collect();
        let resumir = |orden: &mut dyn Iterator<Item = &Vec<Valor>>| {
            let mut r = Resumidor::nuevo(16).unwrap();
            for valores in orden {
                let celdas: Vec<Celda<'_>> = valores.iter().map(Valor::celda).collect();
                r.fila(&celdas, &claves).unwrap();
            }
            r.fin()
        };
        assert_eq!(resumir(&mut filas.iter()), resumir(&mut filas.iter().rev()));
    }

    #[test]
    fn un_valor_cambiado_una_fila_de_menos_y_una_de_mas_dejan_su_cubo_sin_cuadrar() {
        let resumir = |filas: &[(&str, f64)]| {
            let mut r = Resumidor::nuevo(4).unwrap();
            let mut cubos = Vec::new();
            for (id, precio) in filas {
                let celdas = [Celda::Texto(id.as_bytes()), Celda::Numero(*precio)];
                cubos.push(r.fila(&celdas, &[0]).unwrap().0);
            }
            (r.fin(), cubos)
        };
        let (base, cubos) = resumir(&[("a", 1.0), ("b", 2.0), ("c", 3.0)]);
        assert_eq!(base.distintos(&base), Some(vec![]));

        // Un valor distinto: sólo el cubo de esa fila.
        let (otro, _) = resumir(&[("a", 1.0), ("b", 2.5), ("c", 3.0)]);
        assert_eq!(base.distintos(&otro), Some(vec![cubos[1]]));

        // Una fila de menos y una de más: los suyos.
        let (otro, _) = resumir(&[("a", 1.0), ("b", 2.0)]);
        assert_eq!(base.distintos(&otro), Some(vec![cubos[2]]));
        let (otro, cubos_de_mas) = resumir(&[("a", 1.0), ("b", 2.0), ("c", 3.0), ("d", 4.0)]);
        assert_eq!(base.distintos(&otro), Some(vec![cubos_de_mas[3]]));

        // Con otro número de cubos no hay comparación.
        assert_eq!(base.distintos(&ResumenCubos::nuevo(8).unwrap()), None);
    }

    #[test]
    fn unas_32_filas_por_cubo_en_potencias_de_dos_y_hasta_256() {
        for caso in casos()["cubos_para"].as_array().unwrap() {
            let filas = caso["filas"].as_u64().unwrap();
            assert_eq!(u64::from(cubos_para(filas)), caso["cubos"].as_u64().unwrap(), "{filas} filas");
            assert!(cubos_validos(cubos_para(filas)));
        }
    }

    #[test]
    fn solo_valen_las_potencias_de_dos_hasta_el_maximo() {
        for cubos in [1, 2, 4, 8, 16, 32, 64, 128, 256] {
            assert!(cubos_validos(cubos), "{cubos}");
        }
        for cubos in [0, 3, 6, 100, 257, 512, u32::MAX] {
            assert!(!cubos_validos(cubos), "{cubos}");
            assert!(ResumenCubos::nuevo(cubos).is_none(), "{cubos}");
            assert_eq!(cubo_de(u64::MAX, cubos), 0, "{cubos}");
        }
        assert_eq!(cubo_de(u64::MAX, 1), 0);
        // Con menos cubos, los bits altos del de 256.
        for h in [0u64, 1, 0xcbf2_9ce4_8422_2325, u64::MAX, 0x0123_4567_89ab_cdef] {
            for cubos in [2u32, 4, 16, 64, 128] {
                assert_eq!(cubo_de(h, cubos), cubo_de(h, 256) >> (8 - cubos.trailing_zeros()), "{h:x} en {cubos}");
            }
        }
    }

    #[test]
    fn claves_que_solo_se_diferencian_al_final_se_reparten_por_todos_los_cubos() {
        // Con los bits altos del FNV-1a sin mezclar, 180 claves así caían en 2 de los 256 cubos.
        let mut ocupados = std::collections::HashSet::new();
        let mut por_cubo = [0u32; 16];
        for i in 0..180 {
            let clave = format!("d-{i:04}");
            let mut bytes = Vec::new();
            escribir_canonico(&Celda::Texto(clave.as_bytes()), &mut bytes);
            let h = fnv1a64(&bytes);
            ocupados.insert(cubo_de(h, 256));
            por_cubo[cubo_de(h, 16) as usize] += 1;
        }
        assert!(ocupados.len() > 100, "{} cubos ocupados", ocupados.len());
        assert!(por_cubo.iter().all(|n| (4..=25).contains(n)), "{por_cubo:?}");
    }

    #[test]
    fn una_suma_viaja_en_dieciseis_cifras() {
        for n in [0, 1, 0xcbf2_9ce4_8422_2325, u64::MAX] {
            assert_eq!(de_hex64(&hex64(n)), Some(n));
        }
        for malo in ["", "0", "cbf29ce48422232", "cbf29ce4842223255", "cbf29ce48422232g", "+bf29ce484222325"] {
            assert_eq!(de_hex64(malo), None, "{malo:?}");
        }
    }
}
