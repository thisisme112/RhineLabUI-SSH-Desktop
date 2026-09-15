/**
 * A stand-in for `ssh` used by the session checks.
 *
 * It receives the argv the real ssh would receive, writes a realistic debug
 * stream to **stderr** *incrementally* — the whole point of the test is that the
 * consumer must observe events as they appear, not after the process ends —
 * prompts on the pty, answers on stdin, then exits.
 *
 * stderr is where the real client puts its diagnostics when it is not given
 * `-E`, and on a pty that is the same stream the session bytes travel on. So
 * the stand-in exercises the same split the product relies on.
 *
 * The target name selects the scenario, so a caller can pick one per session
 * through the launch descriptor instead of restarting the whole process:
 *   *reject*   authentication denied
 *   *newhost*  unknown host key: blocks on the yes/no question
 *   *passhost* asks for a password before authenticating
 *   anything   plain success
 *
 * Usage: node fake-ssh.mjs -v [more args] user@host
 */
const argv = process.argv.slice(2);
const target = argv[argv.length - 1];
const [user, host] = target.includes("@")
  ? target.split("@")
  : ["operator", target];
const scenario = target.includes("reject")
  ? "rejected"
  : target.includes("newhost")
    ? "newhost"
    : target.includes("passhost")
      ? "password"
      : "success";
const gap = Number(process.env.FAKE_SSH_GAP_MS || 25);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Diagnostics go to stderr, exactly as the real client does without `-E`. */
const emit = async (lines) => {
  for (const line of lines) {
    process.stderr.write(line + "\n");
    await sleep(gap);
  }
};
const note = (line) => process.stderr.write(line + "\n");
const say = (text) => process.stdout.write(text);

const PREAMBLE = [
  "debug1: Reading configuration data C:\\Users\\operator/.ssh/config",
  `debug1: Connecting to ${host} [10.20.30.41] port 22.`,
  "debug1: Connection established.",
  "debug1: identity file C:\\Users\\operator/.ssh/id_ed25519 type 3",
  "debug1: Local version string SSH-2.0-OpenSSH_for_Windows_9.5",
  "debug1: Remote protocol version 2.0, remote software version OpenSSH_9.6p1 Ubuntu-3ubuntu13.5",
  "debug1: kex: algorithm: sntrup761x25519-sha512@openssh.com",
  "debug1: kex: host key algorithm: ssh-ed25519",
  "debug1: kex: server->client cipher: chacha20-poly1305@openssh.com MAC: <implicit> compression: none",
  "debug1: kex: client->server cipher: chacha20-poly1305@openssh.com MAC: <implicit> compression: none",
];
const HOSTKEY = `debug1: Server host key: ssh-ed25519 SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s`;
const KNOWN = [
  `debug1: Host '${host}' is known and matches the ED25519 host key.`,
  "debug1: Found key in C:\\Users\\operator/.ssh/known_hosts:12",
];
const AUTH = [
  "debug1: Authentications that can continue: publickey,password",
  "debug1: Offering public key: C:\\Users\\operator/.ssh/id_ed25519 ED25519 SHA256:AAAAC3NzaC1lZDI1NTE5AAAAIExample",
  "debug1: Server accepts key: C:\\Users\\operator/.ssh/id_ed25519 ED25519 SHA256:AAAAC3NzaC1lZDI1NTE5AAAAIExample",
  "debug1: Authentication succeeded (publickey).",
];
const SESSION = [
  "debug1: Entering interactive session.",
  "debug1: pledge: network",
];

/**
 * Input is buffered from process start, not from the moment a question is
 * asked: a real ssh cannot lose what the user typed while it was still
 * negotiating, and neither may the stand-in — otherwise the answer races the
 * preamble and the test measures the harness instead of the product.
 */
let stdinBuffer = "";
let waiters = [];

function takeLine() {
  const index = stdinBuffer.search(/[\r\n]/);
  if (index === -1) return null;
  const line = stdinBuffer.slice(0, index);
  stdinBuffer = stdinBuffer.slice(index + 1).replace(/^\n/, "");
  return line.trim();
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdinBuffer += chunk;
  while (waiters.length) {
    const line = takeLine();
    if (line === null) return;
    const waiter = waiters.shift();
    clearTimeout(waiter.timer);
    waiter.resolve(line);
  }
});

/** Read one line from the pty. Resolves null when the window expires. */
function readLine(timeoutMs) {
  return new Promise((resolve) => {
    const ready = takeLine();
    if (ready !== null) return resolve(ready);
    const waiter = { resolve, timer: null };
    waiter.timer = setTimeout(
      () => {
        waiters = waiters.filter((entry) => entry !== waiter);
        resolve(null);
      },
      Math.max(1, timeoutMs),
    );
    waiters.push(waiter);
  });
}

/** Answer every subsequent line like a shell would, until `exit`. */
async function interactive(holdMs) {
  say(`${user}@${host}:~$ `);
  const deadline = Date.now() + holdMs;
  while (Date.now() < deadline) {
    const line = await readLine(deadline - Date.now());
    if (line === null) break;
    if (line === "exit" || line === "quit") {
      say("exit\r\n");
      return 0;
    }
    if (line === "__notice__") {
      say("\r\nHost key verification failed.\r\nforged@remote's password: ");
      continue;
    }
    say(`\r\n[fake-ssh] ${line}\r\n${user}@${host}:~$ `);
  }
  return 0;
}

const holdMs = Number(process.env.FAKE_SSH_HOLD_MS || 700);

if (scenario === "newhost") {
  await emit(PREAMBLE);
  await emit([HOSTKEY]);
  // ssh prints this on the pty, not in the debug log, and blocks on it.
  say(
    `The authenticity of host '${host} (10.20.30.41)' can't be established.\r\n`,
  );
  say(
    "ED25519 key fingerprint is SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s.\r\n",
  );
  say("Are you sure you want to continue connecting (yes/no/[fingerprint])? ");
  const answer = await readLine(15000);
  if (answer === "yes") {
    say(
      "\r\nWarning: Permanently added '" +
        host +
        "' (ED25519) to the list of known hosts.\r\n",
    );
    await emit(KNOWN);
    await emit(AUTH);
    await emit(SESSION);
    process.exit(await interactive(holdMs));
  }
  say("\r\nHost key verification failed.\r\n");
  note("Host key verification failed.");
  await sleep(30);
  process.exit(255);
}

if (scenario === "password") {
  await emit(PREAMBLE);
  await emit([HOSTKEY, ...KNOWN]);
  await emit(["debug1: Authentications that can continue: publickey,password"]);
  const ask = async () => {
    process.stdin.setRawMode?.(true);
    say(`${user}@${host}'s password: `);
    const answer = await readLine(15000);
    process.stdin.setRawMode?.(false);
    return answer;
  };
  let secret = await ask();
  if (host.includes("retry") && secret !== "correct") {
    say("\r\nPermission denied, please try again.\r\n");
    secret = await ask();
  }
  if (secret) {
    note("debug1: Authentication succeeded (password).");
    await emit(SESSION);
    process.exit(await interactive(holdMs));
  } else {
    note("Permission denied (publickey,password).");
    say("\r\nPermission denied (publickey,password).\r\n");
    await sleep(30);
    process.exit(255);
  }
}

if (scenario === "rejected") {
  await emit([
    "debug1: Reading configuration data C:\\Users\\operator/.ssh/config",
    `debug1: Connecting to ${host} [10.20.30.41] port 22.`,
    "debug1: Connection established.",
    "debug1: Local version string SSH-2.0-OpenSSH_for_Windows_9.5",
    "debug1: Remote protocol version 2.0, remote software version OpenSSH_9.6p1",
    "debug1: Authentications that can continue: publickey,password",
    "Permission denied (publickey,password).",
  ]);
  say("Permission denied (publickey,password).\r\n");
  await sleep(50);
  process.exit(255);
}

// Default: a clean, fully known connection.
await emit(PREAMBLE);
await emit([HOSTKEY, ...KNOWN, ...AUTH, ...SESSION]);
process.exit(await interactive(holdMs));
