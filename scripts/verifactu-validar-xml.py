#!/usr/bin/env python3
"""Valida el XML que el TPV manda a la AEAT contra los **XSD oficiales**.

    pnpm verifactu:validar-xml

Genera las muestras con `cargo run -p tpv-infra-aeat --example muestras_xml` y las valida contra
`crates/tpv-infra-aeat/esquemas/`, que son los ficheros que publica la AEAT descargados tal cual.

## Por qué esto existe

Los tests de `xml.rs` comprueban reglas concretas (que tal campo esté, que tal otro no, que el
orden sea el del `sequence`). Eso caza los errores que uno sabe buscar.

El XSD es el contrato ENTERO, escrito por la AEAT. Validar contra él antes de conectarse convierte
el primer envío real en una comprobación de que el certificado funciona, y no en una sesión de
depuración a ciegas contra un servidor que sólo contesta «4102: el XML no cumple el esquema» sin
decir qué campo — y que además, cuando falla la cabecera, rechaza el ENVÍO COMPLETO.

## Qué caza y qué no

Comprobado a mano rompiendo las muestras a propósito, porque un validador que siempre dice «bien»
no vale nada. **Caza**: un campo obligatorio que falta (`TipoHuella`), el orden alterado del
`sequence`, un importe con coma decimal, una fecha en `AAAA-MM-DD` en vez de `DD-MM-AAAA`, un
`TipoFactura` que no está en la lista.

**No caza** las validaciones de NEGOCIO, que son las del documento de validaciones y no las del
esquema: que el NIF exista en el censo, que la huella cuadre con lo que calcula la AEAT o que un F2
no pase de 3.000 €. Eso sólo lo dice el servidor. Aquí se cierra la parte que se puede cerrar sin
red.

Requisito: `pip install xmlschema`.
"""

import subprocess
import sys
import tempfile
from pathlib import Path

# La consola de Windows va en cp1252 y no traga ni un guion largo. Se fuerza UTF-8 para que un
# fallo del validador se pueda LEER, que es justo cuando importa.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

RAIZ = Path(__file__).resolve().parent.parent
ESQUEMAS = RAIZ / "crates" / "tpv-infra-aeat" / "esquemas"

# El envío es un `RegFactuSistemaFacturacion` (SuministroLR.xsd) dentro de un sobre SOAP. El sobre
# no lo valida ningún XSD nuestro: lo que la AEAT valida es el CUERPO, así que se extrae y se
# valida contra el elemento raíz que declara el esquema.
NS_SOAP = "http://schemas.xmlsoap.org/soap/envelope/"
NS_LR = ("https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/"
         "aplicaciones/es/aeat/tike/cont/ws/SuministroLR.xsd")


def main() -> int:
    try:
        import xmlschema
    except ImportError:
        print("Falta `xmlschema`. Instálalo con:  pip install xmlschema", file=sys.stderr)
        return 2

    if not (ESQUEMAS / "SuministroLR.xsd").exists():
        print(f"No están los esquemas en {ESQUEMAS}", file=sys.stderr)
        return 2

    with tempfile.TemporaryDirectory() as tmp:
        print("Generando las muestras…")
        r = subprocess.run(
            ["cargo", "run", "-q", "-p", "tpv-infra-aeat", "--example", "muestras_xml", "--", tmp],
            cwd=RAIZ,
            capture_output=True,
            text=True,
        )
        if r.returncode != 0:
            print(r.stdout)
            print(r.stderr, file=sys.stderr)
            return 1

        muestras = sorted(Path(tmp).glob("*.xml"))
        if not muestras:
            print("El ejemplo no generó ninguna muestra.", file=sys.stderr)
            return 1

        print(f"Cargando los esquemas de {ESQUEMAS.relative_to(RAIZ)}…")
        esquema = xmlschema.XMLSchema(str(ESQUEMAS / "SuministroLR.xsd"))

        import xml.etree.ElementTree as ET

        fallos = 0
        for m in muestras:
            arbol = ET.parse(m)
            cuerpo = arbol.getroot().find(f"{{{NS_SOAP}}}Body")
            if cuerpo is None or len(cuerpo) == 0:
                print(f"  [FALLA] {m.name}: el sobre SOAP no tiene cuerpo")
                fallos += 1
                continue
            peticion = cuerpo[0]
            esperado = f"{{{NS_LR}}}RegFactuSistemaFacturacion"
            if peticion.tag != esperado:
                print(f"  [FALLA] {m.name}: el cuerpo es {peticion.tag}, se esperaba {esperado}")
                fallos += 1
                continue

            try:
                esquema.validate(peticion)
                print(f"  [OK] {m.name}")
            except Exception as e:  # xmlschema lanza varias clases de error de validación
                primera = str(e).strip().splitlines()
                resumen = " ".join(l.strip() for l in primera[:6])
                print(f"  ✗ {m.name}\n      {resumen}")
                fallos += 1

        print()
        if fallos:
            print(f"{fallos} de {len(muestras)} muestras NO cumplen el esquema de la AEAT.")
            return 1
        print(f"Las {len(muestras)} muestras cumplen el esquema oficial de la AEAT.")
        return 0


if __name__ == "__main__":
    sys.exit(main())
