# AoE2 Mod Manager（阶段一：只读原型）

《帝国时代 II：决定版》模组浏览与管理工具。**本阶段只读**：扫描 `local` 与 `subscribed`，
展示真实存在的模组信息，不订阅、不下载、不启用/禁用、不删除任何文件。

技术栈：Tauri 2 + Vue 3 + TypeScript + Vite + Rust。

## 一、环境（本机已就绪，换机器照此复现）

| 组件 | 位置 / 版本 | 说明 |
| --- | --- | --- |
| Node.js | v22.16.0 | Vite 8 要求 `^20.19 || >=22.12` |
| Rust | `stable-x86_64-pc-windows-gnu`，`F:\Rust\.cargo` | 无管理员权限，装到 F 盘 |
| MinGW-w64 | WinLibs GCC 16.2.0 UCRT，`F:\mingw\mingw64` | 提供 `dlltool` / `windres` / `gcc` |
| WebView2 Runtime | 155.0.4283.62 | 系统已存在 |

需要的环境变量（用户级，已写入）：

```
CARGO_HOME=F:\Rust\.cargo
RUSTUP_HOME=F:\Rust\.rustup
PATH += F:\Rust\.cargo\bin ; F:\mingw\mingw64\bin
```

代理（本机为 Clash，rustup / npm / curl 都需要显式设置，Windows 系统代理它们不读）：

```powershell
$env:HTTPS_PROXY="http://127.0.0.1:7897"; $env:HTTP_PROXY="http://127.0.0.1:7897"
```

### 首次部署必备的两步修复

1. **工具链 manifest 补丁**（一次性）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-toolchain.ps1
```

MinGW 的 gcc specs 会自动链接自带的 `default-manifest.o`，与 `tauri-build` 注入的 manifest
（含 `Microsoft.Windows.Common-Controls` v6 依赖）冲突，ld 报
`.rsrc merge failure: multiple non-default manifests`，结果 comctl32 v6 未激活，
进程启动即 `0xC0000139 STATUS_ENTRYPOINT_NOT_FOUND`。脚本把该对象替换为不含 `.rsrc` 的空对象。

2. **图标**（仅有需要改图标时）：

```powershell
npm run icons   # 生成 src-tauri/icons/*.png 与 icon.ico（无第三方依赖）
```

## 二、运行

```powershell
cd F:\AoE2ModManager
npm install
npm run tauri dev      # 开发模式（Vite + 桌面窗口）
npm run build          # 仅前端产物（vue-tsc 类型检查 + vite build）
cargo test --manifest-path src-tauri\Cargo.toml -- --nocapture   # 后端扫描测试
npm run tauri build    # 打包 NSIS 安装包
```

> 若 PowerShell 里的 `cargo` 找不到，先在新终端里执行一次：
> `$env:PATH="F:\mingw\mingw64\bin;F:\Rust\.cargo\bin;$env:PATH"`

## 三、已验证的行为（阶段一验收）

| 项 | 结果 |
| --- | --- |
| 扫描 `F:\Games\AoE2DE` | 175 个模组（本地 1、已订阅 174） |
| `info.json` 解析 | 175/175 成功（含字符串内裸换行的非法 JSON，已容错） |
| `mod-status.json` | 151 启用 / 24 停用 / 0 未知 |
| 缩略图 | 170 个模组有真实 `thumbnail.jpg`，经 asset 协议只读加载 |
| 体积/文件数 | 选中模组时按需统计，实测 `399 KB / 38 个文件` |
| 单元测试 | `cargo test` 4 项通过 |
| 启动 | `npm run tauri dev` 正常出窗口并显示真实模组 |

## 四、目录结构

```
F:\AoE2ModManager
├─ src/                       前端
│  ├─ App.vue                 三栏布局 + 筛选/排序/扫描状态机
│  ├─ components/ModCard.vue  卡片（封面、来源徽章、状态点）
│  ├─ components/ModDetail.vue 详情（作者、ID、优先级、路径、体积、问题）
│  ├─ api.ts                  invoke 封装 + convertFileSrc
│  ├─ types.ts                与 Rust 结构体一一对应的类型
│  └─ style.css               深色中世纪主题（羊皮纸/金色，衬线字体）
├─ src-tauri/
│  ├─ src/scan.rs             扫描、info.json/ mod-status.json 解析、体积统计
│  ├─ src/settings.rs         根目录持久化、Steam 库路径探测
│  ├─ src/lib.rs              Tauri 命令（scan_mods / set_mod_root / mod_stats …）
│  ├─ build.rs                注入 manifest、复制 WebView2Loader.dll
│  ├─ link/default-manifest.o 遮蔽 MinGW 自带 manifest 的空对象
│  └─ capabilities/default.json  仅 core:default + dialog:default
└─ scripts/                   图标生成、导入表体检、截图、工具链补丁
```

## 五、数据来源与“不做假”约定

| 字段 | 来源 |
| --- | --- |
| 名称 | `info.json` 的 `Title`；缺失时用去掉数字前缀的文件夹名，并标注来源 |
| 作者 / 描述 | `info.json` 的 `Author` / `Description`（描述去 HTML 标签后展示） |
| Workshop ID | 文件夹名 `108404_xxx` 的数字前缀 |
| 启用状态 / 优先级 / 更新时间 / Checksum | 游戏写出的 `mod-status.json` |
| 封面 | 模组文件夹内真实存在的 `thumbnail.jpg/.png/.webp` |
| 内容类型 | 依据真实子目录（`widgetui`→界面 UI，`resources`→游戏资源 …） |

任何拿不到的数据一律显示“未提供 / 未知”，并在详情里给出原因（缺少 `info.json`、
`mod-status.json` 无记录、权限不足等），不生成猜测值。缺失字段也会进入
`ScanReport.warnings`，界面上通过“⚠ N 条提示”查看。

## 六、安全边界

- 全部文件访问为只读：`fs::read_dir` / `fs::read` / `metadata`。
- `mod_stats` 只统计已配置根目录**之内**的路径（`canonicalize` + `starts_with` 校验）。
- 缩略图通过 Tauri asset 协议读取，作用域由 Rust 在扫描时动态放行该根目录。
- 未实现订阅、下载、启用、禁用、卸载；不注入游戏进程、不改客户端 UI。
