/**
 * 右下角轻提示（Toast）的通用实现。
 *
 * 本地页与在线页原本各自复制了一份 `toast` ref + 定时器逻辑：
 * 文案、超时、清理时机完全一致，只是错误态的停留时长不同（本地 7s / 在线 3.2s）。
 * 这里把差异收敛成参数，两个页面共用同一份实现，避免以后改一处忘另一处。
 *
 * 生命周期：定时器在组件卸载时自动清掉（KeepAlive 缓存的在线页也会走 onUnmounted），
 * 不会出现“卸载后 3 秒还在改已销毁组件的 ref”。
 */
import { onBeforeUnmount, ref } from "vue";

export interface ToastState {
  text: string;
  kind: "ok" | "error";
}

export interface ToastOptions {
  /** 成功提示停留时长（毫秒），默认 3200 */
  okMs?: number;
  /** 错误提示停留时长（毫秒），默认 7000 */
  errorMs?: number;
}

export function useToast(options: ToastOptions = {}) {
  const okMs = options.okMs ?? 3200;
  const errorMs = options.errorMs ?? 7000;

  const toast = ref<ToastState | null>(null);
  let timer: number | null = null;

  function clearToast(): void {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
    toast.value = null;
  }

  function showToast(text: string, kind: "ok" | "error" = "ok"): void {
    toast.value = { text, kind };
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(
      () => {
        toast.value = null;
        timer = null;
      },
      kind === "error" ? errorMs : okMs,
    );
  }

  onBeforeUnmount(clearToast);

  return { toast, showToast };
}
