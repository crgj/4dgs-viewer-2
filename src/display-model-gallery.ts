export interface DisplayGalleryItem {
    name: string;
    url: string;
    thumbnail: string;
}

interface DisplayGalleryGroup {
    id: 'sog' | 'sog4';
    label: string;
    items: DisplayGalleryItem[];
}

interface DisplayGalleryManifest {
    groups: DisplayGalleryGroup[];
}

// #WDD-gpt 2026-08-04 - 独立管理模型相册的清单、分组、键盘关闭与当前模型状态，避免展示运行时混入 DOM 细节
export class DisplayModelGallery {
    private readonly modal = document.getElementById('display-model-gallery');
    private readonly content = document.getElementById('display-gallery-content');
    private readonly openButton = document.getElementById('display-open-gallery') as HTMLButtonElement | null;
    private readonly closeButton = document.getElementById('display-close-gallery') as HTMLButtonElement | null;
    private activeUrl = '';
    private lastFocusedElement: HTMLElement | null = null;

    constructor(private readonly onSelect: (item: DisplayGalleryItem) => void) {
        this.openButton?.addEventListener('click', () => this.open());
        this.closeButton?.addEventListener('click', () => this.close());
        this.modal?.addEventListener('click', (event) => {
            if (event.target === this.modal) this.close();
        });
        window.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && !this.modal?.classList.contains('hidden')) this.close();
        });
    }

    async initialize() {
        if (!this.content) return;
        try {
            const response = await fetch('./model-gallery.json');
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const manifest = await response.json() as DisplayGalleryManifest;
            this.render(manifest.groups);
        } catch (error) {
            console.error('[DisplayGallery] Manifest load failed:', error);
            this.content.innerHTML = '<p class="gallery-empty">模型相册读取失败，请使用“本地文件”打开模型。</p>';
        }
    }

    setActiveUrl(url: string | null) {
        this.activeUrl = url ? this.normalizeUrl(url) : '';
        this.content?.querySelectorAll<HTMLButtonElement>('.gallery-card').forEach((card) => {
            const active = this.normalizeUrl(card.dataset.url || '') === this.activeUrl;
            card.classList.toggle('active', active);
            card.setAttribute('aria-current', active ? 'true' : 'false');
        });
    }

    open() {
        if (!this.modal) return;
        this.lastFocusedElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        this.modal.classList.remove('hidden');
        this.modal.setAttribute('aria-hidden', 'false');
        document.body.classList.add('gallery-open');
        window.requestAnimationFrame(() => this.closeButton?.focus());
    }

    close() {
        if (!this.modal || this.modal.classList.contains('hidden')) return;
        this.modal.classList.add('hidden');
        this.modal.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('gallery-open');
        this.lastFocusedElement?.focus();
    }

    private render(groups: DisplayGalleryGroup[]) {
        if (!this.content) return;
        this.content.replaceChildren();
        for (const group of groups) {
            const section = document.createElement('section');
            section.className = 'gallery-group';
            section.setAttribute('aria-labelledby', `gallery-group-${group.id}`);

            const heading = document.createElement('div');
            heading.className = 'gallery-group-heading';
            const title = document.createElement('h3');
            title.id = `gallery-group-${group.id}`;
            title.textContent = group.label;
            const count = document.createElement('span');
            count.textContent = `${group.items.length} 个模型`;
            heading.append(title, count);

            const grid = document.createElement('div');
            grid.className = 'gallery-grid';
            for (const item of group.items) grid.append(this.createCard(item, group.id));
            section.append(heading, grid);
            this.content.append(section);
        }
        this.setActiveUrl(this.activeUrl);
    }

    private createCard(item: DisplayGalleryItem, format: string) {
        const button = document.createElement('button');
        button.className = 'gallery-card';
        button.type = 'button';
        button.dataset.url = item.url;
        button.title = item.name;
        button.setAttribute('aria-label', `显示 ${item.name}`);

        const image = document.createElement('img');
        image.src = item.thumbnail;
        image.alt = '';
        image.loading = 'lazy';
        image.decoding = 'async';

        const meta = document.createElement('span');
        meta.className = 'gallery-card-meta';
        const name = document.createElement('strong');
        name.textContent = item.name;
        const badge = document.createElement('small');
        badge.textContent = format.toUpperCase();
        meta.append(name, badge);
        button.append(image, meta);
        button.addEventListener('click', () => {
            this.close();
            this.onSelect(item);
        });
        return button;
    }

    private normalizeUrl(url: string) {
        try {
            return new URL(url, window.location.href).pathname;
        } catch {
            return url;
        }
    }
}
