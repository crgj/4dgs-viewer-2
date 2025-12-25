# 部署指南 (Deployment Guide)

由于之前遇到了 MIME type 错误，我们已经切换到了更简单稳定的 **Failed-Safe 部署模式 (Docs Folder Strategy)**。

## 1. 提交更新到 GitHub

这步操作我已经帮你执行了本地构建和提交，现在你只需要把代码推送到远程仓库：

```bash
git push
```

## 2. 更改 GitHub Pages 设置 (关键步骤)

请务必按照以下步骤修改 GitHub 仓库的设置，否则依然会报错：

1.  打开你的 GitHub 仓库页面。
2.  点击顶部的 **Settings** (设置) 选项卡。
3.  在左侧侧边栏中找到 **Pages** (页面)。
4.  在 **Build and deployment** (构建与部署) 部分：
    *   **Source**: 选择 **Deploy from a branch** (从分支部署)。
    *   **Branch**: 选择 `main` 分支。
    *   **Folder**: **最重要的一步**，选择 `/docs` 文件夹 (不要选 root)。
5.  点击 **Save** (保存)。

## 3. 完成

保存后，等待约 1-2 分钟，页面顶部的链接就会更新。刷新该链接，你的应用应该就能正常运行了，之前的 MIME type 错误将不再出现。
