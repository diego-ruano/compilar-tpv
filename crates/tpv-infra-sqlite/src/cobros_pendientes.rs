//! RI-47: intenciones duraderas locales. Nunca se confunden con un pago confirmado.
use crate::ejecutor::Value;
use tpv_application::error::{AppError, AppResult};
use tpv_contracts::venta_rapida::{CobroPendienteDto, VrCobrarFraccionadoInput};
use tpv_contracts::verifactu::DestinatarioInput;
use tpv_domain::venta_rapida::CobroFraccionado;
use crate::db::{Reader, WriteGuard};
use crate::mapping::v_string;

fn error(e: impl std::fmt::Display) -> AppError { AppError::repository(e.to_string()) }

pub async fn listar(conn: &impl Reader) -> AppResult<Vec<CobroPendienteDto>> {
    let mut rows = conn.query("SELECT Datos_Json FROM _Cobros_Pendientes ORDER BY ID_Pago;", ()).await.map_err(error)?;
    let mut result = vec![];
    while let Some(row) = rows.next().await.map_err(error)? {
        let json = v_string(row.get_value(0).map_err(error)?).ok_or_else(|| AppError::repository("Cobro pendiente sin datos"))?;
        result.push(serde_json::from_str(&json).map_err(error)?);
    }
    Ok(result)
}

pub async fn escribir(g: &WriteGuard<'_>, pendiente: &CobroPendienteDto) -> AppResult<()> {
    g.raw().execute("INSERT INTO _Cobros_Pendientes (ID_Pago, Datos_Json) VALUES (?1, ?2) ON CONFLICT(ID_Pago) DO UPDATE SET Datos_Json = excluded.Datos_Json;",
        vec![Value::Text(pendiente.cobro.id_pago.clone()), Value::Text(serde_json::to_string(pendiente).map_err(error)?)]).await.map_err(error)?;
    Ok(())
}

pub async fn quitar(g: &WriteGuard<'_>, id: &str) -> AppResult<bool> {
    Ok(g.raw().execute("DELETE FROM _Cobros_Pendientes WHERE ID_Pago = ?1;", vec![Value::Text(id.into())]).await.map_err(error)? > 0)
}

pub async fn preparar(g: &WriteGuard<'_>, data: CobroFraccionado) -> AppResult<CobroPendienteDto> {
    let existentes = listar(g).await?;
    if let Some(p) = existentes.iter().find(|p| p.cobro.id_pago == data.id_pago) {
        if p.cobro.id_comanda != data.id_comanda || p.cobro.detalles != data.detalles || p.cobro.metodo != data.metodo.como_texto() {
            return Err(AppError::conflict("Ese identificador pertenece a otro cobro pendiente"));
        }
        // Recuperar nunca cambia el operador original ni pierde una factura solicitada.
        return Ok(p.clone());
    }
    if existentes.iter().any(|p| p.cobro.id_comanda == data.id_comanda && p.cobro.detalles.iter().any(|d| data.detalles.contains(d))) {
        return Err(AppError::conflict("Estas líneas tienen un cobro pendiente. Resuélvelo desde Cobros pendientes"));
    }
    // SYN-INC-05: con la escritura tomada, que es la que lleva después el cobro: entre esto y el
    // cobro no entra nada. Sólo al apuntar el cobro: al reintentar uno pendiente no se vuelve a
    // mirar, porque es la intención que ya se apuntó con esas líneas, y lo añadido después se cobra
    // aparte.
    if data.todo {
        crate::consultas::exigir_que_se_cobre_todo(g, &data.id_comanda, &data.detalles).await?;
    }
    let pendiente = CobroPendienteDto {
        cobro: VrCobrarFraccionadoInput {
            id_pago: data.id_pago, id_comanda: data.id_comanda, metodo: data.metodo.to_string(),
            importe_total: data.importe_total, detalles: data.detalles,
            destinatario: data.destinatario.map(|d| DestinatarioInput { nombre_razon: d.nombre_razon, nif: d.nif, domicilio: d.direccion }),
            todo: data.todo,
        },
        // Los apuntes históricos internos pueden no tener cobrador. El IPC siempre aporta la sesión.
        id_usuario: data.id_usuario_cobrador,
        id_trabajador: data.id_trabajador_cobrador, creado_en_ms: crate::util::now_ms(), ultimo_error: None,
    };
    escribir(g, &pendiente).await?;
    Ok(pendiente)
}
