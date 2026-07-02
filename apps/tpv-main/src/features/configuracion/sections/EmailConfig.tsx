// src/features/configuracion/sections/EmailConfig.tsx
import React from "react";
import { Panel } from "../ui/Panel";

// Ya no hay configuración de correo (DB-04): todo el envío lo gestiona nuestro servicio a través
// del worker (Cloudflare Email Service / Resend). No hay SMTP propio ni credenciales que
// configurar, así que esta sección es solo informativa.
export function EmailConfig(_props: { darkMode: boolean }) {
  return (
    <div className="flex flex-col gap-4">
      <Panel
        title="Envío de correos"
        subtitle="Cómo se envían los correos de pedido a proveedores."
      >
        <div className="rounded-xl border border-border bg-surface-2 p-4 text-sm text-fg-muted">
          Los correos (por ejemplo, los pedidos a proveedores) se envían automáticamente a través de
          nuestro servicio. No necesitas configurar nada.
          <br />
          <br />
          El envío requiere conexión a internet: en modo sin conexión el correo no se puede enviar.
        </div>
      </Panel>
    </div>
  );
}
