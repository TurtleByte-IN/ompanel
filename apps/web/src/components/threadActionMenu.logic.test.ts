import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadActionMenuItems,
  threadActionRequiresOperate,
  type ThreadActionMenuState,
} from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
  },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

describe("buildThreadActionMenuItems", () => {
  it.each([false, true])(
    "disables both lifecycle directions without permission (reversed: %s)",
    (reversed) => {
      const items = buildThreadActionMenuItems({
        ...baseState,
        canOperate: false,
        isPinned: reversed,
        isSettled: reversed,
        isSnoozed: reversed,
      });
      const expected = reversed
        ? [
            "unpin",
            "unsettle",
            "unsnooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ]
        : [
            "pin",
            "settle",
            "snooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ];
      expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(expected);
      expect(
        items.find((item) => item.id === "snooze")?.children?.every((child) => child.disabled) ??
          true,
      ).toBe(true);
    },
  );

  it("disables archive while the thread is running", () => {
    const archiveItem = buildThreadActionMenuItems({ ...baseState, isRunning: true }).find(
      (item) => item.id === "archive",
    );
    expect(archiveItem?.disabled).toBe(true);
  });
});

describe("the OMP section", () => {
  const ompSection = (state: ThreadActionMenuState) =>
    buildThreadActionMenuItems(state).find((item) => item.id === "omp");

  it("appears only on OMP threads", () => {
    expect(ompSection(baseState)).toBeUndefined();
    expect(
      ompSection({ ...baseState, isOmpThread: true })?.children?.map((item) => item.id),
    ).toEqual([
      "omp-export-html",
      "omp-share-gist",
      "omp-share-live",
      "omp-stop-live",
      "omp-branch-tree",
    ]);
  });

  it("keeps reading the thread for read-only clients and disables sharing it", () => {
    const section = ompSection({ ...baseState, canOperate: false, isOmpThread: true });
    expect(section?.disabled).toBeUndefined();
    expect(
      section?.children?.filter((item) => item.disabled === true).map((item) => item.id),
    ).toEqual(["omp-share-gist", "omp-share-live", "omp-stop-live"]);
    expect(threadActionRequiresOperate("omp-export-html")).toBe(false);
    expect(threadActionRequiresOperate("omp-branch-tree")).toBe(false);
    expect(threadActionRequiresOperate("omp-share-live")).toBe(true);
  });

  it("flags Share live as outside T3 pairing where it is offered", () => {
    const live = ompSection({ ...baseState, isOmpThread: true })?.children?.find(
      (item) => item.id === "omp-share-live",
    );
    expect(live?.label).toBe("Share live (outside pairing)…");
  });
});
