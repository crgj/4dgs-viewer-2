// #WDD 2026-04-20: Extracted from selection-tool.ts for modularity
// Help modal logic for SelectionTool
// #WDD-gpt 2026-05-16: 全面升级帮助界面，覆盖智能对齐、圆柱选择、Lazy模式等全部新功能
// #WDD-gpt 2026-05-17: 改为多页标签式布局，去除滚动条，支持主题自适应
// #WDD-gpt 2026-06-13 - 更新帮助内容，补充 Render ALL 与 Delete Hidden 清理流程
// #WDD-gpt 2026-06-13 - 同步左侧选择栏新布局：范围切换、编辑组、顶部撤销重做、智能面板隐藏点清理

import { onLanguageChange, t } from '../i18n';

export class SelectionToolHelp {
    private helpModal: HTMLElement | null = null;
    private currentPage = 0;
    private readonly totalPages = 5;

    constructor() {
        onLanguageChange(() => {
            if (!this.helpModal) return;
            const wasOpen = !this.helpModal.classList.contains('hidden');
            this.helpModal.remove();
            this.helpModal = null;
            this.createHelpModal();
            const nextModal = document.getElementById('help-modal');
            if (wasOpen && nextModal) nextModal.classList.remove('hidden');
        });
    }

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
                        <span>${t('help.title')}</span>
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
                        ${t('help.prev')}
                    </button>
                    <div class="flex items-center gap-1.5" id="help-dots">
                        ${this.renderDots()}
                    </div>
                    <button id="help-next" class="help-nav-btn px-3 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider transition-all">
                        ${t('help.next')}
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
            { label: t('help.tab.select'), color: 'text-emerald-400', border: 'border-emerald-400' },
            { label: t('help.tab.smart'), color: 'text-cyan-400', border: 'border-cyan-400' },
            { label: t('help.tab.sequence'), color: 'text-amber-400', border: 'border-amber-400' },
            { label: t('help.tab.playback'), color: 'text-pink-400', border: 'border-pink-400' },
            { label: t('help.tab.tips'), color: 'text-yellow-400', border: 'border-yellow-400' },
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

    // ========== Page 0: Selection Tools ==========
    private renderPage0(): string {
        return `
            <div class="help-page" data-page="0">
                <div class="space-y-4 text-sm">
                    <div>
                        <h3 class="text-xs uppercase font-bold text-emerald-400 mb-2 tracking-wider">${t('help.selection.title')}</h3>
                        <ul class="space-y-1.5 text-gray-200">
                            <li class="flex items-center gap-2"><span class="px-2 py-0.5 bg-white/10 rounded text-xs font-bold">Current / All-Time</span><span>${t('help.selection.scope')}</span></li>
                            <li class="flex items-center gap-2"><kbd class="px-2 py-0.5 bg-white/10 rounded text-xs font-mono">1</kbd><span>${t('help.selection.brush')}</span></li>
                            <li class="flex items-center gap-2"><kbd class="px-2 py-0.5 bg-white/10 rounded text-xs font-mono">2</kbd><span>${t('help.selection.rect')}</span></li>
                            <li class="flex items-center gap-2"><kbd class="px-2 py-0.5 bg-white/10 rounded text-xs font-mono">3</kbd><span>${t('help.selection.poly')}</span></li>
                            <li class="flex items-center gap-2"><kbd class="px-2 py-0.5 bg-white/10 rounded text-xs font-mono">Alt</kbd><span>${t('help.selection.subtract')}</span></li>
                            <li class="flex items-center gap-2"><kbd class="px-2 py-0.5 bg-white/10 rounded text-xs font-mono">Esc</kbd><span>${t('help.selection.exit')}</span></li>
                        </ul>
                    </div>
                    <div>
                        <h3 class="text-xs uppercase font-bold text-blue-400 mb-2 tracking-wider">${t('help.hitMode.title')}</h3>
                        <ul class="space-y-1.5 text-gray-200">
                            <li class="flex items-center gap-2"><span class="w-2 h-2 rounded-full bg-emerald-400"></span><span>${t('help.hitMode.centers')}</span></li>
                            <li class="flex items-center gap-2"><span class="w-2 h-2 rounded-full bg-yellow-400"></span><span>${t('help.hitMode.rings')}</span></li>
                        </ul>
                    </div>
                    <div>
                        <h3 class="text-xs uppercase font-bold text-red-400 mb-2 tracking-wider">${t('help.edit.title')}</h3>
                        <ul class="space-y-1.5 text-gray-200">
                            <li class="flex items-center gap-2"><span class="px-2 py-0.5 bg-white/10 rounded text-xs font-bold">Edit</span><span>${t('help.edit.grouped')}</span></li>
                            <li class="flex items-center gap-2"><kbd class="px-2 py-0.5 bg-white/10 rounded text-xs font-mono">Delete</kbd><span>${t('help.edit.delete')}</span></li>
                            <li class="flex items-center gap-2"><span class="px-2 py-0.5 bg-pink-500/15 rounded text-xs font-bold text-pink-300">Edit</span><span>${t('help.edit.deleteHidden')}</span></li>
                            <li class="flex items-center gap-2"><kbd class="px-2 py-0.5 bg-white/10 rounded text-xs font-mono">Ctrl+Z</kbd><span>${t('help.edit.undo')}</span></li>
                            <li class="flex items-center gap-2"><kbd class="px-2 py-0.5 bg-white/10 rounded text-xs font-mono">Ctrl+Y</kbd><span>${t('help.edit.redo')}</span></li>
                        </ul>
                    </div>
                </div>
            </div>
        `;
    }

    // ========== Page 1: Smart Align & Cylinder ==========
    private renderPage1(): string {
        return `
            <div class="help-page hidden" data-page="1">
                <div class="space-y-4 text-sm">
                    <div>
                        <h3 class="text-xs uppercase font-bold text-cyan-400 mb-2 tracking-wider">${t('help.smart.title')}</h3>
                        <ul class="space-y-1.5 text-gray-200">
                            <li class="flex items-start gap-2"><span class="w-2 h-2 rounded-full bg-cyan-400 mt-1.5 shrink-0"></span><span>${t('help.smart.autoAlign')}</span></li>
                            <li class="flex items-start gap-2"><span class="w-2 h-2 rounded-full bg-cyan-400 mt-1.5 shrink-0"></span><span>${t('help.smart.showCylinder')}</span></li>
                            <li class="flex items-start gap-2"><span class="w-2 h-2 rounded-full bg-cyan-400 mt-1.5 shrink-0"></span><span>${t('help.smart.adjust')}</span></li>
                            <li class="flex items-start gap-2"><span class="w-2 h-2 rounded-full bg-cyan-400 mt-1.5 shrink-0"></span><span>${t('help.smart.selectCylinder')}</span></li>
                            <li class="flex items-start gap-2"><span class="w-2 h-2 rounded-full bg-cyan-400 mt-1.5 shrink-0"></span><span>${t('help.smart.scrub')}</span></li>
                        </ul>
                    </div>
                    <div class="p-3 bg-cyan-500/10 rounded-lg border border-cyan-500/20">
                        <h3 class="text-xs uppercase font-bold text-cyan-400 mb-1 tracking-wider">${t('help.workflow.title')}</h3>
                        <p class="text-gray-300 text-xs leading-relaxed">
                            ${t('help.workflow.body')}
                        </p>
                    </div>
                </div>
            </div>
        `;
    }

    // ========== Page 2: PLY4 Sequence Mode ==========
    private renderPage2(): string {
        return `
            <div class="help-page hidden" data-page="2">
                <div class="space-y-4 text-sm">
                    <div>
                        <h3 class="text-xs uppercase font-bold text-amber-400 mb-2 tracking-wider">${t('help.sequence.title')}</h3>
                        <ul class="space-y-1.5 text-gray-200">
                            <li class="flex items-start gap-2"><span class="w-2 h-2 rounded-full bg-emerald-400 mt-1.5 shrink-0"></span><span>${t('help.sequence.full')}</span></li>
                            <li class="flex items-start gap-2"><span class="w-2 h-2 rounded-full bg-cyan-400 mt-1.5 shrink-0"></span><span>${t('help.sequence.lazy')}</span></li>
                            <li class="flex items-start gap-2"><span class="w-2 h-2 rounded-full bg-amber-400 mt-1.5 shrink-0"></span><span>${t('help.sequence.keeps')}</span></li>
                            <li class="flex items-start gap-2"><span class="w-2 h-2 rounded-full bg-amber-400 mt-1.5 shrink-0"></span><span>${t('help.sequence.pause')}</span></li>
                        </ul>
                    </div>
                    <div class="p-3 bg-amber-500/10 rounded-lg border border-amber-500/20">
                        <h3 class="text-xs uppercase font-bold text-amber-400 mb-1 tracking-wider">${t('help.sequence.multiTitle')}</h3>
                        <p class="text-gray-300 text-xs leading-relaxed">
                            ${t('help.sequence.multi')}
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
                        <h3 class="text-xs uppercase font-bold text-pink-400 mb-2 tracking-wider">${t('help.playback.title')}</h3>
                        <ul class="space-y-1.5 text-gray-200">
                            <li class="flex items-start gap-2"><span class="w-2 h-2 rounded-full bg-pink-400 mt-1.5 shrink-0"></span><span>${t('help.playback.segment')}</span></li>
                            <li class="flex items-start gap-2"><span class="w-2 h-2 rounded-full bg-pink-400 mt-1.5 shrink-0"></span><span>${t('help.playback.timeline')}</span></li>
                            <li class="flex items-start gap-2"><span class="w-2 h-2 rounded-full bg-pink-400 mt-1.5 shrink-0"></span><span>${t('help.playback.hover')}</span></li>
                            <li class="flex items-start gap-2"><span class="w-2 h-2 rounded-full bg-pink-400 mt-1.5 shrink-0"></span><span>${t('help.playback.single')}</span></li>
                        </ul>
                    </div>
                    <div class="p-3 bg-pink-500/10 rounded-lg border border-pink-500/20">
                        <h3 class="text-xs uppercase font-bold text-pink-400 mb-1 tracking-wider">${t('help.timeline.title')}</h3>
                        <p class="text-gray-300 text-xs leading-relaxed">
                            ${t('help.timeline.body')}
                        </p>
                    </div>
                </div>
            </div>
        `;
    }

    // ========== Page 4: Tips ==========
    private renderPage4(): string {
        return `
            <div class="help-page hidden" data-page="4">
                <div class="space-y-4 text-sm">
                    <div class="p-3 bg-yellow-500/10 rounded-lg border border-yellow-500/20">
                        <h3 class="text-xs uppercase font-bold text-yellow-400 mb-1 tracking-wider">${t('help.tips.timeAwareTitle')}</h3>
                        <p class="text-gray-300 text-xs leading-relaxed">
                            ${t('help.tips.timeAware')}
                        </p>
                    </div>
                    <div class="p-3 bg-pink-500/10 rounded-lg border border-pink-500/20">
                        <h3 class="text-xs uppercase font-bold text-pink-400 mb-1 tracking-wider">${t('help.tips.renderAllTitle')}</h3>
                        <p class="text-gray-300 text-xs leading-relaxed">
                            ${t('help.tips.renderAll')}
                        </p>
                    </div>
                    <div class="p-3 bg-yellow-500/10 rounded-lg border border-yellow-500/20">
                        <h3 class="text-xs uppercase font-bold text-yellow-400 mb-1 tracking-wider">${t('help.tips.allTimeTitle')}</h3>
                        <p class="text-gray-300 text-xs leading-relaxed">
                            ${t('help.tips.allTime')}
                        </p>
                    </div>
                    <div class="p-3 bg-yellow-500/10 rounded-lg border border-yellow-500/20">
                        <h3 class="text-xs uppercase font-bold text-yellow-400 mb-1 tracking-wider">${t('help.tips.basicTitle')}</h3>
                        <p class="text-gray-300 text-xs leading-relaxed">
                            ${t('help.tips.basic')}
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
            nextBtn.textContent = disabled ? t('help.done') : t('help.next');
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
