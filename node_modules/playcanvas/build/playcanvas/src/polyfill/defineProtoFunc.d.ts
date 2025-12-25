/**
 * A short hand function to polyfill prototype methods which are not iterated in e.g. for-in loops.
 *
 * @param {ObjectConstructor} cls
 * @param {string} name
 * @param {Function} func
 * @ignore
 */
export function defineProtoFunc(cls: ObjectConstructor, name: string, func: Function): void;
