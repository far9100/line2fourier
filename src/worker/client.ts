// The page's side of the worker. Without a worker (a browser that refuses module workers), or if
// it fails, the same handler runs on the main thread: slower, but the same result.
import type { Stroke } from '../core/path.ts';
import type { Tour, TourOptions } from '../core/tour.ts';
import { handle, pack, type Request, type Response } from './protocol.ts';

export interface WorkerClient { tour(strokes: Stroke[], opts?: TourOptions): Promise<Tour> }

export function createWorkerClient(): WorkerClient {
  let worker: Worker | null | undefined;
  let nextId = 1;
  // Requests are copied to the worker, not transferred, so they can be answered here if it fails.
  const pending = new Map<number, { req: Request; resolve: (r: Response) => void }>();

  const fail = () => {
    worker = null;
    for (const { req, resolve } of pending.values()) resolve(handle(req));
    pending.clear();
  };

  const get = (): Worker | null => {
    if (worker !== undefined) return worker;
    try {
      worker = new Worker(new URL('./heavy.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (e: MessageEvent<Response>) => {
        const p = pending.get(e.data.id);
        pending.delete(e.data.id);
        p?.resolve(e.data);
      };
      worker.onerror = fail;
    } catch {
      worker = null;
    }
    return worker;
  };

  const call = (req: Request): Promise<Response> => {
    const w = get();
    if (!w) return Promise.resolve(handle(req));
    return new Promise(resolve => {
      pending.set(req.id, { req, resolve });
      w.postMessage(req);
    });
  };

  return {
    async tour(strokes, opts) {
      const res = await call({ id: nextId++, type: 'tour', strokes: pack(strokes), opts });
      if (!res.ok) throw new Error(res.error);
      return res.tour;
    },
  };
}
