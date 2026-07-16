import { defineConfig } from 'vite';
import { resolve } from 'path';
import fs from 'fs';

// #WDD-gpt  2026-07-16 - 从独立 VERSION 文件读取页面版本号，避免在 index.html 中重复硬编码
const appVersion = fs.readFileSync(resolve(__dirname, 'VERSION'), 'utf8').trim();

export default defineConfig({
    plugins: [
        {
            name: 'inject-app-version',
            transformIndexHtml(html) {
                return html.split('__APP_VERSION__').join(appVersion);
            },
        },
    ],
    // TODO: 如果发布到 GitHub Pages 的子目录，请将 '/' 替换为 '/仓库名称/'
    // 例如: base: '/4dgs-viewer/',
    base: './',
    publicDir: 'public',
    worker: {
        format: 'es'
    },
    build: {
        outDir: 'docs',
        emptyOutDir: true,
        rollupOptions: {
            input: Object.fromEntries(
                fs.readdirSync(__dirname)
                    .filter(file => file.endsWith('.html'))
                    .map(file => [file.replace(/\.html$/, ''), resolve(__dirname, file)])
            ),
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
            // #WDD-gpt 2026-06-18 - Roboflow SAM3 serverless API 未向浏览器返回 ACAO；本地开发通过同源代理避免 Failed fetch
            '/api/sam3': {
                target: 'https://serverless.roboflow.com',
                changeOrigin: true,
                secure: true,
                rewrite: (path) => path.replace(/^\/api\/sam3/, '/sam3'),
                configure: (proxy, _options) => {
                    proxy.on('error', (err, _req, _res) => {
                        console.log('proxy error (sam3)', err);
                    });
                },
            },
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
