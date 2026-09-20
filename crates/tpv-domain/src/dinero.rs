//! El tipo del **dinero** (ARQ-01). Un importe es un número **entero de céntimos**, y nada más.
//!
//! ## Por qué existe, si antes se decidió que no
//!
//! `cierre_caja.rs` decía: *«no se introduce aquí un tipo de dinero nuevo porque sería el único del
//! repo y la inconsistencia costaría más que el rigor que aporta»*. Era cierto **mientras fuera el
//! único**. Lo que cambió es que ahora el dinero es entero de punta a punta —columnas `INTEGER`,
//! `Dinero` en Rust, `Dinero` marcado en TypeScript—, así que ya no hay inconsistencia que pagar:
//! lo inconsistente pasa a ser el `f64` suelto.
//!
//! ## Qué compra ser entero
//!
//! Un `f64` no representa `0,10 €`, así que toda suma arrastraba un error y el código lo tapaba con
//! `(x * 100.0).round() / 100.0` repetido en 35 sitios y tres lenguajes, con **tres modos de
//! redondeo distintos** conviviendo (el de Rust aleja la mitad del cero, el de JavaScript la lleva
//! hacia +∞, y `ROUND()` de SQLite hace lo suyo). Con enteros no hay nada que redondear al sumar:
//! `SUM` en SQLite es exacto y **asociativo**, o sea que la Main y Turso obtienen el mismo número
//! sin importar el orden de las filas ni el motor. Eso es lo que permite dejar los agregados
//! derivados dentro del SQL —donde tienen que estar, porque `Total_Comanda` tiene dos escritores
//! (la Main por el outbox y la Handy por el Durable Object) y sólo converge si se re-deriva del
//! estado— y a la vez poder afirmar que convergen en vez de suponerlo.
//!
//! ## La trampa al mezclar con cantidades
//!
//! Las **cantidades** siguen siendo `REAL` a propósito (0,5 kg es fraccionario de verdad). Por eso
//! `Cantidad * Precio_Unitario` dentro de SQL **vuelve a ser un flotante**, y hay que devolverlo a
//! entero antes de sumar: `CAST(ROUND(Cantidad * Precio_Unitario) AS INTEGER)`. No es decoración:
//! sin el `CAST(ROUND(...))` se estaría sumando en coma flotante otra vez, con el agravante de que
//! parecería entero. El `ROUND` de SQLite y el `.round()` de Rust rompen el empate igual —alejando
//! del cero—, así que las dos implementaciones coinciden; `Math.round` de JavaScript **no**, y por
//! eso esa cuenta no se hace nunca en TypeScript.

use std::fmt;
use std::iter::Sum;
use std::ops::{Add, AddAssign, Neg, Sub, SubAssign};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Un importe, en céntimos enteros.
///
/// Cruza la frontera a TypeScript como un `number` **marcado**: un `number` corriente no se puede
/// asignar a un `Dinero` sin decirlo, y cualquier aritmética sobre él pierde la marca. Eso es lo
/// que convierte «se me ha olvidado convertir este importe» en un error de compilación en vez de
/// en un precio de `4750 €` en pantalla.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default, Serialize, Deserialize, TS,
)]
#[serde(transparent)]
// `export_to` SIN `export`: dice en que fichero vive el tipo, pero no genera aqui el test que lo
// escribe. Quien escribe `bindings.ts` es `tpv-contracts`, en una sola pasada, y arrastra a
// `Dinero` como dependencia de sus DTO. Con `export` en los dos sitios, cada tanda de tests es un
// proceso distinto y el segundo trunca lo que escribio el primero.
#[ts(export_to = "../../../packages/contracts/src/generated/bindings.ts")]
#[ts(type = "number & { readonly __centimos: unique symbol }")]
pub struct Dinero(i64);

impl Dinero {
    /// Ni un céntimo.
    pub const CERO: Dinero = Dinero(0);

    /// Construye desde céntimos. Es el constructor normal: la base de datos, la frontera con la UI
    /// y el resto del programa hablan en céntimos.
    pub const fn de_centimos(centimos: i64) -> Self {
        Dinero(centimos)
    }

    /// Los céntimos que hay dentro. Para guardar en SQLite y para mandar a la UI.
    pub const fn centimos(self) -> i64 {
        self.0
    }

    /// Construye desde euros en coma flotante, redondeando la mitad **lejos del cero**.
    ///
    /// Es la puerta de entrada desde lo que todavía es `f64` y no puede dejar de serlo: el
    /// resultado de multiplicar por una cantidad fraccionaria, o un tipo de IVA aplicado. No es
    /// para uso general — si tienes céntimos, usa [`Dinero::de_centimos`].
    ///
    /// Lo que no es finito cuenta como cero: un `NaN` que llegara aquí se propagaría a un importe,
    /// y un importe que no es un número no significa nada en un ticket.
    pub fn de_euros(euros: f64) -> Self {
        if !euros.is_finite() {
            return Dinero::CERO;
        }
        Dinero((euros * 100.0).round() as i64)
    }

    /// Los euros que representa, en coma flotante.
    ///
    /// Sólo para lo que sigue siendo `f64` por naturaleza (aplicar un tipo de IVA, repartir por un
    /// peso). **Nunca para guardar ni para mostrar**: guardar va en céntimos y mostrar va por el
    /// formateador.
    pub fn a_euros(self) -> f64 {
        self.0 as f64 / 100.0
    }

    /// El valor absoluto.
    pub fn abs(self) -> Self {
        Dinero(self.0.abs())
    }

    /// ¿Es exactamente cero? Con enteros esta pregunta por fin significa lo que parece.
    pub const fn es_cero(self) -> bool {
        self.0 == 0
    }

    /// ¿Falta dinero?
    pub const fn es_negativo(self) -> bool {
        self.0 < 0
    }

    /// Multiplica por un número de unidades enteras.
    pub const fn por(self, unidades: i64) -> Self {
        Dinero(self.0 * unidades)
    }

    /// Multiplica por un factor fraccionario, redondeando la mitad lejos del cero.
    ///
    /// Es lo que necesitan el IVA (`base = total / (1 + tipo/100)`) y el prorrateo de un cobro
    /// parcial. El redondeo ocurre **una vez, aquí**, y no en cada llamante.
    pub fn escala(self, factor: f64) -> Self {
        if !factor.is_finite() {
            return Dinero::CERO;
        }
        Dinero((self.0 as f64 * factor).round() as i64)
    }

    /// Divide por un divisor fraccionario, redondeando la mitad lejos del cero.
    ///
    /// **No es `escala(1.0 / divisor)`, y la diferencia se ve en el papel.** Multiplicar por el
    /// reciproco pierde un bit: la base de 0,91 EUR al 4 % sale 87,4999... por ese camino y 87,5
    /// dividiendo, que redondean a 87 y a 88. Lo caza la tabla de golden del ticket, que es
    /// exactamente para lo que esta.
    pub fn entre(self, divisor: f64) -> Self {
        if !divisor.is_finite() || divisor == 0.0 {
            return Dinero::CERO;
        }
        Dinero((self.0 as f64 / divisor).round() as i64)
    }

    /// El importe tal y como lo escribe la AEAT: punto decimal, **siempre** dos decimales, y sin
    /// `-0.00` (art. 21 de la Orden HAC/1177/2024 y los XSD de Veri\*factu).
    ///
    /// Esta cadena entra en la cadena de huella, así que es la representación canónica y no puede
    /// depender de cómo se formatee en ningún otro sitio. Con céntimos enteros, además, es una
    /// función total: no hay dos flotantes que den la misma cadena ni una cadena que dependa de
    /// cómo se llegó al número.
    pub fn texto_fiscal(self) -> String {
        let signo = if self.0 < 0 { "-" } else { "" };
        let abs = self.0.unsigned_abs();
        format!("{signo}{}.{:02}", abs / 100, abs % 100)
    }
    /// La inversa de [`Dinero::texto_fiscal`]: lee `"123.10"` y devuelve 12.310 céntimos.
    ///
    /// **Sin pasar por `f64`.** Lo que se lee aquí es el texto que se guardó en el registro de
    /// facturación, o sea el dato canónico; convertirlo a flotante y de vuelta sería reintroducir
    /// justo el rodeo del que este tipo existe para salir. Acepta cualquier número de decimales
    /// (redondea al céntimo alejándose del cero) porque el texto lo escribe la AEAT tanto como
    /// nosotros, y tolera el signo y los espacios.
    pub fn de_texto_fiscal(texto: &str) -> Option<Self> {
        let t = texto.trim();
        let (negativo, t) = match t.strip_prefix('-') {
            Some(resto) => (true, resto),
            None => (false, t.strip_prefix('+').unwrap_or(t)),
        };
        let (entera, decimal) = match t.split_once('.') {
            Some((a, b)) => (a, b),
            None => (t, ""),
        };
        if entera.is_empty() && decimal.is_empty() {
            return None;
        }
        if !entera.bytes().all(|c| c.is_ascii_digit())
            || !decimal.bytes().all(|c| c.is_ascii_digit())
        {
            return None;
        }
        let euros: i64 = if entera.is_empty() {
            0
        } else {
            entera.parse().ok()?
        };
        // Dos primeros decimales, y el tercero decide si se sube el céntimo.
        let mut d = decimal.bytes().map(|c| (c - b'0') as i64);
        let c1 = d.next().unwrap_or(0);
        let c2 = d.next().unwrap_or(0);
        let resto_sube = decimal.as_bytes().get(2).is_some_and(|c| *c >= b'5');
        let centimos = euros
            .checked_mul(100)?
            .checked_add(c1 * 10 + c2 + i64::from(resto_sube))?;
        Some(Dinero(if negativo { -centimos } else { centimos }))
    }
}

impl fmt::Display for Dinero {
    /// La representación canónica es la fiscal. Lo que ve la persona (`1.234,50 €`) lo pone el
    /// formateador de cada salida, que no es lo mismo en el papel que en pantalla.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.texto_fiscal())
    }
}

impl Add for Dinero {
    type Output = Dinero;
    fn add(self, otro: Dinero) -> Dinero {
        Dinero(self.0 + otro.0)
    }
}

impl Sub for Dinero {
    type Output = Dinero;
    fn sub(self, otro: Dinero) -> Dinero {
        Dinero(self.0 - otro.0)
    }
}

impl Neg for Dinero {
    type Output = Dinero;
    fn neg(self) -> Dinero {
        Dinero(-self.0)
    }
}

impl AddAssign for Dinero {
    fn add_assign(&mut self, otro: Dinero) {
        self.0 += otro.0;
    }
}

impl SubAssign for Dinero {
    fn sub_assign(&mut self, otro: Dinero) {
        self.0 -= otro.0;
    }
}

impl Sum for Dinero {
    fn sum<I: Iterator<Item = Dinero>>(iter: I) -> Dinero {
        Dinero(iter.map(|d| d.0).sum())
    }
}

impl<'a> Sum<&'a Dinero> for Dinero {
    fn sum<I: Iterator<Item = &'a Dinero>>(iter: I) -> Dinero {
        Dinero(iter.map(|d| d.0).sum())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// La tabla que comparten las TRES implementaciones del dinero.
    ///
    /// Si esto cambia, el worker y la webview se ponen rojos hasta igualarse: es lo unico que
    /// impide que las tres deriven, porque no pueden compartir codigo.
    fn casos() -> serde_json::Value {
        serde_json::from_str(include_str!("dinero_casos.json"))
            .expect("dinero_casos.json no es JSON valido")
    }

    fn n(v: &serde_json::Value) -> f64 {
        v.as_f64().expect("un caso tiene que ser un numero")
    }

    fn c(v: &serde_json::Value) -> i64 {
        v.as_i64().expect("los centimos son enteros")
    }

    #[test]
    fn de_euros_cuadra_con_la_tabla_compartida() {
        for caso in casos()["de_euros"].as_array().expect("falta «de_euros»") {
            let (euros, centimos) = (n(&caso[0]), c(&caso[1]));
            assert_eq!(
                Dinero::de_euros(euros),
                Dinero::de_centimos(centimos),
                "de_euros({euros})"
            );
        }
    }

    #[test]
    fn el_texto_fiscal_cuadra_con_la_tabla_compartida() {
        for caso in casos()["texto_fiscal"].as_array().expect("falta «texto_fiscal»") {
            let (centimos, texto) = (c(&caso[0]), caso[1].as_str().unwrap());
            assert_eq!(
                Dinero::de_centimos(centimos).texto_fiscal(),
                texto,
                "texto_fiscal({centimos})"
            );
        }
    }

    #[test]
    fn dividir_cuadra_con_la_tabla_compartida() {
        for caso in casos()["entre"].as_array().expect("falta «entre»") {
            let (cent, divisor, esperado) = (c(&caso[0]), n(&caso[1]), c(&caso[2]));
            assert_eq!(
                Dinero::de_centimos(cent).entre(divisor),
                Dinero::de_centimos(esperado),
                "{cent} entre {divisor}"
            );
        }
    }

    #[test]
    fn escalar_cuadra_con_la_tabla_compartida() {
        for caso in casos()["escalar"].as_array().expect("falta «escalar»") {
            let (cent, factor, esperado) = (c(&caso[0]), n(&caso[1]), c(&caso[2]));
            assert_eq!(
                Dinero::de_centimos(cent).escala(factor),
                Dinero::de_centimos(esperado),
                "{cent} por {factor}"
            );
        }
    }

    #[test]
    fn sumar_cuadra_con_la_tabla_compartida() {
        for caso in casos()["sumar"].as_array().expect("falta «sumar»") {
            let suma: Dinero = caso[0]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| Dinero::de_centimos(c(v)))
                .sum();
            assert_eq!(suma, Dinero::de_centimos(c(&caso[1])), "{:?}", caso[0]);
        }
    }

    #[test]
    fn sumar_es_exacto_donde_el_flotante_no_lo_era() {
        // 0,10 + 0,20 en f64 daba 0,30000000000000004 y había que redondear para compararlo.
        let a = Dinero::de_centimos(10);
        let b = Dinero::de_centimos(20);
        assert_eq!(a + b, Dinero::de_centimos(30));

        // Mil líneas de 0,10 €: en f64 la suma se desviaba; aquí no hay desviación posible.
        let suma: Dinero = std::iter::repeat(Dinero::de_centimos(10)).take(1000).sum();
        assert_eq!(suma, Dinero::de_centimos(10_000));
    }

    #[test]
    fn el_descuadre_cero_es_cero_de_verdad() {
        // La razón de ser de `a_centimos` en el arqueo: que un descuadre de 0,004 € no se enseñara
        // como descuadre. Con enteros la pregunta no necesita tolerancia.
        let esperado = Dinero::de_centimos(12_345);
        let contado = Dinero::de_centimos(12_345);
        assert!((contado - esperado).es_cero());
    }

    #[test]
    fn de_euros_aleja_la_mitad_del_cero_tambien_en_negativo() {
        // El fallo encontrado al inventariar: `ticketMath.ts` usaba `Math.round`, que lleva la
        // mitad hacia +∞, así que la vista previa y el papel discrepaban en medio céntimo negativo.
        // Esta es la única regla, y ahora sólo existe en un sitio por lenguaje.
        assert_eq!(Dinero::de_euros(1.125), Dinero::de_centimos(113));
        assert_eq!(Dinero::de_euros(-1.125), Dinero::de_centimos(-113));
        assert_eq!(Dinero::de_euros(2.675), Dinero::de_centimos(268));
        assert_eq!(Dinero::de_euros(-2.675), Dinero::de_centimos(-268));
        assert_eq!(Dinero::de_euros(-0.005), Dinero::de_centimos(-1));
    }

    #[test]
    fn el_redondeo_es_el_mismo_que_el_de_la_pantalla() {
        // Tabla repetida a proposito en `apps/tpv-main/test/efectivo.test.ts`: la pantalla del
        // cierre ensena el arqueo antes de confirmar y tiene que redondear igual que lo que se
        // guarda. `f64::round` aleja la mitad del cero y el `Math.round` de JavaScript no
        // (-12,5 -> -12), asi que si esto cambia, alli hay que cambiar `aCentimos`.
        //
        // Vivia en `cierre_caja.rs` cuando la regla era de la caja. Ahora es del dinero entero:
        // esta es la unica puerta por la que un f64 se convierte en un importe.
        for (entrada, centimos) in [
            (0.125, 13i64),
            (-0.125, -13),
            (0.005, 1),
            (-0.005, -1),
            (1.005, 100),
            (2.675, 268),
            (0.1 + 0.2, 30),
            (-0.004, 0),
        ] {
            assert_eq!(
                Dinero::de_euros(entrada),
                Dinero::de_centimos(centimos),
                "de_euros({entrada})"
            );
        }
    }

    #[test]
    fn lo_que_no_es_un_numero_cuenta_como_cero() {
        assert_eq!(Dinero::de_euros(f64::NAN), Dinero::CERO);
        assert_eq!(Dinero::de_euros(f64::INFINITY), Dinero::CERO);
        assert_eq!(Dinero::de_centimos(100).escala(f64::NAN), Dinero::CERO);
    }

    #[test]
    fn el_texto_fiscal_lleva_siempre_dos_decimales() {
        // Lo exige el XSD de Veri*factu, y esta cadena entra en la cadena de huella.
        assert_eq!(Dinero::de_centimos(12_310).texto_fiscal(), "123.10");
        assert_eq!(Dinero::de_centimos(12_345).texto_fiscal(), "123.45");
        assert_eq!(Dinero::CERO.texto_fiscal(), "0.00");
        assert_eq!(Dinero::de_centimos(5).texto_fiscal(), "0.05");
        assert_eq!(Dinero::de_centimos(-1_250).texto_fiscal(), "-12.50");
    }

    #[test]
    fn de_texto_fiscal_es_la_inversa_exacta() {
        // Ida y vuelta sobre el dato canonico del registro de facturacion.
        for c in [0i64, 5, 99, 100, 12_310, -1_250, -1, 100_000_000] {
            let d = Dinero::de_centimos(c);
            assert_eq!(Dinero::de_texto_fiscal(&d.texto_fiscal()), Some(d), "{c}");
        }
    }

    #[test]
    fn de_texto_fiscal_admite_lo_que_escribe_la_aeat() {
        assert_eq!(Dinero::de_texto_fiscal("123.10"), Some(Dinero::de_centimos(12_310)));
        assert_eq!(Dinero::de_texto_fiscal("123"), Some(Dinero::de_centimos(12_300)));
        assert_eq!(Dinero::de_texto_fiscal("0.5"), Some(Dinero::de_centimos(50)));
        assert_eq!(Dinero::de_texto_fiscal(" -12.50 "), Some(Dinero::de_centimos(-1_250)));
        assert_eq!(Dinero::de_texto_fiscal("+3.00"), Some(Dinero::de_centimos(300)));
        // Un tercer decimal redondea, alejandose del cero como el resto del tipo.
        assert_eq!(Dinero::de_texto_fiscal("1.005"), Some(Dinero::de_centimos(101)));
        assert_eq!(Dinero::de_texto_fiscal("-1.005"), Some(Dinero::de_centimos(-101)));
        assert_eq!(Dinero::de_texto_fiscal("1.004"), Some(Dinero::de_centimos(100)));
    }

    #[test]
    fn de_texto_fiscal_rechaza_lo_que_no_es_un_importe() {
        for malo in ["", " ", "-", "abc", "1,50", "1.2.3", "1e5", "12.5x"] {
            assert_eq!(Dinero::de_texto_fiscal(malo), None, "{malo:?}");
        }
    }

    #[test]
    fn el_texto_fiscal_no_puede_escribir_menos_cero() {
        // Un «-0,00 €» en un ticket no significa nada, y en un registro fiscal el signo SÍ. Con
        // enteros esto deja de ser un caso que haya que recordar: -0 no existe.
        assert_eq!(Dinero::CERO.texto_fiscal(), "0.00");
        assert_eq!(Dinero::de_euros(-0.001).texto_fiscal(), "0.00");
    }

    #[test]
    fn escalar_redondea_una_sola_vez() {
        // Base de un total de 12,10 € al 21 %: 12,10 / 1,21 = 10,00 exactos.
        let total = Dinero::de_centimos(1_210);
        let base = total.escala(1.0 / 1.21);
        assert_eq!(base, Dinero::de_centimos(1_000));
        // Y la cuota es LO QUE FALTA, nunca un segundo redondeo (§11).
        assert_eq!(total - base, Dinero::de_centimos(210));
    }

    #[test]
    fn dividir_no_es_multiplicar_por_el_reciproco() {
        // 0,91 EUR al 4 %: por el reciproco sale 87 y dividiendo sale 88, que es lo que imprime
        // el papel. La diferencia es un bit de f64 y se ve en un ticket de bar.
        let total = Dinero::de_centimos(91);
        assert_eq!(total.entre(1.04), Dinero::de_centimos(88));
        assert_eq!(total.escala(1.0 / 1.04), Dinero::de_centimos(87));
    }

    #[test]
    fn base_mas_cuota_dan_el_total_en_el_caso_que_lo_rompia() {
        // 0,39 € al 4 % era el primer caso en que redondear las dos por separado daba
        // 0,38 + 0,02 = 0,40 en el papel.
        let total = Dinero::de_centimos(39);
        let base = total.escala(1.0 / 1.04);
        let cuota = total - base;
        assert_eq!(base + cuota, total, "el papel no puede decir otra cosa");
    }

    #[test]
    fn por_unidades() {
        assert_eq!(Dinero::de_centimos(250).por(3), Dinero::de_centimos(750));
    }

    #[test]
    fn comparar_y_ordenar_sin_tolerancia() {
        let mut v = vec![
            Dinero::de_centimos(300),
            Dinero::de_centimos(-50),
            Dinero::de_centimos(0),
        ];
        v.sort();
        assert_eq!(
            v,
            vec![
                Dinero::de_centimos(-50),
                Dinero::CERO,
                Dinero::de_centimos(300)
            ]
        );
    }

    #[test]
    fn serde_lo_escribe_como_un_numero_pelado() {
        // `#[serde(transparent)]`: en el JSON de la frontera es 4750, no {"0":4750}.
        let json = serde_json::to_string(&Dinero::de_centimos(4_750)).unwrap();
        assert_eq!(json, "4750");
        let vuelta: Dinero = serde_json::from_str("4750").unwrap();
        assert_eq!(vuelta, Dinero::de_centimos(4_750));
    }
}
