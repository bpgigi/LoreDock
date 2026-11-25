# LoreDock Windows 桌面版

桌面版复用 `frontend/` 和 `backend/`，增加薄 Electron 外壳；页面、模型配置、编辑器、资料检索和卡片仍由原代码实现。修改功能不需要维护第二份界面。

## 打开与退出

双击项目根目录的 `启动LoreDock桌面版.bat`，或 `release/win-unpacked/LoreDock.exe`。该目录包含完整运行环境，日常使用无需启动终端、安装 Python 或 Node.js。复制软件时需复制整个 `win-unpacked` 文件夹，不能只复制 EXE。

关闭窗口会退出软件和它启动的后端。重复打开会回到同一个窗口。已有的 `启动LoreDock.bat` 和 `停止LoreDock.bat` 继续用于网页版开发，不影响桌面版。

按 Alt 显示菜单，可打开数据目录和日志目录。程序目前为本机未签名版本，没有自动更新、安装器或开机启动。

## 数据位置与迁移

- 桌面工作区：`%APPDATA%\LoreDock` 下的应用存储，保存空间、正文、草稿、会话、卡片和非敏感偏好。固定来源 `loredock://app/`，不随后台端口变化。
- 后端资料：`%APPDATA%\LoreDock\data`，包含 SQLite、上传原文与待导入包。
- 日志：`%APPDATA%\LoreDock\logs`。
- 软件发布目录不包含个人资料、模型配置或密钥；替换程序不会覆盖上述数据目录。

从原浏览器迁移时，在原来使用的浏览器打开原地址 `http://127.0.0.1:5173/`，点击左下角“工作区备份与迁移”→“导出工作区”。桌面版同一入口选择“导入工作区”，确认文件中的资料、卡片、会话与草稿数量后导入。不要用重新导入学习包代替工作区迁移，否则拿不到原来的编辑、会话和卡片。

JSON 备份包含 IndexedDB 工作区的全部记录与未知旧字段。导入会校验关系，用单次事务替换；失败回滚，成功重新加载，并阻止旧页面的迟到保存覆盖导入结果。导入前会生成当前工作区下载备份，并保留一份内部恢复快照。不同窗口或浏览器不会自动同步，迁移后以桌面版为日常工作区。

首次复制后端资料可运行：

```powershell
./.venv/Scripts/python.exe tools/migrate_desktop_data.py
```

该脚本使用 SQLite backup 读取已提交的 WAL 数据，并对原文与导入包逐文件校验 SHA-256；原目录保留。目标目录存在时拒绝覆盖。迁移清单位于桌面数据目录 `migration.json`。加密密钥仍绑定原 Windows 账户，复制到另一台电脑或另一个账户后需重新填写密钥。

**完整备份**：先关闭桌面版，再复制整个 `%APPDATA%\LoreDock` 文件夹到独立备份目录。JSON 备份只覆盖工作区，不能替代包含后端 SQLite、原文与配置的完整备份。恢复整个目录前同样关闭桌面版并先另存当前目录；恢复到同一 Windows 账户。

## 继续开发与重新打包

首次准备桌面构建依赖（已有依赖无需重装）：

```powershell
npm --prefix frontend ci
npm --prefix desktop ci
./.venv/Scripts/python.exe -m pip install -r backend/requirements.txt -r desktop/requirements-build.txt
```

开发窗口：`npm --prefix desktop start`，会先构建当前前端，再用项目 `.venv` 运行同一后端。快速修改界面仍可使用原有 Vite 网页开发流程；桌面窗口按 Alt → 视图 → 开发工具可调试。开发桌面窗口与发布版共用桌面工作区，不能同时运行两个实例；试验性数据应先备份。

发布：`npm --prefix desktop run package`。关闭已打开的桌面版后执行，输出覆盖 `release/win-unpacked` 中的程序，不清理应用数据目录。增加纯 Python 模块通常会自动收集；动态导入或额外资源需在构建脚本显式包含。

一次界面操作经过：

1. `frontend/src/App.tsx` 及原组件处理页面；`storage.ts` 保存本地工作区。
2. `desktop/src/protocol.cjs` 从固定应用来源提供静态文件，并代理 `/api`。
3. `backend/desktop_entry.py` 启动已有 `backend/app.py`，使用独立数据目录。
4. `desktop/src/main.cjs` 管理窗口、单实例与后端生命周期。

后台仅监听随机本机端口，使用每次启动生成的令牌；渲染页没有 Node.js 权限，不能直接读磁盘或取得令牌。网页中已有的来源过滤仍然生效。

## 验证与边界

```powershell
npm --prefix frontend test
npm --prefix frontend run typecheck
npm --prefix desktop test
./.venv/Scripts/python.exe -m pytest backend/tests -q
```

桌面包装复用关键词检索、Markdown 编辑和知识卡片。Chroma／Embedding、真实模型质量、跨设备密钥恢复与规模性能仍需分别验证。前端构建目前仍有包体积提示；自动检查与模拟演示方法见 [测试说明](TESTING.md)。

修改界面后，可先运行桌面开发窗口检查，再打包验证同一份前端构建在发布版中的表现。
