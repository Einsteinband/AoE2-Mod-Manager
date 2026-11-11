/**
 * 上下文菜单条目类型：本地 / 在线页面装配层共用。
 * 组件只负责渲染与交互，可见性 / 可用性 / 动作由页面层计算后传入。
 */
export interface ContextMenuItem {
  /** 动作标识：页面层在 select 回调里据此分派 */
  id: string;
  label: string;
  /** 行首小图标（沿用卡片 / 详情现有的 emoji 词表）；不传则留空占位对齐 */
  icon?: string;
  disabled?: boolean;
  /** 危险操作：文字走 danger 语义色，与强调色区分 */
  danger?: boolean;
  /** 上一条分隔线（危险分组前使用） */
  dividerBefore?: boolean;
  /** 右侧次要说明文字（状态提示等） */
  hint?: string;
}
