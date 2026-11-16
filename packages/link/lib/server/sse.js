/** Server-Sent Events: writing them, and an incremental parser both Node and the page use. No Node imports. */
/** Feeds text chunks, calls back per complete event. */
export class SseParser {
    onEvent;
    buffer = '';
    event = '';
    data = [];
    constructor(onEvent) {
        this.onEvent = onEvent;
    }
    push(chunk) {
        this.buffer += chunk;
        let newline;
        while ((newline = this.buffer.search(/\r\n|\r|\n/)) >= 0) {
            const line = this.buffer.slice(0, newline);
            this.buffer = this.buffer.slice(newline + (this.buffer.startsWith('\r\n', newline) ? 2 : 1));
            this.line(line);
        }
    }
    line(line) {
        if (line === '') {
            if (this.data.length > 0)
                this.onEvent({ event: this.event || 'message', data: this.data.join('\n') });
            this.event = '';
            this.data = [];
            return;
        }
        if (line.startsWith(':'))
            return;
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? '' : line.slice(colon + 1);
        if (value.startsWith(' '))
            value = value.slice(1);
        if (field === 'event')
            this.event = value;
        else if (field === 'data')
            this.data.push(value);
    }
}
/** One event in the wire format. */
export const sseFrame = (event, value) => `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
