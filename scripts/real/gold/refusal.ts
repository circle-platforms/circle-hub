/** A refusal the CLI catches by type: the line is decided where it is thrown, never re-parsed from the message. */
export class GoldRefusal extends Error {
  readonly line: string;
  constructor(line: string) {
    super(line);
    this.name = 'GoldRefusal';
    this.line = line;
  }
}
