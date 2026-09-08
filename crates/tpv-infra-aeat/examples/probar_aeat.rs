//! **Prueba real contra el servicio web de la AEAT**, con un certificado del almacén de Windows.
//!
//! ```text
//! pnpm verifactu:probar-aeat -- <huella-del-certificado> [pruebas|produccion]
//! ```
//!
//! La huella sale de `pnpm verifactu:certificados`. El entorno por defecto es **pruebas**, y hay
//! que escribir `produccion` entero para ir al otro: los endpoints se distinguen en tres caracteres
//! (`prewww1` / `www1`), que es exactamente el tipo de error que se comete a las dos de la mañana.
//!
//! ## Qué hace exactamente
//!
//! Abre una conexión HTTPS **con el certificado como credencial de cliente** y manda un sobre SOAP
//! **sin ningún registro dentro**. Eso basta y es lo que se quiere: lo que se está probando es el
//! HANDSHAKE —que Windows puede firmar con esa clave sin pedir un diálogo, y que la AEAT acepta al
//! titular— y no el contenido. La respuesta será un error de esquema, y eso es la señal de éxito:
//! significa que la conexión se estableció y que el servidor nos leyó.
//!
//! ⚠️ **NO emite ninguna factura.** Un registro de facturación enviado a producción es un registro
//! real de ese NIF y **no se «borra»**: como mucho se anula con otro registro. Por eso la sonda va
//! vacía y por eso el entorno por defecto es preproducción.
//!
//! ## Qué se responde con esto
//!
//! - ¿El certificado que hay instalado sirve para el TLS mutuo con la AEAT?
//! - ¿Sale algún diálogo de PIN escondido que el flag de silencio no detectó?
//! - ¿Hay un proxy o un antivirus que intercepta el tráfico y rompe la cadena?
//! - ¿Está el titular del certificado autorizado sobre ese NIF? (esto sólo se ve del todo con un
//!   envío real, pero un `4112` aquí ya lo delata).

fn main() {
    #[cfg(not(windows))]
    {
        eprintln!("La remisión a la AEAT sólo está disponible en Windows.");
        std::process::exit(2);
    }

    #[cfg(windows)]
    {
        use tpv_application::ports::aeat::{AeatClient, EntornoAeat};

        let args: Vec<String> = std::env::args().skip(1).collect();
        let Some(huella) = args.first().cloned() else {
            eprintln!("Uso: pnpm verifactu:probar-aeat -- <huella> [pruebas|produccion]");
            eprintln!();
            eprintln!("La huella sale de `pnpm verifactu:certificados`.");
            std::process::exit(2);
        };

        let entorno = match args.get(1).map(String::as_str) {
            Some("produccion") => EntornoAeat::Produccion,
            _ => EntornoAeat::Pruebas,
        };

        if matches!(entorno, EntornoAeat::Produccion) {
            eprintln!("⚠️  Entorno de PRODUCCIÓN. La sonda va sin registros, así que no se emite");
            eprintln!("    ninguna factura — pero conviene saber dónde se está apuntando.");
            eprintln!();
        }

        let rt = tokio::runtime::Runtime::new().expect("runtime");
        let cliente = tpv_infra_aeat::AeatAdapter::new();

        // Primero se comprueba que el certificado sigue ahí, para dar un mensaje mejor que un
        // fallo de conexión cuando lo que pasa es que se ha renovado y cambiado de huella.
        match rt.block_on(cliente.certificados()) {
            Ok(certs) => {
                let h = huella.trim().to_uppercase().replace([' ', ':'], "");
                match certs.iter().find(|c| c.huella == h) {
                    Some(c) => {
                        println!("Certificado : {}", c.sujeto);
                        println!("Almacén     : {}", c.almacen);
                        println!("Válido hasta: {}", c.valido_hasta);
                        println!(
                            "Endpoint    : {}",
                            tpv_application::ports::aeat::endpoint(
                                entorno,
                                if c.es_sello {
                                    tpv_application::ports::aeat::TipoCertificado::Sello
                                } else {
                                    tpv_application::ports::aeat::TipoCertificado::Persona
                                },
                            )
                        );
                        println!();
                    }
                    None => {
                        eprintln!("Esa huella no está en el almacén. Lista los disponibles con:");
                        eprintln!("  pnpm verifactu:certificados");
                        std::process::exit(1);
                    }
                }
            }
            Err(e) => {
                eprintln!("No se pudo leer el almacén: {e}");
                std::process::exit(1);
            }
        }

        println!("Conectando…");
        match rt.block_on(cliente.probar_conexion(entorno, &huella)) {
            Ok(msg) => {
                println!();
                println!("{msg}");
                println!();
                println!("El handshake TLS con certificado de cliente FUNCIONA.");
                println!("Que la respuesta sea un error de esquema es lo esperado: la sonda va sin");
                println!("registros a propósito, para no emitir nada.");
            }
            Err(e) => {
                println!();
                eprintln!("Falló: {e}");
                eprintln!();
                eprintln!("Qué mirar, por orden de probabilidad:");
                eprintln!("  · ¿Salió un diálogo pidiendo un PIN o una contraseña? Entonces ese");
                eprintln!("    certificado no sirve para el envío automático (ver la nota de");
                eprintln!("    `pnpm verifactu:certificados`).");
                eprintln!("  · ¿El certificado está caducado o revocado?");
                eprintln!("  · ¿Hay un proxy o un antivirus con inspección TLS? Rompe la cadena.");
                eprintln!("  · Si dice 4112: el titular del certificado no está autorizado sobre");
                eprintln!("    ese NIF. La forma de esquivarlo es poner como obligado el MISMO NIF");
                eprintln!("    del certificado — entonces eres el titular y no hace falta nada más.");
                std::process::exit(1);
            }
        }
    }
}
