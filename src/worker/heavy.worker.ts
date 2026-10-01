// The work that can take a while off the main thread: ordering many strokes (spec §9).
import { handle, type Request } from './protocol.ts';

const scope = self as unknown as { onmessage: ((e: MessageEvent<Request>) => void) | null; postMessage(message: unknown): void };
scope.onmessage = e => scope.postMessage(handle(e.data));
