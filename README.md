# Cloudflare Edge Chat Demo

Forked from https://github.com/cloudflare/workers-chat-demo

- https://edge-chat-demo.cloudflareworkers.com
- https://workers.cloudflare.com/
- https://blog.cloudflare.com/introducing-workers-durable-objects
- https://developers.cloudflare.com/workers/learning/using-durable-objects
- miniflare
    - https://blog.cloudflare.com/miniflare/
    - https://miniflare.dev
    - https://miniflare.dev/core/web-sockets
- esbuild
    - https://miniflare.dev/developing/esbuild
    - https://github.com/mrbbot/miniflare-typescript-esbuild-jest
- typescript
    - https://www.npmjs.com/package/@cloudflare/workers-types

- In a chat room, when one user sends a message, the app must somehow route that message to other users, via connections that those other users already had open.
- These connections are state, and coordinating them in a stateless framework is hard if not impossible.

## How does it work?

- This chat app uses a Durable Object to control each chat room.
- Users connect to the object using WebSockets.
- Messages from one user are broadcast to all the other users.
- The chat history is also stored in durable storage, but this is only for history.
- Real-time messages are relayed directly from one user to others without going through the storage layer.

## Install

```sh
$ yarn install
```

## Usage

```sh
$ yarn start:dev # http://localhost:8787/
```

## Publishing

```sh
$ npm i -g @cloudflare/wrangler
$ wrangler login
# required paid plan ($5+/month)
$ wrangler publish
```

## How to uninstall

Modify wrangler.toml to remove the durable_objects bindings and add a deleted_classes migration. The bottom of your wrangler.toml should look like:

```toml
[durable_objects]
bindings = [
]

# Indicate that you want the ChatRoom and RateLimiter classes to be callable as Durable Objects.
[[migrations]]
tag = "v1" # Should be unique for each entry
new_classes = ["ChatRoom", "RateLimiter"]

[[migrations]]
tag = "v2"
deleted_classes = ["ChatRoom", "RateLimiter"]
```

Then run `wrangler publish`, which will delete the Durable Objects and all data stored in them. To remove the Worker, go to [dash.cloudflare.com](dash.cloudflare.com) and navigate to Workers -> Overview -> edge-chat-demo -> Manage Service -> Delete (bottom of page)
