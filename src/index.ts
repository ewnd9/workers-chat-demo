import HTML from 'chat.html';
import CSS from 'chat.css';

interface Env {
  rooms: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env) {
    return await handleErrors(request, async () => {
      const url = new URL(request.url);

      if (url.pathname === '/') {
        return handleStaticRequest(HTML, 'text/html;charset=UTF-8');
      } else if (url.pathname === '/chat.css') {
        return handleStaticRequest(CSS, 'text/css;charset=UTF-8');
      } else if (url.pathname.startsWith('/api')) {
        return handleApiRequest(url.pathname.split('/').slice(2), request, env);
      } else {
        return new Response('Not found', { status: 404 });
      }
    });
  },
} as ExportedHandler<Env>;

// throws "TypeError: Cannot perform Construct on a detached ArrayBuffer" on passing data directly
async function handleStaticRequest(data: ArrayBuffer, contentType: string) {
  const buffer = new ArrayBuffer(data.byteLength);
  new Uint8Array(buffer).set(new Uint8Array(data));
  return new Response(buffer, { headers: { 'Content-Type': contentType } });
}

async function handleApiRequest(path: string[], request: Request, env: Env) {
  switch (path[0]) {
    case 'room': {
      if (!path[1]) {
        // POST to /api/room creates a private room.
        if (request.method == 'POST') {
          const id = env.rooms.newUniqueId();
          return new Response(id.toString(), {
            headers: { 'Access-Control-Allow-Origin': '*' },
          });
        } else {
          return new Response('Method not allowed', { status: 405 });
        }
      }

      const name = path[1];

      let id;
      if (name.match(/^[0-9a-f]{64}$/)) {
        id = env.rooms.idFromString(name);
      } else if (name.length <= 32) {
        id = env.rooms.idFromName(name);
      } else {
        return new Response('Name too long', { status: 404 });
      }

      // Get the Durable Object stub for this room! The stub is a client object that can be used
      // to send messages to the remote Durable Object instance. The stub is returned immediately;
      // there is no need to await it. This is important because you would not want to wait for
      // a network round trip before you could start sending requests. Since Durable Objects are
      // created on-demand when the ID is first used, there's nothing to wait for anyway; we know
      // an object will be available somewhere to receive our requests.
      const roomObject = env.rooms.get(id);

      // Compute a new URL with `/api/room/<name>` removed. We'll forward the rest of the path
      // to the Durable Object.
      let newUrl = new URL(request.url);
      newUrl.pathname = '/' + path.slice(2).join('/');

      // Send the request to the object. The `fetch()` method of a Durable Object stub has the
      // same signature as the global `fetch()` function, but the request is always sent to the
      // object, regardless of the request's URL.

      // Argument of type 'URL' is not assignable to parameter of type 'string | Request'.
      // @ts-expect-error
      return roomObject.fetch(newUrl, request);
    }

    default:
      return new Response('Not found', { status: 404 });
  }
}

// `handleErrors()` is a little utility function that can wrap an HTTP request handler in a
// try/catch and return errors to the client. You probably wouldn't want to use this in production
// code but it is convenient when debugging and iterating.
async function handleErrors<T>(
  request: Request,
  func: () => Promise<T>
): Promise<T | Response> {
  try {
    return await func();
  } catch (err: any) {
    if (request.headers.get('Upgrade') == 'websocket') {
      // Annoyingly, if we return an HTTP error in response to a WebSocket request, Chrome devtools
      // won't show us the response body! So... let's send a WebSocket response with an error
      // frame instead.
      let pair = new WebSocketPair();
      pair[1].accept();
      pair[1].send(JSON.stringify({ error: err.stack }));
      pair[1].close(1011, 'Uncaught exception during session setup');
      return new Response(null, { status: 101, webSocket: pair[0] });
    } else {
      return new Response(err.stack, { status: 500 });
    }
  }
}

interface ChatRoomSession {
  name?: string;
  quit?: boolean;
  webSocket: WebSocket;
  blockedMessages: string[];
}

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

        // Save message.
        let key = new Date(data.timestamp).toISOString();
        await this.storage.put(key, dataStr);
      } catch (err: any) {
        // Report any exceptions directly back to the client. As with our handleErrors() this
        // probably isn't what you'd want to do in production, but it's convenient when testing.
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
