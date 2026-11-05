/**
 * 顶栏「启动游戏」的全局状态与点击流程（模块级单例）。
 *
 * 为什么不是 Pinia：本项目从未引入 pinia，全局状态一律走「模块级 ref」
 * （sessionState.ts / modUpdates.ts / online/downloadQueue.ts 都是这个套路）。
 * 顶栏按钮全局只有一个，模块级 ref 足够，切本地/在线页也不会丢 loading 状态。
 *
 * v3.3 契约（启动必须经过 Steam，否则丢启动项 / 游玩时长 / 成就）：
 *   1. 直接调用 launch_game(null)，后端自己读 settings.game_root_dir；
 *   2. 后端返回 GAME_PATH_MISSING（没配置根目录）→ Toast 提示 + 打开
 *      「设置 → 通用」并聚焦「游戏根目录」一行，**不再弹选 exe 的文件框**；
 *   3. 其它错误（目录配置有误 / 唤不起 Steam）→ 直接 error Toast。
 */
import { ref } from "vue";
import { GAME_PATH_MISSING, launchGame } from "../api";

/** 唯一 loading 开关（模块级：切页不重置） */
const launching = ref(false);

export interface GameLaunchDeps {
  /** 右下角 Toast（App.vue 传全局 showToast） */
  notify: (text: string, kind?: "ok" | "error") => void;
  /** 统一错误文案（App.vue 传 scan.normalizeError） */
  normalizeError: (error: unknown) => string;
  /** 未配置游戏根目录时：打开「设置 → 通用」并聚焦到「游戏根目录」一行 */
  openGameRootSettings: () => void;
  /** 点击时才取文案：切换语言后无需重建组件 */
  texts: () => { started: string; needRoot: string };
}

/** 只有「后端没有配置游戏根目录」这一种失败才跳设置页 */
function isMissingPath(error: unknown): boolean {
  const text =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : String(error ?? "");
  return text.includes(GAME_PATH_MISSING);
}

export function useGameLaunch(deps: GameLaunchDeps) {
  async function launch(): Promise<void> {
    if (launching.value) return;
    launching.value = true;
    try {
      // exePath 恒传 null：根目录是唯一真源，避免前端再持有一份可能过期的路径
      await launchGame(null);
      deps.notify(deps.texts().started, "ok");
    } catch (error) {
      if (isMissingPath(error)) {
        // 没配置根目录 → 直接把用户送到设置页那一行，而不是让他去猜
        deps.notify(deps.texts().needRoot, "error");
        deps.openGameRootSettings();
        return;
      }
      deps.notify(deps.normalizeError(error), "error");
    } finally {
      launching.value = false;
    }
  }

  return { launching, launch };
}
