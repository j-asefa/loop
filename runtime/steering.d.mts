export class SteeringControls {
  constructor(
    write: (message: { action: string; id: string; text: string }) => void,
  );
  send(id: string, text: string): Promise<{ accepted: boolean }>;
  receive(receipt: { id: string; accepted: boolean }): void;
  close(): void;
}
