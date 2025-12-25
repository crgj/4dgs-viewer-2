/**
 * Logs a frame number.
 *
 * @type {string}
 * @category Debug
 */
export const TRACEID_RENDER_FRAME: string;
/**
 * Logs a frame time.
 *
 * @type {string}
 * @category Debug
 */
export const TRACEID_RENDER_FRAME_TIME: string;
/**
 * Logs basic information about generated render passes.
 *
 * @type {string}
 * @category Debug
 */
export const TRACEID_RENDER_PASS: string;
/**
 * Logs additional detail for render passes.
 *
 * @type {string}
 * @category Debug
 */
export const TRACEID_RENDER_PASS_DETAIL: string;
/**
 * Logs render actions created by the layer composition. Only executes when the
 * layer composition changes.
 *
 * @type {string}
 * @category Debug
 */
export const TRACEID_RENDER_ACTION: string;
/**
 * Logs the allocation of render targets.
 *
 * @type {string}
 * @category Debug
 */
export const TRACEID_RENDER_TARGET_ALLOC: string;
/**
 * Logs the allocation of textures.
 *
 * @type {string}
 * @category Debug
 */
export const TRACEID_TEXTURE_ALLOC: string;
/**
 * Logs the creation of shaders.
 *
 * @type {string}
 * @category Debug
 */
export const TRACEID_SHADER_ALLOC: string;
/**
 * Logs the compilation time of shaders.
 *
 * @type {string}
 * @category Debug
 */
export const TRACEID_SHADER_COMPILE: string;
/**
 * Logs the vram use by the textures.
 *
 * @type {string}
 * @category Debug
 */
export const TRACEID_VRAM_TEXTURE: string;
/**
 * Logs the vram use by the vertex buffers.
 *
 * @type {string}
 * @category Debug
 */
export const TRACEID_VRAM_VB: string;
/**
 * Logs the vram use by the index buffers.
 *
 * @type {string}
 * @category Debug
 */
export const TRACEID_VRAM_IB: string;
/**
 * Logs the vram use by the storage buffers.
 *
 * @type {string}
 * @category Debug
 */
export const TRACEID_VRAM_SB: string;
/**
 * Logs the creation of bind groups.
 *
 * @type {string}
 * @category Debug
 */
export const TRACEID_BINDGROUP_ALLOC: string;
/**
 * Logs the creation of bind group formats.
 *
 * @type {string}
 * @category Debug
 */
export const TRACEID_BINDGROUPFORMAT_ALLOC: string;
/**
 * Logs the creation of render pipelines. WebBPU only.
 *
 * @type {string}
 * @category Debug
 */
export const TRACEID_RENDERPIPELINE_ALLOC: string;
/**
 * Logs the creation of compute pipelines. WebGPU only.
 *
 * @type {string}
 * @category Debug
 */
export const TRACEID_COMPUTEPIPELINE_ALLOC: string;
/**
 * Logs the creation of pipeline layouts. WebBPU only.
 *
 * @type {string}
 * @category Debug
 */
export const TRACEID_PIPELINELAYOUT_ALLOC: string;
/**
 * Logs the internal debug information for Elements.
 *
 * @type {string}
 * @category Debug
 */
export const TRACE_ID_ELEMENT: string;
/**
 * Logs the vram use by all textures in memory.
 *
 * @type {string}
 * @category Debug
 */
export const TRACEID_TEXTURES: string;
/**
 * Logs the render queue commands.
 *
 * @type {string}
 * @category Debug
 */
export const TRACEID_RENDER_QUEUE: string;
/**
 * Logs the GPU timings.
 *
 * @type {string}
 * @category Debug
 */
export const TRACEID_GPU_TIMINGS: string;
