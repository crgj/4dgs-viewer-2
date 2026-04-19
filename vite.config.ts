import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
    // TODO: 如果发布到 GitHub Pages 的子目录，请将 '/' 替换为 '/仓库名称/'
    // 例如: base: '/4dgs-viewer/',
    base: './',
    publicDir: 'public',
    build: {
        outDir: 'docs',
        emptyOutDir: true,
        rollupOptions: {
            input: {
                main: resolve(__dirname, 'index.html'),
                batchConvert: resolve(__dirname, 'batch-convert.html'),
            },
        },
    },
    server: {
        // 允许通过 IP 访问，方便手机端测试
        host: '0.0.0.0',
        port: 5173,
        // 必须开启，否则无法使用 SharedArrayBuffer 进行高性能排序
        headers: {
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp',
        },
        proxy: {
            '/hf-direct': {
                target: 'https://huggingface.co',
                changeOrigin: true,
                secure: false,
                headers: {
                    'Referer': 'https://huggingface.co'
                },
                rewrite: (path) => path.replace(/^\/hf-direct/, ''),
                configure: (proxy, _options) => {
                    proxy.on('error', (err, _req, _res) => {
                        console.log('proxy error (direct)', err);
                    });
                },
            },
            '/hf-mirror': {
                target: 'https://hf-mirror.com',
                changeOrigin: true,
                secure: false,
                headers: {
                    'Referer': 'https://hf-mirror.com'
                },
                rewrite: (path) => path.replace(/^\/hf-mirror/, ''),
                configure: (proxy, _options) => {
                    proxy.on('error', (err, _req, _res) => {
                        console.log('proxy error', err);
                    });
                    proxy.on('proxyReq', (proxyReq, req, _res) => {
                        console.log('Sending Request to the Target:', req.method, req.url);
                    });
                    proxy.on('proxyRes', (proxyRes, req, _res) => {
                        console.log('Received Response from the Target:', proxyRes.statusCode, req.url);
                    });
                },
            },
        },
    },
});
