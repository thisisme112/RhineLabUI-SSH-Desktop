/** Execute the reproducible insert script on the local Blender MCP add-on. */
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path
  .join(root, "art", "build_terminal.py")
  .replaceAll("\\", "/");
const code = `from pathlib import Path\np = Path(${JSON.stringify(script)})\nexec(compile(p.read_text(encoding='utf-8-sig'), str(p), 'exec'), {'__file__': str(p)})`;
const result = await new Promise((resolve, reject) => {
  const socket = net.createConnection({ host: "127.0.0.1", port: 9876 });
  let response = "";
  socket.setTimeout(120_000, () =>
    socket.destroy(new Error("Blender MCP timed out")),
  );
  socket.on("error", reject);
  socket.on("connect", () =>
    socket.write(JSON.stringify({ type: "execute_code", params: { code } })),
  );
  socket.on("data", (chunk) => {
    response += chunk.toString("utf8");
    let data;
    try {
      data = JSON.parse(response);
    } catch {
      return;
    }
    socket.end();
    if (data.status === "error") reject(new Error(data.message));
    else resolve(data.result);
  });
});
console.log(JSON.stringify(result, null, 2));
