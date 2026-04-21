/**
 * SOG4 Encoder Wrapper
 * 提供统一的编码接口，仅保留标准与 raw 模式
 */

import { SOG4Encoder as SOG4EncoderStandard, SOG4EncodeProgressMeta } from './sog4-encoder';

export type { SOG4EncodeProgressMeta };

export type EncodeMode = 'auto' | 'standard' | 'raw';

export interface SOG4EncoderOptions {
    /** 编码模式 */
    mode?: EncodeMode;
    /** 进度回调 */
    progress?: (pct: number, msg: string, meta?: SOG4EncodeProgressMeta) => void;
}

/**
 * 智能 SOG4 编码器
 * 仅使用标准编码器
 */
export class SOG4Encoder {
    static async encode(
        data: any,
        overrides: any = {},
        options: SOG4EncoderOptions = {}
    ): Promise<Uint8Array> {
        const {
            mode = 'standard',  // 默认使用标准模式确保安全
            progress
        } = options;

        const count = data.count || data.plyData?.elements?.[0]?.count || 0;
        
        let useRaw = mode === 'raw';

        // 构建进度回调包装器
        const wrappedProgress = (pct: number, msg: string, meta?: SOG4EncodeProgressMeta) => {
            // 添加编码器类型标识
            const enhancedMeta = meta ? {
                ...meta,
                detail: `[${useRaw ? 'RAW' : 'STD'}] ${meta.detail || msg}`
            } : undefined;
            progress?.(pct, `[${useRaw ? '原始快导' : '标准'}] ${msg}`, enhancedMeta);
        };

        console.log(`[SOG4 Encoder] Mode: ${mode}, Points: ${count}, Using: ${useRaw ? 'Raw' : 'Standard'}`);
        return SOG4EncoderStandard.encode(data, {
            ...overrides,
            rawFloatPayload: useRaw || overrides.rawFloatPayload === true
        }, wrappedProgress);
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
