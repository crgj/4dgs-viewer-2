/**
 * EventHandle manages the binding and unbinding of event listeners. It provides a convenient way
 * to add, remove, and invoke event handlers associated with specific event names. Each EventHandle
 * is linked to an 'owner' object, typically an instance of the Events class, allowing for elegant
 * event management and chaining.
 */
class EventHandle {
    /**
     * Creates an instance of EventHandle.
     *
     * @param owner - Owner
     * @param name - Name
     * @param fn - Callback function
     */
    constructor(owner, name, fn) {
        this.owner = owner;
        this.name = name;
        this.fn = fn;
    }
    /**
     * Unbinds the event handle from the owner, effectively removing the event listener. After
     * calling this method, the event handle will no longer trigger the callback function when the
     * event is emitted.
     */
    unbind() {
        if (!this.owner) {
            return;
        }
        this.owner.unbind(this.name, this.fn);
        this.owner = null;
        this.name = null;
        this.fn = null;
    }
    /**
     * Invokes the callback function associated with the event handle. This method directly
     * triggers the event's callback without the event being emitted by the event system.
     */
    call(_events, ..._args) {
        if (!this.fn) {
            return;
        }
        this.fn.call(this.owner, arguments[0], arguments[1], arguments[2], arguments[3], arguments[4], arguments[5], arguments[6], arguments[7]);
    }
    /**
     * Registers a new event listener on the same owner as the EventHandle. This method allows
     * chaining additional event listeners to the owner of this event handle.
     *
     * @param name - Name
     * @param fn - Callback function
     * @returns EventHandle
     */
    on(name, fn) {
        return this.owner.on(name, fn);
    }
}

/**
 * Base class for event handling, providing mechanisms to register, emit, and unbind events. This
 * class supports adding event listeners, emitting events with up to 8 arguments, and managing
 * multiple emitters.
 *
 * @example
 * // Create an instance of the Events class
 * const events = new Events();
 *
 * // Register an event listener
 * events.on('testEvent', (arg1, arg2) => {
 *     console.log('Event triggered with arguments:', arg1, arg2);
 * });
 *
 * // Emit the event
 * events.emit('testEvent', 'value1', 'value2');
 *
 * // Unbind the event listener
 * events.unbind('testEvent');
 */
class Events {
    /**
     * Creates a new Events instance.
     */
    constructor() {
        this._suspendEvents = false;
        this._additionalEmitters = [];
        this._events = {};
        // _world
        Object.defineProperty(this, '_events', {
            enumerable: false,
            configurable: false,
            writable: true,
            value: {}
        });
    }
    /**
     * Sets whether events are suspended. If true, the observer will not emit events when values
     * are set.
     */
    set suspendEvents(value) {
        this._suspendEvents = !!value;
    }
    /**
     * Gets whether events are suspended.
     */
    get suspendEvents() {
        return this._suspendEvents;
    }
    /**
     * Registers an event listener for the specified event name. If the event is emitted,
     * the callback function is executed with up to 8 arguments.
     *
     * @param name - The name of the event to listen for.
     * @param fn - The callback function to be executed when the event is emitted.
     * @returns An EventHandle object that can be used to unbind the event listener.
     *
     * @example
     * // Register an event listener
     * events.on('testEvent', (arg1, arg2) => {
     *     console.log('Event triggered with arguments:', arg1, arg2);
     * });
     *
     * // Emit the event
     * events.emit('testEvent', 'value1', 'value2');
     */
    on(name, fn) {
        const events = this._events[name];
        if (events === undefined) {
            this._events[name] = [fn];
        }
        else {
            if (events.indexOf(fn) === -1) {
                events.push(fn);
            }
        }
        return new EventHandle(this, name, fn);
    }
    /**
     * Registers a one-time event listener for the specified event name. The callback function is
     * executed the next time the event is emitted, and then automatically unbound.
     *
     * @param name - The name of the event to listen for.
     * @param fn - The callback function to be executed once when the event is emitted.
     * @returns An EventHandle object that can be used to unbind the event listener
     * before it is triggered.
     *
     * @example
     * // Register a one-time event listener
     * events.once('testEvent', (arg1, arg2) => {
     *     console.log('Event triggered once with arguments:', arg1, arg2);
     * });
     *
     * // Emit the event
     * events.emit('testEvent', 'value1', 'value2'); // The callback will be called and then unbound.
     *
     * // Emit the event again
     * events.emit('testEvent', 'value1', 'value2'); // The callback will not be called this time.
     */
    once(name, fn) {
        const evt = this.on(name, (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7) => {
            fn.call(this, arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7);
            evt.unbind();
        });
        return evt;
    }
    /**
     * Emits the specified event, executing all registered listeners for that event with the
     * provided arguments. If events are suspended, the emit operation will be ignored.
     *
     * @param name - The name of the event to emit.
     * @param arg0 - The first argument to pass to the event listeners.
     * @param arg1 - The second argument to pass to the event listeners.
     * @param arg2 - The third argument to pass to the event listeners.
     * @param arg3 - The fourth argument to pass to the event listeners.
     * @param arg4 - The fifth argument to pass to the event listeners.
     * @param arg5 - The sixth argument to pass to the event listeners.
     * @param arg6 - The seventh argument to pass to the event listeners.
     * @param arg7 - The eighth argument to pass to the event listeners.
     * @returns The current instance for chaining.
     *
     * @example
     * // Register an event listener
     * events.on('testEvent', (arg1, arg2) => {
     *     console.log('Event triggered with arguments:', arg1, arg2);
     * });
     *
     * // Emit the event
     * events.emit('testEvent', 'value1', 'value2');
     *
     * // Emit the event with more arguments
     * events.emit('testEvent', 'value1', 'value2', 'value3', 'value4');
     */
    emit(name, arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7) {
        if (this._suspendEvents)
            return this;
        let events = this._events[name];
        if (events && events.length) {
            events = events.slice(0);
            for (let i = 0; i < events.length; i++) {
                if (!events[i]) {
                    continue;
                }
                try {
                    events[i].call(this, arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7);
                }
                catch (ex) {
                    console.info('%c%s %c(event error)', 'color: #06f', name, 'color: #f00');
                    console.log(ex.stack);
                }
            }
        }
        if (this._additionalEmitters.length) {
            const emitters = this._additionalEmitters.slice();
            emitters.forEach((emitter) => {
                emitter.emit(name, arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7);
            });
        }
        return this;
    }
    /**
     * Unbinds an event listener for the specified event name. If a callback function is provided,
     * only that specific listener is removed. If no callback is provided, all listeners for the
     * event are removed. If no event name is provided, all listeners for all events are removed.
     *
     * @param name - The name of the event to unbind. If not provided, all events are
     * unbound.
     * @param fn - The specific callback function to remove. If not provided, all
     * listeners for the event are removed.
     * @returns The current instance for chaining.
     *
     * @example
     * // Register an event listener
     * const callback = (arg1, arg2) => {
     *     console.log('Event triggered with arguments:', arg1, arg2);
     * };
     * events.on('testEvent', callback);
     *
     * // Unbind the specific event listener
     * events.unbind('testEvent', callback);
     *
     * // Unbind all listeners for a specific event
     * events.unbind('testEvent');
     *
     * // Unbind all listeners for all events
     * events.unbind();
     */
    unbind(name, fn) {
        if (name) {
            const events = this._events[name];
            if (!events) {
                return this;
            }
            if (fn) {
                const i = events.indexOf(fn);
                if (i !== -1) {
                    if (events.length === 1) {
                        delete this._events[name];
                    }
                    else {
                        events.splice(i, 1);
                    }
                }
            }
            else {
                delete this._events[name];
            }
        }
        else {
            this._events = {};
        }
        return this;
    }
    /**
     * Adds another emitter. Any events fired by this instance will also be fired on the additional
     * emitter.
     *
     * @param emitter - The emitter
     */
    addEmitter(emitter) {
        if (!this._additionalEmitters.includes(emitter)) {
            this._additionalEmitters.push(emitter);
        }
    }
    /**
     * Removes emitter.
     *
     * @param emitter - The emitter
     */
    removeEmitter(emitter) {
        const idx = this._additionalEmitters.indexOf(emitter);
        if (idx !== -1) {
            this._additionalEmitters.splice(idx, 1);
        }
    }
}

function __awaiter(thisArg, _arguments, P, generator) {
  function adopt(value) {
    return value instanceof P ? value : new P(function (resolve) {
      resolve(value);
    });
  }
  return new (P || (P = Promise))(function (resolve, reject) {
    function fulfilled(value) {
      try {
        step(generator.next(value));
      } catch (e) {
        reject(e);
      }
    }
    function rejected(value) {
      try {
        step(generator["throw"](value));
      } catch (e) {
        reject(e);
      }
    }
    function step(result) {
      result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected);
    }
    step((generator = generator.apply(thisArg, _arguments || [])).next());
  });
}
typeof SuppressedError === "function" ? SuppressedError : function (error, suppressed, message) {
  var e = new Error(message);
  return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
};

/**
 * Manages history actions for undo/redo operations. This class keeps track of actions that can be
 * undone and redone, allowing for complex state management in applications such as editors, games,
 * or any interactive applications where state changes need to be reversible.
 *
 * @example
 * const history = new History();
 *
 * // Define an action
 * const action = {
 *   name: 'draw',
 *   undo: () => { console.log('Undo draw'); },
 *   redo: () => { console.log('Redo draw'); }
 * };
 *
 * // Add the action to history
 * history.add(action);
 *
 * // Perform undo
 * history.undo();
 *
 * // Perform redo
 * history.redo();
 */
class History extends Events {
    constructor() {
        super(...arguments);
        this._executing = 0;
        this._actions = [];
        this._currentActionIndex = -1;
        this._canUndo = false;
        this._canRedo = false;
    }
    /**
     * Adds a new history action to the stack. If the action has a combine flag and matches the
     * current action's name, the redo function of the current action is updated. If actions have
     * been undone before adding this new action, it removes all actions that come after the
     * current action to maintain a consistent history.
     *
     * @param action - The action to add.
     * @returns Returns `true` if the action is successfully added, `false` otherwise.
     */
    add(action) {
        if (!action.name) {
            console.error('Trying to add history action without name');
            return false;
        }
        if (!action.undo) {
            console.error('Trying to add history action without undo method', action.name);
            return false;
        }
        if (!action.redo) {
            console.error('Trying to add history action without redo method', action.name);
            return false;
        }
        // If an action is added after some actions have been undone, remove all actions that come
        // after the current action to ensure the history is consistent.
        if (this._currentActionIndex !== this._actions.length - 1) {
            this._actions = this._actions.slice(0, this._currentActionIndex + 1);
        }
        // If the combine flag is true and the current action has the same name, replace the redo
        // function of the current action with the new action's redo function.
        if (action.combine && this.currentAction && this.currentAction.name === action.name) {
            this.currentAction.redo = action.redo;
        }
        else {
            const length = this._actions.push(action);
            this._currentActionIndex = length - 1;
        }
        this.emit('add', action.name);
        this.canUndo = true;
        this.canRedo = false;
        return true;
    }
    /**
     * Adds a new history action and immediately executes its redo function.
     *
     * @param action - The action.
     * @returns A promise that resolves once the redo function has been executed.
     */
    addAndExecute(action) {
        return __awaiter(this, undefined, undefined, function* () {
            if (this.add(action)) {
                // execute an action - don't allow history actions till it finishes
                try {
                    this.executing++;
                    yield action.redo();
                }
                finally {
                    this.executing--;
                }
            }
        });
    }
    /**
     * Undoes the last history action. This method retrieves the current action from the history
     * stack and executes the action's undo function.
     *
     * @returns A promise that resolves once the undo function has been executed.
     */
    undo() {
        return __awaiter(this, undefined, undefined, function* () {
            if (!this.canUndo) {
                return;
            }
            const name = this.currentAction.name;
            const undo = this.currentAction.undo;
            this._currentActionIndex--;
            this.emit('undo', name);
            if (this._currentActionIndex < 0) {
                this.canUndo = false;
            }
            this.canRedo = true;
            // execute an undo action - don't allow history actions until it finishes
            try {
                this.executing++;
                yield undo();
            }
            catch (ex) {
                console.info('%c(History#undo)', 'color: #f00');
                console.log(ex.stack);
            }
            finally {
                this.executing--;
            }
        });
    }
    /**
     * Redoes the next history action. This retrieves the next action from the history stack and
     * executes the action's redo function.
     *
     * @returns A promise that resolves once the redo function has been executed.
     */
    redo() {
        return __awaiter(this, undefined, undefined, function* () {
            if (!this.canRedo) {
                return;
            }
            this._currentActionIndex++;
            const redo = this.currentAction.redo;
            this.emit('redo', this.currentAction.name);
            this.canUndo = true;
            if (this._currentActionIndex === this._actions.length - 1) {
                this.canRedo = false;
            }
            // execute redo action - don't allow history actions till it finishes
            try {
                this.executing++;
                yield redo();
            }
            catch (ex) {
                console.info('%c(History#redo)', 'color: #f00');
                console.log(ex.stack);
            }
            finally {
                this.executing--;
            }
        });
    }
    /**
     * Clears all history actions.
     */
    clear() {
        if (!this._actions.length)
            return;
        this._actions.length = 0;
        this._currentActionIndex = -1;
        this.canUndo = false;
        this.canRedo = false;
    }
    /**
     * The current history action.
     */
    get currentAction() {
        return this._actions[this._currentActionIndex] || null;
    }
    /**
     * The last action committed to the history.
     */
    get lastAction() {
        return this._actions[this._actions.length - 1] || null;
    }
    /**
     * Sets whether we can undo at this time.
     */
    set canUndo(value) {
        if (this._canUndo === value)
            return;
        this._canUndo = value;
        if (!this.executing) {
            this.emit('canUndo', value);
        }
    }
    /**
     * Gets whether we can undo at this time.
     */
    get canUndo() {
        return this._canUndo && !this.executing;
    }
    /**
     * Sets whether we can redo at this time.
     */
    set canRedo(value) {
        if (this._canRedo === value)
            return;
        this._canRedo = value;
        if (!this.executing) {
            this.emit('canRedo', value);
        }
    }
    /**
     * Gets whether we can redo at this time.
     */
    get canRedo() {
        return this._canRedo && !this.executing;
    }
    /**
     * Sets the number of async actions currently executing.
     */
    set executing(value) {
        if (this._executing === value)
            return;
        this._executing = value;
        if (this._executing) {
            this.emit('canUndo', false);
            this.emit('canRedo', false);
        }
        else {
            this.emit('canUndo', this._canUndo);
            this.emit('canRedo', this._canRedo);
        }
    }
    /**
     * Gets the number of async actions currently executing.
     */
    get executing() {
        return this._executing;
    }
}

/**
 * Determines whether two arrays are deeply equal. Two arrays are considered equal if they have the
 * same length and corresponding elements are equal. This function also supports nested arrays,
 * comparing them recursively.
 *
 * @param a - The first array to compare.
 * @param b - The second array to compare.
 * @returns Returns `true` if the arrays are deeply equal, otherwise `false`.
 *
 * @example
 * arrayEquals([1, 2, 3], [1, 2, 3]); // true
 * arrayEquals([1, 2, 3], [3, 2, 1]); // false
 * arrayEquals([1, [2, 3]], [1, [2, 3]]); // true
 * arrayEquals([1, [2, 3]], [1, [3, 2]]); // false
 * arrayEquals([1, 2, 3], null); // false
 * arrayEquals(null, null); // false
 */
const arrayEquals = (a, b) => {
    if (!a || !b) {
        return false;
    }
    const l = a.length;
    if (l !== b.length) {
        return false;
    }
    for (let i = 0; i < l; i++) {
        if (a[i] instanceof Array && b[i] instanceof Array) {
            if (!arrayEquals(a[i], b[i])) {
                return false;
            }
        }
        else if (a[i] !== b[i]) {
            return false;
        }
    }
    return true;
};

/**
 * The Observer class is used to observe and manage changes to an object. It allows for tracking
 * modifications to nested properties, emitting events on changes, and maintaining state
 * consistency. This is particularly useful in applications where state management and change
 * tracking are critical, such as in data-driven interfaces or collaborative applications.
 *
 * @example
 * const data = {
 *   name: 'John',
 *   age: 30,
 *   address: {
 *     city: 'New York',
 *     zip: '10001'
 *   }
 * };
 *
 * const observer = new Observer(data);
 *
 * observer.on('name:set', (newValue, oldValue) => {
 *   console.log(`Name changed from ${oldValue} to ${newValue}`);
 * });
 *
 * observer.set('name', 'Jane'); // Logs: Name changed from John to Jane
 */
class Observer extends Events {
    /**
     * Creates a new Observer instance.
     *
     * @param data - The initial data to observe.
     * @param options - Additional options for the observer.
     */
    constructor(data, options = {}) {
        super();
        this._destroyed = false;
        this._path = '';
        this._keys = [];
        this._data = {};
        this._pathsWithDuplicates = null;
        this._parent = null;
        this._parentPath = '';
        this._parentField = null;
        this._parentKey = null;
        this._latestFn = null;
        this._silent = false;
        // array paths where duplicate entries are allowed - normally
        // we check if an array already has a value before inserting it
        // but if the array path is in here we'll allow it
        this._pathsWithDuplicates = null;
        if (options.pathsWithDuplicates) {
            this._pathsWithDuplicates = {};
            for (let i = 0; i < options.pathsWithDuplicates.length; i++) {
                this._pathsWithDuplicates[options.pathsWithDuplicates[i]] = true;
            }
        }
        this.patch(data);
        this._parent = options.parent || null;
        this._parentPath = options.parentPath || '';
        this._parentField = options.parentField || null;
        this._parentKey = options.parentKey || null;
        this._latestFn = options.latestFn || null;
        this._silent = false;
        const propagate = function (evt) {
            return function (path, arg1, arg2, arg3) {
                if (!this._parent) {
                    return;
                }
                let key = this._parentKey;
                if (!key && (this._parentField instanceof Array)) {
                    key = this._parentField.indexOf(this);
                    if (key === -1) {
                        return;
                    }
                }
                path = `${this._parentPath}.${key}.${path}`;
                let state;
                if (this._silent) {
                    state = this._parent.silence();
                }
                this._parent.emit(`${path}:${evt}`, arg1, arg2, arg3);
                this._parent.emit(`*:${evt}`, path, arg1, arg2, arg3);
                if (this._silent) {
                    this._parent.silenceRestore(state);
                }
            };
        };
        // propagate set
        this.on('*:set', propagate('set'));
        this.on('*:unset', propagate('unset'));
        this.on('*:insert', propagate('insert'));
        this.on('*:remove', propagate('remove'));
        this.on('*:move', propagate('move'));
    }
    static _splitPath(path) {
        const cache = Observer._splitPathsCache;
        let result = cache[path];
        if (!result) {
            result = path.split('.');
            cache[path] = result;
        }
        else {
            result = result.slice();
        }
        return result;
    }
    silence() {
        this._silent = true;
        // history hook to prevent array values to be recorded
        const historyState = this.history && this.history.enabled;
        if (historyState) {
            this.history.enabled = false;
        }
        // sync hook to prevent array values to be recorded as array root already did
        const syncState = this.sync && this.sync.enabled;
        if (syncState) {
            this.sync.enabled = false;
        }
        return [historyState, syncState];
    }
    silenceRestore(state) {
        this._silent = false;
        if (state[0]) {
            this.history.enabled = true;
        }
        if (state[1]) {
            this.sync.enabled = true;
        }
    }
    _prepare(target, key, value, silent = false, remote = false) {
        let i;
        let state;
        const path = (target._path ? (`${target._path}.`) : '') + key;
        const type = typeof value;
        target._keys.push(key);
        if (type === 'object' && (value instanceof Array)) {
            target._data[key] = value.slice(0);
            for (i = 0; i < target._data[key].length; i++) {
                if (typeof target._data[key][i] === 'object' && target._data[key][i] !== null) {
                    if (target._data[key][i] instanceof Array) {
                        target._data[key][i].slice(0);
                    }
                    else {
                        target._data[key][i] = new Observer(target._data[key][i], {
                            parent: this,
                            parentPath: path,
                            parentField: target._data[key],
                            parentKey: null
                        });
                    }
                }
                else {
                    state = this.silence();
                    this.emit(`${path}.${i}:set`, target._data[key][i], null, remote);
                    this.emit('*:set', `${path}.${i}`, target._data[key][i], null, remote);
                    this.silenceRestore(state);
                }
            }
            if (silent) {
                state = this.silence();
            }
            this.emit(`${path}:set`, target._data[key], null, remote);
            this.emit('*:set', path, target._data[key], null, remote);
            if (silent) {
                this.silenceRestore(state);
            }
        }
        else if (type === 'object' && (value instanceof Object)) {
            if (typeof target._data[key] !== 'object') {
                target._data[key] = {
                    _path: path,
                    _keys: [],
                    _data: {}
                };
            }
            for (i in value) {
                if (typeof value[i] === 'object') {
                    this._prepare(target._data[key], i, value[i], true, remote);
                }
                else {
                    state = this.silence();
                    target._data[key]._data[i] = value[i];
                    target._data[key]._keys.push(i);
                    this.emit(`${path}.${i}:set`, value[i], null, remote);
                    this.emit('*:set', `${path}.${i}`, value[i], null, remote);
                    this.silenceRestore(state);
                }
            }
            if (silent) {
                state = this.silence();
            }
            // passing undefined as valueOld here
            // but we should get the old value to be consistent
            this.emit(`${path}:set`, value, undefined, remote);
            this.emit('*:set', path, value, undefined, remote);
            if (silent) {
                this.silenceRestore(state);
            }
        }
        else {
            if (silent) {
                state = this.silence();
            }
            target._data[key] = value;
            this.emit(`${path}:set`, value, undefined, remote);
            this.emit('*:set', path, value, undefined, remote);
            if (silent) {
                this.silenceRestore(state);
            }
        }
        return true;
    }
    /**
     * @param path - Path to the property in the object.
     * @param value - Value to set.
     * @param silent - If true, the change will not be recorded in history.
     * @param remote - State value passed to the set event used to disable remote event emission.
     * @param force - If true, the value will be set even if it is the same as the current value.
     * @returns Returns true if the value was successfully set and false otherwise.
     */
    set(path, value, silent = false, remote = false, force = false) {
        let i;
        let valueOld;
        let keys = Observer._splitPath(path);
        const length = keys.length;
        const key = keys[length - 1];
        let node = this;
        let nodePath = '';
        let obj = this;
        let state;
        for (i = 0; i < length - 1; i++) {
            if (node instanceof Array) {
                node = node[keys[i]];
                if (node instanceof Observer) {
                    path = keys.slice(i + 1).join('.');
                    obj = node;
                }
            }
            else {
                if (i < length && typeof node._data[keys[i]] !== 'object') {
                    if (node._data[keys[i]]) {
                        obj.unset((node._path ? `${node._path}.` : '') + keys[i]);
                    }
                    node._data[keys[i]] = {
                        _path: path,
                        _keys: [],
                        _data: {}
                    };
                    node._keys.push(keys[i]);
                }
                if (i === length - 1 && node._path) {
                    nodePath = `${node._path}.${keys[i]}`;
                }
                node = node._data[keys[i]];
            }
        }
        if (node instanceof Array) {
            const ind = parseInt(key, 10);
            if (node[ind] === value && !force) {
                return false;
            }
            valueOld = node[ind];
            if (valueOld instanceof Observer) {
                valueOld = valueOld.json();
            }
            else {
                valueOld = obj.json(valueOld);
            }
            node[ind] = value;
            if (value instanceof Observer) {
                value._parent = obj;
                value._parentPath = nodePath;
                value._parentField = node;
                value._parentKey = null;
            }
            if (silent) {
                state = obj.silence();
            }
            obj.emit(`${path}:set`, value, valueOld, remote);
            obj.emit('*:set', path, value, valueOld, remote);
            if (silent) {
                obj.silenceRestore(state);
            }
            return true;
        }
        else if (node._data && !node._data.hasOwnProperty(key)) {
            if (typeof value === 'object') {
                return obj._prepare(node, key, value, false, remote);
            }
            node._data[key] = value;
            node._keys.push(key);
            if (silent) {
                state = obj.silence();
            }
            obj.emit(`${path}:set`, value, null, remote);
            obj.emit('*:set', path, value, null, remote);
            if (silent) {
                obj.silenceRestore(state);
            }
            return true;
        }
        if (typeof value === 'object' && (value instanceof Array)) {
            if (arrayEquals(value, node._data[key]) && !force) {
                return false;
            }
            valueOld = node._data[key];
            if (!(valueOld instanceof Observer)) {
                valueOld = obj.json(valueOld);
            }
            if (node._data[key] && node._data[key].length === value.length) {
                state = obj.silence();
                // handle new array instance
                if (value.length === 0) {
                    node._data[key] = value;
                }
                for (i = 0; i < node._data[key].length; i++) {
                    if (node._data[key][i] instanceof Observer) {
                        node._data[key][i].patch(value[i], true);
                    }
                    else if (node._data[key][i] !== value[i]) {
                        node._data[key][i] = value[i];
                        obj.emit(`${path}.${i}:set`, node._data[key][i], valueOld && valueOld[i] || null, remote);
                        obj.emit('*:set', `${path}.${i}`, node._data[key][i], valueOld && valueOld[i] || null, remote);
                    }
                }
                obj.silenceRestore(state);
            }
            else {
                node._data[key] = [];
                value.forEach((val) => {
                    this._doInsert(node, key, val, undefined, true);
                });
                state = obj.silence();
                for (i = 0; i < node._data[key].length; i++) {
                    obj.emit(`${path}.${i}:set`, node._data[key][i], valueOld && valueOld[i] || null, remote);
                    obj.emit('*:set', `${path}.${i}`, node._data[key][i], valueOld && valueOld[i] || null, remote);
                }
                obj.silenceRestore(state);
            }
            if (silent) {
                state = obj.silence();
            }
            obj.emit(`${path}:set`, value, valueOld, remote);
            obj.emit('*:set', path, value, valueOld, remote);
            if (silent) {
                obj.silenceRestore(state);
            }
            return true;
        }
        else if (typeof value === 'object' && (value instanceof Object)) {
            let changed = false;
            valueOld = node._data[key];
            if (!(valueOld instanceof Observer)) {
                valueOld = obj.json(valueOld);
            }
            keys = Object.keys(value);
            if (!node._data[key] || !node._data[key]._data) {
                if (node._data[key]) {
                    obj.unset((node._path ? `${node._path}.` : '') + key);
                }
                else {
                    changed = true;
                }
                node._data[key] = {
                    _path: path,
                    _keys: [],
                    _data: {}
                };
            }
            let c;
            for (const n in node._data[key]._data) {
                if (!value.hasOwnProperty(n)) {
                    c = obj.unset(`${path}.${n}`, true);
                    if (c)
                        changed = true;
                }
                else if (node._data[key]._data.hasOwnProperty(n)) {
                    if (!obj._equals(node._data[key]._data[n], value[n])) {
                        c = obj.set(`${path}.${n}`, value[n], true);
                        if (c)
                            changed = true;
                    }
                }
                else {
                    c = obj._prepare(node._data[key], n, value[n], true, remote);
                    if (c)
                        changed = true;
                }
            }
            for (i = 0; i < keys.length; i++) {
                if (value[keys[i]] === undefined && node._data[key]._data.hasOwnProperty(keys[i])) {
                    c = obj.unset(`${path}.${keys[i]}`, true);
                    if (c)
                        changed = true;
                }
                else if (typeof value[keys[i]] === 'object') {
                    if (node._data[key]._data.hasOwnProperty(keys[i])) {
                        c = obj.set(`${path}.${keys[i]}`, value[keys[i]], true);
                        if (c)
                            changed = true;
                    }
                    else {
                        c = obj._prepare(node._data[key], keys[i], value[keys[i]], true, remote);
                        if (c)
                            changed = true;
                    }
                }
                else if (!obj._equals(node._data[key]._data[keys[i]], value[keys[i]])) {
                    if (typeof value[keys[i]] === 'object') {
                        c = obj.set(`${node._data[key]._path}.${keys[i]}`, value[keys[i]], true);
                        if (c)
                            changed = true;
                    }
                    else if (node._data[key]._data[keys[i]] !== value[keys[i]]) {
                        changed = true;
                        if (node._data[key]._keys.indexOf(keys[i]) === -1) {
                            node._data[key]._keys.push(keys[i]);
                        }
                        node._data[key]._data[keys[i]] = value[keys[i]];
                        state = obj.silence();
                        obj.emit(`${node._data[key]._path}.${keys[i]}:set`, node._data[key]._data[keys[i]], null, remote);
                        obj.emit('*:set', `${node._data[key]._path}.${keys[i]}`, node._data[key]._data[keys[i]], null, remote);
                        obj.silenceRestore(state);
                    }
                }
            }
            if (changed) {
                if (silent) {
                    state = obj.silence();
                }
                const val = obj.json(node._data[key]);
                obj.emit(`${node._data[key]._path}:set`, val, valueOld, remote);
                obj.emit('*:set', node._data[key]._path, val, valueOld, remote);
                if (silent) {
                    obj.silenceRestore(state);
                }
                return true;
            }
            return false;
        }
        let data;
        if (!node.hasOwnProperty('_data') && node.hasOwnProperty(key)) {
            data = node;
        }
        else {
            data = node._data;
        }
        if (data[key] === value && !force) {
            return false;
        }
        if (silent) {
            state = obj.silence();
        }
        valueOld = data[key];
        if (!(valueOld instanceof Observer)) {
            valueOld = obj.json(valueOld);
        }
        data[key] = value;
        obj.emit(`${path}:set`, value, valueOld, remote);
        obj.emit('*:set', path, value, valueOld, remote);
        if (silent) {
            obj.silenceRestore(state);
        }
        return true;
    }
    /**
     * Query whether the object has the specified property.
     *
     * @param path - Path to the value.
     * @returns Returns true if the value is present and false otherwise.
     */
    has(path) {
        const keys = Observer._splitPath(path);
        let node = this;
        for (let i = 0, len = keys.length; i < len; i++) {
            // eslint-disable-next-line eqeqeq
            if (node == undefined) {
                return undefined;
            }
            if (node._data) {
                node = node._data[keys[i]];
            }
            else {
                node = node[keys[i]];
            }
        }
        return node !== undefined;
    }
    /**
     * @param path - Path to the value.
     * @param raw - Retrieve the observer object without converting it to JSON.
     * @returns The value at the specified path.
     */
    get(path, raw = false) {
        const keys = Observer._splitPath(path);
        let node = this;
        for (let i = 0; i < keys.length; i++) {
            // eslint-disable-next-line eqeqeq
            if (node == undefined) {
                return undefined;
            }
            if (node._data) {
                node = node._data[keys[i]];
            }
            else {
                node = node[keys[i]];
            }
        }
        if (raw) {
            return node;
        }
        if (node == null) {
            return null;
        }
        return this.json(node);
    }
    getRaw(path) {
        return this.get(path, true);
    }
    _equals(a, b) {
        if (a === b) {
            return true;
        }
        else if (a instanceof Array && b instanceof Array && arrayEquals(a, b)) {
            return true;
        }
        return false;
    }
    /**
     * @param path - Path to the value.
     * @param silent - If true, the change will not be recorded in history.
     * @param remote - State value passed to the set event used to disable remote event emission.
     * @returns Returns true if the value was successfully unset and false otherwise.
     */
    unset(path, silent = false, remote = false) {
        let i;
        const keys = Observer._splitPath(path);
        const key = keys[keys.length - 1];
        let node = this;
        let obj = this;
        for (i = 0; i < keys.length - 1; i++) {
            if (node instanceof Array) {
                node = node[keys[i]];
                if (node instanceof Observer) {
                    path = keys.slice(i + 1).join('.');
                    obj = node;
                }
            }
            else {
                node = node._data[keys[i]];
            }
        }
        if (!node._data || !node._data.hasOwnProperty(key)) {
            return false;
        }
        let valueOld = node._data[key];
        if (!(valueOld instanceof Observer)) {
            valueOld = obj.json(valueOld);
        }
        // recursive
        if (node._data[key] && node._data[key]._data) {
            // do this in reverse order because node._data[key]._keys gets
            // modified as we loop
            for (i = node._data[key]._keys.length - 1; i >= 0; i--) {
                obj.unset(`${path}.${node._data[key]._keys[i]}`, true);
            }
        }
        node._keys.splice(node._keys.indexOf(key), 1);
        delete node._data[key];
        let state;
        if (silent) {
            state = obj.silence();
        }
        obj.emit(`${path}:unset`, valueOld, remote);
        obj.emit('*:unset', path, valueOld, remote);
        if (silent) {
            obj.silenceRestore(state);
        }
        return true;
    }
    /**
     * @param path - Path to the value.
     * @param ind - Index of the value.
     * @param silent - If true, the remove event will not be emitted.
     * @param remote - State value passed to the set event used to disable remote event emission.
     * @returns Returns true if the value was successfully removed and false otherwise.
     */
    remove(path, ind, silent = false, remote = false) {
        const keys = Observer._splitPath(path);
        const key = keys[keys.length - 1];
        let node = this;
        let obj = this;
        for (let i = 0; i < keys.length - 1; i++) {
            if (node instanceof Array) {
                node = node[parseInt(keys[i], 10)];
                if (node instanceof Observer) {
                    path = keys.slice(i + 1).join('.');
                    obj = node;
                }
            }
            else if (node._data && node._data.hasOwnProperty(keys[i])) {
                node = node._data[keys[i]];
            }
            else {
                return false;
            }
        }
        if (!node._data || !node._data.hasOwnProperty(key) || !(node._data[key] instanceof Array)) {
            return false;
        }
        const arr = node._data[key];
        if (arr.length < ind) {
            return false;
        }
        let value = arr[ind];
        if (value instanceof Observer) {
            value._parent = null;
        }
        else {
            value = obj.json(value);
        }
        arr.splice(ind, 1);
        let state;
        if (silent) {
            state = obj.silence();
        }
        obj.emit(`${path}:remove`, value, ind, remote);
        obj.emit('*:remove', path, value, ind, remote);
        if (silent) {
            obj.silenceRestore(state);
        }
        return true;
    }
    /**
     * @param path - Path to the value.
     * @param value - Value to remove.
     * @param silent - If true, the remove event will not be emitted.
     * @param remote - State value passed to the set event used to disable remote event emission.
     * @returns Returns true if the value was successfully removed and false otherwise.
     */
    removeValue(path, value, silent = false, remote = false) {
        const keys = Observer._splitPath(path);
        const key = keys[keys.length - 1];
        let node = this;
        let obj = this;
        for (let i = 0; i < keys.length - 1; i++) {
            if (node instanceof Array) {
                node = node[parseInt(keys[i], 10)];
                if (node instanceof Observer) {
                    path = keys.slice(i + 1).join('.');
                    obj = node;
                }
            }
            else if (node._data && node._data.hasOwnProperty(keys[i])) {
                node = node._data[keys[i]];
            }
            else {
                return;
            }
        }
        if (!node._data || !node._data.hasOwnProperty(key) || !(node._data[key] instanceof Array)) {
            return;
        }
        const arr = node._data[key];
        const ind = arr.indexOf(value);
        if (ind === -1) {
            return;
        }
        if (arr.length < ind) {
            return;
        }
        value = arr[ind];
        if (value instanceof Observer) {
            value._parent = null;
        }
        else {
            value = obj.json(value);
        }
        arr.splice(ind, 1);
        let state;
        if (silent) {
            state = obj.silence();
        }
        obj.emit(`${path}:remove`, value, ind, remote);
        obj.emit('*:remove', path, value, ind, remote);
        if (silent) {
            obj.silenceRestore(state);
        }
        return true;
    }
    /**
     * @param path - Path to the value.
     * @param value - Value to insert.
     * @param ind - Index to insert the value at.
     * @param silent - If true, the insert event will not be emitted.
     * @param remote - State value passed to the set event used to disable remote event emission.
     * @returns Returns true if the value was successfully inserted and false otherwise.
     */
    insert(path, value, ind, silent = false, remote = false) {
        const keys = Observer._splitPath(path);
        const key = keys[keys.length - 1];
        let node = this;
        let obj = this;
        for (let i = 0; i < keys.length - 1; i++) {
            if (node instanceof Array) {
                node = node[parseInt(keys[i], 10)];
                if (node instanceof Observer) {
                    path = keys.slice(i + 1).join('.');
                    obj = node;
                }
            }
            else if (node._data && node._data.hasOwnProperty(keys[i])) {
                node = node._data[keys[i]];
            }
            else {
                return;
            }
        }
        if (!node._data || !node._data.hasOwnProperty(key) || !(node._data[key] instanceof Array)) {
            return;
        }
        const arr = node._data[key];
        value = obj._doInsert(node, key, value, ind);
        if (ind === undefined) {
            ind = arr.length - 1;
        }
        let state;
        if (silent) {
            state = obj.silence();
        }
        obj.emit(`${path}:insert`, value, ind, remote);
        obj.emit('*:insert', path, value, ind, remote);
        if (silent) {
            obj.silenceRestore(state);
        }
        return true;
    }
    _doInsert(node, key, value, ind, allowDuplicates = false) {
        const arr = node._data[key];
        if (typeof value === 'object' && !(value instanceof Observer) && value !== null) {
            if (value instanceof Array) {
                value = value.slice(0);
            }
            else {
                value = new Observer(value);
            }
        }
        const path = node._path ? `${node._path}.${key}` : key;
        if (value !== null && !allowDuplicates && (!this._pathsWithDuplicates || !this._pathsWithDuplicates[path])) {
            if (arr.indexOf(value) !== -1) {
                return;
            }
        }
        if (ind === undefined) {
            arr.push(value);
        }
        else {
            arr.splice(ind, 0, value);
        }
        if (value instanceof Observer) {
            value._parent = this;
            value._parentPath = path;
            value._parentField = arr;
            value._parentKey = null;
        }
        else {
            value = this.json(value);
        }
        return value;
    }
    /**
     * @param path - Path to the value.
     * @param indOld - Index of the value to move.
     * @param indNew - Index to move the value to.
     * @param silent - If true, the move event will not be emitted.
     * @param remote - State value passed to the set event used to disable remote event emission.
     * @returns Returns true if the value was successfully moved and false otherwise.
     */
    move(path, indOld, indNew, silent = false, remote = false) {
        const keys = Observer._splitPath(path);
        const key = keys[keys.length - 1];
        let node = this;
        let obj = this;
        for (let i = 0; i < keys.length - 1; i++) {
            if (node instanceof Array) {
                node = node[parseInt(keys[i], 10)];
                if (node instanceof Observer) {
                    path = keys.slice(i + 1).join('.');
                    obj = node;
                }
            }
            else if (node._data && node._data.hasOwnProperty(keys[i])) {
                node = node._data[keys[i]];
            }
            else {
                return;
            }
        }
        if (!node._data || !node._data.hasOwnProperty(key) || !(node._data[key] instanceof Array)) {
            return;
        }
        const arr = node._data[key];
        if (arr.length < indOld || arr.length < indNew || indOld === indNew) {
            return;
        }
        let value = arr[indOld];
        arr.splice(indOld, 1);
        if (indNew === -1) {
            indNew = arr.length;
        }
        arr.splice(indNew, 0, value);
        if (!(value instanceof Observer)) {
            value = obj.json(value);
        }
        let state;
        if (silent) {
            state = obj.silence();
        }
        obj.emit(`${path}:move`, value, indNew, indOld, remote);
        obj.emit('*:move', path, value, indNew, indOld, remote);
        if (silent) {
            obj.silenceRestore(state);
        }
        return true;
    }
    patch(data, removeMissingKeys = false) {
        if (typeof data !== 'object') {
            return;
        }
        for (const key in data) {
            if (typeof data[key] === 'object' && !this._data.hasOwnProperty(key)) {
                this._prepare(this, key, data[key]);
            }
            else if (this._data[key] !== data[key]) {
                this.set(key, data[key]);
            }
        }
        if (removeMissingKeys) {
            for (const key in this._data) {
                if (!data.hasOwnProperty(key)) {
                    this.unset(key);
                }
            }
        }
    }
    /**
     * @param target - The object to JSONify.
     * @returns The current state of the object tracked by the observer.
     */
    json(target) {
        let key, n;
        let obj = {};
        const node = target === undefined ? this : target;
        let len, nlen;
        if (node instanceof Object && node._keys) {
            len = node._keys.length;
            for (let i = 0; i < len; i++) {
                key = node._keys[i];
                const value = node._data[key];
                const type = typeof value;
                if (type === 'object' && (value instanceof Array)) {
                    obj[key] = value.slice(0);
                    nlen = obj[key].length;
                    for (n = 0; n < nlen; n++) {
                        if (typeof obj[key][n] === 'object') {
                            obj[key][n] = this.json(obj[key][n]);
                        }
                    }
                }
                else if (type === 'object' && (value instanceof Object)) {
                    obj[key] = this.json(value);
                }
                else {
                    obj[key] = value;
                }
            }
        }
        else {
            if (node === null) {
                return null;
            }
            else if (typeof node === 'object' && (node instanceof Array)) {
                obj = node.slice(0);
                len = obj.length;
                for (n = 0; n < len; n++) {
                    obj[n] = this.json(obj[n]);
                }
            }
            else if (typeof node === 'object') {
                for (key in node) {
                    if (node.hasOwnProperty(key)) {
                        obj[key] = node[key];
                    }
                }
            }
            else {
                obj = node;
            }
        }
        return obj;
    }
    forEach(fn, target, path = '') {
        const node = target || this;
        for (let i = 0; i < node._keys.length; i++) {
            const key = node._keys[i];
            const value = node._data[key];
            const type = (this.schema && this.schema.has(path + key) && this.schema.get(path + key).type.name.toLowerCase()) || typeof value;
            if (type === 'object' && (value instanceof Array)) {
                fn(path + key, 'array', value, key);
            }
            else if (type === 'object' && (value instanceof Object)) {
                fn(path + key, 'object', value, key);
                this.forEach(fn, value, `${path + key}.`);
            }
            else {
                fn(path + key, type, value, key);
            }
        }
    }
    /**
     * Returns the latest observer instance. This is important when
     * dealing with undo / redo where the observer might have been deleted
     * and/or possibly re-created.
     *
     * @returns The latest instance of the observer.
     */
    latest() {
        return this._latestFn ? this._latestFn() : this;
    }
    /**
     * Destroys the observer instance.
     */
    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        this.emit('destroy');
        this.unbind();
    }
    set latestFn(value) {
        this._latestFn = value;
    }
    get latestFn() {
        return this._latestFn;
    }
}
// cache calls to path.split(path, '.')
// as they take considerable time especially during loading
// if there are a lot of observers like entities, assets etc.
Observer._splitPathsCache = {};

/**
 * The ObserverHistory module provides a mechanism for tracking changes to an Observer object and
 * storing them in a history stack.
 */
class ObserverHistory extends Events {
    /**
     * @param args - Arguments
     */
    constructor(args = {}) {
        super();
        this._enabled = true;
        this._prefix = '';
        this._combine = false;
        this._selfEvents = [];
        this.item = args.item;
        this._history = args.history;
        this._enabled = args.enabled || true;
        this._prefix = args.prefix || '';
        this._combine = args.combine || false;
        this._initialize();
    }
    _initialize() {
        this._selfEvents.push(this.item.on('*:set', (path, value, valueOld) => {
            if (!this._enabled || !this._history)
                return;
            // need jsonify
            if (value instanceof Observer) {
                value = value.json();
            }
            // action
            const action = {
                name: this._prefix + path,
                combine: this._combine,
                undo: () => {
                    const item = this.item.latest();
                    if (!item)
                        return;
                    item.history.enabled = false;
                    if (valueOld === undefined) {
                        item.unset(path);
                    }
                    else {
                        item.set(path, valueOld);
                    }
                    item.history.enabled = true;
                },
                redo: () => {
                    const item = this.item.latest();
                    if (!item)
                        return;
                    item.history.enabled = false;
                    if (value === undefined) {
                        item.unset(path);
                    }
                    else {
                        item.set(path, value);
                    }
                    item.history.enabled = true;
                }
            };
            this._history.add(action);
        }));
        this._selfEvents.push(this.item.on('*:unset', (path, valueOld) => {
            if (!this._enabled || !this._history)
                return;
            // action
            const action = {
                name: this._prefix + path,
                combine: this._combine,
                undo: () => {
                    const item = this.item.latest();
                    if (!item)
                        return;
                    item.history.enabled = false;
                    item.set(path, valueOld);
                    item.history.enabled = true;
                },
                redo: () => {
                    const item = this.item.latest();
                    if (!item)
                        return;
                    item.history.enabled = false;
                    item.unset(path);
                    item.history.enabled = true;
                }
            };
            this._history.add(action);
        }));
        this._selfEvents.push(this.item.on('*:insert', (path, value, ind) => {
            if (!this._enabled || !this._history)
                return;
            // need jsonify
            // if (value instanceof Observer)
            //     value = value.json();
            // action
            const action = {
                name: this._prefix + path,
                combine: this._combine,
                undo: () => {
                    const item = this.item.latest();
                    if (!item)
                        return;
                    item.history.enabled = false;
                    item.removeValue(path, value);
                    item.history.enabled = true;
                },
                redo: () => {
                    const item = this.item.latest();
                    if (!item)
                        return;
                    item.history.enabled = false;
                    item.insert(path, value, ind);
                    item.history.enabled = true;
                }
            };
            this._history.add(action);
        }));
        this._selfEvents.push(this.item.on('*:remove', (path, value, ind) => {
            if (!this._enabled || !this._history)
                return;
            // need jsonify
            // if (value instanceof Observer)
            //     value = value.json();
            // action
            const action = {
                name: this._prefix + path,
                combine: this._combine,
                undo: () => {
                    const item = this.item.latest();
                    if (!item)
                        return;
                    item.history.enabled = false;
                    item.insert(path, value, ind);
                    item.history.enabled = true;
                },
                redo: () => {
                    const item = this.item.latest();
                    if (!item)
                        return;
                    item.history.enabled = false;
                    item.removeValue(path, value);
                    item.history.enabled = true;
                }
            };
            this._history.add(action);
        }));
        this._selfEvents.push(this.item.on('*:move', (path, value, ind, indOld) => {
            if (!this._enabled || !this._history)
                return;
            // action
            const action = {
                name: this._prefix + path,
                combine: this._combine,
                undo: () => {
                    const item = this.item.latest();
                    if (!item)
                        return;
                    item.history.enabled = false;
                    item.move(path, ind, indOld);
                    item.history.enabled = true;
                },
                redo: () => {
                    const item = this.item.latest();
                    if (!item)
                        return;
                    item.history.enabled = false;
                    item.move(path, indOld, ind);
                    item.history.enabled = true;
                }
            };
            this._history.add(action);
        }));
    }
    destroy() {
        this._selfEvents.forEach((evt) => {
            evt.unbind();
        });
        this._selfEvents.length = 0;
        this.item = null;
    }
    set enabled(value) {
        this._enabled = !!value;
    }
    get enabled() {
        return this._enabled;
    }
    set prefix(value) {
        this._prefix = value || '';
    }
    get prefix() {
        return this._prefix;
    }
    set combine(value) {
        this._combine = !!value;
    }
    get combine() {
        return this._combine;
    }
}

/**
 * The ObserverList class is a list of Observer objects.
 */
class ObserverList extends Events {
    /**
     * @param options.sorted - Sorted
     * @param options.index - Index
     */
    constructor(options = {}) {
        super();
        this.data = [];
        this._indexed = {};
        this.sorted = null;
        this.index = null;
        this.sorted = options.sorted || null;
        this.index = options.index || null;
    }
    get length() {
        return this.data.length;
    }
    get(index) {
        if (this.index) {
            return this._indexed[index] || null;
        }
        return this.data[index] || null;
    }
    set(index, value) {
        if (this.index) {
            this._indexed[index] = value;
        }
        else {
            this.data[index] = value;
        }
    }
    indexOf(item) {
        if (this.index) {
            const index = (item instanceof Observer && item.get(this.index)) || item[this.index];
            return (this._indexed[index] && index) || null;
        }
        const ind = this.data.indexOf(item);
        return ind !== -1 ? ind : null;
    }
    position(b, fn) {
        const l = this.data;
        let min = 0;
        let max = l.length - 1;
        let cur;
        let a, i;
        fn = fn || this.sorted;
        while (min <= max) {
            cur = Math.floor((min + max) / 2);
            a = l[cur];
            i = fn(a, b);
            if (i === 1) {
                max = cur - 1;
            }
            else if (i === -1) {
                min = cur + 1;
            }
            else {
                return cur;
            }
        }
        return -1;
    }
    positionNextClosest(b, fn) {
        const l = this.data;
        let min = 0;
        let max = l.length - 1;
        let cur;
        let a, i;
        fn = fn || this.sorted;
        if (l.length === 0) {
            return -1;
        }
        if (fn(l[0], b) === 0) {
            return 0;
        }
        while (min <= max) {
            cur = Math.floor((min + max) / 2);
            a = l[cur];
            i = fn(a, b);
            if (i === 1) {
                max = cur - 1;
            }
            else if (i === -1) {
                min = cur + 1;
            }
            else {
                return cur;
            }
        }
        if (fn(a, b) === 1) {
            return cur;
        }
        if ((cur + 1) === l.length) {
            return -1;
        }
        return cur + 1;
    }
    has(item) {
        if (this.index) {
            const index = (item instanceof Observer && item.get(this.index)) || item[this.index];
            return !!this._indexed[index];
        }
        return this.data.indexOf(item) !== -1;
    }
    add(item) {
        if (this.has(item)) {
            return null;
        }
        let index = this.data.length;
        if (this.index) {
            index = (item instanceof Observer && item.get(this.index)) || item[this.index];
            this._indexed[index] = item;
        }
        let pos = 0;
        if (this.sorted) {
            pos = this.positionNextClosest(item, undefined);
            if (pos !== -1) {
                this.data.splice(pos, 0, item);
            }
            else {
                this.data.push(item);
            }
        }
        else {
            this.data.push(item);
            pos = this.data.length - 1;
        }
        this.emit('add', item, index, pos);
        if (this.index) {
            const id = item.get(this.index);
            if (id) {
                this.emit(`add[${id}]`, item, index, pos);
            }
        }
        return pos;
    }
    move(item, pos) {
        const ind = this.data.indexOf(item);
        this.data.splice(ind, 1);
        if (pos === -1) {
            this.data.push(item);
        }
        else {
            this.data.splice(pos, 0, item);
        }
        this.emit('move', item, pos);
    }
    remove(item) {
        if (!this.has(item)) {
            return;
        }
        const ind = this.data.indexOf(item);
        let index = ind;
        if (this.index) {
            index = (item instanceof Observer && item.get(this.index)) || item[this.index];
            delete this._indexed[index];
        }
        this.data.splice(ind, 1);
        this.emit('remove', item, index);
    }
    removeByKey(index) {
        let item;
        if (this.index) {
            item = this._indexed[index];
            if (!item) {
                return;
            }
            const ind = this.data.indexOf(item);
            this.data.splice(ind, 1);
            delete this._indexed[index];
            this.emit('remove', item, ind);
        }
        else {
            if (this.data.length < index) {
                return;
            }
            item = this.data[index];
            this.data.splice(index, 1);
            this.emit('remove', item, index);
        }
    }
    removeBy(fn) {
        let i = this.data.length;
        while (i--) {
            if (!fn(this.data[i])) {
                continue;
            }
            if (this.index) {
                delete this._indexed[this.data[i][this.index]];
            }
            this.data.splice(i, 1);
            this.emit('remove', this.data[i], i);
        }
    }
    clear() {
        const items = this.data.slice(0);
        this.data = [];
        this._indexed = {};
        let i = items.length;
        while (i--) {
            this.emit('remove', items[i], i);
        }
    }
    forEach(fn) {
        for (let i = 0; i < this.data.length; i++) {
            fn(this.data[i], (this.index && this.data[i][this.index]) || i);
        }
    }
    find(fn) {
        const items = [];
        for (let i = 0; i < this.data.length; i++) {
            if (!fn(this.data[i])) {
                continue;
            }
            let index = i;
            if (this.index) {
                index = this.data[i][this.index];
            }
            items.push([index, this.data[i]]);
        }
        return items;
    }
    findOne(fn) {
        for (let i = 0; i < this.data.length; i++) {
            if (!fn(this.data[i])) {
                continue;
            }
            let index = i;
            if (this.index) {
                index = this.data[i][this.index];
            }
            return [index, this.data[i]];
        }
        return null;
    }
    map(fn) {
        return this.data.map(fn);
    }
    sort(fn) {
        this.data.sort(fn);
    }
    array() {
        return this.data.slice(0);
    }
    json() {
        const items = this.array();
        for (let i = 0; i < items.length; i++) {
            if (items[i] instanceof Observer) {
                items[i] = items[i].json();
            }
        }
        return items;
    }
}

export { EventHandle, Events, History, Observer, ObserverHistory, ObserverList };
