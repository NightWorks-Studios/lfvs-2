# LFVS-2

基于 Cordis 的多平台媒体资源同步系统，采用 workspace monorepo 结构。

## 当前插件

- `@lfvs/core`：通用资源模型、适配器注册、字段扩展和统一存储。
- `@lfvs/adapter-bilibili-video`：通过 `bilibili-rs-gateway` 获取 Bilibili 视频详情。
- `@lfvs/updater-bilibili-video`：每小时全量刷新本地 Bilibili 视频，默认 4 并发、每批 250 个 BVID。

## 开发

```powershell
Copy-Item app.yml.example app.yml
npm install
npm run dev
```

默认服务地址为 `http://127.0.0.1:3140`。运行前请在 `app.yml` 中确认 Bilibili gateway 的 `endpoint` 配置。

所有插件位于 `external/*`，依赖统一安装在 monorepo 根目录的 `node_modules` 中。
