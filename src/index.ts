import { workerFetch } from './fetch';
import { Env } from './types';

export { ChatRoom } from './chat-room';
export default {
  fetch: workerFetch,
} as ExportedHandler<Env>;
