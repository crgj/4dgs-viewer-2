/**
 * Used to set the anim state graph transition interruption source to no state.
 *
 * @type {string}
 * @category Animation
 */
export const ANIM_INTERRUPTION_NONE: string;
/**
 * Used to set the anim state graph transition interruption source as the previous state only.
 *
 * @type {string}
 * @category Animation
 */
export const ANIM_INTERRUPTION_PREV: string;
/**
 * Used to set the anim state graph transition interruption source as the next state only.
 *
 * @type {string}
 * @category Animation
 */
export const ANIM_INTERRUPTION_NEXT: string;
/**
 * Used to set the anim state graph transition interruption sources as the previous state followed
 * by the next state.
 *
 * @type {string}
 * @category Animation
 */
export const ANIM_INTERRUPTION_PREV_NEXT: string;
/**
 * Used to set the anim state graph transition interruption sources as the next state followed by
 * the previous state.
 *
 * @type {string}
 * @category Animation
 */
export const ANIM_INTERRUPTION_NEXT_PREV: string;
/**
 * Used to set an anim state graph transition condition predicate as '>'.
 *
 * @type {string}
 * @category Animation
 */
export const ANIM_GREATER_THAN: string;
/**
 * Used to set an anim state graph transition condition predicate as '<'.
 *
 * @type {string}
 * @category Animation
 */
export const ANIM_LESS_THAN: string;
/**
 * Used to set an anim state graph transition condition predicate as '>='.
 *
 * @type {string}
 * @category Animation
 */
export const ANIM_GREATER_THAN_EQUAL_TO: string;
/**
 * Used to set an anim state graph transition condition predicate as '<='.
 *
 * @type {string}
 * @category Animation
 */
export const ANIM_LESS_THAN_EQUAL_TO: string;
/**
 * Used to set an anim state graph transition condition predicate as '==='.
 *
 * @type {string}
 * @category Animation
 */
export const ANIM_EQUAL_TO: string;
/**
 * Used to set an anim state graph transition condition predicate as '!=='.
 *
 * @type {string}
 * @category Animation
 */
export const ANIM_NOT_EQUAL_TO: string;
/**
 * Used to set an anim state graph parameter as type integer.
 *
 * @type {string}
 * @category Animation
 */
export const ANIM_PARAMETER_INTEGER: string;
/**
 * Used to set an anim state graph parameter as type float.
 *
 * @type {string}
 * @category Animation
 */
export const ANIM_PARAMETER_FLOAT: string;
/**
 * Used to set an anim state graph parameter as type boolean.
 *
 * @type {string}
 * @category Animation
 */
export const ANIM_PARAMETER_BOOLEAN: string;
/**
 * Used to set an anim state graph parameter as type trigger.
 *
 * @type {string}
 * @category Animation
 */
export const ANIM_PARAMETER_TRIGGER: string;
/**
 * @type {string}
 * @category Animation
 */
export const ANIM_BLEND_1D: string;
/**
 * @type {string}
 * @category Animation
 */
export const ANIM_BLEND_2D_DIRECTIONAL: string;
/**
 * @type {string}
 * @category Animation
 */
export const ANIM_BLEND_2D_CARTESIAN: string;
/**
 * @type {string}
 * @category Animation
 */
export const ANIM_BLEND_DIRECT: string;
/**
 * The starting state in an anim state graph layer.
 *
 * @type {string}
 * @category Animation
 */
export const ANIM_STATE_START: string;
/**
 * The ending state in an anim state graph layer.
 *
 * @type {string}
 * @category Animation
 */
export const ANIM_STATE_END: string;
/**
 * Used to indicate any state in an anim state graph layer.
 *
 * @type {string}
 * @category Animation
 */
export const ANIM_STATE_ANY: string;
export const ANIM_CONTROL_STATES: string[];
/**
 * Used to indicate that a layers animations should overwrite all previous layers.
 *
 * @type {string}
 * @category Animation
 */
export const ANIM_LAYER_OVERWRITE: string;
/**
 * Used to indicate that a layers animations should blend additively with previous layers.
 *
 * @type {string}
 * @category Animation
 */
export const ANIM_LAYER_ADDITIVE: string;
