/**
 * Callback function that the {@link AnimEvaluator} uses to set final animation values. These
 * callbacks are stored in {@link AnimTarget} instances which are constructed by an
 * {@link AnimBinder}.
 */
export type AnimSetter = (value: number[]) => any;
/**
 * Callback function that the {@link AnimEvaluator} uses to set final animation values. These
 * callbacks are stored in {@link AnimTarget} instances which are constructed by an
 * {@link AnimBinder}.
 *
 * @callback AnimSetter
 * @param {number[]} value - Updated animation value.
 * @ignore
 */
/**
 * Stores the information required by {@link AnimEvaluator} for updating a target value.
 *
 * @ignore
 */
export class AnimTarget {
    /**
     * Create a new AnimTarget instance.
     *
     * @param {AnimSetter} func - This function will be called when a new animation value is output
     * by the {@link AnimEvaluator}.
     * @param {'vector'|'quaternion'} type - The type of animation data this target expects.
     * @param {number} components - The number of components on this target (this should ideally
     * match the number of components found on all attached animation curves).
     * @param {string} targetPath - The path to the target value.
     */
    constructor(func: AnimSetter, type: "vector" | "quaternion", components: number, targetPath: string);
    _set: any;
    _get: any;
    _type: "quaternion" | "vector";
    _components: number;
    _targetPath: string;
    _isTransform: boolean;
    get set(): any;
    get get(): any;
    get type(): "quaternion" | "vector";
    get components(): number;
    get targetPath(): string;
    get isTransform(): boolean;
}
