// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { OmpSettingsForm, OmpSignInState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";

import { makeOmpAccountsController, ompProjectSecrets } from "./accountsController.ts";
import { makeOmpControlService, type OmpControlTarget } from "./control.ts";
import { type FakeOmpScript, makeFakeOmpState } from "./testing/fakeOmp.ts";

const API_KEY = "gsk-k05-secret-api-key";

/** Every file under `dir`, recursively, as text. */
const filesUnder = (dir: string): ReadonlyArray<string> =>
  NodeFS.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => NodeFS.readFileSync(NodePath.join(entry.parentPath, entry.name), "utf8"));

const credentialField = (source: "project" | "global") => ({
  key: "auth.broker.token",
  group: "auth",
  type: "string" as const,
  description: "Broker bearer token",
  source,
  redacted: true,
  credential: true,
  readOnly: false,
  launchScoped: true,
  threadOverride: "none" as const,
});

/** A controller over a real fake-omp process; `stateDir` stands for Ompanel's state directory. */
const setup = (input: {
  readonly contract: string;
  readonly script: FakeOmpScript;
  readonly form?: OmpSettingsForm;
}) =>
  Effect.gen(function* () {
    const fake = yield* makeFakeOmpState;
    const stateDir = NodeFS.mkdtempSync(NodePath.join(fake.dir, "ompanel-state-"));
    const binaryPath = fake.executable();
    const environment = fake.env({
      FAKE_OMP_CONTRACT: input.contract,
      ...fake.script(input.script),
    });
    const target = (cwd: string) =>
      Effect.succeed<OmpControlTarget>({ binaryPath, profile: "", environment, cwd });
    const states: Array<OmpSignInState> = [];
    const accounts = yield* makeOmpAccountsController({
      control: yield* makeOmpControlService(),
      target,
      readSettings: () => Effect.succeed(input.form ?? { fields: [] }),
      globalCwd: stateDir,
    });
    yield* accounts.subscribe.pipe(
      Stream.runForEach((state) => Effect.sync(() => void states.push(state))),
      Effect.forkScoped,
    );
    const until = (check: (state: OmpSignInState) => boolean) =>
      accounts.subscribe.pipe(
        Stream.filter(check),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
        Effect.timeout("10 seconds"),
      );
    return { fake, stateDir, accounts, states, until };
  });

describe("OMP accounts controller", () => {
  it.live("relays a browser sign-in: open_url, then a pasted code through an input prompt", () =>
    Effect.gen(function* () {
      const { fake, accounts, until } = yield* setup({
        contract: "1.6.0",
        script: {
          commands: {
            login: [
              {
                emit: {
                  type: "extension_ui_request",
                  id: "ui-url",
                  method: "open_url",
                  url: "https://auth.example/authorize",
                  instructions: "Finish in the browser",
                },
              },
              // The prompt reuses the login's id, so the answer's steps can respond to the login.
              {
                emit: {
                  type: "extension_ui_request",
                  id: "$id",
                  method: "input",
                  title: "Paste the authorization code",
                },
              },
            ],
            extension_ui_response: [
              {
                emit: {
                  type: "response",
                  id: "$id",
                  command: "login",
                  success: true,
                  data: { providerId: "anthropic" },
                },
              },
            ],
          },
        },
      });
      const started = yield* accounts.start({ providerId: "anthropic", apiKey: undefined });
      assert.strictEqual(started.phase, "running");
      const asking = yield* until((state) => state.prompt !== null);
      assert.deepStrictEqual(asking.openUrl, {
        url: "https://auth.example/authorize",
        instructions: "Finish in the browser",
      });
      assert.strictEqual(asking.prompt?.title, "Paste the authorization code");
      assert.isFalse(asking.prompt?.secret);
      yield* accounts.answer({
        flowId: asking.flowId!,
        promptId: asking.prompt!.id,
        value: Redacted.make("code-123"),
      });
      const done = yield* until((state) => state.phase !== "running");
      assert.strictEqual(done.phase, "succeeded");
      assert.isNull(done.prompt);

      const [login, answer] = fake.commands();
      assert.deepInclude(login, { type: "login", providerId: "anthropic", secretInput: true });
      assert.notProperty(login, "input");
      assert.deepInclude(answer, { type: "extension_ui_response", value: "code-123" });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("hands an API key to omp only inside the RPC login command", () =>
    Effect.gen(function* () {
      const { fake, stateDir, accounts, states, until } = yield* setup({
        contract: "1.6.0",
        script: { commands: { login: [{ respond: { providerId: "groq" } }] } },
      });
      yield* accounts.start({ providerId: "groq", apiKey: Redacted.make(API_KEY) });
      const done = yield* until((state) => state.phase !== "running");
      assert.strictEqual(done.phase, "succeeded");

      // The key went over the process's stdin, inside `login`.
      const [login] = fake.commands();
      assert.deepInclude(login, { type: "login", providerId: "groq", input: API_KEY });
      // Never in argv, Ompanel's state directory, or any state the client sees.
      assert.notInclude(JSON.stringify(fake.argv()), API_KEY);
      for (const text of filesUnder(stateDir)) assert.notInclude(text, API_KEY);
      assert.notInclude(JSON.stringify(states), API_KEY);
      // A logged or traced Redacted value prints as a placeholder.
      assert.notInclude(String(Redacted.make(API_KEY)), API_KEY);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("never sends a key to an omp older than contract 1.6.0", () =>
    Effect.gen(function* () {
      const { fake, accounts, until } = yield* setup({
        contract: "1.3.0",
        script: { commands: { login: [{ respond: { providerId: "groq" } }] } },
      });
      yield* accounts.start({ providerId: "groq", apiKey: Redacted.make(API_KEY) });
      const done = yield* until((state) => state.phase !== "running");
      assert.strictEqual(done.phase, "failed");
      assert.include(done.message, "needs a newer OMP");
      assert.deepStrictEqual(fake.commands(), []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("refuses a second sign-in while one runs, and cancels a waiting one", () =>
    Effect.gen(function* () {
      const { accounts, until } = yield* setup({
        contract: "1.6.0",
        script: {
          commands: {
            login: [
              {
                emit: {
                  type: "extension_ui_request",
                  id: "ui-key",
                  method: "input",
                  title: "Paste your Mistral API key",
                  secret: true,
                },
              },
            ],
          },
        },
      });
      yield* accounts.start({ providerId: "mistral", apiKey: undefined });
      const asking = yield* until((state) => state.prompt !== null);
      assert.isTrue(asking.prompt?.secret);
      const busy = yield* accounts
        .start({ providerId: "groq", apiKey: undefined })
        .pipe(Effect.flip);
      assert.strictEqual(busy.reason, "busy");
      const cancelled = yield* accounts.cancel;
      assert.strictEqual(cancelled.phase, "cancelled");
      const stale = yield* accounts
        .answer({ flowId: asking.flowId!, promptId: asking.prompt!.id, value: undefined })
        .pipe(Effect.flip);
      assert.strictEqual(stale.reason, "not_found");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("lists providers with auth state and flags credentials in project config", () =>
    Effect.gen(function* () {
      const { accounts } = yield* setup({
        contract: "1.6.0",
        form: { fields: [credentialField("project")] },
        script: {
          commands: {
            get_login_providers: [
              {
                respond: {
                  providers: [
                    {
                      id: "anthropic",
                      name: "Anthropic",
                      available: true,
                      authenticated: true,
                      apiKey: false,
                      source: "oauth",
                    },
                    {
                      id: "openai",
                      name: "OpenAI",
                      available: true,
                      authenticated: true,
                      apiKey: true,
                      source: "env",
                      envVar: "OPENAI_API_KEY",
                    },
                    {
                      id: "groq",
                      name: "Groq",
                      available: true,
                      authenticated: false,
                      apiKey: true,
                    },
                  ],
                },
              },
            ],
          },
        },
      });
      const listed = yield* accounts.list({ cwd: "/work/repo" });
      assert.isTrue(listed.apiKeySignIn);
      assert.deepStrictEqual(listed.providers[1], {
        id: "openai",
        name: "OpenAI",
        available: true,
        authenticated: true,
        apiKey: true,
        source: "env",
        envVar: "OPENAI_API_KEY",
      });
      assert.deepStrictEqual(listed.projectSecrets, [
        { key: "auth.broker.token", path: "/work/repo/.omp/config.yml" },
      ]);
      assert.deepStrictEqual(ompProjectSecrets({ fields: [credentialField("global")] }, "/w"), []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("signs out one stored credential", () =>
    Effect.gen(function* () {
      const { fake, accounts } = yield* setup({
        contract: "1.6.0",
        script: {
          commands: {
            get_logout_accounts: [
              {
                respond: {
                  accounts: [
                    {
                      credentialId: 7,
                      provider: "groq",
                      label: "API key #7",
                      detail: "stored API key #7",
                      type: "api_key",
                      active: true,
                    },
                  ],
                },
              },
            ],
            logout: [{ respond: { remainingSource: "environment variable GROQ_API_KEY" } }],
          },
        },
      });
      const listed = yield* accounts.signOutAccounts({ providerId: "groq" });
      assert.strictEqual(listed.accounts[0]?.credentialId, 7);
      const result = yield* accounts.signOut({ providerId: "groq", credentialId: 7 });
      assert.deepStrictEqual(result, { remainingSource: "environment variable GROQ_API_KEY" });
      assert.deepInclude(fake.commands()[1], {
        type: "logout",
        providerId: "groq",
        credentialId: 7,
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
