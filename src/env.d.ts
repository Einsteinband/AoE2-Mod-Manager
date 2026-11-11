/// <reference types="vite/client" />

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<{}, {}, any>;
  export default component;
}

// 仅用于 Vitest 源码契约测试读取项目文件；运行环境由 Vitest/Node 提供，不新增运行时依赖。
declare module "node:fs" {
  export function readFileSync(path: string, encoding: BufferEncoding): string;
}
declare module "node:path" {
  export function join(...paths: string[]): string;
}
