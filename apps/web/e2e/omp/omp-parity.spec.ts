// @effect-diagnostics nodeBuiltinImport:off - an end-to-end test reading the stack's files.
// PRD parity checks the G1 thread suite leaves out (program/evidence/parity, item Z-07): the
// Agents panel over a scripted fan-out, T3's checkpoint summary under an OMP turn, the Share live
// QR code, and a thread on a named OMP profile. Same harness as omp-thread.spec.ts: a real `omp`
// built from the omp.lock tag and the scripted local model. Steps run in order on one page.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { expect, test } from "@playwright/test";
import { QrCode } from "@t3tools/shared/qrCode";

import { useOmpSuite } from "./ompSuite.ts";
import { STREAMED_PARAGRAPHS, TOOL_REPLY_PREFIX } from "./scriptedModel.ts";

const ARTIFACTS =
  process.env.OMPANEL_E2E_ARTIFACTS_DIR === undefined
    ? NodePath.join(import.meta.dirname, "..", "..", ".playwright", "omp-parity-artifacts")
    : NodePath.join(process.env.OMPANEL_E2E_ARTIFACTS_DIR, "parity");

test.describe.configure({ mode: "serial" });

const suite = useOmpSuite({ artifacts: ARTIFACTS });

test("opens the Agents panel and lists fanned-out subagents", async () => {
  const { createOmpThread, page, screenshot, sendAndSettle } = suite.current();
  // Full access: the subagents start without an approval each.
  await createOmpThread("Full access");
  await sendAndSettle("fanout: parity-alpha, parity-beta");

  const toggle = page.getByRole("button", { name: "Toggle agents panel" });
  await toggle.click();
  const agents = page.getByRole("navigation", { name: "Agents" });
  for (const name of ["parity-alpha", "parity-beta"]) {
    await expect(
      agents.getByRole("button", { name: new RegExp(`${name}.*, Completed$`) }),
    ).toBeVisible();
  }
  await screenshot("01-agents-panel-completed");
  await toggle.click();
  await expect(agents).toHaveCount(0);
  // OMP runs `task` subagents in the background and reports their results in a follow-up turn.
  await expect(page.getByRole("button", { name: "Stop generation" })).toHaveCount(0);
});

test("shows T3's checkpoint summary under an OMP turn that changed a file", async () => {
  const { assistantSays, page, screenshot, sendAndSettle, stack } = suite.current();
  // README.md holds one committed line; the turn replaces it with two.
  await sendAndSettle("run: printf 'parity one\\nparity two\\n' > README.md && echo wrote-readme");
  await expect(assistantSays(`${TOOL_REPLY_PREFIX}wrote-readme`)).toBeVisible();
  expect(NodeFS.readFileSync(NodePath.join(stack.workspace, "README.md"), "utf8")).toBe(
    "parity one\nparity two\n",
  );

  const card = page.locator('[data-changed-files-state="tree"]').last();
  const header = card.locator("[data-changed-files-header]");
  await expect(header.getByText("1 changed file", { exact: true })).toBeVisible();
  await expect(header.getByRole("group", { name: "2 additions, 1 deletions" })).toBeVisible();
  await expect(header.getByRole("button", { name: "Open diff" })).toBeVisible();
  // The file's own row, with the same counts.
  await expect(
    card.getByRole("button", { name: "README.md 2 additions, 1 deletions", exact: true }),
  ).toBeVisible();
  await card.scrollIntoViewIfNeeded();
  await screenshot("02-checkpoint-summary");
});

/** Picks `label` in the OMP section of the thread's menu (the title button opens it). */
const pickOmpMenuItem = async (label: string) => {
  const { page } = suite.current();
  await page.locator("[data-thread-title-chevron]").click();
  await page.locator("div[data-level] button", { hasText: /^OMP$/ }).click();
  await page.locator("div[data-level] button", { hasText: new RegExp(`^${label}$`) }).click();
};

/** The dark modules of a `QRCodeSvg` path (`M<x> <y>h<run>v1H<x>z` per run), as `x,y`. */
const svgModules = (path: string, margin: number) =>
  new Set(
    [...path.matchAll(/M(\d+) (\d+)h(\d+)/g)].flatMap(([, x, y, run]) =>
      Array.from(
        { length: Number(run) },
        (_, offset) => `${Number(x) - margin + offset},${Number(y) - margin}`,
      ),
    ),
  );

const qrModules = (text: string) => {
  // OmpThreadMenu's QR: error correction level M.
  const qr = QrCode.encodeText(text, QrCode.Ecc.MEDIUM);
  const modules = new Set<string>();
  for (let y = 0; y < qr.size; y += 1) {
    for (let x = 0; x < qr.size; x += 1) if (qr.getModule(x, y)) modules.add(`${x},${y}`);
  }
  return { size: qr.size, modules };
};

test("shows the Share live browser link as a QR code, outside the trace", async () => {
  const { page, stack, untraced } = suite.current();
  await pickOmpMenuItem("Share live \\(outside pairing\\)…");
  const dialog = page.locator("[data-omp-share-live-dialog]");
  await expect(dialog.getByText("This link bypasses T3 pairing")).toBeVisible();

  // The links are capabilities: everything that shows them runs untraced, the screenshot masks
  // them, and the teardown scan fails the run if either reached a log, trace or artifact.
  await untraced(async () => {
    await dialog.getByRole("button", { name: "Start sharing" }).click();
    const browserLink = dialog.getByRole("textbox", { name: "Browser link" });
    const joinLink = dialog.getByRole("textbox", { name: "omp join link" });
    await expect(browserLink).toHaveValue(/^http:\/\/127\.0\.0\.1:\d+\//);
    const link = await browserLink.inputValue();
    stack.registerSecret("Share live browser link", link);
    stack.registerSecret("Share live join link", await joinLink.inputValue());

    const qr = dialog.getByRole("img", { name: "Live share link. Scan to open in a browser" });
    await expect(qr).toBeVisible();
    const box = await qr.boundingBox();
    expect(box?.width).toBe(148);
    // The QR holds exactly the browser link: its modules match an encoding of the link (margin 2).
    const expected = qrModules(link);
    const viewBox = await qr.getAttribute("viewBox");
    expect(viewBox).toBe(`0 0 ${expected.size + 4} ${expected.size + 4}`);
    const drawn = svgModules((await qr.locator("path").getAttribute("d")) ?? "", 2);
    expect(drawn.size).toBeGreaterThan(0);
    // A boolean, so a failure never prints anything derived from the link.
    expect(
      drawn.size === expected.modules.size &&
        [...drawn].every((cell) => expected.modules.has(cell)),
    ).toBe(true);

    const path = NodePath.join(ARTIFACTS, "03-share-live-qr.png");
    await page.screenshot({ path, mask: [qr, browserLink, joinLink] });
    await test.info().attach("03-share-live-qr", { path, contentType: "image/png" });

    await dialog.getByRole("button", { name: "Stop sharing" }).click();
    await expect(dialog.getByRole("button", { name: "Start sharing" })).toBeEnabled();
    await expect(qr).toHaveCount(0);
    await expect.poll(() => stack.collabRelay.openRooms()).toHaveLength(0);
  });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

const PROFILE = "parity-work";

test("launches an OMP thread on the instance's named profile", async () => {
  const { assistantSays, createOmpThread, page, screenshot, send, stack, threadId } =
    suite.current();
  // A named profile keeps its own config and sessions under ~/.omp/profiles/<name>; give it the
  // scripted model as `omp setup` would.
  const defaultAgentDir = NodePath.join(stack.home, ".omp", "agent");
  const profileAgentDir = NodePath.join(stack.home, ".omp", "profiles", PROFILE, "agent");
  NodeFS.mkdirSync(profileAgentDir, { recursive: true });
  for (const file of ["config.yml", "models.yml"]) {
    NodeFS.copyFileSync(NodePath.join(defaultAgentDir, file), NodePath.join(profileAgentDir, file));
  }

  await page.goto(new URL("/settings/providers", page.url()).href);
  await page.getByRole("button", { name: "Select OMP", exact: true }).click();
  const profile = page.getByRole("textbox", { name: "Profile", exact: true });
  await expect(profile).toHaveValue("");
  await profile.fill(PROFILE);
  await profile.press("Enter");
  await expect(profile).toHaveValue(PROFILE);
  await screenshot("04a-instance-profile");

  await page.goto(new URL("/", page.url()).href);
  await createOmpThread("Full access");
  await send("hello from the parity profile");
  await expect(assistantSays(STREAMED_PARAGRAPHS[1])).toBeVisible();
  const processes = stack.ompProcesses().filter((entry) => entry.threadId === threadId());
  expect(processes).toHaveLength(1);
  expect(processes[0]?.args).toContain(`--profile ${PROFILE}`);

  // OMP kept the session in the profile's directory, not the default one.
  const sessionsHolding = (agentDir: string) => {
    const dir = NodePath.join(agentDir, "sessions");
    return NodeFS.existsSync(dir)
      ? NodeFS.readdirSync(dir, { recursive: true, encoding: "utf8" })
          .filter((name) => name.endsWith(".jsonl"))
          .filter((name) =>
            NodeFS.readFileSync(NodePath.join(dir, name), "utf8").includes(
              "hello from the parity profile",
            ),
          )
      : [];
  };
  await expect.poll(() => sessionsHolding(profileAgentDir)).toHaveLength(1);
  expect(sessionsHolding(defaultAgentDir)).toEqual([]);
  await screenshot("04b-profile-thread");
});
