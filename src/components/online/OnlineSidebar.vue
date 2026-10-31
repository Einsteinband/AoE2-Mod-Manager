<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { tagLabel, type ModTag, type SessionStatus } from "../../online/types";

/**
 * 在线页左侧栏：来源 / 收藏 / 官方分类 / 账号。
 *
 * 纯展示组件：状态真源在 `useOnlineList`（来源、收藏、分类）与 `useOnlineSession`（账号），
 * 这里只把交互上抛给页面。样式全部复用 style.css 的 .side-group / .side-item。
 */
defineProps<{
  onlySubscribed: boolean;
  favoritesOnly: boolean;
  activeTag: number | null;
  tags: ModTag[];
  tagsError: string | null;
  session: SessionStatus | null;
  netClearing: boolean;
  netError: string | null;
  netMessage: string | null;
  favoriteCount: number;
}>();

const emit = defineEmits<{
  (event: "pick-subscribed", value: boolean): void;
  (event: "toggle-favorites"): void;
  (event: "pick-tag", value: number | null): void;
  (event: "refresh-session"): void;
  (event: "logout"): void;
}>();

const { t } = useI18n();
</script>

<template>
  <div class="side-group">
    <div class="side-title">{{ t("sidebar.source") }}</div>
    <button
      type="button"
      class="side-item"
      :class="{ active: !onlySubscribed && !favoritesOnly }"
      @click="emit('pick-subscribed', false)"
    >
      <span class="label">{{ t("sidebar.allMods") }}</span>
    </button>
    <button
      type="button"
      class="side-item"
      :class="{ active: onlySubscribed && !favoritesOnly }"
      @click="emit('pick-subscribed', true)"
    >
      <span class="label">{{ t("sidebar.subscribed") }}</span>
    </button>
  </div>

  <!-- v0.5：我的收藏（只过滤 isFavorite，按 modId 匹配 user_data.json） -->
  <div class="side-group">
    <div class="side-title">{{ t("favorites.groupTitle") }}</div>
    <button
      type="button"
      class="side-item"
      :class="{ active: favoritesOnly }"
      @click="emit('toggle-favorites')"
    >
      <span class="label">⭐ {{ t("favorites.label") }}</span>
      <span class="count">{{ favoriteCount }}</span>
    </button>
  </div>

  <div class="side-group">
    <div class="side-title">{{ t("sidebar.officialTags") }}</div>
    <button
      type="button"
      class="side-item"
      :class="{ active: !favoritesOnly && activeTag === null }"
      @click="emit('pick-tag', null)"
    >
      <span class="label">{{ t("sidebar.allContent") }}</span>
    </button>
    <button
      v-for="item in tags"
      :key="item.modTypeId"
      type="button"
      class="side-item"
      :class="{ active: !favoritesOnly && activeTag === item.modTypeId }"
      :title="item.modTypeName"
      @click="emit('pick-tag', item.modTypeId)"
    >
      <span class="label">{{ tagLabel(item) }}</span>
    </button>

    <div v-if="!tags.length" class="side-note note">{{ t("online.tagsLoading") }}</div>
    <div v-else-if="tagsError" class="side-note note">{{ tagsError }}</div>
  </div>

  <div class="side-group">
    <div class="side-title">{{ t("online.account") }}</div>
    <div class="side-note note">
      {{ session?.loggedIn ? t("online.signedIn") : t("online.signedOut") }} ·
      {{ session?.cookieSource === "cache" ? t("online.cookieCache") : t("online.cookieWebview") }}
      <template v-if="session?.cookieCount">· {{ session.cookieCount }} Cookie</template>
    </div>
    <button type="button" class="side-item" @click="emit('refresh-session')">
      <span class="label">{{ t("online.recheck") }}</span>
    </button>
    <button type="button" class="side-item" :disabled="netClearing" @click="emit('logout')">
      <span class="label">{{ netClearing ? t("online.clearing") : t("online.clearCache") }}</span>
    </button>
    <div v-if="netError" class="side-msg error">{{ netError }}</div>
    <div v-else-if="netMessage" class="side-msg">{{ netMessage }}</div>
  </div>

  <!-- 代理 / 记住登录已迁到顶栏齿轮里的设置弹窗（SettingsModal → 网络） -->
</template>

<style scoped>
/* 只补充本地界面没有的元素；布局全部复用 style.css 的本地类 */
.side-note {
  padding: 2px 10px 4px;
  line-height: 1.6;
  word-break: break-all;
}
.side-msg {
  padding: 2px 10px;
  font-size: 11px;
  line-height: 1.6;
  color: var(--gold);
}
.side-msg.error {
  color: var(--danger-text);
}
</style>
