// injected from miniflare
import HTML from 'chat.html';
import CSS from 'chat.css';
import JS from 'chat.js';

import { Env } from './types';
import { handleErrors } from './utils/handle-errors';

export async function workerFetch(request: Request, env: Env) {
  return await handleErrors(request, async () => {
    const url = new URL(request.url);

    if (url.pathname === '/') {
      return handleStaticRequest(HTML, 'text/html;charset=UTF-8');
    } else if (url.pathname === '/chat.css') {
      return handleStaticRequest(CSS, 'text/css;charset=UTF-8');
    } else if (url.pathname === '/chat.js') {
      return handleStaticRequest(JS, 'text/css;charset=UTF-8');
    } else if (url.pathname.startsWith('/api')) {
      return handleApiRequest(url.pathname.split('/').slice(2), request, env);
    } else {
      return new Response('Not found', { status: 404 });
    }
  });
}

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
