import { defineConfig } from 'vite';

export default defineConfig({
    // TODO: 如果发布到 GitHub Pages 的子目录，请将 '/' 替换为 '/仓库名称/'
    // 例如: base: '/4dgs-viewer/',
    base: './',
    server: {
        // 允许通过 IP 访问，方便手机端测试
        host: '0.0.0.0',
        port: 5173,
        // 必须开启，否则无法使用 SharedArrayBuffer 进行高性能排序
        headers: {
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp',
        },
    },
});