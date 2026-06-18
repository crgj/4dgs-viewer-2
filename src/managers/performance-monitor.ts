/**
 * Performance Monitor - 性能治理监控器
 * 
 * 功能：
 * 1. GPU/CPU/内存/纹理占用监控
 * 2. 排序耗时统计
 * 3. 加载阶段耗时分析
 * 4. 性能预警和降级建议
 */

import * as pc from 'playcanvas';

export interface PerformanceMetrics {
    timestamp: number;
    fps: number;
    frameTime: number;
    gpuMemory?: number;
    cpuUsage?: number;
    memoryUsage?: number;
    textureMemory?: number;
    drawCalls?: number;
    triangles?: number;
    sorterTime?: number;
    activeSplats: number;
    visibleSplats: number;
}

export interface LoadPhaseMetrics {
    phase: string;
    startTime: number;
    endTime?: number;
    duration?: number;
    detail?: string;
}

export interface DeviceCapability {
    tier: 'high' | 'medium' | 'low' | 'minimal';
    maxTextureSize: number;
    maxViewportDims: [number, number];
    supportsWebGL2: boolean;
    supportsFloatTextures: boolean;
    hardwareConcurrency: number;
    deviceMemory?: number;
    isMobile: boolean;
    gpuVendor?: string;
    gpuRenderer?: string;
}

export interface PerformanceConfig {
    targetFPS: number;
    adaptiveQuality: boolean;
    mobileDowngrade: boolean;
    largeModelMode: boolean;
    progressiveLoading: boolean;
    maxMemoryMB: number;
    maxTextureMemoryMB: number;
    showWarnings: boolean;
}

export type PerformanceWarningType = 
    | 'low-fps' 
    | 'high-memory' 
    | 'high-gpu-memory' 
    | 'sorter-slow' 
    | 'device-limit'
    | 'thermal-throttling';

export interface PerformanceWarning {
    type: PerformanceWarningType;
    severity: 'info' | 'warning' | 'critical';
    message: string;
    timestamp: number;
    suggestedAction?: string;
}

export class PerformanceMonitor {
    private app: pc.Application;
    private metrics: PerformanceMetrics[] = [];
    private maxMetricsHistory = 300; // 5秒 @ 60fps
    private loadPhases: LoadPhaseMetrics[] = [];
    private currentPhase: LoadPhaseMetrics | null = null;
    private warnings: PerformanceWarning[] = [];
    private maxWarningsHistory = 50;
    
    private lastFrameTime = 0;
    private frameCount = 0;
    private lastFpsUpdate = 0;
    private currentFPS = 0;
    
    private deviceCapability: DeviceCapability;
    private config: PerformanceConfig;
    
    private observers: Set<(metrics: PerformanceMetrics) => void> = new Set();
    private warningObservers: Set<(warning: PerformanceWarning) => void> = new Set();
    
    private gl: WebGL2RenderingContext | WebGLRenderingContext | null = null;
    private extDisjointTimerQuery: any = null;
    private extMemoryInfo: any = null;
    
    // 性能降级状态
    private downgradeLevel = 0; // 0: normal, 1: medium, 2: high, 3: extreme
    private isThrottled = false;
    
    // 大模型模式
    private progressiveLoadProgress = 0;
    private isProgressiveLoading = false;
    
    // 定时器引用（用于销毁时清理）
    private systemMetricsTimer: ReturnType<typeof setInterval> | null = null;
    private frameUpdateHandler: ((dt: number) => void) | null = null;

    constructor(app: pc.Application, config?: Partial<PerformanceConfig>) {
        this.app = app;
        this.config = {
            targetFPS: 30,
            adaptiveQuality: true,
            mobileDowngrade: true,
            largeModelMode: false,
            progressiveLoading: true,
            maxMemoryMB: 2048,
            maxTextureMemoryMB: 1024,
            showWarnings: true,
            ...config
        };
        
        this.deviceCapability = this.detectDeviceCapability();
        this.initWebGLExtensions();
        this.startMonitoring();
        
        console.log('[PerformanceMonitor] Initialized', {
            capability: this.deviceCapability,
            config: this.config
        });
    }

    /**
     * 检测设备能力
     */
    private detectDeviceCapability(): DeviceCapability {
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
        
        const ua = navigator.userAgent;
        const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
        
        let maxTextureSize = 4096;
        let maxViewportDims: [number, number] = [4096, 4096];
        let supportsWebGL2 = false;
        let supportsFloatTextures = false;
        let gpuVendor = 'unknown';
        let gpuRenderer = 'unknown';
        
        if (gl) {
            maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
            maxViewportDims = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
            supportsWebGL2 = gl instanceof WebGL2RenderingContext;
            supportsFloatTextures = !!gl.getExtension('OES_texture_float');
            
            const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
            if (debugInfo) {
                gpuVendor = gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) || 'unknown';
                gpuRenderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) || 'unknown';
            }
        }
        
        // 设备分级
        let tier: DeviceCapability['tier'] = 'high';
        
        if (isMobile) {
            if (maxTextureSize <= 2048 || navigator.hardwareConcurrency <= 4) {
                tier = 'minimal';
            } else if (maxTextureSize <= 4096 || navigator.hardwareConcurrency <= 6) {
                tier = 'low';
            } else {
                tier = 'medium';
            }
        } else {
            if (maxTextureSize <= 2048 || navigator.hardwareConcurrency <= 2) {
                tier = 'minimal';
            } else if (maxTextureSize <= 4096 || navigator.hardwareConcurrency <= 4) {
                tier = 'low';
            } else if (maxTextureSize <= 8192 || navigator.hardwareConcurrency <= 8) {
                tier = 'medium';
            } else {
                tier = 'high';
            }
        }
        
        return {
            tier,
            maxTextureSize,
            maxViewportDims,
            supportsWebGL2,
            supportsFloatTextures,
            hardwareConcurrency: navigator.hardwareConcurrency || 2,
            deviceMemory: (navigator as any).deviceMemory,
            isMobile,
            gpuVendor,
            gpuRenderer
        };
    }

    /**
     * 初始化 WebGL 扩展
     */
    private initWebGLExtensions() {
        const device = this.app.graphicsDevice;
        this.gl = (device as any).gl;
        
        if (this.gl) {
            this.extDisjointTimerQuery = this.gl.getExtension('EXT_disjoint_timer_query_webgl2') ||
                                         this.gl.getExtension('EXT_disjoint_timer_query');
            this.extMemoryInfo = this.gl.getExtension('GMAN_webgl_memory');
        }
    }

    /**
     * 开始监控
     */
    private startMonitoring() {
        this.frameUpdateHandler = (dt: number) => this.onFrameUpdate(dt);
        this.app.on('update', this.frameUpdateHandler);
        
        // 每秒更新一次系统级指标
        this.systemMetricsTimer = setInterval(() => this.collectSystemMetrics(), 1000);
    }

    /**
     * 帧更新
     */
    private onFrameUpdate(dt: number) {
        const now = performance.now();
        this.frameCount++;
        
        // 计算 FPS
        if (now - this.lastFpsUpdate >= 1000) {
            this.currentFPS = this.frameCount;
            this.frameCount = 0;
            this.lastFpsUpdate = now;
        }
        
        // 收集指标
        const metrics: PerformanceMetrics = {
            timestamp: now,
            fps: this.currentFPS,
            frameTime: dt * 1000,
            activeSplats: this.getActiveSplatCount(),
            visibleSplats: this.getVisibleSplatCount()
        };
        
        // 获取 GPU/内存信息
        this.enrichMetrics(metrics);
        
        // 存储历史
        this.metrics.push(metrics);
        if (this.metrics.length > this.maxMetricsHistory) {
            this.metrics.shift();
        }
        
        // 通知观察者
        this.observers.forEach(cb => cb(metrics));
        
        // 检查性能警告
        this.checkPerformanceWarnings(metrics);
        
        // 自适应降级
        if (this.config.adaptiveQuality) {
            this.adaptiveDowngrade(metrics);
        }
        
        this.lastFrameTime = now;
    }

    /**
     * 丰富指标数据
     */
    private enrichMetrics(metrics: PerformanceMetrics) {
        // GPU 内存
        if (this.extMemoryInfo && this.gl) {
            const info = this.gl.getParameter(this.extMemoryInfo.MEMORY_INFO);
            if (info) {
                metrics.gpuMemory = info.total;
                metrics.textureMemory = info.texture;
            }
        }
        
        // 使用 performance.memory (Chrome)
        const perfMemory = (performance as any).memory;
        if (perfMemory) {
            metrics.memoryUsage = perfMemory.usedJSHeapSize / (1024 * 1024);
        }
        
        // 渲染统计
        const device = this.app.graphicsDevice;
        if (device) {
            metrics.drawCalls = (device as any)._drawCalls;
            metrics.triangles = (device as any)._triangles;
        }
    }

    /**
     * 收集系统级指标
     */
    private collectSystemMetrics() {
        // 这里可以收集更慢速的指标
    }

    /**
     * 获取当前活跃的 Splat 数量
     */
    private getActiveSplatCount(): number {
        const viewer = (window as any).viewer;
        if (viewer?.lastParsedData?.count) {
            return viewer.lastParsedData.count;
        }
        const gsplatComponent = viewer?.splatEntity?.gsplat;
        const assetResource = gsplatComponent?.asset?.resource;
        const splatData = assetResource?.splatData;
        if (splatData?.numSplats) {
            return splatData.numSplats;
        }
        return 0;
    }

    /**
     * 获取可见的 Splat 数量
     */
    private getVisibleSplatCount(): number {
        return this.getActiveSplatCount();
    }

    /**
     * 检查性能警告
     */
    private checkPerformanceWarnings(metrics: PerformanceMetrics) {
        if (!this.config.showWarnings) return;
        
        const now = Date.now();
        
        // 低 FPS 警告
        if (metrics.fps < this.config.targetFPS * 0.5) {
            this.addWarning({
                type: 'low-fps',
                severity: 'critical',
                message: `FPS 过低: ${metrics.fps}`,
                timestamp: now,
                suggestedAction: '建议启用性能降级模式或降低模型精度'
            });
        } else if (metrics.fps < this.config.targetFPS * 0.8) {
            this.addWarning({
                type: 'low-fps',
                severity: 'warning',
                message: `FPS 下降: ${metrics.fps}`,
                timestamp: now,
                suggestedAction: '建议调整渲染质量设置'
            });
        }
        
        // 内存警告
        if (metrics.memoryUsage && metrics.memoryUsage > this.config.maxMemoryMB) {
            this.addWarning({
                type: 'high-memory',
                severity: 'critical',
                message: `内存占用过高: ${metrics.memoryUsage.toFixed(0)}MB`,
                timestamp: now,
                suggestedAction: '建议启用渐进加载或关闭其他标签页'
            });
        }
        
        // GPU 内存警告
        if (metrics.gpuMemory && metrics.gpuMemory > this.config.maxTextureMemoryMB * 1024 * 1024) {
            this.addWarning({
                type: 'high-gpu-memory',
                severity: 'critical',
                message: `GPU 内存不足`,
                timestamp: now,
                suggestedAction: '建议降低纹理质量或启用大模型模式'
            });
        }
    }

    /**
     * 添加性能警告
     */
    private addWarning(warning: PerformanceWarning) {
        // 避免重复警告
        const lastWarning = this.warnings[this.warnings.length - 1];
        if (lastWarning && lastWarning.type === warning.type && 
            Date.now() - lastWarning.timestamp < 5000) {
            return;
        }
        
        this.warnings.push(warning);
        if (this.warnings.length > this.maxWarningsHistory) {
            this.warnings.shift();
        }
        
        this.warningObservers.forEach(cb => cb(warning));
        
        console.warn('[PerformanceMonitor]', warning);
    }

    /**
     * 自适应降级
     */
    private adaptiveDowngrade(metrics: PerformanceMetrics) {
        // 根据性能指标自动调整降级级别
        if (metrics.fps < 15 && this.downgradeLevel < 3) {
            this.downgradeLevel++;
            this.applyDowngrade();
        } else if (metrics.fps > 45 && this.downgradeLevel > 0) {
            this.downgradeLevel--;
            this.applyDowngrade();
        }
    }

    /**
     * 应用降级
     */
    private applyDowngrade() {
        const viewer = (window as any).viewer;
        if (!viewer) return;
        
        console.log(`[PerformanceMonitor] Applying downgrade level: ${this.downgradeLevel}`);
        
        switch (this.downgradeLevel) {
            case 0: // 正常模式
                viewer.setHighQuality(true);
                break;
            case 1: // 轻度降级
                viewer.setHighQuality(false);
                break;
            case 2: // 中度降级
                viewer.setHighQuality(false);
                // 降低分辨率
                break;
            case 3: // 极限降级
                viewer.setHighQuality(false);
                // 最低分辨率
                break;
        }
    }

    // ============ 公共 API ============

    /**
     * 开始加载阶段计时
     */
    startLoadPhase(phase: string, detail?: string) {
        this.currentPhase = {
            phase,
            startTime: performance.now(),
            detail
        };
        console.log(`[PerformanceMonitor] Start phase: ${phase}`, detail);
    }

    /**
     * 结束加载阶段计时
     */
    endLoadPhase(phase?: string) {
        if (!this.currentPhase) return;
        
        // 如果指定了 phase，确保匹配
        if (phase && this.currentPhase.phase !== phase) {
            console.warn(`[PerformanceMonitor] Phase mismatch: ${this.currentPhase.phase} vs ${phase}`);
            return;
        }
        
        this.currentPhase.endTime = performance.now();
        this.currentPhase.duration = this.currentPhase.endTime - this.currentPhase.startTime;
        
        this.loadPhases.push({ ...this.currentPhase });
        console.log(`[PerformanceMonitor] End phase: ${this.currentPhase.phase}, duration: ${this.currentPhase.duration.toFixed(1)}ms`);
        
        this.currentPhase = null;
    }

    /**
     * 记录排序耗时
     */
    recordSortTime(duration: number) {
        // 更新最新的 metrics
        const latest = this.metrics[this.metrics.length - 1];
        if (latest) {
            latest.sorterTime = duration;
        }
    }

    /**
     * 更新渐进加载进度
     */
    updateProgressiveLoad(progress: number) {
        this.progressiveLoadProgress = progress;
        this.isProgressiveLoading = progress < 1;
    }

    /**
     * 获取当前指标
     */
    getCurrentMetrics(): PerformanceMetrics | null {
        return this.metrics[this.metrics.length - 1] || null;
    }

    /**
     * 获取指标历史
     */
    getMetricsHistory(): PerformanceMetrics[] {
        return [...this.metrics];
    }

    /**
     * 获取加载阶段统计
     */
    getLoadPhases(): LoadPhaseMetrics[] {
        return [...this.loadPhases];
    }

    /**
     * 获取性能警告
     */
    getWarnings(): PerformanceWarning[] {
        return [...this.warnings];
    }

    /**
     * 获取设备能力
     */
    getDeviceCapability(): DeviceCapability {
        return { ...this.deviceCapability };
    }

    /**
     * 获取配置
     */
    getConfig(): PerformanceConfig {
        return { ...this.config };
    }

    /**
     * 更新配置
     */
    updateConfig(config: Partial<PerformanceConfig>) {
        this.config = { ...this.config, ...config };
    }

    /**
     * 订阅指标更新
     */
    onMetrics(callback: (metrics: PerformanceMetrics) => void): () => void {
        this.observers.add(callback);
        return () => this.observers.delete(callback);
    }

    /**
     * 订阅警告
     */
    onWarning(callback: (warning: PerformanceWarning) => void): () => void {
        this.warningObservers.add(callback);
        return () => this.warningObservers.delete(callback);
    }

    /**
     * 获取性能报告
     */
    getReport() {
        const metrics = this.metrics;
        if (metrics.length === 0) return null;
        
        const fpsValues = metrics.map(m => m.fps);
        const frameTimeValues = metrics.map(m => m.frameTime);
        
        return {
            avgFPS: fpsValues.reduce((a, b) => a + b, 0) / fpsValues.length,
            minFPS: Math.min(...fpsValues),
            maxFPS: Math.max(...fpsValues),
            avgFrameTime: frameTimeValues.reduce((a, b) => a + b, 0) / frameTimeValues.length,
            device: this.deviceCapability,
            loadPhases: this.loadPhases,
            warnings: this.warnings.slice(-10),
            downgradeLevel: this.downgradeLevel,
            progressiveLoadProgress: this.progressiveLoadProgress
        };
    }

    /**
     * 销毁监控器，清理所有定时器和事件监听
     */
    destroy() {
        // 清理定时器
        if (this.systemMetricsTimer !== null) {
            clearInterval(this.systemMetricsTimer);
            this.systemMetricsTimer = null;
        }
        
        // 清理帧更新监听
        if (this.frameUpdateHandler) {
            this.app.off('update', this.frameUpdateHandler);
            this.frameUpdateHandler = null;
        }
        
        // 清理观察者
        this.observers.clear();
        this.warningObservers.clear();
        
        // 清理历史数据
        this.clear();
        
        console.log('[PerformanceMonitor] Destroyed');
    }

    /**
     * 清除历史
     */
    clear() {
        this.metrics = [];
        this.loadPhases = [];
        this.warnings = [];
        this.downgradeLevel = 0;
    }

    /**
     * 设置大模型模式
     */
    setLargeModelMode(enabled: boolean) {
        this.config.largeModelMode = enabled;
        if (enabled) {
            this.config.progressiveLoading = true;
            console.log('[PerformanceMonitor] Large model mode enabled');
        }
    }

    /**
     * 是否正在渐进加载
     */
    isProgressiveLoadActive(): boolean {
        return this.isProgressiveLoading;
    }

    /**
     * 获取渐进加载进度
     */
    getProgressiveLoadProgress(): number {
        return this.progressiveLoadProgress;
    }
}

export default PerformanceMonitor;
