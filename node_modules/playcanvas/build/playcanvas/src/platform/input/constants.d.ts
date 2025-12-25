export const ACTION_MOUSE: "mouse";
export const ACTION_KEYBOARD: "keyboard";
export const ACTION_GAMEPAD: "gamepad";
export const AXIS_MOUSE_X: "mousex";
export const AXIS_MOUSE_Y: "mousey";
export const AXIS_PAD_L_X: "padlx";
export const AXIS_PAD_L_Y: "padly";
export const AXIS_PAD_R_X: "padrx";
export const AXIS_PAD_R_Y: "padry";
export const AXIS_KEY: "key";
/**
 * Name of event fired when a key is pressed.
 *
 * @type {string}
 * @category Input
 */
export const EVENT_KEYDOWN: string;
/**
 * Name of event fired when a key is released.
 *
 * @type {string}
 * @category Input
 */
export const EVENT_KEYUP: string;
/**
 * Name of event fired when a mouse button is pressed.
 *
 * @type {string}
 * @category Input
 */
export const EVENT_MOUSEDOWN: string;
/**
 * Name of event fired when the mouse is moved.
 *
 * @type {string}
 * @category Input
 */
export const EVENT_MOUSEMOVE: string;
/**
 * Name of event fired when a mouse button is released.
 *
 * @type {string}
 * @category Input
 */
export const EVENT_MOUSEUP: string;
/**
 * Name of event fired when the mouse wheel is rotated.
 *
 * @type {string}
 * @category Input
 */
export const EVENT_MOUSEWHEEL: string;
/**
 * Name of event fired when a new touch occurs. For example, a finger is placed on the device.
 *
 * @type {string}
 * @category Input
 */
export const EVENT_TOUCHSTART: string;
/**
 * Name of event fired when touch ends. For example, a finger is lifted off the device.
 *
 * @type {string}
 * @category Input
 */
export const EVENT_TOUCHEND: string;
/**
 * Name of event fired when a touch moves.
 *
 * @type {string}
 * @category Input
 */
export const EVENT_TOUCHMOVE: string;
/**
 * Name of event fired when a touch point is interrupted in some way. The exact reasons for
 * canceling a touch can vary from device to device. For example, a modal alert pops up during the
 * interaction; the touch point leaves the document area, or there are more touch points than the
 * device supports, in which case the earliest touch point is canceled.
 *
 * @type {string}
 * @category Input
 */
export const EVENT_TOUCHCANCEL: string;
/**
 * Name of event fired when a new xr select occurs. For example, primary trigger was pressed.
 *
 * @type {string}
 * @category Input
 */
export const EVENT_SELECT: string;
/**
 * Name of event fired when a new xr select starts. For example, primary trigger is now pressed.
 *
 * @type {string}
 * @category Input
 */
export const EVENT_SELECTSTART: string;
/**
 * Name of event fired when xr select ends. For example, a primary trigger is now released.
 *
 * @type {string}
 * @category Input
 */
export const EVENT_SELECTEND: string;
/**
 * @type {number}
 * @category Input
 */
export const KEY_BACKSPACE: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_TAB: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_RETURN: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_ENTER: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_SHIFT: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_CONTROL: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_ALT: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_PAUSE: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_CAPS_LOCK: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_ESCAPE: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_SPACE: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_PAGE_UP: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_PAGE_DOWN: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_END: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_HOME: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_LEFT: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_UP: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_RIGHT: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_DOWN: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_PRINT_SCREEN: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_INSERT: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_DELETE: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_0: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_1: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_2: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_3: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_4: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_5: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_6: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_7: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_8: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_9: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_SEMICOLON: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_EQUAL: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_A: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_B: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_C: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_D: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_E: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_F: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_G: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_H: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_I: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_J: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_K: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_L: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_M: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_N: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_O: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_P: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_Q: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_R: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_S: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_T: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_U: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_V: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_W: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_X: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_Y: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_Z: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_WINDOWS: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_CONTEXT_MENU: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_NUMPAD_0: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_NUMPAD_1: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_NUMPAD_2: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_NUMPAD_3: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_NUMPAD_4: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_NUMPAD_5: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_NUMPAD_6: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_NUMPAD_7: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_NUMPAD_8: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_NUMPAD_9: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_MULTIPLY: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_ADD: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_SEPARATOR: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_SUBTRACT: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_DECIMAL: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_DIVIDE: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_F1: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_F2: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_F3: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_F4: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_F5: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_F6: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_F7: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_F8: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_F9: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_F10: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_F11: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_F12: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_COMMA: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_PERIOD: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_SLASH: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_OPEN_BRACKET: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_BACK_SLASH: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_CLOSE_BRACKET: number;
/**
 * @type {number}
 * @category Input
 */
export const KEY_META: number;
/**
 * No mouse buttons pressed.
 *
 * @type {number}
 * @category Input
 */
export const MOUSEBUTTON_NONE: number;
/**
 * The left mouse button.
 *
 * @type {number}
 * @category Input
 */
export const MOUSEBUTTON_LEFT: number;
/**
 * The middle mouse button.
 *
 * @type {number}
 * @category Input
 */
export const MOUSEBUTTON_MIDDLE: number;
/**
 * The right mouse button.
 *
 * @type {number}
 * @category Input
 */
export const MOUSEBUTTON_RIGHT: number;
/**
 * Index for pad 1.
 *
 * @type {number}
 * @category Input
 */
export const PAD_1: number;
/**
 * Index for pad 2.
 *
 * @type {number}
 * @category Input
 */
export const PAD_2: number;
/**
 * Index for pad 3.
 *
 * @type {number}
 * @category Input
 */
export const PAD_3: number;
/**
 * Index for pad 4.
 *
 * @type {number}
 * @category Input
 */
export const PAD_4: number;
/**
 * The first face button, from bottom going clockwise.
 *
 * @type {number}
 * @category Input
 */
export const PAD_FACE_1: number;
/**
 * The second face button, from bottom going clockwise.
 *
 * @type {number}
 * @category Input
 */
export const PAD_FACE_2: number;
/**
 * The third face button, from bottom going clockwise.
 *
 * @type {number}
 * @category Input
 */
export const PAD_FACE_3: number;
/**
 * The fourth face button, from bottom going clockwise.
 *
 * @type {number}
 * @category Input
 */
export const PAD_FACE_4: number;
/**
 * The first shoulder button on the left.
 *
 * @type {number}
 * @category Input
 */
export const PAD_L_SHOULDER_1: number;
/**
 * The first shoulder button on the right.
 *
 * @type {number}
 * @category Input
 */
export const PAD_R_SHOULDER_1: number;
/**
 * The second shoulder button on the left.
 *
 * @type {number}
 * @category Input
 */
export const PAD_L_SHOULDER_2: number;
/**
 * The second shoulder button on the right.
 *
 * @type {number}
 * @category Input
 */
export const PAD_R_SHOULDER_2: number;
/**
 * The select button.
 *
 * @type {number}
 * @category Input
 */
export const PAD_SELECT: number;
/**
 * The start button.
 *
 * @type {number}
 * @category Input
 */
export const PAD_START: number;
/**
 * The button when depressing the left analogue stick.
 *
 * @type {number}
 * @category Input
 */
export const PAD_L_STICK_BUTTON: number;
/**
 * The button when depressing the right analogue stick.
 *
 * @type {number}
 * @category Input
 */
export const PAD_R_STICK_BUTTON: number;
/**
 * Direction pad up.
 *
 * @type {number}
 * @category Input
 */
export const PAD_UP: number;
/**
 * Direction pad down.
 *
 * @type {number}
 * @category Input
 */
export const PAD_DOWN: number;
/**
 * Direction pad left.
 *
 * @type {number}
 * @category Input
 */
export const PAD_LEFT: number;
/**
 * Direction pad right.
 *
 * @type {number}
 * @category Input
 */
export const PAD_RIGHT: number;
/**
 * Vendor specific button.
 *
 * @type {number}
 * @category Input
 */
export const PAD_VENDOR: number;
/**
 * Horizontal axis on the left analogue stick.
 *
 * @type {number}
 * @category Input
 */
export const PAD_L_STICK_X: number;
/**
 * Vertical axis on the left analogue stick.
 *
 * @type {number}
 * @category Input
 */
export const PAD_L_STICK_Y: number;
/**
 * Horizontal axis on the right analogue stick.
 *
 * @type {number}
 * @category Input
 */
export const PAD_R_STICK_X: number;
/**
 * Vertical axis on the right analogue stick.
 *
 * @type {number}
 * @category Input
 */
export const PAD_R_STICK_Y: number;
/**
 * Name of event fired when a gamepad connects.
 *
 * @type {string}
 * @category Input
 */
export const EVENT_GAMEPADCONNECTED: string;
/**
 * Name of event fired when a gamepad disconnects.
 *
 * @type {string}
 * @category Input
 */
export const EVENT_GAMEPADDISCONNECTED: string;
/**
 * Horizontal axis on the touchpad of a XR pad.
 *
 * @type {number}
 * @category Input
 */
export const XRPAD_TOUCHPAD_X: number;
/**
 * Vertical axis on the thouchpad of a XR pad.
 *
 * @type {number}
 * @category Input
 */
export const XRPAD_TOUCHPAD_Y: number;
/**
 * Horizontal axis on the stick of a XR pad.
 *
 * @type {number}
 * @category Input
 */
export const XRPAD_STICK_X: number;
/**
 * Vertical axis on the stick of a XR pad.
 *
 * @type {number}
 * @category Input
 */
export const XRPAD_STICK_Y: number;
/**
 * The button when pressing the XR pad's touchpad.
 *
 * @type {number}
 * @category Input
 */
export const XRPAD_TOUCHPAD_BUTTON: number;
/**
 * The trigger button from XR pad.
 *
 * @type {number}
 * @category Input
 */
export const XRPAD_TRIGGER: number;
/**
 * The squeeze button from XR pad.
 *
 * @type {number}
 * @category Input
 */
export const XRPAD_SQUEEZE: number;
/**
 * The button when pressing the XR pad's stick.
 *
 * @type {number}
 * @category Input
 */
export const XRPAD_STICK_BUTTON: number;
/**
 * The A button from XR pad.
 *
 * @type {number}
 * @category Input
 */
export const XRPAD_A: number;
/**
 * The B button from XR pad.
 *
 * @type {number}
 * @category Input
 */
export const XRPAD_B: number;
