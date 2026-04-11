/**
 * SOG4 Encoder Wrapper
 * 提供统一的编码接口，自动选择极速版或标准版
 */

import { SOG4Encoder as SOG4EncoderStandard, SOG4EncodeProgressMeta } from './sog4-encoder';
import { SOG4EncoderFast, FastEncodeOptions } from './sog4-encoder-fast';

export type { SOG4EncodeProgressMeta, FastEncodeOptions };

export type EncodeMode = 'auto' | 'standard' | 'fast' | 'raw';

export interface SOG4EncoderOptions extends FastEncodeOptions {
    /** 编码模式 */
    mode?: EncodeMode;
    /** 自动切换到极速模式的数据大小阈值 (点数) */
    fastModeThreshold?: number;
}

/**
 * 智能 SOG4 编码器
 * 根据数据大小和选项自动选择最佳编码策略
 */
export class SOG4Encoder {
    static async encode(
        data: any,
        overrides: any = {},
        options: SOG4EncoderOptions = {}
    ): Promise<Uint8Array> {
        const {
            mode = 'standard',  // 默认使用标准模式确保安全
            progress,
            ...fastOptions
        } = options;

        const count = data.count || data.plyData?.elements?.[0]?.count || 0;
        
        // 决定使用哪个编码器
        let useFast = false;
        let useRaw = mode === 'raw';

        // 暂时完全禁用极速版，全部使用标准版（极速版有bug待修复）
        useFast = false;

        // 构建进度回调包装器
        const wrappedProgress = (pct: number, msg: string, meta?: SOG4EncodeProgressMeta) => {
            // 添加编码器类型标识
            const enhancedMeta = meta ? {
                ...meta,
                detail: `[${useFast ? 'FAST' : (useRaw ? 'RAW' : 'STD')}] ${meta.detail || msg}`
            } : undefined;
            progress?.(pct, `[${useFast ? '极速' : (useRaw ? '原始快导' : '标准')}] ${msg}`, enhancedMeta);
        };

        console.log(`[SOG4 Encoder] Mode: ${mode}, Points: ${count}, Using: ${useFast ? 'Fast' : (useRaw ? 'Raw' : 'Standard')}`);

        if (useFast) {
            return SOG4EncoderFast.encode(data, overrides, {
                ...fastOptions,
                forceRawFloat: useRaw || fastOptions.forceRawFloat,
                progress: wrappedProgress
            });
        } else {
            return SOG4EncoderStandard.encode(data, {
                ...overrides,
                rawFloatPayload: useRaw || overrides.rawFloatPayload === true
            }, wrappedProgress);
        }
    }

    /**
     * 快速导出 - 一键极速模式
     */
    static async encodeFast(
        data: any,
        overrides: any = {},
        progress?: (pct: number, msg: string, meta?: SOG4EncodeProgressMeta) => void
    ): Promise<Uint8Array> {
        return this.encode(data, overrides, {
            mode: 'fast',
            quality: 'fast',
            parallelTextureRender: true,
            progress
        });
    }

    /**
     * Raw Float 导出 - 最快但文件较大
     */
    static async encodeRaw(
        data: any,
        overrides: any = {},
        progress?: (pct: number, msg: string, meta?: SOG4EncodeProgressMeta) => void
    ): Promise<Uint8Array> {
        return this.encode(data, overrides, {
            mode: 'raw',
            progress
        });
    }
}

export default SOG4Encoder;
