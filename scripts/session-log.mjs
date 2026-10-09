/** Read supported durable generations without falling back from a newer log. */
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { zstdDecompressSync, constants } from "node:zlib";

export async function readSessionRows(runtime, id) {
  if (!/^session-[a-zA-Z0-9-]+$/.test(id)) throw Error("INVALID_SESSION_ID");
  const home = resolve(runtime, "home/sessions");
  let workspaces;
  try { workspaces = await readdir(home); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  for (const workspace of workspaces) {
    const directory = resolve(home, workspace, id);
    let files;
    try { files = await readdir(directory); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    const versions = files.flatMap(name => {
      const match = /^session\.v(\d+)\.jsonl\.zstd$/.exec(name);
      return match ? [{ name, version: Number(match[1]) }] : [];
    }).sort((a,b) => b.version-a.version);
    if (!versions.length) continue;
    const selected = versions[0];
    if (![3,4].includes(selected.version)) throw Error("UNSUPPORTED_SESSION_GENERATION: " + selected.version);
    const compressed = await readFile(resolve(directory, selected.name));
    let offset = 0, text = "";
    while (offset < compressed.length) {
      const frame = zstdDecompressSync(compressed.subarray(offset), { info: true, finishFlush: constants.ZSTD_e_flush });
      if (!frame.engine.bytesWritten) throw Error("INVALID_ZSTD_FRAME");
      offset += frame.engine.bytesWritten;
      text += frame.buffer.toString();
    }
    return text.trim().split("\n").map(JSON.parse);
  }
}
