/**
 * Controller state machine — deterministic, no network.
 * Reuses v1.1 terminology but with explicit transitions and epoch fences.
 *
 * OFFLINE (no instance)
 *   -> PROVISIONING -> BOOTSTRAPPING -> CONNECTING -> READY
 * STOPPED -> STARTING -> BOOTSTRAPPING -> CONNECTING -> READY
 * READY -> BUSY -> IDLE -> STOPPING -> STOPPED
 * IDLE + admitted work -> BUSY
 * STOPPED --explicit destroy--> DESTROYING -> OFFLINE
 * Any uncertain action -> UNKNOWN -> RECONCILE
 */

export type RuntimeState =
  | "offline"
  | "provisioning"
  | "bootstrapping"
  | "connecting"
  | "ready"
  | "busy"
  | "idle"
  | "stopping"
  | "stopped"
  | "destroying"
  | "unknown";

const TRANSITIONS: Record<RuntimeState, RuntimeState[]> = {
  offline: ["provisioning", "starting"],
  provisioning: ["bootstrapping", "unknown"],
  bootstrapping: ["connecting", "unknown"],
  connecting: ["ready", "unknown"],
  ready: ["busy", "idle", "stopping"],
  busy: ["ready", "idle", "stopping"],
  idle: ["busy", "stopping", "destroying"],
  stopping: ["stopped", "unknown"],
  stopped: ["starting", "destroying"],
  destroying: ["offline", "unknown"],
  unknown: ["bootstrapping", "stopped", "stopping", "offline"],
};

export class IllegalTransitionError extends Error {
  constructor(from: RuntimeState, to: RuntimeState) {
    super(`illegal transition ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export class StateMachine {
  private _state: RuntimeState;
  readonly epoch: number;

  constructor(initial: RuntimeState = "offline", epoch = 1) {
    this._state = initial;
    this.epoch = epoch;
  }

  get state(): RuntimeState {
    return this._state;
  }

  assert(to: RuntimeState): RuntimeState {
    if (!TRANSITIONS[this._state].includes(to)) {
      throw new IllegalTransitionError(this._state, to);
    }
    this._state = to;
    return this._state;
  }

  reconcile(to: RuntimeState): RuntimeState {
    if (!TRANSITIONS[this._state].includes(to) && !TRANSITIONS.unknown.includes(to)) {
      throw new IllegalTransitionError(this._state, to);
    }
    this._state = to;
    return this._state;
  }
}
