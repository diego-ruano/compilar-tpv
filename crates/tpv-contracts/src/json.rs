#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(transparent)]
pub struct JsonDinamico(pub serde_json::Value);
impl specta::Type for JsonDinamico {
    fn definition(types: &mut specta::Types) -> specta::datatype::DataType {
        <specta_typescript::Unknown as specta::Type>::definition(types)
    }
}
