import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { writeScreenedReport } from "../src/report-file";

it("saves large screened reports without environment transport and cannot overwrite or escape the output root",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"eai-report-root-"));
  const outside=await mkdtemp(path.join(os.tmpdir(),"eai-report-outside-"));
  try {
    const destination=path.join(root,"report.json");
    await writeScreenedReport(destination,{observations:"x".repeat(150_000)},root);
    expect(JSON.parse(await readFile(destination,"utf8")).observations.length).toBe(150_000);
    await expect(writeScreenedReport(destination,{replacement:true},root)).rejects.toThrow();
    await writeFile(path.join(outside,"sentinel"),"unchanged");
    await symlink(outside,path.join(root,"escape"));
    await expect(writeScreenedReport(path.join(root,"escape","sentinel"),{},root)).rejects.toThrow("escapes");
    expect(await readFile(path.join(outside,"sentinel"),"utf8")).toBe("unchanged");
  } finally { await Promise.all([rm(root,{recursive:true,force:true}),rm(outside,{recursive:true,force:true})]); }
});
