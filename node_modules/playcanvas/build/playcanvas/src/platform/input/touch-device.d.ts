/**
 * Attach a TouchDevice to an element and it will receive and fire events when the element is
 * touched. See also {@link Touch} and {@link TouchEvent}.
 *
 * @category Input
 */
export class TouchDevice extends EventHandler {
    /**
     * Create a new touch device and attach it to an element.
     *
     * @param {Element} element - The element to attach listen for events on.
     */
    constructor(element: Element);
    _element: Element;
    _startHandler: any;
    _endHandler: any;
    _moveHandler: any;
    _cancelHandler: any;
    /**
     * Attach a device to an element in the DOM. If the device is already attached to an element
     * this method will detach it first.
     *
     * @param {Element} element - The element to attach to.
     */
    attach(element: Element): void;
    /**
     * Detach a device from the element it is attached to.
     */
    detach(): void;
    _handleTouchStart(e: any): void;
    _handleTouchEnd(e: any): void;
    _handleTouchMove(e: any): void;
    _handleTouchCancel(e: any): void;
}
import { EventHandler } from '../../core/event-handler.js';
