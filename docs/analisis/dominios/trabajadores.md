# D9 — Trabajadores (fichajes · turnos · horarios)

> **Ámbito.** Personal: ficha de trabajador (con PII), roles, **fichajes** (control horario, turno
> partido), **turnos** y **asignaciones** semanales, horario predeterminado.
> **Capas:** `crates/tpv-infra-sqlite/src/trabajadores.rs` (CRUD, turnos, asignaciones),
> `crates/tpv-infra-sqlite/src/login.rs` (**fichajes** `exec_punch`), `stats.rs` (lectura de horas),
> `use_cases/{trabajadores,login}.rs`, `apps/cloud-worker-licensing/src/domains/{trabajadores,login}/*`,
> FE `apps/tpv-main/src/features/trabajadores/*`.

## Nota de cohesión

El **control horario** (fichajes) vive en `login.rs` (fichar al identificarse), no en `trabajadores.rs`.
La lógica de jornada laboral está **repartida** entre `login.rs`, `stats.rs` y `trabajadores.rs`.

## Resumen de hallazgos

| ID | Sev | Título | Ubicación |
|----|-----|--------|-----------|
| TRAB-01 | 🟡 | Fichajes olvidados **nunca se auto-cierran** (`Cerrado_Automatico`/`Cierre_Motivo` sin uso) → jornadas ABIERTAS perpetuas | `login.rs:305-461`, esquema |
| TRAB-02 | 🟡 | `punch` acepta `hora_evento` del cliente **sin validar** → fraude horario (fichar a hora arbitraria) | `use_cases/login.rs:94`, `login.rs:305-313` |
| TRAB-03 | 🟡 | **PII sensible** (DNI, IBAN, Nº Seg. Social) en claro y **replicada a la nube** (Turso) | esquema `Trabajadores`, `create_trabajador` |
| TRAB-04 | 🟡 | `create_asignacion` **sin guard de doble asignación** (mismo trabajador/fecha/turno duplicable) | `trabajadores.rs:557` |
| TRAB-05 | 🔵 | Operaciones masivas (`copy_semana`, `set_predeterminado_desde_semana`) — revisar atomicidad/rendimiento | `trabajadores.rs:656,767` |
| TRAB-06 | 🔵 | Doble implementación Rust/worker de la lógica de **fichaje** (crítica) | `login.rs` ↔ `login.commands.ts` |

---

## Detalle de hallazgos

### TRAB-01 🟡 Fichajes olvidados no se cierran — CONFIRMADO
- **Ubicación:** el esquema tiene `Fichajes.Cerrado_Automatico`, `Cierre_Motivo` y `exec_punch`
  siempre los pone a `0`/`NULL` (`login.rs:404,452-454`). **No existe** ningún proceso que ponga
  `Cerrado_Automatico=1` (grep: cero coincidencias).
- **Fallo:** si un trabajador ficha entrada y **olvida** la salida, su fichaje queda `ABIERTO` **para
  siempre**. La comprobación de entrada del día siguiente filtra por `Fecha=hoy`, así que no le
  bloquea, pero el fichaje viejo nunca se cierra → las **horas trabajadas** que lee `stats` quedan
  corruptas (jornada sin fin) y el descuadre crece.
- **Impacto:** informes de horas incorrectos; infra de cierre automático diseñada pero **muerta**.
- **Arreglo:** implementar el cierre automático (job al arrancar / cambio de día que cierre las
  jornadas abiertas del día anterior con `Cerrado_Automatico=1`, `Cierre_Motivo` y, opcionalmente,
  una hora de cierre por defecto o marcarlas como incidencia para revisión).

### TRAB-02 🟡 Fichaje con hora arbitraria (fraude horario) — CONFIRMADO
- **Ubicación:** `punch` (`use_cases/login.rs:76-94`) pasa `hora_evento` del input al repo; `exec_punch`
  (`login.rs:313`) usa `hora_evento.unwrap_or_else(now)`. No hay validación de que la hora esté
  próxima a "ahora".
- **Fallo:** un cliente (o la Handy) puede fichar entrada/salida con una **hora arbitraria**
  (backdating/forward-dating) → manipulación del control horario.
- **Arreglo:** para fichajes normales, **ignorar** la hora del cliente y usar la del servidor/Main; si
  se permite corrección manual, restringirla a un rol admin y registrarla como ajuste auditable.

### TRAB-03 🟡 PII sensible replicada a la nube en claro — CONFIRMADO
- **Ubicación:** `Trabajadores` almacena `DNI`, `IBAN`, `Numero_Seguridad_Social` (además de
  teléfono). Todas las escrituras se replican a Turso (nube) en claro.
- **Fallo:** datos personales especialmente sensibles (bancarios, identificativos) viajan y se
  almacenan sin cifrar fuera del dispositivo → riesgo de privacidad/GDPR.
- **Arreglo:** valorar cifrado a nivel de campo para estos datos, minimizar su replicación (¿los
  necesita la nube/Handy?), y documentar el tratamiento. Cruce con DB-04 (secretos en BD).

### TRAB-04 🟡 Doble asignación de turno
- **Ubicación:** `create_asignacion` (`:557`) inserta sin comprobar que no exista ya una asignación
  para el mismo `ID_Trabajador`/`Fecha`/`ID_Turno`. No hay UNIQUE que lo impida.
- **Fallo:** un trabajador puede acabar con turnos duplicados el mismo día.
- **Arreglo:** comprobar duplicados antes de insertar o añadir un índice único adecuado.

### TRAB-05 🔵 Operaciones masivas de planning
- `copy_semana` (`:656`) y `set_predeterminado_desde_semana` (`:767`) mueven muchas filas. No
  analizadas en detalle; revisar que sean atómicas y no hagan N round-trips innecesarios.

### TRAB-06 🔵 Doble implementación de fichaje
- La lógica de `exec_punch` (turno partido, validaciones) existe en Rust y en el worker. Al ser
  **crítica** (control horario legal), una divergencia sería grave. **Arreglo:** tests de contrato
  exhaustivos Rust↔worker de todos los caminos de fichaje.

---

## Workflow de corrección (D9)

1. **TRAB-02 (fraude horario).** Usar hora de servidor para fichajes; corrección manual solo admin y
   auditada.
2. **TRAB-01 (auto-cierre).** Implementar el cierre automático de jornadas abiertas.
3. **TRAB-03 (PII).** Plan de tratamiento/cifrado de datos sensibles y minimización de replicación.
4. **TRAB-04 (doble asignación).** Guard/índice.
5. **TRAB-05/06 (robustez y parity).** Revisar operaciones masivas; tests de contrato de fichaje.

**Invariante clave:** el control horario debe ser **veraz** (hora de confianza), **completo** (sin
jornadas abiertas colgadas) e **idéntico** entre Main y Handy; la PII debe tratarse con el mínimo de
exposición.
