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
    expect(r.items.map(i => i.appid)).toEqual([1, 2]);
  });

  it("steamos38: picks the local machine (remote_client_id '0')", () => {
    const r = parseDownloadItems([true, [
      { remote_client_id: "0", item_data: [a] },
      { remote_client_id: "99", item_data: [b] },
    ]]);
    expect(r.format).toBe("steamos38");
    expect(r.items.map(i => i.appid)).toEqual([1]);
  });

  it("steamos38 with no local entry → empty", () => {
    const r = parseDownloadItems([true, [{ remote_client_id: "7", item_data: [a] }]]);
    expect(r.format).toBe("steamos38");
    expect(r.items).toEqual([]);
  });

  it("degenerate args → legacy empty", () => {
    expect(parseDownloadItems([]).items).toEqual([]);
    expect(parseDownloadItems([true, null]).items).toEqual([]);
  });
});
