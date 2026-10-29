**English** | [中文](./README.zh.md)

# AoE2 Mod Manager

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Tauri](https://img.shields.io/badge/Tauri-2.0-24C8DB?logo=tauri)
![Vue.js](https://img.shields.io/badge/Vue.js-3.0-4FC08D?logo=vue.js)
![Rust](https://img.shields.io/badge/Rust-1.70+-000000?logo=rust)

A modern, open-source desktop mod manager for **Age of Empires II: Definitive Edition**. 

Stop waiting for the game client to sync. Browse, download, and manage your 40,000+ mods directly from your desktop.

## ✨ Why use this?

- **No Game Launch Required**: Search and download mods directly into your `local` folder. The app automatically handles the `info.json` and `mod-status.json` so the game recognizes them instantly.
- **Preset System**: Game updates often disable all your mods. Save your current enabled mods as a preset and restore them with one click.
- **Drag & Drop Sorting**: Easily adjust the load priority (`Priority` field) to resolve mod conflicts by simply dragging the cards.
- **Fully Internationalized**: English and Chinese out-of-the-box. Adding a new language is as simple as dropping a `.ts` file.
- **Safe & Transparent**: Read-only by default. Automatic backups are created before any file modification. The game must be closed before changes are made.

## 🚀 Installation

Go to the [Releases](https://github.com/Einsteinband/AoE2-Mod-Manager/releases) page and download the latest version:

- **Installer (Recommended)**: Download `AoE2 Mod Manager_x.x.x_x64-setup.exe` and run it.
- **Portable**: Download `AoE2ModManager-x.x.x-win-x64-portable.zip`, extract it anywhere, and run `aoe2-mod-manager.exe`.

> **Note**: The app is currently unsigned. Windows SmartScreen may show a warning. Click "More info" -> "Run anyway".

## 🛠️ Building from Source

1. Install [Node.js](https://nodejs.org/) (v22+) and [Rust](https://www.rust-lang.org/).
2. Clone the repository and install dependencies:
   ```bash
   git clone https://github.com/Einsteinband/AoE2-Mod-Manager.git
   cd AoE2-Mod-Manager
   npm install
Run in development mode:

bash
npm run tauri dev
Build for production:

bash
npm run tauri build
☕ Support the Development
If this tool has helped you, consider buying me a coffee! Your support keeps the project alive.

https://img.shields.io/badge/Sponsor_Afdian-%E2%98%95-orange

⚠️ Disclaimer
This is an unofficial tool and is not affiliated with Microsoft, Xbox Game Studios, or Forgotten Empires. Age of Empires is a trademark of its respective owners. Use at your own risk.

📄 License
This project is licensed under the MIT License - see the LICENSE file for details.

<div align="center"> <i>Developed by <a href="https://github.com/Einsteinband">Einsteinband</a></i> </div> ```