import { AlertTriangle } from "lucide-react";

/**
 * «Entra sin PIN» de la ficha del trabajador (`Usuarios.Sin_PIN`): el login y el fichaje no se lo
 * piden y basta con elegir su nombre. No se impide a nadie, tampoco a un administrador; a él se le
 * avisa de lo que supone antes de guardar.
 */
export default function CasillaSinPin({
  checked,
  onChange,
  esAdministrador,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  esAdministrador: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <label className="flex cursor-pointer select-none items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          className="accent-accent"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        Entra sin PIN
      </label>
      <p className="text-xs text-fg-subtle">
        Para entrar y fichar le basta con tocar su nombre en la pantalla de inicio.
      </p>

      {checked && esAdministrador ? (
        <div className="flex gap-2 rounded-xl border border-warning/30 bg-warning-soft p-2 text-xs text-warning">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p>
            Es administrador: sin PIN, cualquiera que toque su nombre entra en Configuración, los
            cierres de caja y las anulaciones, y lo que haga queda a su nombre.
          </p>
        </div>
      ) : null}
    </div>
  );
}
