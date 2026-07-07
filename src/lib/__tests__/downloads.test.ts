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
