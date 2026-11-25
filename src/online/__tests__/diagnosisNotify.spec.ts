import { beforeEach, describe, expect, it } from "vitest";

/**
 * 通知桥回归：订阅发布、同键去重、旧代际丢弃、重置后允许重新提示。
 */
import {
  diagnosisNotify,
  getLastDedupeKey,
  resetDiagnosisNotify,
  subscribeDiagnosisNotify,
} from "../diagnosisNotify";

beforeEach(() => {
  resetDiagnosisNotify();
});

describe("diagnosisNotify", () => {
  it("订阅者收到通知请求", () => {
    const received: unknown[] = [];
    const off = subscribeDiagnosisNotify((req) => received.push(req));
    diagnosisNotify({ key: "statusbar.toastDns", kind: "error", dedupeKey: "a", generation: 1 });
    expect(received).toHaveLength(1);
    off();
  });

  it("相同 dedupeKey 持续期间不重复发布", () => {
    const received: unknown[] = [];
    const off = subscribeDiagnosisNotify((req) => received.push(req));
    diagnosisNotify({ key: "statusbar.toastDns", kind: "error", dedupeKey: "dns:x", generation: 1 });
    diagnosisNotify({ key: "statusbar.toastDns", kind: "error", dedupeKey: "dns:x", generation: 2 });
    expect(received).toHaveLength(1);
    off();
  });

  it("旧代际（被取代轮次）的通知被丢弃，不覆盖新通知", () => {
    const received: Array<{ generation: number }> = [];
    const off = subscribeDiagnosisNotify((req) => received.push(req));
    diagnosisNotify({ key: "statusbar.toastOld", kind: "error", dedupeKey: "old", generation: 2 });
    diagnosisNotify({ key: "statusbar.toastNew", kind: "error", dedupeKey: "new", generation: 1 });
    expect(received).toHaveLength(1);
    expect(received[0].generation).toBe(2);
    off();
  });

  it("不同 dedupeKey 可以连续发布", () => {
    const received: unknown[] = [];
    const off = subscribeDiagnosisNotify((req) => received.push(req));
    diagnosisNotify({ key: "statusbar.toastNetworkRecovered", kind: "ok", dedupeKey: "recovered", generation: 3 });
    diagnosisNotify({ key: "statusbar.toastProxyChanged", kind: "ok", dedupeKey: "proxy:system", generation: 4 });
    expect(received).toHaveLength(2);
    off();
  });

  it("resetDiagnosisNotify 清空去重键，允许重新提示", () => {
    const received: unknown[] = [];
    const off = subscribeDiagnosisNotify((req) => received.push(req));
    diagnosisNotify({ key: "statusbar.toastDns", kind: "error", dedupeKey: "dns:x", generation: 1 });
    resetDiagnosisNotify();
    diagnosisNotify({ key: "statusbar.toastDns", kind: "error", dedupeKey: "dns:x", generation: 2 });
    expect(received).toHaveLength(2);
    expect(getLastDedupeKey()).toBe("dns:x");
    off();
  });

  it("解绑后不再收到通知", () => {
    const received: unknown[] = [];
    const off = subscribeDiagnosisNotify((req) => received.push(req));
    off();
    diagnosisNotify({ key: "statusbar.toastDns", kind: "error", dedupeKey: "x", generation: 1 });
    expect(received).toHaveLength(0);
  });
});
