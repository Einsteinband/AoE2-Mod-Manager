import { describe, it, expect } from "vitest";
import zh from "../locales/zh";
import en from "../locales/en";
import es from "../locales/es";
import de from "../locales/de";
import ru from "../locales/ru";
import { translateBackendMessage } from "../../format";
import { rawMessageOf } from "../../online/errors";

/**
 * R4 / R5 回归：用户可见文本不得硬编码，协议串哨兵必须落在语言包里。
 *
 * 这里做的是「源码扫描 + 语言包断言」，属于静态检查（A 级）：
 * 它能保证模板里不再出现硬编码 aria-label、下载队列分支判定的是 Rust 真正发射的码，
 * 但它不能替代真实 WebView2 里点一遍的验证（C 级）。
 *
 * 源码通过 Vite 的 `?raw` 导入读取，避免给单元测试引入 Node 类型依赖。
 */

const LOCALES = { zh, en, es, de, ru };

/** 所有 .vue 模板的原始源码（eager 读取，键是相对本文件的路径） */
const VUE_SOURCES = import.meta.glob("../../**/*.vue", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** 少数需要单独断言的 .ts 源文件 */
const TS_SOURCES = import.meta.glob("../../online/downloadQueue.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function sourceOf(key: string): string {
  return VUE_SOURCES[key] ?? TS_SOURCES[key] ?? "";
}

describe("硬编码用户可见文本（R4）", () => {
  it("模板里没有写死的 aria-label / placeholder 文案", () => {
    const offenders: string[] = [];
    for (const [file, content] of Object.entries(VUE_SOURCES)) {
      // 只看静态属性（attr="..."，不是 :attr 绑定）；绑定里再放字符串字面量也算硬编码
      const staticAttr = /(?<!:)(aria-label|placeholder)="([^"]*)"/g;
      const literalBinding = /(?<!:)(aria-label|placeholder)="'([^']*)'"/g;
      for (const match of content.matchAll(staticAttr)) {
        const value = match[2].trim();
        if (/^https?:\/\//.test(value)) continue; // 语言中立的 URL 示例
        if (/^(t|\$t|translate)\s*\(/.test(value)) continue; // 已走 i18n
        if (/[:{}$]/.test(value)) continue; // 绑定/插值表达式，不是硬编码文案
        offenders.push(`${file}: ${match[1]}="${value}"`);
      }
      for (const match of content.matchAll(literalBinding)) {
        offenders.push(`${file}: ${match[1]}='${match[2]}'（字符串字面量绑定）`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("这几个曾经硬编码的模板位置已经走语言包", () => {
    const download = sourceOf("../../components/DownloadManager.vue");
    expect(download).toContain("downloader.title");

    const importDialog = sourceOf("../../components/local/ImportDialog.vue");
    expect(importDialog).toContain("common.close");

    const wizard = sourceOf("../../components/FirstRunWizard.vue");
    expect(wizard).toContain("wizard.chipLocal");
    expect(wizard).toContain("wizard.chipSubscribed");
  });

  it("新增/使用的无障碍文案五语齐全", () => {
    for (const key of ["downloader.title", "common.close", "wizard.chipLocal", "wizard.chipSubscribed"]) {
      for (const [code, tree] of Object.entries(LOCALES)) {
        const parts = key.split(".");
        let node: unknown = tree;
        for (const part of parts) node = (node as Record<string, unknown> | undefined)?.[part];
        expect(typeof node, `${code} 缺 ${key}`).toBe("string");
      }
    }
  });
});

describe("错误串哨兵与下载队列分支（R5）", () => {
  it("前端不再使用 labels.unknown 这种伪 code 当哨兵", () => {
    const offenders = Object.entries(VUE_SOURCES)
      .filter(([, content]) => content.includes("aoe2mm:err:labels.unknown"))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });

  it("未知值兜底成 common.unknownError，并且五语都有文案", () => {
    for (const [code, tree] of Object.entries(LOCALES)) {
      const text = (tree as { backendErrors?: { code?: { common?: { unknownError?: string } } } })
        .backendErrors?.code?.common?.unknownError;
      expect(typeof text, `${code} 缺 common.unknownError`).toBe("string");
    }
    // 哨兵串必须能被翻译链路解析成文案，而不是原样透出
    const fallback = translateBackendMessage("aoe2mm:err:common.unknownError");
    expect(fallback).not.toContain("aoe2mm:err:");
    expect(rawMessageOf({ notAnError: true })).toBe("aoe2mm:err:common.unknownError");
  });

  it("下载队列识别的是 Rust 真正发射的 install.targetExistsForeign", () => {
    const queue = sourceOf("../../online/downloadQueue.ts");
    expect(queue).toContain("aoe2mm:err:install.targetExistsForeign");
    expect(queue).not.toContain("aoe2mm:err:install.overwriteRequired");
  });

  it("已确认无发射点的三个死键不再留在语言包里", () => {
    for (const [code, tree] of Object.entries(LOCALES)) {
      const backend = (tree as { backendErrors: { code: Record<string, Record<string, string> | undefined> } })
        .backendErrors;
      expect(backend.code.net?.timeout, `${code} net.timeout 应已清理`).toBeUndefined();
      expect(backend.code.install?.extractFailed, `${code} install.extractFailed 应已清理`).toBeUndefined();
      expect(backend.code.settings?.writeFailed, `${code} settings.writeFailed 应已清理`).toBeUndefined();
    }
  });
});
