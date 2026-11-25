# 测试与演示

安装步骤见根目录 README。所有模型协议测试使用本机模拟响应，不需要真实 API Key。

## 自动检查

```powershell
npm --prefix frontend run typecheck
npm --prefix frontend test
npm --prefix frontend run build
.\.venv\Scripts\python.exe -m pytest backend/tests -q
npm --prefix desktop test
```

| 层次 | 主要覆盖 |
| --- | --- |
| 前端 | IndexedDB 事务、并发保存、删除防复活、版本对齐、上下文隔离、选文、卡片分批和修订、模型偏好、备份与快速查找 |
| 后端 | 临时数据库、版本及空间白名单、FTS5、引用校验、模型错误脱敏、生成协议、重放冲突、密钥加解密与桌面迁移 |
| 桌面 | 静态资源路径、外链协议、本机代理令牌、请求头隔离；另有打包后端生命周期集成测试 |

GitHub Actions 在 Windows 上使用 Python 3.12 和 Node.js 24 执行这些检查。桌面测试可直接运行，不需要先安装 Electron；没有打包产物时，独立后端集成测试会明确跳过。执行 `npm --prefix desktop run package` 后再运行桌面测试可以覆盖该分支。

私人笔记语料及依赖该语料的评价脚本不在公开仓库中。通用检索、边界和协议测试自带临时样例，不以私人数据作为运行前提。

2026-11-25 使用待发布文件的干净副本重新安装依赖：前端 85 项、后端 178 项测试通过，类型检查和生产构建通过；桌面协议 3 项通过，打包后端检查因没有构建产物跳过 1 项。构建保留包体积提示，后端保留 Starlette / httpx 弃用提示；这两项不影响本轮检查结果。

## 无额度界面演示

先构建前端，然后执行：

```powershell
.\.venv\Scripts\python.exe -m backend.tests.ui_polish_preview
```

打开 `http://127.0.0.1:8005/__test__/seed`。这是独立示例工作区，后端使用临时目录和模拟模型；可体验问答、GFM 表格、快速查找和相关卡片。README 两张截图来自此类模拟场景。

阅读卡片流程演示：

```powershell
.\.venv\Scripts\python.exe -m backend.tests.card_workshop_preview
```

打开 `http://127.0.0.1:8004/__test__/seed`，体验分批生成、修订、合并、保存、停止及失败恢复。关闭演示进程可按 `Ctrl+C`；浏览器中的示例记录与日常使用地址相互独立。

这些演示入口只用于本机开发，不由正式应用加载。模拟测试不代表真实服务的回答质量、计费、大规模性能或全部辅助技术交互已通过验收。
