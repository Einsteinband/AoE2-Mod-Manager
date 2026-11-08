import { i18n, translate } from "./i18n";
import type { ModSource } from "./types";

/**
 * 后端报错的多语言兜底（唯一出处，所有页面都经由这里）。
 *
 * Rust 侧消息目前仍是中文，本文件提供**两级**翻译，两级都不命中时原样返回原文，绝不吞掉信息：
 *   ① 错误码协议 `aoe2mm:err:<code>:<json>`
 *      —— Rust 迁移到错误码后走这条。文案放在语言包的 `backendErrors.code` 段（点分即嵌套），
 *         参数（路径 / modId / 字节数…）用 `{name}` 占位符注入。
 *         新增语言只翻译语言包，后端永远不用为语言改动。
 *   ② 旧版中文原文
 *      —— 按下面的关键词表转成**当前界面语言**（不是写死英文）；
 *         该语言缺 key 时 vue-i18n 会自动回落到 en，加新语言不会出现空白。
 *
 * 第二项是 `backendErrors.pattern` 下的 key，文案本体一律不进代码。
 */
/**
 * 整句锚定模板：`^…$` 从头到尾匹配整条后端原文，命中就**整句**替换，
 * 可变部分（路径 / 错误详情 / modId 等）抓进 `detail` 交给模板。
 * 只收「句式固定、一句话说得清」的句子；带多段上下文的复杂组合句故意不匹配，
 * 交给下面的片段兜底，避免整句替换把 final_dir / 回退记录之类的信息压掉。
 */
/** 多参数整句：[正则, key, 捕获组→参数名]；第三项省略时沿用旧的 {detail} 单参数行为 */
type BackendPattern = [RegExp, string, string[]?];

const BACKEND_PATTERNS: BackendPattern[] = [
  [/^路径不存在[：:]\s*(.+)$/, "pathNotExist"],
  [/^该路径不是文件夹[：:]\s*(.+)$/, "notFolder"],
  [/^该目录下没有 local 或 subscribed 子目录[，,][\s\S]*?[：:]\s*(.+)$/, "noLocalSub"],
  [/^尚未设置[\s\S]*目录[\s\S]*$/, "noRoot"],
  [/^检测到游戏正在运行[（(][\s\S]*$/, "gameRunning"],
  [/^mod-status\.json [^，。]{0,10}没有该模组的记录[\s\S]*$/, "noModRecord"],
  [/^模组文件夹为空[（(][\s\S]*$/, "emptyFolder"],
  [/^(?:无法创建解压目录|解压失败)[：:]\s*([\s\S]*)$/, "extractFailed"],
  [/^写入失败(?:（[^）]*）)?[：:]\s*([\s\S]*)$/, "writeFailed"],
  [/^(?:备份失败|无法创建备份目录)[（(：:，,][\s\S]*$/, "backupFailed"],
  [/^(?:压缩包校验失败|卸载校验失败|回读[^：:]{0,10}失败)[：:]\s*([\s\S]*)$/, "verifyFailed"],
  [/^(?:权限不足[，,][\s\S]*|拒绝访问[：:](?![\s\S]*不在模组根目录内)[\s\S]*)$/, "accessDenied"],
  [/^拒绝访问[：:]目标路径不在模组根目录内$/, "outsideRoot"],
  [/^(?:无法读取[^（(，。]{0,80}|读取失败)[：:]\s*([\s\S]*)$/, "readFailed"],
  [/^(?:无法创建[^（(，。]{0,80}|创建目录失败)[：:]\s*([\s\S]*)$/, "createFailed"],
  [/^(?:无法删除[^（(，。]{0,80}|删除失败)[：:]\s*([\s\S]*)$/, "deleteFailed"],
  [/^(?:下载失败|下载中断|下载超时中止)[^，。]{0,40}[：:]\s*([\s\S]*)$/, "downloadFailed"],
  [/^网络连接被意外中断[（(][\s\S]*$/, "connectionInterrupted"],
  [/^网络配置无效[：:]\s*([\s\S]*)$/, "network"],
  [/^[^。]{0,30}超时[^。]{0,30}[：:，,。][\s\S]*$/, "timeout"],
  [/^未知错误[：:]?[\s\S]*$/, "unknown"],
  /* 预设应用报告（Rust presets.rs 拼的整句）：6 个数值 + 可选的数据模组子句 */
  [
    /^已按预设覆盖配置：启用 (\d+) 个（其中原本已启用 (\d+) 个），禁用 (\d+) 个不在预设中的模组，未找到记录 (\d+) 个([^。]*)。现在共 (\d+) 个模组处于启用状态，请启动游戏确认。$/,
    "presetApplied",
    ["enabled", "already", "disabled", "notFound", "extra", "total"],
  ],
  /* 预设与现状已一致：没有写文件，也就没有备份 */
  [
    /^当前配置已与该预设一致（预设内 (\d+) 个模组已启用，其余均已禁用），未修改文件。([\s\S]*)$/,
    "presetIdentical",
    ["enabled", "extra"],
  ],
];

/**
 * 片段兜底：整句没命中（说明 Rust 侧改了句式）时退回关键词替换。
 * 宁可出现中外混排，也绝不吞掉用户需要反馈的关键报错信息。
 */
const BACKEND_PATTERNS_FALLBACK: BackendPattern[] = [
  [/^路径不存在[:：]\s*(.+)$/, "pathNotExist"],
  [/^该路径不是文件夹[:：]\s*(.+)$/, "notFolder"],
  [/没有 local 或 subscribed 子目录/, "noLocalSub"],
  [/尚未设置.*根目录/, "noRoot"],
  [/游戏正在运行|请先关闭游戏|游戏启动中/, "gameRunning"],
  [/没有该模组的记录/, "noModRecord"],
  [/文件夹为空/, "emptyFolder"],
  [/无法创建解压目录|解压失败/, "extractFailed"],
  [/写入失败/, "writeFailed"],
  [/备份失败/, "backupFailed"],
  [/校验失败|回读失败|回读校验/, "verifyFailed"],
  [/拒绝访问|权限不足|无权访问/, "accessDenied"],
  [/不在模组根目录内/, "outsideRoot"],
  [/无法读取|读取失败/, "readFailed"],
  [/无法创建|创建目录失败/, "createFailed"],
  [/无法删除|删除失败/, "deleteFailed"],
  [/下载失败|下载中断/, "downloadFailed"],
  [/网络连接被意外中断/, "connectionInterrupted"],
  [/网络|连接失败|代理/, "network"],
  [/超时/, "timeout"],
  [/未知错误/, "unknown"],
];

/** 错误码协议前缀：Rust 迁移后所有用户可见错误串都以此开头 */
const BACKEND_CODE_PREFIX = "aoe2mm:err:";
/**
 * `aoe2mm:err:<code>:<json>`，json 段可省略。
 * code 用点分命名空间（`install.extractFailed`），段内 lowerCamelCase，与语言包 key 逐段对应。
 */
const BACKEND_CODE_RE = /^aoe2mm:err:([A-Za-z0-9_.-]+)(?::([\s\S]*))?$/;

interface BackendCodeEnvelope {
  code: string;
  params: Record<string, unknown>;
}

/**
 * 拆错误码信封。前缀不对 / code 非法 → null（交给旧版中文兜底）；
 * 参数 JSON 坏了不影响主流程：仍按 code 出文案，只是占位符为空。
 */
function parseBackendCode(raw: string): BackendCodeEnvelope | null {
  if (!raw.startsWith(BACKEND_CODE_PREFIX)) return null;
  const match = BACKEND_CODE_RE.exec(raw);
  if (!match) return null;
  const code = match[1];
  let params: Record<string, unknown> = {};
  const payload = match[2]?.trim();
  if (payload) {
    try {
      const parsed: unknown = JSON.parse(payload);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        params = parsed as Record<string, unknown>;
      }
    } catch {
      // 参数解析失败：保留 code，文案照常输出
    }
  }
  return { code, params };
}

/**
 * 查当前语言包的文案。
 * `translate` 在缺 key 时会把 key 原样返回（且不会走 fallback 之后再兜一层），据此判断“有没有这条文案”。
 */
function lookupMessage(key: string, params?: Record<string, unknown>): string | null {
  const text = translate(key, params);
  return text === key ? null : text;
}

/**
 * 预设报告尾巴上的「数据模组已跳过」子句（Rust 拼在整句后面，本身也是中文）。
 * 外层整句翻译后，这段要单独转写，否则会留下半个中文尾巴。
 */
const PRESET_DATA_MOD_NOTE = /^；游戏同一时间只能加载一个数据模组，已跳过 (\d+) 个（([\s\S]+)）$/;

function localizePresetNote(text: string): string {
  const m = PRESET_DATA_MOD_NOTE.exec(text ?? "");
  if (!m) return text;
  const key = "backendErrors.pattern.presetDataModNote";
  return lookupMessage(key, { n: m[1], list: m[2] }) ?? text;
}

export function translateBackendMessage(message: string | null | undefined): string {
  const raw = (message ?? "").toString();
  if (!raw.trim()) return raw;

  // ① 错误码协议：与界面语言无关，任何语言下都查「当前语言包」的 backendErrors.code
  const envelope = parseBackendCode(raw);
  if (envelope) {
    const translated = lookupMessage(`backendErrors.code.${envelope.code}`, envelope.params);
    if (translated) return translated;
    // 语言包还没有这个 code 的文案：给出可读提示并保留 code，方便用户反馈定位
    return translate("backendErrors.protocolUnknown", { code: envelope.code });
  }

  // ② 中文界面：后端本来就是中文，原样返回（信息最全，也不做有损替换）
  if (i18n.global.locale.value === "zh") return raw;

  // ③ 非中文界面：先跑整句锚定表（整句替换），未命中再跑片段兜底表（该语言缺 key 会先回落 en）
  for (const [pattern, key, named] of [...BACKEND_PATTERNS, ...BACKEND_PATTERNS_FALLBACK]) {
    if (!pattern.test(raw)) continue;
    const templateKey = `backendErrors.pattern.${key}`;
    if (!lookupMessage(templateKey)) return raw;
    // 多参数整句：按声明顺序把捕获组注入命名占位符
    if (named?.length) {
      return raw.replace(pattern, (...args: unknown[]) => {
        const caps = args.slice(0, named.length + 1) as string[];
        const params: Record<string, unknown> = {};
        named.forEach((name, i) => {
          params[name] = localizePresetNote(caps[i + 1] ?? "");
        });
        return translate(templateKey, params);
      });
    }
    return raw.replace(pattern, (match: string, detail?: string) =>
      translate(templateKey, { detail: detail ?? match }),
    );
  }
  return raw;
}

/**
 * 任意异常 → 可展示文案（唯一出处）。
 *
 * 本地页的 `normalizeError` 与各 composable 里重复了同一段判断，
 * 这里收敛成一处：字符串 / Error / 其它对象都先过一遍后端文案转写，
 * 序列化也失败时才退回「未知错误」。
 */
export function normalizeBackendError(e: unknown): string {
  if (typeof e === "string") return translateBackendMessage(e);
  if (e instanceof Error) return translateBackendMessage(e.message);
  try {
    return translateBackendMessage(JSON.stringify(e));
  } catch {
    return translate("labels.unknown");
  }
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 100 || index === 0 ? 0 : 1)} ${units[index]}`;
}

export function formatDateTime(ms: number | null): string {
  if (!ms || ms <= 0) return translate("labels.notProvided");
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return translate("labels.notProvided");
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

export function kindLabel(kind: string): string {
  if (kind === "local") return translate("labels.kindLocal");
  if (kind === "subscribed") return translate("labels.kindSubscribed");
  return kind;
}

export function statusLabel(enabled: boolean | null): string {
  if (enabled === true) return translate("labels.statusEnabled");
  if (enabled === false) return translate("labels.statusDisabled");
  return translate("labels.statusUnknown");
}

/** 来源徽章的文案（唯一出处，卡片与详情共用） */
export function sourceLabel(source: ModSource | undefined): string {
  if (source === "tool") return translate("labels.sourceTool");
  if (source === "official") return translate("labels.sourceOfficial");
  return translate("labels.sourceUnknown");
}

/** 徽章的悬停解释：把判定依据说清楚，不靠用户猜 */
export function sourceHint(source: ModSource | undefined): string {
  if (source === "tool") return translate("labels.sourceToolHint");
  if (source === "official") return translate("labels.sourceOfficialHint");
  return translate("labels.sourceUnknownHint");
}

export function initials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const first = Array.from(trimmed)[0] ?? "?";
  return first.toUpperCase();
}
