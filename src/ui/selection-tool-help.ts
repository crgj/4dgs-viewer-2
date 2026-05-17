// #WDD 2026-04-20: Extracted from selection-tool.ts for modularity
// Help modal logic for SelectionTool
// #WDD-gpt 2026-05-16: 全面升级帮助界面，覆盖智能对齐、圆柱选择、Lazy模式等全部新功能
// #WDD-gpt 2026-05-17: 改为多页标签式布局，去除滚动条，支持主题自适应

export class SelectionToolHelp {
    private helpModal: HTMLElement | null = null;
    private currentPage = 0;
    private readonly totalPages = 5;

    createHelpModal() {
        const modal = document.createElement('div');
        modal.id = 'help-modal';
        modal.className = 'fixed inset-0 z-50 hidden flex items-center justify-center bg-black/60 backdrop-blur-sm';

        const isLight = document.body.classList.contains('theme-light');
        const themeClass = isLight ? 'theme-light' : '';

        modal.innerHTML = `
            <div class="glass-blue p-0 rounded-xl max-w-lg w-full mx-4 shadow-2xl border border-white/10 overflow-hidden ${themeClass}" id="help-modal-card">
                <!-- Header -->
                <div class="flex justify-between items-center px-6 py-4 border-b border-white/10">
                    <h2 class="text-lg font-bold text-white flex items-center gap-2 help-title">
                        <svg viewBox="0 0 24 24" class="w-6 h-6 fill-current text-yellow-400"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17h-2v-2h2v2zm2.07-7.75l-.9.92C13.45 12.9 13 13.5 13 15h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H8c0-2.21 1.79-4 4-4s4 1.79 4 4c0 .88-.36 1.68-.93 2.25z"/></svg>
                        <span>使用帮助</span>
                    </h2>
                    <button id="help-close" class="p-1 hover:bg-white/10 rounded-lg transition-colors">
                        <svg viewBox="0 0 24 24" class="w-6 h-6 fill-current text-gray-400 hover:text-white"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
                    </button>
                </div>

                <!-- Tab Navigation -->
                <div class="flex items-center justify-center gap-1 px-6 pt-3 pb-1">
                    ${this.renderTabs()}
                </div>

                <!-- Page Content -->
                <div class="px-6 py-4 min-h-[280px]" id="help-pages">
                    ${this.renderPage0()}
                    ${this.renderPage1()}
                    ${this.renderPage2()}
                    ${this.renderPage3()}
                    ${this.renderPage4()}
                </div>

                <!-- Footer -->
                <div class="px-6 py-3 border-t border-white/10 flex items-center justify-between">
                    <button id="help-prev" class="help-nav-btn px-3 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider opacity-50 pointer-events-none transition-all">
                        ← Prev
                    </button>
                    <div class="flex items-center gap-1.5" id="help-dots">
                        ${this.renderDots()}
                    </div>
                    <button id="help-next" class="help-nav-btn px-3 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider transition-all">
                        Next →
                    </button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        this.helpModal = modal;

        // Event bindings
        modal.querySelector('#help-close')?.addEventListener('click', () => this.hideHelpModal());
        modal.addEventListener('click', (e) => {
            if (e.target === modal) this.hideHelpModal();
        });

        modal.querySelector('#help-prev')?.addEventListener('click', () => this.goPage(this.currentPage - 1));
        modal.querySelector('#help-next')?.addEventListener('click', () => this.goPage(this.currentPage + 1));

        // Tab clicks
        modal.querySelectorAll('.help-tab').forEach((tab, idx) => {
            tab.addEventListener('click', () => this.goPage(idx));
        });

        this.updatePageVisibility();
    }

    private renderTabs(): string {
        const tabs = [
            { label: '选择', color: 'text-emerald-400', border: 'border-emerald-400' },
            { label: '智能', color: 'text-cyan-400', border: 'border-cyan-400' },
            { label: '序列', color: 'text-amber-400', border: 'border-amber-400' },
            { label: '播放', color: 'text-pink-400', border: 'border-pink-400' },
            { label: '提示', color: 'text-yellow-400', border: 'border-yellow-400' },
        ];
        return tabs.map((t, i) => `
            <button class="help-tab px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider transition-all border border-transparent hover:bg-white/5 ${t.color}"
                data-page="${i}" data-active-border="${t.border}">
                ${t.label}
            </button>
        `).join('');
    }

    private renderDots(): string {
        return Array.from({ length: this.totalPages }, (_, i) => `
            <span class="help-dot w-1.5 h-1.5 rounded-full bg-white/20 transition-all" data-page="${i}"></span>
        `).join('');
    }

    // ========== Page 0: 选择工具 ==========
    private renderPage0(): string {
        return `
            <div class="help-page" data-page="0">
                <div class="space-y-4 text-sm">
                    <div>
                        <h3 class="text-xs uppercase font-bold text-emerald-400 mb-2 tracking-wider">选择工具</h3>
                        <ul class="space-y-1.5 text-gray-200">
                            <li class="flex items-center gap-2"><kbd class="px-2 py-0.5 bg-white/10 rounded text-xs font-mono">1</kbd><span>切换<strong>笔刷选择</strong>工具（再按关闭）</span></li>
                            <li class="flex items-center gap-2"><kbd class="px-2 py-0.5 bg-white/10 rounded text-xs font-mono">2</kbd><span>切换<strong>矩形选择</strong>工具（再按关闭）</span></li>
                            <li class="flex items-center gap-2"><kbd class="px-2 py-0.5 bg-white/10 rounded text-xs font-mono">3</kbd><span>切换<strong>多边形选择</strong>工具（再按关闭）</span></li>
                            <li class="flex items-center gap-2"><kbd class="px-2 py-0.5 bg-white/10 rounded text-xs font-mono">4</kbd><span>切换<strong>全时段笔刷</strong>工具（选中所有帧可见点）</span></li>
                            <li class="flex items-center gap-2"><kbd class="px-2 py-0.5 bg-white/10 rounded text-xs font-mono">5</kbd><span>切换<strong>全时段矩形</strong>工具（选中所有帧可见点）</span></li>
                            <li class="flex items-center gap-2"><kbd class="px-2 py-0.5 bg-white/10 rounded text-xs font-mono">6</kbd><span>切换<strong>全时段多边形</strong>工具（选中所有帧可见点）</span></li>
                            <li class="flex items-center gap-2"><kbd class="px-2 py-0.5 bg-white/10 rounded text-xs font-mono">Alt</kbd><span>按住进入<strong>减选模式</strong>（从选区移除）</span></li>
                            <li class="flex items-center gap-2"><kbd class="px-2 py-0.5 bg-white/10 rounded text-xs font-mono">Esc</kbd><span>退出当前选择工具</span></li>
                        </ul>
                    </div>
                    <div>
                        <h3 class="text-xs uppercase font-bold text-blue-400 mb-2 tracking-wider">选择模式</h3>
                        <ul class="space-y-1.5 text-gray-200">
                            <li class="flex items-center gap-2"><span class="w-2 h-2 rounded-full bg-blue-400"></span><span><strong>中心模式</strong> - 仅选择中心点在选区内的点</span></li>
                            <li class="flex items-center gap-2"><span class="w-2 h-2 rounded-full bg-purple-400"></span><span><strong>椭圆模式</strong> - 考虑点的屏幕空间大小</span></li>
                        </ul>
                    </div>
                    <div>
                        <h3 class="text-xs uppercase font-bold text-red-400 mb-2 tracking-wider">删除操作</h3>
                        <ul class="space-y-1.5 text-gray-200">
                            <li class="flex items-center gap-2"><kbd class="px-2 py-0.5 bg-white/10 rounded text-xs font-mono">Delete</kbd><span>删除当前<strong>选中的点</strong></span></li>
                            <li class="flex items-center gap-2"><kbd class="px-2 py-0.5 bg-white/10 rounded text-xs font-mono">Ctrl+Z</kbd><span><strong>撤销</strong>删除（最多30步）</span></li>
                            <li class="flex items-center gap-2"><kbd class="px-2 py-0.5 bg-white/10 rounded text-xs font-mono">Ctrl+Y</kbd><span>或 <kbd class="px-1.5 py-0.5 bg-white/10 rounded text-xs font-mono">Ctrl+Shift+Z</kbd> <strong>重做</strong>删除</span></li>
                        </ul>
                    </div>
                </div>
            </div>
        `;
    }

    // ========== Page 1: 智能对齐 & 圆柱选择 ==========
    private renderPage1(): string {
        return `
            <div class="help-page hidden" data-page="1">
                <div class="space-y-4 text-sm">
                    <div>
                        <h3 class="text-xs uppercase font-bold text-cyan-400 mb-2 tracking-wider">智能对齐 & 圆柱选择</h3>
                        <ul class="space-y-1.5 text-gray-200">
                            <li class="flex items-start gap-2"><span class="w-2 h-2 rounded-full bg-cyan-400 mt-1.5 shrink-0"></span><span><strong>Auto Align</strong> - 自动检测地面并旋转平移场景，使人物直立、地面水平</span></li>
                            <li class="flex items-start gap-2"><span class="w-2 h-2 rounded-full bg-cyan-400 mt-1.5 shrink-0"></span><span><strong>Show Cylinder</strong> - 对齐完成后显示可调圆柱区域（网格线框预览）</span></li>
                            <li class="flex items-start gap-2"><span class="w-2 h-2 rounded-full bg-cyan-400 mt-1.5 shrink-0"></span><span><strong>R / H / X / Z / GROUND</strong> - 调整圆柱半径、高度、中心位置、地面余量</span></li>
                            <li class="flex items-start gap-2"><span class="w-2 h-2 rounded-full bg-cyan-400 mt-1.5 shrink-0"></span><span><strong>Select In Cylinder</strong> - 按圆柱区域全时段选择点（支持多段PLY4序列）</span></li>
                            <li class="flex items-start gap-2"><span class="w-2 h-2 rounded-full bg-cyan-400 mt-1.5 shrink-0"></span><span>输入框支持<strong>Scrub拖拽</strong>：按住鼠标左右拖动即可微调数值</span></li>
                        </ul>
                    </div>
                    <div class="p-3 bg-cyan-500/10 rounded-lg border border-cyan-500/20">
                        <h3 class="text-xs uppercase font-bold text-cyan-400 mb-1 tracking-wider">💡 工作流程</h3>
                        <p class="text-gray-300 text-xs leading-relaxed">
                            1. 加载模型 → 2. 点击 <strong>Auto Align</strong> → 3. 等待分析完成 → 4. 点击 <strong>Show Cylinder</strong> → 5. 调整参数 → 6. 点击 <strong>Select In Cylinder</strong> → 7. 按 Delete 删除
                        </p>
                    </div>
                </div>
            </div>
        `;
    }

    // ========== Page 2: PLY4 序列模式 ==========
    private renderPage2(): string {
        return `
            <div class="help-page hidden" data-page="2">
                <div class="space-y-4 text-sm">
                    <div>
                        <h3 class="text-xs uppercase font-bold text-amber-400 mb-2 tracking-wider">PLY4 序列加载模式</h3>
                        <ul class="space-y-1.5 text-gray-200">
                            <li class="flex items-start gap-2"><span class="w-2 h-2 rounded-full bg-emerald-400 mt-1.5 shrink-0"></span><span><strong>FULL 模式</strong>（&lt;4GB）- 全序列一次性加载，所有手工选择工具可用</span></li>
                            <li class="flex items-start gap-2"><span class="w-2 h-2 rounded-full bg-cyan-400 mt-1.5 shrink-0"></span><span><strong>LAZY 模式</strong>（&ge;4GB）- 仅加载当前段，节省内存；笔刷/矩形/多边形工具自动隐藏</span></li>
                            <li class="flex items-start gap-2"><span class="w-2 h-2 rounded-full bg-amber-400 mt-1.5 shrink-0"></span><span>Lazy模式下仍可使用<strong>反选、清空、撤销、删除</strong>和<strong>智能圆柱选择</strong></span></li>
                            <li class="flex items-start gap-2"><span class="w-2 h-2 rounded-full bg-amber-400 mt-1.5 shrink-0"></span><span>切换未缓存段时播放自动暂停，右下角显示读取进度</span></li>
                        </ul>
                    </div>
                    <div class="p-3 bg-amber-500/10 rounded-lg border border-amber-500/20">
                        <h3 class="text-xs uppercase font-bold text-amber-400 mb-1 tracking-wider">💡 多段序列</h3>
                        <p class="text-gray-300 text-xs leading-relaxed">
                            同时拖拽多个 <strong>.sog4</strong> 或 <strong>.ply4</strong> 文件即可加载序列。系统按文件名数字排序。选择和删除状态会<strong>按段独立保存</strong>，切换段后自动恢复。
                        </p>
                    </div>
                </div>
            </div>
        `;
    }

    // ========== Page 3: Playbar & Timeline ==========
    private renderPage3(): string {
        return `
            <div class="help-page hidden" data-page="3">
                <div class="space-y-4 text-sm">
                    <div>
                        <h3 class="text-xs uppercase font-bold text-pink-400 mb-2 tracking-wider">播放栏 & 时间线</h3>
                        <ul class="space-y-1.5 text-gray-200">
                            <li class="flex items-start gap-2"><span class="w-2 h-2 rounded-full bg-pink-400 mt-1.5 shrink-0"></span><span>多段 PLY4 序列播放时，<strong>Playbar</strong> 显示当前段编号、文件名、段内帧号、加载模式（FULL/LAZY）</span></li>
                            <li class="flex items-start gap-2"><span class="w-2 h-2 rounded-full bg-pink-400 mt-1.5 shrink-0"></span><span><strong>Timeline</strong> 上用青色竖线和数字标记每段边界，当前段高亮为绿色</span></li>
                            <li class="flex items-start gap-2"><span class="w-2 h-2 rounded-full bg-pink-400 mt-1.5 shrink-0"></span><span>鼠标悬停段标记可查看完整文件名、全局帧范围、缓存状态</span></li>
                            <li class="flex items-start gap-2"><span class="w-2 h-2 rounded-full bg-pink-400 mt-1.5 shrink-0"></span><span>单文件模式下段信息自动隐藏，保持时间线简洁</span></li>
                        </ul>
                    </div>
                    <div class="p-3 bg-pink-500/10 rounded-lg border border-pink-500/20">
                        <h3 class="text-xs uppercase font-bold text-pink-400 mb-1 tracking-wider">💡 时间线控制</h3>
                        <p class="text-gray-300 text-xs leading-relaxed">
                            <strong>A / B / LOOP</strong> - 设置循环区间：先移到起始帧点 <strong>A</strong>，再移到结束帧点 <strong>B</strong>，最后点 <strong>LOOP</strong> 开启循环。点击 <strong>← / →</strong> 逐帧步进。
                        </p>
                    </div>
                </div>
            </div>
        `;
    }

    // ========== Page 4: 提示 ==========
    private renderPage4(): string {
        return `
            <div class="help-page hidden" data-page="4">
                <div class="space-y-4 text-sm">
                    <div class="p-3 bg-yellow-500/10 rounded-lg border border-yellow-500/20">
                        <h3 class="text-xs uppercase font-bold text-yellow-400 mb-1 tracking-wider">💡 时间感知选择</h3>
                        <p class="text-gray-300 text-xs leading-relaxed">
                            选择工具现在是<strong>时间感知</strong>的！只会选择当前时刻可见的点。播放动画时，当前时刻会自动更新。
                        </p>
                    </div>
                    <div class="p-3 bg-yellow-500/10 rounded-lg border border-yellow-500/20">
                        <h3 class="text-xs uppercase font-bold text-yellow-400 mb-1 tracking-wider">💡 全时段选择</h3>
                        <p class="text-gray-300 text-xs leading-relaxed">
                            <strong>全时段选择</strong>（<kbd class="px-1 py-0.5 bg-white/5 rounded text-xs">4</kbd> / <kbd class="px-1 py-0.5 bg-white/5 rounded text-xs">5</kbd> / <kbd class="px-1 py-0.5 bg-white/5 rounded text-xs">6</kbd>）可选中所有时间帧内可见的点，适合清理跨帧噪点。
                        </p>
                    </div>
                    <div class="p-3 bg-yellow-500/10 rounded-lg border border-yellow-500/20">
                        <h3 class="text-xs uppercase font-bold text-yellow-400 mb-1 tracking-wider">💡 基本操作</h3>
                        <p class="text-gray-300 text-xs leading-relaxed">
                            左键拖拽旋转视角 · 右键拖拽平移 · 滚轮缩放 · <kbd class="px-1 py-0.5 bg-white/5 rounded text-xs">空格</kbd> 播放/暂停 · <kbd class="px-1 py-0.5 bg-white/5 rounded text-xs">H</kbd> 隐藏UI · <kbd class="px-1 py-0.5 bg-white/5 rounded text-xs">WASD</kbd> 移动相机
                        </p>
                    </div>
                </div>
            </div>
        `;
    }

    // ========== Navigation ==========
    private goPage(page: number) {
        if (page < 0 || page >= this.totalPages) return;
        this.currentPage = page;
        this.updatePageVisibility();
    }

    private updatePageVisibility() {
        if (!this.helpModal) return;

        // Pages
        this.helpModal.querySelectorAll('.help-page').forEach((el) => {
            const p = Number((el as HTMLElement).dataset.page);
            el.classList.toggle('hidden', p !== this.currentPage);
        });

        // Tabs
        this.helpModal.querySelectorAll('.help-tab').forEach((el) => {
            const p = Number((el as HTMLElement).dataset.page);
            const activeBorder = (el as HTMLElement).dataset.activeBorder || 'border-white';
            const isActive = p === this.currentPage;
            el.classList.toggle('bg-white/10', isActive);
            el.classList.toggle('border-transparent', !isActive);
            if (isActive) {
                el.classList.add(activeBorder);
            } else {
                el.classList.remove(activeBorder);
            }
        });

        // Dots
        this.helpModal.querySelectorAll('.help-dot').forEach((el) => {
            const p = Number((el as HTMLElement).dataset.page);
            el.classList.toggle('bg-white/60', p === this.currentPage);
            el.classList.toggle('bg-white/20', p !== this.currentPage);
            el.classList.toggle('scale-125', p === this.currentPage);
        });

        // Prev/Next buttons
        const prevBtn = this.helpModal.querySelector('#help-prev') as HTMLElement | null;
        const nextBtn = this.helpModal.querySelector('#help-next') as HTMLElement | null;
        if (prevBtn) {
            const disabled = this.currentPage === 0;
            prevBtn.classList.toggle('opacity-50', disabled);
            prevBtn.classList.toggle('pointer-events-none', disabled);
        }
        if (nextBtn) {
            const disabled = this.currentPage === this.totalPages - 1;
            nextBtn.classList.toggle('opacity-50', disabled);
            nextBtn.classList.toggle('pointer-events-none', disabled);
            nextBtn.textContent = disabled ? 'Done' : 'Next →';
        }
    }

    toggleHelpModal() {
        if (!this.helpModal) {
            this.createHelpModal();
        }
        if (!this.helpModal) return;

        // Sync theme on open
        const card = this.helpModal.querySelector('#help-modal-card');
        if (card) {
            const isLight = document.body.classList.contains('theme-light');
            card.classList.toggle('theme-light', isLight);
        }

        if (this.helpModal.classList.contains('hidden')) {
            this.currentPage = 0;
            this.updatePageVisibility();
            this.helpModal.classList.remove('hidden');
        } else {
            this.hideHelpModal();
        }
    }

    hideHelpModal() {
        this.helpModal?.classList.add('hidden');
    }

    getModal() { return this.helpModal; }
}
