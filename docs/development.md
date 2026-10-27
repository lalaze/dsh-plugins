# 大仓开发指南

## 包边界

根包 `dsh-plugins` 设置 `private: true`，仅负责工具和批量命令。各插件位于 `packages/*`，保留独立版本，不要求一起发布。现有插件的包名、DSH 注册 ID、版本和持久化目录仍为原来的约定；目录迁移不影响已安装用户的数据。

TypeScript、tsx、esbuild 和 Node 类型由根目录提供。React、DSH 接口包和其他插件专用依赖声明在插件自己的 `package.json`，避免依赖其他插件恰好安装的包。DSH/React 的宿主依赖继续按插件需要声明为 peerDependencies，并在开发时提供相应 devDependencies。

## 新增插件

1. 新建 `packages/<目录名>`，写入独立 `package.json`，选择唯一的包名和初始版本。
2. 添加 `src/`、`test/`、README 和 LICENSE。插件专用文档放在该包的 `docs/`。
3. 添加 `tsconfig.json`，继承根配置；`include` 必须按包目录定义：

   ```json
   {
     "extends": "../../tsconfig.base.json",
     "include": ["src", "test"]
   }
   ```

4. 按插件实际入口设置 `main`、`types`、`exports`、`files`、DSH 清单和构建配置。当前插件的服务端编译结果位于 `lib/server/`，客户端为 `lib/client.js`，可参考 [Remote Agents 清单](../packages/remote-agents/package.json)。后端插件无需客户端构建步骤。
5. 定义 `build`、`typecheck`、`test` 和 `prepack` 脚本；`check` 可组合前三项，`test:ui` 按需添加。当前使用 Node test runner，命令为 `node --import tsx --test test/*.test.ts`。让 `prepack` 执行构建，确保归档包含最新产物。
6. 在根目录执行 `pnpm install` 更新唯一锁文件，再运行 `pnpm --filter <包名> check`。根目录 README 的插件表需要同时更新。

workspace 自动发现 `packages/*`，无需修改根目录的批量脚本。不使用的脚本可以省略，根命令会跳过它们。

## 共用客户端构建

采用当前客户端目录约定的插件可以在 `build` 脚本中执行：

```sh
tsc -p tsconfig.build.json && node ../../scripts/build-client.mjs
```

共用脚本读取调用包当前目录下的 `package.json`，以包名作为 `window.__ModuleLoader__.load` 的模块 ID，将 `src/client/index.tsx` 编译到 `lib/client.js`。React、React DOM 和 `@deepseek-ai/*` 保持外部依赖；插件需按实际使用声明客户端注入项和宿主依赖。客户端结构不同时可使用自己的构建脚本。

插件的 `cordis.patch.yml` 随包保存，引用该插件自己的包名；`dsh.bundle.patch`、客户端 `./client` 导出及 `dsh.client` 按需配置。不要让所有插件复用同一个 DSH 模块 ID。

## 打包与发布

```sh
pnpm check
pnpm pack:plugins
```

根打包命令按 workspace 依赖顺序打包 `packages/*` 下有版本的包，先执行各包的 `prepack`，归档集中在根目录 `dist/`。公共依赖包也会产生归档；安装时选择需要的插件。

单独打包当前插件：

```sh
pnpm --filter dsh-remote-agents pack:plugin
```

新增插件若需要同样的快捷命令，在自己的 `scripts` 中添加 `"pack:plugin": "pnpm pack --pack-destination ../../dist"`。每个可发布包应通过 `files` 明确包含编译产物、patch、README、LICENSE 和必要文档，源码测试及根目录工具不进入安装包。

发布前检查归档内容，并从归档验证入口可以解析。使用 `.tgz` 安装时不需要用户拿到整个大仓；不要把 GitHub 根仓库地址作为子包安装地址。

通过插件市场发布时运行 `pnpm release:market`（可加 `--dry-run`），再 `git push origin market`。脚本要求工作区干净，按 `pnpm pack` 的产物生成去掉 `scripts` 与 `devDependencies` 的安装包，提交到只追加的 `market` 分支，并用 DSH 自带的校验器（`@deepseek-ai/dsh-plugin-market-index`）检查索引。插件标题取自各包 README 的一级标题，简介取自根目录 README 的插件表，所以新增插件时更新插件表即可。发布新版本前必须升级版本号；同一版本内容变化会被提示并跳过。

## 共享代码

实际出现复用需求后再建立 `packages/shared` 等公共包，不从其他插件的 `src` 使用跨包相对导入。workspace 内依赖可使用 `workspace:*`，pnpm 打包时会转换为对应版本依赖。

如果公共包用于运行时，它必须可供安装端获取：分别发布公共包，或在插件构建时将所需代码打进插件产物。只发布插件 `.tgz` 而让它依赖尚未发布的公共包，会导致独立安装失败。只供开发使用的公共包可设为 `private: true`。

## 迁移旧工作区

旧项目的 `src/`、`test/`、插件文档和清单已移到 `packages/claude-ssh/`。`scripts/test-select-ui.mjs` 随插件迁移，客户端打包脚本成为根目录公共工具。旧 `package-lock.json` 已转换为 `pnpm-lock.yaml`。

旧的 npm `node_modules` 可移除后在根目录重新执行 `pnpm install --frozen-lockfile`。后续不要运行 `npm install` 或维护子包锁文件。历史 `.tgz` 不会被更新，新的安装包请从 `dist/` 取用。

本次迁移已验证：全新依赖安装、全仓类型检查、31 项自动测试、现有浏览器回归、批量打包均通过。pnpm 锁文件保留原 npm 锁文件中的全部 160 个依赖名称及版本；插件源码、测试、patch 和 UI 回归脚本仅移动目录，编译产物与迁移前一致。另用不同包名验证了共用客户端构建脚本，并从独立解压目录加载安装包服务端入口、检查客户端模块注册；宿主依赖由测试环境提供，未修改现有 DSH profile。
