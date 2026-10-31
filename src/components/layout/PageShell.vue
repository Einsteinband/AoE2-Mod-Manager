<script setup lang="ts">
/**
 * 统一三栏页面骨架：左侧筛选栏 + 中间主内容 + 右侧详情面板。
 *
 * **全项目唯一的 .body-grid 三栏定义都在这一个文件里**（style.css 只保留各栏的视觉样式）：
 *   grid-template-columns: 侧栏宽 | minmax(内容最小宽, 1fr) | 详情宽
 * 尺寸全部来自 :root 的 --layout-* 变量；窗口变窄时由 style.css 的断点收窄两侧固定栏，
 * 中间列始终吃掉剩余宽度 —— 不再出现“某一列被挤成 0”或“固定宽 + flex 无限收缩”导致的重叠。
 *
 * 滚动区域划分（页面外层永远不出滚动条，也不会出现双滚动条）：
 *   sidebar → 自身纵向滚动（scrollbar-gutter: stable，切换筛选时宽度不跳）
 *   content → overflow: hidden，滚动交给内部的 .grid-scroll
 *   detail  → overflow: hidden，滚动交给内部的 .detail-body
 *
 * 具名插槽：
 *   #sidebar  左侧栏内容
 *   #content  主内容区
 *   #detail   右侧详情面板
 *   #overlay  固定定位的浮层（Toast / 弹窗），脱离文档流，不参与三栏排版
 */
withDefaults(
  defineProps<{
    /** 追加到 .sidebar 的类名（例如排序模式的锁定态） */
    sidebarClass?: string;
    /** 追加到 .content 的类名 */
    contentClass?: string;
    /** 追加到 .detail 的类名 */
    detailClass?: string;
  }>(),
  { sidebarClass: "", contentClass: "", detailClass: "" },
);
</script>

<template>
  <div class="page-shell">
    <div class="body-grid">
      <!-- 侧栏：分类 / 收藏 / 状态筛选（本地与在线同一套宽度与滚动规则） -->
      <aside class="sidebar" :class="sidebarClass">
        <slot name="sidebar" />
      </aside>

      <!-- 主内容：抬头 + 唯一滚动容器 .grid-scroll（由 ModGrid 提供） -->
      <section class="content" :class="contentClass">
        <slot name="content" />
      </section>

      <!-- 详情面板：抬头定高 + 内部 .detail-body 滚动 -->
      <aside class="detail" :class="detailClass">
        <slot name="detail" />
      </aside>
    </div>

    <!-- 浮层：position: fixed，不占据网格单元，也不改变三栏尺寸 -->
    <slot name="overlay" />
  </div>
</template>

<style scoped>
/* 页面外壳：吃满 AppShell 的主区域，自身永不滚动 */
.page-shell {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

/* ---------- 三栏骨架（全项目唯一定义处，禁止在页面里重复写 grid-template-columns） ---------- */
.body-grid {
  display: grid;
  /* 左固定 | 中自适应（带最小宽度） | 右固定；宽度变量见 style.css 的 :root */
  grid-template-columns:
    var(--layout-sidebar-width, 216px)
    minmax(var(--layout-content-min-width, 320px), 1fr)
    var(--layout-detail-width, 372px);
  column-gap: var(--layout-column-gap, 0px);
  /* 吃满 PageShell 剩余高度：min-height: 0 是内部各栏能独立滚动的前提 */
  flex: 1 1 auto;
  min-height: 0;
  /* 页面外层不出滚动条：滚动只发生在 .sidebar / .grid-scroll / .detail-body 内 */
  overflow: hidden;
}

/* 三栏共用的防溢出基线：grid 子项默认 min-width: auto，会被长文本撑破列宽 */
.sidebar,
.content,
.detail {
  min-width: 0;
  min-height: 0;
}

/* 左栏：唯一自身滚动的固定栏 */
.sidebar {
  overflow-x: hidden;
  overflow-y: auto;
  /* 始终为滚动条留位：切换筛选导致条目数变化时，内容栏宽度不会突变 */
  scrollbar-gutter: stable;
}

/* 中栏：纵向 flex（抬头 + 滚动区），自身不滚动 */
.content {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* 右栏：纵向 flex（抬头 + 详情正文），自身不滚动 */
.detail {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
</style>
