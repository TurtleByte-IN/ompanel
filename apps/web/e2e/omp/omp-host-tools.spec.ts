// @effect-diagnostics nodeBuiltinImport:off - an end-to-end test writing artifacts.
// T3's MCP tools in an OMP thread (docs/omp/host-tools.md): Ompanel issues the thread an MCP
// credential, the OMP driver hands every tool of Ompanel's MCP server to the real `omp` with
// `set_host_tools`, which OMP mounts as `xd://` devices; the scripted model calls one by name
// (`tool: <name> <json-args>`).
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { expect, test } from "@playwright/test";

import { useOmpSuite } from "./ompSuite.ts";
import {
  STREAMED_PARAGRAPHS,
  TOOL_REFUSED_PREFIX,
  TOOL_REPLY_PREFIX,
  type ScriptedModelCall,
} from "./scriptedModel.ts";

const ARTIFACTS =
  process.env.OMPANEL_E2E_ARTIFACTS_DIR ??
  NodePath.join(import.meta.dirname, "..", "..", ".playwright", "omp-artifacts");

test.describe.configure({ mode: "serial" });

const suite = useOmpSuite({ artifacts: ARTIFACTS });

// What the model was offered and sent, for the evidence: tool names and texts, no secrets.
test.afterEach(() => {
  NodeFS.writeFileSync(
    NodePath.join(ARTIFACTS, "host-tools-model-calls.json"),
    `${JSON.stringify(suite.current().stack.model.calls, null, 2)}\n`,
  );
});

/**
 * The model request that called `tool` (directly, or by writing to its `xd://` device), and the
 * next one, which carried its result back.
 */
const toolRoundTrip = (calls: ReadonlyArray<ScriptedModelCall>, tool: string) => {
  const at = calls.findIndex(
    (call) =>
      "calls" in call.reply &&
      call.reply.calls.some(
        (entry) =>
          entry.tool === tool || (entry.tool === "write" && entry.args.path === `xd://${tool}`),
      ),
  );
  return {
    request: at === -1 ? undefined : calls[at],
    result: at === -1 ? undefined : calls.slice(at + 1).find((call) => call.lastRole === "tool"),
  };
};

test("an OMP thread calls a T3 preview tool and gets its result in the turn", async () => {
  const { assistantSays, createOmpThread, page, screenshot, sendAndSettle, stack } =
    suite.current();
  // Full access: T3's tools run without an approval each.
  await createOmpThread("Full access");
  await sendAndSettle('tool: t3_preview_list {"limit":5}');

  const { request, result } = toolRoundTrip(stack.model.calls, "t3_preview_list");
  // OMP offered the model T3's tools: the terminal as a tool, and the MCP tools (preview and
  // delegation among them) as `xd://` devices, since a host tool without a `loadMode` is
  // "discoverable" and OMP mounts those.
  expect(request?.tools).toEqual(expect.arrayContaining(["terminal", "write"]));
  expect(request?.devices).toEqual(
    expect.arrayContaining(["t3_preview_list", "preview_open", "delegate_task"]),
  );
  // The thread's preview tabs (none yet), from Ompanel's MCP server.
  expect(result?.lastText).toContain('"sessions":[]');
  const firstLine = result?.lastText.trim().split("\n")[0] ?? "";
  await expect(assistantSays(`${TOOL_REPLY_PREFIX}${firstLine}`)).toBeVisible();
  await expect(page.getByRole("main").getByText(TOOL_REFUSED_PREFIX)).toHaveCount(0);
  // The turn's work log shows the device call as its tool entry.
  await page
    .getByRole("button", { name: /^Worked for / })
    .first()
    .click();
  await expect(
    page.getByRole("main").getByRole("button", { name: /^xd:\/\/t3_preview_list$/i }),
  ).toBeVisible();
  await screenshot("z04-01-preview-tool");
});

test("an OMP thread delegates to a child thread through delegate_task", async () => {
  const { assistantMessages, assistantSays, page, screenshot, sendAndSettle, stack } =
    suite.current();
  const title = "Z04 delegated child";
  const args = {
    task: "Say hello from the delegated child.",
    title,
    mode: "wait",
    timeoutMs: 120_000,
  };
  await sendAndSettle(`tool: delegate_task ${JSON.stringify(args)}`, 180_000);

  const { result } = toolRoundTrip(stack.model.calls, "delegate_task");
  // The parent's turn got the child's finished result: the scripted model's streamed reply.
  expect(result?.lastText).toContain('"status":"completed"');
  expect(result?.lastText).toContain(STREAMED_PARAGRAPHS[0]);
  // The parent's reply links the child thread by its title.
  await expect(assistantMessages().last()).toContainText(`${TOOL_REPLY_PREFIX}{"taskId"`);
  await expect(
    assistantMessages()
      .last()
      .getByRole("link", { name: `Thread, ${title}` }),
  ).toBeVisible();
  // The child ran on OMP with the scripted model, as a prompt of its own.
  expect(stack.model.calls.some((call) => call.lastText.endsWith(args.task))).toBe(true);
  await screenshot("z04-02-delegated-parent");

  // The child is the parent's delegated agent in its Lineage panel, and opens from there.
  const lineage = page.getByRole("region", { name: "Lineage" });
  await lineage.getByRole("button", { name: /^Previous agents/ }).click();
  const childRow = lineage.getByRole("button", { name: new RegExp(`^${title}`) });
  await expect(childRow).toBeVisible();
  await screenshot("z04-03-lineage");
  await childRow.click();
  // The child thread: a subagent of the parent, its task as the parent's message, the reply.
  await expect(page.getByRole("heading", { name: title, level: 2 })).toBeVisible();
  await expect(page.getByRole("main").getByText("Subagent of")).toBeVisible();
  await expect(page.getByRole("main").getByRole("button", { name: args.task })).toBeVisible();
  await expect(assistantSays(STREAMED_PARAGRAPHS[1])).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop generation" })).toHaveCount(0);
  await screenshot("z04-04-delegated-child");
});
