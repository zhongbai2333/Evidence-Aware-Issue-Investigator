import path from "node:path";
import { realpath, writeFile } from "node:fs/promises";

export async function writeScreenedReport(destination: string, report: unknown, allowedRoot: string): Promise<void> {
  if (!path.isAbsolute(destination)) throw new Error("Report destination must be absolute and inside RUNNER_TEMP");
  const root = await realpath(allowedRoot);
  const parent = await realpath(path.dirname(destination));
  if (parent !== root && !parent.startsWith(`${root}${path.sep}`)) throw new Error("Report destination escapes RUNNER_TEMP");
  const text = JSON.stringify(report,null,2) + "\n";
  if (Buffer.byteLength(text) > 1024 * 1024) throw new Error("Screened report exceeds the file size budget");
  await writeFile(path.join(parent,path.basename(destination)),text,{flag:"wx",mode:0o600});
}
