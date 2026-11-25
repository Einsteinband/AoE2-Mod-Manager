import { describe, expect, it } from "vitest";
import { classifyAuthError, isUnauthenticatedError } from "../sessionVerdict";
import type { ApiFailure } from "../types";

/**
 * 会话错误统一分类：401 / 网络 / 服务端 / 其他 四类必须和列表、下载队列、
 * 索引同步三处调用方口径一致，不能再各自按 kind 或中文正则判断。
 */
function failure(overrides: Partial<ApiFailure>): ApiFailure {
  return { kind: "http", message: "aoe2mm:err:api.serverHttpError", status: null, ...overrides };
}

describe("classifyAuthError", () => {
  it("kind=unauthenticated 判为凭证失效", () => {
    expect(classifyAuthError(failure({ kind: "unauthenticated", status: 401 }))).toBe(
      "unauthenticated",
    );
    expect(isUnauthenticatedError(failure({ kind: "unauthenticated", status: 401 }))).toBe(true);
  });

  it("即使 kind 缺失，status=401 也判为凭证失效", () => {
    expect(classifyAuthError(failure({ kind: "http", status: 401 }))).toBe("unauthenticated");
  });

  it("network / timeout / dns / offline 判为网络不可达", () => {
    for (const kind of ["network", "timeout", "dns", "offline"]) {
      expect(classifyAuthError(failure({ kind, status: null }))).toBe("network");
    }
  });

  it("5xx 判为服务端错误，404 归其他", () => {
    expect(classifyAuthError(failure({ kind: "http", status: 500 }))).toBe("server");
    expect(classifyAuthError(failure({ kind: "http", status: 502 }))).toBe("server");
    expect(classifyAuthError(failure({ kind: "not_found", status: 404 }))).toBe("other");
  });

  it("无 status 的 http 失败归服务端错误", () => {
    expect(classifyAuthError(failure({ kind: "http", status: null }))).toBe("server");
  });

  it("普通 Error 且不含网络特征词时归其他", () => {
    expect(classifyAuthError(new Error("boom"))).toBe("other");
  });

  it("传输层特征文案的 Error 判为网络不可达", () => {
    expect(classifyAuthError(new Error("tcp connect timed out"))).toBe("network");
  });
});
