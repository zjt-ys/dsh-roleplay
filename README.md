# dsh-roleplay

DeepSeek Harness 插件：**角色扮演模式**——人设 / 长期记忆 / 提示词按会话独立保存，并自动注入该会话的系统提示词；侧边栏面板提供人设、记忆、提示词三个页签。

## 工作方式

- **角色扮演模式是一个 agent preset**（`roleplay`）：新建对话时选择它，会话才会获得提示词注入。普通会话不受影响。
- **按会话存储**：每条会话一个 JSON 文件（`$DSH_HOME/roleplay/sessions/<sessionId>.json`），原子写入；索引文件可从目录重建。
- **两段注入**：
  - 人设 + 扮演规则 + 附加要求 → 一个 prompt **section**（`roleplay:persona`）
  - 长期记忆 → 一个 prompt **context**（`roleplay:memory`，置顶优先、条数可限）
  - 两者都是惰性求值：在侧边栏改完，下一次请求立即生效，无需重启或重建会话
- **一个操作，两个调用者**：侧边栏面板编辑的与模型 `roleplay_memory` 工具读写的是同一份档案
- **防呆**：会话还没填人设时，注入「先问清角色」的引导段；会话不是角色扮演模式时，面板显示引导而不是报错

## 面板

侧边栏「角色扮演」图标 → 中央面板，只列出角色扮演会话：

- **人设**：角色名 / 身份定位 / 性格特征 / 所处场景 / 说话风格
- **记忆**：分类（事实 / 事件 / 关系 / 偏好 / 场景）、置顶、增删
- **提示词**：模板（`{{name}}` 等占位符）、附加要求、四个扮演规则开关、记忆条数上限、**合成预览**（显示下一次请求实际注入的全文）

## 安装

```
plugin_manager install_bundle → E:\工作区\dsh-roleplay
```

bundle 的 cordis.patch.yml 会同时插入插件行与 `preset-roleplay` 声明。

## 目录

| 文件 | 作用 |
|---|---|
| `index.js` | 宿主半：按会话存取档案、注入 system prompt、`/api/roleplay/*` 路由、`roleplay_memory` 工具、`/roleplay` 命令 |
| `client.js` | 浏览器半：侧边栏图标 + 面板（三页签），只列角色扮演会话 |
| `prompt.js` | 提示词合成纯函数（规整、模板填充、规则渲染、预览） |
| `store.js` | 磁盘层：一会话一 JSON、原子写、索引 + 目录扫描兜底 |
| `test/` | `node --test` 回归测试（零依赖，43 项） |

## 测试

```powershell
node --test test/prompt.test.mjs test/store.test.mjs test/client.test.mjs test/render.test.mjs test/host.test.mjs
```

## License

MIT
