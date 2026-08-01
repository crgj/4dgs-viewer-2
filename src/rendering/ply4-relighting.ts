import * as pc from 'playcanvas';

export type Ply4RelightingMode = 'directional' | 'point';

export interface Ply4RelightingState {
    enabled: boolean;
    mode: Ply4RelightingMode;
    position: [number, number, number];
    direction: [number, number, number];
    color: [number, number, number];
    diffuse: number;
    ambient: number;
    colorInfluence: number;
    normalInfluence: number;
    twoSided: boolean;
}

const DEFAULT_STATE: Ply4RelightingState = {
    enabled: false,
    mode: 'directional',
    position: [2, 3, 2],
    direction: [0.45, 0.35, 0.82],
    color: [1, 0.95, 0.88],
    diffuse: 0.75,
    ambient: 0.55,
    colorInfluence: 0.65,
    normalInfluence: 0.35,
    twoSided: true
};

const cloneState = (state: Ply4RelightingState): Ply4RelightingState => ({
    ...state,
    position: [...state.position],
    direction: [...state.direction],
    color: [...state.color]
});

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const wrapDegrees = (value: number) => ((value + 180) % 360 + 360) % 360 - 180;

const normalizeVector = (
    value: [number, number, number],
    fallback: [number, number, number] = [0, 0, 1]
): [number, number, number] => {
    const length = Math.hypot(value[0], value[1], value[2]);
    return length > 1e-8
        ? [value[0] / length, value[1] / length, value[2] / length]
        : [...fallback];
};

const directionToAngles = (direction: [number, number, number]) => {
    const [x, y, z] = normalizeVector(direction);
    return {
        yaw: Math.atan2(x, z) * 180 / Math.PI,
        pitch: Math.asin(clamp(y, -1, 1)) * 180 / Math.PI
    };
};

const anglesToDirection = (yaw: number, pitch: number): [number, number, number] => {
    const yawRadians = yaw * Math.PI / 180;
    const pitchRadians = pitch * Math.PI / 180;
    const horizontal = Math.cos(pitchRadians);
    return [
        horizontal * Math.sin(yawRadians),
        Math.sin(pitchRadians),
        horizontal * Math.cos(yawRadians)
    ];
};

const parseHexColor = (value: string): [number, number, number] => {
    const normalized = value.replace('#', '').padEnd(6, 'f').slice(0, 6);
    return [0, 2, 4].map((offset) => parseInt(normalized.slice(offset, offset + 2), 16) / 255) as [number, number, number];
};

const toHexColor = (color: [number, number, number]) => `#${color
    .map((value) => Math.round(clamp(value, 0, 1) * 255).toString(16).padStart(2, '0'))
    .join('')}`;

const rotateAxisByQuaternion = (
    axis: [number, number, number],
    x: number,
    y: number,
    z: number,
    w: number
): [number, number, number] => {
    const length = Math.hypot(x, y, z, w);
    if (length < 1e-8) return axis;
    x /= length;
    y /= length;
    z /= length;
    w /= length;
    const tx = 2 * (y * axis[2] - z * axis[1]);
    const ty = 2 * (z * axis[0] - x * axis[2]);
    const tz = 2 * (x * axis[1] - y * axis[0]);
    return normalizeVector([
        axis[0] + w * tx + (y * tz - z * ty),
        axis[1] + w * ty + (z * tx - x * tz),
        axis[2] + w * tz + (x * ty - y * tx)
    ]);
};

// #WDD-gpt 2026-07-31 - 对齐 Unity CSCalcViewData：重光照只使用 SH0/DC，并以 Ambient + Lambert Direct 乘回基底色
export const ply4RelightingVS = `
    #ifdef USE_PLY4_RELIGHTING
        uniform sampler2D uRelightNormalTexture;
        uniform float uRelightEnabled;
        uniform float uRelightMode;
        uniform vec3 uRelightPosition;
        uniform vec3 uRelightDirection;
        uniform vec3 uRelightColor;
        uniform float uRelightDiffuse;
        uniform float uRelightAmbient;
        uniform float uRelightColorInfluence;
        uniform float uRelightNormalInfluence;
        uniform float uRelightTwoSided;

        vec3 ply4SafeNormalize(vec3 value, vec3 fallbackValue) {
            float lenSq = dot(value, value);
            return lenSq > 1e-10 ? value * inversesqrt(lenSq) : fallbackValue;
        }

        vec3 samplePly4RelightNormal(ivec2 uv) {
            vec3 encoded = texelFetch(uRelightNormalTexture, uv, 0).rgb;
            return ply4SafeNormalize(encoded * 2.0 - 1.0, vec3(0.0, 0.0, 1.0));
        }

        vec3 applyPly4Relighting(
            vec3 dcColor,
            vec3 worldPosition,
            vec3 objectNormal,
            vec3 cameraPosition
        ) {
            if (uRelightEnabled < 0.5) return dcColor;

            vec3 normal = ply4SafeNormalize(mat3(matrix_model) * objectNormal, vec3(0.0, 0.0, 1.0));
            if (uRelightTwoSided > 0.5) {
                vec3 viewDirection = ply4SafeNormalize(cameraPosition - worldPosition, normal);
                if (dot(normal, viewDirection) < 0.0) normal = -normal;
            }

            vec3 lightDirection = uRelightMode > 0.5
                ? ply4SafeNormalize(uRelightPosition - worldPosition, normal)
                : ply4SafeNormalize(uRelightDirection, normal);
            float lambert = max(dot(normal, lightDirection), 0.0);
            float normalTerm = mix(1.0, lambert, clamp(uRelightNormalInfluence, 0.0, 1.0));
            vec3 influencedColor = mix(vec3(1.0), max(uRelightColor, vec3(0.0)), clamp(uRelightColorInfluence, 0.0, 1.0));
            vec3 direct = max(uRelightDiffuse, 0.0) * normalTerm * influencedColor;
            vec3 lighting = vec3(max(uRelightAmbient, 0.0)) + direct;
            return dcColor * max(lighting, vec3(0.0));
        }
    #endif
`;

export class Ply4RelightingController {
    private state = cloneState(DEFAULT_STATE);
    private readonly normalTextures = new Set<pc.Texture>();
    private directionCanvas: HTMLCanvasElement | null = null;
    private dragState: { pointerId: number } | null = null;
    private directionHemisphere: 1 | -1 = 1;

    constructor(private readonly app: pc.Application) {
        this.bindUI();
        this.syncUI();
    }

    getState(): Ply4RelightingState {
        return cloneState(this.state);
    }

    // #WDD-gpt 2026-07-31 - 对齐 Unity 法线语义：静态 splat 取最小 scale 轴并由基础四元数旋转，避免 PCA 分区造成亮暗斑驳
    createNormalTexture(splatData: any, width: number, height: number): pc.Texture {
        const texture = new pc.Texture(this.app.graphicsDevice, {
            width,
            height,
            format: pc.PIXELFORMAT_RGBA8,
            mipmaps: false,
            minFilter: pc.FILTER_NEAREST,
            magFilter: pc.FILTER_NEAREST,
            addressU: pc.ADDRESS_CLAMP_TO_EDGE,
            addressV: pc.ADDRESS_CLAMP_TO_EDGE,
            name: 'ply4MinimumScaleNormalTexture'
        });
        const locked = texture.lock();
        const pixels = new Uint8Array(locked.buffer, locked.byteOffset, locked.byteLength);
        const scale0 = splatData.getProp('scale_0') as Float32Array | null;
        const scale1 = splatData.getProp('scale_1') as Float32Array | null;
        const scale2 = splatData.getProp('scale_2') as Float32Array | null;
        const rot0 = splatData.getProp('rot_0') as Float32Array | null;
        const rot1 = splatData.getProp('rot_1') as Float32Array | null;
        const rot2 = splatData.getProp('rot_2') as Float32Array | null;
        const rot3 = splatData.getProp('rot_3') as Float32Array | null;
        const count = Math.min(splatData.numSplats || 0, width * height);

        for (let index = 0; index < count; index++) {
            const scales = [scale0?.[index] ?? 0, scale1?.[index] ?? 0, scale2?.[index] ?? 0];
            let axisIndex = 0;
            if (scales[1] < scales[axisIndex]) axisIndex = 1;
            if (scales[2] < scales[axisIndex]) axisIndex = 2;
            const axis: [number, number, number] = axisIndex === 0
                ? [1, 0, 0]
                : (axisIndex === 1 ? [0, 1, 0] : [0, 0, 1]);
            const normal = rot0 && rot1 && rot2 && rot3
                ? rotateAxisByQuaternion(axis, rot1[index], rot2[index], rot3[index], rot0[index])
                : axis;
            const offset = index * 4;
            pixels[offset] = Math.round((normal[0] * 0.5 + 0.5) * 255);
            pixels[offset + 1] = Math.round((normal[1] * 0.5 + 0.5) * 255);
            pixels[offset + 2] = Math.round((normal[2] * 0.5 + 0.5) * 255);
            pixels[offset + 3] = 255;
        }
        texture.unlock();
        this.normalTextures.add(texture);
        return texture;
    }

    disposeNormalTexture(texture: pc.Texture | null | undefined): void {
        if (!texture || !this.normalTextures.has(texture)) return;
        this.normalTextures.delete(texture);
        texture.destroy();
    }

    disposeAllNormalTextures(): void {
        for (const texture of this.normalTextures) texture.destroy();
        this.normalTextures.clear();
    }

    bindMaterial(material: any, normalTexture: pc.Texture): void {
        material.setParameter('uRelightNormalTexture', normalTexture);
        this.applyStateToMaterial(material);
    }

    applySettings(): void {
        const gsplats = this.app.root.findComponents('gsplat') as any[];
        for (const gsplat of gsplats) {
            if (gsplat?.instance?.material) this.applyStateToMaterial(gsplat.instance.material);
        }
    }

    private applyStateToMaterial(material: any): void {
        material.setParameter('uRelightEnabled', this.state.enabled ? 1 : 0);
        material.setParameter('uRelightMode', this.state.mode === 'point' ? 1 : 0);
        material.setParameter('uRelightPosition', this.state.position);
        material.setParameter('uRelightDirection', normalizeVector(this.state.direction));
        material.setParameter('uRelightColor', this.state.color);
        material.setParameter('uRelightDiffuse', this.state.diffuse);
        material.setParameter('uRelightAmbient', this.state.ambient);
        material.setParameter('uRelightColorInfluence', this.state.colorInfluence);
        material.setParameter('uRelightNormalInfluence', this.state.normalInfluence);
        material.setParameter('uRelightTwoSided', this.state.twoSided ? 1 : 0);
    }

    private bindUI(): void {
        document.getElementById('relight-enabled')?.addEventListener('click', () => {
            this.state.enabled = !this.state.enabled;
            this.syncUI();
            this.applySettings();
        });
        document.getElementById('relight-reset')?.addEventListener('click', () => {
            this.state = cloneState(DEFAULT_STATE);
            this.syncUI();
            this.applySettings();
        });
        document.getElementById('relight-two-sided')?.addEventListener('click', () => {
            this.state.twoSided = !this.state.twoSided;
            this.syncTwoSidedUI();
            this.applySettings();
        });
        document.getElementById('relight-hemisphere-positive')?.addEventListener('click', () => this.setDirectionHemisphere(1));
        document.getElementById('relight-hemisphere-negative')?.addEventListener('click', () => this.setDirectionHemisphere(-1));

        const mode = document.getElementById('relight-mode') as HTMLSelectElement | null;
        mode?.addEventListener('change', () => {
            this.state.mode = mode.value === 'point' ? 'point' : 'directional';
            this.syncModeUI();
            this.applySettings();
        });

        this.bindVectorInputs('relight-position', this.state.position, (value) => { this.state.position = value; });
        this.bindVectorInputs('relight-direction', this.state.direction, (value) => {
            this.state.direction = normalizeVector(value, this.state.direction);
            this.syncDirectionUI();
        });
        this.bindAngleInputs();
        this.bindDirectionSphere();
        this.bindRange('relight-diffuse', 0, 2, (value) => { this.state.diffuse = value; });
        this.bindRange('relight-ambient', 0, 2, (value) => { this.state.ambient = value; });
        this.bindRange('relight-color-influence', 0, 1, (value) => { this.state.colorInfluence = value; });
        this.bindRange('relight-normal-influence', 0, 1, (value) => { this.state.normalInfluence = value; });

        const color = document.getElementById('relight-color') as HTMLInputElement | null;
        color?.addEventListener('input', () => {
            this.state.color = parseHexColor(color.value);
            this.applySettings();
        });
    }

    private bindRange(id: string, min: number, max: number, assign: (value: number) => void): void {
        const input = document.getElementById(id) as HTMLInputElement | null;
        input?.addEventListener('input', () => {
            assign(clamp(Number(input.value) || 0, min, max));
            this.syncRangeValue(id);
            this.applySettings();
        });
    }

    private bindVectorInputs(
        prefix: string,
        initialValue: [number, number, number],
        assign: (value: [number, number, number]) => void
    ): void {
        const inputs = ['x', 'y', 'z'].map((axis) => document.getElementById(`${prefix}-${axis}`) as HTMLInputElement | null);
        inputs.forEach((input) => input?.addEventListener('input', () => {
            const values = inputs.map((item, index) => {
                const parsed = Number(item?.value);
                return Number.isFinite(parsed) ? parsed : initialValue[index];
            }) as [number, number, number];
            assign(values);
            this.applySettings();
        }));
    }

    private bindAngleInputs(): void {
        const yawInput = document.getElementById('relight-yaw') as HTMLInputElement | null;
        const pitchInput = document.getElementById('relight-pitch') as HTMLInputElement | null;
        const update = () => {
            const current = directionToAngles(this.state.direction);
            const yaw = wrapDegrees(Number.isFinite(Number(yawInput?.value)) ? Number(yawInput?.value) : current.yaw);
            const pitch = clamp(Number.isFinite(Number(pitchInput?.value)) ? Number(pitchInput?.value) : current.pitch, -90, 90);
            this.state.direction = anglesToDirection(yaw, pitch);
            this.syncDirectionUI();
            this.applySettings();
        };
        yawInput?.addEventListener('input', update);
        pitchInput?.addEventListener('input', update);
    }

    // #WDD-gpt 2026-07-31 - 方向球将指针直接映射到所选 Z 半球，配合正负半球按钮覆盖完整单位球
    private bindDirectionSphere(): void {
        this.directionCanvas = document.getElementById('relight-direction-sphere') as HTMLCanvasElement | null;
        this.directionCanvas?.addEventListener('pointerdown', (event) => {
            this.dragState = { pointerId: event.pointerId };
            this.directionCanvas?.setPointerCapture(event.pointerId);
            this.directionCanvas?.classList.add('dragging');
            this.updateDirectionFromSpherePointer(event);
        });
        this.directionCanvas?.addEventListener('pointermove', (event) => {
            if (!this.dragState || this.dragState.pointerId !== event.pointerId) return;
            this.updateDirectionFromSpherePointer(event);
        });
        const finishDrag = (event: PointerEvent) => {
            if (!this.dragState || this.dragState.pointerId !== event.pointerId) return;
            this.directionCanvas?.releasePointerCapture(event.pointerId);
            this.directionCanvas?.classList.remove('dragging');
            this.dragState = null;
        };
        this.directionCanvas?.addEventListener('pointerup', finishDrag);
        this.directionCanvas?.addEventListener('pointercancel', finishDrag);
        window.addEventListener('resize', () => this.drawDirectionSphere());
    }

    private updateDirectionFromSpherePointer(event: PointerEvent): void {
        const canvas = this.directionCanvas;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const radius = Math.min(rect.width, rect.height) * 0.42;
        if (radius <= 0) return;
        let x = (event.clientX - (rect.left + rect.width * 0.5)) / radius;
        let y = -((event.clientY - (rect.top + rect.height * 0.5)) / radius);
        const radialLength = Math.hypot(x, y);
        if (radialLength > 1) {
            x /= radialLength;
            y /= radialLength;
        }
        const z = this.directionHemisphere * Math.sqrt(Math.max(0, 1 - x * x - y * y));
        this.state.direction = normalizeVector([x, y, z], this.state.direction);
        this.syncDirectionUI();
        this.applySettings();
    }

    private setDirectionHemisphere(hemisphere: 1 | -1): void {
        this.directionHemisphere = hemisphere;
        const [x, y, z] = normalizeVector(this.state.direction);
        this.state.direction = normalizeVector([x, y, hemisphere * Math.max(Math.abs(z), 0.001)]);
        this.syncDirectionUI();
        this.applySettings();
    }

    private syncUI(): void {
        const enabled = document.getElementById('relight-enabled');
        enabled?.classList.toggle('active', this.state.enabled);
        enabled?.setAttribute('aria-pressed', this.state.enabled ? 'true' : 'false');
        const mode = document.getElementById('relight-mode') as HTMLSelectElement | null;
        if (mode) mode.value = this.state.mode;
        this.syncVectorUI('relight-position', this.state.position);
        this.syncDirectionUI();
        const color = document.getElementById('relight-color') as HTMLInputElement | null;
        if (color) color.value = toHexColor(this.state.color);
        this.syncRangeUI('relight-diffuse', this.state.diffuse);
        this.syncRangeUI('relight-ambient', this.state.ambient);
        this.syncRangeUI('relight-color-influence', this.state.colorInfluence);
        this.syncRangeUI('relight-normal-influence', this.state.normalInfluence);
        this.syncTwoSidedUI();
        this.syncModeUI();
    }

    private syncRangeUI(id: string, value: number): void {
        const input = document.getElementById(id) as HTMLInputElement | null;
        if (input) input.value = value.toString();
        this.syncRangeValue(id);
    }

    private syncRangeValue(id: string): void {
        const input = document.getElementById(id) as HTMLInputElement | null;
        const output = document.getElementById(`${id}-value`);
        if (input && output) output.textContent = Number(input.value).toFixed(2);
    }

    private syncTwoSidedUI(): void {
        const button = document.getElementById('relight-two-sided');
        button?.classList.toggle('active', this.state.twoSided);
        button?.setAttribute('aria-pressed', this.state.twoSided ? 'true' : 'false');
    }

    private syncHemisphereUI(): void {
        const positive = document.getElementById('relight-hemisphere-positive') as HTMLButtonElement | null;
        const negative = document.getElementById('relight-hemisphere-negative') as HTMLButtonElement | null;
        const isPositive = this.directionHemisphere > 0;
        positive?.classList.toggle('active', isPositive);
        positive?.setAttribute('aria-pressed', isPositive ? 'true' : 'false');
        negative?.classList.toggle('active', !isPositive);
        negative?.setAttribute('aria-pressed', isPositive ? 'false' : 'true');
    }

    private syncVectorUI(prefix: string, value: [number, number, number], digits?: number): void {
        ['x', 'y', 'z'].forEach((axis, index) => {
            const input = document.getElementById(`${prefix}-${axis}`) as HTMLInputElement | null;
            if (input) input.value = digits === undefined ? value[index].toString() : value[index].toFixed(digits);
        });
    }

    private syncDirectionUI(): void {
        const normalized = normalizeVector(this.state.direction);
        this.state.direction = normalized;
        if (Math.abs(normalized[2]) > 1e-5) this.directionHemisphere = normalized[2] >= 0 ? 1 : -1;
        this.syncVectorUI('relight-direction', normalized, 3);
        const angles = directionToAngles(normalized);
        const yaw = document.getElementById('relight-yaw') as HTMLInputElement | null;
        const pitch = document.getElementById('relight-pitch') as HTMLInputElement | null;
        if (yaw) yaw.value = angles.yaw.toFixed(1);
        if (pitch) pitch.value = angles.pitch.toFixed(1);
        this.syncHemisphereUI();
        this.drawDirectionSphere();
    }

    private drawDirectionSphere(): void {
        const canvas = this.directionCanvas;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        const pixelWidth = Math.round(rect.width * ratio);
        const pixelHeight = Math.round(rect.height * ratio);
        if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
            canvas.width = pixelWidth;
            canvas.height = pixelHeight;
        }
        const context = canvas.getContext('2d');
        if (!context) return;
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        context.clearRect(0, 0, rect.width, rect.height);
        const radius = Math.min(rect.width, rect.height) * 0.42;
        const cx = rect.width * 0.5;
        const cy = rect.height * 0.5;
        const sphereGradient = context.createRadialGradient(cx - radius * 0.35, cy - radius * 0.4, radius * 0.05, cx, cy, radius);
        sphereGradient.addColorStop(0, 'rgba(82, 225, 190, 0.28)');
        sphereGradient.addColorStop(0.65, 'rgba(12, 45, 58, 0.82)');
        sphereGradient.addColorStop(1, 'rgba(3, 12, 20, 0.96)');
        context.beginPath();
        context.arc(cx, cy, radius, 0, Math.PI * 2);
        context.fillStyle = sphereGradient;
        context.fill();
        context.strokeStyle = 'rgba(52, 211, 153, 0.7)';
        context.lineWidth = 1;
        context.stroke();

        context.strokeStyle = 'rgba(148, 163, 184, 0.24)';
        for (const scale of [0.34, 0.67]) {
            context.beginPath();
            context.ellipse(cx, cy, radius * scale, radius, 0, 0, Math.PI * 2);
            context.stroke();
            context.beginPath();
            context.ellipse(cx, cy, radius, radius * scale, 0, 0, Math.PI * 2);
            context.stroke();
        }
        context.beginPath();
        context.moveTo(cx - radius, cy);
        context.lineTo(cx + radius, cy);
        context.moveTo(cx, cy - radius);
        context.lineTo(cx, cy + radius);
        context.stroke();

        const [dx, dy, dz] = normalizeVector(this.state.direction);
        const markerX = cx + dx * radius * 0.88;
        const markerY = cy - dy * radius * 0.88;
        context.beginPath();
        context.moveTo(cx, cy);
        context.lineTo(markerX, markerY);
        context.strokeStyle = dz >= 0 ? 'rgba(255, 244, 218, 0.78)' : 'rgba(148, 163, 184, 0.58)';
        context.lineWidth = 1.5;
        context.setLineDash(dz >= 0 ? [] : [4, 3]);
        context.stroke();
        context.setLineDash([]);
        context.beginPath();
        context.arc(markerX, markerY, dz >= 0 ? 5 : 3.5, 0, Math.PI * 2);
        context.fillStyle = dz >= 0 ? '#fff4da' : '#94a3b8';
        context.fill();
        context.strokeStyle = dz >= 0 ? '#10b981' : 'rgba(255,255,255,0.45)';
        context.lineWidth = 2;
        context.stroke();

        context.fillStyle = dz >= 0 ? 'rgba(52, 211, 153, 0.82)' : 'rgba(148, 163, 184, 0.82)';
        context.font = '700 8px ui-monospace, monospace';
        context.textAlign = 'right';
        context.fillText(dz >= 0 ? '+Z' : '−Z', cx + radius, cy - radius + 10);
    }

    private syncModeUI(): void {
        const isPoint = this.state.mode === 'point';
        document.getElementById('relight-position-row')?.classList.toggle('relight-control-inactive', !isPoint);
        document.getElementById('relight-direction-row')?.classList.toggle('relight-control-inactive', isPoint);
        document.getElementById('relight-direction-control')?.classList.toggle('relight-control-inactive', isPoint);
        for (const axis of ['x', 'y', 'z']) {
            const position = document.getElementById(`relight-position-${axis}`) as HTMLInputElement | null;
            const direction = document.getElementById(`relight-direction-${axis}`) as HTMLInputElement | null;
            if (position) position.disabled = !isPoint;
            if (direction) direction.disabled = isPoint;
        }
        for (const id of ['relight-yaw', 'relight-pitch']) {
            const input = document.getElementById(id) as HTMLInputElement | null;
            if (input) input.disabled = isPoint;
        }
        for (const id of ['relight-hemisphere-positive', 'relight-hemisphere-negative']) {
            const button = document.getElementById(id) as HTMLButtonElement | null;
            if (button) button.disabled = isPoint;
        }
        if (this.directionCanvas) this.directionCanvas.style.pointerEvents = isPoint ? 'none' : 'auto';
    }
}
