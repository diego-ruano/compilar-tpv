// Verificación de un evento controlado: comprueba la recepción y la simbolización en Sentry.
// No provoca errores de negocio ni publica una release del updater.
import { readFileSync } from "node:fs";
import { sentryBuildConfig, sentryRequest, validateSentryTarget } from "./sentry-config.mjs";

const [file] = process.argv.slice(2);
const probe = JSON.parse(readFileSync(file, "utf8"));
if (!/^[0-9a-f]{32}$/.test(probe.eventId) || !probe.source || !Number.isInteger(probe.line)) {
  throw new Error("La prueba requiere eventId, source y line");
}
const config = sentryBuildConfig({ ...process.env, TPV_RELEASE_BUILD: "1" });
await validateSentryTarget(config);
let event;
for (let attempt = 0; attempt < 24; attempt++) {
  try {
    event = await (await sentryRequest(config, `projects/${config.org}/${config.project}/events/${probe.eventId}/`)).json();
    break;
  } catch (error) {
    if (!error.message.includes("HTTP 404") || attempt === 23) throw error;
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
}
const release = typeof event.release === "string" ? event.release : event.release?.version;
if (release !== config.release) throw new Error(`Evento recibido con release incorrecta: ${release}`);
if (event.platform !== "javascript") throw new Error("El evento no es de la Webview");
const exceptions = event.entries?.find(entry => entry.type === "exception")?.data.values ?? [];
const frames = exceptions.flatMap(value => value.stacktrace?.frames ?? []);
const mapped = frames.find(frame => (frame.filename ?? "").endsWith(probe.source) && frame.lineNo === probe.line);
if (!mapped) {
  console.log(JSON.stringify({ eventId: probe.eventId, release, errors: event.errors,
    frames: frames.map(frame => ({ file: frame.filename, line: frame.lineNo, column: frame.colNo })) }, null, 2));
  throw new Error("El evento llegó, pero la traza no recupera el archivo y la línea esperados");
}
console.log(JSON.stringify({ eventId: probe.eventId, release, platform: event.platform,
  environment: event.tags?.find(tag => tag.key === "environment")?.value,
  file: mapped.filename, line: mapped.lineNo, column: mapped.colNo,
  url: `https://${config.org}.sentry.io/issues/?query=${probe.eventId}` }, null, 2));
