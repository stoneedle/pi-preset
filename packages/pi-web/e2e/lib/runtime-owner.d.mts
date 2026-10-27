export type FixtureState = Record<string, unknown> & { state: string };
export function openFixtureOwner(options: {
  agentDir: string;
  sessionPath: string;
  getState?: () => FixtureState;
  control?: (input: Record<string, any>) => unknown | Promise<unknown>;
}): Promise<{
  publish(): void;
  snapshot(): Record<string, unknown>;
  close(): Promise<void>;
}>;
