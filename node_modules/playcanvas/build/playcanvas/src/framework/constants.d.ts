/**
 * When resizing the window the size of the canvas will not change.
 *
 * @type {string}
 */
export const FILLMODE_NONE: string;
/**
 * When resizing the window the size of the canvas will change to fill the window exactly.
 *
 * @type {string}
 */
export const FILLMODE_FILL_WINDOW: string;
/**
 * When resizing the window the size of the canvas will change to fill the window as best it can,
 * while maintaining the same aspect ratio.
 *
 * @type {string}
 */
export const FILLMODE_KEEP_ASPECT: string;
/**
 * When the canvas is resized the resolution of the canvas will change to match the size of the
 * canvas.
 *
 * @type {string}
 */
export const RESOLUTION_AUTO: string;
/**
 * When the canvas is resized the resolution of the canvas will remain at the same value and the
 * output will just be scaled to fit the canvas.
 *
 * @type {string}
 */
export const RESOLUTION_FIXED: string;
