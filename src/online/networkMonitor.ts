/**
 * 网络变化自动监听与诊断调度。
 *
 * 触发来源（不引入第三方网络插件，优先使用 WebView2 / 浏览器既有能力）：
 * - 程序启动：由 App.vue 直接调用 runNetworkDiagnosis("startup")；
 * - Windows 网络连接 / 接口变化：window online / offline 事件（navigator.onLine 同源）；
 * - 登录过程中网络变化：订阅 flowState，进入 waitingBrowser / checking 时补一轮；
 * - 代理模式切换：设置页保存后直接请求诊断（settings）；
 * - 低频后台复查：120s 兜底轮询，覆盖系统代理 / TUN 配置这类浏览器事件感知不到的变化；
 * - 手动校验：底栏按钮请求诊断（manual）。
 *
 * 调度规则：
 * - 事件防抖 2.5s，快速连续的网络事件合并为一轮；
 * - 同一时间只允许一轮有效诊断（单飞 + generation 代际丢弃旧结果，见 networkDiagnosis）；
 * - 复查轮不打断正在执行的诊断；低频间隔固定，避免影响游戏与下载。
 */
import { watch } from "vue";
import { flowState } from "../session/controller";
import { diagnosisRunning, runNetworkDiagnosis } from "./networkDiagnosis";
import type { DiagnosisTrigger } from "./types";

/** 低频后台复查间隔：120s */
export const POLL_INTERVAL_MS = 120_000;
/** 网络事件防抖窗口：2.5s */
export const DEBOUNCE_MS = 2_500;

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let stopFlowWatch: (() => void) | null = null;
let started = false;

/** 调度一轮诊断；防抖窗口内的多次请求合并为最后一次。 */
export function requestDiagnosis(trigger: DiagnosisTrigger): void {
  if (debounceTimer !== null) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void runNetworkDiagnosis(trigger);
  }, DEBOUNCE_MS);
}

function onOnline(): void {
  requestDiagnosis("event");
}

function onOffline(): void {
  requestDiagnosis("event");
}

/** 启动全局监听；App.vue 挂载时调用一次，重复调用幂等。 */
export function startNetworkMonitoring(): void {
  if (started) return;
  started = true;

  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);

  pollTimer = setInterval(() => {
    // 不打断正在执行的诊断；代际机制保证旧结果不覆盖新结果。
    if (!diagnosisRunning.value) void runNetworkDiagnosis("poll");
  }, POLL_INTERVAL_MS);

  stopFlowWatch = watch(
    () => flowState.value,
    (next, prev) => {
      if ((next === "waitingBrowser" || next === "checking") && prev !== next) {
        requestDiagnosis("login");
      }
    },
    { flush: "sync" },
  );
}

/** 停止监听并清理定时器；组件卸载 / 测试隔离时调用。 */
export function stopNetworkMonitoring(): void {
  if (!started) return;
  started = false;

  window.removeEventListener("online", onOnline);
  window.removeEventListener("offline", onOffline);

  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  stopFlowWatch?.();
  stopFlowWatch = null;
}
