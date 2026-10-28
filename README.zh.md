[English](./README.md) | **中文**

# AoE2 模组管理器

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Tauri](https://img.shields.io/badge/Tauri-2.0-24C8DB?logo=tauri)
![Vue.js](https://img.shields.io/badge/Vue.js-3.0-4FC08D?logo=vue.js)
![Rust](https://img.shields.io/badge/Rust-1.70+-000000?logo=rust)

一个现代、开源、完全独立的《帝国时代 II：决定版》桌面模组管理器。

告别进游戏等待同步的漫长过程。在桌面上直接浏览、下载和管理 40000+ 官方模组。

<table>
  <tr>
    <td align="center" width="50%">
      <img src="./docs/screenshot-online.png" alt="在线模组浏览" width="100%">
      <br>
      <sub><b>在线模组浏览与安装</b></sub>
    </td>
    <td align="center" width="50%">
      <img src="./docs/screenshot-local.png" alt="本地模组管理" width="100%">
      <br>
      <sub><b>本地管理与预设恢复</b></sub>
    </td>
  </tr>
</table>

## ✨ 核心功能

- **免进游戏，一键安装**：直接搜索并下载模组到 `local` 文件夹。软件会自动生成 `info.json` 和修改 `mod-status.json`，进游戏直接生效。
- **预设批量恢复**：每次游戏更新后模组全被禁用？一键应用预设，瞬间恢复你之前精心搭配的模组配置。
- **拖拽排序**：模组冲突怎么办？开启排序模式，直接拖动卡片即可修改加载优先级（Priority）。
- **多语言支持**：原生支持中英双语，基于模块化的 i18n 架构，增加新语言只需放入一个 `.ts` 文件。
- **绝对安全**：只读模式，修改前自动备份。游戏运行时自动拦截写入操作，绝不损坏你的原版文件。

## 🚀 下载与安装

前往 [Releases](https://github.com/Einsteinband/AoE2-Mod-Manager/releases) 页面下载最新版本：

- **安装版（推荐）**：下载 `AoE2 Mod Manager_0.1.0_x64-setup.exe` 并运行，支持自定义安装目录。
- **免安装版**：下载 `AoE2ModManager-0.1.0-win-x64-portable.zip`，解压到任意位置，双击 `aoe2-mod-manager.exe` 即可运行。

> **注意**：软件目前未购买数字签名，Windows 安装时可能会弹出 SmartScreen 拦截，点击“更多信息” -> “仍要运行”即可。

## 💻 技术栈

- **前端**：Vue 3 + TypeScript + Vite
- **后端**：Rust + Tauri 2
- **UI**：纯手工打造的暗黑中世纪风格

## 🌍 贡献与翻译

欢迎提交 PR！如果你想帮忙添加新语言：
1. 复制 `src/i18n/locales/en.ts` 为 `src/i18n/locales/<你的语言代码>.ts`（例如 `de.ts`）。
2. 翻译内容，并导出 `const label = "Deutsch";`。
3. 提交 Pull Request！

## ⚠️ 免责声明

本工具为非官方第三方软件，与 Microsoft、Xbox Game Studios 及 Forgotten Empires 无关。Age of Empires 为其各自权利人的商标。请自行承担使用风险。

## 📄 开源协议

本项目基于 MIT 许可证开源 - 详见 [LICENSE](LICENSE) 文件。

---
<div align="center">
  <i>由 <a href="https://github.com/Einsteinband">Einsteinband</a> 开发</i>
</div>