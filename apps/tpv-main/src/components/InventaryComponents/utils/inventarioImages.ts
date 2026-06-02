// utils/inventarioImages.ts
import { convertFileSrc } from "@tauri-apps/api/core";
import { appDataDir, join } from "@tauri-apps/api/path";

export async function fileUrlFromAppData(relativePath: string | null | undefined) {
  const baseDir = await appDataDir();
  const safe = relativePath ?? "";
  return convertFileSrc(await join(baseDir, safe));
}
