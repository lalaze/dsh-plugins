/** Server-Sent Events: writing them, and an incremental parser both Node and the page use. No Node imports. */

export interface SseEvent { event: string; data: string }

/** Feeds text chunks, calls back per complete event. */
export class SseParser {
  private buffer = '';
  private event = '';
  private data: string[] = [];
  constructor(private readonly onEvent: (event: SseEvent) => void) {}

  push(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.search(/\r\n|\r|\n/)) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + (this.buffer.startsWith('\r\n', newline) ? 2 : 1));
      this.line(line);
    }
  }

  private line(line: string): void {
    if (line === '') {
      if (this.data.length > 0) this.onEvent({ event: this.event || 'message', data: this.data.join('\n') });
      this.event = ''; this.data = [];
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.event = value;
    else if (field === 'data') this.data.push(value);
  }
}

/** One event in the wire format. */
export const sseFrame = (event: string, value: unknown) => `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
