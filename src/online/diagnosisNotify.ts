/**
 * 诊断通知桥（模块级单例）。
 *
 * 项目现有通知形态是 App.vue 持有一份全局 Toast，各页面另有组件内 useToast。
 * 诊断模块不新建冲突的通知 UI，只通过本桥发布「通知决策请求」；App.vue 订阅后
 * 把 key 翻译成文案，交给现有全局 Toast 以浮动气泡展示（不参与布局、不挤压底栏）。
 *
 * 去重 / 防覆盖规则：
 * - 同一 dedupeKey 持续期间不重复弹（相同故障持续不刷屏）；
 * - 旧 generation（被取代的诊断轮次）的通知一律丢弃，不能覆盖新诊断结论；
 * - 恢复、代理变化等事件各自使用独立 dedupeKey。
 */

export type DiagnosisNotifyKind = "ok" | "error";

export interface DiagnosisNotifyRequest {
  /** i18n 文案 key（statusbar.*） */
  key: string;
  kind: DiagnosisNotifyKind;
  /** 相同故障的去重键；"none" 表示不参与去重 */
  dedupeKey: string;
  /** 产生该通知的诊断代际（旧代际通知丢弃） */
  generation: number;
  params?: Record<string, unknown>;
}

type Listener = (req: DiagnosisNotifyRequest) => void;

const listeners = new Set<Listener>();
let lastDedupeKey: string | null = null;
let lastGeneration = 0;

/** 订阅诊断通知；返回解绑函数。App.vue 全局只订阅一次。 */
export function subscribeDiagnosisNotify(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 发布诊断通知。旧代际、重复去重键的请求直接丢弃。 */
export function diagnosisNotify(req: DiagnosisNotifyRequest): void {
  if (req.generation < lastGeneration) return;
  lastGeneration = req.generation;
  if (req.dedupeKey !== "none" && req.dedupeKey === lastDedupeKey) return;
  lastDedupeKey = req.dedupeKey;
  for (const fn of listeners) fn(req);
}

/** 退出登录 / 强边界时重置去重状态，允许后续重新提示。 */
export function resetDiagnosisNotify(): void {
  lastDedupeKey = null;
  lastGeneration = 0;
}

/** 仅供测试：读取当前去重键。 */
export function getLastDedupeKey(): string | null {
  return lastDedupeKey;
}
