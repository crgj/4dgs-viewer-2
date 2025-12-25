/**
 * An animation is a sequence of keyframe arrays which map to the nodes of a skeletal hierarchy. It
 * controls how the nodes of the hierarchy are transformed over time.
 *
 * @category Animation
 */
export class Animation {
    /**
     * Human-readable name of the animation.
     *
     * @type {string}
     */
    name: string;
    /**
     * Duration of the animation in seconds.
     *
     * @type {number}
     */
    duration: number;
    _nodes: any[];
    _nodeDict: {};
    /**
     * Gets a {@link Node} by name.
     *
     * @param {string} name - The name of the {@link Node}.
     * @returns {Node} The {@link Node} with the specified name.
     */
    getNode(name: string): Node;
    /**
     * Adds a node to the internal nodes array.
     *
     * @param {Node} node - The node to add.
     */
    addNode(node: Node): void;
    /**
     * A read-only property to get array of animation nodes.
     *
     * @type {Node[]}
     */
    get nodes(): Node[];
}
export class Key {
    constructor(time: any, position: any, rotation: any, scale: any);
    time: any;
    position: any;
    rotation: any;
    scale: any;
}
/**
 * A animation node has a name and contains an array of keyframes.
 *
 * @category Animation
 */
export class Node {
    _name: string;
    _keys: any[];
}
