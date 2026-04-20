// #WDD 2026-04-20: Extracted from selection-tool.ts for modularity
// Help modal logic for SelectionTool

export class SelectionToolHelp {
    private helpModal: HTMLElement | null = null;

    createHelpModal() {
        const modal = document.createElement('div');
        modal.id = 'help-modal';
        modal.className = 'fixed inset-0 z-50 hidden flex items-center justify-center bg-black/60 backdrop-blur-sm';
        modal.innerHTML = `
            <div class="glass-blue p-6 rounded-xl max-w-md w-full mx-4 max-h-[80vh] overflow-y-auto shadow-2xl border border-white/10">
                <div class="flex justify-between items-center mb-4 pb-3 border-b border-white/10">
                    <h2 class="text-lg font-bold text-white flex items-center gap-2">
                        <svg viewBox="0 0 24 24" class="w-6 h-6 fill-current text-yellow-400"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17h-2v-2h2v2zm2.07-7.75l-.9.92C13.45 12.9 13 13.5 13 15h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H8c0-2.21 1.79-4 4-4s4 1.79 4 4c0 .88-.36 1.68-.93 2.25z"/></svg>
                        使用帮助
                    </h2>
                    <button id="help-close" class="p-1 hover:bg-white/10 rounded-lg transition-colors">
                        <svg viewBox="0 0 24 24" class="w-6 h-6 fill-current text-gray-400 hover:text-white"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
                    </button>
                </div>
                
                <div class="space-y-4 text-sm">
                    <!-- 选择工具 -->
                    <div>
                        <h3 class="text-xs uppercase font-bold text-emerald-400 mb-2 tracking-wider">选择工具</h3>
                        <ul class="space-y-1.5 text-gray-200">
                            <li class="flex items-center gap-2">
                                <kbd class="px-2 py-0.5 bg-white/10 rounded text-xs font-mono">1</kbd>
                                <span>切换<strong>笔刷选择</strong>工具（再按关闭）</span>
                            </li>
                            <li class="flex items-center gap-2">
                                <kbd class="px-2 py-0.5 bg-white/10 rounded text-xs font-mono">2</kbd>
                                <span>切换<strong>矩形选择</strong>工具（再按关闭）</span>
                            </li>
                            <li class="flex items-center gap-2">
                                <kbd class="px-2 py-0.5 bg-white/10 rounded text-xs font-mono">3</kbd>
                                <span>切换<strong>全时段笔刷</strong>工具（选中所有帧可见点）</span>
                            </li>
                            <li class="flex items-center gap-2">
                                <kbd class="px-2 py-0.5 bg-white/10 rounded text-xs font-mono">4</kbd>
                                <span>切换<strong>全时段矩形</strong>工具（选中所有帧可见点）</span>
                            </li>
                            <li class="flex items-center gap-2">
                                <kbd class="px-2 py-0.5 bg-white/10 rounded text-xs font-mono">Alt</kbd>
                                <span>按住进入<strong>减选模式</strong>（从选区移除）</span>
                            </li>
                        </ul>
                    </div>

                    <!-- 选择模式 -->
                    <div>
                        <h3 class="text-xs uppercase font-bold text-blue-400 mb-2 tracking-wider">选择模式</h3>
                        <ul class="space-y-1.5 text-gray-200">
                            <li class="flex items-center gap-2">
                                <span class="w-2 h-2 rounded-full bg-blue-400"></span>
                                <span><strong>中心模式</strong> - 仅选择中心点在选区内的点</span>
                            </li>
                            <li class="flex items-center gap-2">
                                <span class="w-2 h-2 rounded-full bg-purple-400"></span>
                                <span><strong>椭圆模式</strong> - 考虑点的屏幕空间大小</span>
                            </li>
                        </ul>
                    </div>

                    <!-- 删除操作 -->
                    <div>
                        <h3 class="text-xs uppercase font-bold text-red-400 mb-2 tracking-wider">删除操作</h3>
                        <ul class="space-y-1.5 text-gray-200">
                            <li class="flex items-center gap-2">
                                <kbd class="px-2 py-0.5 bg-white/10 rounded text-xs font-mono">Delete</kbd>
                                <span>删除当前<strong>选中的点</strong></span>
                            </li>
                            <li class="flex items-center gap-2">
                                <kbd class="px-2 py-0.5 bg-white/10 rounded text-xs font-mono">Ctrl+Z</kbd>
                                <span><strong>撤销</strong>删除（最多30步）</span>
                            </li>
                            <li class="flex items-center gap-2">
                                <kbd class="px-2 py-0.5 bg-white/10 rounded text-xs font-mono">Ctrl+Y</kbd>
                                <span>或 <kbd class="px-1.5 py-0.5 bg-white/10 rounded text-xs font-mono">Ctrl+Shift+Z</kbd> <strong>重做</strong>删除</span>
                            </li>
                        </ul>
                    </div>

                    <!-- 时间感知选择 -->
                    <div class="p-3 bg-yellow-500/10 rounded-lg border border-yellow-500/20">
                        <h3 class="text-xs uppercase font-bold text-yellow-400 mb-1 tracking-wider">💡 提示</h3>
                        <p class="text-gray-300 text-xs leading-relaxed">
                            选择工具现在是<strong>时间感知</strong>的！只会选择当前时刻可见的点。
                            播放动画时，当前时刻会自动更新。
                        </p>
                        <p class="text-gray-300 text-xs leading-relaxed mt-1">
                            <strong>全时段选择</strong>（<kbd class="px-1 py-0.5 bg-white/5 rounded text-xs">3</kbd> / <kbd class="px-1 py-0.5 bg-white/5 rounded text-xs">4</kbd>）可选中所有时间帧内可见的点，适合清理跨帧噪点。
                        </p>
                    </div>
                </div>

                <div class="mt-4 pt-3 border-t border-white/10 text-center">
                    <p class="text-xs text-gray-500">按 <kbd class="px-1.5 py-0.5 bg-white/5 rounded text-xs">ESC</kbd> 或点击空白处关闭</p>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        this.helpModal = modal;

        // Close button
        modal.querySelector('#help-close')?.addEventListener('click', () => this.hideHelpModal());
        
        // Click outside to close
        modal.addEventListener('click', (e) => {
            if (e.target === modal) this.hideHelpModal();
        });
    }

    toggleHelpModal() {
        if (!this.helpModal) return;
        if (this.helpModal.classList.contains('hidden')) {
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
