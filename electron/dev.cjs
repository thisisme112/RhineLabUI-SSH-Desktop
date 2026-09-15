/**
 * Dev launcher: start Vite in desktop mode, wait for it, then open the desktop
 * shell pointed at it. Electron exits → Vite is stopped too, so
 * `npm run dev:desktop` is a single command with no orphans.
 *
 * The desktop dev server gets its own port and verifies what it finds there.
 * Reusing whatever happened to answer on the web preview's port silently served
 * the web build, which has no session layer — the window opened without any SSH
 * features and looked like a missing button rather than a wrong build.
 */
const { spawn } = require("node:child_process");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");

const HOST = process.env.RHINE_DEV_HOST || "127.0.0.1";
const root = path.join(__dirname, "..");

/** Nothing may collide with another project's dev server on this machine. */
const CANDIDATE_PORTS = [
  5175, 5176, 5177, 5178, 5179, 5180, 5181, 5182, 5183, 5184,
];

const isFree = (port) =>
  new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, HOST);
  });

async function pickPort() {
  const requested = Number(process.env.RHINE_DEV_PORT || 0);
  if (requested) return requested;
  for (const port of CANDIDATE_PORTS) if (await isFree(port)) return port;
  return null;
}

const probe = (url) =>
  new Promise((resolve) => {
    const request = http.get(url, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        return resolve({ ok: false, desktop: false });
      }
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
        if (body.length > 8192) response.destroy();
      });
      const finish = () =>
        resolve({
          ok: true,
          desktop: /name="rhine-host"\s+content="desktop"/.test(body),
        });
      response.on("end", finish);
      response.on("close", finish);
    });
    request.on("error", () => resolve({ ok: false, desktop: false }));
    request.setTimeout(1500, () => {
      request.destroy();
      resolve({ ok: false, desktop: false });
    });
  });

const waitForServer = async (url, timeoutMs = 60000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await probe(url);
    if (state.ok) return state;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return { ok: false, desktop: false };
};

(async () => {
  let port = await pickPort();
  if (!port) {
    console.error(
      `[desktop] no free port among ${CANDIDATE_PORTS.join(", ")}.\n` +
        `          Pick one explicitly:  $env:RHINE_DEV_PORT=5200; npm run dev:desktop`,
    );
    process.exit(1);
  }
  let url = `http://${HOST}:${port}/`;
  let vite = null;

  // An explicitly requested port may already be serving: reuse only if it is
  // genuinely the desktop build, otherwise fail loudly rather than open a
  // window with no session layer and let it look like a missing button.
  const existing = process.env.RHINE_DEV_PORT
    ? await probe(url)
    : { ok: false, desktop: false };
  if (existing.ok && !existing.desktop) {
    console.error(
      `[desktop] ${url} is answering, but it is not serving the desktop build.\n` +
        `          Something else is using that port. Choose another:  $env:RHINE_DEV_PORT=5200; npm run dev:desktop`,
    );
    process.exit(1);
  }

  if (!existing.ok) {
    console.log(`[desktop] starting Vite (mode=desktop) on ${url}`);
    vite = spawn(
      process.execPath,
      [
        path.join(root, "node_modules", "vite", "bin", "vite.js"),
        // Without this the dev server serves the web build and the session
        // layer never loads.
        "--mode",
        "desktop",
        "--host",
        HOST,
        "--port",
        String(port),
        "--strictPort",
      ],
      { cwd: root, stdio: "inherit" },
    );
    const ready = await waitForServer(url);
    if (!ready.ok) {
      console.error(`[desktop] Vite did not become ready on ${url}.`);
      vite.kill();
      process.exit(1);
    }
    if (!ready.desktop) {
      console.error(
        "[desktop] Vite started but is not serving the desktop build.",
      );
      vite.kill();
      process.exit(1);
    }
  } else {
    console.log(`[desktop] reusing the desktop dev server already on ${url}`);
  }

  const electron = spawn(
    process.execPath,
    [
      path.join(root, "node_modules", "electron", "cli.js"),
      root,
      ...process.argv.slice(2),
    ],
    {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, RHINE_DEV_URL: url },
    },
  );
  electron.on("exit", (code) => {
    if (vite) vite.kill();
    process.exit(code ?? 0);
  });
})();
