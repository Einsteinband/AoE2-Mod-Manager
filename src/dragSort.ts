import Sortable from "sortablejs";

export interface DragEndPayload {
  oldIndex: number;
  newIndex: number;
}

/**
 * 在卡片网格上挂 sortablejs（只允许拖 `.mod-card`）。
 *
 * 为什么必须 forceFallback: true：
 * Tauri 的 WebView2 把原生 HTML5 拖放交给宿主的 OLE 拖放通道处理，
 * 卡片根节点又是 <button>，原生 dragstart 经常根本触发不了（控制台无任何报错，
 * 表现就是“排序模式能进，但怎么拖都没反应”）。
 * forceFallback 改成纯 mousedown/mousemove 驱动 + 浮动克隆体，完全由 JS 控制，
 * 在 WebView2 / Chrome 里行为一致，也不受 <button>、<img> 原生拖拽干扰。
 *
 * 返回销毁函数：退出排序模式时必须调用，否则隐藏的网格仍会拦截鼠标事件。
 */
export function attachDragSort(
  el: HTMLElement,
  onEnd: (payload: DragEndPayload) => void,
): () => void {
  // 同一容器重复挂载会产生两个实例（互相抢 dragstart），先清掉旧的
  const existing = Sortable.get(el);
  if (existing) existing.destroy();

  const sortable = Sortable.create(el, {
    animation: 150,
    draggable: ".mod-card",
    forceFallback: true,
    fallbackOnBody: true,
    // 鼠标移动不足 3px 不算拖拽：保证“点一下选中”和“拖动排序”互不干扰
    fallbackTolerance: 3,
    fallbackClass: "drag-fallback",
    ghostClass: "drag-ghost",
    chosenClass: "drag-chosen",
    dragClass: "drag-active",
    // 卡片上是 <img>，禁止浏览器原生拖图
    preventOnFilter: false,
    onStart: () => {
      document.body.classList.add("sort-dragging");
    },
    onEnd: (evt) => {
      document.body.classList.remove("sort-dragging");
      if (evt.oldIndex === undefined || evt.newIndex === undefined) return;
      if (evt.oldIndex === evt.newIndex) return;
      onEnd({ oldIndex: evt.oldIndex, newIndex: evt.newIndex });
    },
    onUnchoose: () => {
      document.body.classList.remove("sort-dragging");
    },
  });

  el.dataset.sortableReady = "1";
  console.info(
    `[sort] Sortable 已挂载：容器内 ${el.querySelectorAll(".mod-card").length} 张可拖拽卡片`,
  );

  return () => {
    delete el.dataset.sortableReady;
    document.body.classList.remove("sort-dragging");
    sortable.destroy();
  };
}
