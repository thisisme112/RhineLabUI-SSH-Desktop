/**
 * What the maid decides on this machine (the Unreal build's RhineClaudeUi.cpp and RhineClaude.cpp): which commands
 * only read, which paths hold secrets, which commands are not kept in her record, the words that make a command's
 * output a failure, a success or the command a risky one, and how long a line stays in her bubble.
 */

/** One line of plain text: nothing in it can press Enter, interrupt or escape. */
export const isOneLine = (text: string) => !/[\x00-\x1f\x7f]/.test(text);

/** How long an answer stays in her bubble: by its length, six seconds at least and half a minute at most. */
export const holdOf = (line: string) => Math.min(30, Math.max(6, 4 + [...line].length * .12));
/** A remark of her own is shorter-lived: five to fourteen seconds. */
export const remarkHoldOf = (line: string) => Math.min(14, Math.max(5, 3 + [...line].length * .15));

/** The bubble holds the start of a long answer; the panel holds all of it. */
export function bubbled(line: string) {
  const chars = [...line];
  if (chars.length <= 72) return line;
  // Up to the end of the first sentence that fits, or a clean cut.
  let cut = 64;
  for (let i = 12; i < Math.min(chars.length, 72); i++) if ("。！？\n".includes(chars[i])) { cut = i + 1; break; }
  return chars.slice(0, cut).join("").trimEnd() + "……（全文在对话面板）";
}

/** The words in a command's output that mean it failed, lower case. */
export const FAILURES = ["command not found", "permission denied", "no such file or directory", "error:", "error ", "fatal:", "traceback (most recent call last)",
  "segmentation fault", "core dumped", "failed", "failure", "connection refused", "connection timed out", "no space left on device", "out of memory",
  "killed", "panic:", "exception", "not recognized", "cannot ", "could not ", "unable to ", "denied", "syntax error"];
/** What makes a command a risky one, lower case. */
export const RISKS = ["rm -rf", "rm -fr", "mkfs", "dd if=", "shutdown", "reboot", "push --force", "push -f", "reset --hard", "drop table",
  "drop database", "chmod -r 777", "truncate ", "> /dev/sd", "kill -9", "systemctl stop"];
/** And the words of one that went well. */
export const SUCCESSES = ["passed", "succeeded", "successfully", "0 errors", "build finished", "all tests", "up to date", "done."];
export const hasAny = (lower: string, words: readonly string[]) => words.some(word => lower.includes(word));

/** A path that holds a key, a password or a token: never read without the reader's say, whatever the settings. */
export function isSecretPath(path: string) {
  const lower = path.toLowerCase();
  return [".ssh/", "id_rsa", "id_ecdsa", "id_ed25519", ".pem", ".key", ".p12", ".pfx", "shadow", ".env", "credential", ".netrc", ".pgpass", "secret",
    "token", "kubeconfig", ".kube/", ".aws/", ".docker/config", "private", "passwd", ".git-credentials"].some(mark => lower.includes(mark));
}

/** A command that seems to carry a secret on its line is not kept in her record. */
export function looksSecret(command: string) {
  const lower = command.toLowerCase();
  if (["password", "passwd=", "token=", "secret", "api_key", "apikey", "access_key", "private_key", "authorization:", "sk-ant-"].some(mark => lower.includes(mark))) return true;
  // mysql -pSecret and the like: a password glued to its flag.
  return lower.startsWith("mysql") && lower.includes(" -p") && !lower.includes(" -p ") && !lower.endsWith(" -p");
}

const PLAIN = ["ls", "cat", "head", "wc", "grep", "egrep", "fgrep", "df", "du", "free", "uptime", "whoami", "id", "pwd", "uname", "hostname", "date", "which",
  "whereis", "file", "stat", "ps", "lsblk", "lscpu", "nproc", "ss", "netstat", "lsof", "nvidia-smi", "tree", "realpath", "readlink", "getent", "last", "w",
  "who", "vmstat", "iostat", "dmesg", "findmnt", "mount", "env"];
const SYSTEMCTL = ["status", "is-active", "is-enabled", "is-failed", "list-units", "list-unit-files", "list-timers", "show", "cat"];
const DOCKER = ["ps", "images", "inspect", "version", "info", "logs"];
const GIT = ["status", "log", "diff", "show", "branch", "remote", "rev-parse", "describe", "blame", "ls-files"];

/**
 * A command that only reads: one plain command (nothing chained, piped, redirected, substituted or put in the
 * background), from a short list of programs, with none of their options that write, follow or page, and no secret
 * among its arguments. 设置 → 看板娘 can let these run without the reader's 运行.
 */
export function isReading(command: string) {
  if (/[;&|<>`$(){}\\!\n\r]/.test(command)) return false;
  const words = command.trim().split(/\s+/).filter(Boolean);
  if (!words.length || words.some(isSecretPath)) return false;
  const [first, second = ""] = words;
  const has = (option: string) => words.slice(1).some(word => word === option || word.startsWith(option + "="));
  if (PLAIN.includes(first)) {
    // env and mount with arguments run or change things; env alone prints every secret in the environment; dmesg -c clears the ring.
    if (first === "env") return false;
    if (first === "mount" && words.length > 1) return false;
    if (first === "dmesg" && (has("-c") || has("-C") || has("-w"))) return false;
    return true;
  }
  if (first === "tail") return !has("-f") && !has("-F") && !has("--follow");
  if (first === "find") return !["-exec", "-execdir", "-delete", "-ok", "-fprint", "-fprintf", "-fls"].some(has);
  if (first === "journalctl") return !has("-f") && !has("--follow") && !command.includes("--vacuum") && !has("--rotate") && !has("--flush");
  if (first === "ip") return ["a", "addr", "r", "route"].includes(second) || (second === "link" && (words.length === 2 || words[2] === "show"));
  if (first === "systemctl") return SYSTEMCTL.includes(second);
  if (first === "docker") {
    if (has("-f") || has("--follow")) return false;
    return DOCKER.includes(second) || (second === "stats" && has("--no-stream"));
  }
  if (first === "git") {
    if (!GIT.includes(second)) return false;
    if (second === "branch" && (has("-d") || has("-D") || has("-m"))) return false;
    return !(second === "remote" && words.length > 2 && words[2] !== "-v");
  }
  return false;
}
