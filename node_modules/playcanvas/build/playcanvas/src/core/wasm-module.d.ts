/**
 * Callback used by {@link Module#setConfig}.
 */
export type ModuleErrorCallback = (error: string) => any;
/**
 * Callback used by {@link Module#getInstance}.
 */
export type ModuleInstanceCallback = (moduleInstance: any) => any;
/**
 * Callback used by {@link Module#setConfig}.
 *
 * @callback ModuleErrorCallback
 * @param {string} error - If the instance fails to load this will contain a description of the error.
 */
/**
 * Callback used by {@link Module#getInstance}.
 *
 * @callback ModuleInstanceCallback
 * @param {any} moduleInstance - The module instance.
 */
/**
 * A pure static utility class which supports immediate and lazy loading of wasm modules.
 */
export class WasmModule {
    /**
     * Set a wasm module's configuration.
     *
     * @param {string} moduleName - Name of the module.
     * @param {object} [config] - The configuration object.
     * @param {string} [config.glueUrl] - URL of glue script.
     * @param {string} [config.wasmUrl] - URL of the wasm script.
     * @param {string} [config.fallbackUrl] - URL of the fallback script to use when wasm modules
     * aren't supported.
     * @param {number} [config.numWorkers] - For modules running on worker threads, the number of
     * threads to use. Default value is based on module implementation.
     * @param {ModuleErrorCallback} [config.errorHandler] - Function to be called if the module fails
     * to download.
     */
    static setConfig(moduleName: string, config?: {
        glueUrl?: string;
        wasmUrl?: string;
        fallbackUrl?: string;
        numWorkers?: number;
        errorHandler?: ModuleErrorCallback;
    }): void;
    /**
     * Get a wasm module's configuration.
     *
     * @param {string} moduleName - Name of the module.
     * @returns {object | undefined} The previously set configuration.
     */
    static getConfig(moduleName: string): object | undefined;
    /**
     * Get a wasm module instance. The instance will be created if necessary and returned
     * in the second parameter to callback.
     *
     * @param {string} moduleName - Name of the module.
     * @param {ModuleInstanceCallback} callback - The function called when the instance is
     * available.
     */
    static getInstance(moduleName: string, callback: ModuleInstanceCallback): void;
}
