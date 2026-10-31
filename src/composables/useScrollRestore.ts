/**
 * 滚动位置记忆（本地列表）。
 *
 * 背景：`mode` 在 本地/在线 之间切换时，`.grid-scroll` 会被 v-if 销毁重建，
 * 每次回来都会跳回顶部。这里记住真实滚动容器的位置，在同一个元素重新就绪时静默还原。
 *
 * 关键细节（原 App.vue 里踩过的坑）：
 * 1. 只在容器**真的能滚动**（scrollHeight > clientHeight）时才记录，
 *    否则元素脱离文档后读到的 0 会把已记下的位置覆盖掉；
 * 2. 还原要等 nextTick（DOM 刚插入还没布局），缩略图 / 字体回流会让高度暂时不足、
 *    导致 scrollTop 被截断，所以下一帧再补一次。
 */
import { nextTick, onBeforeUnmount, ref, watch } from "vue";

export function useScrollRestore() {
  const el = ref<HTMLElement | null>(null);
  let savedTop = 0;
  let bound: HTMLElement | null = null;

  function remember(): void {
    const node = el.value;
    if (!node) return;
    // 只有真有滚动高度时才记录，避免元素脱离文档后被归零的值覆盖掉
    if (node.scrollHeight > node.clientHeight) savedTop = node.scrollTop;
  }

  function unbind(): void {
    if (!bound) return;
    bound.removeEventListener("scroll", remember);
    bound = null;
  }

  watch(
    el,
    (node) => {
      unbind();
      if (!node) return;
      node.addEventListener("scroll", remember, { passive: true });
      bound = node;

      const target = savedTop;
      if (target <= 0) return;
      void nextTick(() => {
        node.scrollTop = target;
        // 缩略图 / 字体回流会让高度暂时不足导致 scrollTop 被截断，下一帧再补一次
        if (node.scrollTop < target) {
          requestAnimationFrame(() => {
            if (node.scrollTop < target) node.scrollTop = target;
          });
        }
      });
    },
    { flush: "post" },
  );

  onBeforeUnmount(unbind);

  return { el };
}
