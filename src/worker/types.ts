export interface Env {
  rooms: DurableObjectNamespace;
}

export interface ChatRoomSession {
  name?: string;
  quit?: boolean;
  webSocket: WebSocket;
  blockedMessages: string[];
}
