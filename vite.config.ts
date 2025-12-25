import { defineConfig } from 'vite';

export default defineConfig({
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