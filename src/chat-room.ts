import { ChatRoomSession, Env } from './types';
import { handleErrors } from './utils/handle-errors';

// ChatRoom implements a Durable Object that coordinates an individual chat room. Participants
// connect to the room using WebSockets, and the room broadcasts messages from each participant
// to all others.
export class ChatRoom implements DurableObject {
  storage: DurableObjectStorage;
  env: Env;

  sessions = [] as ChatRoomSession[];
  lastTimestamp = 0;

  constructor(controller: DurableObjectState, env: Env) {
    this.storage = controller.storage;
    this.env = env;
  }

  async fetch(request: Request) {
    return await handleErrors(request, async () => {
      let url = new URL(request.url);

      switch (url.pathname) {
        case '/websocket': {
          if (request.headers.get('Upgrade') != 'websocket') {
            return new Response('expected websocket', { status: 400 });
          }

          const pair = new WebSocketPair();
          await this.handleSession(pair[1]);
          return new Response(null, { status: 101, webSocket: pair[0] });
        }
        default:
          return new Response('Not found', { status: 404 });
      }
    });
  }

  async handleSession(webSocket: WebSocket) {
    webSocket.accept();

    const session: ChatRoomSession = { webSocket, blockedMessages: [] };
    this.sessions.push(session);

    this.sessions.forEach((otherSession) => {
      if (otherSession.name) {
        session.blockedMessages.push(
          JSON.stringify({ joined: otherSession.name })
        );
      }
    });

    const storage = await this.storage.list<string>({
      reverse: true,
      limit: 100,
    });

    const backlog = [...storage.values()];
    backlog.reverse();
    backlog.forEach((value) => {
      session.blockedMessages.push(value);
    });

    let receivedUserInfo = false;
    webSocket.addEventListener('message', async (msg) => {
      try {
        if (session.quit) {
          // Whoops, when trying to send to this WebSocket in the past, it threw an exception and
          // we marked it broken. But somehow we got another message? I guess try sending a
          // close(), which might throw, in which case we'll try to send an error, which will also
          // throw, and whatever, at least we won't accept the message. (This probably can't
          // actually happen. This is defensive coding.)
          webSocket.close(1011, 'WebSocket broken.');
          return;
        }

        // Argument of type 'string | ArrayBuffer' is not assignable to parameter of type 'string'.
        // @ts-expect-error
        let data = JSON.parse(msg.data);

        if (!receivedUserInfo) {
          // The first message the client sends is the user info message with their name. Save it
          // into their session object.
          session.name = '' + (data.name || 'anonymous');

          // Don't let people use ridiculously long names. (This is also enforced on the client,
          // so if they get here they are not using the intended client.)
          if (session.name.length > 32) {
            webSocket.send(JSON.stringify({ error: 'Name too long.' }));
            webSocket.close(1009, 'Name too long.');
            return;
          }

          // Deliver all the messages we queued up since the user connected.
          session.blockedMessages.forEach((queued) => {
            webSocket.send(queued);
          });
          session.blockedMessages.splice(0, session.blockedMessages.length);

          this.broadcast({ joined: session.name });
          webSocket.send(JSON.stringify({ ready: true }));
          receivedUserInfo = true;

          return;
        }

        data = { name: session.name, message: '' + data.message };
        if (data.message.length > 256) {
          webSocket.send(JSON.stringify({ error: 'Message too long.' }));
          return;
        }

        // Add timestamp. Here's where this.lastTimestamp comes in -- if we receive a bunch of
        // messages at the same time (or if the clock somehow goes backwards????), we'll assign
        // them sequential timestamps, so at least the ordering is maintained.
        data.timestamp = Math.max(Date.now(), this.lastTimestamp + 1);
        this.lastTimestamp = data.timestamp;

        let dataStr = JSON.stringify(data);
        this.broadcast(dataStr);

        let key = new Date(data.timestamp).toISOString();
        await this.storage.put(key, dataStr);
      } catch (err: any) {
        webSocket.send(JSON.stringify({ error: err.stack }));
      }
    });

    const closeOrErrorHandler = (evt: Event | CloseEvent) => {
      session.quit = true;
      this.sessions = this.sessions.filter((member) => member !== session);
      if (session.name) {
        this.broadcast({ quit: session.name });
      }
    };

    webSocket.addEventListener('close', closeOrErrorHandler);
    webSocket.addEventListener('error', closeOrErrorHandler);
  }

  broadcast(_message: string | Record<string, unknown>) {
    const message =
      typeof _message !== 'string' ? JSON.stringify(_message) : _message;

    const quitters = [] as ChatRoomSession[];
    this.sessions = this.sessions.filter((session) => {
      if (session.name) {
        try {
          session.webSocket.send(message);
          return true;
        } catch (err) {
          // Whoops, this connection is dead. Remove it from the list and arrange to notify
          // everyone below.
          session.quit = true;
          quitters.push(session);
          return false;
        }
      } else {
        // This session hasn't sent the initial user info message yet, so we're not sending them
        // messages yet (no secret lurking!). Queue the message to be sent later.
        session.blockedMessages.push(message);
        return true;
      }
    });

    quitters.forEach((quitter) => {
      if (quitter.name) {
        this.broadcast({ quit: quitter.name });
      }
    });
  }
}
