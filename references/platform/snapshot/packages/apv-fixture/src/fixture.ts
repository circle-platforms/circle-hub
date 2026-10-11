/**
 * The simulated APV device, implementing SMP-V02-01 exactly: logical
 * command set, session/config state machine, monotonic config versions,
 * and the five injection points INJ-APV-1..5. Everything is in-memory
 * and deterministic; nothing here talks to a real device.
 */
export interface DeviceIdentity {
  model: string;
  serial: string;
  firmware: string;
}

export type FixtureState = "no-session" | "in-session" | "staged" | "committed";

export type FixtureErrorCode =
  | "NO_SESSION"
  | "SESSION_ACTIVE"
  | "VERSION_CONFLICT"
  | "NO_STAGED_CHANGE"
  | "STAGE_MISMATCH";

export interface Receipt {
  ok: boolean;
  errorCode?: FixtureErrorCode;
  message?: string;
  /** Simulated response latency, consumed by the driver's timeout logic. */
  delayMs: number;
  identity: DeviceIdentity;
  sessionId?: string;
  value?: string;
  configVersion?: number;
  stageId?: string;
}

export type InjectionId = "INJ-APV-1" | "INJ-APV-2" | "INJ-APV-3" | "INJ-APV-5";

const BASE_IDENTITY: DeviceIdentity = {
  model: "APV-EMU-9000",
  serial: "EMU-SN-0001",
  firmware: "fw-emu-1.0",
};
const DRIFTED_SERIAL = "EMU-SN-9999-DRIFTED";
export const SLOW_RESPONSE_MS = 30_000;

interface StagedChange {
  stageId: string;
  object: string;
  value: string;
  baseVersion: number;
}

export class ApvFixture {
  #state: FixtureState = "no-session";
  #sessionSeq = 0;
  #sessionId: string | undefined;
  #config = new Map<string, string>([["vs.web", "profile=baseline"]]);
  #history = new Map<number, Map<string, string>>();
  #configVersion = 1;
  #staged: StagedChange | undefined;
  #stageSeq = 0;
  /** Number of commits actually applied on the device side. */
  changeCount = 0;
  #injections = new Set<InjectionId>();

  constructor() {
    this.#history.set(1, new Map(this.#config));
  }

  get state(): FixtureState {
    return this.#state;
  }
  get configVersion(): number {
    return this.#configVersion;
  }
  get activeSessionId(): string | undefined {
    return this.#sessionId;
  }
  get hasStagedChange(): boolean {
    return this.#staged !== undefined;
  }

  arm(injection: InjectionId): void {
    this.#injections.add(injection);
  }
  disarm(injection: InjectionId): void {
    this.#injections.delete(injection);
  }

  #identity(): DeviceIdentity {
    return this.#injections.has("INJ-APV-3")
      ? { ...BASE_IDENTITY, serial: DRIFTED_SERIAL }
      : { ...BASE_IDENTITY };
  }

  #delay(): number {
    return this.#injections.has("INJ-APV-5") ? SLOW_RESPONSE_MS : 0;
  }

  #receipt(partial: Partial<Receipt>): Receipt {
    return {
      ok: true,
      delayMs: this.#delay(),
      identity: this.#identity(),
      ...partial,
    };
  }

  #error(errorCode: FixtureErrorCode, message: string): Receipt {
    return {
      ok: false,
      errorCode,
      message,
      delayMs: this.#delay(),
      identity: this.#identity(),
    };
  }

  #requireSession(): Receipt | undefined {
    if (!this.#sessionId) {
      return this.#error("NO_SESSION", "no active management session");
    }
    return undefined;
  }

  open(): Receipt {
    if (this.#sessionId) {
      return this.#error("SESSION_ACTIVE", "a session is already open");
    }
    this.#sessionSeq += 1;
    this.#sessionId = `sess_${String(this.#sessionSeq).padStart(4, "0")}`;
    this.#state = "in-session";
    return this.#receipt({
      sessionId: this.#sessionId,
      configVersion: this.#configVersion,
    });
  }

  read(object: string): Receipt {
    const noSession = this.#requireSession();
    if (noSession) return noSession;
    return this.#receipt({
      value: this.#config.get(object),
      configVersion: this.#configVersion,
    });
  }

  stage(object: string, value: string, baseVersion: number): Receipt {
    const noSession = this.#requireSession();
    if (noSession) return noSession;
    if (baseVersion !== this.#configVersion) {
      return this.#error(
        "VERSION_CONFLICT",
        `staged against config version ${baseVersion}, current is ${this.#configVersion}`,
      );
    }
    this.#stageSeq += 1;
    this.#staged = {
      stageId: `stage_${String(this.#stageSeq).padStart(4, "0")}`,
      object,
      value,
      baseVersion,
    };
    this.#state = "staged";
    return this.#receipt({ stageId: this.#staged.stageId, configVersion: this.#configVersion });
  }

  /**
   * Commit outcome markers: a normal receipt, `receiptLost` (INJ-APV-1:
   * applied, receipt never arrives), or `disconnected` (INJ-APV-2: the
   * connection drops mid-commit and, in this fixture's deterministic
   * model, the change is NOT applied — the caller cannot know that).
   */
  commit(stageId: string): Receipt & { receiptLost?: boolean; disconnected?: boolean } {
    const noSession = this.#requireSession();
    if (noSession) return noSession;
    if (!this.#staged) return this.#error("NO_STAGED_CHANGE", "nothing is staged");
    if (this.#staged.stageId !== stageId) {
      return this.#error("STAGE_MISMATCH", "stageId does not match the staged change");
    }
    if (this.#injections.has("INJ-APV-2")) {
      this.#injections.delete("INJ-APV-2");
      return { ...this.#receipt({}), disconnected: true };
    }
    const staged = this.#staged;
    this.#config.set(staged.object, staged.value);
    this.#configVersion += 1;
    this.#history.set(this.#configVersion, new Map(this.#config));
    this.#staged = undefined;
    this.#state = "committed";
    this.changeCount += 1;
    if (this.#injections.has("INJ-APV-1")) {
      this.#injections.delete("INJ-APV-1");
      return { ...this.#receipt({ configVersion: this.#configVersion }), receiptLost: true };
    }
    return this.#receipt({ configVersion: this.#configVersion });
  }

  rollback(toVersion: number): Receipt {
    const noSession = this.#requireSession();
    if (noSession) return noSession;
    const target = this.#history.get(toVersion);
    if (!target) {
      return this.#error("VERSION_CONFLICT", `no config history at version ${toVersion}`);
    }
    this.#config = new Map(target);
    this.#configVersion += 1; // versions stay monotonic across rollback
    this.#history.set(this.#configVersion, new Map(this.#config));
    this.#staged = undefined;
    this.#state = "committed";
    this.changeCount += 1;
    return this.#receipt({ configVersion: this.#configVersion });
  }

  close(): Receipt {
    const noSession = this.#requireSession();
    if (noSession) return noSession;
    this.#sessionId = undefined;
    this.#staged = undefined;
    this.#state = "no-session";
    return this.#receipt({});
  }

  /** Test-side external actor: advances the config outside any session flow. */
  externalAdvance(object: string, value: string): void {
    this.#config.set(object, value);
    this.#configVersion += 1;
    this.#history.set(this.#configVersion, new Map(this.#config));
  }

  /** Identity as the device currently reports it (drift-aware). */
  reportedIdentity(): DeviceIdentity {
    return this.#identity();
  }

  /** Deep snapshot for cleanup assertions. */
  snapshotState(): {
    config: Record<string, string>;
    configVersion: number;
    state: FixtureState;
    sessionActive: boolean;
    staged: boolean;
  } {
    return {
      config: Object.fromEntries(this.#config),
      configVersion: this.#configVersion,
      state: this.#state,
      sessionActive: this.#sessionId !== undefined,
      staged: this.#staged !== undefined,
    };
  }
}
