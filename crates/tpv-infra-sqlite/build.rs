fn main() {
    // include_dir! embebe los SQL, pero no registra sus rutas en Cargo. Vigilar la carpeta
    // detecta modificaciones, altas y bajas sin tener que tocar migrations.rs (RI-49).
    println!("cargo:rerun-if-changed=../../packages/database/migrations");
}
