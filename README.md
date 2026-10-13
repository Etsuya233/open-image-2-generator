# open-image-2-generator

SillyTavern 原生 UI 扩展：自动读取回复末尾的 `<pic prompt="...">` 并生成图片，支持按角色名与别名匹配参考图、图生图、上下文提示词整理、图片预览与日志。运行时无需 TavernHelper / JS-Slash-Runner。

## 安装与更新

将此仓库放在 `SillyTavern/data/<用户>/extensions/open-image-2-generator` 下，确保该目录直接包含 `manifest.json`，然后刷新 ST 页面。右下角的 **image2 参考图** 按钮用于打开面板。

仓库发布到 Git 远端后，也可以在 ST 的“扩展 → 安装扩展”中填写仓库地址安装，并通过扩展管理更新。目前本仓库没有配置 Git 远端。

### 本机开发

本机使用目录联接，让 ST 直接加载这个工作目录：

```text
D:\programming\SillyTavern\data\default-user\extensions\open-image-2-generator
  → D:\programming\silly\open-image-2-generator
```

首次建立连接：

```powershell
./scripts/setup-local.ps1
```

其他安装位置：

```powershell
./scripts/setup-local.ps1 -SillyTavernRoot 'D:\your\SillyTavern' -UserHandle 'default-user'
```

直接编辑源码后刷新 ST 页面即可，无需打包或重新导入脚本。浏览器仍显示旧版本时，使用 Ctrl+F5 强制刷新。安装脚本遇到已有的其他目录会报错，不会覆盖该目录。

## 从旧脚本迁移

先在酒馆助手脚本库中关闭旧的 image2 脚本，再刷新 ST，避免重复生成和面板冲突。旧脚本可以保留作为备份。

扩展首次启动会读取全局脚本、当前角色脚本或当前聊天补全预设中保存的 image2 配置，并将其迁移到 ST 扩展设置。若同时存在多份配置，优先读取启用的脚本；仍有多份候选时会提示先保留一份，避免误选配置。迁移完成后，扩展独立保存设置。

参考图片继续使用原来的浏览器 IndexedDB，标题折叠状态沿用原来的 localStorage 键。使用相同的浏览器配置和 ST 地址时，这些数据可以继续使用；更换浏览器、端口或域名时，先在旧面板导出参考图库，再在新面板导入。

`open_image2_character_reference.json` 是归档的 TavernHelper 版本，后续开发编辑原生扩展源码。

## 源码

| 文件 | 用途 |
| --- | --- |
| `manifest.json` | ST 扩展元数据、入口与样式声明 |
| `index.js` | 等待 ST 就绪后启动扩展 |
| `src/main.js` | 图片请求、参考图库、面板交互与自动生图流程 |
| `src/tavern.js` | ST 原生聊天读写、提示注入、世界书与文本生成接口、设置迁移 |
| `src/defaults.js` | 默认设置与提示词 |
| `src/panel.html` | 面板结构 |
| `style.css` | 面板与图片样式 |
| `scripts/setup-local.ps1` | 建立本地开发目录联接 |

运行 `npm run check` 检查 JS 语法，无需安装 npm 依赖。交互检查在 ST 页面中完成。

## 默认配置与存储

图片服务默认地址为 `http://127.0.0.1:8199/v1/images/generations`，默认模型为 `gpt-image-2`。服务地址、模型、请求参数和提示词可在面板中修改。图片请求沿用浏览器直接访问图片服务的方式，服务需允许 ST 页面跨域访问。

提示词整理支持酒馆当前连接、ST 反向代理预设和独立 API。当前连接使用 ST 原生生成接口，覆盖模型时使用聊天补全连接；独立 API 与反向代理通过 ST 聊天补全后端发送请求。

设置存储于 `extensionSettings.open_image_2_generator`，参考图片存储于 IndexedDB `oair_image2_character_reference_v1`，标题折叠状态存储于 localStorage `oair_image2_character_reference_collapsed_sections_v1`。

## 关联源码

`link/JS-Slash-Runner` 和 `link/SillyTavern` 是指向真实仓库的目录联接；使用前阅读 `AGENTS.md` 中的规则。原生扩展开发通常只需要修改本仓库。
