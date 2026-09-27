export class ClaudeSteering {
  steer(
    text: string,
    interrupt: () => Promise<unknown>,
    prompt: (text: string) => Promise<unknown>,
  ): Promise<void>;
  result(): boolean;
}
