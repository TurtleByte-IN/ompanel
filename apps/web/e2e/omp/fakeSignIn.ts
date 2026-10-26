// @effect-diagnostics nodeBuiltinImport:off globalDate:off - a loopback HTTP fixture.
// A fake login provider for the G2 end-to-end test, so a sign-in runs through Ompanel's real
// Accounts UI and OmpControlService without reaching a real vendor. OMP lists only built-in
// providers in its control servers (Ompanel starts them with `--no-extensions`), so the
// provider is added by a wrapper `omp`: control servers run `fakeSignInOmp.mjs`, which passes
// every frame to the real `omp` except those for the fake provider; every other `omp` start
// (threads, `omp config`, `omp -p`) execs the real binary, keeping its pid and command line.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

export const FAKE_SIGN_IN_PROVIDER = { id: "g2-fake-vendor", name: "G2 Fake Vendor" } as const;
export const FAKE_SIGN_IN_EMAIL = "g2@fake-vendor.test";

const PROXY = NodePath.join(import.meta.dirname, "fakeSignInOmp.mjs");
/** How every control server starts (`OMP_CONTROL_RPC_ARGS` in provider-omp's `control.ts`). */
const CONTROL_SERVER_ARGS = "--mode rpc --no-session --no-tools --no-extensions";

export interface FakeSignInVendor {
  readonly url: string;
  /** The codes the vendor accepted at its token endpoint, in order. */
  readonly exchanged: () => ReadonlyArray<string>;
  readonly close: () => Promise<void>;
}

/**
 * The vendor: `/authorize` shows a one-time code for its `state`, `/token` trades that code for a
 * token. Codes are random per page view.
 */
export const startFakeSignInVendor = async (): Promise<FakeSignInVendor> => {
  const codes = new Map<string, string>();
  const exchanged: string[] = [];
  const server = NodeHttp.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/authorize") {
      const code = `G2-${NodeCrypto.randomBytes(4).toString("hex")}`;
      codes.set(url.searchParams.get("state") ?? "", code);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        `<!doctype html><title>${FAKE_SIGN_IN_PROVIDER.name}</title>` +
          `<h1>${FAKE_SIGN_IN_PROVIDER.name}</h1>` +
          `<p>Signed in as ${FAKE_SIGN_IN_EMAIL}. Paste this code into Ompanel:</p>` +
          `<p><code data-fake-vendor-code>${code}</code></p>`,
      );
      return;
    }
    if (request.method === "POST" && url.pathname === "/token") {
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      request.on("end", () => {
        const { code, state } = JSON.parse(body) as { code?: string; state?: string };
        if (code === undefined || codes.get(state ?? "") !== code) {
          response.writeHead(400).end();
          return;
        }
        codes.delete(state ?? "");
        exchanged.push(code);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ access: `token-${code}`, email: FAKE_SIGN_IN_EMAIL }));
      });
      return;
    }
    response.writeHead(404).end();
  });
  const listening = Promise.withResolvers<number>();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    listening.resolve(typeof address === "object" && address !== null ? address.port : 0);
  });
  const port = await listening.promise;
  return {
    url: `http://127.0.0.1:${port}`,
    exchanged: () => exchanged,
    close: () => {
      const closed = Promise.withResolvers<void>();
      server.closeAllConnections();
      server.close(() => closed.resolve());
      return closed.promise;
    },
  };
};

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * Writes `<dir>/omp`: control servers go through the proxy with the fake provider, everything
 * else execs `binary`. The signed-in account lands in `<dir>/account.json`.
 */
export const writeFakeSignInOmp = (dir: string, binary: string, vendor: FakeSignInVendor) => {
  const wrapper = NodePath.join(dir, "omp");
  const environment = {
    FAKE_SIGN_IN_OMP: binary,
    FAKE_SIGN_IN_PROVIDER_ID: FAKE_SIGN_IN_PROVIDER.id,
    FAKE_SIGN_IN_PROVIDER_NAME: FAKE_SIGN_IN_PROVIDER.name,
    FAKE_SIGN_IN_VENDOR_URL: vendor.url,
    FAKE_SIGN_IN_STATE: NodePath.join(dir, "account.json"),
  };
  NodeFS.writeFileSync(
    wrapper,
    [
      "#!/bin/sh",
      `case " $* " in`,
      `  *" ${CONTROL_SERVER_ARGS} "*)`,
      `    ${Object.entries(environment)
        .map(([key, value]) => `${key}=${shellQuote(value)}`)
        .join(" ")} exec ${shellQuote(process.execPath)} ${shellQuote(PROXY)} "$@" ;;`,
      "esac",
      `exec ${shellQuote(binary)} "$@"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return { binary: wrapper, accountFile: environment.FAKE_SIGN_IN_STATE };
};
