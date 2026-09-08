//! Lista los certificados del almacén de Windows que **sirven para remitir a la AEAT**.
//!
//! ```text
//! pnpm verifactu:certificados
//! ```
//!
//! Es la primera de las dos comprobaciones manuales del tramo del envío, y la que **no toca la
//! clave privada**: sólo enumera. Enseña la huella (que es lo único que la aplicación guardará del
//! elegido), en qué almacén está y si se puede usar sin diálogos.
//!
//! ## Lo que se responde aquí
//!
//! - **¿Está el certificado donde el TPV lo va a buscar?** El almacén personal es *por usuario de
//!   Windows*: si la gestoría lo instaló con su sesión, el TPV corriendo como otro usuario no lo
//!   ve. Por eso cada línea dice `CurrentUser` o `LocalMachine`.
//! - **¿Se puede usar sin que salga un diálogo?** Un certificado con «protección alta» o con PIN de
//!   tarjeta no sirve para un job desatendido: pediría interfaz a las tres de la mañana.
//! - **¿Es de sello?** Sólo decide el endpoint (`www10` en vez de `www1`). No se le pregunta al
//!   usuario: se deduce.
//!
//! No sale nada más del certificado, y no hace falta que salga.

fn main() {
    #[cfg(not(windows))]
    {
        eprintln!("El almacén de certificados de Windows sólo existe en Windows.");
        std::process::exit(2);
    }

    #[cfg(windows)]
    {
        use tpv_application::ports::aeat::AeatClient;

        let rt = tokio::runtime::Runtime::new().expect("runtime");
        let cliente = tpv_infra_aeat::AeatAdapter::new();
        let certs = match rt.block_on(cliente.certificados()) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("No se pudo leer el almacén: {e}");
                std::process::exit(1);
            }
        };

        if certs.is_empty() {
            println!("No hay ningún certificado CON CLAVE PRIVADA en los almacenes personales.");
            println!();
            println!("Un `.cer` o un `.crt` no valen: sólo llevan la parte pública y no pueden");
            println!("autenticar nada. Hace falta el certificado instalado como se instala para");
            println!("Autofirma (doble clic en el `.p12`/`.pfx`, o desde la web de la FNMT).");
            println!();
            println!("Y ojo con la sesión: el almacén es por usuario de Windows. Si lo instaló");
            println!("otra persona con su sesión, hay que instalarlo también en esta.");
            return;
        }

        println!("{} certificado(s) utilizable(s):\n", certs.len());
        for (i, c) in certs.iter().enumerate() {
            println!("  [{}] {}", i + 1, c.sujeto);
            println!("      Emitido por : {}", c.emisor);
            println!("      Válido hasta: {}", c.valido_hasta);
            println!("      Almacén     : {}", c.almacen);
            println!("      Huella      : {}", c.huella);
            println!(
                "      Tipo        : {}",
                if c.es_sello {
                    "sello de entidad (va a la subsede www10/prewww10)"
                } else {
                    "persona física o representante (va a www1/prewww1)"
                }
            );
            println!(
                "      Uso sin PIN : {}",
                if c.uso_silencioso {
                    "sí — sirve para el envío automático"
                } else {
                    "NO — pedirá un diálogo o un PIN en cada envío (ver abajo)"
                }
            );
            println!();
        }

        if certs.iter().any(|c| !c.uso_silencioso) {
            println!("─────────────────────────────────────────────────────────────────────────");
            println!("Alguno de los certificados NO se puede usar sin interfaz de usuario.");
            println!();
            println!("Hay dos causas y sólo una tiene arreglo:");
            println!();
            println!("  · «Protección alta» de la clave privada: es una casilla del asistente de");
            println!("    importación que alguien marcó sin querer. Se arregla borrando el");
            println!("    certificado del almacén y volviéndolo a importar SIN marcarla.");
            println!();
            println!("  · PIN de una tarjeta, un DNIe o un token USB: es del hardware y no tiene");
            println!("    arreglo. Ese certificado no sirve para un envío desatendido.");
            println!();
            println!("Y una advertencia: esta comprobación NO es infalible. Con lectores con");
            println!("pinpad y drivers propios, Windows ignora la petición de silencio y saca el");
            println!("diálogo igual. Por eso existe `pnpm verifactu:probar-aeat`, que hace un");
            println!("handshake de verdad: si hay un PIN escondido, sale ahí y con alguien delante.");
        }
    }
}
