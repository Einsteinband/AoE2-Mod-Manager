[English](./README.md) | **中文**

# AoE2 模组管理器

<table>
  <tr>
    <td align="center" width="50%">
      <a href="./docs/screenshot-online.png"><img src="./docs/screenshot-online.png" alt="在线模组浏览" width="100%"></a>
      <br>
      <sub><b>在线模组浏览</b></sub>
    </td>
    <td align="center" width="50%">
      <a href="./docs/screenshot-local.png"><img src="./docs/screenshot-local.png" alt="本地模组管理" width="100%"></a>
      <br>
      <sub><b>本地模组管理</b></sub>
    </td>
  </tr>
</table>

《帝国时代 II：决定版》的桌面模组管理工具，技术栈 **Tauri 2 + Vue 3 + TypeScript + Rust**。

它只依据游戏真实写出的文件（`local/`、`subscribed/`、`info.json`、`mod-status.json`）来展示模组，支持启用/禁用、模组预设一键恢复，以及从官方模组服务浏览与安装模组——不猜数据，也不动自己没完全弄明白的东西。

---

## 功能

### 本地模组
- 同时扫描 `local/` 与 `subscribed/`，合并成一个列表（名称、作者、Workshop ID、封面、体积、文件数）。
- **启用状态、加载优先级、最后更新、Checksum 全部照 `mod-status.json` 原样显示**，不做任何推断。
- 启用/禁用：先确认游戏未运行 → 备份 `mod-status.json` → 只改 `Enabled` 字段 → 回读校验，校验不过自动回滚。
- 可一键在资源管理器中定位文件夹、打开官网页面，或只删除这一个本地目录（二次确认里写清楚后果）。

### 预设与批量恢复
- 把当前已启用的模组保存为具名预设。
- 游戏更新把模组全部禁用后，一键恢复整套启用状态。
- 每次应用都有备份、回读校验，并逐项汇报（已恢复 / 原本已启用 / 已不存在）。

### 在线模组（官方服务）
- 搜索、浏览、安装 `api.ageofempires.com` 上的模组，支持官方分类、排序与分页。
- 登录在内置 WebView2 窗口里走微软 / Steam / PlayStation 官方页面，**本应用不会索取也不会看到密码**；会话 Cookie 可选用 Windows DPAPI 加密缓存（记住登录）。
- 安装完成后模组落在 `local/`，可直接在游戏内启用。
- 网络设置：默认自动跟随 Windows 系统代理，也可手动指定代理。

### 首次启动引导
- 首次启动会自动搜索 Windows 注册表、Steam 库、用户目录与常见安装路径，定位《帝国时代 II：决定版》的游戏目录。
- 探测失败（或之前记录的路径后来失效）时，弹出设置向导让用户手动选择模组根目录，并在使用前做存在性与结构校验。

### 打包
- **NSIS 安装包**：安装器支持中英双语选择、可安装给所有用户或当前用户，并**允许自定义安装目录**（任意盘符）。
- **免安装 ZIP**：解压即用，无需安装、无需管理员权限。

### 多语言
- 内置英文与简体中文，可在顶栏切换，选择会记在 `settings.json` 里。
- 语言包从 `src/i18n/locales/*.ts` 自动加载，新增语言只需丢一个文件（见[新增语言](#新增语言)）。

---

## 运行环境

- Windows 10 / 11（x64）
- Microsoft Edge **WebView2 运行时**（Win10/11 一般已自带；否则从 <https://go.microsoft.com/fwlink/p/?LinkId=2124703> 安装）
- 《帝国时代 II：决定版》（Steam 版或微软商店版）

---

## 安装

**安装包** —— 运行 `AoE2 Mod Manager_0.1.0_x64-setup.exe`，选择"所有用户 / 仅当前用户"，再选择安装目录（任意盘符均可）。

**免安装版** —— 解压 `AoE2ModManager-0.1.0-win-x64-portable.zip` 到任意位置，运行 `aoe2-mod-manager.exe`；`WebView2Loader.dll` 必须与 exe 放在同一目录。

两种方式的配置、预设与登录缓存都保存在 `%APPDATA%\com.aoe2.modmanager`。

---

## 安全边界

- 只有你明确操作（启用/禁用、应用预设、安装、删除）才会写文件，且每次写入前都会备份。
- 游戏运行期间一律拒绝执行（检测 `AoE2DE_s.exe`）。
- 只修改目标记录的 `Enabled` 字段，`CheckSum`、`LastUpdate`、`Priority`、`Unsub` 原样保留，不会造成校验和不匹配。
- 删除模组只删这一个本地目录和 `mod-status.json` 里的对应记录，**不发送任何退订请求**；要取消订阅请用"在网站浏览"到官网操作。
- 拿不到的数据一律显示"未提供 / 未知"并给出原因，绝不编造。

---

## 开发

| 组件 | 说明 |
| --- | --- |
| Node.js | 22.x（Vite 8 要求 `^20.19 \|\| >=22.12`） |
| Rust | stable，发布用 `x86_64-pc-windows-gnu` 工具链 |
| MinGW-w64 | 提供 `dlltool` / `windres` / `gcc` |

```powershell
npm install
npm run tauri dev      # 开发模式（Vite + 桌面窗口）
npm run build          # 仅前端（vue-tsc 类型检查 + vite build）
npm run tauri build    # 生成 NSIS 安装包
npm run portable       # 生成免安装 ZIP（dist-portable\）
```

后端测试：

```powershell
cargo test --manifest-path src-tauri\Cargo.toml -- --nocapture
```

### Windows GNU 工具链注意事项

MinGW 的 `gcc` specs 会自动链接自带的 `default-manifest.o`，与 `tauri-build` 注入的 manifest 冲突并导致 Common-Controls v6 未激活（启动即 `0xC0000139`）。换机器后先跑一次补丁脚本：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-toolchain.ps1
```

### 新增语言

1. 复制 `src/i18n/locales/en.ts` 为 `src/i18n/locales/<语言代码>.ts`（文件名**就是**语言代码，例如 `de.ts`）。
2. 写 `export const label = "Deutsch";` 并翻译内容；缺失的键自动回退英文。
3. 完成——顶栏语言下拉会自动出现该语言，首次启动也会按系统语言自动选中。

---

## 目录结构

```
F:\AoE2ModManager
├─ src/                          前端
│  ├─ App.vue                    三栏布局、顶栏、筛选与向导承载
│  ├─ components/
│  │  ├─ ModCard.vue             本地模组卡片
│  │  ├─ ModDetail.vue           本地模组详情面板
│  │  ├─ OnlineBrowser.vue       在线页（搜索 / 列表 / 详情 / 安装）
│  │  ├─ OnlineModCard.vue       在线模组卡片
│  │  ├─ PresetManager.vue       预设管理弹窗
│  │  ├─ FirstRunWizard.vue      首次启动根目录向导
│  │  └─ ConfirmDialog.vue       羊皮纸风二次确认
│  ├─ i18n/
│  │  ├─ index.ts                语言包自动加载器
│  │  └─ locales/{en,zh}.ts      语言包（每种语言一个文件）
│  ├─ online/                    官方接口客户端、类型、分类本地化
│  ├─ api.ts / types.ts / format.ts
│  └─ style.css                  深色羊皮纸主题
├─ src-tauri/
│  ├─ src/scan.rs                模组扫描、info.json / mod-status.json 解析
│  ├─ src/settings.rs            配置持久化、根目录自动探测（注册表 + Steam VDF）
│  ├─ src/presets.rs             预设与批量恢复（备份 / 回滚）
│  ├─ src/install.rs             下载 → 解压 → 安装 → 写 mod-status.json
│  ├─ src/online/                官方服务客户端、会话（WebView2 + DPAPI）
│  ├─ src/net.rs                 代理解析（手动 / 系统注册表 / 环境变量）
│  ├─ src/metadata.rs            自有元数据（官方 Tag）
│  ├─ src/lib.rs                 Tauri 命令
│  └─ build.rs                   manifest 注入、WebView2Loader.dll 复制
├─ scripts/                      图标、免安装打包、截图、工具链补丁
└─ docs/
```

---

## 数据来源（不做假约定）

| 字段 | 来源 |
| --- | --- |
| 名称 | `info.json` 的 `Title`；缺失时用去掉数字前缀的文件夹名，并在界面上标注 |
| 作者 / 描述 | `info.json` 的 `Author` / `Description`（描述去 HTML 标签后以纯文本展示） |
| Workshop ID | 文件夹名的数字前缀，如 `108404_xxx` |
| 启用状态 / 优先级 / 最后更新 / Checksum | 游戏写出的 `mod-status.json` |
| 封面 | 模组文件夹内真实存在的 `thumbnail.jpg` / `.png` / `.webp` |
| 分类 | 从在线页安装时记录的官方 Tag；缺失时由本地特征扫描（向下 3 层）兜底 |

任何拿不到的数据都会显示"未提供 / 未知"并附上原因（缺少 `info.json`、`mod-status.json` 无记录、权限不足等）。

---

## 声明

本工具与 Microsoft、Xbox Game Studios、Forgotten Empires 无关。Age of Empires 为其各自权利人的商标。
---

## ☕ 支持开发

如果这个工具帮到了你，欢迎请我喝杯咖啡！你的支持是我持续更新的最大动力。

[![Sponsor](https://img.shields.io/badge/Sponsor_Afdian-☕-orange)](https://afdian.com/a/Einsteinband)