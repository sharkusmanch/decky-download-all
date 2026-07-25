import { describe, expect, it } from "vitest";
import { getTotalBytes, DEFAULTS, type DownloadItem } from "../downloads";

const item = (over: Partial<DownloadItem>): DownloadItem => ({
  appid: 1, active: false, completed: false, paused: false,
  queue_index: -1, deferred_time: 0, update_type_info: [], ...over,
});

describe("getTotalBytes", () => {
  it("sums bytes_total across pending updates", () => {
    const d = item({ update_type_info: [
      { has_update: true, completed_update: false, progress: [{ bytes_total: 100, bytes_in_progress: 0 }, { bytes_total: 50, bytes_in_progress: 0 }] },
    ] });
    expect(getTotalBytes(d)).toBe(150);
  });
  it("ignores completed updates and missing info", () => {
    const d = item({ update_type_info: [
      { has_update: true, completed_update: true, progress: [{ bytes_total: 999, bytes_in_progress: 0 }] },
      { has_update: false, completed_update: false, progress: [{ bytes_total: 5, bytes_in_progress: 0 }] },
    ] });
    expect(getTotalBytes(d)).toBe(0);
    expect(getTotalBytes(item({ update_type_info: undefined }))).toBe(0);
  });
});

describe("DEFAULTS", () => {
  it("auto-queue is off by default at 15 min", () => {
    expect(DEFAULTS.autoQueue).toBe(false);
    expect(DEFAULTS.autoQueueIntervalMin).toBe(15);
    expect(DEFAULTS.mode).toBe("scheduled");
  });
});

import { parseDownloadItems } from "../downloads";

describe("parseDownloadItems", () => {
  const a = item({ appid: 1 }), b = item({ appid: 2 });

  it("legacy: items array in args[1]", () => {
    const r = parseDownloadItems([true, [a, b]]);
    expect(r.format).toBe("legacy");
    expect(r.items!.map(i => i.appid)).toEqual([1, 2]);
  });

  it("steamos38: picks the local machine (remote_client_id '0')", () => {
    const r = parseDownloadItems([true, [
      { remote_client_id: "0", item_data: [a] },
      { remote_client_id: "99", item_data: [b] },
    ]]);
    expect(r.format).toBe("steamos38");
    expect(r.items!.map(i => i.appid)).toEqual([1]);
  });

  // A delta about a remote client carries no local wrapper. Reporting [] there
  // would wipe the tracked downloads and leave the plugin blind until Steam next
  // mentions the local client, which it may not do for hours.
  it("steamos38 with no local entry → null (no news, not 'no downloads')", () => {
    const r = parseDownloadItems([true, [{ remote_client_id: "7", item_data: [a] }]]);
    expect(r.format).toBe("steamos38");
    expect(r.items).toBeNull();
  });

  it("steamos38 with an empty local entry → empty list (genuinely nothing)", () => {
    const r = parseDownloadItems([true, [{ remote_client_id: "0", item_data: [] }]]);
    expect(r.items).toEqual([]);
  });

  it("degenerate args → legacy empty", () => {
    expect(parseDownloadItems([]).items).toEqual([]);
    expect(parseDownloadItems([true, null]).items).toEqual([]);
  });
});

import { selectItemsToQueue, planQueueOps, type Settings } from "../downloads";

const sized = (appid: number, over: Partial<DownloadItem>, bytes: number): DownloadItem =>
  item({ appid, deferred_time: 1, ...over,
    update_type_info: [{ has_update: true, completed_update: false, progress: [{ bytes_total: bytes, bytes_in_progress: 0 }] }] });

const settings = (over: Partial<Settings> = {}) => ({ ...DEFAULTS, ...over });

describe("selectItemsToQueue", () => {
  it("all mode: every unqueued item, smallest first", () => {
    const dl = [sized(1, {}, 300), sized(2, {}, 100), item({ appid: 3, queue_index: 0 })];
    expect(selectItemsToQueue(dl, settings({ mode: "all" })).map(d => d.appid)).toEqual([2, 1]);
  });
  it("scheduled mode: only deferred_time > 0", () => {
    const dl = [sized(1, { deferred_time: 0 }, 100), sized(2, { deferred_time: 5 }, 100)];
    expect(selectItemsToQueue(dl, settings({ mode: "scheduled" })).map(d => d.appid)).toEqual([2]);
  });
  it("size-limit mode: scheduled and within maxSizeMB", () => {
    const dl = [sized(1, {}, 100 * 1024 * 1024), sized(2, {}, 9000 * 1024 * 1024)];
    const r = selectItemsToQueue(dl, settings({ mode: "size-limit", maxSizeMB: 5000 }));
    expect(r.map(d => d.appid)).toEqual([1]);
  });
  it("excludes already-queued items", () => {
    const dl = [item({ appid: 1, queue_index: 2, deferred_time: 1 })];
    expect(selectItemsToQueue(dl, settings({ mode: "all" }))).toEqual([]);
  });
});

import { verifyQueued, hasPendingUpdate } from "../downloads";

describe("hasPendingUpdate / phantom filtering", () => {
  it("excludes items whose update_type_info has no pending update", () => {
    const phantom = item({ appid: 9, update_type_info: [
      { has_update: false, completed_update: false },
      { has_update: true, completed_update: true },
    ] });
    expect(hasPendingUpdate(phantom)).toBe(false);
    expect(selectItemsToQueue([phantom], settings({ mode: "all" }))).toEqual([]);
  });
  it("keeps items with a pending update or no update info", () => {
    expect(hasPendingUpdate(sized(1, {}, 100))).toBe(true);
    expect(hasPendingUpdate(item({ update_type_info: undefined }))).toBe(true);
    expect(hasPendingUpdate(item({ update_type_info: [] }))).toBe(true);
  });
});

describe("verifyQueued", () => {
  it("confirms appids that moved into the queue, flags ones still at -1", () => {
    const dl = [item({ appid: 1, queue_index: 3 }), item({ appid: 2, queue_index: -1 })];
    expect(verifyQueued([1, 2], dl)).toEqual({ confirmed: [1], missing: [2] });
  });
  it("counts appids absent from the fresh list as confirmed", () => {
    expect(verifyQueued([5], [])).toEqual({ confirmed: [5], missing: [] });
    expect(verifyQueued([5], [item({ appid: 1, queue_index: -1 })])).toEqual({ confirmed: [5], missing: [] });
  });
  it("queue head (index 0) counts as confirmed", () => {
    expect(verifyQueued([1], [item({ appid: 1, queue_index: 0 })])).toEqual({ confirmed: [1], missing: [] });
  });
  it("empty appids → nothing to report", () => {
    expect(verifyQueued([], [item({ appid: 1 })])).toEqual({ confirmed: [], missing: [] });
  });
});

describe("planQueueOps", () => {
  it("appends below the current max queue index; resumes head or first item", () => {
    const items = [sized(2, {}, 100), sized(3, {}, 200)];
    const downloads = [item({ appid: 1, queue_index: 0 }), ...items];
    const plan = planQueueOps(items, downloads);
    expect(plan.ops).toEqual([{ appid: 2, index: 1 }, { appid: 3, index: 2 }]);
    expect(plan.resumeAppId).toBe(1);
  });
  it("with no active head, resumes the first queued item", () => {
    const items = [sized(2, {}, 100)];
    expect(planQueueOps(items, items).resumeAppId).toBe(2);
    expect(planQueueOps([], []).resumeAppId).toBeNull();
  });
});
