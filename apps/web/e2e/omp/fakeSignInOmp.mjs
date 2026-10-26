// The control server `omp --mode rpc` of the G2 end-to-end test (fakeSignIn.ts): the real omp
// plus a login provider whose sign-in goes to a fake vendor on loopback. Frames pass through,
// except the provider's own `login`/`get_logout_accounts`/`logout` and the provider list it joins.
// Nothing reaches a real vendor.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";

const env = process.env;
const PROVIDER_ID = env.FAKE_SIGN_IN_PROVIDER_ID;
const PROVIDER_NAME = env.FAKE_SIGN_IN_PROVIDER_NAME;
const VENDOR_URL = env.FAKE_SIGN_IN_VENDOR_URL;
const STATE_FILE = env.FAKE_SIGN_IN_STATE;

const omp = NodeChildProcess.spawn(env.FAKE_SIGN_IN_OMP, process.argv.slice(2), {
  stdio: ["pipe", "pipe", "inherit"],
});
// Exit with omp's status once everything it wrote has been passed on.
omp.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal === null ? 0 : 1);
  process.stdin.destroy();
});
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => omp.kill(signal));

const write = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const respond = (command, data) =>
  write({ id: command.id, type: "response", command: command.type, success: true, data });
const fail = (command, error) =>
  write({ id: command.id, type: "response", command: command.type, success: false, error });

const signedIn = () =>
  NodeFS.existsSync(STATE_FILE) ? JSON.parse(NodeFS.readFileSync(STATE_FILE, "utf8")) : null;

let nextUiId = 0;
/** UI request ids this script sent, and who waits for their answer. */
const uiWaiters = new Map();
const askUi = (request) => {
  const id = `fake-sign-in-${nextUiId++}`;
  write({ type: "extension_ui_request", id, ...request });
  return id;
};

async function login(command) {
  const state = `state-${Date.now()}`;
  askUi({
    method: "open_url",
    url: `${VENDOR_URL}/authorize?state=${state}`,
    instructions: `Sign in to ${PROVIDER_NAME}, then paste the code it shows.`,
  });
  const inputId = askUi({
    method: "input",
    title: "Paste the authorization code",
    placeholder: "code",
    timeout: 600_000,
  });
  const answer = await new Promise((resolve) => uiWaiters.set(inputId, resolve));
  if (answer.cancelled === true || typeof answer.value !== "string") {
    fail(command, "Login cancelled");
    return;
  }
  const exchanged = await fetch(`${VENDOR_URL}/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: answer.value.trim(), state }),
  });
  if (!exchanged.ok) {
    fail(command, `${PROVIDER_NAME} rejected the code (${exchanged.status})`);
    return;
  }
  const token = await exchanged.json();
  NodeFS.writeFileSync(STATE_FILE, JSON.stringify({ email: token.email, access: token.access }));
  respond(command, { providerId: PROVIDER_ID });
}

const hostLines = NodeReadline.createInterface({ input: process.stdin });
hostLines.on("line", (line) => {
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    omp.stdin.write(`${line}\n`);
    return;
  }
  if (frame.type === "extension_ui_response" && uiWaiters.has(frame.id)) {
    uiWaiters.get(frame.id)(frame);
    uiWaiters.delete(frame.id);
  } else if (frame.type === "login" && frame.providerId === PROVIDER_ID) {
    void login(frame);
  } else if (frame.type === "get_logout_accounts" && frame.providerId === PROVIDER_ID) {
    const account = signedIn();
    respond(frame, {
      accounts:
        account === null
          ? []
          : [
              {
                credentialId: 1,
                provider: PROVIDER_ID,
                label: account.email,
                detail: "OAuth",
                type: "oauth",
                active: true,
              },
            ],
    });
  } else if (frame.type === "logout" && frame.providerId === PROVIDER_ID) {
    NodeFS.rmSync(STATE_FILE, { force: true });
    respond(frame, {});
  } else {
    omp.stdin.write(`${line}\n`);
  }
});
hostLines.on("close", () => omp.stdin.end());

const ompLines = NodeReadline.createInterface({ input: omp.stdout });
ompLines.on("line", (line) => {
  if (line.includes('"get_login_providers"')) {
    const frame = JSON.parse(line);
    if (frame.type === "response" && frame.success === true) {
      const account = signedIn();
      frame.data.providers.push({
        id: PROVIDER_ID,
        name: PROVIDER_NAME,
        available: true,
        authenticated: account !== null,
        apiKey: false,
        ...(account === null ? {} : { source: "oauth" }),
      });
      write(frame);
      return;
    }
  }
  process.stdout.write(`${line}\n`);
});
