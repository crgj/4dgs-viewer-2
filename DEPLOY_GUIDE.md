# 部署指南 (Deployment Guide)

以下是将本项目上传到 GitHub 并配置在线浏览 (GitHub Pages) 的完整步骤。

## 1. 准备工作 (已完成)

我已经为你配置好了以下文件：
*   **`vite.config.ts`**: 设置了 `base: './'`，确保应用可以在任何子路径下运行（例如 `https://yourname.github.io/repo-name/`）。
*   **`.github/workflows/deploy.yml`**: 创建了一个自动化工作流。当你把代码推送到 GitHub 的 `main` 分支时，它会自动打包项目并发布到 GitHub Pages。

## 2. 初始化 Git 并推送到 GitHub

请在终端中依次执行以下命令：

1.  **初始化仓库** (如果从未初始化过):
    ```bash
    git init
    ```

2.  **添加所有文件**:
    ```bash
    git add .
    ```

3.  **提交更改**:
    ```bash
    git commit -m "Initial commit with deployment workflow"
    ```

4.  **关联远程仓库**:
    *   首先，前往 [GitHub](https://github.com/new) 创建一个新的仓库（例如命名为 `4dgs-viewer`）。
    *   创建后，复制仓库的 HTTPS 或 SSH 地址。
    *   运行以下命令（将 `<URL>` 替换为你的仓库地址）:
        ```bash
        git branch -M main
        git remote add origin <你的仓库地址URL>
        git push -u origin main
        ```

## 3. 在 GitHub 上启用 Pages

代码上传成功后，进行最后一步配置：

1.  打开你的 GitHub 仓库页面。
2.  点击顶部的 **Settings** (设置) 选项卡。
3.  在左侧侧边栏中找到 **Pages** (页面)。
4.  在 **Build and deployment** (构建与部署) 部分：
    *   **Source**: 选择 **GitHub Actions** (这一步非常重要，因为我们使用了 automated workflow)。
5.  配置完成后，点击页面顶部的 **Actions** 选项卡，你应该能看到名为 "Deploy to GitHub Pages" 的工作流正在运行。
    *   等待它变成绿色对勾（Success）。
6.  点击具体的 workflow run，或者回到 **Settings > Pages**，你将看到生成的在线访问链接（例如 `https://yourname.github.io/4dgs-viewer/`）。

## 4. 后续更新

以后每次你修改代码并运行 `git push` 推送到 GitHub，网站都会自动更新。
