/**
 * 代理来源事实的全局状态单例（底栏代理胶囊唯一数据源）。
 *
 * 为什么与网络诊断结论分开：
 * - 代理来源（manual / system / env / direct）是「当前链路走哪条路」的静态事实，
 *   由 Rust `net::resolve()` 解析本地设置 / 系统代理 / 环境变量得到；
 * - 诊断 verdict（healthy / proxySuspected / ...）是「官网 / API 探针可达性」的健康结论；
 *   探针失败、诊断命令抛错都不应该把已经读到的链路事实抹掉。
 *
 * 数据源与刷新策略：
 * - 诊断成功回包的 `proxy_info` 视为最新事实，直接写入；
 * - 启动时与设置保存后，走独立兜底通道 `getNetworkSettings()` 读取；
 * - 两条命令在 Rust 侧都复用同一个 `net::resolve()`，来源判定语义一致；
 * - 读取失败时保留上一次成功事实；从未成功读取则为 null（空状态），
 *   绝不编造 direct 默认值，也不写入认证态。
 */
import { ref } from "vue";
import { getNetworkSettings } from "./service";

const KNOWN_SOURCES = new Set(["manual", "system", "env", "direct"]);

/** manual | system | env | direct；null = 尚未成功读取 */
export const proxySource = ref<string | null>(null);
/** 最近一次成功写入来源事实的时间戳（ms）；null = 尚未成功读取 */
export const proxySourceUpdatedAtMs = ref<number | null>(null);

function isValidSource(value: unknown): value is string {
  return typeof value === "string" && KNOWN_SOURCES.has(value);
}

/** 写入一次成功取得的来源事实；未知取值忽略，不落成默认直连 */
export function applyProxySource(source: unknown): void {
  if (!isValidSource(source)) return;
  proxySource.value = source;
  proxySourceUpdatedAtMs.value = Date.now();
}

/** 诊断回包成功时喂入最新 proxy_info；只更新来源事实，不修改诊断 verdict / 认证态 */
export function applyDiagnosisProxy(source: unknown): void {
  applyProxySource(source);
}

/** 独立读取一次网络设置链路（`get_network_settings`）；失败保留旧事实，不置空 */
export async function refreshProxySource(): Promise<string | null> {
  try {
    const view = await getNetworkSettings();
    applyProxySource(view?.source);
  } catch {
    // 读取失败：保留上一次成功事实；从未成功则维持 null（空状态）
  }
  return proxySource.value;
}

/** 仅供单测 / 重置：清空来源事实与时间戳 */
export function resetProxySource(): void {
  proxySource.value = null;
  proxySourceUpdatedAtMs.value = null;
}
