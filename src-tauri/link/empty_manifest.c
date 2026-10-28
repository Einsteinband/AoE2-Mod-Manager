// 这个文件只用于生成一个"空的" default-manifest.o。
// 原因：MinGW 的 gcc specs 里有 `%{!shared:%:if-exists(default-manifest.o%s)}`，
// 会自动链接自带的极简 manifest，与 tauri-build 注入的 manifest（含 comctl32 v6 依赖）
// 冲突，ld 报 ".rsrc merge failure: multiple non-default manifests"，
// 结果是 comctl32 v6 未被激活，运行时 comctl32.dll!TaskDialogIndirect 找不到而崩溃。
// 在链接搜索路径里放一个不含 .rsrc 的同名对象即可让 if-exists 命中它。
int aoe2_mod_manager_manifest_placeholder(void) { return 0; }
