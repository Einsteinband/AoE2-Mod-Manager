/**
 * 右键上下文菜单的共享状态：打开坐标 + 右键目标快照。
 *
 * 关键约束（见任务「右键目标一致性」）：
 * - 打开瞬间把目标 Mod 存进 `target`，之后列表选中项变化不会改变菜单操作对象；
 * - 组件本身只持有坐标与快照，菜单项可见性 / 可用性 / 动作全部由页面装配层计算；
 * - 关闭时清空快照，避免旧目标残留到下一次打开。
 */
import { ref, shallowRef, type Ref } from "vue";

export interface ContextMenuState<T> {
  open: Ref<boolean>;
  x: Ref<number>;
  y: Ref<number>;
  target: Ref<T | null>;
  /** 由卡片事件触发：MouseEvent 用 clientX/Y；键盘菜单键用触发元素底部落点 */
  openAt: (event: MouseEvent | KeyboardEvent, target: T) => void;
  /** 直接给定坐标（页面层需要自算落点时使用） */
  openAtPoint: (x: number, y: number, target: T) => void;
  close: () => void;
}

export function useContextMenu<T>(): ContextMenuState<T> {
  const open = ref(false);
  const x = ref(0);
  const y = ref(0);
  const target = shallowRef<T | null>(null);

  function openAtPoint(px: number, py: number, next: T): void {
    x.value = Math.max(0, Math.round(px));
    y.value = Math.max(0, Math.round(py));
    target.value = next;
    open.value = true;
  }

  function openAt(event: MouseEvent | KeyboardEvent, next: T): void {
    if (event instanceof MouseEvent) {
      openAtPoint(event.clientX, event.clientY, next);
      return;
    }
    // Shift+F10 / 菜单键：以触发卡片的左下缘作为落点，避免菜单压在卡片正中
    const el = event.currentTarget as HTMLElement | null;
    if (el && typeof el.getBoundingClientRect === "function") {
      const rect = el.getBoundingClientRect();
      openAtPoint(rect.left, rect.bottom, next);
    } else {
      openAtPoint(0, 0, next);
    }
  }

  function close(): void {
    open.value = false;
    target.value = null;
  }

  return { open, x, y, target, openAt, openAtPoint, close };
}
