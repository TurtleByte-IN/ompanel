// A scripted stand-in for the short-lived `omp` processes `OmpControlService` starts: one-shot
// CLI commands and `--mode rpc` control servers. FAKE_OMP_CONTROL_SCRIPT names a JSON
// `FakeOmpControlScript` (fakeOmpControl.ts); FAKE_OMP_CONTROL_LOG names a JSON-lines file it
// appends its start and every inbound frame to.
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";

const env = process.env;
const script = JSON.parse(NodeFS.readFileSync(env.FAKE_OMP_CONTROL_SCRIPT, "utf8"));
const argv = process.argv.slice(2);

function log(entry) {
  if (env.FAKE_OMP_CONTROL_LOG) {
    NodeFS.appendFileSync(env.FAKE_OMP_CONTROL_LOG, `${JSON.stringify(entry)}\n`);
  }
}

/** Keeps the process alive until a signal stops it, like a hung omp. */
function hang() {
  log({ event: "hang", pid: process.pid });
  setInterval(() => {}, 1 << 30);
}

/** `config list`, `skill list`, `usage`: the command words after a leading `--profile <p>`. */
function cliCommand() {
  if (argv.includes("--version")) return "--version";
  const words = argv[0] === "--profile" ? argv.slice(2) : argv;
  const [first, second] = words;
  return ["config", "skill", "plugin", "agents"].includes(first) ? `${first} ${second}` : first;
}

log({ event: "start", pid: process.pid, argv, cwd: process.cwd() });

if (!argv.includes("--mode")) {
  const command = cliCommand();
  const output = script.cli?.[command];
  if (output === undefined) {
    process.stderr.write(`fake omp: no output scripted for \`${command}\`\n`);
    process.exitCode = 2;
  } else if (output.hang === true) {
    hang();
  } else {
    if (output.stderr !== undefined) process.stderr.write(output.stderr);
    if (output.stdout !== undefined) process.stdout.write(output.stdout);
    process.exitCode = output.exitCode ?? 0;
  }
} else {
  runRpc(script.rpc ?? {});
}

function runRpc(rpc) {
  /** UI responses by request id, and the steps waiting for one. */
  const uiResponses = new Map();
  const uiWaiters = new Map();
  let halted = false;

  const write = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
  const substitute = (value, id) =>
    JSON.parse(JSON.stringify(value).replaceAll('"$id"', JSON.stringify(id)));
  const waitForUi = (uiId) =>
    uiResponses.has(uiId)
      ? Promise.resolve(uiResponses.get(uiId))
      : new Promise((resolve) => uiWaiters.set(uiId, resolve));

  /** Runs `steps` for the command `frame`; false once a step ended the process or the chain. */
  async function run(steps, frame) {
    for (const step of steps) {
      if (halted) return false;
      if ("emit" in step) write(substitute(step.emit, frame?.id));
      else if ("respond" in step) {
        write({
          id: frame.id,
          type: "response",
          command: frame.type,
          success: true,
          ...(step.respond === null ? {} : { data: step.respond }),
        });
      } else if ("fail" in step) {
        write({
          id: frame.id,
          type: "response",
          command: frame.type,
          success: false,
          error: step.fail,
        });
      } else if ("raw" in step) process.stdout.write(step.raw);
      else if ("stderr" in step) process.stderr.write(step.stderr);
      else if ("await" in step) {
        const response = await waitForUi(step.await);
        if (response.cancelled === true && step.onCancel !== undefined) {
          return run(step.onCancel, frame);
        }
      } else if ("exit" in step) {
        halted = true;
        process.stdout.write("", () => process.exit(step.exit));
        return false;
      } else if ("hang" in step) {
        halted = true;
        hang();
        return false;
      }
    }
    return true;
  }

  void (async () => {
    if (!(await run(rpc.beforeReady ?? [], undefined))) return;
    write(rpc.ready);
    if (!(await run(rpc.afterReady ?? [], undefined))) return;
    const lines = NodeReadline.createInterface({ input: process.stdin });
    lines.on("line", (line) => {
      if (line.trim() === "") return;
      const frame = JSON.parse(line);
      log({ event: "frame", frame });
      if (halted) return;
      if (frame.type === "extension_ui_response") {
        uiResponses.set(frame.id, frame);
        uiWaiters.get(frame.id)?.(frame);
        uiWaiters.delete(frame.id);
        return;
      }
      void run(rpc.commands?.[frame.type] ?? [{ fail: `Unknown command: ${frame.type}` }], frame);
    });
    // Like OMP, a control server whose stdin closes exits.
    lines.on("close", () => {
      if (!halted) process.exit(0);
    });
  })();
}
