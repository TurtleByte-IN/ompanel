import {
  EnvironmentId,
  OmpThreadMenuOperationError,
  ProviderInstanceId,
  ThreadId,
  type OmpCollabStatus,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import "~/index.css";

import { act, render } from "../../../test/render";

const commands = vi.hoisted(() => ({
  status: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  gist: vi.fn(),
  tree: vi.fn(),
}));

vi.mock(import("@t3tools/client-runtime/state/runtime"), async (original) => {
  const { serverEnvironment } = await import("../../state/server");
  const byAtom = new Map<unknown, (input: unknown) => unknown>([
    [serverEnvironment.getOmpThreadCollab, commands.status],
    [serverEnvironment.startOmpThreadCollab, commands.start],
    [serverEnvironment.stopOmpThreadCollab, commands.stop],
    [serverEnvironment.shareOmpThreadGist, commands.gist],
    [serverEnvironment.getOmpThreadBranchTree, commands.tree],
  ]);
  return {
    ...(await original()),
    runAtomCommand: (async (_registry: unknown, atom: unknown, input: unknown) =>
      byAtom.get(atom)!(input)) as never,
  };
});

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { OmpThreadDialogHost, ompThreadDialogAtom } from "./OmpThreadMenu";

const threadRef = {
  environmentId: EnvironmentId.make("local"),
  threadId: ThreadId.make("thread-omp"),
};
const instanceId = ProviderInstanceId.make("omp");
const input = { instanceId, threadId: threadRef.threadId };

const success = <A,>(value: A) => ({ _tag: "Success" as const, value });
const failure = (reason: OmpThreadMenuOperationError["reason"], message: string) =>
  AsyncResult.failure(Cause.fail(new OmpThreadMenuOperationError({ reason, message })));

const ROOM: OmpCollabStatus = {
  active: true,
  access: "view",
  link: "omp://join/room#read-key",
  webLink: "https://my.omp.sh/#room.read-key",
  relayConnected: true,
  participants: [
    { name: "host", role: "host" },
    { name: "ana", role: "guest", readOnly: true },
  ],
};

async function open(kind: "share-gist" | "share-live" | "branch-tree") {
  const screen = await render(<OmpThreadDialogHost />, { router: false });
  await act(async () => appAtomRegistry.set(ompThreadDialogAtom, { kind, threadRef, instanceId }));
  const button = (label: string) => {
    const found = [...document.body.querySelectorAll("button")].find(
      (element) => element.textContent === label,
    );
    expect(found, `button ${label}`).toBeDefined();
    return found!;
  };
  return Object.assign(screen, {
    text: () => document.body.textContent ?? "",
    button,
    click: (label: string) => act(async () => button(label).click()),
    [Symbol.asyncDispose]: async () => {
      await act(async () => appAtomRegistry.set(ompThreadDialogAtom, null));
      await screen[Symbol.asyncDispose]();
    },
  });
}

it("warns that Share live bypasses pairing and says when OMP is too old", async () => {
  commands.status
    .mockReset()
    .mockResolvedValue(
      failure(
        "needs_newer_omp",
        "Share live needs OMP RPC contract 1.7.0 or later; this Ompanel runs OMP 18.12.6-ompanel.3 (contract 1.6.0).",
      ),
    );
  commands.start.mockReset();
  await using screen = await open("share-live");
  await vi.waitFor(() => expect(screen.text()).toContain("needs OMP RPC contract 1.7.0"));
  expect(screen.text()).toContain("This link bypasses T3 pairing");
  expect(screen.button("Start sharing").disabled).toBe(true);
  expect(commands.start).not.toHaveBeenCalled();
});

it("starts a room, shows its links and QR code, then stops it", async () => {
  commands.status
    .mockReset()
    .mockResolvedValue(success({ active: false, participants: [] } satisfies OmpCollabStatus));
  commands.start.mockReset().mockResolvedValue(success(ROOM));
  commands.stop.mockReset().mockResolvedValue(success({ stopped: true }));
  await using screen = await open("share-live");
  await vi.waitFor(() => expect(screen.button("Start sharing").disabled).toBe(false));
  await screen.click("Start sharing");
  expect(commands.start).toHaveBeenCalledWith({
    environmentId: threadRef.environmentId,
    input: { ...input, access: "view" },
  });
  const values = [...document.body.querySelectorAll("input")].map((element) => element.value);
  expect(values).toEqual([ROOM.webLink, ROOM.link]);
  expect(document.body.querySelector("svg title")?.textContent).toContain("Live share link");
  expect(screen.text()).toContain("1 guest: ana");
  await screen.click("Stop sharing");
  expect(commands.stop).toHaveBeenCalledWith({ environmentId: threadRef.environmentId, input });
  expect(screen.button("Start sharing")).toBeDefined();
});

it("asks before sharing a gist and shows why gh refused", async () => {
  commands.gist
    .mockReset()
    .mockResolvedValue(
      failure(
        "gh_unavailable",
        "The GitHub CLI (gh) is not signed in. Run `gh auth login`, then try again. Nothing was uploaded.",
      ),
    );
  await using screen = await open("share-gist");
  expect(commands.gist).not.toHaveBeenCalled();
  await screen.click("Share as gist");
  expect(commands.gist).toHaveBeenCalledWith({ environmentId: threadRef.environmentId, input });
  expect(document.body.querySelector("[role=alert]")?.textContent).toContain(
    "Nothing was uploaded",
  );
});

it("shows the gist link, and says when OMP fell back to its share server", async () => {
  commands.gist
    .mockReset()
    .mockResolvedValue(
      success({ url: "https://my.omp.sh/s/1#k", gistUrl: null, truncated: false }),
    );
  await using screen = await open("share-gist");
  await screen.click("Share as gist");
  expect(document.body.querySelector("input")?.value).toBe("https://my.omp.sh/s/1#k");
  expect(screen.text()).toContain("Uploaded to OMP's share server");
});

it("draws the branch tree with the active path and the fork", async () => {
  const node = (entryId: string, parentId: string | null, kind: "user" | "assistant") => ({
    entryId,
    parentId,
    kind,
    preview: kind === "user" ? `ask ${entryId}` : "",
    timestamp: null,
    label: null,
  });
  commands.tree.mockReset().mockResolvedValue(
    success({
      nodes: [
        node("u1", null, "user"),
        node("a1", "u1", "assistant"),
        node("u2", "a1", "user"),
        node("u3", "a1", "user"),
      ],
      leafId: "u3",
      activePath: ["u1", "a1", "u3"],
    }),
  );
  await using screen = await open("branch-tree");
  await vi.waitFor(() => expect(screen.text()).toContain("2 branches"));
  const rows = [...document.body.querySelectorAll("[data-entry-id]")];
  expect(rows.map((row) => row.getAttribute("data-entry-id"))).toEqual(["u1", "a1", "u2", "u3"]);
  expect(
    rows.filter((row) => row.hasAttribute("data-active-path")).map((row) => row.textContent),
  ).toEqual(["ask u1", "Reply", "ask u3current"]);
});
