<script setup lang="ts">
import StatusBar from "../StatusBar.vue";
import TopBar from "./TopBar.vue";

/**
 * 应用外壳：统一「顶部导航 / 信息栏 / 主体区域 / 底部状态栏」四层结构。
 *
 * 本地页与在线页都挂在同一个 AppShell 下，唯一的差别是各自塞进来的主体内容：
 *   本地页 → <PageShell>（三栏）     在线页 → <OnlineBrowser>（内部同样用 <PageShell>）
 *
 * 插槽分工：
 *   #toolbar  顶栏中间的工具栏（ModToolbar：搜索 / 排序 / 视图 / 业务按钮）
 *   #info     信息栏（本地页：根目录 + 计数 + 扫描时间 + 告警）
 *   default   主体区域（必须是一个能 flex 撑满的组件，通常是 PageShell）
 *   #overlay  固定定位浮层（弹窗 / Toast），脱离文档流，不参与布局计算
 *
 * 状态（mode）由父组件持有：顶栏切换与底栏显示都读同一个 v-model。
 */
withDefaults(
  defineProps<{
    /** 作者主页地址（只用于 <a> 的 href，真正打开由父组件交给系统浏览器） */
    authorUrl?: string;
    /** 底部状态栏展示的本地模组总数 */
    localCount?: number;
  }>(),
  { authorUrl: "https://github.com/Einsteinband", localCount: 0 },
);

const mode = defineModel<"local" | "online">("mode", { default: "local" });

const emit = defineEmits<{
  (event: "open-author"): void;
  (event: "open-settings"): void;
}>();
</script>

<template>
  <div class="app-layout">
    <!-- ① 顶部导航：纹章 / 模式切换 / 工具栏 / 设置入口 -->
    <TopBar
      v-model:mode="mode"
      :author-url="authorUrl"
      @open-author="emit('open-author')"
      @open-settings="emit('open-settings')"
    >
      <slot name="toolbar" />
    </TopBar>

    <!-- ② 信息栏：由页面自己决定放什么（本地页放 .rootbar，在线页可留空） -->
    <slot name="info" />

    <!-- ③ 主体区域：三栏骨架由 <PageShell> 负责，这里只保证它吃满剩余高度 -->
    <main class="app-main">
      <slot />
    </main>

    <!-- ④ 底部状态栏：账号灯 / 动态提示 / 代理与本地计数，始终显示 -->
    <StatusBar :local-count="localCount" :mode="mode" />

    <!-- ⑤ 浮层：固定定位，不占布局 -->
    <slot name="overlay" />
  </div>
</template>

<style scoped>
/* 主体区域：纵向 flex + min-height: 0，让 PageShell 能真正撑满且内部可滚动 */
.app-main {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
</style>
