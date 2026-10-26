// @effect-diagnostics nodeBuiltinImport:off - a loopback Ompanel Connect relay for end-to-end tests.
// Stands in for the hosted relay's agent-activity endpoint, so a test can read exactly the state
// the server would hand the relay for push delivery (PHASES P-15). Every other relay route 404s.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

/** The parts of a published `RelayAgentActivityState` the tests read. */
export interface RelayStubState {
  readonly threadId: string;
  readonly phase: string;
  readonly threadTitle: string;
  readonly agentMessage?: { readonly id: string; readonly text: string; readonly sentAt: string };
}

export interface RelayStubPublication {
  readonly path: string;
  readonly state: RelayStubState | null;
}

export interface RelayStub {
  readonly url: string;
  /** Every agent-activity publish received so far, in arrival order. */
  readonly publications: () => ReadonlyArray<RelayStubPublication>;
  readonly close: () => Promise<void>;
}

const PUBLISH_PATH = /^\/v1\/environments\/[^/]+\/threads\/[^/]+\/agent-activity$/;

export const startRelayStub = async (): Promise<RelayStub> => {
  const received: Array<RelayStubPublication> = [];
  const server = NodeHttp.createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://relay.invalid").pathname;
    const chunks: Array<Buffer> = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (request.method !== "POST" || !PUBLISH_PATH.test(path)) {
        response.writeHead(404, { "content-type": "application/json" }).end("{}");
        return;
      }
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          readonly state: RelayStubState | null;
        };
        received.push({ path, state: body.state });
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ ok: true, deliveries: [] }));
      } catch {
        response.writeHead(400).end();
      }
    });
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
    publications: () => [...received],
    close: () => {
      const closed = Promise.withResolvers<void>();
      server.closeAllConnections();
      server.close(() => closed.resolve());
      return closed.promise;
    },
  };
};

/**
 * Links the server's environment to the stub the way a Connect sign-in would: the relay URL,
 * issuer, an environment credential, and agent-activity publishing on (`apps/server/src/cloud/config.ts`).
 */
export const linkToRelayStub = (secretsDir: string, relayUrl: string) => {
  NodeFS.mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  const secrets = {
    "cloud-relay-url": relayUrl,
    "cloud-relay-issuer": relayUrl,
    "cloud-relay-environment-credential": "e2e-relay-environment-credential",
    "cloud-publish-agent-activity": "true",
  };
  for (const [name, value] of Object.entries(secrets)) {
    NodeFS.writeFileSync(NodePath.join(secretsDir, `${name}.bin`), value, { mode: 0o600 });
  }
};
